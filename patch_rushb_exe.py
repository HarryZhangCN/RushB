"""Change only unsigned Windows EXE VERSIONINFO CompanyName, with verification."""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import tempfile


RT_VERSION = 16
ResourceKey = tuple[int | str, int | str, int]


def _pe_certificate_size(data: bytes) -> int:
    if data[:2] != b"MZ":
        raise RuntimeError("Expected a Windows PE executable")
    offset = struct.unpack_from("<I", data, 0x3C)[0]
    if data[offset : offset + 4] != b"PE\0\0":
        raise RuntimeError("Invalid PE signature")
    optional = offset + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    directories = optional + {0x10B: 96, 0x20B: 112}.get(magic, 0)
    if directories == optional:
        raise RuntimeError("Unsupported PE optional header")
    certificate_offset, certificate_size = struct.unpack_from("<II", data, directories + 4 * 8)
    return certificate_offset or certificate_size


def _require_unsigned(exe: Path) -> None:
    # Reject a certificate table even when its signature is expired or invalid.
    if _pe_certificate_size(exe.read_bytes()):
        raise RuntimeError("The executable has an Authenticode certificate table; refusing to change it")

    class GUID(ctypes.Structure):
        _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]

    class FILE_INFO(ctypes.Structure):
        _fields_ = [("cbStruct", wintypes.DWORD), ("pcwszFilePath", wintypes.LPCWSTR), ("hFile", wintypes.HANDLE), ("pgKnownSubject", ctypes.c_void_p)]

    class TRUST_DATA(ctypes.Structure):
        _fields_ = [
            ("cbStruct", wintypes.DWORD), ("pPolicyCallbackData", ctypes.c_void_p), ("pSIPClientData", ctypes.c_void_p),
            ("dwUIChoice", wintypes.DWORD), ("fdwRevocationChecks", wintypes.DWORD), ("dwUnionChoice", wintypes.DWORD),
            ("pFile", ctypes.POINTER(FILE_INFO)), ("dwStateAction", wintypes.DWORD), ("hWVTStateData", wintypes.HANDLE),
            ("pwszURLReference", wintypes.LPCWSTR), ("dwProvFlags", wintypes.DWORD), ("dwUIContext", wintypes.DWORD),
            ("pSignatureSettings", ctypes.c_void_p),
        ]

    action = GUID(0x00AAC56B, 0xCD44, 0x11D0, (ctypes.c_ubyte * 8)(0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE))
    info = FILE_INFO(ctypes.sizeof(FILE_INFO), str(exe), None, None)
    trust = TRUST_DATA()
    trust.cbStruct = ctypes.sizeof(TRUST_DATA)
    trust.dwUIChoice = 2  # WTD_UI_NONE
    trust.dwUnionChoice = 1  # WTD_CHOICE_FILE
    trust.pFile = ctypes.pointer(info)
    trust.dwStateAction = 1  # WTD_STATEACTION_VERIFY
    trust.dwProvFlags = 0x1000 | 0x10  # Cache only; never download certificates.
    wintrust = ctypes.WinDLL("wintrust", use_last_error=True)
    verify = wintrust.WinVerifyTrust
    verify.argtypes = [wintypes.HWND, ctypes.POINTER(GUID), ctypes.POINTER(TRUST_DATA)]
    verify.restype = wintypes.LONG
    try:
        status = verify(None, ctypes.byref(action), ctypes.byref(trust)) & 0xFFFFFFFF
    finally:
        trust.dwStateAction = 2
        verify(None, ctypes.byref(action), ctypes.byref(trust))
    if status != 0x800B0100:  # TRUST_E_NOSIGNATURE is the only accepted result.
        raise RuntimeError(f"Authenticode verification did not report unsigned (0x{status:08X}); refusing to modify")


def _kernel32():
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
    api.LoadLibraryExW.restype = wintypes.HMODULE
    api.FreeLibrary.argtypes = [wintypes.HMODULE]
    api.FreeLibrary.restype = wintypes.BOOL
    api.FindResourceExW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD]
    api.FindResourceExW.restype = wintypes.HANDLE
    api.LoadResource.argtypes = [wintypes.HMODULE, wintypes.HANDLE]
    api.LoadResource.restype = wintypes.HANDLE
    api.LockResource.argtypes = [wintypes.HANDLE]
    api.LockResource.restype = ctypes.c_void_p
    api.SizeofResource.argtypes = [wintypes.HMODULE, wintypes.HANDLE]
    api.SizeofResource.restype = wintypes.DWORD
    api.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
    api.BeginUpdateResourceW.restype = wintypes.HANDLE
    api.UpdateResourceW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD, ctypes.c_void_p, wintypes.DWORD]
    api.UpdateResourceW.restype = wintypes.BOOL
    api.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]
    api.EndUpdateResourceW.restype = wintypes.BOOL
    return api


def _identifier(pointer: int) -> int | str:
    return pointer if pointer <= 0xFFFF else ctypes.wstring_at(pointer)


def _pointer(identifier: int | str):
    return ctypes.c_void_p(identifier) if isinstance(identifier, int) else ctypes.c_wchar_p(identifier)


def read_resources(exe: Path) -> dict[ResourceKey, bytes]:
    """Read every language of every resource without executing the PE image."""
    api = _kernel32()
    module = api.LoadLibraryExW(str(exe), None, 0x2 | 0x20)
    if not module:
        raise ctypes.WinError(ctypes.get_last_error())
    result: dict[ResourceKey, bytes] = {}
    errors: list[BaseException] = []
    LANG_CALLBACK = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD, wintypes.LPARAM)
    NAME_CALLBACK = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, wintypes.LPARAM)
    TYPE_CALLBACK = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMODULE, ctypes.c_void_p, wintypes.LPARAM)
    api.EnumResourceLanguagesW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, LANG_CALLBACK, wintypes.LPARAM]
    api.EnumResourceLanguagesW.restype = wintypes.BOOL
    api.EnumResourceNamesW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, NAME_CALLBACK, wintypes.LPARAM]
    api.EnumResourceNamesW.restype = wintypes.BOOL
    api.EnumResourceTypesW.argtypes = [wintypes.HMODULE, TYPE_CALLBACK, wintypes.LPARAM]
    api.EnumResourceTypesW.restype = wintypes.BOOL

    @LANG_CALLBACK
    def language_callback(handle, type_id, name_id, language, _param):
        try:
            resource = api.FindResourceExW(handle, type_id, name_id, language)
            if not resource:
                raise ctypes.WinError(ctypes.get_last_error())
            size = api.SizeofResource(handle, resource)
            loaded = api.LoadResource(handle, resource)
            pointer = api.LockResource(loaded)
            if size and not pointer:
                raise ctypes.WinError(ctypes.get_last_error())
            result[(_identifier(type_id), _identifier(name_id), language)] = ctypes.string_at(pointer, size)
            return True
        except BaseException as error:
            errors.append(error)
            return False

    @NAME_CALLBACK
    def name_callback(handle, type_id, name_id, _param):
        if not api.EnumResourceLanguagesW(handle, type_id, name_id, language_callback, 0) and not errors:
            errors.append(ctypes.WinError(ctypes.get_last_error()))
        return not errors

    @TYPE_CALLBACK
    def type_callback(handle, type_id, _param):
        if not api.EnumResourceNamesW(handle, type_id, name_callback, 0) and not errors:
            errors.append(ctypes.WinError(ctypes.get_last_error()))
        return not errors

    try:
        if not api.EnumResourceTypesW(module, type_callback, 0) and not errors:
            errors.append(ctypes.WinError(ctypes.get_last_error()))
        if errors:
            raise errors[0]
        return result
    finally:
        api.FreeLibrary(module)


@dataclass
class VersionBlock:
    key: str
    kind: int
    value_length: int
    value: bytes
    value_start: int
    children_start: int
    children: list["VersionBlock"]
    raw: bytes


def _align4(value: int) -> int:
    return (value + 3) & ~3


def _parse_version(data: bytes, offset: int = 0, limit: int | None = None) -> VersionBlock:
    limit = len(data) if limit is None else limit
    if offset + 6 > limit:
        raise RuntimeError("Truncated VERSIONINFO block")
    length, value_length, kind = struct.unpack_from("<HHH", data, offset)
    end = offset + length
    if length < 6 or end > limit:
        raise RuntimeError("Invalid VERSIONINFO block length")
    position = offset + 6
    while position + 2 <= end and data[position : position + 2] != b"\0\0":
        position += 2
    if position + 2 > end:
        raise RuntimeError("Unterminated VERSIONINFO key")
    key = data[offset + 6 : position].decode("utf-16le")
    value_start = _align4(position + 2)
    value_end = value_start + value_length * (2 if kind == 1 else 1)
    if value_end > end:
        raise RuntimeError("Invalid VERSIONINFO value length")
    children_start = min(_align4(value_end), end)
    children = []
    cursor = children_start
    while cursor + 6 <= end:
        if not any(data[cursor:end]):
            break
        child = _parse_version(data, cursor, end)
        children.append(child)
        cursor = _align4(cursor + len(child.raw))
    return VersionBlock(key, kind, value_length, data[value_start:value_end], value_start - offset,
                        children_start - offset, children, data[offset:end])


def _is_company(path: tuple[str, ...]) -> bool:
    return len(path) >= 3 and path[-3] == "StringFileInfo" and path[-1] == "CompanyName"


def version_values(data: bytes) -> dict[tuple[str, ...], tuple[int, int, bytes]]:
    values = {}

    def visit(node: VersionBlock, parent: tuple[str, ...]):
        path = parent + (node.key,)
        if path in values:
            raise RuntimeError("Duplicate VERSIONINFO key")
        values[path] = (node.kind, node.value_length, node.value)
        for child in node.children:
            visit(child, path)

    visit(_parse_version(data), ())
    return values


def _rewrite_version(node: VersionBlock, publisher: str, parent: tuple[str, ...] = ()) -> tuple[bytes, int]:
    path = parent + (node.key,)
    if _is_company(path):
        if node.kind != 1 or node.children:
            raise RuntimeError("Unexpected CompanyName VERSIONINFO structure")
        value = (publisher + "\0").encode("utf-16le")
        result = bytearray(node.raw[:node.value_start] + value + node.raw[node.value_start + len(node.value):])
        struct.pack_into("<HH", result, 0, len(result), len(value) // 2)
        return bytes(result), 1
    children = []
    changes = 0
    for child in node.children:
        rewritten, count = _rewrite_version(child, publisher, path)
        children.append(rewritten)
        changes += count
    if not changes:
        return node.raw, 0
    result = bytearray(node.raw[:node.children_start])
    for index, child in enumerate(children):
        result.extend(child)
        if index + 1 < len(children):
            result.extend(b"\0" * (_align4(len(result)) - len(result)))
    if len(result) > 0xFFFF:
        raise RuntimeError("VERSIONINFO resource exceeds its 16-bit length limit")
    struct.pack_into("<H", result, 0, len(result))
    return bytes(result), changes


def _update_resources(exe: Path, updates: dict[ResourceKey, bytes]) -> None:
    api = _kernel32()
    handle = api.BeginUpdateResourceW(str(exe), False)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        for (type_id, name_id, language), value in updates.items():
            buffer = ctypes.create_string_buffer(value)
            if not api.UpdateResourceW(handle, _pointer(type_id), _pointer(name_id), language, buffer, len(value)):
                raise ctypes.WinError(ctypes.get_last_error())
        if not api.EndUpdateResourceW(handle, False):
            raise ctypes.WinError(ctypes.get_last_error())
        handle = None
    finally:
        if handle:
            api.EndUpdateResourceW(handle, True)


def patch_publisher(exe: Path, publisher: str = "Harry张") -> None:
    """Patch only the explicitly supplied unsigned EXE, atomically after validation."""
    if os.name != "nt":
        raise RuntimeError("Windows resource APIs are required")
    exe = Path(exe).resolve(strict=True)
    if not isinstance(publisher, str) or not publisher or "\0" in publisher or len(publisher) > 256:
        raise ValueError("Publisher must contain 1-256 characters and no NUL")
    _require_unsigned(exe)
    original = read_resources(exe)
    updates = {}
    for key, data in original.items():
        if key[0] != RT_VERSION:
            continue
        new_data, changes = _rewrite_version(_parse_version(data), publisher)
        if not changes:
            raise RuntimeError(f"No CompanyName in VERSIONINFO resource {key}")
        before = {path: value for path, value in version_values(data).items() if not _is_company(path)}
        after = {path: value for path, value in version_values(new_data).items() if not _is_company(path)}
        if before != after:
            raise RuntimeError("A non-CompanyName VERSIONINFO value changed")
        for path, (_kind, _length, value) in version_values(new_data).items():
            if _is_company(path) and value.decode("utf-16le").rstrip("\0") != publisher:
                raise RuntimeError("CompanyName verification failed")
        updates[key] = new_data
    if not updates:
        raise RuntimeError("No VERSIONINFO resources were found")
    expected = original | updates
    descriptor, temporary = tempfile.mkstemp(prefix=".rushb-publisher-", suffix=".exe", dir=exe.parent)
    os.close(descriptor)
    candidate = Path(temporary)
    try:
        shutil.copy2(exe, candidate)
        _update_resources(candidate, updates)
        _require_unsigned(candidate)
        if read_resources(candidate) != expected:
            raise RuntimeError("Post-update resource inventory differs from the expected CompanyName-only change")
        os.replace(candidate, exe)
        if read_resources(exe) != expected:
            raise RuntimeError("Final executable resource verification failed")
    finally:
        candidate.unlink(missing_ok=True)


def _summary(exe: Path) -> dict:
    versions = []
    for key, data in read_resources(exe).items():
        if key[0] != RT_VERSION:
            continue
        strings = {
            "/".join(path): value.decode("utf-16le").rstrip("\0")
            for path, (kind, _length, value) in version_values(data).items()
            if kind == 1 and value
        }
        versions.append({"resource": key, "strings": strings})
    return {"path": str(exe), "bytes": exe.stat().st_size, "sha256": hashlib.sha256(exe.read_bytes()).hexdigest(), "versions": versions}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--publisher", default="Harry张")
    args = parser.parse_args()
    source, target = args.input.resolve(strict=True), args.candidate.resolve()
    if source == target or target.exists():
        parser.error("Candidate must be a new path distinct from the input")
    _require_unsigned(source)
    before = _summary(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    try:
        patch_publisher(target, args.publisher)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    print(json.dumps({"before": before, "after": _summary(target)}, ensure_ascii=False, indent=2))

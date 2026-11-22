"""Replace the icon resources of an unsigned Windows EXE."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import os
from pathlib import Path
import shutil
import struct
import tempfile

from patch_rushb_exe import ResourceKey, _kernel32, _pointer, _require_unsigned, read_resources


RT_ICON, RT_GROUP_ICON = 3, 14
ICON_TYPES = {RT_ICON, RT_GROUP_ICON}


def read_ico(icon: Path) -> list[tuple[bytes, bytes]]:
    """Read each ICO directory entry (minus its offset) and its image data."""
    data = icon.read_bytes()
    if len(data) < 6:
        raise ValueError("Truncated ICO header")
    reserved, kind, count = struct.unpack_from("<HHH", data)
    directory_end = 6 + 16 * count
    if reserved or kind != 1 or not 1 <= count <= 256 or directory_end > len(data):
        raise ValueError("Expected an ICO with 1 to 256 image entries")
    entries = []
    for index in range(count):
        position = 6 + 16 * index
        size, offset = struct.unpack_from("<II", data, position + 8)
        if not size or offset < directory_end or offset + size > len(data):
            raise ValueError(f"Invalid ICO image range at entry {index + 1}")
        information = data[position:position + 12]
        image = data[offset:offset + size]
        expected_size = (information[0] or 256, information[1] or 256)
        if image.startswith(b"\x89PNG\r\n\x1a\n"):
            if len(image) < 33 or image[8:16] != b"\0\0\0\rIHDR":
                raise ValueError(f"Truncated ICO PNG at entry {index + 1}")
            actual_size = struct.unpack_from(">II", image, 16)
        else:
            if len(image) < 40 or not 40 <= struct.unpack_from("<I", image)[0] <= size:
                raise ValueError(f"Unsupported ICO image at entry {index + 1}")
            width, height = struct.unpack_from("<ii", image, 4)
            actual_size = (width, abs(height) // 2)
        if actual_size != expected_size:
            raise ValueError(f"ICO image dimensions differ from the directory at entry {index + 1}")
        entries.append((information, image))
    return entries


def _non_resource_sections(exe: Path) -> dict:
    """Compare the bytes and PE attributes of sections other than resources."""
    data = exe.read_bytes()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[:2] != b"MZ" or data[pe:pe + 4] != b"PE\0\0":
        raise ValueError("Invalid Windows PE signature")
    coff = pe + 4
    section_count = struct.unpack_from("<H", data, coff + 2)[0]
    optional_size = struct.unpack_from("<H", data, coff + 16)[0]
    optional = coff + 20
    magic = struct.unpack_from("<H", data, optional)[0]
    directory = {0x10B: 96, 0x20B: 112}.get(magic)
    if directory is None or directory + 48 > optional_size:
        raise ValueError("Unsupported PE optional header")
    resource_rva = struct.unpack_from("<I", data, optional + directory + 16)[0]
    reloc_rva, reloc_size = struct.unpack_from("<II", data, optional + directory + 40)
    section_table = optional + optional_size
    if not resource_rva or section_table + section_count * 40 > len(data):
        raise ValueError("PE section table or resource address is invalid")
    result = {}
    for index in range(section_count):
        start = section_table + 40 * index
        name = data[start:start + 8].rstrip(b"\0")
        virtual_size, rva, size, offset = struct.unpack_from("<4I", data, start + 8)
        flags = struct.unpack_from("<I", data, start + 36)[0]
        if rva <= resource_rva < rva + max(virtual_size, size):
            continue
        if offset + size > len(data):
            raise ValueError("PE section data is truncated")
        address = rva
        # Windows can slide the relocation section when .rsrc shrinks or grows.
        # Verify the directory still points to the same bytes in that section.
        if name == b".reloc" and rva <= reloc_rva and reloc_rva + reloc_size <= rva + size:
            address = (reloc_rva - rva, reloc_size)
        result[(index, name)] = (virtual_size, address, size, flags, hashlib.sha256(memoryview(data)[offset:offset + size]).digest())
    return result


def _write_resources(exe: Path, changes: dict[ResourceKey, bytes | None]) -> None:
    api = _kernel32()
    transaction = api.BeginUpdateResourceW(str(exe), False)
    if not transaction:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        for (kind, name, language), payload in changes.items():
            buffer = ctypes.create_string_buffer(payload) if payload is not None else None
            size = len(payload) if payload is not None else 0
            if not api.UpdateResourceW(transaction, _pointer(kind), _pointer(name), language, buffer, size):
                raise ctypes.WinError(ctypes.get_last_error())
        handle, transaction = transaction, None
        if not api.EndUpdateResourceW(handle, False):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        if transaction:
            api.EndUpdateResourceW(transaction, True)


def patch_icon(exe: Path, icon: Path) -> None:
    """Apply the ICO to every group and language, then verify before replacing the EXE."""
    if os.name != "nt":
        raise RuntimeError("Windows resource APIs are required")
    exe = Path(exe).resolve(strict=True)
    entries = read_ico(Path(icon).resolve(strict=True))
    _require_unsigned(exe)
    original = read_resources(exe)
    sections = _non_resource_sections(exe)
    groups = [key for key in original if key[0] == RT_GROUP_ICON]
    if not groups:
        raise RuntimeError("The executable has no icon groups")

    desired = {key: value for key, value in original.items() if key[0] not in ICON_TYPES}
    group_data = struct.pack("<HHH", 0, 1, len(entries)) + b"".join(
        info + struct.pack("<H", index) for index, (info, _) in enumerate(entries, 1)
    )
    for group in groups:
        desired[group] = group_data
    for language in {group[2] for group in groups}:
        for index, (_, image) in enumerate(entries, 1):
            desired[(RT_ICON, index, language)] = image

    changes = {key: None for key in original.keys() - desired.keys()}
    changes.update({key: value for key, value in desired.items() if original.get(key) != value})
    if not changes:
        return

    fd, filename = tempfile.mkstemp(prefix=".rushb-icon-", suffix=".exe", dir=exe.parent)
    os.close(fd)
    candidate = Path(filename)
    try:
        shutil.copy2(exe, candidate)
        _write_resources(candidate, changes)
        if read_resources(candidate) != desired:
            raise RuntimeError("Executable resources do not match the intended icon-only changes")
        if _non_resource_sections(candidate) != sections:
            raise RuntimeError("A non-resource PE section changed")
        _require_unsigned(candidate)
        os.replace(candidate, exe)
    finally:
        candidate.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Original EXE to preserve")
    parser.add_argument("icon", type=Path)
    parser.add_argument("candidate", type=Path, help="An unused path for the patched candidate")
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    target = args.candidate.resolve()
    if source == target or target.exists():
        parser.error("Candidate must be a new path distinct from the input")
    shutil.copy2(source, target)
    try:
        patch_icon(target, args.icon)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    print(f"Verified {len(read_ico(args.icon))} icon images in {target}")

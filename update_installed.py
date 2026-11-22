"""Update installed RushB resources while preserving its current HTML entry."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
from datetime import datetime, timezone
from pathlib import Path

from build_rushb import (
    APP_ICON,
    CSS_SOURCE,
    DOUYIN_SOURCE,
    YOUTUBE_SOURCE,
    ENGINE_SOURCE,
    JS_SOURCE,
    LEGACY_RENDERER,
    LINKS_SOURCE,
    component_resources,
    patch_bili_account_background,
    patch_bili_account_settings,
    patch_components_background,
    patch_components_settings,
    patch_douyin_background,
    patch_package_publisher,
    patch_publisher_label,
    patch_windows_app_id,
    patch_youtube_background,
    patch_engine_background,
    patch_favicon,
    patch_legacy_logo,
)


LINK_PLACEHOLDER = "粘贴 B 站、抖音或 YouTube 链接，也可粘贴分享文案"


def patch_link_placeholder(html: str) -> str:
    """Change only the batch input placeholder, preserving other installed edits."""
    pattern = r'''<textarea\b(?=[^>]*\bid\s*=\s*(["'])batch-links\1)[^>]*>'''

    def replace_tag(match: re.Match) -> str:
        tag = match.group(0)
        attribute = r'''\bplaceholder\s*=\s*(["']).*?\1'''
        replacement = f'placeholder="{LINK_PLACEHOLDER}"'
        if re.search(attribute, tag, flags=re.IGNORECASE | re.DOTALL):
            return re.sub(attribute, replacement, tag, count=1, flags=re.IGNORECASE | re.DOTALL)
        return tag[:-1] + " " + replacement + ">"

    result, count = re.subn(pattern, replace_tag, html, flags=re.IGNORECASE | re.DOTALL)
    if count != 1:
        raise RuntimeError("Could not find exactly one installed batch-links textarea")
    return result


def update(installation: Path) -> None:
    installation = installation.expanduser().resolve()
    archive = installation / "resources" / "app.asar"
    if not (installation / "RushB.exe").is_file():
        raise RuntimeError("The selected directory is not a RushB installation")
    original = archive.read_bytes()
    json_size = struct.unpack_from("<I", original, 12)[0]
    if not json_size or 16 + json_size > len(original):
        raise RuntimeError("The selected archive has an invalid ASAR header")
    tree = json.loads(original[16 : 16 + json_size])
    body_start = (16 + json_size + 3) & ~3
    body = original[body_start:]

    def entry(path: str) -> dict:
        node = tree
        for part in path.split("/"):
            node = node["files"][part]
        return node

    def read_resource(path: str) -> bytes:
        node = entry(path)
        if "offset" not in node or "size" not in node:
            raise RuntimeError(f"Expected a packed ASAR resource: {path}")
        offset, size = int(node["offset"]), int(node["size"])
        if offset < 0 or size < 0 or offset + size > len(body):
            raise RuntimeError(f"Invalid ASAR resource range: {path}")
        return body[offset : offset + size]

    background = read_resource("background.js").decode("utf-8")
    # Select the entry actually loaded by this installation. Do not replace its
    # complete HTML with INDEX_HTML: it may contain newer local patches.
    match = re.search(r'''\bE\.loadURL\(\s*(["'])app://\./([^"']+)\1\s*\)''', background)
    if not match:
        raise RuntimeError("Could not find the currently installed app entry URL")
    entry_path = match.group(2).split("?", 1)[0].split("#", 1)[0]
    if not entry_path or entry_path.startswith("/") or ".." in entry_path.split("/"):
        raise RuntimeError("The installed app entry path is invalid")
    installed_html = read_resource(entry_path).decode("utf-8")
    background = patch_windows_app_id(patch_bili_account_background(background))
    installed_html = patch_bili_account_settings(installed_html)
    updates = {
        "package.json": patch_package_publisher(read_resource("package.json")),
        "background.js": patch_components_background(patch_youtube_background(patch_douyin_background(patch_engine_background(background)))).encode("utf-8"),
        "rushb-engine.js": ENGINE_SOURCE.read_bytes(),
        "rushb-douyin.js": DOUYIN_SOURCE.read_bytes(),
        "rushb-youtube.js": YOUTUBE_SOURCE.read_bytes(),
        "rushb-links.js": LINKS_SOURCE.read_bytes(),
        "assets/js/rushb-ui-dialog-fix.js": JS_SOURCE.read_bytes(),
        "assets/css/rushb-ui-dialog-fix.css": CSS_SOURCE.read_bytes(),
        entry_path: patch_favicon(patch_components_settings(patch_publisher_label(patch_link_placeholder(installed_html)))).encode("utf-8"),
        LEGACY_RENDERER: patch_legacy_logo(read_resource(LEGACY_RENDERER)),
        "logo.ico": APP_ICON.read_bytes(),
        **component_resources(),
    }
    appended = bytearray()
    for path, data in updates.items():
        node = tree
        parts = path.split("/")
        for part in parts[:-1]:
            node = node.setdefault("files", {}).setdefault(part, {"files": {}})
        node.setdefault("files", {})[parts[-1]] = {"size": len(data), "offset": str(len(body) + len(appended))}
        appended.extend(data)
    header = json.dumps(tree, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    padded = (len(header) + 3) & ~3
    inner = padded + 4
    packed = struct.pack("<IIII", 4, inner + 4, inner, len(header)) + header + b"\0" * (padded - len(header)) + body + appended

    # Verify candidate resources through the new ASAR header before installation.
    size = struct.unpack_from("<I", packed, 12)[0]
    candidate_tree = json.loads(packed[16 : 16 + size])
    candidate_base = (16 + size + 3) & ~3
    for path, expected in updates.items():
        node = candidate_tree
        for part in path.split("/"):
            node = node["files"][part]
        offset = candidate_base + int(node["offset"])
        actual = packed[offset : offset + node["size"]]
        if actual != expected:
            raise RuntimeError(f"Resource verification failed: {path}")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    backup = archive.with_name(f"app.asar.before-platform-update-{stamp}.bak")
    shutil.copy2(archive, backup)
    if hashlib.sha256(backup.read_bytes()).digest() != hashlib.sha256(original).digest():
        raise RuntimeError("Backup verification failed")
    temporary = archive.with_name("app.asar.platform-update.tmp")
    temporary.write_bytes(packed)
    os.replace(temporary, archive)
    if archive.read_bytes() != packed:
        raise RuntimeError("Installed archive verification failed")
    shutil.copy2(JS_SOURCE, installation / "rushb-ui.js")
    shutil.copy2(CSS_SOURCE, installation / "rushb-ui.css")
    print(f"Updated {archive}; bytes={len(packed)}")
    print(f"Updated the RushB interface and branding in {entry_path}")
    print(f"Backup {backup}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "installation",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="RushB installation to update; defaults to the parent of this project",
    )
    update(parser.parse_args().installation)

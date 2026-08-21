"""Discovering sources: mounted volumes, SD cards, and .zip archives."""

from __future__ import annotations

import os
import shutil
import string
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass, asdict
from pathlib import Path

from .probe import JUNK_NAMES, VIDEO_EXTS, is_junk


@dataclass
class Volume:
    path: str
    label: str
    total_bytes: int = 0
    free_bytes: int = 0
    removable: bool = True
    kind: str = "volume"          # volume | zip | folder
    note: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _usage(path: str) -> tuple[int, int]:
    try:
        u = shutil.disk_usage(path)
        return u.total, u.free
    except OSError:
        return 0, 0


def _mac_volumes() -> list[Volume]:
    out: list[Volume] = []
    root = Path("/Volumes")
    if not root.exists():
        return out
    for entry in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        try:
            if not entry.is_dir():
                continue
        except OSError:
            continue
        # The boot volume is symlinked into /Volumes; never offer it as a source.
        if entry.is_symlink() or os.path.realpath(entry) == "/":
            continue
        total, free = _usage(str(entry))
        out.append(Volume(path=str(entry), label=entry.name,
                          total_bytes=total, free_bytes=free))
    return out


def _windows_volumes() -> list[Volume]:
    import ctypes

    out: list[Volume] = []
    bitmask = ctypes.windll.kernel32.GetLogicalDrives()
    DRIVE_REMOVABLE, DRIVE_FIXED = 2, 3
    for i, letter in enumerate(string.ascii_uppercase):
        if not bitmask & (1 << i):
            continue
        root = f"{letter}:\\"
        dtype = ctypes.windll.kernel32.GetDriveTypeW(ctypes.c_wchar_p(root))
        if dtype not in (DRIVE_REMOVABLE, DRIVE_FIXED):
            continue
        if letter == "C":
            continue                      # system drive is not a card or SSD
        name_buf = ctypes.create_unicode_buffer(1024)
        try:
            ctypes.windll.kernel32.GetVolumeInformationW(
                ctypes.c_wchar_p(root), name_buf, ctypes.sizeof(name_buf),
                None, None, None, None, 0)
        except OSError:
            pass
        total, free = _usage(root)
        out.append(Volume(path=root, label=name_buf.value or root,
                          total_bytes=total, free_bytes=free,
                          removable=dtype == DRIVE_REMOVABLE))
    return out


def _linux_volumes() -> list[Volume]:
    out: list[Volume] = []
    user = os.environ.get("USER", "")
    for base in (Path("/media") / user, Path("/media"), Path("/run/media") / user,
                 Path("/mnt")):
        if not base.exists():
            continue
        for entry in sorted(base.iterdir()):
            if entry.is_dir() and os.path.ismount(entry):
                total, free = _usage(str(entry))
                out.append(Volume(path=str(entry), label=entry.name,
                                  total_bytes=total, free_bytes=free))
    return out


def list_volumes() -> list[dict]:
    """Every plausible source drive, boot/system disks excluded."""
    if os.name == "nt":
        vols = _windows_volumes()
    elif os.uname().sysname == "Darwin":
        vols = _mac_volumes()
    else:
        vols = _linux_volumes()

    seen: set[str] = set()
    unique: list[Volume] = []
    for v in vols:
        real = os.path.realpath(v.path)
        if real in seen:
            continue
        seen.add(real)
        if _looks_like_card(Path(v.path)):
            v.note = "Camera card structure detected"
        unique.append(v)
    return [v.to_dict() for v in unique]


CARD_MARKERS = ("dcim", "private", "avchd", "clip", "xdroot", "bdmv",
                "m4root", "panasonic", "contents")


def _looks_like_card(root: Path) -> bool:
    try:
        names = {p.name.lower() for p in root.iterdir() if p.is_dir()}
    except OSError:
        return False
    return any(m in names for m in CARD_MARKERS)


# ---------------------------------------------------------------- zip sources

_ZIP_EXTRACTS: dict[str, str] = {}     # zip path -> extraction dir


def inspect_zip(zip_path: str | Path) -> dict:
    """Read a zip's contents without extracting, so the GUI can preview it."""
    zip_path = Path(zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()
        entries = [i for i in infos if not i.is_dir()]
        folders = _folders_in(infos)
        videos = [i for i in entries
                  if Path(i.filename).suffix.lower() in VIDEO_EXTS
                  and not is_junk(Path(i.filename))]
        return {
            "path": str(zip_path),
            "label": zip_path.stem,
            "entry_count": len(entries),
            "folder_count": len(folders),
            "video_count": len(videos),
            # A zip of nothing but folders is a structure template: it carries the
            # session folder's name and its cam layout, and no footage.
            "is_template": len(videos) == 0 and len(folders) > 0,
            "folders": sorted(folders)[:200],
            "compressed_bytes": sum(i.compress_size for i in entries),
            "uncompressed_bytes": sum(i.file_size for i in entries),
            "videos": [{"name": Path(i.filename).name,
                        "inner_path": i.filename,
                        "size": i.file_size,
                        "mtime": _zip_mtime(i)} for i in videos[:500]],
        }


def _folders_in(infos) -> set[str]:
    """Every folder the archive implies, whether or not it is stored explicitly.

    Some tools write a directory entry per folder; others store only file paths
    and leave the folders implied. Both have to be recognised, or a structure
    template made by the wrong tool looks empty.
    """
    out: set[str] = set()
    for i in infos:
        parts = Path(i.filename).parts
        if not i.is_dir():
            parts = parts[:-1]
        for n in range(1, len(parts) + 1):
            joined = "/".join(parts[:n])
            if joined and not is_junk(Path(joined)):
                out.add(joined)
    return out


def _zip_mtime(info: zipfile.ZipInfo) -> float:
    import datetime as dt
    try:
        return dt.datetime(*info.date_time).timestamp()
    except (ValueError, OverflowError):
        return 0.0


def _safe_member(name: str) -> bool:
    """Reject absolute paths and ../ escapes before extracting anything."""
    p = Path(name)
    return not p.is_absolute() and ".." not in p.parts


def extract_zip(zip_path: str | Path, dest: str | Path | None = None,
                progress=None) -> str:
    """Extract to a working folder and return its path.

    Zip entries carry their own modification times; those are restored onto the
    extracted files, because the whole naming scheme keys off last-modified.
    """
    zip_path = Path(zip_path)
    cached = _ZIP_EXTRACTS.get(str(zip_path))
    if cached and Path(cached).exists():
        return cached

    out = Path(dest) if dest else Path(tempfile.mkdtemp(prefix="vingest-zip-"))
    out.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()

        # Folders first, and every folder the archive implies — a structure
        # template is nothing but empty folders, so skipping them extracts nothing.
        for folder in sorted(_folders_in(infos)):
            if _safe_member(folder):
                (out / folder).mkdir(parents=True, exist_ok=True)

        members = [i for i in infos
                   if not i.is_dir() and _safe_member(i.filename)]
        total = len(members)
        for n, info in enumerate(members, 1):
            target = out / info.filename
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            stamp = _zip_mtime(info)
            if stamp:
                os.utime(target, (stamp, stamp))
            if progress and (n % 5 == 0 or n == total):
                progress({"stage": "extract", "done": n, "total": total,
                          "name": Path(info.filename).name})

        if progress and not total:
            progress({"stage": "extract", "done": 1, "total": 1,
                      "name": "folder structure"})

    _ZIP_EXTRACTS[str(zip_path)] = str(out)
    return str(out)


def cleanup_zip(zip_path: str | Path) -> bool:
    """Delete the temporary extraction for `zip_path`, if we made one."""
    path = _ZIP_EXTRACTS.pop(str(zip_path), None)
    if path and Path(path).exists() and Path(path).name.startswith("vingest-zip-"):
        shutil.rmtree(path, ignore_errors=True)
        return True
    return False


def eject(path: str) -> dict:
    """Unmount a volume once verification passes (macOS/Windows)."""
    try:
        if os.name == "nt":
            drive = str(Path(path).drive or path)[:2]
            subprocess.run(["powershell", "-NoProfile", "-Command",
                            f"(New-Object -comObject Shell.Application)"
                            f".Namespace(17).ParseName('{drive}')"
                            f".InvokeVerb('Eject')"],
                           check=True, capture_output=True, timeout=60)
        else:
            subprocess.run(["diskutil", "eject", path], check=True,
                           capture_output=True, timeout=60)
        return {"ejected": True, "path": path}
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
        detail = getattr(e, "stderr", b"")
        msg = detail.decode(errors="replace").strip() if detail else str(e)
        return {"ejected": False, "path": path, "error": msg or "Eject failed"}


# ------------------------------------------------------- camera card layouts

# Canon XF cards mount as CanonA_0006 / CanonB_0012 and hold their clips at
# XFVC/REEL_<n>. The trailing number differs per card and is not matched on —
# the structure is what identifies the card, and the letter says which camera
# body it came from.
CARD_LAYOUTS = [
    {
        "name": "Canon XF",
        "volume_prefix": "Canon",
        "inner": ["XFVC", "REEL_*"],
        "letter_re": r"^canon(?P<letter>[a-z])",
    },
]


def _children_matching(parent: Path, pattern: str) -> list[Path]:
    """Sub-folders of `parent` matching `pattern`, case-insensitively.

    A trailing '*' matches any suffix, so 'REEL_*' finds REEL_0006 whatever the
    card's number happens to be.
    """
    pat = pattern.lower()
    out: list[Path] = []
    try:
        for child in parent.iterdir():
            if not child.is_dir():
                continue
            name = child.name.lower()
            if pat.endswith("*"):
                if name.startswith(pat[:-1]):
                    out.append(child)
            elif name == pat:
                out.append(child)
    except OSError:
        return []
    return sorted(out)


def _walk_layout(root: Path, segments: list[str]) -> list[Path]:
    current = [root]
    for seg in segments:
        nxt: list[Path] = []
        for parent in current:
            nxt.extend(_children_matching(parent, seg))
        current = nxt
        if not current:
            return []
    return current


def find_camera_cards(layouts: list[dict] | None = None) -> dict:
    """Find mounted camera cards and the clips inside them.

    Looks for volumes whose name starts with the layout's prefix, then walks the
    layout's folder structure. The letter in a card's name (CanonA / CanonB) is
    reported as a cam number, since that is how the bodies are labelled.
    """
    import re as _re

    layouts = layouts or CARD_LAYOUTS
    cards: list[dict] = []

    for vol in list_volumes():
        vol_path = Path(vol["path"])
        name = vol_path.name
        for layout in layouts:
            if not name.lower().startswith(layout["volume_prefix"].lower()):
                continue
            reels = _walk_layout(vol_path, layout["inner"])
            if not reels:
                continue

            files: list[Path] = []
            for reel in reels:
                try:
                    files.extend(p for p in sorted(reel.iterdir())
                                 if p.is_file() and is_junk(p) is False
                                 and p.suffix.lower() in VIDEO_EXTS)
                except OSError:
                    continue

            cam = None
            m = _re.match(layout.get("letter_re", ""), name.lower()) \
                if layout.get("letter_re") else None
            if m and m.group("letter"):
                cam = ord(m.group("letter")) - ord("a") + 1

            cards.append({
                "volume": str(vol_path),
                "label": name,
                "layout": layout["name"],
                "reels": [str(r) for r in reels],
                "suggested_cam": cam,
                "file_count": len(files),
                "bytes": sum(f.stat().st_size for f in files if f.exists()),
                "files": [str(f) for f in files],
            })
            break

    cards.sort(key=lambda c: c["label"].lower())
    return {
        "cards": cards,
        "card_count": len(cards),
        "file_count": sum(c["file_count"] for c in cards),
        "searched": [l["volume_prefix"] + "* / " + "/".join(l["inner"]) for l in layouts],
    }

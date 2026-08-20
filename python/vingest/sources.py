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
        entries = [i for i in zf.infolist() if not i.is_dir()]
        videos = [i for i in entries
                  if Path(i.filename).suffix.lower() in VIDEO_EXTS
                  and not is_junk(Path(i.filename))]
        return {
            "path": str(zip_path),
            "label": zip_path.stem,
            "entry_count": len(entries),
            "video_count": len(videos),
            "compressed_bytes": sum(i.compress_size for i in entries),
            "uncompressed_bytes": sum(i.file_size for i in entries),
            "videos": [{"name": Path(i.filename).name,
                        "inner_path": i.filename,
                        "size": i.file_size,
                        "mtime": _zip_mtime(i)} for i in videos[:500]],
        }


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
        members = [i for i in zf.infolist()
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

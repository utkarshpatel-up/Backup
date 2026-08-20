"""ffprobe wrapper: duration, codec, and the H.265-vs-ProRes classification."""

from __future__ import annotations

import datetime as _dt
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path

VIDEO_EXTS = {".mov", ".mp4", ".mxf", ".m4v", ".avi", ".mts", ".m2ts",
              ".mkv", ".braw", ".r3d", ".insv", ".lrv"}
# Sidecars and camera junk we copy or skip but never treat as clips.
SIDECAR_EXTS = {".xml", ".cpi", ".bim", ".thm", ".lrf", ".sec", ".modd", ".moff"}
JUNK_NAMES = {".ds_store", "thumbs.db", "desktop.ini", ".spotlight-v100",
              ".fseventsd", ".trashes", "system volume information"}

PRORES_CODECS = {"prores", "prores_ks", "prores_aw"}
H265_CODECS = {"hevc", "h265"}

_FFPROBE: str | None = None
_FFMPEG: str | None = None


def _bundled_dir() -> Path | None:
    """PyInstaller unpacks bundled binaries next to the frozen executable."""
    base = getattr(sys, "_MEIPASS", None)
    return Path(base) if base else None


def _find(tool: str, override: str | None = None) -> str | None:
    exe = tool + (".exe" if os.name == "nt" else "")
    for cand in (override, os.environ.get(f"VINGEST_{tool.upper()}")):
        if cand and Path(cand).exists():
            return str(cand)
    bundled = _bundled_dir()
    if bundled and (bundled / exe).exists():
        return str(bundled / exe)
    found = shutil.which(tool)
    if found:
        return found
    for cand in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
                 r"C:\ffmpeg\bin", r"C:\Program Files\ffmpeg\bin"):
        p = Path(cand) / exe
        if p.exists():
            return str(p)
    return None


def configure(ffprobe: str | None = None, ffmpeg: str | None = None) -> dict:
    global _FFPROBE, _FFMPEG
    _FFPROBE = _find("ffprobe", ffprobe)
    _FFMPEG = _find("ffmpeg", ffmpeg)
    return {"ffprobe": _FFPROBE, "ffmpeg": _FFMPEG}


def ffprobe_path() -> str:
    if _FFPROBE is None:
        configure()
    if not _FFPROBE:
        raise RuntimeError(
            "ffprobe was not found. Install ffmpeg, or set its location in Settings.")
    return _FFPROBE


def _no_window() -> dict:
    """Keep PyInstaller/Windows from flashing a console for every probe."""
    if os.name != "nt":
        return {}
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return {"startupinfo": si, "creationflags": 0x08000000}


@dataclass
class MediaInfo:
    path: str
    name: str
    size: int
    mtime: float                      # last-modified, epoch seconds
    duration: float | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    profile: str | None = None
    created: float | None = None      # container creation_time, when present
    error: str | None = None

    @property
    def family(self) -> str:
        c = (self.video_codec or "").lower()
        if c in PRORES_CODECS:
            return "prores"
        if c in H265_CODECS:
            return "h265"
        if c in ("h264", "avc"):
            return "h264"
        return c or "unknown"

    def shoot_datetime(self) -> _dt.datetime:
        """Best available wall-clock time for this clip.

        Last-modified is the house rule (the user's cameras write it at stop),
        but a container creation_time that predates mtime is more trustworthy
        when files have been copied around by tools that reset mtime.
        """
        stamp = self.mtime
        if self.created and self.created < stamp:
            stamp = self.created
        return _dt.datetime.fromtimestamp(stamp)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["family"] = self.family
        d["shoot_iso"] = self.shoot_datetime().isoformat(timespec="seconds")
        return d


def _parse_created(tags: dict) -> float | None:
    raw = tags.get("creation_time") or tags.get("com.apple.quicktime.creationdate")
    if not raw:
        return None
    try:
        txt = raw.replace("Z", "+00:00")
        dt = _dt.datetime.fromisoformat(txt)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_dt.timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


def _fps(rate: str | None) -> float | None:
    if not rate or "/" not in rate:
        return None
    num, _, den = rate.partition("/")
    try:
        den_f = float(den)
        return round(float(num) / den_f, 3) if den_f else None
    except ValueError:
        return None


def probe(path: str | Path, timeout: int = 60) -> MediaInfo:
    p = Path(path)
    st = p.stat()
    info = MediaInfo(path=str(p), name=p.name, size=st.st_size, mtime=st.st_mtime)
    cmd = [ffprobe_path(), "-v", "error", "-print_format", "json",
           "-show_format", "-show_streams", str(p)]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=timeout, **_no_window())
    except subprocess.TimeoutExpired:
        info.error = "ffprobe timed out"
        return info
    if res.returncode != 0:
        info.error = (res.stderr or "ffprobe failed").strip().splitlines()[-1][:300]
        return info
    try:
        data = json.loads(res.stdout)
    except json.JSONDecodeError:
        info.error = "ffprobe returned unreadable output"
        return info

    fmt = data.get("format", {})
    if fmt.get("duration"):
        try:
            info.duration = float(fmt["duration"])
        except ValueError:
            pass
    info.created = _parse_created(fmt.get("tags", {}) or {})

    for s in data.get("streams", []):
        kind = s.get("codec_type")
        if kind == "video" and info.video_codec is None:
            info.video_codec = (s.get("codec_name") or "").lower()
            info.width, info.height = s.get("width"), s.get("height")
            info.fps = _fps(s.get("avg_frame_rate") or s.get("r_frame_rate"))
            info.profile = s.get("profile")
            if info.duration is None and s.get("duration"):
                try:
                    info.duration = float(s["duration"])
                except ValueError:
                    pass
            if info.created is None:
                info.created = _parse_created(s.get("tags", {}) or {})
        elif kind == "audio" and info.audio_codec is None:
            info.audio_codec = (s.get("codec_name") or "").lower()
    return info


def is_video(path: Path) -> bool:
    return path.suffix.lower() in VIDEO_EXTS


def is_junk(path: Path) -> bool:
    name = path.name.lower()
    return name in JUNK_NAMES or name.startswith("._")


def scan_videos(root: str | Path, max_depth: int = 8) -> list[Path]:
    """All video files under `root`, junk and hidden system dirs excluded."""
    root = Path(root)
    out: list[Path] = []
    if not root.exists():
        return out
    base_depth = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root):
        d = Path(dirpath)
        if len(d.parts) - base_depth >= max_depth:
            dirnames[:] = []
        dirnames[:] = [x for x in dirnames
                       if x.lower() not in JUNK_NAMES and not x.startswith("._")]
        for f in filenames:
            p = d / f
            if is_video(p) and not is_junk(p):
                out.append(p)
    out.sort(key=lambda p: str(p).lower())
    return out


@dataclass
class VolumeReport:
    """What a single source (SSD volume, SD card, or unzipped folder) holds."""
    root: str
    label: str
    file_count: int = 0
    probed: int = 0
    total_bytes: int = 0
    family: str = "unknown"
    confidence: float = 0.0
    families: dict = field(default_factory=dict)
    largest: dict | None = None
    samples: list = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["family_label"] = FAMILY_LABELS.get(self.family, self.family or "Unknown")
        return d


FAMILY_LABELS = {
    "prores": "Apple ProRes",
    "h265": "H.265 / HEVC",
    "h264": "H.264",
    "unknown": "Unknown",
}


def classify_source(root: str | Path, sample_size: int = 12,
                    label: str | None = None) -> VolumeReport:
    """Probe a sample of the biggest files on `root` and decide its codec family.

    Sampling the largest files (rather than the first few) avoids classifying a
    card off its proxy/LRV sidecars, which are H.264 even on a ProRes card.
    """
    root = Path(root)
    rep = VolumeReport(root=str(root), label=label or root.name or str(root))
    if not root.exists():
        rep.error = "Path does not exist"
        return rep

    files = scan_videos(root)
    rep.file_count = len(files)
    if not files:
        rep.error = "No video files found"
        return rep

    sized = sorted(((p.stat().st_size, p) for p in files), reverse=True)
    rep.total_bytes = sum(s for s, _ in sized)

    weights: dict[str, float] = {}
    for _, p in sized[:sample_size]:
        info = probe(p)
        rep.probed += 1
        rep.samples.append(info.to_dict())
        if info.error:
            continue
        # Weight by size: one 40 GB ProRes master outvotes ten tiny proxies.
        weights[info.family] = weights.get(info.family, 0.0) + max(info.size, 1)

    rep.families = {k: round(v) for k, v in weights.items()}
    if weights:
        best = max(weights, key=weights.get)
        rep.family = best
        rep.confidence = round(weights[best] / sum(weights.values()), 3)
    if rep.samples:
        rep.largest = rep.samples[0]
    return rep


def assign_roles(reports: list[VolumeReport]) -> dict:
    """Pick which report is the H.265 source and which is the ProRes source.

    Returns the assignment plus a reason string, so the GUI can show why and
    let the operator swap before anything is copied.
    """
    prores = [r for r in reports if r.family == "prores"]
    h265 = [r for r in reports if r.family == "h265"]
    result = {"prores": None, "h265": None, "unassigned": [], "reason": "",
              "confident": False}

    if len(prores) == 1 and len(h265) == 1:
        result.update(prores=prores[0].root, h265=h265[0].root, confident=True,
                      reason="Codec probe: one ProRes source and one H.265 source.")
    elif len(reports) == 2 and not prores and not h265:
        # Neither probed as a known family; fall back to size, since ProRes is
        # roughly an order of magnitude larger than H.265 for the same footage.
        a, b = sorted(reports, key=lambda r: r.total_bytes, reverse=True)
        result.update(prores=a.root, h265=b.root,
                      reason="Codec unclear — guessed from size (ProRes is much larger). "
                             "Confirm before copying.")
    else:
        if len(prores) == 1:
            result["prores"] = prores[0].root
        if len(h265) == 1:
            result["h265"] = h265[0].root
        assigned = {result["prores"], result["h265"]}
        result["unassigned"] = [r.root for r in reports if r.root not in assigned]
        result["reason"] = "Could not assign every source automatically — set the rest by hand."
    return result

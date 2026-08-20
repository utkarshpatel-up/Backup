"""Recognising the house structure that a source already carries.

A zip or SSD does not arrive as loose files needing a name invented for them —
it arrives already organised and already named:

    3017 Dt-16 Aug 2026/                      <- job folder
      Adalaj Soneri ... General Satsang E. Dt-16-Aug-26/   <- session folder
        <master file>
        Clips for Insert/
          Cam-01/  Cam-02/  Cam-03/

The only thing missing is the ` Dur-54m1s` on the session folder. This module
finds that folder so the app can complete its name instead of asking for it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, asdict, field
from pathlib import Path

from . import naming
from .probe import is_junk, is_video, probe, scan_videos

CLIPS_ALIASES = {"clips for insert", "clips", "inserts", "insert clips"}


@dataclass
class Detected:
    root: str
    session_path: str | None = None
    session_name: str = ""
    base_name: str = ""              # session name minus any Dur- token
    has_dur: bool = False
    current_dur: int | None = None
    job_path: str | None = None
    job_name: str = ""
    clips_dir: str | None = None
    cams: dict = field(default_factory=dict)      # "1" -> [paths already filed]
    master_candidates: list = field(default_factory=list)
    loose_clips: list = field(default_factory=list)
    confidence: str = "none"         # strong | weak | none
    reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _clips_child(folder: Path) -> Path | None:
    """The 'Clips for Insert' folder inside `folder`, whatever its exact casing."""
    try:
        for child in folder.iterdir():
            if child.is_dir() and child.name.lower() in CLIPS_ALIASES:
                return child
    except OSError:
        pass
    return None


def _candidate_folders(root: Path, max_depth: int = 3):
    """`root` and its descendants, shallowest first, junk skipped."""
    yield root
    base = len(root.parts)
    for dirpath, dirnames, _ in os.walk(root):
        d = Path(dirpath)
        if len(d.parts) - base >= max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = sorted(x for x in dirnames
                             if not is_junk(d / x) and x.lower() not in CLIPS_ALIASES
                             and not naming.CAM_FOLDER_RE.match(x))
        for name in dirnames:
            yield d / name


def detect(root: str | Path, probe_masters: bool = True) -> Detected:
    """Find the session folder under `root` and report what it already contains."""
    root = Path(root)
    out = Detected(root=str(root))
    if not root.is_dir():
        out.reason = "Path is not a folder"
        return out

    session: Path | None = None
    clips: Path | None = None

    # Strongest signal: the folder that actually holds "Clips for Insert".
    for folder in _candidate_folders(root):
        found = _clips_child(folder)
        if found is not None:
            session, clips = folder, found
            out.confidence = "strong"
            out.reason = f"Found “{found.name}” inside this folder."
            break

    # Next best: a folder already carrying a Dt- token.
    if session is None:
        for folder in _candidate_folders(root):
            if folder != root and naming.DATE_TOKEN_RE.search(folder.name):
                session = folder
                out.confidence = "weak"
                out.reason = "This folder's name carries a Dt- token."
                break

    # Last resort: a zip that unpacked to exactly one folder.
    if session is None:
        try:
            children = [c for c in root.iterdir() if c.is_dir() and not is_junk(c)]
        except OSError:
            children = []
        if len(children) == 1:
            session = children[0]
            out.confidence = "weak"
            out.reason = "The only folder in this source."
        elif any(is_video(p) for p in root.iterdir() if p.is_file()):
            session = root
            out.confidence = "weak"
            out.reason = "Video files sit directly in this folder."

    if session is None:
        out.reason = "No session folder recognised — pick one by hand."
        return out

    out.session_path = str(session)
    out.session_name = session.name
    out.base_name = naming.DUR_TOKEN_RE.sub("", session.name).strip()
    token = naming.DUR_TOKEN_RE.search(session.name)
    out.has_dur = token is not None
    if token:
        out.current_dur = naming.parse_duration(token.group(0).strip()[4:])

    parent = session.parent
    if session != root and parent != session:
        out.job_path, out.job_name = str(parent), parent.name

    if clips is None:
        clips = _clips_child(session)
    if clips is not None:
        out.clips_dir = str(clips)
        try:
            for child in sorted(clips.iterdir()):
                m = naming.CAM_FOLDER_RE.match(child.name)
                if child.is_dir() and m:
                    out.cams[str(int(m.group(1)))] = [
                        str(p) for p in sorted(child.iterdir())
                        if p.is_file() and is_video(p)]
        except OSError:
            pass

    # Videos sitting directly in the session folder are master candidates;
    # anything else not already filed into a cam is a loose clip.
    filed = {p for paths in out.cams.values() for p in paths}
    try:
        masters = [p for p in sorted(session.iterdir()) if p.is_file() and is_video(p)]
    except OSError:
        masters = []
    if probe_masters:
        out.master_candidates = [probe(p).to_dict() for p in masters]
    else:
        out.master_candidates = [{"path": str(p), "name": p.name} for p in masters]

    master_paths = {str(p) for p in masters}
    out.loose_clips = [str(p) for p in scan_videos(root)
                       if str(p) not in filed and str(p) not in master_paths]
    return out


def unfiled_clips(detected: Detected | dict, master_path: str | None = None) -> list[str]:
    """Every video not already filed into a cam folder, minus the master.

    Unfiled clips usually sit beside the master at the session root, so they
    show up as master candidates too; whichever file is chosen as the master is
    the only one excluded here.
    """
    d = detected if isinstance(detected, dict) else detected.to_dict()
    paths = [c["path"] for c in d.get("master_candidates", [])]
    paths += list(d.get("loose_clips", []))
    return [p for p in dict.fromkeys(paths) if p != master_path]


def pick_master(detected: Detected | dict) -> dict | None:
    """The longest video sitting at the session-folder root.

    The master is the program recording, so on length alone it wins against
    anything else that might be lying beside it.
    """
    d = detected if isinstance(detected, dict) else detected.to_dict()
    cands = [c for c in d.get("master_candidates", []) if c.get("duration")]
    if not cands:
        cands = d.get("master_candidates", [])
    return max(cands, key=lambda c: c.get("duration") or 0) if cands else None


def planned_rename(detected: dict, seconds: float | None) -> dict:
    """What the session folder is called now, and what it becomes."""
    base = detected.get("base_name") or ""
    final = base + (f" Dur-{naming.fmt_duration(seconds)}" if seconds is not None else "")
    final = naming.sanitize(final) if final else ""
    return {
        "from": detected.get("session_name", ""),
        "to": final,
        "changed": bool(final) and final != detected.get("session_name"),
        "duration_label": naming.fmt_duration(seconds) if seconds is not None else "",
    }

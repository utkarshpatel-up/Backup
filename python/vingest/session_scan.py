"""Read the session folders on a drive: each session's duration and clip count.

Durations come straight from the file headers (see :mod:`durations`, no ffmpeg
needed). This module, like the rest of the engine, never touches the network.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from .durations import get_duration
from .ingest import CLIP_COUNT_EXTS

SESSION_NUM_RE = re.compile(r"^(\d+)\b")
CAM_FOLDER_RE = re.compile(r"cam[-\s_]*\d+", re.IGNORECASE)
# A project (job) folder: the id sits at the very START of the name, followed by
# the spaced ` Dt-<date>` token that naming.build_job_folder writes
# ('2486 Dt-08 Nov 2025'). Anchoring at the start is what keeps a range folder
# ('2456 to 2540') and a session's own 'Clips-1763' count from being mistaken
# for a project id.
PROJECT_DIR_RE = re.compile(r"^\s*(\d{4,})\s+Dt-", re.IGNORECASE)


def _is_cam_folder(name: str) -> bool:
    return bool(CAM_FOLDER_RE.search(name))


def _session_number(name: str):
    """Leading session integer ('02 Event' -> 2); None if it looks like an id."""
    m = SESSION_NUM_RE.match(name)
    if not m:
        return None
    val = int(m.group(1))
    return val if val < 100 else None


def _scan_one(folder: Path, extensions):
    """Total seconds, clip count and unknown-duration count under `folder`."""
    total = 0.0
    count = 0
    unknown = 0
    for dirpath, _dirs, files in os.walk(folder):
        for f in files:
            if f.startswith("."):
                continue
            if os.path.splitext(f)[1].lower() not in extensions:
                continue
            count += 1
            secs = get_duration(os.path.join(dirpath, f))
            if secs is None:
                unknown += 1
            else:
                total += secs
    return total, count, unknown


def scan_sessions(root: str, extensions=None) -> list[dict]:
    """Every informal session folder under `root`, with its duration and count.

    The house tree is: a project (job) folder ``NNNN Dt-<date>`` holds one or
    more session folders, and everything below a session — camera folders, and
    for the big 'Informal from MM' jobs a whole day/source sub-tree — rolls up
    into that one session. So a session is a direct, non-camera child of a
    project folder; its clips are counted recursively, and nothing deeper is
    ever a session of its own.

    The session number is its leading index (``02 Event`` -> 2); a single
    unnumbered session (``Adalaj … Clips-68``) is session 1, matching the
    duration-list convention (``DD-I-HD-2456-1``). This deliberately does NOT
    treat a folder as a session just because its name starts with a number:
    the day folders inside ``… Clips-1763`` (``10 - Nov 08``) are not sessions,
    and the ``1763`` clip count is never read as a project id.
    """
    root = os.path.abspath(root)
    exts = set(extensions) if extensions else set(CLIP_COUNT_EXTS)
    sessions = []
    for dirpath, dirnames, _files in os.walk(root):
        m = PROJECT_DIR_RE.match(os.path.basename(dirpath))
        if not m:
            continue
        project = m.group(1)
        # This is a project folder. Take its direct child folders as sessions
        # and stop descending — the sub-tree belongs to those sessions.
        dirnames[:] = []
        try:
            children = sorted(p for p in Path(dirpath).iterdir() if p.is_dir())
        except OSError:
            continue
        for child in children:
            if child.name.startswith(".") or _is_cam_folder(child.name):
                continue
            session = _session_number(child.name)
            if session is None:
                session = 1
            total, count, unknown = _scan_one(child, exts)
            if count == 0:
                continue
            sessions.append({
                "path": str(child),
                "folder": child.name,
                "project": project,
                "session": session,
                "seconds": round(total, 2),
                "clips": count,
                "unknown": unknown,
            })
    sessions.sort(key=lambda s: (int(s["project"]), s["session"]))
    return sessions

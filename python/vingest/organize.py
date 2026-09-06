"""Rename an already-filed informal session in place.

This is the engine-side twin of scripts/renaming_informal_standalone.py, exposed
so the app can offer it as a one-click tool instead of the operator running a
script by hand. Point it at a folder and it:

  1. renames raw camera clips (random device names) to the house
     ``[Cam-NN ]Event Name Clip-NNN.ext`` scheme, sequencing each clip group by
     modified time, and
  2. rewrites every session folder's ``Clips-NN`` token to the real number of
     media files (video + audio) it holds, counted recursively across all of its
     Cam-NN sub-folders.

Nothing is touched until :func:`apply_rename` is called with a plan produced by
:func:`plan_rename`, so the GUI can show the full before/after for approval.
The naming rules are shared with the rest of the app (see ``naming`` and
``ingest``) so this tool and a normal informal backup name clips identically.
"""

from __future__ import annotations

import os

from . import naming
from .ingest import CLIP_COUNT_EXTS, _count_clip_files


def _cam_label(folder_name: str):
    """The 'Cam-NN' portion of a camera folder name, or None."""
    match = naming.CAM_PREFIX_RE.match(folder_name or "")
    return match.group(1) if match else None


def _find_event_folder(dirpath: str, root: str) -> str:
    """Walk up from a clip-group directory to the folder that names the event,
    skipping any Cam-NN folder the clips sit inside."""
    current = dirpath
    while True:
        base = os.path.basename(current)
        if not _cam_label(base):
            return base
        parent = os.path.dirname(current)
        if parent == current or os.path.normpath(parent) == os.path.normpath(root):
            return base
        current = parent


def _clip_groups(root: str, extensions):
    """Yield (dirpath, [filenames]) for every directory that directly holds at
    least one media file."""
    for dirpath, _dirnames, filenames in os.walk(root):
        media = [
            f for f in filenames
            if not f.startswith(".")
            and os.path.splitext(f)[1].lower() in extensions
        ]
        if media:
            yield dirpath, media


def _rel(path: str, root: str) -> str:
    try:
        return os.path.relpath(path, root)
    except ValueError:                     # different drive on Windows
        return path


def plan_rename(root: str, extensions=None) -> dict:
    """Build the full rename plan for `root` without touching any file.

    Returns a dict with ``files`` (clip renames) and ``folders`` (Clips-NN count
    updates), each entry carrying absolute and root-relative old/new paths.
    """
    root = os.path.abspath(root)
    exts = set(extensions) if extensions else set(CLIP_COUNT_EXTS)

    files = []
    for dirpath, filenames in _clip_groups(root, exts):
        folder_base = os.path.basename(dirpath)
        cam = folder_base if _cam_label(folder_base) else ""
        event_folder = _find_event_folder(dirpath, root)

        # Clips are sequenced by their date modified — the "Date" column shown in
        # Explorer, i.e. when each clip was recorded — oldest first. The original
        # name breaks ties so files sharing a timestamp keep a stable order.
        with_mtime = []
        for f in filenames:
            full = os.path.join(dirpath, f)
            try:
                mtime = os.path.getmtime(full)
            except OSError:
                mtime = 0.0
            with_mtime.append((f, mtime))
        with_mtime.sort(key=lambda pair: (pair[1], pair[0].lower()))

        for index, (fname, _mtime) in enumerate(with_mtime, start=1):
            ext = os.path.splitext(fname)[1]
            new_name = naming.informal_clip_name(event_folder, cam, index, ext)
            if new_name == fname:
                continue                    # already correctly named
            old_path = os.path.join(dirpath, fname)
            new_path = os.path.join(dirpath, new_name)
            files.append({
                "old_path": old_path, "new_path": new_path,
                "rel_old": _rel(old_path, root), "rel_new": _rel(new_path, root),
                "mtime": _mtime,
            })

    folders = []
    for dirpath, dirnames, _filenames in os.walk(root):
        for d in dirnames:
            # Only folders that already carry a Clips-NN count are re-tallied, so
            # the tool never invents a token on a folder that was not using one.
            if not naming.CLIPS_TOKEN_RE.search(d):
                continue
            folder_path = os.path.join(dirpath, d)
            count = _count_clip_files(folder_path)
            new_name = naming.set_clips_count(d, count)
            if new_name == d:
                continue
            new_path = os.path.join(dirpath, new_name)
            folders.append({
                "old_path": folder_path, "new_path": new_path,
                "rel_old": _rel(folder_path, root), "rel_new": _rel(new_path, root),
                "count": count,
            })

    # Both the clip numbering (above) and the preview order follow date modified,
    # so the list reads oldest-to-newest — the order the clips were recorded,
    # matching Clip-001, Clip-002, … The new name breaks ties.
    files.sort(key=lambda item: (item["mtime"], item["rel_new"].lower()))
    folders.sort(key=lambda item: item["rel_new"].lower())

    return {
        "root": root,
        "files": files,
        "folders": folders,
        "file_count": len(files),
        "folder_count": len(folders),
    }


def apply_rename(plan: dict) -> dict:
    """Perform the renames in a plan produced by :func:`plan_rename`.

    Files are renamed through a temporary intermediate name so a swap of two
    clips can never collide; folders are renamed deepest-first so renaming a
    parent never invalidates a child's path.
    """
    files = plan.get("files", [])
    folders = plan.get("folders", [])
    errors: list[str] = []

    temp_pairs = []
    for i, item in enumerate(files):
        old_path = item["old_path"]
        dirpath = os.path.dirname(old_path)
        temp_path = os.path.join(
            dirpath, f".__vingest_rename_{i}__{os.path.basename(old_path)}")
        try:
            os.rename(old_path, temp_path)
            temp_pairs.append((temp_path, item["new_path"]))
        except OSError as e:
            errors.append(f"{item.get('rel_old', old_path)}: {e}")

    renamed_files = 0
    for temp_path, new_path in temp_pairs:
        try:
            os.rename(temp_path, new_path)
            renamed_files += 1
        except OSError as e:
            errors.append(f"{os.path.basename(new_path)}: {e}")

    renamed_folders = 0
    for item in sorted(folders, key=lambda f: f["old_path"].count(os.sep),
                       reverse=True):
        old_path, new_path = item["old_path"], item["new_path"]
        try:
            if os.path.exists(new_path):
                errors.append(
                    f"{item.get('rel_new', new_path)}: a folder with that name "
                    f"already exists — left unchanged.")
                continue
            os.rename(old_path, new_path)
            renamed_folders += 1
        except OSError as e:
            errors.append(f"{item.get('rel_old', old_path)}: {e}")

    return {
        "renamed_files": renamed_files,
        "renamed_folders": renamed_folders,
        "errors": errors,
    }

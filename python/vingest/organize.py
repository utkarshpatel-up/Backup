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
import re
from pathlib import Path

from . import naming, structure
from .session_scan import PROJECT_DIR_RE
from .ingest import CLIP_COUNT_EXTS, _count_clip_files

# A camera folder inside a job or session: 'Cam-01', 'Cam-07 (Drone)'.
CAM_DIR_RE = re.compile(r"^Cam-\d+\b", re.IGNORECASE)
# An Informal clip the app named: '[Cam-01 ]<event>[ Clip-001][ (2)]'.
INFORMAL_STEM_RE = re.compile(
    r"^(?P<cam>Cam-\d+\s)?(?P<event>.+?)(?P<clip>\sClip-\d{3,})?(?P<dup>\s\(\d+\))?$", re.IGNORECASE)


def _cam_label(folder_name: str):
    """The 'Cam-NN' portion of a camera folder name, or None."""
    match = naming.CAM_PREFIX_RE.match(folder_name or "")
    return match.group(1) if match else None


def _find_event_folder(dirpath: str, root: str) -> str:
    return os.path.basename(_find_event_path(dirpath))


def _find_event_path(dirpath: str) -> str:
    """Walk up from a clip-group directory to the folder that names the event,
    skipping any Cam-NN folder the clips sit inside.

    The walk may pass the chosen root: when the operator picks the session
    folder itself, its Cam-NN sub-folders must still take the session's name,
    not their own "Cam-02".
    """
    current = os.path.normpath(dirpath)
    while _cam_label(os.path.basename(current)):
        parent = os.path.dirname(current)
        if parent == current:              # reached the top of the drive
            break
        current = parent
    return current


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

    groups = list(_clip_groups(root, exts))
    # A session (event folder) holding a single clip names it without a number,
    # just as its folder carries no Clips- count; count across its Cam folders.
    per_event: dict[str, int] = {}
    for dirpath, filenames in groups:
        key = os.path.normcase(_find_event_path(dirpath))
        per_event[key] = per_event.get(key, 0) + len(filenames)

    files = []
    for dirpath, filenames in groups:
        folder_base = os.path.basename(dirpath)
        cam = folder_base if _cam_label(folder_base) else ""
        event_folder = _find_event_folder(dirpath, root)
        lone = per_event[os.path.normcase(_find_event_path(dirpath))] == 1

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
            new_name = naming.informal_clip_name(event_folder, cam, None if lone else index, ext)
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


# ------------------------------------------- rename a filed session to a row

# Left by Explorer/Finder in a folder; an old job folder holding only these is empty.
SYSTEM_FILES = {"thumbs.db", "desktop.ini", ".ds_store"}
# The ceremony tag a Formal master's topic was swapped for (Pujyashree's Entry …).
CEREMONY_RE = re.compile(r"\bPujyashree[’']s (?:Welcome|Entry|Exit)\b", re.IGNORECASE)


def _media(files):
    return [f for f in files if not f.startswith(".")
            and os.path.splitext(f)[1].lower() in CLIP_COUNT_EXTS]


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def _informal_renames(session: Path, new_folder: str) -> list[tuple[str, str]]:
    """Every clip of an Informal session renamed as the backup names it, after
    `new_folder`: 'Cam-01 <event> Clip-001' in each camera folder (no Cam-
    prefix in the session folder itself), numbered by date modified, and the
    session's only clip left unnumbered. Camera names like C0007.MP4 included:
    an Informal backup renames every clip, so any other name was put there by hand."""
    groups = []
    for dirpath, dirnames, filenames in os.walk(session):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        media = _media(filenames)
        if media:
            groups.append((dirpath, media))
    lone = sum(len(m) for _, m in groups) == 1
    out = []
    for dirpath, media in groups:
        base = os.path.basename(dirpath)
        cam = base if _cam_label(base) else ""
        ordered = sorted(media, key=lambda f: (_mtime(os.path.join(dirpath, f)), f.lower()))
        for index, f in enumerate(ordered, 1):
            new = naming.informal_clip_name(new_folder, cam, None if lone else index,
                                            os.path.splitext(f)[1])
            if new != f:
                out.append((os.path.join(dirpath, f), os.path.join(dirpath, new)))
    return out


def _formal_renames(session: Path, old_folder: str, new_folder: str) -> tuple[list, int]:
    """The masters of a Formal session (media in the session folder itself),
    renamed after `new_folder` with their own Dur-/Clip- kept: the ordinary ones
    take the new name, and an Entry/Welcome/Exit master keeps its ceremony tag
    in place of the topic. Camera clips in 'Clips for Insert' keep their names.
    Returns (renames, files left alone)."""
    def core(name):      # a master's name before its Dur-/Clip- tokens, date included
        return naming.LEADING_INDEX_RE.sub("", naming.session_base(name)).strip()
    new_core = core(new_folder)
    out, kept = [], 0
    for dirpath, dirnames, filenames in os.walk(session):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in sorted(_media(filenames)):
            stem, ext = os.path.splitext(f)
            date = naming.DATE_TOKEN_RE.search(stem)
            if Path(dirpath) != session or not date:
                kept += 1
                continue
            new = naming.sanitize(f"{new_core} {stem[date.end():].strip()}".strip()) + ext
            tag = CEREMONY_RE.search(stem[:date.start()])
            if tag:
                new = naming.replace_topic(new, tag.group(0))
            if new != f:
                out.append((os.path.join(dirpath, f), os.path.join(dirpath, new)))
    return out, kept


def plan_session_rename(session_path: str, new_session: str,
                        new_job: str = "") -> dict:
    """Preview renaming an already backed-up session folder to an event
    schedule row's name, without touching anything.

    - The session folder takes the row's name and keeps its Dur- token; an
      Informal session's Clips- count is re-tallied, a Formal one's kept.
    - Informal: every clip is renamed as the backup names it (see
      _informal_renames). Formal: the masters are, ceremony ones keeping
      their tag; camera clips keep their card names.
    - Job folder: when the session is alone in its job folder and the row's job
      folder is not on the drive, the job folder is renamed. Otherwise the
      session moves into the row's job folder beside it (made when missing),
      leaving the other sessions where they are; an old job folder left empty
      is removed. A move stays on the same drive, so nothing is copied.
    """
    session = Path(os.path.abspath(session_path))
    if not session.is_dir():
        raise ValueError(f"“{session}” is not a folder.")
    old_name = session.name
    base = naming.session_base(naming.sanitize(new_session)) if str(new_session or "").strip() else ""
    if not base:
        raise ValueError("The row has no session name.")
    dur = naming.DUR_TOKEN_RE.search(old_name)
    new_name = naming.sanitize(" ".join([base, *([dur.group(0).strip()] if dur else [])]))
    _, tag = structure._date_and_tag(old_name)
    informal = tag is None
    if informal:
        renames, kept = _informal_renames(session, new_name), 0
        count = _count_clip_files(str(session))
        new_name = naming.set_clips_count(new_name, count)
    else:
        renames, kept = _formal_renames(session, old_name, new_name)
        clips = naming.CLIPS_TOKEN_RE.search(old_name)
        if clips:
            new_name = naming.sanitize(f"{new_name} {clips.group(0).strip()}")

    # A new name may be another clip's old one (renumbering): those are freed by
    # the rename itself, which goes through temporary names.
    leaving = {os.path.normcase(a) for a, _ in renames}
    files, landing = [], set()
    for old, new in renames:
        key = os.path.normcase(new)
        if key in landing or (os.path.exists(new) and key not in leaving):
            raise ValueError(f"“{os.path.basename(new)}” is already there — nothing renamed.")
        landing.add(key)
        files.append({"old_path": old, "new_path": new,
                      "rel_old": os.path.relpath(old, session.parent),
                      "rel_new": os.path.relpath(new, session.parent)})

    job, drive = session.parent, session.parent.parent
    folders, notes, make, remove = [], [], [], []
    job_new = naming.sanitize(new_job) if str(new_job or "").strip() else ""   # sanitize("") is "untitled"
    number = (PROJECT_DIR_RE.match(job_new) or [None, None])[1] if job_new else None
    if not job_new or job_new == job.name:
        target_job = job
    else:
        try:
            siblings = [c for c in job.iterdir() if c.is_dir() and c != session
                        and not c.name.startswith(".") and not CAM_DIR_RE.match(c.name)]
        except OSError:
            siblings = []
        # The row's job folder already on the drive: by name, else by its number.
        existing = drive / job_new
        if not existing.is_dir() and number:
            existing = next((c for c in sorted(drive.iterdir()) if c.is_dir() and c != job
                             and (m := PROJECT_DIR_RE.match(c.name)) and m.group(1) == number),
                            drive / job_new)
        if not siblings and not existing.is_dir():
            target_job = job          # renamed below, after the session inside it
        else:
            target_job = existing
            if not existing.is_dir():
                make.append(str(existing))
                notes.append(f"Makes the job folder “{existing.name}”.")
            if siblings:
                notes.append(f"The other session(s) in “{job.name}” stay there.")
            else:
                remove.append(str(job))
                notes.append(f"“{job.name}” is removed once it is empty.")

    final = target_job / new_name
    if os.path.normcase(str(final)) != os.path.normcase(str(session)):
        if final.exists():
            raise ValueError(f"“{final.parent.name}/{final.name}” is already there — nothing renamed.")
        folders.append({"old_path": str(session), "new_path": str(final),
                        "rel_old": os.path.relpath(session, drive),
                        "rel_new": os.path.relpath(final, drive)})
    if target_job == job and job_new and job_new != job.name:
        folders.append({"old_path": str(job), "new_path": str(drive / job_new),
                        "rel_old": job.name, "rel_new": job_new})
        final = drive / job_new / new_name
    if kept:
        notes.append(f"{kept} camera clip(s) keep their names.")
    return {"root": str(session), "old_name": old_name, "new_name": new_name,
            "job_old": job.name, "files": files, "folders": folders, "notes": notes,
            "make_dirs": make, "remove_if_empty": remove, "final_path": str(final)}


def apply_session_rename(plan: dict) -> dict:
    """Perform a plan_session_rename plan: make the row's job folder when it is
    new, rename the files then the folders, and remove an old job folder the
    session left empty (system files such as Thumbs.db do not count)."""
    errors = []
    for d in plan.get("make_dirs") or []:
        try:
            os.makedirs(d, exist_ok=True)
        except OSError as e:
            errors.append(f"{os.path.basename(d)}: {e}")
    if errors:
        return {"renamed_files": 0, "renamed_folders": 0, "removed": [], "errors": errors}
    result = apply_rename(plan)
    removed = []
    for d in plan.get("remove_if_empty") or []:
        try:
            names = os.listdir(d)
            if all(n.lower() in SYSTEM_FILES or n.startswith("._") for n in names):
                for n in names:
                    os.remove(os.path.join(d, n))
                os.rmdir(d)
                removed.append(os.path.basename(d))
        except OSError:
            pass                       # left in place: it is not empty, or still in use
    result["removed"] = removed
    return result

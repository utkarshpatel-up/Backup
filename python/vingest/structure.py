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

import datetime as _dt
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
    session_date: str | None = None  # ISO date parsed from the folder's Dt- token
    dur_precision: str = "s"         # smallest unit the folder's Dur- token uses
    tree: list = field(default_factory=list)      # every folder, relative to session
    video_count: int = 0
    is_template: bool = False        # a structure with no footage in it at all
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


def _camera_children(folder: Path) -> list[Path]:
    """Camera folders directly inside ``folder``.

    Some supplied structure archives omit the ``Clips for Insert`` wrapper and
    put Cam-01, Cam-02, ... directly below each event.  That is still a strong
    session signal. Informal filing preserves that direct layout; Formal filing
    uses the ``Clips for Insert`` house layout.
    """
    try:
        return [child for child in sorted(folder.iterdir())
                if child.is_dir() and naming.CAM_FOLDER_RE.match(child.name)]
    except OSError:
        return []


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


def detect(root: str | Path, probe_masters: bool = True,
           preferred_session: str | Path | None = None) -> Detected:
    """Find one session folder under ``root`` and report what it contains.

    ``preferred_session`` lets a caller select one folder after :func:`detect_all`
    has presented every session in a structure archive.
    """
    root = Path(root)
    out = Detected(root=str(root))
    if not root.is_dir():
        out.reason = "Path is not a folder"
        return out

    session: Path | None = None
    clips: Path | None = None

    if preferred_session is not None:
        candidate = Path(preferred_session)
        try:
            root_resolved = root.resolve()
            candidate_resolved = candidate.resolve()
        except OSError:
            root_resolved, candidate_resolved = root, candidate
        if (candidate_resolved != root_resolved
                and root_resolved not in candidate_resolved.parents):
            out.reason = "That folder isn't part of the imported structure."
            return out
        if not candidate.is_dir():
            out.reason = "That session folder is no longer there."
            return out
        session = candidate
        clips = _clips_child(session)
        has_camera_layout = clips is not None or bool(_camera_children(session))
        out.confidence = "strong" if has_camera_layout else "weak"
        out.reason = (f"Selected “{session.name}” from the imported structure."
                      if has_camera_layout
                      else f"Selected folder “{session.name}”.")

    # Strongest signal: a Clips wrapper or direct camera folders.
    if session is None:
        for folder in _candidate_folders(root):
            found = _clips_child(folder)
            direct_cams = _camera_children(folder)
            if found is not None or direct_cams:
                session, clips = folder, found
                out.confidence = "strong"
                out.reason = (f"Found “{found.name}” inside this folder."
                              if found is not None else
                              "Found camera folders directly inside this folder.")
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
        out.reason = "No session folder found."
        return out

    parent = session.parent
    out.session_path = str(session)
    out.session_name = session.name
    out.base_name = naming.DUR_TOKEN_RE.sub("", session.name).strip()
    # The folder already states the shoot date; that is what makes it possible to
    # suggest which files on the drive belong to this session.
    dated = naming.parse_date_token(session.name) or naming.parse_date_token(parent.name)
    out.session_date = dated.isoformat() if dated else None
    out.dur_precision = naming.token_precision(token.group(0).strip()[4:]) \
        if (token := naming.DUR_TOKEN_RE.search(session.name)) else "s"

    out.has_dur = token is not None
    if token:
        out.current_dur = naming.parse_duration(token.group(0).strip()[4:])

    if session != root and parent != session:
        out.job_path, out.job_name = str(parent), parent.name

    if clips is None:
        clips = _clips_child(session)
    cam_root = clips if clips is not None else session
    camera_children = _camera_children(cam_root)
    if clips is not None:
        out.clips_dir = str(clips)
    if camera_children:
        try:
            for child in camera_children:
                m = naming.CAM_FOLDER_RE.match(child.name)
                if m:
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

    out.tree = folder_tree(session)
    out.video_count = len(scan_videos(session))
    # An empty structure is not a failure — it is a template: the folder name and
    # cam layout are exactly what is wanted, and the footage comes from elsewhere.
    out.is_template = out.video_count == 0
    if out.is_template:
        out.reason += (" It holds no video, so it will be used as a structure "
                       "template — pick the footage from another source.")
    return out


def detect_all(root: str | Path, probe_masters: bool = True) -> list[Detected]:
    """Return every session represented below a structure root.

    A session containing ``Clips for Insert`` or direct ``Cam-NN`` folders is
    authoritative. If no such folder exists, retain the legacy weak
    single-folder detection as a fallback.
    """
    root = Path(root)
    if not root.is_dir():
        return []
    sessions: list[Path] = []
    seen: set[str] = set()
    for folder in _candidate_folders(root):
        if _clips_child(folder) is None and not _camera_children(folder):
            continue
        key = os.path.normcase(os.path.abspath(str(folder)))
        if key not in seen:
            seen.add(key)
            sessions.append(folder)
    if sessions:
        return [detect(root, probe_masters, folder) for folder in sessions]
    fallback = detect(root, probe_masters)
    return [fallback] if fallback.session_path else []


def folder_tree(session: str | Path, max_depth: int = 4) -> list[str]:
    """Every folder under `session`, relative and sorted.

    A template's empty Cam folders are part of what it defines, so they are
    recreated at the destination even when no clip is assigned to them.
    """
    session = Path(session)
    out: list[str] = []
    base = len(session.parts)
    for dirpath, dirnames, _ in os.walk(session):
        d = Path(dirpath)
        if len(d.parts) - base >= max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = sorted(x for x in dirnames if not is_junk(d / x))
        for name in dirnames:
            out.append("/".join((d / name).relative_to(session).parts))
    return sorted(out)


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
    current = detected.get("session_name", "")
    final = naming.complete_with_dur(current, seconds) if current else ""
    token = naming.DUR_TOKEN_RE.search(final)
    return {
        "from": current,
        "to": final,
        "changed": bool(final) and final != current,
        "duration_label": token.group(0).strip()[4:] if token else "",
        "precision": naming.token_precision(
            naming.DUR_TOKEN_RE.search(current).group(0).strip()[4:])
        if naming.DUR_TOKEN_RE.search(current) else "s",
    }


# ------------------------------------------------- numbering earlier sessions

def _session_key(name: str) -> str:
    """A session folder's name without its leading number or Dur-/Clips- tokens."""
    base = naming.LEADING_INDEX_RE.sub("", naming.session_base(name))
    return " ".join(base.split()).lower()


def _date_and_tag(name: str):
    """(Dt- date, session tag such as "M" / "E2") from a session folder name."""
    base = naming.session_base(name)
    date = naming.DATE_TOKEN_RE.search(base)
    head = base[:date.start()] if date else base
    tag = naming.SESSION_INDICATOR_RE.search(head.strip())
    return (naming.parse_date_token(base), tag.group(1).upper() if tag else None)


def _session_order(name: str):
    when, tag = _date_and_tag(name)
    rank = {"M": 0, "E": 1}.get((tag or "")[:1], 2)
    return (when or _dt.date.max, rank, tag or "", name.lower())


def find_unnumbered_sessions(job_dirs: list, session_names: list) -> list:
    """Earlier session folders that were filed before the day had a second
    session, so they lack the "01 " the structure zip now numbers them with.

    A folder is matched to a numbered zip session by name, or by its date and
    session tag (M./E.) if the name was edited since. Any left over take the
    numbers the zip does not use (e.g. 01 when the zip only carries 02), but
    only when that pairing is unambiguous. Nothing is renamed here.
    """
    numbered = {}
    for name in session_names or []:
        m = naming.LEADING_INDEX_RE.match(name or "")
        if m:
            numbered[name] = int(m.group(0))
    if not numbered:
        return []

    out = []
    for job in job_dirs or []:
        job_path = Path(job)
        if not job_path.is_dir():
            continue
        sessions = [c for c in job_path.iterdir()
                    if c.is_dir() and naming.DATE_TOKEN_RE.search(c.name)]
        used = {int(naming.LEADING_INDEX_RE.match(c.name).group(0))
                for c in sessions if naming.LEADING_INDEX_RE.match(c.name)}
        loose = [c for c in sessions if not naming.LEADING_INDEX_RE.match(c.name)]
        proposals = {}

        for name, number in sorted(numbered.items(), key=lambda kv: kv[1]):
            if number in used:
                continue
            hits = [c for c in loose if c not in proposals
                    and _session_key(c.name) == _session_key(name)]
            if not hits:
                when_tag = _date_and_tag(name)
                if when_tag[0] and when_tag[1]:
                    hits = [c for c in loose if c not in proposals
                            and _date_and_tag(c.name) == when_tag]
            if len(hits) == 1:
                proposals[hits[0]] = number

        left = sorted((c for c in loose if c not in proposals),
                      key=lambda c: _session_order(c.name))
        taken = used | set(numbered.values()) | set(proposals.values())
        top = max(taken) if taken else 0
        missing = [n for n in range(1, top + 1) if n not in taken]
        if left and len(left) == len(missing):
            proposals.update(zip(left, missing))

        for folder, number in proposals.items():
            target = folder.with_name(f"{number:02d} {folder.name}")
            if not target.exists():
                out.append({"path": str(folder), "new_path": str(target),
                            "number": f"{number:02d}"})
    out.sort(key=lambda r: (r["new_path"].lower()))
    return out


def apply_session_numbers(renames: list) -> dict:
    """Rename the folders proposed by find_unnumbered_sessions."""
    done, errors = [], []
    for r in renames or []:
        src, dst = Path(r["path"]), Path(r["new_path"])
        if src.parent != dst.parent:
            errors.append(f"Skipped {src.name}: not a rename in place.")
            continue
        if dst.exists():
            errors.append(f"Skipped {src.name}: {dst.name} already exists.")
            continue
        try:
            os.rename(src, dst)
            done.append(str(dst))
        except OSError as exc:
            errors.append(f"Couldn't rename {src.name}: {exc.strerror or exc}")
    return {"renamed": done, "errors": errors}

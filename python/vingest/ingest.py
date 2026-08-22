"""Planning and executing the copy: camera originals -> house folder structure.

Media files keep the names they arrive with. The only name this module composes
is the session folder's, whose `Dur-` token comes from the master's duration.

The plan is always built and returned before anything touches the disk, so the
GUI can show every destination path for approval first.
"""

from __future__ import annotations

import datetime as _dt
import os
import shutil
import time
from dataclasses import dataclass, asdict, field
from pathlib import Path

from . import naming
from .hashing import file_digest
from .probe import MediaInfo, VIDEO_EXTS, probe, scan_videos


@dataclass
class PlanItem:
    src: str
    dst: str                  # where the file is written (inside staging_path)
    final_dst: str = ""       # same file once the folder rename has happened
    size: int = 0
    kind: str = "clip"        # master | clip
    cam: int | None = None
    duration: float | None = None
    codec: str | None = None
    original_name: str = ""
    status: str = "pending"   # pending | done | skipped | failed
    message: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TargetPlan:
    role: str                 # prores | h265 | sd | other
    source_root: str
    dest_root: str
    job_folder: str
    session_folder: str       # the name the folder ends up with
    session_path: str         # where it ends up
    staging_path: str = ""    # where files are written before the rename
    rename_from: str = ""     # existing folder name, when one was found
    rename_to: str = ""       # same name plus the Dur- token
    in_place: bool = False    # True when completing a folder that already exists
    from_template: bool = False
    ensure_dirs: list = field(default_factory=list)   # folders to create even if empty
    existing_cams: dict = field(default_factory=dict) # cam folder -> clips already filed there
    master_present: bool = False                      # a master already sits in the folder
    items: list[PlanItem] = field(default_factory=list)
    total_bytes: int = 0
    free_bytes: int = 0
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["items"] = [i.to_dict() for i in self.items]
        return d


# ------------------------------------------------------------------ pairing

def _stem_key(path: str | Path) -> str:
    """'C0031 Dt-16-Aug-26 Dur-2m14s.MOV' -> 'c0031' — the camera's own reel id.

    Tokens we may have added previously are stripped so a re-run pairs the same
    files it paired the first time.
    """
    return naming.strip_tokens(Path(path).stem).lower()


def pair_sources(primary: list[dict], secondary: list[dict],
                 duration_tol: float = 1.5,
                 time_tol: float = 900.0) -> dict:
    """Match each primary file to its twin on the other SSD.

    Filename stem first (cameras write the same reel id to both recordings);
    duration + wall-clock time as the fallback when the stems disagree.
    """
    remaining = list(secondary)
    matches: dict[str, str] = {}
    unmatched_primary: list[str] = []

    by_stem: dict[str, list[dict]] = {}
    for f in remaining:
        by_stem.setdefault(_stem_key(f["path"]), []).append(f)

    for pf in primary:
        key = _stem_key(pf["path"])
        bucket = by_stem.get(key)
        if bucket:
            twin = bucket.pop(0)
            matches[pf["path"]] = twin["path"]
            remaining.remove(twin)
            continue

        best, best_gap = None, None
        for cand in remaining:
            pd, cd = pf.get("duration"), cand.get("duration")
            if pd is None or cd is None or abs(pd - cd) > duration_tol:
                continue
            gap = abs((pf.get("mtime") or 0) - (cand.get("mtime") or 0))
            if gap > time_tol:
                continue
            if best_gap is None or gap < best_gap:
                best, best_gap = cand, gap
        if best is not None:
            matches[pf["path"]] = best["path"]
            remaining.remove(best)
        else:
            unmatched_primary.append(pf["path"])

    return {
        "matches": matches,
        "unmatched_primary": unmatched_primary,
        "unmatched_secondary": [f["path"] for f in remaining],
    }


# ------------------------------------------------------------------ planning

def _session_date(master: MediaInfo | None, override: str | None) -> _dt.date:
    if override:
        return _dt.date.fromisoformat(override)
    if master is not None:
        return master.shoot_datetime().date()
    return _dt.date.today()


def build_plan(spec: dict, progress=None) -> dict:
    """Turn the GUI's selections into a full, reviewable copy plan.

    Two shapes of target are supported:

    * **In place** — the target carries `session_source`, the existing session
      folder found on the drive. Its name is already correct apart from the
      `Dur-` token, so files are filed into it as-is and the folder itself is
      renamed at the very end.
    * **Create** — no `session_source`. A folder is built from `title` under
      `dest_root`. Used when organising loose files that were never structured.

    `spec` keys: title, job_number, date (ISO, optional), mode (copy|move),
    verify (none|size|hash), targets[] with role/source_root/dest_root/
    session_source/master/cams{cam_index: [paths]}.
    """
    title = (spec.get("title") or "Untitled Session").strip()
    job_number = (spec.get("job_number") or "").strip()
    date_override = spec.get("date")
    targets_out: list[TargetPlan] = []
    probe_cache: dict[str, MediaInfo] = {}

    def get(path: str) -> MediaInfo:
        if path not in probe_cache:
            if progress:
                progress({"stage": "probe", "name": Path(path).name})
            probe_cache[path] = probe(path)
        return probe_cache[path]

    for t in spec.get("targets", []):
        # One session can hold several master clips; Clip-01 is the earliest.
        master_paths = [mp for mp in (t.get("masters")
                        or ([t["master"]] if t.get("master") else []))
                        if Path(mp).exists()]
        masters = sorted((get(mp) for mp in master_paths),
                         key=lambda m: (m.mtime, m.name))
        timed = [m.duration for m in masters if m.duration is not None]
        # The folder's Dur- is the sum of every master clip inside it.
        duration = sum(timed) if timed else None
        when = _session_date(masters[0] if masters else None, date_override)
        existing = t.get("session_source")
        template_name = t.get("session_name")
        from_template = False

        if not existing and template_name:
            # The name comes from an imported template (usually a zip of empty
            # folders). It is authoritative — only the Dur- token is ours.
            session_folder = naming.session_folder_name(
                template_name, duration, len(masters))
            job_folder = naming.sanitize(t.get("job_name") or "") if t.get("job_name") else ""
            dest_root = Path(t["dest_root"])
            session_path = dest_root / job_folder / session_folder if job_folder \
                else dest_root / session_folder
            staging_path = session_path
            in_place = False
            from_template = True
        elif existing:
            existing_path = Path(existing)
            if not masters:
                # Adding cameras to an already-filed folder: its name (and Dur-)
                # is already correct, so leave it exactly as it is — recomputing
                # with no master would wrongly strip the existing Dur- token.
                session_folder = existing_path.name
            else:
                # First pass over this folder: complete its Dur- from the master.
                session_folder = naming.session_folder_name(
                    existing_path.name, duration, len(masters))
            session_path = existing_path.parent / session_folder
            staging_path = existing_path
            job_folder = existing_path.parent.name if existing_path.parent != existing_path.parent.parent else ""
            dest_root = existing_path.parent
            in_place = True
        else:
            session_folder = naming.session_folder_name(
                naming.build_session_folder(title, when, None,
                                            add_date=spec.get("add_date", True)),
                duration, len(masters))
            job_folder = naming.build_job_folder(job_number, when) if job_number else ""
            dest_root = Path(t.get("dest_root") or t["source_root"])
            session_path = dest_root / job_folder / session_folder if job_folder \
                else dest_root / session_folder
            staging_path = session_path
            in_place = False

        _names = t.get("cam_names") or {}

        def _apply_cam_name(rel: str) -> str:
            # Rewrite a "…/Cam-NN" folder to its custom name when one is set.
            m = naming.CAM_FOLDER_RE.search(rel.split("/")[-1])
            if m:
                custom = _names.get(str(int(m.group(1)))) or _names.get(int(m.group(1)))
                if custom:
                    return "/".join(rel.split("/")[:-1] + [naming.sanitize(custom)])
            return rel

        ensure = [_apply_cam_name(d) for d in (t.get("template_dirs") or []) if d]
        if not ensure:
            # No template: still create a cam folder for every cam in play.
            ensure = [f"{naming.CLIPS_DIRNAME}/"
                      f"{naming.sanitize(_names.get(str(c)) or naming.cam_folder(int(c)))}"
                      for c in sorted((t.get("cams") or {}), key=int)]

        plan = TargetPlan(
            role=t.get("role", "other"),
            source_root=t["source_root"],
            dest_root=str(dest_root),
            job_folder=job_folder,
            session_folder=session_folder,
            session_path=str(session_path),
            staging_path=str(staging_path),
            rename_from=Path(existing).name if existing else "",
            rename_to=session_folder if existing else "",
            in_place=in_place,
            from_template=from_template,
            ensure_dirs=ensure,
        )
        if in_place and plan.rename_from == plan.rename_to:
            plan.rename_to = ""          # already complete; nothing to rename

        taken: set[str] = set()
        for index, master in enumerate(masters, 1):
            # Unlike the cam clips, a master is renamed after the folder it sits
            # in, carrying its own duration and its position in the session.
            name = naming.dedupe(
                naming.master_clip_name(session_folder, master.duration, index,
                                        len(masters), Path(master.path).suffix),
                taken)
            taken.add(name)
            plan.items.append(PlanItem(
                src=master.path, dst=str(staging_path / name),
                final_dst=str(session_path / name), size=master.size,
                kind="master", cam=None, duration=master.duration,
                codec=master.family, original_name=Path(master.path).name))
            if master.duration is None:
                # The folder's whole reason to consult the media is this token,
                # so say plainly what will be missing rather than just "probe failed".
                detail = f" ({master.error})" if master.error else ""
                plan.warnings.append(
                    f"Could not read the duration of {Path(master.path).name}{detail}, "
                    f"so the folder's Dur- total will be wrong. Check the file plays, "
                    f"or drop it from the masters.")
            elif master.error:
                plan.warnings.append(f"Master probed with a warning: {master.error}")

        if not masters and not (existing and not master_paths and Path(existing).exists()):
            # Warn about a missing master only on a first pass. Adding cameras to
            # an already-named folder legitimately has no master to file.
            if not existing:
                plan.warnings.append(
                    f"No master file for the {plan.role} target, so its folder gets no "
                    f"Dur- token. Check that drive's footage is loaded and mirrored.")

        clips_root = staging_path / naming.CLIPS_DIRNAME
        final_clips_root = session_path / naming.CLIPS_DIRNAME
        # A cam may carry a custom folder name; otherwise it is "Cam-NN".
        cam_names = t.get("cam_names") or {}

        def cam_folder_name(idx: int) -> str:
            custom = cam_names.get(str(idx)) or cam_names.get(idx)
            return naming.sanitize(custom) if custom else naming.cam_folder(idx)

        for cam_key, paths in sorted((t.get("cams") or {}).items(),
                                     key=lambda kv: int(kv[0])):
            cam_index = int(cam_key)
            cam_dir = clips_root / cam_folder_name(cam_index)
            final_cam_dir = final_clips_root / cam_folder_name(cam_index)
            cam_taken: set[str] = set()
            for p in paths:
                if not Path(p).exists():
                    # A clip whose card was already ejected (its footage is filed
                    # from an earlier pass). Skip it rather than crashing the build.
                    plan.warnings.append(
                        f"{Path(p).name} is no longer on any connected drive — skipped. "
                        f"It was likely filed from an earlier card.")
                    continue
                info = get(p)
                name = naming.dedupe(Path(p).name, cam_taken)
                cam_taken.add(name)
                plan.items.append(PlanItem(
                    src=p, dst=str(cam_dir / name),
                    final_dst=str(final_cam_dir / name), size=info.size, kind="clip",
                    cam=cam_index, duration=info.duration, codec=info.family,
                    original_name=Path(p).name))
                if info.error:
                    plan.warnings.append(f"{Path(p).name}: {info.error}")

        clip_days = {get(i.src).shoot_datetime().date().isoformat()
                     for i in plan.items if i.kind == "clip"}
        if len(clip_days) > 1:
            plan.warnings.append(
                "These clips were shot on more than one day ("
                + ", ".join(sorted(clip_days))
                + "). A session is normally one day's footage — check the day filter.")

        # In place, a clip already filed in the right cam folder needs no copy.
        plan.items = [i for i in plan.items
                      if os.path.normcase(i.src) != os.path.normcase(i.dst)]
        plan.total_bytes = sum(i.size for i in plan.items)

        # Report what the folder already contains, so the plan shows the cams that
        # were filed on an earlier pass rather than looking like they vanished.
        clips_dir = Path(staging_path) / naming.CLIPS_DIRNAME
        if clips_dir.is_dir():
            for child in sorted(clips_dir.iterdir()):
                if not child.is_dir():
                    continue
                try:
                    n = sum(1 for f in child.iterdir()
                            if f.is_file() and f.suffix.lower() in VIDEO_EXTS)
                except OSError:
                    n = 0
                if n:
                    plan.existing_cams[child.name] = n
        try:
            plan.master_present = Path(staging_path).is_dir() and any(
                f.is_file() and f.suffix.lower() in VIDEO_EXTS
                for f in Path(staging_path).iterdir())
        except OSError:
            plan.master_present = False
        try:
            plan.free_bytes = shutil.disk_usage(dest_root).free
        except OSError:
            plan.free_bytes = 0

        # A copy needs room for the files that are not just relocated on the drive.
        copy_bytes = sum(i.size for i in plan.items
                         if not _same_volume(Path(i.src).parent, session_path))
        if plan.free_bytes and copy_bytes > plan.free_bytes * 0.98:
            plan.warnings.append(
                f"Not enough free space on {dest_root}: needs "
                f"{human(copy_bytes)} to copy, has {human(plan.free_bytes)} free.")

        if in_place and plan.rename_to:
            clash = session_path
            if clash.exists() and os.path.normcase(str(clash)) != os.path.normcase(str(staging_path)):
                plan.warnings.append(
                    f"A folder called “{session_folder}” already exists here, so the "
                    f"rename would collide. Move or remove it first.")

        # Two different sources must never write into one session folder.
        if from_template and session_path.exists():
            plan.warnings.append(
                f"“{session_folder}” already exists at {dest_root}. Files will be added "
                f"to it and matching ones skipped, rather than a second folder being made.")

        for other in targets_out:
            if os.path.normcase(other.session_path) == os.path.normcase(plan.session_path):
                plan.warnings.append(
                    f"Destination collides with the {other.role} target. "
                    "Give each source its own destination drive.")
        targets_out.append(plan)

    return {
        "title": title,
        "job_number": job_number,
        "mode": spec.get("mode", "copy"),
        "verify": spec.get("verify", "size"),
        "targets": [t.to_dict() for t in targets_out],
        "total_bytes": sum(t.total_bytes for t in targets_out),
        "item_count": sum(len(t.items) for t in targets_out),
        "renames": [{"role": t.role, "from": t.rename_from, "to": t.rename_to}
                    for t in targets_out if t.rename_to],
        "warnings": [w for t in targets_out for w in t.warnings],
    }


def _same_volume(a, b) -> bool:
    try:
        return os.stat(a).st_dev == os.stat(b).st_dev
    except OSError:
        return False


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} TB"


# ----------------------------------------------------------------- execution

CHUNK = 8 * 1024 * 1024


class Cancelled(Exception):
    pass


def _copy_with_progress(src: Path, dst: Path, on_chunk, should_cancel) -> int:
    """Chunked copy so a 40 GB ProRes file still reports progress and cancels.

    Writes to a .vingest-part file and renames on completion, so an interrupted
    run never leaves a truncated file wearing the final name.
    """
    tmp = dst.with_name(dst.name + ".vingest-part")
    copied = 0
    with open(src, "rb") as fsrc, open(tmp, "wb") as fdst:
        while True:
            if should_cancel():
                fdst.close()
                tmp.unlink(missing_ok=True)
                raise Cancelled()
            buf = fsrc.read(CHUNK)
            if not buf:
                break
            fdst.write(buf)
            copied += len(buf)
            on_chunk(len(buf))
        fdst.flush()
        os.fsync(fdst.fileno())
    tmp.replace(dst)
    shutil.copystat(src, dst, follow_symlinks=True)
    return copied


def execute_plan(plan: dict, progress=None, should_cancel=None) -> dict:
    """Run a plan produced by build_plan. Safe to re-run: existing, verified
    destinations are skipped rather than recopied."""
    should_cancel = should_cancel or (lambda: False)
    mode = plan.get("mode", "copy")
    verify = plan.get("verify", "size")
    total_bytes = plan.get("total_bytes", 0) or 1
    done_bytes = 0
    copied_bytes = 0        # bytes that were actually COPIED (relocations excluded)
    copy_seconds = 0.0      # wall-clock spent copying, for a meaningful rate
    started = time.time()
    results: list[dict] = []
    errors: list[str] = []
    cancelled = False

    def emit(**kw):
        if progress:
            # Rate and ETA are based on copied bytes over the time spent copying:
            # relocations (same-drive renames) move their whole size instantly and
            # would otherwise report a wildly inflated, useless speed.
            rate = copied_bytes / copy_seconds if copy_seconds > 0.05 else 0
            remaining = max(total_bytes - done_bytes, 0)
            progress({
                "stage": "copy",
                "bytes_done": done_bytes,
                "bytes_total": total_bytes,
                "percent": round(done_bytes / total_bytes * 100, 2),
                "rate_bps": rate,
                "copied_bytes": copied_bytes,
                "eta_seconds": round(remaining / rate) if rate > 1 else None,
                **kw,
            })

    # A camera-card clip is filed to both SSDs, so one source has several
    # destinations. Count them, so move mode copies to every drive before the
    # source is deleted rather than losing it after the first.
    # How many destinations each source has, in total. A file with exactly one
    # destination on its own drive is relocated; a file bound for both SSDs is
    # copied to each. This count never changes as the run proceeds.
    import os as _os
    dest_count: dict[str, int] = {}
    for _t in plan.get("targets", []):
        for _i in _t.get("items", []):
            key = _os.path.normcase(_i["src"])
            dest_count[key] = dest_count.get(key, 0) + 1

    for target in plan.get("targets", []):
        staging_root = Path(target.get("staging_path") or target["session_path"])
        staging_root.mkdir(parents=True, exist_ok=True)
        # A template's empty Cam folders are part of what it defines, so they are
        # created whether or not a clip was assigned to them.
        for rel in target.get("ensure_dirs", []):
            try:
                (staging_root / rel).mkdir(parents=True, exist_ok=True)
            except OSError as e:
                errors.append(f"Could not create {rel}: {e}")
        for item in target["items"]:
            # Checked per item, not just inside the copy loop: a same-volume move
            # never enters that loop, so Cancel would otherwise do nothing at all.
            if should_cancel():
                cancelled = True
            if cancelled:
                item["status"] = "skipped"
                item["message"] = "Cancelled"
                results.append(item)
                continue

            src, dst = Path(item["src"]), Path(item["dst"])
            emit(current=src.name, target=target["role"])
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)

                if dst.exists() and dst.stat().st_size == item["size"]:
                    item["status"] = "skipped"
                    item["message"] = "Already present with matching size"
                    done_bytes += item["size"]
                    results.append(item)
                    emit(current=src.name, target=target["role"])
                    continue

                if not src.exists():
                    # Already relocated on a previous run, or genuinely missing.
                    raise FileNotFoundError("Source file is gone")

                chunk_acc = {"n": 0}

                def on_chunk(n, _acc=chunk_acc):
                    nonlocal done_bytes
                    done_bytes += n
                    _acc["n"] += n
                    if _acc["n"] >= CHUNK * 4:
                        _acc["n"] = 0
                        emit(current=src.name, target=target["role"])

                src_key = os.path.normcase(item["src"])
                # RELOCATE (rename into the folder) only when this file has a
                # single destination AND is already on that drive — the master.
                # A clip bound for both SSDs is always COPIED, and no source is
                # ever deleted: the camera cards are cleared by hand.
                relocate = (dest_count.get(src_key, 1) == 1
                            and _same_volume(src.parent, dst.parent))
                if relocate:
                    src.replace(dst)          # atomic within a volume
                    done_bytes += item["size"]
                    problem = _verify_moved(dst, item["size"])
                else:
                    _t0 = time.time()
                    _copy_with_progress(src, dst, on_chunk, should_cancel)
                    copy_seconds += time.time() - _t0
                    copied_bytes += item["size"]
                    problem = _verify(src, dst, verify)

                if problem:
                    item["status"] = "failed"
                    item["message"] = problem
                    errors.append(f"{src.name}: {problem}")
                else:
                    item["status"] = "done"
                    item["message"] = "moved" if relocate else "copied"

            except Cancelled:
                cancelled = True
                item["status"] = "skipped"
                item["message"] = "Cancelled"
            except (OSError, shutil.Error) as e:
                item["status"] = "failed"
                item["message"] = str(e)
                errors.append(f"{src.name}: {e}")
            results.append(item)

    # The folder rename happens last, and only if every file landed. Renaming
    # first would invalidate the source paths of anything living inside it, and
    # renaming after a failure would label an incomplete folder as finished.
    renames = []
    for target in plan.get("targets", []):
        if not target.get("rename_to"):
            continue
        staging = Path(target["staging_path"])
        final = Path(target["session_path"])
        record = {"role": target.get("role"), "from": target.get("rename_from"),
                  "to": target.get("rename_to"), "done": False, "message": ""}
        if cancelled or errors:
            record["message"] = ("Left as-is: the copy did not finish cleanly, so the "
                                 "folder keeps its original name.")
        elif not staging.exists():
            record["message"] = "Source folder no longer exists"
        elif staging == final:
            record["done"] = True
        elif final.exists():
            record["message"] = f"“{final.name}” already exists — renamed nothing."
            errors.append(record["message"])
        else:
            try:
                staging.rename(final)
                record["done"] = True
            except OSError as e:
                record["message"] = f"Could not rename the session folder: {e}"
                errors.append(record["message"])
        renames.append(record)

    # Report the post-rename location, which is what the operator will look for.
    for item in results:
        if item.get("final_dst") and any(r["done"] for r in renames):
            item["dst"] = item["final_dst"]

    ok = sum(1 for i in results if i["status"] == "done")
    return {
        "completed": not cancelled,
        "cancelled": cancelled,
        "copied": ok,
        "skipped": sum(1 for i in results if i["status"] == "skipped"),
        "failed": sum(1 for i in results if i["status"] == "failed"),
        "bytes": done_bytes,
        "copied_bytes": copied_bytes,
        "copy_seconds": round(copy_seconds, 1),
        "rate_bps": round(copied_bytes / copy_seconds) if copy_seconds > 0.05 else 0,
        "seconds": round(time.time() - started, 1),
        "renames": renames,
        "errors": errors,
        "items": results,
    }


def _verify_moved(dst: Path, expected: int) -> str | None:
    """Confirm a same-volume move actually produced the file it promised."""
    try:
        size = dst.stat().st_size
    except OSError as e:
        return f"Moved file is missing: {e}"
    return None if size == expected else \
        f"Moved file is {size} bytes, expected {expected}"


def _verify(src: Path, dst: Path, mode: str) -> str | None:
    """Return a problem description, or None when the copy checks out."""
    if mode == "none":
        return None
    try:
        s, d = src.stat().st_size, dst.stat().st_size
    except OSError as e:
        return f"Could not stat copy: {e}"
    if s != d:
        return f"Size mismatch: source {s} vs copy {d}"
    if mode == "hash":
        if file_digest(src) != file_digest(dst):
            return "Checksum mismatch — the copy is not bit-identical"
    return None


def suggest_cam_groups(files: list[dict], gap_minutes: float = 45.0) -> dict:
    """A starting point for the manual cam assignment.

    Files are grouped by resolution + fps + codec first (different bodies
    usually differ in at least one), and each group is offered as a cam. The
    operator still confirms or reshuffles everything in the GUI.
    """
    groups: dict[str, list[dict]] = {}
    for f in files:
        key = f"{f.get('width')}x{f.get('height')}@{f.get('fps')}/{f.get('video_codec')}"
        groups.setdefault(key, []).append(f)
    ordered = sorted(groups.items(), key=lambda kv: -len(kv[1]))
    return {
        "groups": [
            {"cam": i + 1, "signature": key,
             "files": sorted(v, key=lambda f: f.get("mtime") or 0)}
            for i, (key, v) in enumerate(ordered)
        ],
        "basis": "resolution + frame rate + codec",
    }


def group_by_date(files: list[dict], session_date: str | None = None) -> dict:
    """Bucket files by the day they were last modified.

    The session folder already states its shoot date, so the files written on
    that day are almost certainly the ones belonging to it. This does not filter
    anything — it reports the buckets and flags the matching one, leaving the
    operator to accept the suggestion or ignore it.
    """
    buckets: dict[str, dict] = {}
    for f in files:
        day = f.get("shoot_date")
        if not day:
            continue
        b = buckets.setdefault(day, {"date": day, "count": 0, "bytes": 0,
                                     "duration": 0.0, "paths": []})
        b["count"] += 1
        b["bytes"] += f.get("size") or 0
        b["duration"] += f.get("duration") or 0.0
        b["paths"].append(f["path"])

    for b in buckets.values():
        b["is_session_date"] = session_date is not None and b["date"] == session_date

    ordered = sorted(buckets.values(), key=lambda b: b["date"])
    matching = next((b for b in ordered if b["is_session_date"]), None)

    # The busiest day is a reasonable guess only when the folder states no date at
    # all. If it states one and nothing on the drive matches, that mismatch is the
    # useful signal — quietly proposing a different day's shoot would hide it.
    fallback = None
    if ordered and not matching and session_date is None:
        fallback = max(ordered, key=lambda b: b["count"])

    pick = matching or fallback
    if matching:
        basis = "the session date stated in the folder name"
    elif fallback:
        basis = "the busiest day, since the folder states no date"
    elif session_date:
        basis = (f"nothing on this source was modified on {session_date}, "
                 f"the date the folder states — check you have the right drive, "
                 f"or choose a day below")
    else:
        basis = ""

    return {
        "session_date": session_date,
        "dates": [{k: v for k, v in b.items() if k != "paths"} for b in ordered],
        "suggested": (pick or {}).get("paths", []),
        "suggested_date": (pick or {}).get("date"),
        "suggestion_basis": basis,
        "matched_session_date": matching is not None,
        "date_mismatch": bool(session_date and ordered and not matching),
        "other_count": sum(b["count"] for b in ordered
                           if not pick or b["date"] != pick["date"]),
    }

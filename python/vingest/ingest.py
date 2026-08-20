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
from .probe import MediaInfo, probe, scan_videos


@dataclass
class PlanItem:
    src: str
    dst: str
    size: int
    kind: str                 # master | clip
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
    session_folder: str
    session_path: str
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

    `spec` keys: title, job_number, date (ISO, optional), mode (copy|move),
    verify (none|size|hash), targets[] with role/source_root/dest_root/master/
    cams{cam_index: [paths]}/extras[].
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
        master_path = t.get("master")
        master = get(master_path) if master_path else None
        when = _session_date(master, date_override)

        session_folder = naming.build_session_folder(
            title, when, master.duration if master else None,
            add_date=spec.get("add_date", True))
        job_folder = naming.build_job_folder(job_number, when) if job_number else ""

        dest_root = Path(t.get("dest_root") or t["source_root"])
        session_path = dest_root / job_folder / session_folder if job_folder \
            else dest_root / session_folder

        plan = TargetPlan(
            role=t.get("role", "other"),
            source_root=t["source_root"],
            dest_root=str(dest_root),
            job_folder=job_folder,
            session_folder=session_folder,
            session_path=str(session_path),
        )

        taken: set[str] = set()
        if master is not None:
            # The file's own name is kept exactly as it arrives; dedupe only
            # guards against two sources colliding in one destination folder.
            name = naming.dedupe(Path(master.path).name, taken)
            taken.add(name)
            plan.items.append(PlanItem(
                src=master.path, dst=str(session_path / name), size=master.size,
                kind="master", duration=master.duration, codec=master.family,
                original_name=Path(master.path).name))
            if master.duration is None:
                # The folder's whole reason to consult the media is this token,
                # so say plainly what will be missing rather than just "probe failed".
                detail = f" ({master.error})" if master.error else ""
                plan.warnings.append(
                    f"Could not read the duration of {Path(master.path).name}{detail}, "
                    f"so the folder will be created without a Dur- token. "
                    f"Check the file plays, or choose a different master.")
            elif master.error:
                plan.warnings.append(f"Master probed with a warning: {master.error}")

        clips_root = session_path / naming.CLIPS_DIRNAME
        for cam_key, paths in sorted((t.get("cams") or {}).items(),
                                     key=lambda kv: int(kv[0])):
            cam_index = int(cam_key)
            cam_dir = clips_root / naming.cam_folder(cam_index)
            cam_taken: set[str] = set()
            for p in paths:
                info = get(p)
                name = naming.dedupe(Path(p).name, cam_taken)
                cam_taken.add(name)
                plan.items.append(PlanItem(
                    src=p, dst=str(cam_dir / name), size=info.size, kind="clip",
                    cam=cam_index, duration=info.duration, codec=info.family,
                    original_name=Path(p).name))
                if info.error:
                    plan.warnings.append(f"{Path(p).name}: {info.error}")

        plan.total_bytes = sum(i.size for i in plan.items)
        try:
            plan.free_bytes = shutil.disk_usage(dest_root).free
        except OSError:
            plan.free_bytes = 0

        same_volume = _same_volume(t["source_root"], dest_root)
        if spec.get("mode") == "copy" and plan.free_bytes and \
                plan.total_bytes > plan.free_bytes * 0.98:
            plan.warnings.append(
                f"Not enough free space on {dest_root}: needs "
                f"{human(plan.total_bytes)}, has {human(plan.free_bytes)} free.")
        if spec.get("mode") == "move" and not same_volume:
            plan.warnings.append(
                "Move crosses volumes — files will be copied then deleted, which is slow.")

        # Two different sources must never write into one session folder.
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
    started = time.time()
    results: list[dict] = []
    errors: list[str] = []
    cancelled = False

    def emit(**kw):
        if progress:
            elapsed = max(time.time() - started, 0.001)
            rate = done_bytes / elapsed
            remaining = max(total_bytes - done_bytes, 0)
            progress({
                "stage": "copy",
                "bytes_done": done_bytes,
                "bytes_total": total_bytes,
                "percent": round(done_bytes / total_bytes * 100, 2),
                "rate_bps": rate,
                "eta_seconds": round(remaining / rate) if rate > 1 else None,
                **kw,
            })

    for target in plan.get("targets", []):
        Path(target["session_path"]).mkdir(parents=True, exist_ok=True)
        for item in target["items"]:
            if cancelled:
                item["status"] = "skipped"
                item["message"] = "Cancelled"
                results.append(item)
                continue

            src, dst = Path(item["src"]), Path(item["dst"])
            emit(current=src.name, target=target["role"])
            try:
                if not src.exists():
                    raise FileNotFoundError("Source file is gone")
                dst.parent.mkdir(parents=True, exist_ok=True)

                if dst.exists() and dst.stat().st_size == item["size"]:
                    item["status"] = "skipped"
                    item["message"] = "Already present with matching size"
                    done_bytes += item["size"]
                    results.append(item)
                    emit(current=src.name, target=target["role"])
                    continue

                chunk_acc = {"n": 0}

                def on_chunk(n, _acc=chunk_acc):
                    nonlocal done_bytes
                    done_bytes += n
                    _acc["n"] += n
                    if _acc["n"] >= CHUNK * 4:
                        _acc["n"] = 0
                        emit(current=src.name, target=target["role"])

                if mode == "move" and _same_volume(src.parent, dst.parent):
                    src.replace(dst)          # instant within a volume
                    done_bytes += item["size"]
                else:
                    _copy_with_progress(src, dst, on_chunk, should_cancel)

                problem = _verify(src, dst, verify)
                if problem:
                    item["status"] = "failed"
                    item["message"] = problem
                    errors.append(f"{src.name}: {problem}")
                else:
                    if mode == "move" and src.exists() and \
                            not _same_volume(src.parent, dst.parent):
                        src.unlink()
                    item["status"] = "done"
                    item["message"] = ""

            except Cancelled:
                cancelled = True
                item["status"] = "skipped"
                item["message"] = "Cancelled"
            except (OSError, shutil.Error) as e:
                item["status"] = "failed"
                item["message"] = str(e)
                errors.append(f"{src.name}: {e}")
            results.append(item)

    ok = sum(1 for i in results if i["status"] == "done")
    return {
        "completed": not cancelled,
        "cancelled": cancelled,
        "copied": ok,
        "skipped": sum(1 for i in results if i["status"] == "skipped"),
        "failed": sum(1 for i in results if i["status"] == "failed"),
        "bytes": done_bytes,
        "seconds": round(time.time() - started, 1),
        "errors": errors,
        "items": results,
    }


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

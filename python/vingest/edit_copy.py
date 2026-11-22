"""H.264 edit copy: the HyperDeck Studio Mini's recording of a formal master.

The HyperDeck records the same programme as the ProRes and H.265 masters, in
H.264, for the multimedia team to edit from. Its files are named exactly like
those masters (same session name, same Dur- and Clip- tokens), with the job's
folder number in front so they can be picked out on a server where hundreds of
them sit loose in one folder:

    3058 Adalaj Soneri Satsang E. Dt-17-Oct-26 Dur-44m43s Clip-01.mp4

Only the files are written, flat into one output folder; no job, session or
camera folders. The clips are counted and numbered from the HyperDeck card
itself, so a card that split the recording differently from the other masters
is still numbered correctly. This copy never feeds a session's Dur- or the
report: those come from the ProRes/H.265 masters.
"""

from __future__ import annotations

import re
import time
from pathlib import Path

from . import naming, probe
from .durations import get_duration
from .hashing import file_digest
from .ingest import Cancelled, _copy_with_progress
from .session_scan import PROJECT_DIR_RE

# The folder number at the start of a job folder: '3058 Dt-17 Oct 2026'.
JOB_NUMBER_RE = re.compile(r"^\s*(\d+)\b")
PART_SUFFIX = ".vingest-part"


def job_number_of(name: str) -> str:
    """'3058 Dt-17 Oct 2026' -> '3058'; '' when the name carries no number."""
    m = JOB_NUMBER_RE.match(str(name or ""))
    return m.group(1) if m else ""


def _natural_key(path: Path):
    """Order clips the way the deck numbered them: Clip2 before Clip10."""
    parts = re.split(r"(\d+)", str(path).lower())
    return [int(p) if p.isdigit() else p for p in parts]


def find_clips(source: str | Path, max_depth: int = 4) -> list[Path]:
    """The video files on the HyperDeck card (or a folder holding them)."""
    return sorted(probe.scan_videos(source, max_depth), key=_natural_key)


def _duration_and_codec(path: Path):
    """Seconds and codec family, read as the masters are (ffprobe first)."""
    try:
        info = probe.probe(path)
        seconds = info.duration
        family = getattr(info, "family", None) or ""
    except (RuntimeError, OSError):
        seconds, family = None, ""
    if seconds is None:
        seconds = get_duration(str(path))
    return seconds, family


def output_name(job_number: str, session_folder: str, seconds, index: int,
                count: int, ext: str) -> str:
    """The master's own name for this clip, with the folder number in front."""
    master = naming.master_clip_name(session_folder, seconds, index, count, ext)
    number = str(job_number or "").strip()
    return f"{number} {master}" if number else master


def build_plan(params: dict, progress=None) -> dict:
    """Preview the copy: every clip, its new name, and what is already there.

    params: source (card or folder), dest (output folder), job_number,
    session_folder (the session's folder name, as the masters are named after
    it), optionally files (an explicit list in place of a card scan), and
    picked: the clips to copy. When some are picked, only those are numbered
    (Clip-01, 02 … in card order) and the rest are listed as "skip".
    """
    emit = progress or (lambda _d: None)
    source = params.get("source") or ""
    dest = params.get("dest") or ""
    session_folder = str(params.get("session_folder") or "").strip()
    job_number = str(params.get("job_number") or "").strip()
    if not session_folder:
        raise ValueError("Choose the session the H.264 recording belongs to.")
    if job_number and not job_number.isdigit():
        raise ValueError(f"The folder number “{job_number}” should be digits only.")

    files = [Path(f) for f in params.get("files") or []]
    if not files:
        if not source or not Path(source).is_dir():
            raise ValueError("Choose the HyperDeck SD card (or the folder holding its clips).")
        files = find_clips(source)
    files = [f for f in files if f.is_file()]

    warnings: list[str] = []
    if not job_number:
        warnings.append("No folder number: the names will not start with one.")
    dest_path = Path(dest) if dest else None
    if dest_path and any(PROJECT_DIR_RE.match(p.name) for p in dest_path.parents):
        # The drive scan reads every folder inside a job folder as a session, so
        # the H.264 files there would be counted in the schedule and the report.
        raise ValueError("The output folder is inside a job folder, where it would be read as a "
                         "session and counted in the duration. Choose a folder outside it.")
    if dest_path and naming.DATE_TOKEN_RE.search(dest_path.name):
        warnings.append(f"“{dest_path.name}” looks like a session folder. The H.264 copy "
                        "belongs in its own folder, outside the session, so it is never "
                        "counted in the session's duration.")
    if dest_path and source and _inside(dest_path, Path(source)):
        raise ValueError("The output folder is on the SD card itself. Choose a folder on the "
                         "server, an HDD or an SSD.")

    items: list[dict] = []
    taken: set[str] = set()
    picked = {str(p) for p in params.get("picked") or []}
    numbered = [f for f in files if str(f) in picked] if picked & {str(f) for f in files} else files
    count = len(numbered)
    order = {str(f): i for i, f in enumerate(numbered, 1)}
    for done, path in enumerate(files, 1):
        emit({"stage": "scan", "done": done, "total": len(files), "name": path.name})
        seconds, family = _duration_and_codec(path)
        size = path.stat().st_size
        index = order.get(str(path))
        if index is None:
            # Not ticked: listed, never copied, and takes no number.
            items.append({"src": str(path), "original_name": path.name, "name": "",
                          "dst": "", "size": size, "duration": seconds, "codec": family,
                          "status": "skip"})
            continue
        name = naming.dedupe(
            output_name(job_number, session_folder, seconds, index, count, path.suffix), taken)
        taken.add(name.lower())
        dst = (dest_path / name) if dest_path else None
        status = "new"
        if dst is not None and dst.exists():
            status = "same" if dst.stat().st_size == size else "conflict"
        if seconds is None:
            warnings.append(f"Can't read the length of {path.name}, so its Dur- is left out.")
        if family and family not in ("h264", "unknown"):
            warnings.append(f"{path.name} is {probe.FAMILY_LABELS.get(family, family)}, "
                            "not H.264. Check this is the HyperDeck card.")
        items.append({"src": str(path), "original_name": path.name, "name": name,
                      "dst": str(dst) if dst else "", "size": size,
                      "duration": seconds, "codec": family, "status": status})

    conflicts = [i for i in items if i["status"] == "conflict"]
    if conflicts:
        warnings.append(f"{len(conflicts)} file(s) of the same name but a different size are "
                        "already in the output folder; they are left alone and not copied.")
    if not items:
        warnings.append("No video files were found there.")
    return {"source": source, "dest": dest, "job_number": job_number,
            "session_folder": session_folder, "items": items,
            "count": len(items), "total_bytes": sum(i["size"] for i in items),
            "picked": count if picked else len(items),
            "to_copy_bytes": sum(i["size"] for i in items if i["status"] == "new"),
            "warnings": warnings}


def _inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except (ValueError, OSError):
        return False


def _check_name(path: Path) -> None:
    for part in (path.name, path.name + PART_SUFFIX):
        if len(part.encode("utf-16-le")) // 2 > 255 or len(part.encode("utf-8")) > 255:
            raise ValueError(f"Name too long: {path.name}. Shorten the session name first.")


def run(plan: dict, verify: str = "size", progress=None, should_cancel=None) -> dict:
    """Copy the plan's new files, then check every one against the card.

    Never overwrites: a file already there with the same size is only checked,
    and one with a different size is reported and left alone.
    """
    emit = progress or (lambda _d: None)
    should_cancel = should_cancel or (lambda: False)
    dest = Path(plan.get("dest") or "")
    if not str(dest) or not dest.is_dir():
        raise ValueError("Choose the output folder first.")
    items = [i for i in plan.get("items") or [] if i.get("status") != "skip"]
    for item in items:
        _check_name(Path(item["dst"]))

    total = sum(int(i.get("size") or 0) for i in items if i.get("status") == "new") or 1
    done = 0
    results: list[dict] = []
    errors: list[str] = []

    started = None   # when the first byte was copied: the speed is copy time only

    def on_chunk(n):
        nonlocal done, started
        now = time.monotonic()
        if started is None:
            started = now
        done += n
        elapsed = now - started
        rate = done / elapsed if elapsed > 0.05 else 0
        emit({"stage": "copy", "percent": round(done * 100 / total, 1),
              "bytes_done": done, "bytes_total": total, "current": current,
              "rate_bps": rate,
              "eta_seconds": round((total - done) / rate) if rate > 1 else None})

    current = ""
    try:
        for item in items:
            src, dst = Path(item["src"]), Path(item["dst"])
            current = item["name"]
            rec = {"name": item["name"], "src": str(src), "dst": str(dst),
                   "copied": False, "verified": False, "detail": ""}
            try:
                if dst.exists():
                    if dst.stat().st_size != src.stat().st_size:
                        rec["detail"] = "a different file of this name is already there; left alone"
                        errors.append(f"{dst.name}: {rec['detail']}")
                        results.append(rec)
                        continue
                    rec["detail"] = "already there"
                else:
                    _copy_with_progress(src, dst, on_chunk, should_cancel)
                    rec["copied"] = True
                ok, detail = _verify(src, dst, verify, should_cancel)
                rec["verified"] = ok
                rec["detail"] = detail if not rec["detail"] else f"{rec['detail']}, {detail}"
                if not ok:
                    errors.append(f"{dst.name}: {detail}")
            except Cancelled:
                raise
            except OSError as exc:
                rec["detail"] = exc.strerror or str(exc)
                errors.append(f"{src.name}: {rec['detail']}")
            results.append(rec)
    except Cancelled:
        return {"cancelled": True, "results": results, "errors": errors,
                "copied": sum(1 for r in results if r["copied"]),
                "verified": sum(1 for r in results if r["verified"])}

    return {"cancelled": False, "results": results, "errors": errors,
            "copied": sum(1 for r in results if r["copied"]),
            "verified": sum(1 for r in results if r["verified"]),
            "ok": not errors and all(r["verified"] for r in results),
            "verify": verify, "dest": str(dest)}


def _verify(src: Path, dst: Path, mode: str, should_cancel) -> tuple[bool, str]:
    sa, sb = src.stat().st_size, dst.stat().st_size
    if sa != sb:
        return False, f"size differs by {abs(sa - sb)} bytes"
    if mode == "hash":
        a = file_digest(src, should_cancel=should_cancel)
        b = file_digest(dst, should_cancel=should_cancel)
        if should_cancel():
            raise Cancelled()
        if a != b:
            return False, "checksums differ"
        return True, "checksums match"
    return True, "same size"

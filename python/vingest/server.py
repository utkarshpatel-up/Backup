"""JSON-lines RPC over stdio. One request per line in, one response per line out.

Request:   {"id": 7, "method": "build_plan", "params": {...}}
Response:  {"id": 7, "ok": true, "result": {...}}
Progress:  {"event": "progress", "id": 7, "data": {...}}

Long-running methods run on a worker thread so the loop can still accept a
`cancel` for the job that is in flight.
"""

from __future__ import annotations

import json
import sys
import threading
import traceback
from pathlib import Path

from . import __version__, compare, ingest, naming, probe, report, sources, structure
from .hashing import algorithm

_LOCK = threading.Lock()
_CANCELLED: set[int] = set()


def _send(payload: dict) -> None:
    with _LOCK:
        sys.stdout.write(json.dumps(payload, default=str) + "\n")
        sys.stdout.flush()


def _progress(req_id):
    def emit(data: dict):
        _send({"event": "progress", "id": req_id, "data": data})
    return emit


def _cancelled(req_id):
    return lambda: req_id in _CANCELLED


# ------------------------------------------------------------------ methods

def m_ping(_p, _id):
    tools = probe.configure()
    return {"version": __version__, "python": sys.version.split()[0],
            "digest": algorithm(), **tools,
            "ready": bool(tools.get("ffprobe"))}


def m_configure(p, _id):
    return probe.configure(p.get("ffprobe"), p.get("ffmpeg"))


def m_list_volumes(_p, _id):
    return {"volumes": sources.list_volumes()}


def m_find_camera_cards(p, _id):
    """Locate mounted camera cards (Canon XF and friends) and their clips."""
    return sources.find_camera_cards(p.get("layouts"))


def m_inspect_zip(p, _id):
    return sources.inspect_zip(p["path"])


def m_extract_zip(p, req_id):
    path = sources.extract_zip(p["path"], p.get("dest"), _progress(req_id))
    return {"path": path}


def m_cleanup_zip(p, _id):
    return {"removed": sources.cleanup_zip(p["path"])}


def m_classify(p, req_id):
    emit = _progress(req_id)
    reports = []
    roots = p.get("roots", [])
    for n, root in enumerate(roots, 1):
        emit({"stage": "classify", "done": n - 1, "total": len(roots), "root": root})
        reports.append(probe.classify_source(root, p.get("sample_size", 12)))
    emit({"stage": "classify", "done": len(roots), "total": len(roots)})
    return {"reports": [r.to_dict() for r in reports],
            "assignment": probe.assign_roles(reports)}


def m_detect_structure(p, _id):
    """Find the session folder a source already carries, and what it needs."""
    d = structure.detect(p["root"]).to_dict()
    master = structure.pick_master(d)
    d["suggested_master"] = master
    d["rename"] = structure.planned_rename(
        d, master.get("duration") if master else None)
    d["unfiled"] = structure.unfiled_clips(d, master.get("path") if master else None)
    return d


def m_scan(p, req_id):
    """Probe every video under a root — the file list the GUI assigns to cams."""
    emit = _progress(req_id)
    paths = probe.scan_videos(p["root"])
    out = []
    for n, path in enumerate(paths, 1):
        if req_id in _CANCELLED:
            return {"cancelled": True, "files": out}
        emit({"stage": "scan", "done": n, "total": len(paths), "name": path.name})
        out.append(probe.probe(path).to_dict())
    out.sort(key=lambda f: (f.get("mtime") or 0))
    return {"root": p["root"], "files": out, "count": len(out),
            "by_date": ingest.group_by_date(out, p.get("session_date")),
            "suggestion": ingest.suggest_cam_groups(out)}


def m_add_files(p, req_id):
    """Probe an explicit list of files or folders the operator picked by hand.

    Used when the structure came from a zip that carries no footage: the clips
    are chosen off the source drive instead.
    """
    emit = _progress(req_id)
    from pathlib import Path as _P

    paths: list = []
    for raw in p.get("paths", []):
        item = _P(raw)
        if item.is_dir():
            paths.extend(probe.scan_videos(item))
        elif probe.is_video(item):
            paths.append(item)

    seen, unique = set(), []
    for item in paths:
        key = str(item)
        if key not in seen:
            seen.add(key)
            unique.append(item)

    out = []
    for n, item in enumerate(unique, 1):
        if req_id in _CANCELLED:
            return {"cancelled": True, "files": out}
        emit({"stage": "scan", "done": n, "total": len(unique), "name": item.name})
        out.append(probe.probe(item).to_dict())
    out.sort(key=lambda f: (f.get("mtime") or 0))
    return {"files": out, "count": len(out),
            "by_date": ingest.group_by_date(out, p.get("session_date"))}


def m_group_dates(p, _id):
    """Re-bucket an already-probed file list by last-modified day."""
    return ingest.group_by_date(p.get("files", []), p.get("session_date"))


def m_probe(p, _id):
    return probe.probe(p["path"]).to_dict()


def m_pair(p, _id):
    return ingest.pair_sources(p["primary"], p["secondary"],
                               p.get("duration_tol", 1.5),
                               p.get("time_tol", 900.0))


def m_preview_name(p, _id):
    """Live folder-name preview while the operator types the title."""
    import datetime as dt
    when = dt.date.fromisoformat(p["date"]) if p.get("date") else dt.date.today()
    seconds = p.get("duration")
    return {
        "session_folder": naming.build_session_folder(p.get("title", ""), when, seconds),
        "job_folder": naming.build_job_folder(p["job_number"], when)
        if p.get("job_number") else "",
        "duration_label": naming.fmt_duration(seconds),
        "date_label": naming.fmt_date(when),
    }


def m_build_plan(p, req_id):
    return ingest.build_plan(p, _progress(req_id))


def m_execute_plan(p, req_id):
    plan = p["plan"]
    result = ingest.execute_plan(plan, _progress(req_id), _cancelled(req_id))
    manifests = []
    if p.get("write_manifest", True):
        for target in plan.get("targets", []):
            try:
                manifests.append(report.write_manifest(
                    target["session_path"], plan, result, target))
            except OSError as e:
                result.setdefault("errors", []).append(f"Manifest failed: {e}")
    result["manifests"] = manifests
    return result


def m_snapshot(p, req_id):
    return compare.snapshot(p["root"], p.get("with_duration", True),
                            _progress(req_id), _cancelled(req_id))


def m_compare(p, req_id):
    emit = _progress(req_id)
    snaps = []
    roots = p.get("roots", [])
    for n, root in enumerate(roots, 1):
        emit({"stage": "index", "done": n - 1, "total": len(roots), "root": root})
        snaps.append(compare.snapshot(root, p.get("with_duration", True),
                                      emit, _cancelled(req_id)))
    result = compare.compare(snaps, p.get("duration_tol", 1.0))
    result["snapshots"] = snaps
    if p.get("report_path"):
        result["report"] = report.write_compare_report(p["report_path"], result)
    return result


def m_verify_pairs(p, req_id):
    """Verify explicit (a, b) file pairs are identical — the clips copied to both
    SSDs. Nothing else is looked at: not the card, not the per-drive masters."""
    from pathlib import Path as _P
    from .hashing import file_digest, algorithm
    emit = _progress(req_id)
    mode = p.get("mode", "size")
    pairs = p.get("pairs", [])
    labels = p.get("labels", [])
    results = []
    for n, pair in enumerate(pairs, 1):
        a, b = pair[0], pair[1]
        if req_id in _CANCELLED:
            return {"cancelled": True, "results": results}
        label = labels[n - 1] if n - 1 < len(labels) else _P(a).name
        emit({"stage": "verify", "done": n, "total": len(pairs), "name": label})
        rec = {"name": label, "a": a, "b": b, "match": False, "detail": ""}
        try:
            sa, sb = _P(a).stat().st_size, _P(b).stat().st_size
            if sa != sb:
                rec["detail"] = f"size differs: {sa} vs {sb}"
            elif mode == "hash":
                ha, hb = file_digest(a), file_digest(b)
                rec["match"] = ha == hb
                rec["detail"] = "checksums match" if rec["match"] else "checksums differ"
            else:
                rec["match"] = True
                rec["detail"] = f"same size ({sa} bytes)"
        except OSError as e:
            rec["detail"] = str(e)
        results.append(rec)
    return {
        "algorithm": (algorithm() if mode == "hash" else "size"),
        "checked": len(results),
        "results": results,
        "mismatched": [r for r in results if not r["match"]],
        "ok": all(r["match"] for r in results),
    }


def m_deep_verify(p, req_id):
    pairs = p.get("pairs")
    if not pairs and p.get("roots") and len(p["roots"]) >= 2:
        a = compare.snapshot(p["roots"][0], with_duration=False)
        b = compare.snapshot(p["roots"][1], with_duration=False)
        pairs = compare.pair_for_verify(a, b)
    return compare.deep_verify([tuple(x) for x in (pairs or [])],
                               p.get("quick", False),
                               _progress(req_id), _cancelled(req_id))


def m_eject(p, _id):
    return sources.eject(p["path"])


def m_shutdown(_p, _id):
    return {"bye": True}


def m_cancel(p, _id):
    _CANCELLED.add(int(p["target_id"]))
    return {"cancelled": p["target_id"]}


METHODS = {name[2:]: fn for name, fn in list(globals().items())
           if name.startswith("m_")}


# --------------------------------------------------------------------- loop

def _handle(req: dict) -> None:
    req_id = req.get("id")
    method = req.get("method")
    fn = METHODS.get(method)
    if fn is None:
        _send({"id": req_id, "ok": False,
               "error": f"Unknown method: {method}",
               "known": sorted(METHODS)})
        return
    try:
        result = fn(req.get("params") or {}, req_id)
        _send({"id": req_id, "ok": True, "result": result})
    except Exception as e:                       # surfaced in the GUI, not swallowed
        _send({"id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}",
               "traceback": traceback.format_exc()})
    finally:
        _CANCELLED.discard(req_id)


def main() -> None:
    probe.configure()
    _send({"event": "ready", "data": m_ping({}, None)})
    workers: list[threading.Thread] = []

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _send({"ok": False, "error": f"Bad JSON: {e}"})
            continue
        if req.get("method") in ("cancel", "shutdown"):
            _handle(req)                          # must not queue behind the job
            if req.get("method") == "shutdown":
                break
            continue
        t = threading.Thread(target=_handle, args=(req,), daemon=True)
        t.start()
        workers.append(t)
        workers[:] = [w for w in workers if w.is_alive()]

    # stdin closed: let in-flight jobs finish writing their replies before the
    # interpreter tears down, or their output is lost mid-line.
    for w in workers:
        w.join(timeout=300)


if __name__ == "__main__":
    main()

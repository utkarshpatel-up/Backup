"""Session manifests — a record of what was copied, written beside the footage."""

from __future__ import annotations

import csv
import datetime as _dt
import json
import platform
from pathlib import Path

from . import naming
from .hashing import algorithm

MANIFEST_DIR = "_manifest"


def write_manifest(session_path: str | Path, plan: dict, result: dict,
                   target: dict) -> dict:
    """Drop a JSON + CSV manifest into the session folder.

    Kept in a `_manifest` subfolder so it never gets mistaken for footage, and
    so the folder comparison can ignore it by name.
    """
    session = Path(session_path)
    out_dir = session / MANIFEST_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = _dt.datetime.now()

    payload = {
        "generated": stamp.isoformat(timespec="seconds"),
        "app": "Video Ingest",
        "host": platform.node(),
        "platform": platform.platform(),
        "title": plan.get("title"),
        "job_number": plan.get("job_number"),
        "session_folder": target.get("session_folder"),
        "role": target.get("role"),
        "source_root": target.get("source_root"),
        "mode": plan.get("mode"),
        "verify": plan.get("verify"),
        "digest_algorithm": algorithm(),
        "copied": result.get("copied"),
        "skipped": result.get("skipped"),
        "failed": result.get("failed"),
        "seconds": result.get("seconds"),
        "files": [],
    }

    rows = []
    for item in result.get("items", []):
        item_path = Path(item.get("dst", ""))
        try:
            relative = item_path.relative_to(session)
        except ValueError:
            continue
        rec = {
            "kind": item.get("kind"),
            "cam": item.get("cam"),
            "original_name": item.get("original_name"),
            "final_name": Path(item["dst"]).name,
            "relative_path": str(relative),
            "size": item.get("size"),
            "duration_seconds": item.get("duration"),
            "duration_label": naming.fmt_duration(item.get("duration")),
            "codec": item.get("codec"),
            "status": item.get("status"),
            "message": item.get("message"),
            "source_path": item.get("src"),
        }
        payload["files"].append(rec)
        rows.append(rec)

    base = f"manifest {naming.fmt_date(stamp)} {stamp:%H%M%S}"
    json_path = out_dir / f"{base}.json"
    csv_path = out_dir / f"{base}.csv"
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    if rows:
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    return {"json": str(json_path), "csv": str(csv_path) if rows else None,
            "file_count": len(rows)}


def write_compare_report(dest: str | Path, comparison: dict,
                         deep: dict | None = None) -> str:
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(
        {"generated": _dt.datetime.now().isoformat(timespec="seconds"),
         "comparison": comparison, "deep_verify": deep}, indent=2),
        encoding="utf-8")
    return str(dest)

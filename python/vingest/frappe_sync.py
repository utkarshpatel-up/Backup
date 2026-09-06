"""Push informal session durations and clip counts to a Frappe database.

Workflow this supports: after the operator filters (deletes bad takes) and
renames an informal session, its real total duration and clip count are read
straight from the file headers (see :mod:`durations`, no ffmpeg needed) and
written to an existing Frappe record found by matching fields — a project id
and a session number. Records that are NOT found are never created; they are
returned and written to a CSV so the operator can fix them in Frappe by hand.

The HTTP layer is injected (`requester`) so the scan/match/partition logic can
be tested without a live site. The default requester uses urllib (stdlib).
"""

from __future__ import annotations

import csv
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .durations import format_duration, get_duration
from .ingest import CLIP_COUNT_EXTS

PROJECT_ID_RE = re.compile(r"\b(\d{4,})\b")
SESSION_NUM_RE = re.compile(r"^(\d+)\b")
CAM_FOLDER_RE = re.compile(r"cam[-\s_]*\d+", re.IGNORECASE)


def _is_cam_folder(name: str) -> bool:
    return bool(CAM_FOLDER_RE.search(name))


def _session_number(name: str):
    """Leading session integer ('02 Event' -> 2); None if it looks like an id."""
    m = SESSION_NUM_RE.match(name)
    if not m:
        return None
    val = int(m.group(1))
    return val if val < 100 else None


def _project_id(parent_name: str) -> str:
    m = PROJECT_ID_RE.search(parent_name)
    return m.group(1) if m else ""


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

    A session folder is one whose name starts with a session number (< 100),
    whose parent name carries a 4+ digit project id, that is not itself a
    camera (Cam-NN) folder, and that holds at least one clip (recursively).
    Camera sub-folders roll up into their session, so they are never rows of
    their own.
    """
    root = os.path.abspath(root)
    exts = set(extensions) if extensions else set(CLIP_COUNT_EXTS)
    sessions = []
    for dirpath, dirnames, _files in os.walk(root):
        base = os.path.basename(dirpath)
        if _is_cam_folder(base):
            continue
        session = _session_number(base)
        if session is None:
            continue
        project = _project_id(os.path.basename(os.path.dirname(dirpath)))
        if not project:
            continue
        total, count, unknown = _scan_one(Path(dirpath), exts)
        if count == 0:
            continue
        sessions.append({
            "path": dirpath,
            "folder": base,
            "project": project,
            "session": session,
            "seconds": round(total, 2),
            "clips": count,
            "unknown": unknown,
        })
    sessions.sort(key=lambda s: (s["project"], s["session"]))
    return sessions


# ------------------------------------------------------------------- HTTP

def _urllib_requester(method, url, headers, body=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace") if e.fp else ""
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"_raw": raw}
        return e.code, parsed
    except urllib.error.URLError as e:
        return 0, {"_error": str(e.reason)}


def _headers(config):
    h = {"Accept": "application/json"}
    key = (config.get("api_key") or "").strip()
    secret = (config.get("api_secret") or "").strip()
    if key and secret:
        h["Authorization"] = f"token {key}:{secret}"
    return h


def config_problems(config: dict) -> list[str]:
    """List missing required settings, so the UI can refuse early with a clear
    message rather than firing broken requests."""
    required = {
        "url": "Frappe URL", "api_key": "API key", "api_secret": "API secret",
        "doctype": "DocType", "project_field": "Project field",
        "session_field": "Session field", "duration_field": "Duration field",
        "clips_field": "Clip-count field",
    }
    return [label for key, label in required.items() if not str(config.get(key) or "").strip()]


def sync(config: dict, sessions: list[dict], requester=None) -> dict:
    """Update an existing Frappe record per session (never create one).

    Returns lists partitioned by outcome: `updated`, `unmatched` (no record
    found — for the operator to fix in Frappe), and `errors` (ambiguous matches
    or request failures).
    """
    requester = requester or _urllib_requester
    base = str(config["url"]).rstrip("/")
    doctype = config["doctype"]
    enc = urllib.parse.quote(doctype)
    headers = _headers(config)
    style = config.get("duration_format", "human")

    updated, unmatched, errors = [], [], []

    for s in sessions:
        filters = [[config["project_field"], "=", s["project"]],
                   [config["session_field"], "=", s["session"]]]
        query = urllib.parse.urlencode({
            "filters": json.dumps(filters),
            "fields": json.dumps(["name"]),
            "limit_page_length": 0,
        })
        list_url = f"{base}/api/resource/{enc}?{query}"
        status, payload = requester("GET", list_url, headers)
        if status != 200:
            errors.append({**s, "reason": _explain(status, payload, "lookup")})
            continue
        names = [row.get("name") for row in (payload.get("data") or []) if row.get("name")]
        if not names:
            unmatched.append({**s, "reason": "No matching record in Frappe"})
            continue
        if len(names) > 1:
            errors.append({**s, "reason": f"{len(names)} records match "
                           f"{s['project']}/{s['session']} — resolve in Frappe"})
            continue

        name = names[0]
        doc_url = f"{base}/api/resource/{enc}/{urllib.parse.quote(str(name))}"
        body = {
            config["duration_field"]: format_duration(s["seconds"], style),
            config["clips_field"]: s["clips"],
        }
        status, payload = requester("PUT", doc_url,
                                    {**headers, "Content-Type": "application/json"}, body)
        if status in (200, 202):
            updated.append({**s, "name": name})
        else:
            errors.append({**s, "name": name, "reason": _explain(status, payload, "update")})

    return {
        "total": len(sessions),
        "updated": updated,
        "unmatched": unmatched,
        "errors": errors,
    }


def _explain(status, payload, phase) -> str:
    if status == 0:
        return f"Could not reach Frappe ({payload.get('_error', 'connection failed')})"
    if status in (401, 403):
        return "Authentication failed — check the API key/secret and permissions"
    if status == 404 and phase == "lookup":
        return "DocType not found — check the DocType name"
    msg = payload.get("exception") or payload.get("message") or payload.get("_error") or ""
    return f"Frappe returned HTTP {status}{f': {msg}' if msg else ''}"


def write_unmatched_csv(path: str, rows: list[dict]) -> str:
    """Write the unmatched/errored sessions to a CSV for manual fixing."""
    path = os.path.abspath(path)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Project", "Session", "Folder", "Clips",
                    "Duration (s)", "Duration", "Reason", "Path"])
        for r in rows:
            w.writerow([r.get("project", ""), r.get("session", ""), r.get("folder", ""),
                        r.get("clips", ""), int(round(r.get("seconds", 0))),
                        format_duration(r.get("seconds"), "human"),
                        r.get("reason", ""), r.get("path", "")])
    return path

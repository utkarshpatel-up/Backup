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
DEFAULT_REPORT = "Raw Video Data Report"
REPORT_TIMEOUT = 180  # a whole report can take far longer than one record
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


def report_problems(config: dict) -> list[str]:
    """Settings missing for reading the report: only the connection, no field names."""
    required = {"url": "Frappe URL", "api_key": "API key", "api_secret": "API secret"}
    return [label for key, label in required.items() if not str(config.get(key) or "").strip()]


def _report_columns(columns) -> list[tuple[str, str]]:
    """(label, fieldname) per column: a dict, or Frappe's older 'Label:Type/Option:Width' text."""
    out = []
    for c in columns or []:
        if isinstance(c, dict):
            label = str(c.get("label") or c.get("fieldname") or "")
            out.append((label, str(c.get("fieldname") or label)))
        else:
            label = str(c).split(":")[0]
            out.append((label, label))
    return out


def fetch_report(config: dict, requester=None) -> list[list]:
    """Read a Frappe report over its API, read-only. Returns [header, row, row …]
    with the same column labels as the report's own download."""
    problems = report_problems(config)
    if problems:
        raise ValueError("Frappe settings missing: " + ", ".join(problems))
    requester = requester or _urllib_requester
    name = str(config.get("report_name") or "").strip() or DEFAULT_REPORT
    query = urllib.parse.urlencode({"report_name": name, "filters": "{}", "ignore_prepared_report": 1})
    url = f"{str(config['url']).rstrip('/')}/api/method/frappe.desk.query_report.run?{query}"
    status, payload = requester("GET", url, _headers(config), timeout=REPORT_TIMEOUT)
    if status == 404:
        raise ValueError(f'Frappe has no report named "{name}" — check the report name.')
    if status != 200:
        raise ValueError(_explain(status, payload, "report"))
    message = payload.get("message") if isinstance(payload, dict) else None
    if not isinstance(message, dict) or "columns" not in message:
        raise ValueError(f'Frappe did not return the columns of "{name}".')
    columns = _report_columns(message.get("columns"))
    rows = [[label for label, _ in columns]]
    for row in message.get("result") or []:
        if isinstance(row, dict):
            if row.get("is_total_row"):
                continue
            cells = [row.get(field) for _, field in columns]
        elif isinstance(row, (list, tuple)):
            cells = list(row)[:len(columns)]
        else:
            continue
        rows.append(["" if c is None else c for c in cells])
    return rows


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

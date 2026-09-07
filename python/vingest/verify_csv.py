"""Offline verification of a footage folder against a duration CSV.

The operator exports the duration/clip-count list from Frappe *while online*
(a plain CSV), then — with no network — this compares that master list against
what is actually on the drive. It is the offline twin of :mod:`frappe_sync`:
same session scan, but instead of pushing to a live site it diffs against a
file and produces a highlighted report, exactly like the standalone
``vidcount_consolidated`` template does.

Each session is flagged:

* ``match``       — present in both, duration and clip count agree
* ``diff``        — present in both, but the clip count or duration disagrees
* ``scan_only``   — on the drive, missing from the master CSV   (red)
* ``master_only`` — in the master CSV, not found on the drive   (orange)

Matching is keyed on (project id, session number) only, so a quality-code
difference in the ID string (HD vs 4K) never causes a false mismatch — the
same rule the standalone template uses.
"""

from __future__ import annotations

import csv
import os
import re
from pathlib import Path

from .durations import fmt_hms, fmt_human, format_duration
from .frappe_sync import scan_sessions

# project id (4+ digits) then a session number, e.g. DD-I-HD-2405-1 -> (2405, 1)
_ID_KEY_RE = re.compile(r"(\d{4,})-(\d+)(?!.*\d{4,}-\d+)")
_HMS_RE = re.compile(r"^\s*(\d+):([0-5]?\d):([0-5]?\d)\s*$")
_HUMAN_RE = re.compile(
    r"(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?", re.IGNORECASE)

# How close two durations must be (seconds) to still count as a match. Header
# durations are whole-second, and rounding across formats can drift by ~1s.
_DURATION_TOL = 2.0


def _key_from_id(text: str):
    """(project_str, session_int) from an ID like 'DD-I-HD-2405-1', else None."""
    m = _ID_KEY_RE.search(text or "")
    return (m.group(1), int(m.group(2))) if m else None


def is_special(activity: str, author: str) -> bool:
    """A Frappe row the operator flags apart (light blue): a Sankul activity or
    the DJM author. Both columns are optional — an empty value is never special.
    Activity values look like 'Sankul - All Sankul Bhaio', so a prefix match
    catches every Sankul variant."""
    act = str(activity or "").strip().lower()
    auth = str(author or "").strip().upper()
    return act.startswith("sankul") or auth == "DJM"


def parse_seconds(text: str):
    """Best-effort seconds from a duration cell: HH:MM:SS, '1h 2m 3s', or a
    bare number. Returns None when nothing parseable is present."""
    if text is None:
        return None
    s = str(text).strip()
    if not s:
        return None
    m = _HMS_RE.match(s)
    if m:
        h, mnt, sec = (int(g) for g in m.groups())
        return h * 3600 + mnt * 60 + sec
    if re.fullmatch(r"\d+(?:\.\d+)?", s):
        return float(s)
    m = _HUMAN_RE.fullmatch(s.strip())
    if m and any(m.groups()):
        h, mnt, sec = (int(g) if g else 0 for g in m.groups())
        return h * 3600 + mnt * 60 + sec
    return None


def _find_col(header, *needles, exact=None):
    """Index of the first header cell that equals `exact` (case-insensitive) or
    else contains any of `needles`. Returns None if nothing matches."""
    lowered = [str(c or "").strip().lower() for c in header]
    if exact:
        want = str(exact).strip().lower()
        for i, cell in enumerate(lowered):
            if cell == want:
                return i
    for i, cell in enumerate(lowered):
        if any(n in cell for n in needles):
            return i
    return None


def _looks_like_header(row):
    joined = " ".join(str(c or "").lower() for c in row)
    return any(w in joined for w in
               ("project", "session", "duration", "clip", "id", "name"))


def _col_index(ref: str) -> int:
    """'B12' -> 1 (0-based column). Empty ref -> 0."""
    letters = "".join(ch for ch in ref if ch.isalpha())
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch.upper()) - 64)
    return idx - 1 if idx else 0


def _read_xlsx_rows(path: str) -> list[list[str]]:
    """Read the first worksheet of an .xlsx as rows of strings — stdlib only,
    so the frozen build needs no openpyxl. Shared strings and inline strings are
    resolved; numbers come through as their text."""
    import zipfile
    import xml.etree.ElementTree as ET

    def local(tag):
        return tag.rsplit("}", 1)[-1]

    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = ET.parse(z.open("xl/sharedStrings.xml")).getroot()
            for si in list(root):
                shared.append("".join(
                    (t.text or "") for t in si.iter() if local(t.tag) == "t"))

        sheet = "xl/worksheets/sheet1.xml"
        if sheet not in names:
            cand = sorted(n for n in names
                          if n.startswith("xl/worksheets/") and n.endswith(".xml"))
            if not cand:
                return []
            sheet = cand[0]

        root = ET.parse(z.open(sheet)).getroot()
        rows: list[list[str]] = []
        for row in root.iter():
            if local(row.tag) != "row":
                continue
            cells: dict[int, str] = {}
            max_i = -1
            col = 0
            for c in row:
                if local(c.tag) != "c":
                    continue
                ref = c.attrib.get("r", "")
                ci = _col_index(ref) if ref else col
                col = ci + 1
                ctype = c.attrib.get("t")
                v_el = is_el = None
                for ch in c:
                    if local(ch.tag) == "v":
                        v_el = ch
                    elif local(ch.tag) == "is":
                        is_el = ch
                val = ""
                if ctype == "s" and v_el is not None and (v_el.text or "").strip().isdigit():
                    si = int(v_el.text)
                    val = shared[si] if si < len(shared) else ""
                elif is_el is not None:
                    val = "".join((t.text or "") for t in is_el.iter()
                                  if local(t.tag) == "t")
                elif v_el is not None:
                    val = v_el.text or ""
                cells[ci] = val
                max_i = max(max_i, ci)
            rows.append([cells.get(i, "") for i in range(max_i + 1)])
        return rows


def _read_rows(path: str) -> list[list[str]]:
    """Master rows from either an .xlsx export or a plain .csv."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm"):
        rows = _read_xlsx_rows(path)
    else:
        with open(path, newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
    return [r for r in rows if any(str(c).strip() for c in r)]


def parse_master(csv_path: str, config: dict | None = None) -> list[dict]:
    """Read the exported duration list (CSV or .xlsx) into keyed master rows.

    Two shapes are supported, in order of preference:

    1. Columnar — a header row names project / session / duration / clip
       columns (matched to the configured Frappe field names first, then by
       keyword). This is what a Frappe list export looks like.
    2. ID style — rows whose first cell is a combined id such as
       ``DD-I-HD-2405-1`` followed by duration and clip-count cells, exactly
       like the standalone tool's ``duration.csv``.
    """
    config = config or {}
    rows = _read_rows(csv_path)
    if not rows:
        return []

    # Locate a header row (scan the first few — exported CSVs sometimes carry
    # a title line above the real header).
    header = header_idx = None
    for i, row in enumerate(rows[:5]):
        if _looks_like_header(row):
            header, header_idx = row, i
            break

    out: list[dict] = []
    seen: set = set()

    def _add(key, id_str, dur, clips, activity="", author=""):
        if key is None or key in seen:
            return
        seen.add(key)
        out.append({
            "key": key,
            "id": id_str or f"{key[0]}-{key[1]}",
            "project": key[0],
            "session": key[1],
            "duration": str(dur or "").strip(),
            "clips": str(clips or "").strip(),
            "seconds": parse_seconds(dur),
            "activity": str(activity or "").strip(),
            "author": str(author or "").strip(),
        })

    if header is not None:
        proj_i = _find_col(header, "project", exact=config.get("project_field"))
        sess_i = _find_col(header, "session", exact=config.get("session_field"))
        dur_i = _find_col(header, "duration", "total",
                          exact=config.get("duration_field"))
        clip_i = _find_col(header, "clip", "count", "no of",
                           exact=config.get("clips_field"))
        id_i = _find_col(header, "id", "name")
        # Optional extra columns — present only in some exports.
        activity_i = _find_col(header, "activity")
        author_i = _find_col(header, "author")

        def cell(row, i):
            return row[i].strip() if i is not None and i < len(row) else ""

        # Columnar parsing works as long as the row's (project, session) key can
        # be found — either from explicit project+session columns, or from the
        # id column. The clip/duration columns are located by name, so their
        # order in the file does not matter.
        if (proj_i is not None and sess_i is not None) or id_i is not None:
            for row in rows[header_idx + 1:]:
                if proj_i is not None and sess_i is not None:
                    proj = re.sub(r"\D", "", cell(row, proj_i))
                    sm = re.search(r"\d+", cell(row, sess_i))
                    key = (proj, int(sm.group())) if proj and sm else None
                else:
                    key = _key_from_id(cell(row, id_i))
                if key is None:
                    continue
                _add(key, cell(row, id_i), cell(row, dur_i), cell(row, clip_i),
                     cell(row, activity_i), cell(row, author_i))
            if out:
                return out

    # Fallback: ID-style rows (id, duration, clips) anywhere in the file.
    for row in rows:
        if not row:
            continue
        key = _key_from_id(row[0])
        if key is None:
            continue
        dur = row[1].strip() if len(row) > 1 else ""
        clips = row[2].strip() if len(row) > 2 else ""
        _add(key, row[0].strip(), dur, clips)
    return out


def compare(root: str, csv_path: str, config: dict | None = None) -> dict:
    """Diff the sessions on disk under `root` against the master CSV.

    Returns the merged, sorted rows plus a per-flag tally. Nothing is written
    here — the caller decides where the report CSV goes.
    """
    scan_rows = scan_sessions(root)
    scan_by_key = {}
    for s in scan_rows:
        scan_by_key[(s["project"], int(s["session"]))] = s

    master_rows = parse_master(csv_path, config)
    master_by_key = {m["key"]: m for m in master_rows}

    all_keys = list(dict.fromkeys(
        list(master_by_key.keys()) + list(scan_by_key.keys())))

    merged = []
    for key in all_keys:
        m = master_by_key.get(key)
        s = scan_by_key.get(key)
        proj, sess = key
        row = {
            "project": proj,
            "session": sess,
            # Prefer the master's own id string (keeps its HD/4K quality code);
            # a drive-only row has no master id, so build the house-form id with
            # the common HD quality code as a sensible default.
            "id": (m["id"] if m else f"DD-I-HD-{proj}-{sess}"),
            "master_duration": (m["duration"] if m else ""),
            "master_clips": (m["clips"] if m else ""),
            "scan_duration": (fmt_human(s["seconds"]) if s else ""),
            "scan_clips": (str(s["clips"]) if s else ""),
            "scan_seconds": (round(s["seconds"], 2) if s else None),
            "master_seconds": (m["seconds"] if m else None),
            "path": (s["path"] if s else ""),
            "unknown": (s["unknown"] if s else 0),
            "clip_delta": None,
            "note": "",
            "activity": (m["activity"] if m else ""),
            "author": (m["author"] if m else ""),
        }
        if m and s:
            notes = []
            try:
                mc = int(re.sub(r"\D", "", m["clips"])) if m["clips"] else None
            except ValueError:
                mc = None
            if mc is not None:
                row["clip_delta"] = s["clips"] - mc
                if s["clips"] != mc:
                    notes.append(f"clips {mc}→{s['clips']}")
            if m["seconds"] is not None and abs(m["seconds"] - s["seconds"]) > _DURATION_TOL:
                notes.append(
                    f"duration {fmt_human(m['seconds'])}→{fmt_human(s['seconds'])}")
            row["flag"] = "diff" if notes else "match"
            row["note"] = "; ".join(notes)
        elif s:
            row["flag"] = "scan_only"
            row["note"] = "On drive, not in the CSV"
        else:
            row["flag"] = "master_only"
            row["note"] = "In the CSV, not found on drive"

        # A Frappe row whose Activity is a Sankul session, or whose Author is
        # DJM, is a special category the operator tracks separately — it takes
        # visual precedence (light blue) over the plain match/mismatch/in-CSV
        # colours. Drive-only rows have no Frappe entry, so they are never
        # special. The raw `flag` is kept for the note and clip delta.
        row["special"] = is_special(row["activity"], row["author"]) and row["flag"] != "scan_only"
        if row["flag"] == "scan_only":
            row["category"] = "scan_only"
        elif row["special"]:
            row["category"] = "special"
        else:
            row["category"] = row["flag"]
        merged.append(row)

    merged.sort(key=lambda r: (int(r["project"]) if str(r["project"]).isdigit()
                               else 0, r["session"]))

    counts = {"match": 0, "diff": 0, "scan_only": 0, "master_only": 0,
              "special": 0, "total": len(merged)}
    for r in merged:
        counts[r["category"]] += 1
    return {"rows": merged, "counts": counts,
            "scanned": len(scan_rows), "master": len(master_rows)}


# ------------------------------------------------------------- xlsx report

# Two sheets, a bold header, and rows tinted a vibrant yellow (in the master
# list, not on the drive) or a bright red (on the drive, not in the master list),
# matching the app's on-screen highlight colours. Written with the standard
# library so the frozen build needs no openpyxl.
_XLSX_STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<fonts count="2">'
    '<font><sz val="11"/><name val="Calibri"/></font>'
    '<font><b/><sz val="11"/><name val="Calibri"/></font>'
    '</fonts>'
    '<fills count="5">'
    '<fill><patternFill patternType="none"/></fill>'
    '<fill><patternFill patternType="gray125"/></fill>'
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFE600"/></patternFill></fill>'
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFF2626"/></patternFill></fill>'
    '<fill><patternFill patternType="solid"><fgColor rgb="FF9CD3F7"/></patternFill></fill>'
    '</fills>'
    '<borders count="1"><border/></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="5">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>'
    '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>'
    '<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>'
    '</cellXfs>'
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    '</styleSheet>')

# Per-category cell style index into cellXfs above. scan_only -> bright red,
# master_only -> vibrant yellow, special (Sankul/DJM) -> light blue; a row
# present in both (match or a value diff) is left unfilled, as the example shows.
_FLAG_STYLE = {"scan_only": 3, "master_only": 2, "special": 4}

_COLS = "ABCDEF"


def _xq(text) -> str:
    from xml.sax.saxutils import escape
    return escape("" if text is None else str(text))


def _xlsx_cell(ref: str, value, style: int | None) -> str:
    s = f' s="{style}"' if style else ""
    if value is None or str(value) == "":
        return f'<c r="{ref}"{s} t="inlineStr"/>'
    return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{_xq(value)}</t></is></c>'


def _xlsx_row(index: int, values, style: int | None) -> str:
    cells = "".join(_xlsx_cell(f"{_COLS[i]}{index}", v, style)
                    for i, v in enumerate(values))
    return f'<row r="{index}">{cells}</row>'


def _template_sheet(result: dict) -> str:
    header = ["ID (Frappe)", "Duration (Frappe)", "No of clips (Frappe)",
              "ID (Drive)", "Duration (Drive)", "No of clips (Drive)"]
    rows = [_xlsx_row(1, header, 1)]
    n = 2
    for r in result["rows"]:
        style = _FLAG_STYLE.get(r.get("category", r["flag"]))
        rows.append(_xlsx_row(n, [
            r["id"], r["master_duration"], r["master_clips"],
            r["id"], r["scan_duration"], r["scan_clips"]], style))
        n += 1
    cols = ("<cols>"
            + "".join(f'<col width="{w}" customWidth="1" min="{i}" max="{i}"/>'
                      for i, w in enumerate((28, 14, 16, 28, 14, 16), 1))
            + "</cols>")
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:F{n - 1}"/>{cols}'
        f'<sheetData>{"".join(rows)}</sheetData>'
        '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        '</worksheet>')


def _legend_sheet() -> str:
    def cell(ref, val, style=None):
        return _xlsx_cell(ref, val, style)
    rows = [
        f'<row r="1">{cell("A1", "Colour", 1)}{cell("B1", "Meaning", 1)}</row>',
        f'<row r="2">{cell("A2", "Red", 3)}'
        f'{cell("B2", "Entry found on the drive but NOT in the Frappe list")}</row>',
        f'<row r="3">{cell("A3", "Yellow", 2)}'
        f'{cell("B3", "Entry in the Frappe list but NOT found on the drive")}</row>',
        f'<row r="4">{cell("A4", "Light blue", 4)}'
        f'{cell("B4", "Frappe row with a Sankul activity or the DJM author")}</row>',
        f'<row r="5">{cell("A5", "(no colour)")}'
        f'{cell("B5", "Entry present in both")}</row>',
    ]
    cols = ('<cols><col width="12" customWidth="1" min="1" max="1"/>'
            '<col width="58" customWidth="1" min="2" max="2"/></cols>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:B5"/>{cols}'
        f'<sheetData>{"".join(rows)}</sheetData>'
        '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        '</worksheet>')


def write_report_xlsx(path: str, result: dict) -> str:
    """Write the highlighted comparison as an .xlsx (Template + Legend sheets),
    laid out and coloured to match the standalone vidcount template."""
    import zipfile

    path = os.path.abspath(path)
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '</Types>')
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>')
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Template" sheetId="1" r:id="rId1"/>'
        '<sheet name="Legend" sheetId="2" r:id="rId2"/></sheets></workbook>')
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '</Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        z.writestr("xl/styles.xml", _XLSX_STYLES)
        z.writestr("xl/worksheets/sheet1.xml", _template_sheet(result))
        z.writestr("xl/worksheets/sheet2.xml", _legend_sheet())
    return path


def write_report(path: str, root: str, csv_path: str, result: dict) -> str:
    """Write the highlighted comparison as a CSV with a Status column — the
    same layout the standalone tool falls back to when openpyxl is absent."""
    path = os.path.abspath(path)
    labels = {
        "match": "OK",
        "diff": "MISMATCH",
        "scan_only": "ON DRIVE / NOT IN CSV",
        "master_only": "IN CSV / NOT ON DRIVE",
    }
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["# vidcount offline verification"])
        w.writerow(["# Drive scanned", os.path.abspath(root)])
        w.writerow(["# Master CSV", os.path.abspath(csv_path)])
        c = result["counts"]
        w.writerow(["# Summary",
                    f"{c['match']} match, {c['diff']} mismatch, "
                    f"{c['scan_only']} on-drive-only, {c['master_only']} in-csv-only"])
        w.writerow([])
        w.writerow(["Status", "ID", "Project", "Session",
                    "Duration (CSV)", "Clips (CSV)",
                    "Duration (Drive)", "Clips (Drive)",
                    "Clip Δ", "Note", "Folder"])
        for r in result["rows"]:
            w.writerow([
                labels.get(r["flag"], r["flag"]), r["id"], r["project"],
                r["session"], r["master_duration"], r["master_clips"],
                r["scan_duration"], r["scan_clips"],
                ("" if r["clip_delta"] is None else r["clip_delta"]),
                r["note"], r["path"],
            ])
    return path

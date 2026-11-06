"""Event schedule -> its own .xlsx in the Raw Satsang Master layout: the engine's half.

The renderer reads the schedule and drafts the sessions (renderer/
schedule-logic.js); this module does the parts that need the disk:

* :func:`read_table` — a Word, Excel or CSV schedule as rows of cell texts, the
  same shape the OCR of a poster produces, so one parser handles them all.
* :func:`scan` — every session folder on a drive with its duration, clip count
  and camera count, keyed the way master rows are (folder number + M/E tag or
  session number).
* :func:`write_xlsx` — the finished rows as an .xlsx in the master's column
  layout, stdlib only so the frozen build needs no openpyxl.
* :func:`make_structure` — the empty job/session/camera folders a structure
  zip would carry, built from one schedule row so a backup can start from it.
"""

from __future__ import annotations

import csv
import datetime as _dt
import os
import re
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from . import naming, structure
from .durations import get_duration
from .session_scan import PROJECT_DIR_RE, _is_cam_folder, _scan_one, _session_number
from .ingest import CLIP_COUNT_EXTS
from .verify_csv import _read_xlsx_rows

COLUMNS = ["ID", "Folder/DVCAM No.", "Format", "Session Time/No.", "Author",
           "Satsang Type", "Full Date", "Duration", "Activity", "Place Details",
           "Topic/Description", "No of clips", "No of cameras",
           "Event Type (Event/Category)", "Language Type (Language)", "Geolocation"]

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


# ------------------------------------------------------------------ reading

def _docx_rows(path: str) -> list[list[str]]:
    """Paragraphs as one-cell rows and tables as rows of cells, in document order.
    A vertically merged cell repeats the text of the cell it continues."""
    def text_of(el) -> str:
        paras = []
        for p in el.iter(f"{_W}p"):
            paras.append("".join(t.text or "" for t in p.iter(f"{_W}t")))
        return "\n".join(x for x in paras if x.strip())

    with zipfile.ZipFile(path) as z:
        body = ET.parse(z.open("word/document.xml")).getroot().find(f"{_W}body")
    rows: list[list[str]] = []
    if body is None:
        return rows
    for el in body:
        if el.tag == f"{_W}p":
            t = text_of(el)
            if t.strip():
                rows.append([t])
        elif el.tag == f"{_W}tbl":
            above: dict[int, str] = {}
            for tr in el.iter(f"{_W}tr"):
                cells, col = [], 0
                for tc in tr.findall(f"{_W}tc"):
                    props = tc.find(f"{_W}tcPr")
                    span = 1
                    merged = False
                    if props is not None:
                        g = props.find(f"{_W}gridSpan")
                        if g is not None:
                            span = int(g.get(f"{_W}val", "1") or 1)
                        v = props.find(f"{_W}vMerge")
                        merged = v is not None and v.get(f"{_W}val", "continue") != "restart"
                    t = above.get(col, "") if merged else text_of(tc)
                    above[col] = t
                    cells.append(t)
                    col += span
                if any(c.strip() for c in cells):
                    rows.append(cells)
    return rows


def read_table(path: str) -> list[list[str]]:
    """A Word (.docx), Excel (.xlsx/.xlsm) or CSV schedule as rows of cell texts."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".docx":
        rows = _docx_rows(path)
    elif ext in (".xlsx", ".xlsm"):
        rows = _read_xlsx_rows(path)
    elif ext in (".csv", ".txt"):
        with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
            rows = list(csv.reader(f))
    else:
        raise ValueError(f"Can't read {ext or 'this'} files here — use a picture, PDF, "
                         "Word, Excel or CSV schedule.")
    return [[str(c) for c in r] for r in rows if any(str(c).strip() for c in r)]


# ----------------------------------------------------------------- scanning

def _cam_count(session: Path, exts) -> int:
    """Camera folders under the session (directly or in 'Clips for Insert')
    that hold at least one clip."""
    roots = [session] + [c for c in session.iterdir()
                         if c.is_dir() and c.name.lower() in structure.CLIPS_ALIASES]
    n = 0
    for r in roots:
        for c in r.iterdir():
            if c.is_dir() and _is_cam_folder(c.name) and _scan_one(c, exts)[1]:
                n += 1
    return n


def _master_totals(session: Path, exts):
    """Seconds and count of the master clips: the videos at the session root.
    A formal session's Dur- and Clips-NN are written from these alone; the
    camera clips under Clips for Insert are inserts, not part of the session."""
    seconds, count = 0.0, 0
    for f in sorted(session.iterdir()):
        if f.is_file() and not f.name.startswith(".") and f.suffix.lower() in exts:
            count += 1
            seconds += get_duration(str(f)) or 0
    return seconds, count


def scan(root: str, extensions=None, progress=None) -> list[dict]:
    """Every session folder under `root`: {project, tag, number, date, seconds,
    clips, cams, folder, path}. A session is a direct, non-camera child of a
    ``NNNN Dt-<date>`` job folder (the same rule as session_scan); `tag` is its
    Formal M/E/E2 marker, `number` its Informal leading index (1 when unnumbered).

    Duration and clips follow the backup's own naming: a Formal session (one with
    an M/E marker) counts its master clips only, like its Dur- and Clips-NN; an
    Informal session counts every clip in it."""
    root = os.path.abspath(root)
    exts = set(extensions) if extensions else set(CLIP_COUNT_EXTS)
    out: list[dict] = []
    for dirpath, dirnames, _files in os.walk(root):
        m = PROJECT_DIR_RE.match(os.path.basename(dirpath))
        if not m:
            continue
        dirnames[:] = []
        try:
            children = sorted(p for p in Path(dirpath).iterdir() if p.is_dir())
        except OSError:
            continue
        for child in children:
            if child.name.startswith(".") or _is_cam_folder(child.name):
                continue
            if progress:
                progress({"stage": "scan", "name": child.name})
            seconds, clips, _unknown = _scan_one(child, exts)
            if not clips:
                continue
            when, tag = structure._date_and_tag(child.name)
            if tag:
                try:
                    master_seconds, masters = _master_totals(child, exts)
                except OSError:
                    masters = 0
                if masters:
                    seconds, clips = master_seconds, masters
            try:
                cams = _cam_count(child, exts)
            except OSError:
                cams = 0
            out.append({
                "project": m.group(1),
                "tag": tag,
                "number": _session_number(child.name) or 1,
                "date": when.isoformat() if when else None,
                "seconds": round(seconds, 2),
                "clips": clips,
                "cams": cams,
                "folder": child.name,
                "path": str(child),
            })
    out.sort(key=lambda s: (int(s["project"]), s["folder"].lower()))
    return out


# ------------------------------------------------------------------ writing

# Characters an XML 1.0 file may not hold, whatever a sheet's data has in it.
_XML_ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _xq(text) -> str:
    return (_XML_ILLEGAL.sub("", str(text)).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _col(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


_EPOCH = _dt.date(1899, 12, 30)
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _cell(ref: str, value, style: int = 0) -> str:
    st = f' s="{style}"' if style else ""
    if value is None or value == "":
        return f'<c r="{ref}"{st}/>' if style else ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}"{st}><v>{value}</v></c>'
    return f'<c r="{ref}" t="inlineStr"{st}><is><t xml:space="preserve">{_xq(value)}</t></is></c>'


def write_xlsx(path: str, rows: list[list], columns: list | None = None) -> str:
    """Write `rows` under the master's header, or under `columns` if given. In the
    master's layout column G (Full Date) takes ISO 'YYYY-MM-DD' strings and is
    stored as a real Excel date, shown dd/mm/yyyy."""
    master = columns is None
    heads = COLUMNS if master else columns
    widths = [18, 10, 8, 10, 8, 10, 12, 12, 24, 30, 50, 8, 9, 22, 16, 30] if master else [18] * len(heads)
    sheet_rows = ['<row r="1">' + "".join(
        _cell(f"{_col(i)}1", h, 1) for i, h in enumerate(heads)) + "</row>"]
    for n, row in enumerate(rows, start=2):
        cells = []
        for i, v in enumerate(list(row)[:len(heads)]):
            if master and i == 6 and isinstance(v, str) and _ISO_DATE.match(v):
                d = _dt.date.fromisoformat(v)
                cells.append(_cell(f"G{n}", (d - _EPOCH).days, 2))
            else:
                cells.append(_cell(f"{_col(i)}{n}", v))
        sheet_rows.append(f'<row r="{n}">' + "".join(cells) + "</row>")
    cols = "".join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>'
                   for i, w in enumerate(widths))
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" '
             'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
             f"<cols>{cols}</cols><sheetData>{''.join(sheet_rows)}</sheetData></worksheet>")
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>'
              '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
              '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
              '<fills count="2"><fill><patternFill patternType="none"/></fill>'
              '<fill><patternFill patternType="gray125"/></fill></fills>'
              '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
              '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
              '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
              '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
              '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
              '</cellXfs></styleSheet>')
    files = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '</Types>'),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>'),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheets><sheet name="{"Event Schedule" if master else "Report"}" sheetId="1" r:id="rId1"/></sheets></workbook>'),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '</Relationships>'),
        "xl/worksheets/sheet1.xml": sheet,
        "xl/styles.xml": styles,
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
    return path


# ---------------------------------------------------------------- structure

def make_structure(job: str, session: str, cams: int = 3) -> str:
    """Empty folders laid out like a structure zip, in a new working folder:
    ``<job>/<session>/Clips for Insert/Cam-01 …`` (just ``<job>/<session>`` for
    no cameras). Returns the working folder, to be loaded as the template."""
    job, session = naming.sanitize(job.strip()), naming.sanitize(session.strip())
    if not PROJECT_DIR_RE.match(job):
        raise ValueError(f"“{job}” is not a job folder name (NNNN Dt-DD Mon YYYY).")
    if not naming.DATE_TOKEN_RE.search(session):
        raise ValueError(f"“{session}” has no Dt- date.")
    cams = int(cams or 0)
    if not 0 <= cams <= 20:
        raise ValueError("Camera folders must be between 0 and 20.")
    root = Path(tempfile.mkdtemp(prefix="vingest-schedule-"))
    folder = root / job / session
    folder.mkdir(parents=True)
    for n in range(1, cams + 1):
        (folder / naming.CLIPS_DIRNAME / naming.cam_folder(n)).mkdir(parents=True)
    return str(root)


# ------------------------------------------------------------------ finding

def _job_folders(root: Path, number: str):
    """Job folders numbered `number` at a drive's top level or one level down
    (``M:/3058 Dt-03 Nov 2026`` or ``M:/AV 2026/3058 Dt-03 Nov 2026``)."""
    def numbered(folder: Path):
        try:
            children = sorted(c for c in folder.iterdir() if c.is_dir() and not c.name.startswith("."))
        except OSError:
            return []
        return [c for c in children if (m := PROJECT_DIR_RE.match(c.name)) and m.group(1) == number], children

    found, children = numbered(root) or ([], [])
    if found:
        return found
    for child in children:
        if PROJECT_DIR_RE.match(child.name) or _is_cam_folder(child.name):
            continue
        deeper = numbered(child)
        if deeper and deeper[0]:
            return deeper[0]
    return []


def find_sessions(roots: list, job: str, session: str) -> list[dict]:
    """The copies of one session folder across `roots` (the connected drives):
    the job folder numbered like `job`, and inside it the session matching
    `session` — by name (ignoring Dur-/Clips- and a leading index), else by its
    Formal M/E marker, else by its Informal number, else the job's only session.
    Returns [{root, job_path, session_path}], one per drive that has it."""
    m = PROJECT_DIR_RE.match(job or "")
    if not m:
        raise ValueError(f"“{job}” is not a job folder name (NNNN Dt-DD Mon YYYY).")
    number = m.group(1)
    want_key = structure._session_key(session)
    _, want_tag = structure._date_and_tag(session)
    want_num = _session_number(session)
    out = []
    for root in roots or []:
        r = Path(root)
        if not r.is_dir():
            continue
        for job_path in _job_folders(r, number):
            try:
                sessions = [c for c in sorted(job_path.iterdir())
                            if c.is_dir() and not c.name.startswith(".") and not _is_cam_folder(c.name)]
            except OSError:
                continue
            pick = next((c for c in sessions if structure._session_key(c.name) == want_key), None)
            if pick is None and want_tag:
                pick = next((c for c in sessions if structure._date_and_tag(c.name)[1] == want_tag), None)
            if pick is None and want_num is not None:
                pick = next((c for c in sessions if _session_number(c.name) == want_num), None)
            if pick is None and len(sessions) == 1:
                pick = sessions[0]
            if pick is not None:
                out.append({"root": str(r), "job_path": str(job_path), "session_path": str(pick)})
                break
    return out

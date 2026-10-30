"""Event schedule -> master sheet: reading Word/Excel/CSV schedules, scanning a
drive for durations, and writing the .xlsx.

    python3 -m pytest tests/ -q          (from the project root)
"""

import sys
import wave
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from vingest import master_sheet, server, verify_csv  # noqa: E402


def make_wav(path: Path, seconds: int) -> Path:
    """A silent WAV: its duration is read from the header, no ffmpeg needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(800)
        w.writeframes(b"\x80" * 800 * seconds)
    return path


def make_docx(path: Path, body: str) -> Path:
    """The smallest .docx Word opens: one document.xml holding `body`."""
    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("word/document.xml", f"<w:document {ns}><w:body>{body}</w:body></w:document>")
    return path


def p(text):
    return f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"


def tc(text, merge=None):
    props = f'<w:tcPr><w:vMerge{"" if merge == "continue" else " w:val=" + chr(34) + "restart" + chr(34)}/></w:tcPr>' \
        if merge else ""
    return f"<w:tc>{props}{p(text) if text else '<w:p/>'}</w:tc>"


def test_docx_schedule_reads_paragraphs_and_table_rows_in_order(tmp_path):
    doc = make_docx(tmp_path / "schedule.docx",
                    p("Satsang Schedule 21 to 22 Oct 2026, Bhadran")
                    + "<w:tbl>"
                    + f"<w:tr>{tc('21st Oct, Wed')}{tc('MBA Shibir')}{tc('Bhadran', 'restart')}</w:tr>"
                    + f"<w:tr>{tc('22nd Oct, Thu')}{tc('MBA Shibir')}{tc('', 'continue')}</w:tr>"
                    + "</w:tbl>")
    rows = master_sheet.read_table(str(doc))
    assert rows[0] == ["Satsang Schedule 21 to 22 Oct 2026, Bhadran"]
    assert rows[1] == ["21st Oct, Wed", "MBA Shibir", "Bhadran"]
    # A vertically merged cell repeats the place it continues.
    assert rows[2] == ["22nd Oct, Thu", "MBA Shibir", "Bhadran"]


def test_csv_schedule_drops_blank_rows(tmp_path):
    f = tmp_path / "s.csv"
    f.write_text("Date,Programme,Time\n15/08/2026,General Satsang,9 - 10 PM\n,,\n", encoding="utf-8")
    assert master_sheet.read_table(str(f)) == [
        ["Date", "Programme", "Time"], ["15/08/2026", "General Satsang", "9 - 10 PM"]]


def test_scan_reports_tag_number_duration_clips_and_cameras(tmp_path):
    job = tmp_path / "3017 Dt-16 Aug 2026"
    formal = job / "Adalaj Soneri General Satsang E. Dt-16-Aug-26 Dur-1m5s"
    make_wav(formal / "Adalaj Soneri General Satsang E. Dt-16-Aug-26.wav", 60)
    make_wav(formal / "Clips for Insert" / "Cam-01" / "a.wav", 2)
    make_wav(formal / "Clips for Insert" / "Cam-02" / "b.wav", 3)
    (formal / "Clips for Insert" / "Cam-03").mkdir(parents=True)          # empty: not counted
    informal = tmp_path / "2600 Dt-23 Aug 2026" / "02 Gnanvidhi Informal Dt-23-Aug-26"
    make_wav(informal / "Cam-01" / "c.wav", 4)

    found = {s["project"]: s for s in master_sheet.scan(str(tmp_path))}
    f = found["3017"]
    assert (f["tag"], f["clips"], f["cams"], round(f["seconds"])) == ("E", 3, 2, 65)
    assert f["date"] == "2026-08-16"
    i = found["2600"]
    assert (i["number"], i["clips"], i["cams"]) == (2, 1, 1)


def test_xlsx_has_master_header_real_dates_and_continuation_rows(tmp_path):
    rows = [
        ["DD-F-HD-3050-E", 3050, "HD", "E", "DD", "Formal", "2026-10-17", "1h 41m 3s",
         "General", "Dadanagar Hall", "Live Garba", 1, 8, "Navratri", "Gujarati"],
        ["", "", "", "", "", "", "", "", "", "", "", "", "", "Garba", ""],
    ]
    out = master_sheet.write_xlsx(str(tmp_path / "m.xlsx"), rows)
    back = verify_csv._read_xlsx_rows(out)
    assert back[0] == master_sheet.COLUMNS
    assert back[1][0] == "DD-F-HD-3050-E" and back[1][1] == "3050"
    # Excel serial for 17 Oct 2026, stored with a date format.
    assert back[1][6] == "46312"
    assert back[2][13] == "Garba" and not any(back[2][:13])
    with zipfile.ZipFile(out) as z:
        assert 's="2"' in z.read("xl/worksheets/sheet1.xml").decode()


def test_rpc_methods_are_registered():
    for name in ("schedule_read_table", "schedule_scan", "schedule_write"):
        assert name in server.METHODS

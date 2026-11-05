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
    # Formal: the master alone, like the folder's Dur- and Clips-NN; the camera
    # clips are inserts. Cameras still count every cam folder holding a clip.
    assert (f["tag"], f["clips"], f["cams"], round(f["seconds"])) == ("E", 1, 2, 60)
    assert f["date"] == "2026-08-16"
    i = found["2600"]
    # Informal: every clip in the session.
    assert (i["number"], i["clips"], i["cams"], round(i["seconds"])) == (2, 1, 1, 4)


def test_make_structure_lays_out_folders_like_a_structure_zip(tmp_path):
    from vingest import structure
    root = master_sheet.make_structure(
        "3062 Dt-21 Oct 2026",
        "01 Bhadran MBA - Bhaio Shibir General Satsang M. Dt-21-Oct-26", 3)
    found = structure.detect_all(root, probe_masters=False)
    assert len(found) == 1
    d = found[0]
    assert d.job_name == "3062 Dt-21 Oct 2026"
    assert d.session_name.startswith("01 Bhadran") and d.session_date == "2026-10-21"
    assert sorted(d.cams) == ["1", "2", "3"] and d.is_template
    # No cameras: just the session folder, still found by its Dt- date.
    bare = structure.detect_all(master_sheet.make_structure(
        "2625 Dt-23 Aug 2026", "Adalaj Gurupurnima Darshan Dt-23-Aug-26", 0), probe_masters=False)
    assert bare[0].session_name == "Adalaj Gurupurnima Darshan Dt-23-Aug-26" and not bare[0].cams


def test_make_structure_refuses_names_the_drive_scan_could_not_read():
    import pytest
    with pytest.raises(ValueError):
        master_sheet.make_structure("Job", "Session Dt-23-Aug-26", 1)
    with pytest.raises(ValueError):
        master_sheet.make_structure("2625 Dt-23 Aug 2026", "Session without a date", 1)


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
        # Shown the Indian way, dd/mm/yyyy.
        assert 'formatCode="dd/mm/yyyy"' in z.read("xl/styles.xml").decode()


def test_rpc_methods_are_registered():
    for name in ("schedule_read_table", "schedule_scan", "schedule_write", "schedule_structure"):
        assert name in server.METHODS


def test_find_sessions_finds_each_ssds_copy_by_name_or_marker(tmp_path):
    # The session on two SSDs: one at the drive's top, one a level down, and one
    # copy already carrying its Dur- token. A third drive doesn't have it.
    name = "Valsad Trimandir Ground Breaking Ceremony M. Dt-03-Nov-26"
    m = tmp_path / "M" / "3058 Dt-03 Nov 2026" / f"{name} Dur-1h48m"
    g = tmp_path / "G" / "AV 2026" / "3058 Dt-03 Nov 2026" / name
    for p in (m, g, tmp_path / "M" / "3058 Dt-03 Nov 2026" / "Valsad Gnanvidhi E. Dt-03-Nov-26",
              tmp_path / "D" / "3057 Dt-25 Oct 2026" / "Bhadran Shibir M. Dt-25-Oct-26"):
        p.mkdir(parents=True)
    roots = [str(tmp_path / d) for d in ("M", "G", "D")]
    found = master_sheet.find_sessions(roots, "3058 Dt-03 Nov 2026", name)
    assert [f["session_path"] for f in found] == [str(m), str(g)]
    # Renamed since the schedule drafted it: still found by its M marker.
    found = master_sheet.find_sessions(roots, "3058 Dt-03 Nov 2026", "Valsad Khatmuhurt M. Dt-03-Nov-26")
    assert [f["session_path"] for f in found] == [str(m), str(g)]
    assert server.METHODS["schedule_find_sessions"]

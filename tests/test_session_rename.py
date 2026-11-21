"""Renaming a backed-up session folder to an event schedule row's name."""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from vingest import organize, server  # noqa: E402


def touch(p):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("x")


def test_formal_folder_and_masters_take_the_row_name_but_a_shared_job_folder_stays(tmp_path):
    job = tmp_path / "3068 Dt-21 Nov 2026"
    s = job / "02 Anand JJ Old Topic E. Dt-21-Nov-26 Dur-1h41m Clips-02"
    touch(s / "Anand JJ Old Topic E. Dt-21-Nov-26 Dur-46m41s Clip-02.mp4")
    touch(s / "Anand JJ Pujyashree's Entry E. Dt-21-Nov-26 Dur-3m6s Clip-01.mp4")
    touch(s / "Clips for Insert" / "Cam-01" / "C0001.MP4")
    (job / "01 Anand JJ Morning M. Dt-21-Nov-26").mkdir()
    plan = organize.plan_session_rename(str(s), "02 Anand JJ General Satsang E. Dt-21-Nov-26",
                                        "3099 Dt-21 Nov 2026")
    assert plan["new_name"] == "02 Anand JJ General Satsang E. Dt-21-Nov-26 Dur-1h41m Clips-02"
    assert [os.path.basename(f["new_path"]) for f in plan["files"]] == [
        "Anand JJ General Satsang E. Dt-21-Nov-26 Dur-46m41s Clip-02.mp4"]
    assert len(plan["folders"]) == 1          # the job folder holds another session
    assert any("other sessions" in n for n in plan["notes"])
    assert organize.apply_rename(plan)["errors"] == []
    assert Path(plan["final_path"]).is_dir()
    assert (Path(plan["final_path"]) / "Clips for Insert" / "Cam-01" / "C0001.MP4").exists()


def test_a_lone_informal_session_renames_its_clips_and_job_folder(tmp_path):
    s = tmp_path / "2627 Dt-18 Nov 2026" / "Anand JJ Pujyashree's Ground Visit Dt-18-Nov-26 Clips-36"
    touch(s / "Cam-01" / "Cam-01 Anand JJ Pujyashree's Ground Visit Clip-001.MP4")
    plan = organize.plan_session_rename(str(s), "Anand JJ Ground Dt-18-Nov-26", "2628 Dt-18 Nov 2026")
    assert organize.apply_rename(plan)["errors"] == []
    final = Path(plan["final_path"])
    assert final == tmp_path / "2628 Dt-18 Nov 2026" / "Anand JJ Ground Dt-18-Nov-26 Clips-36"
    assert (final / "Cam-01" / "Cam-01 Anand JJ Ground Clip-001.MP4").exists()


def test_an_existing_target_stops_the_plan(tmp_path):
    job = tmp_path / "3068 Dt-21 Nov 2026"
    s = job / "Anand Old E. Dt-21-Nov-26"
    s.mkdir(parents=True)
    (job / "Anand New E. Dt-21-Nov-26").mkdir()
    with pytest.raises(ValueError, match="already there"):
        organize.plan_session_rename(str(s), "Anand New E. Dt-21-Nov-26")


def test_engine_methods_are_registered():
    assert "plan_session_rename" in server.METHODS and "apply_session_rename" in server.METHODS

"""Renaming a backed-up session folder to an event schedule row's name."""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from vingest import organize, server  # noqa: E402


def touch(p, mtime=None):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("x")
    if mtime is not None:
        os.utime(p, (mtime, mtime))


def names(folder):
    return sorted(str(p.relative_to(folder)) for p in Path(folder).rglob("*") if p.is_file())


def test_formal_masters_and_ceremony_master_follow_and_the_session_moves_out_of_a_shared_job(tmp_path):
    job = tmp_path / "3068 Dt-21 Nov 2026"
    s = job / "02 Anand JJ Old Topic E. Dt-21-Nov-26 Dur-1h41m Clips-02"
    touch(s / "Anand JJ Old Topic E. Dt-21-Nov-26 Dur-46m41s Clip-02.mp4")
    touch(s / "Anand JJ Pujyashree's Entry E. Dt-21-Nov-26 Dur-3m6s Clip-01.mp4")
    touch(s / "Clips for Insert" / "Cam-01" / "C0001.MP4")
    (job / "01 Anand JJ Morning M. Dt-21-Nov-26").mkdir()
    plan = organize.plan_session_rename(str(s), "01 Anand JJ General Satsang M. Dt-22-Nov-26",
                                        "3069 Dt-22 Nov 2026")
    assert plan["new_name"] == "01 Anand JJ General Satsang M. Dt-22-Nov-26 Dur-1h41m Clips-02"
    assert plan["make_dirs"] == [str(tmp_path / "3069 Dt-22 Nov 2026")]
    assert plan["remove_if_empty"] == []           # 3068 keeps its other session
    r = organize.apply_session_rename(plan)
    assert r["errors"] == []
    final = tmp_path / "3069 Dt-22 Nov 2026" / plan["new_name"]
    assert Path(plan["final_path"]) == final
    assert names(final) == sorted([
        "Anand JJ General Satsang M. Dt-22-Nov-26 Dur-46m41s Clip-02.mp4",
        "Anand JJ Pujyashree's Entry M. Dt-22-Nov-26 Dur-3m6s Clip-01.mp4",
        os.path.join("Clips for Insert", "Cam-01", "C0001.MP4"),
    ])
    assert (job / "01 Anand JJ Morning M. Dt-21-Nov-26").is_dir()


def test_a_session_moves_into_the_rows_existing_job_and_the_emptied_job_is_removed(tmp_path):
    old_job = tmp_path / "3068 Dt-21 Nov 2026"
    s = old_job / "Anand JJ Old E. Dt-21-Nov-26"
    touch(s / "Anand JJ Old E. Dt-21-Nov-26 Dur-5m.mp4")
    touch(old_job / "Thumbs.db")
    target = tmp_path / "3069 Dt-22 Nov 2026"
    (target / "02 Anand JJ Evening E. Dt-22-Nov-26").mkdir(parents=True)
    plan = organize.plan_session_rename(str(s), "01 Anand JJ Morning M. Dt-22-Nov-26", "3069 Dt-22 Nov 2026")
    assert plan["make_dirs"] == [] and plan["remove_if_empty"] == [str(old_job)]
    r = organize.apply_session_rename(plan)
    assert r["errors"] == [] and r["removed"] == ["3068 Dt-21 Nov 2026"]
    assert not old_job.exists()
    assert (target / "01 Anand JJ Morning M. Dt-22-Nov-26" /
            "Anand JJ Morning M. Dt-22-Nov-26 Dur-5m.mp4").exists()


def test_a_lone_session_renames_its_job_folder(tmp_path):
    s = tmp_path / "2627 Dt-18 Nov 2026" / "Anand JJ Pujyashree's Ground Visit Dt-18-Nov-26 Clips-02"
    touch(s / "Cam-01" / "Cam-01 Anand JJ Pujyashree's Ground Visit Clip-001.MP4", 100)
    touch(s / "Cam-01" / "Cam-01 Anand JJ Pujyashree's Ground Visit Clip-002.MP4", 200)
    plan = organize.plan_session_rename(str(s), "Anand JJ Ground Dt-18-Nov-26", "2628 Dt-18 Nov 2026")
    assert organize.apply_session_rename(plan)["errors"] == []
    final = tmp_path / "2628 Dt-18 Nov 2026" / "Anand JJ Ground Dt-18-Nov-26 Clips-02"
    assert Path(plan["final_path"]) == final
    assert names(final) == [os.path.join("Cam-01", "Cam-01 Anand JJ Ground Clip-001.MP4"),
                            os.path.join("Cam-01", "Cam-01 Anand JJ Ground Clip-002.MP4")]


def test_informal_renames_every_clip_in_every_cam_folder_by_date(tmp_path):
    # Named from another clip base, a hand-copied camera name, and a late clip
    # with an earlier time: all take the backup's naming, numbered by date.
    s = tmp_path / "2629 Dt-21 Nov 2026" / "Anand JJ Dimplebhai's Experience Session Dt-21-Nov-26 Clips-04"
    touch(s / "Cam-01" / "Cam-01 Anand JJ Dimplebhai's Experiennce Session Clip-001.MP4", 200)
    touch(s / "Cam-01" / "C0007.MP4", 100)
    touch(s / "Cam-02 (Audio)" / "Cam-02 Anand JJ Dimplebhai's Experiennce Session Clip-001.WAV", 100)
    touch(s / "Cam-02 (Audio)" / "ZOOM0002.WAV", 300)
    touch(s / "Cam-02 (Audio)" / "ZOOM0003.WAV", 400)
    plan = organize.plan_session_rename(str(s), "Anand JJ Darshan Dt-21-Nov-26")
    assert plan["new_name"] == "Anand JJ Darshan Dt-21-Nov-26 Clips-05"     # re-tallied
    assert organize.apply_session_rename(plan)["errors"] == []
    assert names(plan["final_path"]) == sorted([
        os.path.join("Cam-01", "Cam-01 Anand JJ Darshan Clip-001.MP4"),      # C0007, older
        os.path.join("Cam-01", "Cam-01 Anand JJ Darshan Clip-002.MP4"),
        os.path.join("Cam-02 (Audio)", "Cam-02 Anand JJ Darshan Clip-001.WAV"),
        os.path.join("Cam-02 (Audio)", "Cam-02 Anand JJ Darshan Clip-002.WAV"),
        os.path.join("Cam-02 (Audio)", "Cam-02 Anand JJ Darshan Clip-003.WAV"),
    ])


def test_an_informal_sessions_only_clip_in_root_takes_no_number(tmp_path):
    s = tmp_path / "2630 Dt-22 Nov 2026" / "Anand JJ Old Dt-22-Nov-26"
    touch(s / "DJI_0001.MP4")
    plan = organize.plan_session_rename(str(s), "Anand JJ Bhakti Dt-22-Nov-26")
    organize.apply_session_rename(plan)
    assert names(plan["final_path"]) == ["Anand JJ Bhakti.MP4"]


def test_an_existing_target_stops_the_plan(tmp_path):
    job = tmp_path / "3068 Dt-21 Nov 2026"
    s = job / "Anand Old E. Dt-21-Nov-26"
    s.mkdir(parents=True)
    (job / "Anand New E. Dt-21-Nov-26").mkdir()
    with pytest.raises(ValueError, match="already there"):
        organize.plan_session_rename(str(s), "Anand New E. Dt-21-Nov-26")


def test_engine_methods_are_registered():
    assert "plan_session_rename" in server.METHODS and "apply_session_rename" in server.METHODS

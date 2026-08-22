"""Regression tests for the naming, pairing, planning and comparison logic.

    python3 -m pytest tests/ -q          (from the project root)
"""

import datetime as dt
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from vingest import compare, ingest, naming, probe, sources, structure  # noqa: E402
import zipfile  # noqa: E402

HAVE_FFMPEG = shutil.which("ffmpeg") is not None and probe.configure().get("ffprobe")
needs_ffmpeg = pytest.mark.skipif(not HAVE_FFMPEG, reason="ffmpeg/ffprobe not installed")


def make_clip(path: Path, seconds: int) -> Path:
    """A real, probeable video file — the Dur- token has to come from somewhere."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", f"testsrc=size=160x120:rate=25:duration={seconds}",
         "-c:v", "libx264", "-preset", "ultrafast", "-t", str(seconds), str(path)],
        check=True, capture_output=True)
    return path

REFERENCE_TITLE = ("Adalaj Soneri Satsang Experience session of USA and Canada "
                   "Satsang Trip, General Satsang E.")
REFERENCE_FOLDER = REFERENCE_TITLE + " Dt-16-Aug-26 Dur-54m1s"


class TestDuration:
    @pytest.mark.parametrize("seconds,expected", [
        (3241.9, "54m1s"), (3241, "54m1s"), (134, "2m14s"), (48, "48s"),
        (7384, "2h3m4s"), (0, "0s"), (60, "1m0s"), (3600, "1h0m0s"),
    ])
    def test_format(self, seconds, expected):
        assert naming.fmt_duration(seconds) == expected

    def test_truncates_rather_than_rounds(self):
        # 54m1.9s must read 54m1s, matching the reference folder.
        assert naming.fmt_duration(3241.99) == "54m1s"

    def test_roundtrip(self):
        for s in (0, 1, 59, 60, 3599, 3600, 7384, 3241):
            assert naming.parse_duration(naming.fmt_duration(s)) == s

    def test_none_is_blank(self):
        assert naming.fmt_duration(None) == ""


class TestNaming:
    def test_reproduces_the_reference_folder_exactly(self):
        assert naming.build_session_folder(
            REFERENCE_TITLE, dt.date(2026, 8, 16), 3241.9) == REFERENCE_FOLDER

    def test_job_folder(self):
        assert naming.build_job_folder("3017", dt.date(2026, 8, 16)) == "3017 Dt-16 Aug 2026"

    def test_trailing_period_in_title_survives(self):
        assert "Satsang E. Dt-" in naming.build_session_folder(
            REFERENCE_TITLE, dt.date(2026, 8, 16), 10)

    def test_typed_date_wins_over_the_generated_one(self):
        # The operator typed Dt- themselves; we must not add a second token.
        out = naming.build_session_folder(
            REFERENCE_TITLE + " Dt-16-Aug-26", dt.date(2020, 1, 1), 3241.9)
        assert out == REFERENCE_FOLDER
        assert out.count("Dt-") == 1

    def test_folder_naming_is_idempotent(self):
        once = naming.build_session_folder(REFERENCE_TITLE, dt.date(2026, 8, 16), 3241.9)
        twice = naming.build_session_folder(once, dt.date(2026, 8, 16), 3241.9)
        assert once == twice == REFERENCE_FOLDER

    def test_duration_change_replaces_rather_than_appends(self):
        out = naming.build_session_folder(REFERENCE_FOLDER, dt.date(2026, 8, 16), 3300)
        assert out.count("Dur-") == 1 and out.endswith("Dur-55m0s")

    def test_add_date_can_be_switched_off(self):
        assert naming.build_session_folder(
            REFERENCE_TITLE, dt.date(2026, 8, 16), 3241.9, add_date=False) \
            == REFERENCE_TITLE + " Dur-54m1s"

    def test_illegal_characters_are_replaced(self):
        out = naming.build_session_folder('bad/name:with*chars?', dt.date(2026, 8, 16), 5)
        assert not any(c in out for c in '/:*?"<>|')

    def test_windows_reserved_names(self):
        assert naming.sanitize("CON.mov").startswith("_")

    def test_parse_date_token(self):
        assert naming.parse_date_token(REFERENCE_FOLDER) == dt.date(2026, 8, 16)

    def test_dedupe_is_case_insensitive(self):
        # exFAT SSDs are case-insensitive; 'A.MOV' and 'a.mov' collide.
        assert naming.dedupe("a.mov", {"A.MOV"}) == "a (2).mov"
        assert naming.dedupe("a.mov", {"A.MOV", "a (2).MOV"}) == "a (3).mov"

    def test_cam_folder(self):
        assert naming.cam_folder(1) == "Cam-01"
        assert naming.cam_folder(12) == "Cam-12"


class TestPairing:
    def _f(self, path, duration, mtime):
        return {"path": path, "duration": duration, "mtime": mtime}

    def test_matches_on_stem(self):
        a = [self._f("/pr/C0031.mov", 9.0, 100), self._f("/pr/C0032.mov", 5.0, 200)]
        b = [self._f("/h2/C0032.mov", 5.0, 100), self._f("/h2/C0031.mov", 9.0, 200)]
        r = ingest.pair_sources(a, b)
        assert r["matches"]["/pr/C0031.mov"] == "/h2/C0031.mov"
        assert r["matches"]["/pr/C0032.mov"] == "/h2/C0032.mov"
        assert not r["unmatched_primary"]

    def test_matches_already_renamed_files(self):
        a = [self._f("/pr/C0031 Dt-16-Aug-26 Dur-9s.mov", 9.0, 100)]
        b = [self._f("/h2/C0031.mov", 9.0, 100)]
        assert ingest.pair_sources(a, b)["matches"]

    def test_falls_back_to_duration_and_time(self):
        a = [self._f("/pr/A001.mov", 9.0, 1000)]
        b = [self._f("/h2/XYZ9.mov", 9.2, 1060)]
        assert ingest.pair_sources(a, b)["matches"]["/pr/A001.mov"] == "/h2/XYZ9.mov"

    def test_refuses_a_distant_match(self):
        a = [self._f("/pr/A001.mov", 9.0, 1000)]
        b = [self._f("/h2/XYZ9.mov", 9.0, 1000 + 4000)]   # hours apart
        r = ingest.pair_sources(a, b)
        assert r["unmatched_primary"] == ["/pr/A001.mov"]

    def test_refuses_a_different_duration(self):
        a = [self._f("/pr/A001.mov", 9.0, 1000)]
        b = [self._f("/h2/XYZ9.mov", 30.0, 1000)]
        assert ingest.pair_sources(a, b)["unmatched_primary"]

    def test_no_double_booking(self):
        a = [self._f("/pr/A.mov", 9.0, 1000), self._f("/pr/B.mov", 9.0, 1001)]
        b = [self._f("/h2/X.mov", 9.0, 1000)]
        r = ingest.pair_sources(a, b)
        assert len(r["matches"]) == 1 and len(r["unmatched_primary"]) == 1


class TestCompare:
    def _snap(self, files):
        return {"root": "/x", "dirs": [], "files": files}

    def _entry(self, name, size, duration, codec, declared=None):
        return {"name": name, "rel": name, "ext": Path(name).suffix.lower(),
                "size": size, "mtime": 0,
                "duration": duration, "codec": codec, "declared_duration": declared}

    def test_mov_and_mp4_of_the_same_shot_pair_up(self):
        # The drives often use different containers; that must not read as missing.
        a = self._snap({"c0031": self._entry("C0031.mov", 5_000_000, 9.0, "prores")})
        b = self._snap({"c0031": self._entry("C0031.mp4", 80_000, 9.0, "h265")})
        r = compare.compare([a, b])
        assert r["ok"] and not r["pairs"][0]["missing_from_other"]
        assert any(i["field"] == "extension"
                   for m in r["pairs"][0]["mismatched"] for i in m["issues"])

    def test_same_footage_different_codec_is_not_an_error(self):
        a = self._snap({"m.mov": self._entry("m.mov", 50_000_000, 64.0, "prores")})
        b = self._snap({"m.mov": self._entry("m.mov", 780_000, 64.0, "h265")})
        r = compare.compare([a, b])
        assert r["ok"], "a ProRes/H.265 size difference is expected, not a fault"
        assert r["pairs"][0]["mismatched"][0]["info_only"]

    def test_same_codec_size_difference_is_an_error(self):
        a = self._snap({"m.mov": self._entry("m.mov", 50_000_000, 64.0, "prores")})
        b = self._snap({"m.mov": self._entry("m.mov", 40_000_000, 64.0, "prores")})
        assert not compare.compare([a, b])["ok"]

    def test_duration_difference_is_an_error(self):
        a = self._snap({"m.mov": self._entry("m.mov", 100, 64.0, "prores")})
        b = self._snap({"m.mov": self._entry("m.mov", 100, 61.0, "h265")})
        assert not compare.compare([a, b])["ok"]

    def test_missing_file_is_reported(self):
        a = self._snap({"m.mov": self._entry("m.mov", 100, 64.0, "prores"),
                        "c.mov": self._entry("c.mov", 50, 9.0, "prores")})
        b = self._snap({"m.mov": self._entry("m.mov", 100, 64.0, "h265")})
        pair = compare.compare([a, b])["pairs"][0]
        assert [f["name"] for f in pair["missing_from_other"]] == ["c.mov"]

    def test_name_that_lies_about_its_duration_is_caught(self):
        a = self._snap({"m.mov": self._entry("m.mov", 100, 64.0, "prores", declared=64)})
        b = self._snap({"m.mov": self._entry("m.mov", 100, 64.0, "h265", declared=99)})
        assert not compare.compare([a, b])["ok"]

    def test_needs_two_sources(self):
        assert "error" in compare.compare([self._snap({})])


class TestPlan:
    def test_media_filenames_are_never_changed(self, tmp_path):
        """The core contract: files arrive named correctly and stay that way."""
        src = tmp_path / "SSD"
        src.mkdir()
        originals = ["Master Take 01.mov", "C0031.MP4", "weird name (2).mxf"]
        for n in originals:
            (src / n).write_bytes(b"x" * 100)

        plan = ingest.build_plan({
            "title": REFERENCE_TITLE, "job_number": "3017", "date": "2026-08-16",
            "mode": "copy", "verify": "size",
            "targets": [{"role": "prores", "source_root": str(src),
                         "dest_root": str(tmp_path / "out"),
                         "master": str(src / "Master Take 01.mov"),
                         "cams": {"1": [str(src / "C0031.MP4")],
                                  "2": [str(src / "weird name (2).mxf")]}}],
        })
        clips = [i for i in plan["targets"][0]["items"] if i["kind"] == "clip"]
        landed = {Path(i["dst"]).name for i in clips}
        assert landed == {"C0031.MP4", "weird name (2).mxf"}, \
            "cam clip names must survive the copy untouched"
        for item in clips:
            assert "Dur-" not in Path(item["dst"]).name
            assert "Dt-" not in Path(item["dst"]).name

    @needs_ffmpeg
    def test_only_the_session_folder_carries_the_tokens(self, tmp_path):
        src = tmp_path / "SSD"; src.mkdir()
        make_clip(src / "M.mov", 65)
        plan = ingest.build_plan({
            "title": REFERENCE_TITLE, "job_number": "3017", "date": "2026-08-16",
            "mode": "copy", "targets": [{
                "role": "prores", "source_root": str(src), "dest_root": str(tmp_path / "o"),
                "master": str(src / "M.mov"), "cams": {}}]})
        t = plan["targets"][0]
        assert t["session_folder"].endswith("Dt-16-Aug-26 Dur-1m5s")
        assert "Dur-" not in t["job_folder"]          # job folder uses the spaced date only
        # A lone master is renamed after the folder and shares its duration.
        assert Path(t["items"][0]["dst"]).name == \
            REFERENCE_TITLE + " Dt-16-Aug-26 Dur-1m5s.mov"

    @needs_ffmpeg
    def test_duration_comes_from_the_master_not_the_clips(self, tmp_path):
        src = tmp_path / "SSD"; src.mkdir()
        make_clip(src / "MASTER.mov", 65)
        make_clip(src / "C0031.mov", 3)
        plan = ingest.build_plan({
            "title": "T", "date": "2026-08-16", "mode": "copy", "targets": [{
                "role": "prores", "source_root": str(src), "dest_root": str(tmp_path / "o"),
                "master": str(src / "MASTER.mov"),
                "cams": {"1": [str(src / "C0031.mov")]}}]})
        assert plan["targets"][0]["session_folder"].endswith("Dur-1m5s")

    def test_unreadable_master_warns_instead_of_guessing(self, tmp_path):
        src = tmp_path / "SSD"; src.mkdir()
        (src / "M.mov").write_bytes(b"not actually video")
        plan = ingest.build_plan({
            "title": REFERENCE_TITLE, "date": "2026-08-16", "mode": "copy", "targets": [{
                "role": "prores", "source_root": str(src), "dest_root": str(tmp_path / "o"),
                "master": str(src / "M.mov"), "cams": {}}]})
        assert "Dur-" not in plan["targets"][0]["session_folder"]
        assert any("Dur-" in w for w in plan["warnings"]), "a missing duration must be surfaced"

    def test_same_name_from_two_cams_does_not_overwrite(self, tmp_path):
        # Two bodies both writing C0001.mov into one cam folder must both survive.
        src = tmp_path / "SSD"; src.mkdir()
        (src / "a").mkdir(); (src / "b").mkdir()
        (src / "a" / "C0001.mov").write_bytes(b"x")
        (src / "b" / "C0001.mov").write_bytes(b"y")
        (src / "M.mov").write_bytes(b"m")
        plan = ingest.build_plan({
            "title": "T", "date": "2026-08-16", "mode": "copy", "targets": [{
                "role": "prores", "source_root": str(src), "dest_root": str(tmp_path / "o"),
                "master": str(src / "M.mov"),
                "cams": {"1": [str(src / "a" / "C0001.mov"), str(src / "b" / "C0001.mov")]}}]})
        names = [Path(i["dst"]).name for i in plan["targets"][0]["items"] if i["kind"] == "clip"]
        assert names == ["C0001.mov", "C0001 (2).mov"]
        assert len(set(names)) == 2

    def test_master_and_clips_land_in_the_right_folders(self, tmp_path):
        src = tmp_path / "SSD"
        src.mkdir()
        for n in ("MASTER.mov", "C1.mov", "C2.mov"):
            (src / n).write_bytes(b"x" * 100)

        spec = {
            "title": REFERENCE_TITLE, "job_number": "3017", "date": "2026-08-16",
            "mode": "copy", "verify": "size",
            "targets": [{"role": "prores", "source_root": str(src),
                         "dest_root": str(tmp_path / "out"),
                         "master": str(src / "MASTER.mov"),
                         "cams": {"1": [str(src / "C1.mov")],
                                  "2": [str(src / "C2.mov")]}}],
        }
        plan = ingest.build_plan(spec)
        t = plan["targets"][0]
        assert t["job_folder"] == "3017 Dt-16 Aug 2026"
        assert t["session_folder"].startswith(REFERENCE_TITLE)

        master = next(i for i in t["items"] if i["kind"] == "master")
        assert Path(master["dst"]).parent.name == t["session_folder"]
        for item in (i for i in t["items"] if i["kind"] == "clip"):
            parts = Path(item["dst"]).parts
            assert parts[-2] == naming.cam_folder(item["cam"])
            assert parts[-3] == naming.CLIPS_DIRNAME

    def test_two_targets_sharing_a_destination_is_flagged(self, tmp_path):
        src = tmp_path / "SSD"; src.mkdir()
        (src / "M.mov").write_bytes(b"x")
        target = {"role": "prores", "source_root": str(src), "dest_root": str(tmp_path),
                  "master": str(src / "M.mov"), "cams": {}}
        plan = ingest.build_plan({"title": "T", "date": "2026-08-16", "mode": "copy",
                                  "targets": [target, {**target, "role": "h265"}]})
        assert any("collides" in w for w in plan["warnings"])

    def test_execute_then_reexecute_skips(self, tmp_path):
        src = tmp_path / "SSD"; src.mkdir()
        (src / "M.mov").write_bytes(b"payload" * 1000)
        spec = {"title": "T", "date": "2026-08-16", "mode": "copy", "verify": "size",
                "targets": [{"role": "prores", "source_root": str(src),
                             "dest_root": str(tmp_path / "out"),
                             "master": str(src / "M.mov"), "cams": {}}]}
        plan = ingest.build_plan(spec)
        first = ingest.execute_plan(plan)
        assert first["copied"] == 1 and first["failed"] == 0
        # Re-running the SAME plan must skip: the destination is already present,
        # even though the relocated source is now gone from the root.
        second = ingest.execute_plan(plan)
        assert second["failed"] == 0 and second["skipped"] == 1 and second["copied"] == 0

    def test_no_partial_file_is_left_named_as_final(self, tmp_path):
        src = tmp_path / "SSD"; src.mkdir()
        (src / "M.mov").write_bytes(b"z" * (20 * 1024 * 1024))
        spec = {"title": "T", "date": "2026-08-16", "mode": "copy", "verify": "size",
                "targets": [{"role": "prores", "source_root": str(src),
                             "dest_root": str(tmp_path / "out"),
                             "master": str(src / "M.mov"), "cams": {}}]}
        plan = ingest.build_plan(spec)
        res = ingest.execute_plan(plan, should_cancel=lambda: True)
        assert res["cancelled"]
        out = tmp_path / "out"
        leftovers = [p for p in out.rglob("*") if p.is_file()]
        assert not leftovers, f"cancel left files behind: {leftovers}"


class TestStructureDetection:
    """The session folder is read off the drive, never invented."""

    def _house(self, tmp_path, session_name, master_seconds=None):
        job = tmp_path / "3017 Dt-16 Aug 2026"
        session = job / session_name
        for cam in ("Cam-01", "Cam-02", "Cam-03"):
            (session / "Clips for Insert" / cam).mkdir(parents=True)
        if master_seconds:
            make_clip(session / "Program.mov", master_seconds)
        return session

    def test_finds_the_folder_holding_clips_for_insert(self, tmp_path):
        session = self._house(tmp_path, "Some Session Dt-16-Aug-26")
        d = structure.detect(tmp_path, probe_masters=False)
        assert d.session_path == str(session)
        assert d.confidence == "strong"
        assert d.job_name == "3017 Dt-16 Aug 2026"
        assert sorted(d.cams) == ["1", "2", "3"]

    def test_reports_the_name_it_found_without_altering_it(self, tmp_path):
        name = REFERENCE_TITLE + " Dt-16-Aug-26"
        self._house(tmp_path, name)
        d = structure.detect(tmp_path, probe_masters=False)
        assert d.session_name == name
        assert d.base_name == name          # no Dur- to strip yet
        assert d.has_dur is False

    def test_recognises_a_folder_that_already_has_its_token(self, tmp_path):
        self._house(tmp_path, REFERENCE_FOLDER)
        d = structure.detect(tmp_path, probe_masters=False)
        assert d.has_dur and d.current_dur == 3241
        assert d.base_name == REFERENCE_TITLE + " Dt-16-Aug-26"

    def test_falls_back_to_a_dated_folder_name(self, tmp_path):
        (tmp_path / "Some Session Dt-16-Aug-26").mkdir()
        d = structure.detect(tmp_path, probe_masters=False)
        assert d.session_path and d.confidence == "weak"

    def test_says_so_when_nothing_is_recognisable(self, tmp_path):
        (tmp_path / "a").mkdir()
        (tmp_path / "b").mkdir()
        d = structure.detect(tmp_path, probe_masters=False)
        assert d.session_path is None and "by hand" in d.reason

    @needs_ffmpeg
    def test_master_is_the_longest_file_at_the_session_root(self, tmp_path):
        session = self._house(tmp_path, "S Dt-16-Aug-26")
        make_clip(session / "short.mov", 2)
        make_clip(session / "Program.mov", 20)
        d = structure.detect(tmp_path)
        assert structure.pick_master(d)["name"] == "Program.mov"

    @needs_ffmpeg
    def test_clips_already_filed_are_not_offered_as_loose(self, tmp_path):
        session = self._house(tmp_path, "S Dt-16-Aug-26", master_seconds=20)
        make_clip(session / "Clips for Insert" / "Cam-01" / "filed.mov", 2)
        make_clip(session / "loose.mov", 3)
        d = structure.detect(tmp_path)
        assert [Path(p).name for p in d.cams["1"]] == ["filed.mov"]
        assert "filed.mov" not in [Path(p).name for p in d.loose_clips]


class TestInPlacePlan:
    """Completing a folder that already exists, rather than building a new one."""

    def _house(self, tmp_path, session_name):
        session = tmp_path / "3017 Dt-16 Aug 2026" / session_name
        for cam in ("Cam-01", "Cam-02"):
            (session / "Clips for Insert" / cam).mkdir(parents=True)
        return session

    def _plan(self, tmp_path, session, mode="move"):
        det = structure.detect(tmp_path).to_dict()
        master = structure.pick_master(det)
        loose = structure.unfiled_clips(det, master["path"])
        return ingest.build_plan({
            "mode": mode, "verify": "size", "targets": [{
                "role": "prores", "source_root": str(tmp_path),
                "session_source": det["session_path"],
                "master": master["path"],
                "cams": {"1": loose[:1]} if loose else {}}]})

    @needs_ffmpeg
    def test_only_the_dur_token_is_added_to_the_existing_name(self, tmp_path):
        original = REFERENCE_TITLE + " Dt-16-Aug-26"
        session = self._house(tmp_path, original)
        make_clip(session / "Program.mov", 65)
        plan = self._plan(tmp_path, session)
        t = plan["targets"][0]
        assert t["in_place"] is True
        assert t["rename_from"] == original
        assert t["rename_to"] == original + " Dur-1m5s"

    @needs_ffmpeg
    def test_no_rename_when_the_token_is_already_correct(self, tmp_path):
        session = self._house(tmp_path, REFERENCE_TITLE + " Dt-16-Aug-26 Dur-1m5s")
        make_clip(session / "Program.mov", 65)
        t = self._plan(tmp_path, session)["targets"][0]
        assert t["rename_to"] == "", "an already-correct folder must not be renamed"

    @needs_ffmpeg
    def test_a_wrong_token_is_corrected_not_appended(self, tmp_path):
        session = self._house(tmp_path, REFERENCE_TITLE + " Dt-16-Aug-26 Dur-99m9s")
        make_clip(session / "Program.mov", 65)
        t = self._plan(tmp_path, session)["targets"][0]
        assert t["rename_to"].endswith("Dur-1m5s")
        assert t["rename_to"].count("Dur-") == 1

    @needs_ffmpeg
    def test_the_folder_is_renamed_only_after_the_files_land(self, tmp_path):
        original = "Session Dt-16-Aug-26"
        session = self._house(tmp_path, original)
        make_clip(session / "Program.mov", 65)
        make_clip(session / "Loose Clip.mov", 3)
        plan = self._plan(tmp_path, session)
        res = ingest.execute_plan(plan)
        assert res["failed"] == 0
        assert res["renames"][0]["done"] is True

        final = session.parent / (original + " Dur-1m5s")
        assert final.is_dir() and not session.exists()
        assert list(final.glob("*Dur-1m5s.mov")), "master renamed after the folder"
        assert (final / "Clips for Insert" / "Cam-01" / "Loose Clip.mov").exists()

    @needs_ffmpeg
    def test_a_cancelled_run_leaves_the_folder_name_alone(self, tmp_path):
        original = "Session Dt-16-Aug-26"
        session = self._house(tmp_path, original)
        make_clip(session / "Program.mov", 65)
        make_clip(session / "Loose Clip.mov", 3)
        plan = self._plan(tmp_path, session)
        res = ingest.execute_plan(plan, should_cancel=lambda: True)
        assert res["cancelled"]
        assert not res["renames"][0]["done"]
        assert session.is_dir(), "a half-done run must not label the folder as finished"

    @needs_ffmpeg
    def test_a_clip_already_in_its_cam_folder_is_not_work(self, tmp_path):
        session = self._house(tmp_path, "S Dt-16-Aug-26")
        make_clip(session / "Program.mov", 65)
        filed = session / "Clips for Insert" / "Cam-01" / "already.mov"
        make_clip(filed, 2)
        det = structure.detect(tmp_path).to_dict()
        plan = ingest.build_plan({"mode": "move", "targets": [{
            "role": "prores", "source_root": str(tmp_path),
            "session_source": det["session_path"],
            "master": structure.pick_master(det)["path"],
            "cams": {"1": [str(filed)]}}]})
        clips = [i for i in plan["targets"][0]["items"] if i["kind"] == "clip"]
        assert clips == [], "no-op moves must not be planned"


class TestStructureTemplate:
    """A zip of empty folders is a template: it names the folder and lays out the cams."""

    REF = ("Adalaj Soneri Satsang Experience session of USA and Canada Satsang Trip, "
           "General Satsang E. Dt-16-Aug-26 Dur-54m1s")

    def _skeleton_zip(self, tmp_path, explicit_dirs=True):
        """The reference tree, zipped with no media in it at all."""
        zpath = tmp_path / "structure.zip"
        folders = [
            "3017 Dt-16 Aug 2026",
            f"3017 Dt-16 Aug 2026/{self.REF}",
            f"3017 Dt-16 Aug 2026/{self.REF}/Clips for Insert",
            f"3017 Dt-16 Aug 2026/{self.REF}/Clips for Insert/Cam-01",
            f"3017 Dt-16 Aug 2026/{self.REF}/Clips for Insert/Cam-02",
            f"3017 Dt-16 Aug 2026/{self.REF}/Clips for Insert/Cam-03",
        ]
        with zipfile.ZipFile(zpath, "w") as zf:
            if explicit_dirs:
                for f in folders:
                    zf.writestr(f + "/", b"")
            else:
                # Some tools store only file paths and leave folders implied.
                zf.writestr(folders[-1] + "/.keep", b"")
        return zpath

    def test_a_folder_only_zip_is_recognised_as_a_template(self, tmp_path):
        info = sources.inspect_zip(self._skeleton_zip(tmp_path))
        assert info["is_template"] is True
        assert info["video_count"] == 0
        assert info["folder_count"] == 6

    def test_folders_implied_by_paths_are_still_found(self, tmp_path):
        """A zip storing no directory entries must not look empty.

        Only the folders on the stored path are implied — Cam-01 and Cam-02 are
        genuinely absent from such an archive, so four is the right answer, and
        the session folder is still found and named correctly.
        """
        info = sources.inspect_zip(self._skeleton_zip(tmp_path, explicit_dirs=False))
        assert info["is_template"] is True
        assert info["folder_count"] == 4
        assert f"3017 Dt-16 Aug 2026/{self.REF}" in info["folders"]

        out = sources.extract_zip(
            self._skeleton_zip(tmp_path, explicit_dirs=False), tmp_path / "out2")
        d = structure.detect(out)
        assert d.session_name == self.REF and d.is_template

    def test_extracting_a_template_creates_its_empty_folders(self, tmp_path):
        out = sources.extract_zip(self._skeleton_zip(tmp_path), tmp_path / "out")
        cam = Path(out) / "3017 Dt-16 Aug 2026" / self.REF / "Clips for Insert" / "Cam-03"
        assert cam.is_dir(), "an all-folders zip must still extract to something"

    def test_the_template_reports_its_name_and_cams(self, tmp_path):
        out = sources.extract_zip(self._skeleton_zip(tmp_path), tmp_path / "out")
        d = structure.detect(out)
        assert d.is_template is True and d.video_count == 0
        assert d.job_name == "3017 Dt-16 Aug 2026"
        assert d.session_name == self.REF
        assert d.tree == ["Clips for Insert", "Clips for Insert/Cam-01",
                          "Clips for Insert/Cam-02", "Clips for Insert/Cam-03"]

    def test_a_zip_escape_attempt_is_refused(self, tmp_path):
        zpath = tmp_path / "evil.zip"
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr("../escaped.txt", b"nope")
            zf.writestr("fine/ok.txt", b"yes")
        out = Path(sources.extract_zip(zpath, tmp_path / "out"))
        assert not (tmp_path / "escaped.txt").exists()
        assert (out / "fine" / "ok.txt").exists()


class TestPlanFromTemplate:
    REF = TestStructureTemplate.REF

    @needs_ffmpeg
    def _run(self, tmp_path, mode="copy"):
        drive = tmp_path / "SSD"
        drive.mkdir()
        make_clip(drive / "Program.mov", 65)
        make_clip(drive / "Wide.mov", 3)
        dest = tmp_path / "DEST"
        plan = ingest.build_plan({
            "mode": mode, "verify": "size", "targets": [{
                "role": "prores", "source_root": str(drive), "dest_root": str(dest),
                "session_name": self.REF, "job_name": "3017 Dt-16 Aug 2026",
                "template_dirs": ["Clips for Insert", "Clips for Insert/Cam-01",
                                  "Clips for Insert/Cam-02", "Clips for Insert/Cam-03"],
                "master": str(drive / "Program.mov"),
                "cams": {"1": [str(drive / "Wide.mov")]}}]})
        return drive, dest, plan

    @needs_ffmpeg
    def test_the_templates_name_is_used_with_a_real_duration(self, tmp_path):
        _, _, plan = self._run(tmp_path)
        t = plan["targets"][0]
        assert t["from_template"] is True
        # The template's placeholder Dur-54m1s is replaced, not appended to.
        assert t["session_folder"].endswith("Dt-16-Aug-26 Dur-1m5s")
        assert t["session_folder"].count("Dur-") == 1
        assert t["job_folder"] == "3017 Dt-16 Aug 2026"

    @needs_ffmpeg
    def test_output_goes_to_the_chosen_destination_not_the_source(self, tmp_path):
        drive, dest, plan = self._run(tmp_path)
        t = plan["targets"][0]
        assert t["session_path"].startswith(str(dest))
        assert not t["session_path"].startswith(str(drive))
        for item in t["items"]:
            assert item["dst"].startswith(str(dest))
            assert item["src"].startswith(str(drive))

    @needs_ffmpeg
    def test_empty_cam_folders_from_the_template_are_created(self, tmp_path):
        _, dest, plan = self._run(tmp_path)
        res = ingest.execute_plan(plan)
        assert res["failed"] == 0
        session = Path(plan["targets"][0]["session_path"])
        clips = session / "Clips for Insert"
        assert (clips / "Cam-01" / "Wide.mov").exists()
        # Cam-02 and Cam-03 got no clips but are part of what the template defines.
        assert (clips / "Cam-02").is_dir() and (clips / "Cam-03").is_dir()
        assert list(session.glob("*Dur-1m5s.mov"))

    @needs_ffmpeg
    def test_single_drive_files_relocate_into_the_structure(self, tmp_path):
        """One drive, one destination: files move into the folder, not duplicated.

        The master lands under its folder-derived name; the cam clip keeps its
        own name inside Cam-01. Both leave the drive root.
        """
        drive, dest, plan = self._run(tmp_path)
        res = ingest.execute_plan(plan)
        assert res["failed"] == 0
        assert not (drive / "Program.mov").exists() and not (drive / "Wide.mov").exists()
        session = Path(plan["targets"][0]["session_path"])
        assert (session / "Clips for Insert" / "Cam-01" / "Wide.mov").exists()
        masters = [f for f in session.iterdir() if f.is_file() and f.suffix == ".mov"]
        assert len(masters) == 1, "the master relocated into the session folder"
        assert all(i["message"] == "moved" for i in res["items"])

    @needs_ffmpeg
    def test_two_drives_can_target_different_destinations(self, tmp_path):
        targets, drives, dests = [], [], []
        for role in ("prores", "h265"):
            drive = tmp_path / f"SSD_{role}"
            drive.mkdir()
            make_clip(drive / "Program.mov", 65)
            dest = tmp_path / f"DEST_{role}"
            drives.append(drive); dests.append(dest)
            targets.append({
                "role": role, "source_root": str(drive), "dest_root": str(dest),
                "session_name": self.REF, "job_name": "3017 Dt-16 Aug 2026",
                "template_dirs": ["Clips for Insert/Cam-01"],
                "master": str(drive / "Program.mov"), "cams": {}})
        plan = ingest.build_plan({"mode": "copy", "verify": "size", "targets": targets})
        assert not plan["warnings"], "separate destinations must not collide"
        res = ingest.execute_plan(plan)
        assert res["failed"] == 0
        for dest in dests:
            assert list(dest.rglob("*Dur-1m5s.mov")), f"nothing landed in {dest}"


class TestDateSuggestion:
    """A drive holds several shoots; the folder's Dt- token says which is ours."""

    def _f(self, name, day, size=1000, duration=10.0):
        return {"path": f"/drive/{name}", "name": name, "shoot_date": day,
                "size": size, "duration": duration}

    def test_files_from_the_stated_session_date_are_suggested(self):
        files = [self._f("a.mov", "2026-08-16"), self._f("b.mov", "2026-08-16"),
                 self._f("other.mov", "2026-08-18")]
        g = ingest.group_by_date(files, "2026-08-16")
        assert g["matched_session_date"] is True
        assert sorted(Path(p).name for p in g["suggested"]) == ["a.mov", "b.mov"]
        assert g["other_count"] == 1
        assert "folder name" in g["suggestion_basis"]

    def test_every_day_present_is_reported_not_just_the_match(self):
        files = [self._f("a.mov", "2026-08-16"), self._f("b.mov", "2026-08-18"),
                 self._f("c.mov", "2026-08-20")]
        g = ingest.group_by_date(files, "2026-08-16")
        assert [d["date"] for d in g["dates"]] == ["2026-08-16", "2026-08-18", "2026-08-20"]
        assert sum(d["is_session_date"] for d in g["dates"]) == 1

    def test_sizes_and_counts_are_totalled_per_day(self):
        files = [self._f("a.mov", "2026-08-16", size=100, duration=5.0),
                 self._f("b.mov", "2026-08-16", size=250, duration=7.5)]
        day = ingest.group_by_date(files, "2026-08-16")["dates"][0]
        assert day["count"] == 2 and day["bytes"] == 350 and day["duration"] == 12.5

    def test_falls_back_to_the_busiest_day_when_no_date_is_stated(self):
        files = [self._f("a.mov", "2026-08-16"), self._f("b.mov", "2026-08-16"),
                 self._f("c.mov", "2026-08-18")]
        g = ingest.group_by_date(files, None)
        assert g["matched_session_date"] is False
        assert g["suggested_date"] == "2026-08-16"
        assert "busiest day" in g["suggestion_basis"]

    def test_a_session_date_matching_nothing_suggests_nothing(self):
        # Better to offer no suggestion than to quietly propose the wrong shoot.
        files = [self._f("a.mov", "2026-08-18")]
        g = ingest.group_by_date(files, "2026-08-16")
        assert g["matched_session_date"] is False
        assert g["suggested"] == []
        assert g["date_mismatch"] is True
        assert "right drive" in g["suggestion_basis"]

    def test_empty_input_is_handled(self):
        g = ingest.group_by_date([], "2026-08-16")
        assert g["dates"] == [] and g["suggested"] == []

    def test_the_session_date_is_read_off_the_folder_name(self, tmp_path):
        session = tmp_path / "3017 Dt-16 Aug 2026" / (
            "Adalaj Soneri … General Satsang E. Dt-16-Aug-26 Dur-54m1s")
        (session / "Clips for Insert" / "Cam-01").mkdir(parents=True)
        d = structure.detect(tmp_path, probe_masters=False)
        assert d.session_date == "2026-08-16"

    def test_a_probed_file_reports_the_day_it_was_modified(self, tmp_path):
        import os
        import datetime as _dt
        f = tmp_path / "clip.mov"
        f.write_bytes(b"x")
        when = _dt.datetime(2026, 8, 16, 14, 30).timestamp()
        os.utime(f, (when, when))
        assert probe.probe(f).to_dict()["shoot_date"] == "2026-08-16"


class TestMirrorScope:
    """What gets mirrored is the footage in play, not everything on the drive."""

    def _f(self, root, name, day, dur=9.0, mtime=1000):
        return {"path": f"/{root}/{name}", "name": name, "shoot_date": day,
                "duration": dur, "mtime": mtime, "size": 100}

    def test_pairing_the_filtered_pools_excludes_other_shoots(self):
        a = [self._f("A", "MASTER01.mov", "2026-08-16", 64.0, 1000),
             self._f("A", "C0031.mov", "2026-08-16", 9.0, 2000),
             self._f("A", "OTHERDAY.mov", "2026-08-18", 7.0, 9000)]
        b = [self._f("B", n["name"], n["shoot_date"], n["duration"], n["mtime"])
             for n in a]

        # Pairing the raw drives drags the unrelated shoot along.
        assert len(ingest.pair_sources(a, b)["matches"]) == 3

        # Pairing what is actually in play does not.
        day = "2026-08-16"
        fa = [f for f in a if f["shoot_date"] == day]
        fb = [f for f in b if f["shoot_date"] == day]
        matched = ingest.pair_sources(fa, fb)["matches"]
        assert len(matched) == 2
        assert not any("OTHERDAY" in v for v in matched.values())

    def test_a_master_without_a_twin_is_reported(self):
        a = [self._f("A", "MASTER01.mov", "2026-08-16", 64.0, 1000)]
        b = [self._f("B", "SOMETHINGELSE.mov", "2026-08-16", 3.0, 90000)]
        r = ingest.pair_sources(a, b)
        assert r["unmatched_primary"] == ["/A/MASTER01.mov"]

    def test_a_target_with_no_master_warns_about_the_missing_token(self, tmp_path):
        """A mirrored drive whose master had no twin must not fail silently."""
        src = tmp_path / "SSD"
        src.mkdir()
        (src / "clip.mov").write_bytes(b"x" * 10)
        plan = ingest.build_plan({
            "mode": "copy", "targets": [{
                "role": "h265", "source_root": str(src),
                "dest_root": str(tmp_path / "out"),
                "session_name": "Session Dt-16-Aug-26",
                "master": None, "cams": {"1": [str(src / "clip.mov")]}}]})
        t = plan["targets"][0]
        assert "Dur-" not in t["session_folder"]
        assert any("no master" in w.lower() for w in plan["warnings"])


class TestDurTokenShapes:
    """Real folders carry hand-written tokens like 'Dur-1h0m', not just 'Dur-54m1s'."""

    @pytest.mark.parametrize("token,seconds", [
        ("54m1s", 3241), ("1h0m", 3600), ("1h", 3600), ("48s", 48),
        ("1h30m", 5400), ("2h3m4s", 7384), ("0s", 0),
    ])
    def test_every_shape_is_recognised_and_parsed(self, token, seconds):
        assert naming.DUR_TOKEN_RE.search(f"Session {token.join(['Dur-', ''])}")
        assert naming.parse_duration(token) == seconds

    def test_junk_is_not_mistaken_for_a_token(self):
        assert naming.parse_duration("") is None
        assert naming.parse_duration("abc") is None
        assert not naming.DUR_TOKEN_RE.search("Session Dur-")
        assert not naming.DUR_TOKEN_RE.search("Session Duration")

    def test_an_hours_minutes_token_is_replaced_not_duplicated(self):
        """The regression from the screenshot: 'Dur-1h0m' gained a second token."""
        existing = "Adalaj Soneri Satsang with SMHT MHTs E. Dt-20-Aug-26 Dur-1h0m"
        out = naming.build_session_folder(existing, dt.date(2026, 8, 20), 3601)
        assert out.count("Dur-") == 1
        assert "Dur-1h0m " not in out

    def test_a_template_carrying_such_a_token_reports_it(self, tmp_path):
        name = "Adalaj Soneri Satsang with SMHT MHTs E. Dt-20-Aug-26 Dur-1h0m"
        (tmp_path / "3018 Dt-20 Aug 2026" / name / "Clips for Insert" / "Cam-01").mkdir(parents=True)
        d = structure.detect(tmp_path, probe_masters=False)
        assert d.has_dur is True and d.current_dur == 3600
        assert d.base_name.endswith("Dt-20-Aug-26"), "the Dur- token must be stripped off"


class TestDurPrecision:
    """Every Dur- in use is hours+minutes at an hour or over, minutes+seconds under."""

    @pytest.mark.parametrize("seconds,expected", [
        (3241, "54m1s"),          # the original reference folder
        (2683, "44m43s"),         # Clip-01 in the two-clip session
        (3418, "56m58s"),         # Clip-02
        (3600, "1h0m"),           # exactly an hour crosses over
        (3642, "1h0m"),           # the Adalaj folder
        (6101, "1h41m"),          # the two clips totalled
        (7384, "2h3m"),
        (48, "48s"),
        (0, "0s"),
    ])
    def test_house_format(self, seconds, expected):
        assert naming.fmt_duration(seconds, naming.auto_precision(seconds)) == expected

    def test_a_folder_gets_the_total_in_house_format(self):
        folder = "02 Coppell Shibir General Satsang E. Dt-06-Aug-26"
        assert naming.session_folder_name(folder, 2683 + 3418, 2) == folder + \
            " Dur-1h41m Clips-02"

    def test_the_shape_does_not_depend_on_what_was_there_before(self):
        # An existing token is replaced, not imitated: 3241s is always 54m1s.
        for existing in ("Session Dt-20-Aug-26 Dur-1h0m",
                         "Session Dt-20-Aug-26 Dur-99m9s",
                         "Session Dt-20-Aug-26"):
            out = naming.complete_with_dur(existing, 3241)
            assert out.endswith("Dur-54m1s"), out
            assert out.count("Dur-") == 1

    def test_completing_twice_is_stable(self):
        once = naming.complete_with_dur("Session Dt-20-Aug-26 Dur-1h0m", 3601)
        assert naming.complete_with_dur(once, 3601) == once

    def test_the_original_reference_folder_is_unaffected(self):
        title = ("Adalaj Soneri Satsang Experience session of USA and Canada Satsang "
                 "Trip, General Satsang E.")
        assert naming.build_session_folder(title, dt.date(2026, 8, 16), 3241.9) == \
            title + " Dt-16-Aug-26 Dur-54m1s"


class TestSingleDayPlans:
    """A session is one day's footage; a plan spanning days is worth flagging."""

    @needs_ffmpeg
    def test_clips_from_two_days_are_flagged(self, tmp_path):
        import os
        import datetime as _dt
        drive = tmp_path / "SSD"
        drive.mkdir()
        make_clip(drive / "Program.mov", 65)
        for name, day in (("today.mov", (2026, 8, 20)), ("june.mov", (2026, 6, 17))):
            make_clip(drive / name, 2)
            when = _dt.datetime(*day, 12, 0).timestamp()
            os.utime(drive / name, (when, when))

        plan = ingest.build_plan({"mode": "copy", "targets": [{
            "role": "prores", "source_root": str(drive), "dest_root": str(tmp_path / "o"),
            "session_name": "S Dt-20-Aug-26",
            "master": str(drive / "Program.mov"),
            "cams": {"1": [str(drive / "today.mov"), str(drive / "june.mov")]}}]})
        assert any("more than one day" in w for w in plan["warnings"])

    @needs_ffmpeg
    def test_a_single_day_plan_is_not_flagged(self, tmp_path):
        import os
        import datetime as _dt
        drive = tmp_path / "SSD"
        drive.mkdir()
        make_clip(drive / "Program.mov", 65)
        for name in ("a.mov", "b.mov"):
            make_clip(drive / name, 2)
            when = _dt.datetime(2026, 8, 20, 12, 0).timestamp()
            os.utime(drive / name, (when, when))
        plan = ingest.build_plan({"mode": "copy", "targets": [{
            "role": "prores", "source_root": str(drive), "dest_root": str(tmp_path / "o"),
            "session_name": "S Dt-20-Aug-26",
            "master": str(drive / "Program.mov"),
            "cams": {"1": [str(drive / "a.mov"), str(drive / "b.mov")]}}]})
        assert not any("more than one day" in w for w in plan["warnings"])


class TestCameraCards:
    """Canon XF cards mount as CanonA_0006 with clips at XFVC/REEL_0006."""

    def _mount(self, tmp_path, name, reel, count=2, inner=("XFVC", "REEL_")):
        reel_dir = tmp_path / name / inner[0] / f"{inner[1]}{reel}"
        reel_dir.mkdir(parents=True)
        for i in range(count):
            (reel_dir / f"A_{reel}C{i}H260820_CANON.MP4").write_bytes(b"x" * 10)
        return tmp_path / name

    def _find(self, tmp_path, monkeypatch):
        monkeypatch.setattr(sources, "list_volumes", lambda: [
            {"path": str(p), "label": p.name}
            for p in sorted(tmp_path.iterdir()) if p.is_dir()])
        return sources.find_camera_cards()

    def test_cards_are_found_whatever_their_number(self, tmp_path, monkeypatch):
        self._mount(tmp_path, "CanonA_0006", "0006")
        self._mount(tmp_path, "CanonB_0021", "0021", count=3)
        r = self._find(tmp_path, monkeypatch)
        assert r["card_count"] == 2
        assert r["file_count"] == 5
        assert [c["label"] for c in r["cards"]] == ["CanonA_0006", "CanonB_0021"]

    def test_the_card_letter_becomes_the_cam_number(self, tmp_path, monkeypatch):
        for letter, n in (("A", "0006"), ("B", "0021"), ("C", "0005")):
            self._mount(tmp_path, f"Canon{letter}_{n}", n)
        cams = {c["label"]: c["suggested_cam"] for c in self._find(tmp_path, monkeypatch)["cards"]}
        assert cams == {"CanonA_0006": 1, "CanonB_0021": 2, "CanonC_0005": 3}

    def test_the_path_is_matched_case_insensitively(self, tmp_path, monkeypatch):
        self._mount(tmp_path, "CanonA_0006", "0006", inner=("xfvc", "reel_"))
        assert self._find(tmp_path, monkeypatch)["card_count"] == 1

    def test_a_volume_without_the_structure_is_ignored(self, tmp_path, monkeypatch):
        (tmp_path / "CanonD_9999" / "XFVC").mkdir(parents=True)      # no REEL_ inside
        (tmp_path / "NotACard" / "DCIM" / "100CANON").mkdir(parents=True)
        (tmp_path / "NotACard" / "DCIM" / "100CANON" / "x.MP4").write_bytes(b"x")
        assert self._find(tmp_path, monkeypatch)["card_count"] == 0

    def test_junk_files_are_not_imported(self, tmp_path, monkeypatch):
        card = self._mount(tmp_path, "CanonA_0006", "0006")
        reel = card / "XFVC" / "REEL_0006"
        (reel / ".DS_Store").write_bytes(b"x")
        (reel / "notes.txt").write_bytes(b"x")
        r = self._find(tmp_path, monkeypatch)
        names = [Path(f).name for f in r["cards"][0]["files"]]
        assert all(n.endswith(".MP4") for n in names) and len(names) == 2

    def test_clips_from_several_reels_on_one_card_are_all_taken(self, tmp_path, monkeypatch):
        card = self._mount(tmp_path, "CanonA_0006", "0006")
        second = card / "XFVC" / "REEL_0007"
        second.mkdir()
        (second / "extra.MP4").write_bytes(b"x")
        assert self._find(tmp_path, monkeypatch)["cards"][0]["file_count"] == 3


class TestMasterClipNaming:
    """Masters are renamed after the folder; the folder's Dur- is their total."""

    FOLDER = "02 Coppell Shibir General Satsang E. Dt-06-Aug-26 Dur-1h41m Clips-02"
    BASE = "Coppell Shibir General Satsang E. Dt-06-Aug-26"
    A, B = 44 * 60 + 43, 56 * 60 + 58          # 44m43s and 56m58s

    def test_reproduces_the_reference_folder_and_clips(self):
        assert naming.session_folder_name(self.FOLDER, self.A + self.B, 2) == self.FOLDER
        assert naming.master_clip_name(self.FOLDER, self.A, 1, 2, ".MOV") == \
            f"{self.BASE} Dur-44m43s Clip-01.MOV"
        assert naming.master_clip_name(self.FOLDER, self.B, 2, 2, ".MOV") == \
            f"{self.BASE} Dur-56m58s Clip-02.MOV"

    def test_the_leading_session_number_is_dropped_from_the_clip(self):
        assert naming.master_clip_name(self.FOLDER, self.A, 1, 2).startswith("Coppell")

    def test_a_lone_master_gets_no_clip_token_and_the_folders_duration(self):
        folder = "02 Coppell Shibir General Satsang E. Dt-06-Aug-26"
        name = naming.master_clip_name(folder, 3241, 1, 1, ".MOV")
        assert "Clip-" not in name
        assert name == f"{self.BASE.replace('06-Aug', '06-Aug')} Dur-54m1s.MOV".replace(
            "Coppell Shibir General Satsang E. Dt-06-Aug-26",
            "Coppell Shibir General Satsang E. Dt-06-Aug-26")
        assert naming.session_folder_name(folder, 3241, 1).endswith("Dur-54m1s")
        assert "Clips-" not in naming.session_folder_name(folder, 3241, 1)

    def test_the_extension_case_is_preserved(self):
        assert naming.master_clip_name(self.FOLDER, self.A, 1, 2, ".MOV").endswith(".MOV")
        assert naming.master_clip_name(self.FOLDER, self.A, 1, 2, ".mp4").endswith(".mp4")

    def test_renaming_is_idempotent(self):
        once = naming.master_clip_name(self.FOLDER, self.A, 1, 2, ".MOV")
        again = naming.master_clip_name(
            naming.session_folder_name(self.FOLDER, self.A + self.B, 2),
            self.A, 1, 2, ".MOV")
        assert once == again
        # And re-deriving from an already-renamed name does not stack tokens.
        assert naming.master_clip_name(Path(once).stem, self.A, 1, 2, ".MOV") == once

    def test_a_clips_token_is_replaced_when_the_count_changes(self):
        three = naming.session_folder_name(self.FOLDER, 100, 3)
        assert three.endswith("Clips-03") and three.count("Clips-") == 1

    @needs_ffmpeg
    def test_the_planner_totals_the_masters_and_orders_them_by_time(self, tmp_path):
        import os
        import datetime as _dt
        drive = tmp_path / "SSD"
        drive.mkdir()
        # Deliberately named so alphabetical order disagrees with shot order.
        for name, secs, when in (("zz_first.MOV", 65, (2026, 8, 6, 5, 37)),
                                 ("aa_second.MOV", 30, (2026, 8, 6, 6, 34))):
            make_clip(drive / name, secs)
            stamp = _dt.datetime(*when).timestamp()
            os.utime(drive / name, (stamp, stamp))

        plan = ingest.build_plan({"mode": "copy", "targets": [{
            "role": "prores", "source_root": str(drive), "dest_root": str(tmp_path / "out"),
            "session_name": "02 Coppell Shibir General Satsang E. Dt-06-Aug-26",
            "masters": [str(drive / "aa_second.MOV"), str(drive / "zz_first.MOV")],
            "cams": {}}]})

        t = plan["targets"][0]
        assert t["session_folder"].endswith("Dur-1m35s Clips-02")   # 65 + 30
        names = [Path(i["dst"]).name for i in t["items"] if i["kind"] == "master"]
        assert names == [
            "Coppell Shibir General Satsang E. Dt-06-Aug-26 Dur-1m5s Clip-01.MOV",
            "Coppell Shibir General Satsang E. Dt-06-Aug-26 Dur-30s Clip-02.MOV",
        ], names

    @needs_ffmpeg
    def test_a_single_master_matches_the_folder_duration(self, tmp_path):
        drive = tmp_path / "SSD"
        drive.mkdir()
        make_clip(drive / "SHGINF_S001_S001_T004.MOV", 65)
        plan = ingest.build_plan({"mode": "copy", "targets": [{
            "role": "prores", "source_root": str(drive), "dest_root": str(tmp_path / "out"),
            "session_name": "02 Coppell Shibir General Satsang E. Dt-06-Aug-26",
            "masters": [str(drive / "SHGINF_S001_S001_T004.MOV")], "cams": {}}]})
        t = plan["targets"][0]
        folder_dur = naming.DUR_TOKEN_RE.search(t["session_folder"]).group(0).strip()
        clip_name = Path(t["items"][0]["dst"]).name
        assert folder_dur in clip_name, "a lone master must carry the folder's duration"
        assert "Clip-" not in clip_name and "Clips-" not in t["session_folder"]


class TestNoDeletion:
    """Camera-card clips are copied to both SSDs and never deleted."""

    @needs_ffmpeg
    def test_a_two_destination_clip_is_copied_to_both_and_source_kept(self, tmp_path):
        card = tmp_path / "CARD"; card.mkdir()
        clip = card / "A_0006C204_CANON.MP4"
        make_clip(clip, 6)
        targets = []
        for role in ("prores", "h265"):
            drive = tmp_path / f"SSD_{role}"; drive.mkdir()
            make_clip(drive / "Master.mov", 65)
            targets.append({
                "role": role, "source_root": str(drive), "dest_root": str(drive),
                "session_name": "S Dt-20-Aug-26",
                "template_dirs": ["Clips for Insert/Cam-01"],
                "masters": [str(drive / "Master.mov")],
                "cams": {"1": [str(clip)]}})
        res = ingest.execute_plan(ingest.build_plan(
            {"mode": "move", "verify": "size", "targets": targets}))
        assert res["failed"] == 0
        assert clip.exists(), "the card clip must never be deleted"
        for role in ("prores", "h265"):
            landed = list((tmp_path / f"SSD_{role}").rglob("A_0006C204_CANON.MP4"))
            assert landed, f"clip missing on {role} drive"

    @needs_ffmpeg
    def test_master_relocates_but_its_own_drive_is_the_only_one(self, tmp_path):
        drive = tmp_path / "SSD"; drive.mkdir()
        make_clip(drive / "Master.mov", 65)
        plan = ingest.build_plan({"mode": "move", "verify": "size", "targets": [{
            "role": "prores", "source_root": str(drive), "dest_root": str(drive),
            "session_name": "S Dt-20-Aug-26", "masters": [str(drive / "Master.mov")],
            "cams": {}}]})
        res = ingest.execute_plan(plan)
        assert res["failed"] == 0
        assert not (drive / "Master.mov").exists(), "master moved into the folder"
        assert any(i["message"] == "moved" for i in res["items"])


class TestCustomCamNames:
    """A cam folder can be renamed; the clip and the empty folder agree."""

    @needs_ffmpeg
    def test_custom_name_used_for_folder_and_clip(self, tmp_path):
        drive = tmp_path / "SSD"; drive.mkdir()
        make_clip(drive / "M.MOV", 60)
        card = tmp_path / "CARD"; card.mkdir()
        make_clip(card / "CLIP.MP4", 5)
        plan = ingest.build_plan({"mode": "move", "targets": [{
            "role": "prores", "source_root": str(drive), "dest_root": str(drive),
            "session_name": "S Dt-20-Aug-26",
            "template_dirs": ["Clips for Insert/Cam-01", "Clips for Insert/Cam-02"],
            "masters": [str(drive / "M.MOV")],
            "cams": {"2": [str(card / "CLIP.MP4")]},
            "cam_names": {"2": "Cam-02 Wide"}}]})
        t = plan["targets"][0]
        assert "Clips for Insert/Cam-02 Wide" in t["ensure_dirs"]
        clip = next(i for i in t["items"] if i["kind"] == "clip")
        assert "/Cam-02 Wide/" in clip["final_dst"]

    @needs_ffmpeg
    def test_default_name_when_none_given(self, tmp_path):
        drive = tmp_path / "SSD"; drive.mkdir()
        make_clip(drive / "M.MOV", 60)
        card = tmp_path / "CARD"; card.mkdir()
        make_clip(card / "CLIP.MP4", 5)
        plan = ingest.build_plan({"mode": "move", "targets": [{
            "role": "prores", "source_root": str(drive), "dest_root": str(drive),
            "session_name": "S Dt-20-Aug-26",
            "masters": [str(drive / "M.MOV")],
            "cams": {"1": [str(card / "CLIP.MP4")]}}]})
        clip = next(i for i in plan["targets"][0]["items"] if i["kind"] == "clip")
        assert "/Cam-01/" in clip["final_dst"]


class TestPostCopyCardSwap:
    """Swapping a card after the first copy: add cams without re-planning the old."""

    @needs_ffmpeg
    def _filed_session(self, tmp_path):
        session = tmp_path / "DEST" / "S Dt-20-Aug-26 Dur-1m0s"
        (session / "Clips for Insert" / "Cam-01").mkdir(parents=True)
        make_clip(session / "S Dt-20-Aug-26 Dur-1m0s.MOV", 60)
        make_clip(session / "Clips for Insert" / "Cam-01" / "A1.MP4", 5)
        return session

    @needs_ffmpeg
    def test_a_missing_source_is_skipped_not_fatal(self, tmp_path):
        session = self._filed_session(tmp_path)
        make_clip(tmp_path / "CARD_B" / "B1.MP4", 6)
        # References a clip whose card was ejected — must not crash the build.
        plan = ingest.build_plan({"mode": "copy", "targets": [{
            "role": "prores", "source_root": str(tmp_path / "SSD"),
            "dest_root": str(tmp_path / "DEST"), "session_source": str(session),
            "masters": [],
            "cams": {"1": [str(tmp_path / "GONE" / "A1.MP4")],
                     "2": [str(tmp_path / "CARD_B" / "B1.MP4")]}}]})
        names = [Path(i["final_dst"]).name for i in plan["targets"][0]["items"]]
        assert names == ["B1.MP4"], "only the present clip is planned"
        assert any("no longer" in w for w in plan["targets"][0]["warnings"])

    @needs_ffmpeg
    def test_cam_only_add_keeps_the_folder_name(self, tmp_path):
        session = self._filed_session(tmp_path)
        make_clip(tmp_path / "CARD_B" / "B1.MP4", 6)
        t = ingest.build_plan({"mode": "copy", "targets": [{
            "role": "prores", "source_root": str(tmp_path / "SSD"),
            "dest_root": str(tmp_path / "DEST"), "session_source": str(session),
            "masters": [], "cams": {"2": [str(tmp_path / "CARD_B" / "B1.MP4")]}}]})["targets"][0]
        assert t["session_folder"] == "S Dt-20-Aug-26 Dur-1m0s", "existing Dur- must survive"
        assert t["rename_to"] == "", "a cam-only add renames nothing"
        assert not any("No master" in w for w in t["warnings"])

    @needs_ffmpeg
    def test_new_card_clip_lands_in_its_cam(self, tmp_path):
        session = self._filed_session(tmp_path)
        make_clip(tmp_path / "CARD_B" / "B1.MP4", 6)
        t = ingest.build_plan({"mode": "copy", "targets": [{
            "role": "prores", "source_root": str(tmp_path / "SSD"),
            "dest_root": str(tmp_path / "DEST"), "session_source": str(session),
            "masters": [], "cams": {"2": [str(tmp_path / "CARD_B" / "B1.MP4")]}}]})["targets"][0]
        clip = next(i for i in t["items"] if i["kind"] == "clip")
        assert "/Cam-02/B1.MP4" in clip["final_dst"]


class TestExistingCamsReported:
    """A post-copy add must show — and keep — the cams already on disk."""

    @needs_ffmpeg
    def test_existing_cam_folders_are_reported_and_untouched(self, tmp_path):
        session = tmp_path / "DEST" / "S Dt-20-Aug-26 Dur-1h0m"
        (session / "Clips for Insert" / "Cam-01").mkdir(parents=True)
        make_clip(session / "M Dur-1h0m.MOV", 3)
        make_clip(session / "Clips for Insert" / "Cam-01" / "A1.MP4", 2)
        make_clip(session / "Clips for Insert" / "Cam-01" / "A2.MP4", 2)
        make_clip(tmp_path / "CARD_B" / "B1.MP4", 2)

        plan = ingest.build_plan({"mode": "copy", "targets": [{
            "role": "prores", "source_root": str(tmp_path / "SSD"),
            "dest_root": str(tmp_path / "DEST"), "session_source": str(session),
            "masters": [], "cams": {"2": [str(tmp_path / "CARD_B" / "B1.MP4")]}}]})
        t = plan["targets"][0]
        assert t["existing_cams"] == {"Cam-01": 2}
        assert t["master_present"] is True

        res = ingest.execute_plan(plan)
        assert res["failed"] == 0
        cam01 = session / "Clips for Insert" / "Cam-01"
        assert cam01.is_dir()
        assert sorted(f.name for f in cam01.iterdir()) == ["A1.MP4", "A2.MP4"]
        assert (session / "Clips for Insert" / "Cam-02" / "B1.MP4").exists()

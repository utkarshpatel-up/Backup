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
        landed = {Path(i["dst"]).name for i in plan["targets"][0]["items"]}
        assert landed == set(originals), "filenames must survive the copy untouched"
        for item in plan["targets"][0]["items"]:
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
        assert Path(t["items"][0]["dst"]).name == "M.mov", "master keeps its own name"

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
        first = ingest.execute_plan(ingest.build_plan(spec))
        assert first["copied"] == 1 and first["failed"] == 0
        second = ingest.execute_plan(ingest.build_plan(spec))
        assert second["copied"] == 0 and second["skipped"] == 1

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
        assert (final / "Program.mov").exists(), "master stays put, name intact"
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
        assert plan["targets"][0]["items"] == [], "no-op moves must not be planned"


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
        assert (session / "Program.mov").exists()

    @needs_ffmpeg
    def test_copy_leaves_the_source_drive_untouched(self, tmp_path):
        drive, _, plan = self._run(tmp_path, mode="copy")
        ingest.execute_plan(plan)
        assert (drive / "Program.mov").exists() and (drive / "Wide.mov").exists()

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
            assert list(dest.rglob("Program.mov")), f"nothing landed in {dest}"


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


class TestDurShapeIsCarriedOver:
    """The token is written in whatever shape the folder already uses."""

    @pytest.mark.parametrize("existing,seconds,expected", [
        # An hours+minutes folder stays hours+minutes: no seconds are introduced.
        ("Session Dt-20-Aug-26 Dur-1h0m", 3601, "1h0m"),
        ("Session Dt-20-Aug-26 Dur-1h0m", 3241, "54m"),
        # A full h/m/s folder keeps its seconds.
        ("Session Dt-16-Aug-26 Dur-54m1s", 3601, "1h0m1s"),
        ("Session Dt-16-Aug-26 Dur-54m1s", 3241, "54m1s"),
        # No token yet: the full form is the default.
        ("Session Dt-16-Aug-26", 3241, "54m1s"),
        # Hours-only stays hours-only.
        ("Session Dt-20-Aug-26 Dur-1h", 7384, "2h"),
    ])
    def test_shape_follows_the_existing_name(self, existing, seconds, expected):
        out = naming.complete_with_dur(existing, seconds)
        assert out.endswith(f"Dur-{expected}")
        assert out.count("Dur-") == 1

    def test_precision_is_read_off_the_token(self):
        assert naming.token_precision("1h0m") == "m"
        assert naming.token_precision("54m1s") == "s"
        assert naming.token_precision("1h") == "h"

    def test_fmt_duration_honours_precision(self):
        assert naming.fmt_duration(3601, "s") == "1h0m1s"
        assert naming.fmt_duration(3601, "m") == "1h0m"
        assert naming.fmt_duration(3601, "h") == "1h"
        assert naming.fmt_duration(3241, "m") == "54m"

    def test_completing_twice_is_stable(self):
        once = naming.complete_with_dur("Session Dt-20-Aug-26 Dur-1h0m", 3601)
        assert naming.complete_with_dur(once, 3601) == once

    def test_the_original_reference_folder_is_unaffected(self):
        title = ("Adalaj Soneri Satsang Experience session of USA and Canada Satsang "
                 "Trip, General Satsang E.")
        assert naming.build_session_folder(title, dt.date(2026, 8, 16), 3241.9) == \
            title + " Dt-16-Aug-26 Dur-54m1s"

    @needs_ffmpeg
    def test_a_template_in_hours_minutes_plans_in_hours_minutes(self, tmp_path):
        drive = tmp_path / "SSD"; drive.mkdir()
        make_clip(drive / "Program.mov", 65)
        plan = ingest.build_plan({"mode": "copy", "targets": [{
            "role": "prores", "source_root": str(drive), "dest_root": str(tmp_path / "out"),
            "session_name": "Adalaj Soneri Satsang with SMHT MHTs E. Dt-20-Aug-26 Dur-1h0m",
            "master": str(drive / "Program.mov"), "cams": {}}]})
        folder = plan["targets"][0]["session_folder"]
        assert folder.endswith("Dur-1m"), folder
        assert folder.count("Dur-") == 1

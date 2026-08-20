"""Regression tests for the naming, pairing, planning and comparison logic.

    python3 -m pytest tests/ -q          (from the project root)
"""

import datetime as dt
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from vingest import compare, ingest, naming  # noqa: E402

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

    def test_clip_name(self):
        assert naming.build_name("C0031", dt.date(2026, 8, 16), 134, ".MOV") \
            == "C0031 Dt-16-Aug-26 Dur-2m14s.mov"

    def test_rename_is_idempotent(self):
        once = naming.build_name("C0031", dt.date(2026, 8, 16), 134, ".mov")
        twice = naming.build_name(Path(once).stem, dt.date(2026, 8, 16), 134, ".mov")
        assert once == twice, "re-running the ingest must not stack tokens"

    def test_duration_change_replaces_rather_than_appends(self):
        first = naming.build_name("C0031", dt.date(2026, 8, 16), 134, ".mov")
        second = naming.build_name(Path(first).stem, dt.date(2026, 8, 16), 200, ".mov")
        assert second == "C0031 Dt-16-Aug-26 Dur-3m20s.mov"
        assert second.count("Dur-") == 1

    def test_illegal_characters_are_replaced(self):
        out = naming.build_name('bad/name:with*chars?', dt.date(2026, 8, 16), 5, ".mov")
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
        return {"name": name, "rel": name, "size": size, "mtime": 0,
                "duration": duration, "codec": codec, "declared_duration": declared}

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

        dests = {Path(i["dst"]).name: i["dst"] for i in t["items"]}
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

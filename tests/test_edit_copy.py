"""H.264 edit copy: HyperDeck files named like the masters, folder number first.

    python3 -m pytest tests/ -q          (from the project root)
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from vingest import edit_copy, naming, server  # noqa: E402

SESSION = "02 Adalaj Soneri Satsang E. Dt-17-Oct-26 Dur-1h41m Clips-02"


@pytest.fixture
def lengths(monkeypatch):
    """Clip lengths by file name, in place of reading real media."""
    table = {}
    monkeypatch.setattr(edit_copy, "_duration_and_codec",
                        lambda p: (table.get(Path(p).name), "h264"))
    return table


def card(tmp_path, names, size=1000):
    root = tmp_path / "HYPERDECK"
    root.mkdir()
    for i, n in enumerate(names):
        (root / n).write_bytes(bytes([i % 256]) * (size + i))
    return root


def test_names_match_the_masters_with_the_folder_number_in_front(tmp_path, lengths):
    src = card(tmp_path, ["HyperDeck_0002.mp4", "HyperDeck_0010.mp4"])
    lengths.update({"HyperDeck_0002.mp4": 2683, "HyperDeck_0010.mp4": 3384})
    out = tmp_path / "server"
    out.mkdir()
    plan = edit_copy.build_plan({"source": str(src), "dest": str(out),
                                 "job_number": "3058", "session_folder": SESSION})
    names = [i["name"] for i in plan["items"]]
    # The very names the H.265/ProRes masters get, each with 3058 in front.
    assert names == [
        "3058 " + naming.master_clip_name(SESSION, 2683, 1, 2, ".mp4"),
        "3058 " + naming.master_clip_name(SESSION, 3384, 2, 2, ".mp4"),
    ]
    assert names[0] == "3058 Adalaj Soneri Satsang E. Dt-17-Oct-26 Dur-44m43s Clip-01.mp4"
    assert all(i["status"] == "new" for i in plan["items"])


def test_clips_are_counted_from_the_card_alone(tmp_path, lengths):
    # The masters' folder says Clips-02; this card has three, numbered 01-03.
    src = card(tmp_path, ["a.mp4", "b.mp4", "c.mp4"])
    plan = edit_copy.build_plan({"source": str(src), "dest": "", "job_number": "3058",
                                 "session_folder": SESSION})
    assert [i["name"].rsplit("Clip-", 1)[1] for i in plan["items"]] == ["01.mp4", "02.mp4", "03.mp4"]


def test_a_single_clip_carries_no_clip_token(tmp_path, lengths):
    src = card(tmp_path, ["only.mp4"])
    lengths["only.mp4"] = 600
    plan = edit_copy.build_plan({"source": str(src), "dest": "", "job_number": "3058",
                                 "session_folder": SESSION})
    assert plan["items"][0]["name"] == "3058 Adalaj Soneri Satsang E. Dt-17-Oct-26 Dur-10m0s.mp4"


def test_output_inside_a_job_folder_is_refused(tmp_path, lengths):
    src = card(tmp_path, ["a.mp4"])
    inside = tmp_path / "3058 Dt-17 Oct 2026" / "H264"
    inside.mkdir(parents=True)
    with pytest.raises(ValueError, match="inside a job folder"):
        edit_copy.build_plan({"source": str(src), "dest": str(inside), "job_number": "3058",
                              "session_folder": SESSION})


def test_folder_number_must_be_digits(tmp_path, lengths):
    src = card(tmp_path, ["a.mp4"])
    with pytest.raises(ValueError, match="digits"):
        edit_copy.build_plan({"source": str(src), "job_number": "30A8", "session_folder": SESSION})


def test_run_copies_checks_and_never_overwrites(tmp_path, lengths):
    src = card(tmp_path, ["a.mp4", "b.mp4", "c.mp4"])
    out = tmp_path / "server"
    out.mkdir()
    first = edit_copy.build_plan({"source": str(src), "dest": str(out), "job_number": "3058",
                                  "session_folder": SESSION})
    # One already copied, one of the same name but a different file.
    (out / first["items"][0]["name"]).write_bytes((src / "a.mp4").read_bytes())
    (out / first["items"][1]["name"]).write_bytes(b"something else")
    plan = edit_copy.build_plan({"source": str(src), "dest": str(out), "job_number": "3058",
                                 "session_folder": SESSION})
    assert [i["status"] for i in plan["items"]] == ["same", "conflict", "new"]

    res = edit_copy.run(plan, "hash")
    assert res["copied"] == 1 and res["verified"] == 2
    assert not res["ok"] and len(res["errors"]) == 1
    assert (out / plan["items"][1]["name"]).read_bytes() == b"something else"
    assert (out / plan["items"][2]["name"]).read_bytes() == (src / "c.mp4").read_bytes()
    assert not list(out.glob("*.vingest-part"))


def test_run_reports_speed_and_time_left(tmp_path, lengths):
    src = card(tmp_path, ["a.mp4", "b.mp4"])
    out = tmp_path / "server"
    out.mkdir()
    plan = edit_copy.build_plan({"source": str(src), "dest": str(out), "job_number": "3058",
                                 "session_folder": SESSION})
    seen = []
    edit_copy.run(plan, "size", progress=seen.append)
    copies = [d for d in seen if d.get("stage") == "copy"]
    assert copies and all("rate_bps" in d and "eta_seconds" in d for d in copies)


def test_run_copies_only_the_items_given(tmp_path, lengths):
    # The window sends just the ticked clips; their numbers stay the whole card's.
    src = card(tmp_path, ["a.mp4", "b.mp4", "c.mp4"])
    out = tmp_path / "server"
    out.mkdir()
    plan = edit_copy.build_plan({"source": str(src), "dest": str(out), "job_number": "3058",
                                 "session_folder": SESSION})
    picked = [plan["items"][1]]
    res = edit_copy.run({**plan, "items": picked}, "size")
    assert res["copied"] == 1 and res["ok"]
    assert [p.name for p in out.iterdir()] == [picked[0]["name"]]
    assert "Clip-02" in picked[0]["name"]


def test_only_the_ticked_clips_are_numbered(tmp_path, lengths):
    src = card(tmp_path, ["a.mp4", "b.mp4", "c.mp4", "d.mp4"])
    out = tmp_path / "server"
    out.mkdir()
    lengths.update({"a.mp4": 177, "b.mp4": 2754, "c.mp4": 12, "d.mp4": 3287})
    params = {"source": str(src), "dest": str(out), "job_number": "3069", "session_folder": SESSION,
              "picked": [str(src / n) for n in ("a.mp4", "b.mp4", "d.mp4")]}
    plan = edit_copy.build_plan(params)
    assert [i["status"] for i in plan["items"]] == ["new", "new", "skip", "new"]
    names = [i["name"] for i in plan["items"]]
    assert names[0].endswith("Clip-01.mp4") and names[1].endswith("Clip-02.mp4")
    assert names[2] == "" and names[3].endswith("Clip-03.mp4")
    res = edit_copy.run(plan, "size")
    assert res["copied"] == 3 and res["ok"]
    assert sorted(p.name for p in out.iterdir()) == sorted(n for n in names if n)


def test_engine_methods_are_registered():
    assert "edit_copy_plan" in server.METHODS and "edit_copy_run" in server.METHODS


def test_job_number_of():
    assert edit_copy.job_number_of("3058 Dt-17 Oct 2026") == "3058"
    assert edit_copy.job_number_of("Dt-17 Oct 2026") == ""

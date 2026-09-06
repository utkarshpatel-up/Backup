#!/usr/bin/env python3
"""
rename_clips.py

Renames raw audio/video files (which have random names assigned by the
recording device) into a clean, consistent naming scheme based on:

  1. The name of the parent folder(s) describing the event/session, and
  2. An ascending sequence number derived from each file's modified timestamp.

Folder layout expected (matches the "cleaned-up" reference structure):

    <Tour Root>/
      2436 Dt-12 June 2025/
        01 Allentown Hotel Venue Dt-12-06-25 Clips-04/
          Cam-01/
            <random-name-1>.MP4
            <random-name-2>.MP4
          Cam-02 (Drone)/
            <random-name-1>.MP4
        02 Alletown Shibir Pjyashree's Vidhi Dt-12-06-25/
          <random-name-1>.mp4

Any directory that directly contains media files is treated as a "clip
group": all files in that directory are sorted by modified time and
renamed in ascending order.

Output naming:

    [<Cam label> ]<Event Name> Clip-NNN.<ext>

  - <Cam label> is included only if the immediate parent folder of the
    file looks like "Cam-01", "Cam-02 (Drone)", etc. (only the "Cam-NN"
    part is kept in the output name).
  - <Event Name> is derived from the event folder name, stripping a
    leading numeric prefix ("01 "), a trailing "Dt-DD-MM-YY" date stamp,
    and a trailing "Clips-NN" count.
  - NNN is a zero-padded sequence number (001, 002, ...) in ascending
    order of file modified time within that clip group.
  - Original file extension (including case) is preserved.

USAGE
-----
    # Preview the rename plan (no files are touched):
    python3 rename_clips.py "/path/to/Tour Root"

    # Actually perform the renames:
    python3 rename_clips.py "/path/to/Tour Root" --apply

    # Restrict to specific file extensions (default covers common
    # audio/video formats):
    python3 rename_clips.py "/path/to/Tour Root" --ext mp4 mov wav

    # Write the full rename plan to a CSV for review/audit:
    python3 rename_clips.py "/path/to/Tour Root" --csv plan.csv
"""

import argparse
import csv
import os
import re
import sys

DEFAULT_EXTENSIONS = {
    # video
    "mp4", "mov", "mxf", "avi", "mkv", "m4v", "insv",
    # audio
    "wav", "mp3", "aac", "m4a", "wma", "flac",
}

CAM_RE = re.compile(r"^(Cam-\d+)", re.IGNORECASE)
CLIPS_COUNT_RE = re.compile(r"\s*Clips-\d+\s*$", re.IGNORECASE)
LEADING_NUM_RE = re.compile(r"^\d+\s+")
# A "Dt-" date stamp in any of the shapes the folders use, so none of them
# survive into the clip name:
#   Dt-12-06-25      (numeric day-month-year)
#   Dt-12-Jun-25     (abbreviated or full month, dash-separated)
#   Dt-12 June 2025  (month name, space-separated)
DATE_RE = re.compile(
    r"\s*\bDt-\d{1,2}(?:-\d{1,2}-\d{2,4}|-[A-Za-z]{3,9}-\d{2,4}"
    r"|\s+[A-Za-z]{3,9}\s+\d{4})\b",
    re.IGNORECASE,
)


def clean_event_name(folder_name: str) -> str:
    """Strip leading index numbers, date stamps, and clip counts from a
    folder name to derive a clean event name."""
    name = folder_name
    name = CLIPS_COUNT_RE.sub("", name)
    name = DATE_RE.sub(" ", name)
    name = LEADING_NUM_RE.sub("", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def cam_label(folder_name: str):
    m = CAM_RE.match(folder_name)
    return m.group(1) if m else None


def find_event_name(dirpath: str, root: str) -> str:
    """Walk up from dirpath (a clip-group directory) to find the folder
    whose name describes the event, skipping any Cam-NN folder."""
    current = dirpath
    while True:
        base = os.path.basename(current)
        if not cam_label(base):
            return clean_event_name(base)
        parent = os.path.dirname(current)
        if parent == current or os.path.normpath(parent) == os.path.normpath(root):
            return clean_event_name(base)
        current = parent


def collect_clip_groups(root: str, extensions):
    """Yield (dirpath, [filenames]) for every directory that directly
    contains at least one media file."""
    for dirpath, _dirnames, filenames in os.walk(root):
        media_files = [
            f for f in filenames
            if f.rsplit(".", 1)[-1].lower() in extensions and not f.startswith(".")
        ]
        if media_files:
            yield dirpath, media_files


def build_rename_plan(root: str, extensions):
    plan = []  # list of (old_path, new_path)
    for dirpath, filenames in collect_clip_groups(root, extensions):
        folder_base = os.path.basename(dirpath)
        cam = cam_label(folder_base)
        event_name = find_event_name(dirpath, root)

        # sort by modified time ascending
        files_with_mtime = [
            (f, os.path.getmtime(os.path.join(dirpath, f))) for f in filenames
        ]
        files_with_mtime.sort(key=lambda pair: pair[1])

        for idx, (fname, _mtime) in enumerate(files_with_mtime, start=1):
            ext = fname.rsplit(".", 1)[-1]
            prefix = f"{cam} " if cam else ""
            new_name = f"{prefix}{event_name} Clip-{idx:03d}.{ext}"
            old_path = os.path.join(dirpath, fname)
            new_path = os.path.join(dirpath, new_name)
            plan.append((old_path, new_path))
    return plan


def apply_plan(plan):
    """Perform renames safely, using a temporary intermediate name for
    every file first so that renames never collide with each other or
    with the original random names."""
    temp_pairs = []
    for i, (old_path, _new_path) in enumerate(plan):
        dirpath = os.path.dirname(old_path)
        temp_path = os.path.join(dirpath, f".__rename_tmp_{i}__{os.path.basename(old_path)}")
        os.rename(old_path, temp_path)
        temp_pairs.append(temp_path)

    for temp_path, (_old_path, new_path) in zip(temp_pairs, plan):
        os.rename(temp_path, new_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", help="Root folder of the tour content to rename")
    parser.add_argument(
        "--ext", nargs="+", default=None,
        help="File extensions to include (without dot), e.g. --ext mp4 mov wav. "
             "Defaults to a broad set of common audio/video formats.",
    )
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually perform the renames. Without this flag, the script only "
             "prints the planned renames (dry run).",
    )
    parser.add_argument(
        "--csv", metavar="PATH",
        help="Write the full rename plan (old path, new path) to a CSV file.",
    )
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        print(f"Error: '{root}' is not a directory", file=sys.stderr)
        sys.exit(1)

    extensions = {e.lower().lstrip(".") for e in args.ext} if args.ext else DEFAULT_EXTENSIONS

    plan = build_rename_plan(root, extensions)

    if not plan:
        print("No matching media files found.")
        return

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["old_path", "new_path"])
            for old_path, new_path in plan:
                writer.writerow([old_path, new_path])
        print(f"Wrote rename plan to {args.csv}")

    if args.apply:
        apply_plan(plan)
        print(f"Renamed {len(plan)} files.")
    else:
        print(f"DRY RUN — {len(plan)} files would be renamed. Re-run with --apply to execute.\n")
        for old_path, new_path in plan:
            rel_old = os.path.relpath(old_path, root)
            rel_new = os.path.relpath(new_path, root)
            print(f"  {rel_old}\n    -> {rel_new}")


if __name__ == "__main__":
    main()

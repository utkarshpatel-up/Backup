#!/usr/bin/env python3
"""Fail the Mac build if anything in the packaged app needs a newer macOS than
the oldest one we support (12 = Monterey, the operators' Mac).

Checks every Mach-O binary inside each built ``.app`` (Electron, its frameworks
and helpers, the frozen engine), every binary packed inside the frozen engine
(Python's libraries, ffmpeg, ffprobe), and the app's declared minimum version.

    python3 scripts/check_macos_min.py [dist-dir]

The limit comes from VINGEST_MACOS_MIN (default 12.0), shared with
scripts/build_python.py.
"""

from __future__ import annotations

import os
import plistlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_python import MACOS_MIN, _version_tuple, macos_too_new  # noqa: E402

MAGICS = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe")


def needs(path: Path) -> list:
    """The minimum macOS of each architecture slice in a Mach-O file."""
    from macholib import mach_o
    from macholib.MachO import MachO

    found = []
    for header in MachO(str(path)).headers:
        for lc, cmd, _ in header.commands:
            if lc.cmd == mach_o.LC_BUILD_VERSION:
                raw = cmd.minos
            elif lc.cmd == mach_o.LC_VERSION_MIN_MACOSX:
                raw = cmd.version
            else:
                continue
            found.append((raw >> 16, (raw >> 8) & 0xFF))
    return found


def check_app(app: Path, ceiling: tuple) -> list:
    problems = []
    info = app / "Contents" / "Info.plist"
    if info.exists():
        declared = plistlib.loads(info.read_bytes()).get("LSMinimumSystemVersion", "")
        if not declared or _version_tuple(declared) > ceiling:
            problems.append(f"Info.plist LSMinimumSystemVersion is {declared or 'missing'}")
    for dirpath, _dirs, files in os.walk(app):
        for name in files:
            path = Path(dirpath) / name
            if path.is_symlink():
                continue
            try:
                with open(path, "rb") as fh:
                    if fh.read(4) not in MAGICS:
                        continue
            except OSError:
                continue
            try:
                versions = needs(path)
            except Exception:
                continue                      # not really Mach-O (e.g. a Java class)
            for version in versions:
                if version > ceiling:
                    rel = path.relative_to(app)
                    problems.append(f"{rel} needs macOS {version[0]}.{version[1]}")
                    break
    # One engine, or one per chip in a universal app (vingest-core-arm64, vingest-core-x64).
    engines = sorted((app / "Contents" / "Resources" / "python").glob("vingest-core*"))
    for engine in engines:
        problems += [f"{engine.name}: {p}" for p in macos_too_new(engine)]
    if not engines:
        problems.append("engine (Resources/python/vingest-core) is missing")
    return problems


def main() -> int:
    dist = Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
    # Only the top-level apps: Electron nests helper .apps inside the main one.
    apps = sorted(p for p in dist.glob("**/*.app") if p.is_dir()
                  and not any(parent.suffix == ".app" for parent in p.parents))
    if not apps:
        print(f"No .app found under {dist}", file=sys.stderr)
        return 1
    ceiling = _version_tuple(MACOS_MIN)
    failed = False
    for app in apps:
        problems = check_app(app, ceiling)
        if problems:
            failed = True
            print(f"{app}: does NOT run on macOS {MACOS_MIN}:\n  " + "\n  ".join(problems),
                  file=sys.stderr)
        else:
            print(f"{app}: every binary runs on macOS {MACOS_MIN}+.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

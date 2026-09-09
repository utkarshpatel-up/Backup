#!/usr/bin/env python3
"""Freeze the Python engine into a single binary for electron-builder.

Run on each OS you ship for — PyInstaller does not cross-compile. The result
lands in dist-python/ and is copied into the app's Resources by the packager.

    python3 scripts/build_python.py [--with-ffmpeg /path/to/ffmpeg/bin]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist-python"

EXE = ".exe" if os.name == "nt" else ""


def _has_tools(directory: Path) -> bool:
    """True when `directory` holds both ffprobe and ffmpeg executables."""
    return all((directory / (tool + EXE)).exists()
               for tool in ("ffprobe", "ffmpeg"))


def autodetect_ffmpeg() -> Path | None:
    """Find a folder containing ffmpeg + ffprobe without the operator naming it.

    Checks, in order: whatever is on PATH, then the usual install locations on
    each OS. Returns the folder, or None if a complete pair is nowhere to be
    found — so the build can carry on unbundled rather than fail.
    """
    for tool in ("ffprobe", "ffmpeg"):
        found = shutil.which(tool)
        if found:
            directory = Path(found).resolve().parent
            if _has_tools(directory):
                return directory
    common = [
        Path(r"C:\ffmpeg\bin"), Path(r"C:\Program Files\ffmpeg\bin"),
        Path("/opt/homebrew/bin"), Path("/usr/local/bin"), Path("/usr/bin"),
    ]
    for directory in common:
        if _has_tools(directory):
            return directory
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-ffmpeg", metavar="DIR",
                    help="Directory holding ffmpeg/ffprobe to bundle into the binary. "
                         "Omit and the build auto-detects ffmpeg (PATH, then the usual "
                         "install folders) so the installer is self-contained by default.")
    ap.add_argument("--no-ffmpeg", action="store_true",
                    help="Do not bundle ffmpeg; the target machine must have it installed. "
                         "Overrides auto-detection.")
    args = ap.parse_args()

    # ffmpeg is bundled by default: use the explicit folder if given, otherwise
    # go looking for one, so a plain `npm run dist:win` yields a self-contained
    # installer. --no-ffmpeg is the deliberate opt-out.
    if args.no_ffmpeg:
        args.with_ffmpeg = None
    elif not args.with_ffmpeg:
        found = autodetect_ffmpeg()
        if found:
            args.with_ffmpeg = str(found)
            print(f"Auto-detected ffmpeg at {found}")
        else:
            print("Could not auto-detect ffmpeg. Building without it — install "
                  "ffmpeg and pass --with-ffmpeg <dir> for a self-contained build, "
                  "or the target machine will need ffmpeg itself.")

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("PyInstaller is missing. Install it with:\n"
              "    python3 -m pip install pyinstaller xxhash", file=sys.stderr)
        return 1

    sep = ";" if os.name == "nt" else ":"
    # Do not use PyInstaller's --noconsole/--windowed mode. On Windows that can
    # set sys.stdin/sys.stdout to None, but those pipes ARE the Electron RPC
    # transport. Electron starts the process with windowsHide, so no console
    # window is shown to the operator anyway.
    cmd = [sys.executable, "-m", "PyInstaller", "--onefile", "--console",
           "--name", "vingest-core",
           "--distpath", str(OUT),
           "--workpath", str(ROOT / "build" / "pyi"),
           "--specpath", str(ROOT / "build"),
           "--paths", str(ROOT / "python"),
           "--hidden-import", "vingest.server"]

    if args.with_ffmpeg:
        binp = Path(args.with_ffmpeg)
        for tool in ("ffprobe", "ffmpeg"):
            exe = binp / (tool + (".exe" if os.name == "nt" else ""))
            if not exe.exists():
                print(f"Not found: {exe}", file=sys.stderr)
                return 1
            cmd += ["--add-binary", f"{exe}{sep}."]
        print(f"Bundling ffmpeg/ffprobe from {binp}")
    else:
        print("Not bundling ffmpeg — the target machine must have it installed.")

    cmd.append(str(ROOT / "python" / "main.py"))

    OUT.mkdir(exist_ok=True)
    print(" ".join(cmd))
    res = subprocess.run(cmd)
    if res.returncode != 0:
        return res.returncode

    produced = OUT / ("vingest-core.exe" if os.name == "nt" else "vingest-core")
    if not produced.exists():
        print("PyInstaller reported success but produced no binary.", file=sys.stderr)
        return 1
    size = produced.stat().st_size / 1024 / 1024
    print(f"\nBuilt {produced} ({size:.1f} MB)")

    print("Smoke-testing the frozen binary…")
    proc = subprocess.run([str(produced)], input='{"id":1,"method":"ping"}\n',
                          capture_output=True, text=True, timeout=60)
    replies = []
    for line in proc.stdout.splitlines():
        try:
            replies.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    ping = next((r for r in replies if r.get("id") == 1), {})
    if proc.returncode != 0 or not ping.get("ok"):
        print("Smoke test FAILED:\n" + proc.stdout + proc.stderr, file=sys.stderr)
        return 1
    if args.with_ffmpeg:
        result = ping.get("result", {})
        if not all(result.get(tool) for tool in ("ffmpeg", "ffprobe")):
            print("Smoke test FAILED: bundled media tools were not found.", file=sys.stderr)
            return 1
    print("Smoke test passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

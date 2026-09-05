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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-ffmpeg", metavar="DIR",
                    help="Directory holding ffmpeg/ffprobe to bundle into the binary. "
                         "Omit to rely on ffmpeg being installed on the target machine.")
    args = ap.parse_args()

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

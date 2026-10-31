"""Entry point for both `python main.py` and the PyInstaller bundle."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# The RPC pipes carry UTF-8 both ways (Gujarati place names, non-English
# footage paths). Electron asks for that with PYTHONIOENCODING/PYTHONUTF8, but
# the frozen PyInstaller build ignores those variables and falls back to the
# Windows code page, which garbles such text — so set it here as well.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")

from vingest.server import main

if __name__ == "__main__":
    main()

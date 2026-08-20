"""Entry point for both `python main.py` and the PyInstaller bundle."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from vingest.server import main

if __name__ == "__main__":
    main()

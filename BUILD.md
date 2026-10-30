# AV Backup — Setup & Build Guide

How to run this app on another PC, and how to turn the source into a Windows
`.exe` installer.

The GitHub zip is **source code**, not a ready `.exe`. On a new machine you
either **run it from source** (Option A) or **build an installer** (Option B).

---

## How it fits together

- `electron/` — the desktop UI (Electron).
- `renderer/` — the app's screens (HTML/JS/CSS).
- `python/vingest/` — the "engine" that does the scanning, planning, renaming.
- At startup the app looks for a bundled engine `vingest-core.exe`. If it isn't
  there (i.e. you didn't build an installer), it falls back to running
  `python/main.py` with the Python installed on the machine.

**Dependencies**

- **Node.js LTS** — required to run or build.
- **Python 3** — required to run from source, and to build the installer.
  On Windows the `py` launcher (bundled with python.org installers) is enough.
- **ffmpeg / ffprobe** — *optional but recommended*. It reads clip durations and
  codecs. The informal **Rename & fix clip counts** tool and the clip-count
  feature work fine without it. If missing, the app still runs and shows an
  "ffprobe missing" note; use the in-app **Locate ffprobe** button to point at it.
- The Python engine itself needs **only the standard library** — `xxhash` and
  `pyinstaller` (in `requirements.txt`) are optional (xxhash = faster checksums;
  pyinstaller = only for building an installer).

---

## Option A — Run from source (quickest)

Best when the other PC can have Node + Python installed.

1. Install **Node.js LTS** (https://nodejs.org) and **Python 3**
   (https://python.org — tick **Add Python to PATH**). Optionally install
   **ffmpeg** and add it to PATH.
2. Download and unzip the repo.
3. Open a terminal **in the project folder** and run:

```
npm install
```

```
npm start
```

The app launches and starts the Python engine from source automatically.
If it reports ffprobe missing, install ffmpeg or click **Locate ffprobe**.

---

## Option B — Build a Windows installer `.exe`

Produces a single installer you double-click; the target PC then needs nothing
else installed.

> **Must be built on Windows.** PyInstaller cannot cross-compile, so a Windows
> `.exe` engine has to be frozen on a Windows machine. Build once, then copy the
> installer to any Windows PC.

**First, in PowerShell (once per Windows user):** allow the npm/npx script shims
to run. Without this, `npm install` / `npm run` fail with *"running scripts is
disabled on this system"*. Open **Windows PowerShell** and run:

```
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Answer `Y` when prompted. This affects only your user account, not the machine.
(`RemoteSigned` lets local scripts run; use `Bypass` instead if your policy is
locked down further. To check the current setting: `Get-ExecutionPolicy -List`.)

On a Windows build machine that has Node + Python:

```
npm install
```

```
python -m pip install pyinstaller xxhash
```

```
npm run dist:win
```

Output (the version number matches `version` in `package.json`):

- **`dist\AV Backup Setup <version>.exe`** — the installer. Copy it to the other
  PC and run it. It installs for the current user only, so it needs no admin rights.
- **`dist\AV Backup-<version>-win.zip`** — the portable copy. Nothing is installed:
  unzip it anywhere you can write (Desktop, Documents, a USB drive) and run
  `AV Backup.exe` inside. Use this where installers are blocked. Settings are
  kept in `%APPDATA%\AV Backup` either way.

Nothing else needs to be installed on the target machine: the Python engine
**and ffmpeg/ffprobe** are frozen inside both. The event-schedule reader is too:
its OCR (tesseract.js with the English and Gujarati language files) and PDF
reader (pdf.js) are npm `dependencies`, so `npm install` / `npm ci` fetches them
on the build machine and electron-builder packs them into the app. The OCR files
are kept unpacked (`asarUnpack` in `package.json`) because Tesseract reads them
from disk, and on first use they are copied to `%APPDATA%\AV Backup\ocr`. The
app needs no internet at any point.

### ffmpeg is bundled automatically

`npm run dist:win` freezes ffmpeg into the engine on its own — it looks for
`ffmpeg.exe` / `ffprobe.exe` on your **PATH** first, then the usual install
folders (`C:\ffmpeg\bin`, `C:\Program Files\ffmpeg\bin`). The build log prints
`Auto-detected ffmpeg at …` and its smoke test fails the build if the bundled
tools don't actually run, so a green build is a guarantee the installer is
self-contained.

- **ffmpeg somewhere unusual?** Point at it explicitly:
  `npm run bundle:python -- --with-ffmpeg "D:\tools\ffmpeg\bin"` then
  `npx electron-builder --win`.
- **Deliberately ship without ffmpeg** (target already has it on PATH):
  `npm run bundle:python -- --no-ffmpeg` then `npx electron-builder --win`.

Get ffmpeg for Windows from gyan.dev or BtbN — unzip it and either add its `bin`
folder to PATH or drop it at `C:\ffmpeg\bin`, and the build finds it.

---

## macOS (for reference)

A Mac build is produced the same way but on a Mac (again, no cross-compiling):

```
npm install
```

```
npm run dist:mac
```

Helper scripts for macOS live in `scripts/macos.sh` (`setup:mac`, `dist:mac`).

---

## Handy commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the app from source (dev). |
| `npm run bundle:python` | Freeze the Python engine to `dist-python/` (auto-includes ffmpeg; `-- --with-ffmpeg "<dir>"` to force a folder, `-- --no-ffmpeg` to skip). |
| `npm run dist:win` | Bundle the engine (with ffmpeg) **and** build the Windows installer plus the portable ZIP. |
| `npm run dist:mac` | Same, for macOS. |
| `python -m pytest tests/ -q` | Run the engine test suite. |

---

## Troubleshooting

- **"Could not start the Python engine"** (running from source): Python isn't on
  PATH. Install Python 3 with **Add to PATH**, reopen the terminal, retry. You
  can also force a specific interpreter via the `VINGEST_PYTHON` environment
  variable (full path to `python.exe`).
- **"running scripts is disabled on this system"** / `npm : File … .ps1 cannot
  be loaded` (PowerShell): the execution policy blocks the npm/npx shims. Run
  `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once,
  answer `Y`, then reopen PowerShell. (Affects your user only.)
- **"Python 3 with PyInstaller was not found"** (building): run
  `python -m pip install pyinstaller xxhash`, then retry `npm run dist:win`.
- **Durations/codecs show as blank**: ffmpeg/ffprobe isn't found. Install ffmpeg
  (and add to PATH) or bundle it as shown above, or use **Locate ffprobe**.
- **Installer built but the app won't start on the target**: you likely built on
  a different OS than the target. Build the Windows installer on Windows.

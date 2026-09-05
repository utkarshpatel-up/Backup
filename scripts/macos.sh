#!/bin/bash
# Run with bash; compatible with the Bash 3.2 shipped by macOS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE="${1:-run}"
case "$MODE" in setup|run|build) ;; *) echo 'Usage: bash scripts/macos.sh [setup|run|build]' >&2; exit 2 ;; esac
if [ "$(uname -s)" != Darwin ]; then
  echo 'This script requires macOS. Use the Build macOS workflow from Windows.' >&2
  exit 1
fi
if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  echo 'Open Terminal without Rosetta and rerun to build for Apple Silicon.' >&2
  exit 1
fi
trap 'echo "Setup/build failed. Resolve the error above and rerun this script." >&2' ERR

# Prefer tools that are already installed (Node, Python 3.9+, ffmpeg), whatever
# their source — an official .pkg installer, a static build, or Homebrew. Only
# when something is missing do we reach for Homebrew, and only then do we install
# Homebrew itself. This keeps the script working on macOS releases Homebrew no
# longer ships bottles for, where `brew install` would try to compile from source.
BREW=""
ensure_brew() {
  if [ -n "$BREW" ]; then return 0; fi
  if [ "$(uname -m)" = arm64 ]; then BREW=/opt/homebrew/bin/brew; else BREW=/usr/local/bin/brew; fi
  if [ ! -x "$BREW" ]; then
    echo 'A required tool is missing and Homebrew is not installed.'
    echo 'Installing Homebrew; macOS may request an administrator password and Command Line Tools.'
    echo 'On an older macOS you may prefer to install Node, Python 3.12 and ffmpeg from their'
    echo 'own installers instead, then rerun this script — it will use them and skip Homebrew.'
    INSTALLER="$(mktemp -t vingest-homebrew)"
    curl --fail --show-error --location --proto '=https' --tlsv1.2 \
      https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$INSTALLER"
    /bin/bash "$INSTALLER"
    rm -f "$INSTALLER"
  fi
  eval "$("$BREW" shellenv)"
}

# Python for the engine venv: use any installed python3 that is 3.9 or newer.
PYTHON=""
for cand in python3.12 python3.13 python3.11 python3.10 python3.14 python3; do
  if command -v "$cand" >/dev/null 2>&1 \
     && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 9) else 1)' 2>/dev/null; then
    PYTHON="$("$cand" -c 'import sys; print(sys.executable)')"
    echo "Using Python: $PYTHON"
    break
  fi
done
if [ -z "$PYTHON" ]; then
  echo 'No Python 3.9+ found; installing python@3.12 via Homebrew.'
  ensure_brew
  "$BREW" list --versions python@3.12 >/dev/null 2>&1 || "$BREW" install python@3.12
  PYTHON="$("$BREW" --prefix python@3.12)/bin/python3.12"
fi

# Node: use an existing install; otherwise install node@22 via Homebrew.
if command -v node >/dev/null 2>&1; then
  echo "Using Node: $(command -v node)"
else
  echo 'Node not found; installing node@22 via Homebrew.'
  ensure_brew
  "$BREW" list --versions node@22 >/dev/null 2>&1 || "$BREW" install node@22
  export PATH="$("$BREW" --prefix node@22)/bin:$PATH"
fi

# ffmpeg + ffprobe: use existing installs; otherwise install ffmpeg via Homebrew.
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  echo "Using ffmpeg: $(command -v ffmpeg)"
else
  echo 'ffmpeg/ffprobe not found; installing ffmpeg via Homebrew.'
  ensure_brew
  "$BREW" list --versions ffmpeg >/dev/null 2>&1 || "$BREW" install ffmpeg
  export PATH="$("$BREW" --prefix ffmpeg)/bin:$PATH"
fi
FFMPEG_BIN="$(cd "$(dirname "$(command -v ffmpeg)")" && pwd)"

"$PYTHON" -m venv .venv-mac
export VINGEST_PYTHON="$ROOT/.venv-mac/bin/python"
"$VINGEST_PYTHON" -m pip install -r requirements.txt
node --version
"$VINGEST_PYTHON" --version
ffmpeg -version
ffprobe -version
# Always install on this OS: node_modules copied from Windows is not usable.
npm ci
case "$MODE" in
  setup) echo 'Dependencies are ready. Use Start AV Backup.command to launch.' ;;
  run) npm start ;;
  build)
    ARCH="$(node -p 'process.arch')"
    "$VINGEST_PYTHON" -m pip install pytest
    "$VINGEST_PYTHON" -m pytest tests/ -q
    npm run test:renderer
    npm run bundle:python -- --with-ffmpeg "$FFMPEG_BIN"
    npx --no-install electron-builder --mac dmg zip "--$ARCH" --publish never
    echo "DMG and ZIP created in $ROOT/dist ($ARCH)."
    ;;
esac

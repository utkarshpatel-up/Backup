#!/bin/bash
# Build the AV Backup .dmg on an OLDER macOS (e.g. 12 Monterey) WITHOUT Homebrew.
#
# Homebrew no longer ships prebuilt bottles for old macOS, so `brew install` tries
# to compile Node from source and fails. This launcher instead uses Node, Python
# 3.9+, and ffmpeg/ffprobe that you have already installed from their own
# installers, and builds the DMG from those.
#
# On macOS 13 (Ventura) or newer, use the standard "Build macOS DMG.command".
set -euo pipefail
cd "$(dirname "$0")" || exit 1
ROOT="$PWD"

fail() { echo ""; echo "ERROR: $1" >&2; echo ""; read -r -p 'Press Return to close...'; exit 1; }

echo "AV Backup — DMG build for older macOS (no Homebrew)"
echo "Project: $ROOT"
echo ""

# --- Locate the required tools; do not install anything ---
PYTHON=""
for cand in python3.12 python3.13 python3.11 python3.10 python3.14 python3; do
  if command -v "$cand" >/dev/null 2>&1 \
     && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 9) else 1)' 2>/dev/null; then
    PYTHON="$("$cand" -c 'import sys; print(sys.executable)')"; break
  fi
done
[ -n "$PYTHON" ]                 || fail "Python 3.9+ not found. Install it from python.org, then rerun."
command -v node    >/dev/null 2>&1 || fail "Node not found. Install it from nodejs.org (.pkg), then rerun."
command -v ffmpeg  >/dev/null 2>&1 || fail "ffmpeg not found. Put ffmpeg and ffprobe in /usr/local/bin, then rerun."
command -v ffprobe >/dev/null 2>&1 || fail "ffprobe not found. Put ffmpeg and ffprobe in /usr/local/bin, then rerun."
FFMPEG_BIN="$(cd "$(dirname "$(command -v ffmpeg)")" && pwd)"

echo "Python: $PYTHON"
echo "Node:   $(command -v node)  ($(node --version))"
echo "ffmpeg: $(command -v ffmpeg)"
echo ""

# --- Install dependencies into a local virtual environment ---
echo "==> Setting up the Python engine environment"
"$PYTHON" -m venv .venv-mac
export VINGEST_PYTHON="$ROOT/.venv-mac/bin/python"
"$VINGEST_PYTHON" -m pip install --upgrade pip >/dev/null
"$VINGEST_PYTHON" -m pip install -r requirements.txt

echo "==> Installing Node dependencies"
npm ci

# --- Run the test suites (same as the standard build) ---
echo "==> Running tests"
"$VINGEST_PYTHON" -m pip install pytest >/dev/null
"$VINGEST_PYTHON" -m pytest tests/ -q || fail "Python tests failed."
npm run test:renderer || fail "Renderer tests failed."

# --- Bundle the engine (with ffmpeg) and build the DMG (unsigned) ---
ARCH="$(node -p 'process.arch')"
echo "==> Bundling the engine and building the DMG for $ARCH"
npm run bundle:python -- --with-ffmpeg "$FFMPEG_BIN"
# Skip code signing: this is a local build with no Developer ID certificate.
CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx --no-install electron-builder --mac dmg zip "--$ARCH" --publish never

echo ""
echo "Done. The DMG and ZIP are in: $ROOT/dist ($ARCH)"
echo "The build is unsigned, so the first time you open it, right-click the app"
echo "and choose Open to get past macOS Gatekeeper."
echo ""
read -r -p 'Press Return to close...'

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

if [ "$(uname -m)" = arm64 ]; then
  BREW=/opt/homebrew/bin/brew
else
  BREW=/usr/local/bin/brew
fi
if [ ! -x "$BREW" ]; then
  echo 'Installing Homebrew; macOS may request an administrator password and Command Line Tools.'
  INSTALLER="$(mktemp -t vingest-homebrew)"
  trap 'rm -f "$INSTALLER"' EXIT
  curl --fail --show-error --location --proto '=https' --tlsv1.2 \
    https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$INSTALLER"
  /bin/bash "$INSTALLER"
fi
eval "$("$BREW" shellenv)"
# Use known major versions without changing the user's global default links.
for formula in python@3.12 node@22 ffmpeg; do
  if ! "$BREW" list --versions "$formula" >/dev/null 2>&1; then
    "$BREW" install "$formula"
  fi
done
export PATH="$("$BREW" --prefix node@22)/bin:$("$BREW" --prefix ffmpeg)/bin:$PATH"
PYTHON="$("$BREW" --prefix python@3.12)/bin/python3.12"
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
  setup) echo 'Dependencies are ready. Use Start Video Ingest.command to launch.' ;;
  run) npm start ;;
  build)
    ARCH="$(node -p 'process.arch')"
    "$VINGEST_PYTHON" -m pip install pytest
    "$VINGEST_PYTHON" -m pytest tests/ -q
    npm run test:renderer
    npm run bundle:python -- --with-ffmpeg "$("$BREW" --prefix ffmpeg)/bin"
    npx --no-install electron-builder --mac dmg zip "--$ARCH" --publish never
    echo "DMG and ZIP created in $ROOT/dist ($ARCH)."
    ;;
esac

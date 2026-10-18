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

# ffmpeg + ffprobe. A release always bundles the pinned, self-contained builds
# below: they need only macOS 12 (Monterey) and no Homebrew. Homebrew's ffmpeg is
# built for the build Mac's own macOS (the CI runner is macOS 15), so bundling it
# shipped an ffprobe that cannot start on older Macs and stalled every drive scan.
# Running from source uses an ffmpeg already on PATH, else the same pinned build.
FFMPEG_VERSION=9.0.2
fetch_static_ffmpeg() {
  local base sum_ffprobe sum_ffmpeg dir tool sum zip
  case "$(uname -m)" in
    arm64)
      base=https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2
      sum_ffprobe=fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6
      sum_ffmpeg=c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924 ;;
    x86_64)
      base=https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2
      sum_ffprobe=2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd
      sum_ffmpeg=7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4 ;;
    *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  dir="$ROOT/.ffmpeg-mac/$(uname -m)-$FFMPEG_VERSION"
  mkdir -p "$dir"
  for tool in ffprobe ffmpeg; do
    [ -x "$dir/$tool" ] && continue
    if [ "$tool" = ffprobe ]; then sum="$sum_ffprobe"; else sum="$sum_ffmpeg"; fi
    zip="$dir/$tool.zip"
    echo "Downloading self-contained $tool $FFMPEG_VERSION for $(uname -m) (macOS 12+)..."
    curl --fail --show-error --location --retry 5 --retry-delay 5       --connect-timeout 30 -o "$zip" "$base/$tool.zip"
    if ! echo "$sum  $zip" | shasum -a 256 -c - >/dev/null; then
      rm -f "$zip"
      echo "Checksum mismatch for $tool.zip; refusing to use it." >&2
      exit 1
    fi
    unzip -o -q "$zip" "$tool" -d "$dir"
    rm -f "$zip"
    chmod +x "$dir/$tool"
    xattr -d com.apple.quarantine "$dir/$tool" 2>/dev/null || true
  done
  FFMPEG_BIN="$dir"
}
if [ "$MODE" = build ]    || ! { command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; }; then
  fetch_static_ffmpeg
  export PATH="$FFMPEG_BIN:$PATH"
else
  FFMPEG_BIN="$(cd "$(dirname "$(command -v ffmpeg)")" && pwd)"
fi
echo "Using ffmpeg: $FFMPEG_BIN/ffmpeg"

"$PYTHON" -m venv .venv-mac
export VINGEST_PYTHON="$ROOT/.venv-mac/bin/python"
"$VINGEST_PYTHON" -m pip install -r requirements.txt
node --version
"$VINGEST_PYTHON" --version
"$FFMPEG_BIN/ffmpeg" -version
"$FFMPEG_BIN/ffprobe" -version
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
    npx --no-install electron-builder --mac dmg "--$ARCH" --publish never
    # Every binary in the finished app must run on the oldest supported macOS
    # (12, Monterey); fail here rather than ship a DMG that cannot start there.
    "$VINGEST_PYTHON" scripts/check_macos_min.py dist
    echo "DMG created in $ROOT/dist ($ARCH)."
    ;;
esac

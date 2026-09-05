# macOS setup and DMG

Copy or clone this whole project onto a Mac. In Terminal, change to the project
folder and run:

```bash
bash scripts/macos.sh run
```

This installs Homebrew if missing, then Python 3.12, Node.js 22, FFmpeg (including
ffprobe), Python requirements in `.venv-mac`, and Electron dependencies. It then
starts the app. Internet access is needed for setup; Homebrew's initial setup may
request an administrator password and Apple's Command Line Tools. Installation
errors stop the script; fix the reported error and rerun. Existing Homebrew
packages are reused. Use `bash scripts/macos.sh setup` to install without launching.

For Finder launchers, enable their executable permissions once:

```bash
chmod +x "Start AV Backup.command" "Build macOS DMG.command"
```

Then double-click **Start AV Backup.command** or **Build macOS DMG.command**.
The Terminal commands work even when a downloaded ZIP loses executable bits.
The source launcher checks dependencies on every run and requires network access;
the installed app from the DMG runs without this setup step.

## Build on a Mac

```bash
bash scripts/macos.sh build
```

The script installs dependencies, runs Python and renderer tests, freezes the
engine with FFmpeg/ffprobe and their dependencies through PyInstaller, smoke-tests
the engine, and builds a DMG and ZIP in `dist/`. `npm run dist:mac` uses the same
flow once Node is installed. Each build targets the Mac's native architecture:

- Apple Silicon: `AV Backup-1.0.0-mac-arm64.dmg`
- Intel: `AV Backup-1.0.0-mac-x64.dmg`

Use a native Terminal on Apple Silicon (disable Open using Rosetta). Build each
architecture on its matching Mac; these are separate installers, not a universal
binary. Build-machine and dependency OS minimums apply; older macOS versions
have not been validated.

Open the matching DMG, drag **AV Backup** to **Applications**, eject the image,
and launch the installed app. Electron supplies its Node runtime, and the frozen
engine supplies Python and the media tools. Recipients need no Homebrew, Python,
Node, or FFmpeg installation.

## Build from Windows using GitHub Actions

The workflow `.github/workflows/build-macos.yml` builds on native macOS 15 runners
for Apple Silicon and Intel. After committing and pushing these files to GitHub,
open **Actions → Build macOS → Run workflow**. Download the corresponding
`AV-Backup-mac-arm64` or `AV-Backup-mac-x64` artifact from the completed run
and extract its DMG. The workflow uploads build artifacts only; it does not
publish a release. GitHub Actions usage limits and billing apply.

This workflow deliberately builds without an Apple Developer certificate. Such
builds are not notarized and macOS Gatekeeper may block first launch. For public
distribution, configure Developer ID signing and Apple notarization credentials
and validate the signed app on a clean Mac. Do not disable Gatekeeper globally.
FFmpeg builds from Homebrew may include GPL components; review and supply the
applicable license notices and corresponding source when distributing them.

Windows cannot build this app's macOS Python engine or validate a DMG. A successful
macOS workflow and a clean-Mac launch/media test are still required before release.

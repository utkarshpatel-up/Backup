# Releasing an update

Installed copies of AV Backup check GitHub Releases when they start (and from the
**Check again** button in the sidebar). A release is made by pushing a version tag;
`.github/workflows/release.yml` does the rest.

## Steps

1. Set the new version in `package.json` (`"version": "1.7.1"`), then run
   `npm install --package-lock-only` so the lock file matches.
2. Add a `## 1.7.1` section at the top of `CHANGELOG.md`, written for operators. The
   app shows it under **What's new**. The release stops if it is missing.
3. Commit, then tag and push:

   ```bash
   git tag v1.7.1
   git push origin HEAD v1.7.1
   ```

4. Watch **Actions → Release** on GitHub (about 20–30 minutes). It builds Windows and
   both Macs, uploads them to a draft release, and publishes it only when all three
   builds pass. If one fails, nothing is published: fix it, then delete the tag and
   push it again (`git push origin :v1.7.1`, `git tag -f v1.7.1`, `git push origin v1.7.1`).

## What operators see

- **Windows (installed with the Setup .exe):** "Version 1.7.1 is available", then
  **Download update** (only the changed parts are downloaded) and **Restart to update**.
  Unsaved edits are saved first, as when closing the app.
- **Mac:** **Download installer** saves the DMG to Downloads and opens it. Quit AV
  Backup, drag it into Applications, replace the old copy, and reopen. The Mac builds
  are not signed with an Apple Developer ID, so macOS does not let the app replace
  itself, and the first launch may need right-click, **Open**.
- **Windows portable zip, or running from source:** **Open download page**.

Copies older than 1.7.0 have no updater: install 1.7.0 by hand once on each computer.

## Release files

| File | Used by |
|---|---|
| `AV-Backup-Setup-<v>.exe`, `.exe.blockmap`, `latest.yml` | Windows installer and its in-app updates |
| `AV-Backup-<v>-win.zip` | Windows portable copy |
| `AV-Backup-<v>-mac-arm64.dmg`, `-mac-x64.dmg` | Macs with Apple Silicon or Intel |

Do not rename or remove `latest.yml` or the `.blockmap`: installed Windows copies need
them to update.

# Video Ingest

Desktop app (macOS + Windows) that turns camera originals on the ProRes and
H.265 SSDs into the house folder structure, names everything from the media
itself, and then proves the two drives match.

```
3017 Dt-16 Aug 2026/
  Adalaj Soneri … General Satsang E. Dt-16-Aug-26 Dur-54m1s/
    MASTER01 Dt-16-Aug-26 Dur-54m1s.mov
    Clips for Insert/
      Cam-01/  C0031 Dt-16-Aug-26 Dur-2m14s.mov
      Cam-02/  …
      Cam-03/  …
    _manifest/   manifest 16-Aug-26 142633.json + .csv
```

`Dur-` comes from ffprobe. `Dt-` comes from the file's last-modified time
(falling back to the container's creation time when that is earlier and more
trustworthy). Each clip is dated from its **own** timestamp, so a shoot that
rolls past midnight is dated correctly per clip.

## Running it

```bash
npm install
npm start
```

Requires Python 3.9+ and ffmpeg on `PATH`. On macOS: `brew install ffmpeg`.
If ffprobe lives somewhere unusual, the app has a **Locate ffprobe** button and
remembers the choice.

## The five steps

1. **Sources** — lists removable drives (never your system disk). Press
   *Probe codecs* and it ffprobes the largest files on each drive and assigns
   ProRes / H.265 roles, showing its confidence and reasoning. Roles are always
   yours to override. Folders and `.zip` archives can be added as sources too;
   a zip is extracted to a temp folder with its original timestamps restored,
   because the naming depends on them.
2. **Session** — job number, title, shoot date, with a live preview of the exact
   folder name. Choose copy vs move and the verification level.
3. **Cameras** — every clip listed with length, codec, resolution and
   last-modified time. Mark one file **Master** and assign the rest to cams.
   *Auto-suggest* groups by resolution + fps + codec as a starting point.
   **Mirror** matches your choices onto the second SSD: by filename stem first,
   then by duration + wall-clock time when the stems disagree.
4. **Copy** — the full plan is shown first: every source file, its destination
   folder, and its new name. Nothing is written until you press Start.
   Progress shows throughput and ETA and can be cancelled mid-file.
5. **Verify** — compares the session folders (and the SD card, if you add it).

## Design decisions worth knowing

**Size differences between drives are not errors.** The whole point of the two
SSDs is that they hold different encodings. The comparison only treats a size
difference as a fault when *both sides are the same codec family*; across
families it is reported as expected. What it does check strictly is duration,
presence, folder tree, and whether each filename's `Dur-` token agrees with the
actual media — a name that lies about its own content is flagged.

**Re-running is safe.** Renames are idempotent: the `Dt-`/`Dur-` tokens are
stripped before being re-applied, so a second pass never produces
`… Dur-54m1s Dur-54m1s.mov`. Files already present at the right size are
skipped, so an interrupted transfer resumes rather than restarting.

**A cancelled copy leaves no half-file wearing a real name.** Files are written
to `.vingest-part` and renamed only once complete and verified. In move mode,
the original is deleted only after the copy verifies.

**Manifests are excluded from comparison.** Each session folder gets a
`_manifest/` JSON + CSV recording what was copied, with durations, codecs and
statuses. They differ per drive by design, so the comparison skips them.

## Packaging

PyInstaller does not cross-compile — build on each OS you ship for.

```bash
python3 -m pip install pyinstaller xxhash
python3 scripts/build_python.py                      # engine only
python3 scripts/build_python.py --with-ffmpeg /opt/homebrew/bin   # self-contained
npm run dist:mac      # or dist:win
```

Bundling ffmpeg makes the app work on a machine with nothing installed; check
that FFmpeg's LGPL/GPL terms suit how you distribute it. Without `--with-ffmpeg`
the target machine needs ffmpeg on `PATH`.

## Tests

```bash
python3 -m venv .venv && .venv/bin/pip install pytest xxhash
.venv/bin/python -m pytest tests/ -q
```

38 tests covering duration formatting, name idempotency, exFAT
case-insensitive de-duplication, cross-drive pairing, comparison severity
rules, and the cancel-leaves-no-partial-file guarantee.

## Architecture

Electron shell → `electron/python-bridge.js` → Python engine over JSON-lines
stdio. The renderer is sandboxed: `contextIsolation` on, no Node integration,
and a narrow preload API. All media work (ffprobe, copying, hashing, comparing)
happens in Python; long jobs run on worker threads so Cancel is always
responsive.

| Module | Role |
|---|---|
| `python/vingest/naming.py` | Folder/file name construction, parsing, sanitising |
| `python/vingest/probe.py` | ffprobe wrapper, codec-family classification, role assignment |
| `python/vingest/sources.py` | Volume detection (mac/Win/Linux), zip handling, eject |
| `python/vingest/ingest.py` | Cross-drive pairing, plan building, copy execution |
| `python/vingest/compare.py` | Snapshots, fast comparison, checksum verification |
| `python/vingest/hashing.py` | xxhash with a stdlib blake2b fallback |
| `python/vingest/report.py` | Session manifests |
| `python/vingest/server.py` | JSON-lines RPC loop |

## Known limits

- Cam assignment is manual by design, with auto-suggest as a hint only.
- Checksum verification between the ProRes and H.265 drives is meaningless
  (different encodings); use it to verify a copy against its own source.
- Zip sources extract to a temp folder, so a large zip needs the free space.

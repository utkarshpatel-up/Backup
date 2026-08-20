# Video Ingest

Desktop app (macOS + Windows) that turns camera originals on the ProRes and
H.265 SSDs into the house folder structure, names everything from the media
itself, and then proves the two drives match.

```
3017 Dt-16 Aug 2026/
  Adalaj Soneri … General Satsang E. Dt-16-Aug-26 Dur-54m1s/   ← only Dur- is generated
    Adalaj Soneri … - Program.mov                              ← name untouched
    Clips for Insert/
      Cam-01/  Cam A - Wide - Take 1.mov                       ← name untouched
      Cam-02/  …
      Cam-03/  …
    _manifest/   manifest 16-Aug-26 142633.json + .csv
```

## The naming rule

**Nothing is typed.** The session folder already exists on the drive with its
name already correct — the app finds it, reads that name off the disk, and
appends the one thing it can work out for itself:

```
Adalaj Soneri … General Satsang E. Dt-16-Aug-26
                    ↓  ffprobe reads the master: 3241.9s
Adalaj Soneri … General Satsang E. Dt-16-Aug-26 Dur-54m1s
```

`Dur-` is *replaced*, not appended, so a folder that already carries a token is
either left alone (if it is right) or corrected (if it is wrong) — never
doubled. If the token is already correct the folder is not renamed at all.

**Media files are never renamed.** They arrive already named — from the zip, the
card, or the editor — and land in their cam folder byte-identical, name
included. Case, spaces, punctuation and extension all survive. The master is not
moved at all; it stays where it sits at the top of the session folder.

The one case where a filename changes: if two different source files would land
in the same cam folder under the same name, the second becomes `name (2).ext`
rather than silently overwriting the first. The plan flags it when it happens.

### How the folder is found

In order of confidence: the folder containing **“Clips for Insert”**; failing
that, a folder whose name carries a `Dt-` token; failing that, the single folder
a zip unpacked to. Whatever it settles on is shown to you with its reasoning,
and you can point it somewhere else. If nothing is recognisable it says so and
offers to build a folder from a name you type — the only path where typing is
involved, and it exists for loose footage that was never structured.

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
2. **Folder** — the session folder found on the drive, shown with the reason it
   was chosen and a preview of the completed name with the added `Dur-` in bold.
   Pick the master file (it defaults to the longest recording at the folder's
   top level, which is what sets the token), then choose move vs copy.
3. **Cameras** — every unfiled clip listed with length, codec, resolution and
   last-modified time; clips already sitting in a cam folder come pre-selected
   and are not re-copied. Assign the rest to cams.
   *Auto-suggest* groups by resolution + fps + codec as a starting point.
   **Mirror** matches your choices onto the second SSD: by filename stem first,
   then by duration + wall-clock time when the stems disagree.
4. **Copy** — the full plan is shown first: the folder rename, and every clip
   with the cam folder it lands in. Nothing is written until you press Start.
   Progress shows throughput and ETA and can be cancelled mid-file.
5. **Verify** — compares the session folders (and the SD card, if you add it).

## Design decisions worth knowing

**Size differences between drives are not errors.** The whole point of the two
SSDs is that they hold different encodings. The comparison only treats a size
difference as a fault when *both sides are the same codec family*; across
families it is reported as expected. The same goes for the container: the two
drives often write `.mov` and `.mp4` for one shot, so the extension is left out
of the matching key and a difference is reported as information rather than a
missing file. What it does check strictly is duration, presence and folder tree.

**Re-running is safe.** The folder name is idempotent (see above), and files
already present at the right size are skipped, so an interrupted transfer
resumes rather than restarting.

**The folder is renamed last, and only on success.** Renaming first would
invalidate the source paths of everything inside it; renaming after a failure
would stamp a finished-looking name on an incomplete folder. So the clips are
filed first, and the `Dur-` token goes on only once every file has landed and
verified. Cancel or fail partway and the folder keeps its original name, which
is also the signal to run it again.

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

58 tests covering duration formatting, the "filenames are never changed"
contract, session-folder detection, `Dur-` correction and idempotency, the
rename-only-on-success guarantee, exFAT case-insensitive de-duplication,
cross-drive pairing, `.mov`/`.mp4` tolerance, comparison severity rules, and the
cancel-leaves-no-partial-file guarantee. Tests needing real media are skipped
automatically when ffmpeg is absent.

## Architecture

Electron shell → `electron/python-bridge.js` → Python engine over JSON-lines
stdio. The renderer is sandboxed: `contextIsolation` on, no Node integration,
and a narrow preload API. All media work (ffprobe, copying, hashing, comparing)
happens in Python; long jobs run on worker threads so Cancel is always
responsive.

| Module | Role |
|---|---|
| `python/vingest/structure.py` | Finding the session folder a source already carries |
| `python/vingest/naming.py` | Token construction, parsing, sanitising |
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

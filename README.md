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

**The token is written in the shape the folder already uses.** Real folder names
come in more than one form — `Dur-54m1s` (minutes + seconds) and `Dur-1h0m`
(hours + minutes, no seconds) — so the app reads the smallest unit the existing
name uses and matches it, rather than imposing one format:

| Existing name | Master | Result |
|---|---|---|
| `… Dur-1h0m` | 3601s | `… Dur-1h0m` |
| `… Dur-1h0m` | 3241s | `… Dur-54m` |
| `… Dur-54m1s` | 3601s | `… Dur-1h0m1s` |
| no token yet | 3241s | `… Dur-54m1s` |

**Media files are never renamed.** They arrive already named — from the zip, the
card, or the editor — and land in their cam folder byte-identical, name
included. Case, spaces, punctuation and extension all survive. The master is not
moved at all; it stays where it sits at the top of the session folder.

The one case where a filename changes: if two different source files would land
in the same cam folder under the same name, the second becomes `name (2).ext`
rather than silently overwriting the first. The plan flags it when it happens.

### Where the folder name comes from

**The structure zip.** A zip holding the folder tree and no footage — the empty
`3017 Dt-16 Aug 2026/… Dt-16-Aug-26/Clips for Insert/Cam-01…03` skeleton. This is
the normal way a job starts. It supplies the session folder's name, the job
folder, and the cam layout; any `Dur-` placeholder it carries is replaced with
the real one. Its empty cam folders are recreated at the destination even when
no clip is assigned to them, because they are part of what the template defines.

The footage never comes from the zip — you point the app at the source drive and
pick it yourself, which is what the date suggestion below is for.

**A folder already on the drive.** If a source already contains the session
folder, the app finds it — by the "Clips for Insert" it holds, failing that a
`Dt-` token in its name — and completes that folder in place instead.

If neither applies, it offers to build a folder from a name you type. That is
the only path where typing is involved.

### Which files belong to this session

A working drive holds more than one shoot. The session folder's name already
states the shoot date (`Dt-16-Aug-26`), so once footage is loaded the app buckets
it by last-modified day and suggests the bucket matching that date:

```
2026-08-16   4 files   ★ session date     ← suggested
2026-08-18   2 files                        different shoot
```

The suggestion is applied automatically when it matches, and every other day
stays one click away — nothing is hidden, and the day buttons show the full
breakdown. Clips filtered out are also unassigned from any cam, so what you see
is exactly what gets copied.

Two cases it deliberately does **not** guess:

* If the folder name states no date, it falls back to the busiest day and says
  that is what it did.
* If the folder states a date and **nothing** on the source matches it, it makes
  no suggestion at all and says so — that mismatch usually means the wrong drive
  is plugged in, and quietly proposing another day's shoot would bury it.

### Sources and destinations

Each source gets its own destination, chosen on the Sources step and defaulting
to the source drive itself. So the ProRes drive can write to one place and the
H.265 drive to another, or both can organise themselves in place. The app warns
if two sources would write into the same folder.

Footage is selected manually: **Add files…** (multi-select) and **Add a
folder…** are on both the Folder and Cameras steps, alongside a scan of the whole
drive. Picking a folder pulls in every video beneath it.

## Running it

```bash
npm install
npm start
```

Requires Python 3.9+ and ffmpeg on `PATH`. On macOS: `brew install ffmpeg`.
If ffprobe lives somewhere unusual, the app has a **Locate ffprobe** button and
remembers the choice.

## The five steps

1. **Sources** — import the structure zip, then add the drives. Removable drives
   are listed automatically (never your system disk), or point at a folder. Press
   *Probe codecs* and it ffprobes the largest files on each drive and assigns
   ProRes / H.265 roles, showing its confidence and reasoning. Roles are always
   yours to override, and one source can be marked **Structure** to act as the
   template. Each footage source gets its own destination picker. Folders and
   `.zip` archives can be added too; a zip is extracted to a temp folder with
   its original timestamps restored, because the naming depends on them.
2. **Folder** — the folder name from the imported structure, previewed with the
   added `Dur-` in bold. Every footage drive gets its own Scan / Add files /
   Add a folder controls, and files from the session date are suggested. Pick the
   master from any drive — the one it sits on becomes the drive you assign cams
   against — then choose move vs copy.
3. **Cameras** — every clip in play listed with length, codec, resolution and
   last-modified time; clips already sitting in a cam folder come pre-selected
   and are not re-copied. Assign the rest to cams, then **Mirror** to apply the
   same assignment to the other drive.
   *Auto-suggest* groups by resolution + fps + codec as a starting point.

4. **Copy** — the full plan is shown first: the folder rename, and every clip
   with the cam folder it lands in. Nothing is written until you press Start.
   Progress shows throughput and ETA and can be cancelled mid-file.
5. **Verify** — compares the session folders (and the SD card, if you add it).

### How Mirror pairs the two drives

You assign clips to cams once, on the primary drive. **Mirror** finds each clip's
twin on the other drive so the same assignment can be applied to both:

1. **Filename stem**, case-insensitively, with any `Dt-`/`Dur-` tokens stripped.
   Both bodies record the same reel id, so this settles almost everything.
2. **Duration within 1.5s and last-modified within 15 minutes** for whatever is
   left, closest in time winning.

Each file on the second drive can only be claimed once, so two clips cannot pair
to the same twin. Anything unmatched is reported by name and filed on the primary
drive only — and if the *master* is what went unmatched, that is called out
separately, because without it the second drive's folder gets no `Dur-` token.

Both sides are matched from the footage actually in play — the clips you loaded,
narrowed by the day filter — not from a raw scan of each drive. Pairing raw
drives would happily match a clip from an unrelated shoot that happened to share
a reel id.

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

**An empty zip is not an empty import.** A structure template is nothing but
folders, and zip archives store folders in two different ways — some write a
directory entry per folder, others store only file paths and leave the folders
implied. Both are recognised, and folders are created before any file is
extracted, so a template made by either kind of tool imports correctly.

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

100 tests covering duration formatting, the "filenames are never changed"
contract, session-folder detection, `Dur-` correction and idempotency, the
rename-only-on-success guarantee, structure-template import (both zip layouts,
plus path-escape refusal), per-source destinations, the same-day footage
suggestion and its two refusal cases, mirror scoping, every `Dur-` token shape
and its carry-over, exFAT case-insensitive de-duplication,
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
- One structure template applies to the whole job; per-drive templates are not
  supported (and have never been needed, since both drives hold the same shoot).

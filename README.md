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

```
02 Coppell Shibir General Satsang E. Dt-06-Aug-26 Dur-1h41m Clips-02/
   Clips for Insert/
   Coppell Shibir General Satsang E. Dt-06-Aug-26 Dur-44m43s Clip-01.MOV
   Coppell Shibir General Satsang E. Dt-06-Aug-26 Dur-56m58s Clip-02.MOV
```

**Master clips are named after the folder they sit in.** The folder's leading
session number is dropped, its total `Dur-` is replaced by the clip's own, and a
`Clip-NN` says which one it is. Whatever the camera called the file
(`SHGINF_S001_S001_T004.MOV`) is discarded.

**The folder's `Dur-` is the total of its master clips**, and a `Clips-NN` token
records how many there are. With a single master there is no `Clips-` or `Clip-`
token and the clip's duration is, by definition, the folder's.

**Cam clips are never renamed.** Everything under `Clips for Insert` keeps the
name it arrived with — case, spaces, punctuation and extension. Only the two
things above are generated.

### How a duration is written

Every `Dur-` follows one rule: **hours + minutes at an hour or over, minutes +
seconds under**, seconds truncated rather than rounded.

| Length | Written |
|---|---|
| 44m 43s | `Dur-44m43s` |
| 54m 1.9s | `Dur-54m1s` |
| 1h 0m 42s | `Dur-1h0m` |
| 1h 41m 41s | `Dur-1h41m` |

A token already on a name is *replaced*, never appended to, so running the
ingest twice over the same folder is a no-op rather than
`… Dur-1h41m Dur-1h41m`.

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

### What gets copied

**The Cameras page is the decision.** A clip with a cam number is filed; a clip
on **Skip** is not. Nothing else — no hidden filter, no rule operating behind
the page. Everything loaded stays visible and one click from being included.

The shoot date only chooses each clip's **default**. The session folder states
its date (`Dt-20-Aug-26`), so clips carrying that timestamp arrive selected and
clips from other days arrive on Skip:

```
2026-08-20   8 clips   ★ session date     selected
2026-06-17  24 clips                      loaded, on Skip
```

Clicking a day selects that day and skips the rest; **Select all** takes
everything. A clip you add by hand is always selected, whatever date it carries
— drives frequently lose the original timestamps when footage is copied between
them, so a hand-picked file is trusted over its own metadata.

As a backstop the engine warns if a plan's clips span more than one day.

### Importing camera cards

**Import camera cards** on the Cameras page finds mounted cards and pulls their
clips in one step. Canon XF cards mount as `CanonA_0006`, `CanonB_0021` and hold
their footage at `XFVC/REEL_<n>`; the trailing number differs per card and is not
matched on — the folder structure identifies the card. Matching is
case-insensitive and several reels on one card are all collected.

The **letter identifies the body**, so `CanonA` lands in Cam-01, `CanonB` in
Cam-02, `CanonC` in Cam-03 — already assigned, and still changeable per clip.

Other layouts can be added to `CARD_LAYOUTS` in `sources.py`: each is a volume
prefix plus the folder path inside it.

### Sources and destinations

Each source gets its own destination, chosen on the Sources step and defaulting
to the source drive itself. So the ProRes drive can write to one place and the
H.265 drive to another, or both can organise themselves in place. The app warns
if two sources would write into the same folder.

Footage is selected manually: **Add files…** (multi-select) and **Add a
folder…** are on both the Folder and Cameras steps, alongside a scan of the whole
drive. Picking a folder pulls in every video beneath it.

## Running it

For automatic macOS dependency installation, Finder launchers, and Apple Silicon
or Intel DMG builds, see [the macOS setup guide](MACOS.md).

```bash
npm install
npm start
```

Requires Python 3.9+ and ffmpeg on `PATH`. On macOS: `brew install ffmpeg`.
On Windows, install Python from python.org (the `py` launcher is supported) and
install an FFmpeg build, then add its `bin` folder to `PATH`. `python`, `py -3`,
and `python3` are all detected automatically.
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
2. **Folder** — edit and preview the imported structure before copying: the job
   folder, session folder, camera-folder names, and camera-folder count. The
   generated `Dur-` remains visible in bold. Tick one master clip, or several if the session was
   recorded in more than one file; the names they will be given are shown. Every footage drive gets its own Scan / Add files /
   Add a folder controls, and files from the session date are suggested. Pick the
   master from any drive — the one it sits on becomes the drive you assign cams
   against. Only clips long enough to plausibly be the program recording are
   listed here, since a shoot's short camera clips would bury it; the full list
   is one click away. Then choose move vs copy.
3. **Cameras** — every loaded clip with length, codec, resolution and
   last-modified time, and the cam it goes to. **Import camera cards** refreshes
   the list from the cards mounted right now, removing files from cards that were
   ejected, and pre-assigns the current clips by card. **Auto-suggest by camera**
   splits loose clips by resolution, frame rate and codec. The selected camera
   clips are copied to both destination drives automatically.
   *Auto-suggest* groups by resolution + fps + codec as a starting point.

4. **Copy** — the full plan is shown first: the folder rename, and every clip
   with the cam folder it lands in. Nothing is written until you press Start.
   Progress shows throughput and ETA and can be cancelled mid-file.
5. **Verify** — compares the session folders (and the SD card, if you add it).

### How the two destination drives stay aligned

You assign each camera-card clip once. The same selected source clip is copied to
both destination drives, while each drive uses its own selected master recording.
Files on Skip, whole-drive scan results, recycle-bin contents, and selected master
clips can never enter the camera-copy plan.

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
npm run dist:mac      # macOS setup + tests + self-contained DMG; see MACOS.md
```

On Windows (PowerShell), the equivalent self-contained build is:

```powershell
py -3 -m pip install pyinstaller xxhash
npm install
npm run bundle:python -- --with-ffmpeg C:\ffmpeg\bin
npx electron-builder --win
```

The installer is written to `dist/`. Build the Windows installer on Windows:
PyInstaller cannot create a Windows engine executable from macOS or Linux.

Bundling ffmpeg makes the app work on a machine with nothing installed; check
that FFmpeg's LGPL/GPL terms suit how you distribute it. Without `--with-ffmpeg`
the target machine needs ffmpeg on `PATH`.

## Tests

```bash
python3 -m venv .venv && .venv/bin/pip install pytest xxhash
.venv/bin/python -m pytest tests/ -q
npm run test:renderer
```

140 Python tests plus 4 renderer selection tests covering duration formatting,
the camera-selection safety boundary, the "filenames are never changed"
contract, session-folder detection, `Dur-` correction and idempotency, the
rename-only-on-success guarantee, structure-template import (both zip layouts,
plus path-escape refusal), per-source destinations, the same-day footage
suggestion and its two refusal cases, camera-card discovery, stale-card refresh,
master-clip naming and multi-clip totals, every `Dur-` token shape, exFAT
case-insensitive de-duplication,
legacy cross-drive pairing, `.mov`/`.mp4` tolerance, comparison severity rules, and the
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
| `python/vingest/ingest.py` | Safe selection checks, plan building, copy execution |
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
#   B a c k u p  
 

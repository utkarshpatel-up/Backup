'use strict';

/* ------------------------------------------------------------------ state */

const state = {
  view: 'schedule',     // 'schedule' = the Event schedule page; 'steps' = the backup steps below
  step: 0,
  backupType: 'formal', // formal = mixer masters; informal = camera recordings only
  informalDest: '',    // one explicit output; camera cards are imported later on Page 3
  engine: { ready: false, info: null, error: null },
  volumes: [],
  sources: [],          // {path, label, kind, role, report}
  assignment: null,
  scans: {},            // sourcePath -> {files, suggestion}
  detected: {},         // sourcePath -> the session folder found on it
  template: null,       // structure + name imported from a zip/folder of empty folders
  templates: [],        // every session offered by the imported structure
  extraFiles: {},       // sourcePath -> files the operator picked by hand
  byDate: null,         // last-modified breakdown of the loaded footage
  activeDay: null,      // the day last bulk-selected, for highlighting only
  masters: {},          // sourcePath -> chosen master file path
  masterSource: null,   // the drive the master was picked from
  cardCams: {},         // card label -> cam number (distinct card = distinct camera)
  camNames: {},         // cam number -> custom folder name (default "Cam-NN")
  mastersFiled: false,  // true once the first copy is done; later adds skip masters
  filedSessions: {},    // role -> final session folder, for adding cameras afterwards
  completedCams: new Set(), // cams filled during this run (detection is then stale)
  session: { title: '', jobNumber: '', date: '', destMode: 'inPlace', destRoots: {} },
  assign: {},           // primary file path -> 'master' | cam number | 'skip'
  camCount: 3,
  clipNames: {},
  ceremonyNames: {},    // master path -> "Pujyashree's Entry"/"Exit" tag (topic swap)
  filedMasterInfo: {},  // pathKey -> probed details of a master already filed in its session folder
  sessionNumbering: [], // earlier session folders missing their "01 " number: [{path, new_path, number}]
  clipTitle: '',
  namingPreview: null,
  selection: [],        // paths ticked for a batch assign (shift/ctrl on the Cameras page)
  lastPicked: null,     // anchor path for a shift-click range select
  cameraFilterQuery: '',
  cameraFilterCam: 'all',
  cameraFilterIdentity: 'all',
  cameraSort: 'camera-time',
  skipExistingBySize: true,
  renameBase: null,     // operator's replacement for the session folder's base name
  nameCleanup: null,    // automatic fixes to that name: {original, repeat, topic, keepRepeat, keepTopic}
  jobNameOverride: null,// operator's replacement for an imported template's job folder
  plan: null,
  runResult: null,
  compare: null,
  deep: null,
  compareRoots: [],
  pairVerify: null,     // focused result: copied clips identical on both SSDs
  busy: null,           // {label, id, percent, detail}
  rename: null,         // in-place rename/clip-count tool: {open, root, plan, scanning, applying, result}
  clipsOnly: false,     // "only camera clips": skip the master step, add clips into an existing session
  camSeededKey: null,   // signature of the existing session(s) whose cam-folder names have been adopted
  existingCamCounts: {},// cam number -> clips already filed on disk (shown beside each camera chip)
  verify: null,         // Offline CSV comparison page: {open, root, csv, busy, result, error}
  schedule: null,       // Event schedule page and its master rows (schedule-ui.js)
  scheduleRun: null,    // the schedule row the current backup was started from: {key, id}
};

const STEPS = [
  { key: 'sources', label: 'Sources', title: 'Sources',
    hint: 'Import the structure zip, then add the drives holding the footage and set where each one writes.' },
  { key: 'session', label: 'Folder', title: 'Session folder',
    hint: 'Edit the job and session folder names, then select each drive\'s master.' },
  { key: 'cameras', label: 'Cameras', title: 'Camera assignment',
    hint: 'Choose which clip belongs to which cam. Selected clips are copied to both SSDs.' },
  { key: 'copy', label: 'Copy', title: 'Review and copy',
    hint: 'Nothing is written until you press Start. Masters follow the session name. Review camera filenames before starting.' },
  { key: 'verify', label: 'Verify', title: 'Compare copies',
    hint: 'Check the two SSDs (and the SD card) hold the same session, file for file.' },
];

/* ---------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);
const PAINT = window.VIngestPaint;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const selectionRules = window.VIngestSelection;
const isInformal = () => state.backupType === 'informal';

/** Filesystem identity for selection purposes (Windows paths are case-insensitive). */
const pathKey = (path) => selectionRules.pathKey(path, window.api.platform);

/** The parent folder of a path, tolerating either separator. */
function parentDir(p) {
  const norm = String(p || '').replace(/[\\/]+$/, '');
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  return idx > 0 ? norm.slice(0, idx) : norm;
}

// Sizes are formatted the way the host OS file manager shows them, so the numbers
// here match what the operator sees next to the files. On Windows that is Explorer's
// base-1024 (StrFormatByteSize) behaviour where 2,097,151 bytes reads "1.99 MB". On
// macOS the Finder uses base-1000 (decimal SI), where 2,829,394,112 bytes reads
// "2.83 GB", so we switch the divisor by platform. Three significant figures, the
// remainder TRUNCATED rather than rounded up. Bytes below the first unit are shown
// whole with the locale's digit grouping ("1,024 bytes").
const SIZE_MAC = window.api && window.api.platform === 'darwin';
const SIZE_BASE = SIZE_MAC ? 1000 : 1024;
function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= SIZE_BASE && i < u.length - 1) { v /= SIZE_BASE; i++; }
  if (i === 0) return `${Math.round(v).toLocaleString()} ${u[0]}`;
  // Three significant figures: 2 decimals under 10, 1 under 100, none above.
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  const factor = 10 ** decimals;
  // The Finder rounds (2,829,394,112 B → "2.83 GB"); Explorer truncates
  // (2,097,151 B → "1.99 MB", never "2.00 MB"). Match whichever the operator sees.
  const scaled = SIZE_MAC ? Math.round(v * factor) : Math.floor(v * factor);
  return `${(scaled / factor).toFixed(decimals)} ${u[i]}`;
}

// A file/folder byte count rendered as a solid, easy-to-spot chip. `total` gives
// the green "folder total" variant used on folder rows; the default (accent) is
// used on individual clips.
function sizeBadge(bytes, kind = '') {
  return `<span class="size-badge ${kind}">${fmtBytes(bytes)}</span>`;
}

function fmtDur(sec) {
  if (sec == null) return '—';
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}h` : '') + (h || m ? `${m}m` : '') + `${s}s`;
}

/**
 * Format a duration to the smallest unit an existing name already uses, so the
 * token the app writes matches the shape of the folder it is completing.
 * 'Dur-1h0m' keeps hours+minutes; 'Dur-54m1s' keeps the full h/m/s form.
 */
function durPrecisionOf(name) {
  const m = /\bDur-(?=\d)(?:\d+h)?(?:\d+m)?(?:\d+s)?\b/i.exec(name || '');
  if (!m) return 's';
  const body = m[0].trim().slice(4).toLowerCase();
  return body.endsWith('s') ? 's' : body.endsWith('m') ? 'm' : body.endsWith('h') ? 'h' : 's';
}

/** Hours+minutes at an hour or over, minutes+seconds under — the house rule. */
function fmtDurAuto(sec) {
  if (sec == null) return '…';
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h >= 1 ? `${h}h${m}m` : (m ? `${m}m${s}s` : `${s}s`);
}

function fmtDurLike(sec, name) {
  if (sec == null) return '…';
  const p = durPrecisionOf(name);
  const t = Math.floor(sec);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sx = t % 60;
  if (p === 'h') return `${h}h`;
  if (p === 'm') return (h ? `${h}h` : '') + `${m}m`;
  return (h ? `${h}h` : '') + (h || m ? `${m}m` : '') + `${sx}s`;
}

function fmtClock(sec) {
  if (sec == null) return '—';
  const t = Math.round(sec);
  const m = Math.floor(t / 60), s = t % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString(undefined,
    { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 4500);
}

/** Call Python. Long jobs pass a label so the footer shows live progress. */
async function call(method, params = {}, opts = {}) {
  let id = null;
  if (opts.label) {
    id = await window.api.reserveId();
    state.busy = { label: opts.label, id, percent: null, detail: '' };
    window.api.setBusy(true);
    render();
  }
  try {
    const res = await window.api.call(method, params, id);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  } finally {
    if (opts.label) {
      state.busy = null;
      window.api.setBusy(false);
      render();
    }
  }
}

/* ------------------------------------------------------------- step gating */

function stepReady(i) {
  switch (i) {
    case 0: return true;
    case 1: if (state.clipsOnly) return clipsOnlyReady();
      return isInformal()
        ? selectionRules.informalSetupReady(state.template, state.informalDest)
        : footageSources().length > 0;
    case 2: if (state.clipsOnly) return clipsOnlyReady();
      return isInformal()
        ? selectionRules.informalSetupReady(state.template, state.informalDest)
        : !!detection() && chosenMasters().length > 0;
    case 3: return (isInformal() || state.clipsOnly)
      ? selected(primarySource()).length > 0
      : chosenMasters().length > 0;
    case 4: return !!state.plan && !!state.runResult
      && !state.runResult.failed && !state.runResult.cancelled;
    default: return false;
  }
}

/** Clips-only mode is ready once every source in play has an existing session
 *  folder chosen to file the late-arriving clips into. */
function clipsOnlyReady() {
  if (!state.clipsOnly) return false;
  if (isInformal()) return !!state.filedSessions.informal;
  const f = footageSources();
  // No source drive added: the simple, informal-style path — one chosen session
  // is enough, and the clips are brought in by hand on the Cameras page.
  if (!f.length) return !!state.filedSessions.other;
  return f.every((s) => state.filedSessions[filedKeyFor(s.path)]);
}

/** Sources that carry footage — the template is a structure donor, not footage. */
function footageSources() {
  return state.sources.filter((s) => s.role !== 'template');
}

function primarySource() {
  if (isInformal()) {
    if (!state.informalDest) return null;
    // Informal footage is brought in from mounted cards on Page 3. This logical
    // source gives that shared card pool a stable state key and plan destination
    // without making the operator select each SD card on Page 1.
    return { path: state.informalDest, dest: state.informalDest,
             label: 'Mounted camera cards', kind: 'cards', role: 'informal' };
  }
  // Formal clips-only with no source drive added: a logical source rooted at the
  // chosen session, so the flow behaves like informal — pick the folder, then add
  // the late-arriving clips by hand on the Cameras page.
  if (state.clipsOnly && !footageSources().length && state.filedSessions.other) {
    const root = parentDir(state.filedSessions.other);
    return { path: root, dest: root, label: 'Existing session',
             kind: 'folder', role: 'other' };
  }
  const f = footageSources();
  // Cams are assigned once and copied to both destinations. Prefer the
  // drive the operator marked, then one that has masters picked, then by codec.
  return f.find((s) => s.path === state.masterSource)
      || f.find((s) => (state.masters[s.path] || []).length)
      || f.find((s) => s.role === 'prores') || f.find((s) => s.role === 'h265') || f[0];
}

/** Where a source's output goes; defaults to the source drive itself. */
function destOf(src) {
  return (src && (src.dest || src.path)) || '';
}

/**
 * The key a source's filed session folder is tracked under in state.filedSessions.
 *
 * Formal footage drives key by PATH, not by codec role, so two drives that share
 * a role (both ProRes, both H.265, both Other) are tracked — and copied to —
 * independently instead of colliding on one role slot. The two logical
 * singletons keep their fixed keys: an informal run and the clips-only path with
 * no source drive each file into a single chosen folder.
 */
function filedKeyFor(srcPath) {
  if (isInformal()) return 'informal';
  if (state.clipsOnly && !footageSources().length) {
    // Clips-only with no source drive can file into the session's copy on each
    // SSD: the second copy is keyed by the folder it sits in.
    const second = state.filedSessions.other2;
    return second && srcPath && pathKey(srcPath) === pathKey(parentDir(second)) ? 'other2' : 'other';
  }
  return srcPath || 'other';
}

/** The shoot date the folder name states, if any. */
function sessionDate() {
  if (state.template) return state.template.session_date || null;
  const d = primarySource() ? state.detected[primarySource().path] : null;
  return (d && d.session_date) || null;
}

/** Everything loaded for a source, before the date suggestion is applied. */
function allFiles(src) {
  if (!src) return [];
  // The informal source is a logical "mounted cards" pool whose path is the
  // OUTPUT drive. Its footage comes only from imported cards (extraFiles); a
  // drive scan of that same path — e.g. left over from a formal run on the same
  // disk — must never surface the output drive's own files (the master at its
  // root, earlier sessions) as camera footage.
  const scanned = (src.kind === 'cards') ? [] : ((state.scans[src.path] || {}).files || []);
  const extra = state.extraFiles[src.path] || [];
  const seen = new Set(scanned.map((f) => pathKey(f.path)));
  return scanned.concat(extra.filter((f) => !seen.has(pathKey(f.path))));
}

/** The files actually in play — narrowed to the suggested day when one is active. */
/**
 * Every clip loaded for a source.
 *
 * Nothing is hidden. What gets copied is decided on the Cameras page — a clip
 * with a cam number is filed, a clip marked Skip is not — so the shoot date only
 * chooses the DEFAULT for each clip, never whether you can see it. Hiding files
 * meant an "Add files…" of footage from another day looked like it did nothing.
 */
function filePool(src) {
  return allFiles(src);
}

/**
 * Clips the operator can assign on the Cameras page.
 *
 * A whole-drive scan exists only to find master candidates. It must never
 * silently become camera footage: that scan also sees old sessions and, on
 * misconfigured/older engines, may even contain system-trash files. Camera
 * clips enter this pool only through Import card, Add files, or Add folder.
 */
function cameraFiles(src) {
  const pool = isInformal()
    ? filePool(src).map((file) => ({ ...file, manual: true }))
    : filePool(src);
  const filed = new Set();
  const detected = src && state.detected[src.path];
  if (isInformal() && detected) {
    Object.values(detected.cams || {}).flat().forEach((path) => filed.add(pathKey(path)));
  }
  // A whole-drive informal scan may see an earlier copy of this same imported
  // session. Never offer anything already inside the destination we are about
  // to create/complete as fresh camera footage.
  let informalOutput = '';
  if (isInformal() && src && state.template) {
    const t = state.template;
    const job = state.jobNameOverride != null ? state.jobNameOverride : (t.job_name || '');
    const session = stripClipsToken(state.renameBase || t.session_name || '')
      .replace(/\s*\bDur-(?=\d)(?:\d+h)?(?:\d+m)?(?:\d+s)?\b/i, '').trim();
    informalOutput = pathKey([destOf(src), job, session].filter(Boolean).join('/'));
  }
  return selectionRules.cameraFiles(
    pool, [...masterPaths()], window.api.platform)
    .filter((file) => {
      const key = pathKey(file.path);
      return !filed.has(key) && (!informalOutput
        || (key !== informalOutput && !key.startsWith(`${informalOutput}/`)));
    });
}

/** Clips loaded but not selected for this session. */
function skipped(src) {
  return cameraFiles(src).filter((f) => state.assign[f.path] === 'skip');
}

/** Clips that will actually be filed.
 *
 * A clip is eligible when it carries a camera number (not Skip). Ticking nothing
 * means "I'm happy with everything shown" — every eligible clip is filed; ticking
 * any clip narrows the backup to just the ticked ones. This holds for both formal
 * and informal backups. */
function selected(src) {
  const eligible = cameraFiles(src).filter((f) => typeof state.assign[f.path] === 'number');
  if (state.selection.length === 0) return eligible;
  const included = new Set(state.selection.map(pathKey));
  return eligible.filter((f) => included.has(pathKey(f.path)));
}

/**
 * The default cam for a freshly loaded clip.
 *
 * Only a clip that positively matches the session date the folder states is
 * selected. Anything else — a clip from another day, OR one whose timestamp is
 * missing or was reset when it was copied between drives — starts on Skip,
 * visible and one click from being included. This is deliberately strict: an
 * undated clip is not proof of belonging, so it is never auto-filed into the
 * current session's folder.
 *
 * A clip picked by hand is an explicit request, so it is selected whatever day
 * it carries. And when the folder states no date at all, there is no "other
 * day" to exclude, so the operator drives selection with the day buttons.
 */
// The session-root target for informal backups. Clips assigned here are filed
// directly into the session folder with no camera folder and no "Cam-NN" prefix.
const ROOT_CAM = 0;

/** How many in-play clips are currently assigned to the session Root (cam 0). */
function rootAssignedCount() {
  const src = primarySource();
  if (!src) return 0;
  return cameraFiles(src).filter((f) => state.assign[f.path] === ROOT_CAM).length;
}

function defaultAssignmentFor(file) {
  // A structure with no camera folders files everything into the session root
  // until the operator adds a cam and moves clips into it.
  const cam = isInformal() && state.camCount === 0 ? ROOT_CAM : firstEmptyCam();
  if (file.manual) return cam;
  const day = sessionDate();
  if (!day) return cam;
  return file.shoot_date === day ? cam : 'skip';
}

/**
 * Cam numbers that already hold clips filed on an earlier pass.
 *
 * When we are completing a folder that already has footage in Cam-01, Cam-02…,
 * a freshly loaded card must not default into one of those and mix a new card's
 * clips in with an already-done camera. Those cams are read from the detection.
 */
function filedCams() {
  const s = new Set(state.completedCams);
  const src = primarySource();
  const d = src && state.detected[src.path];
  if (d && d.cams) {
    for (const [cam, paths] of Object.entries(d.cams)) {
      if ((paths || []).length) s.add(Number(cam));
    }
  }
  return s;
}

/**
 * The requested number of available cam slots, lowest first.
 *
 * `alsoUsed` is useful while importing several mounted cards at once: a slot
 * chosen for the first card must not be offered to the second card as well.
 */
function nextFreeCams(count = 1, alsoUsed = []) {
  const filled = new Set([...filedCams(), ...alsoUsed]);
  return selectionRules.lowestAvailableCams(count, [...filled]);
}

/** The lowest cam number that is not already filled from an earlier pass. */
function firstEmptyCam() {
  return nextFreeCams(1)[0];
}

/** Every path that is visibly assignable on the Cameras page. */
function livePaths() {
  const sources = isInformal() ? [primarySource()].filter(Boolean) : footageSources();
  return new Set(sources.flatMap((f) => cameraFiles(f)).map((f) => pathKey(f.path)));
}

/**
 * Drop assignments for clips no longer in play.
 *
 * Without this, a clip assigned to a cam before the day filter narrowed the pool
 * stayed assigned invisibly and turned up in the plan — the whole reason clips
 * from other shoots were being filed.
 */
function pruneAssignments() {
  const live = livePaths();
  for (const path of Object.keys(state.assign)) {
    if (!live.has(pathKey(path))) delete state.assign[path];
  }
}

/** The detection result for the primary source. */
function detection() {
  const src = primarySource();
  if (!src) return null;
  if (state.template) {
    // The template supplies the name; the master is chosen from the footage.
    return { ...state.template, from_template: true,
             master_candidates: filePool(src) };
  }
  return state.detected[src.path] || null;
}

/** The master file chosen for the primary source, as a probed file record. */
/**
 * The master clips, in shot order.
 *
 * A session can be recorded as more than one file — the folder's Dur- is their
 * total, and each carries its own Dur- and a Clip-NN telling them apart.
 */
/**
 * The master clips chosen on one specific drive, in shot order.
 *
 * Each drive holds the same recording in its own codec, so each picks its own
 * master(s) independently — the ProRes master on one SSD, its H.265 twin on the
 * other. Their durations match, so either drive gives the folder the same Dur-.
 */
function mastersFor(src) {
  if (!src) return [];
  const raw = state.masters[src.path];
  const picks = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const pool = ((state.detected[src.path] || {}).master_candidates || []).concat(filePool(src))
    .concat(Object.values(state.filedMasterInfo));
  return picks
    .map((path) => pool.find((f) => pathKey(f.path) === pathKey(path)))
    .filter(Boolean)
    .sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
}

/** The directory a file sits in, from its path (POSIX or Windows). */
function parentDir(path) {
  const i = Math.max(String(path).lastIndexOf('/'), String(path).lastIndexOf('\\'));
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * Masters the app is willing to suggest — never a guess.
 *
 * A master is the program recording, which sits at the ROOT of the drive, not
 * down inside a camera card's folders. And it must carry the shoot date the
 * folder name states. Anything failing either test is left for the operator to
 * tick by hand; the app does not promote a random long clip to master.
 */
function suggestedMastersFor(src) {
  if (!src) return [];
  const day = sessionDate();
  // Files at the drive root whose own name does not name a different shoot.
  // Modification time is NOT used: copying a card to the SSD resets it, so a
  // genuine master often reads the wrong mtime. The filename is what we trust.
  const rootOk = filePool(src)
    .filter((f) => atDriveRoot(f, src))
    .filter((f) => !nameStatesOtherDate(f, day));
  if (!rootOk.length) return [];
  // The program recording is the long one; take every root clip within half the
  // longest (so a two-part master, Clip-01 + Clip-02, is picked up together).
  const longest = Math.max(...rootOk.map((f) => f.duration || 0));
  if (!longest) return [];
  return rootOk
    .filter((f) => (f.duration || 0) >= longest * 0.5)
    .sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
}

/** Path depth = how many folder segments a path has. */
function pathDepth(path) {
  return String(path).split(/[\\/]+/).filter(Boolean).length;
}

/**
 * The shallowest level at which this drive's footage sits.
 *
 * "Root" is not the literal volume mount — a drive often keeps the session in a
 * folder — but the topmost level where loaded clips actually live. Masters sit
 * there; camera-card clips are nested deeper, so they fall away.
 */
function driveRootDepth(src) {
  const files = filePool(src);
  if (!files.length) return Infinity;
  return Math.min(...files.map((f) => pathDepth(f.path)));
}

/** True if a file sits at its drive's shallowest (root) footage level. */
function atDriveRoot(file, src) {
  if (!src) return false;
  return pathDepth(file.path) === driveRootDepth(src);
}

/** A file whose own name carries a Dt- token for a different day than `day`. */
function nameStatesOtherDate(file, day) {
  if (!day) return false;
  const m = /\bDt-(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\b/.exec(file.name || '');
  if (!m) return false;
  const M = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8,
              sep: 9, oct: 10, nov: 11, dec: 12 };
  const mon = M[m[2].toLowerCase()];
  if (!mon) return false;
  let yr = parseInt(m[3], 10); if (yr < 100) yr += 2000;
  const iso = `${yr}-${String(mon).padStart(2, '0')}-${String(parseInt(m[1], 10)).padStart(2, '0')}`;
  return iso !== day;
}

// Two masters are "the same recording" when their durations agree to within a
// minute — the small drift between a ProRes master and its H.265 twin, or two
// takes of one program on different drives.
const MASTER_DUR_TOLERANCE = 60;   // seconds

/** Pre-select each drive's root/date masters, leaving manual picks alone. */
function suggestMasters() {
  // Several same-day sessions cannot be distinguished safely by date/length.
  // In that case the operator explicitly chooses each selected session's master.
  if (isInformal() || state.mastersFiled || state.templates.length > 1) return;
  for (const f of footageSources()) {
    const already = state.masters[f.path];
    if (Array.isArray(already) && already.length) continue;   // operator has chosen
    const sug = suggestedMastersFor(f);
    if (sug.length) {
      state.masters[f.path] = sug.map((x) => x.path);
      state.masterSource = state.masterSource || f.path;
    }
  }
  matchMastersByDuration();
}

/**
 * Cross-drive safety net: when one drive's masters are already selected but
 * another footage drive has none, auto-select that drive's root clips whose
 * durations match the selected masters (within a minute). The two SSDs hold the
 * same program in different codecs, so a duration match is strong proof — this
 * catches the cases where the per-drive date/length heuristic ticks one drive
 * but silently misses its twin.
 */
function matchMastersByDuration() {
  // Reference durations: every master already selected on any drive.
  const refDurations = footageSources()
    .flatMap((f) => mastersFor(f))
    .map((m) => m.duration)
    .filter((d) => d != null);
  if (!refDurations.length) return;

  for (const f of footageSources()) {
    const already = state.masters[f.path];
    if (Array.isArray(already) && already.length) continue;   // already sorted
    // Consider this drive's root clips (never nested camera-card footage).
    const rootClips = filePool(f).filter((c) => atDriveRoot(c, f) && c.duration != null);
    const matched = rootClips.filter((c) => refDurations.some(
      (d) => Math.abs(d - c.duration) <= MASTER_DUR_TOLERANCE));
    if (matched.length) {
      state.masters[f.path] = matched
        .sort((a, b) => (a.mtime || 0) - (b.mtime || 0))
        .map((x) => x.path);
      state.masterSource = state.masterSource || f.path;
    }
  }
}

/** True only if a master's own NAME states a different shoot date.
 *  Modification time is ignored — it is reset by copying and cannot be trusted. */
function offSessionDate(file) {
  return nameStatesOtherDate(file, sessionDate());
}

function masterTotalFor(src) {
  const timed = mastersFor(src).map((f) => f.duration).filter((d) => d != null);
  return timed.length ? timed.reduce((a, b) => a + b, 0) : null;
}

/**
 * The masters that set the folder name shown at the top.
 *
 * The two drives agree on duration, so the headline uses whichever drive the
 * cams are assigned against; the fallback keeps an auto-detected master working.
 */
function chosenMasters() {
  if (isInformal()) return [];
  const primary = mastersFor(primarySource());
  if (primary.length) return primary;
  const d = detection();
  return d && d.suggested_master ? [d.suggested_master] : [];
}

function chosenMaster() {
  return chosenMasters()[0] || null;
}

function isMasterPath(path) {
  const key = pathKey(path);
  return [...masterPaths()].some((master) => pathKey(master) === key);
}

/** Paths of every master, for excluding them from the cam clip list. */
function masterPaths() {
  if (isInformal()) return new Set();
  return new Set(footageSources().flatMap((src) => mastersFor(src).map((f) => f.path)));
}

/** The folder's Dur- token: the total of every master clip. */
function masterTotalSeconds() {
  const timed = chosenMasters().map((f) => f.duration).filter((d) => d != null);
  return timed.length ? timed.reduce((a, b) => a + b, 0) : null;
}

// A clip shorter than this is treated as a possible Pujyashree entry/exit
// ceremony recording rather than a program master.
const CEREMONY_MAX_SECONDS = 8 * 60;

/** The tag a ceremony clip's topic is replaced by, e.g. "Pujyashree's Entry". */
function ceremonyTag(kind) {
  return `Pujyashree's ${kind}`;
}

// Swap a master name's middle topic for `tag`, keeping the location word, the
// session indicator (E./M./E2.) and every date/Dur-/Clip- token. Mirrors
// naming.replace_topic on the Python side so the preview matches the plan.
function replaceTopicWithTag(name, tag) {
  const extMatch = /\.[^./\\]+$/.exec(name || '');
  const ext = extMatch ? extMatch[0] : '';
  const stem = ext ? name.slice(0, -ext.length) : name;
  const date = /\s*\bDt-\d{1,2}-[A-Za-z]{3}-\d{2,4}\b/.exec(stem);
  const head = (date ? stem.slice(0, date.index) : stem).trim();
  const tail = date ? stem.slice(date.index).trim() : '';
  const ind = /\s*\b([EM]\d*)\.\s*$/.exec(head);
  const indicator = ind ? `${ind[1]}.` : '';
  const front = ind ? head.slice(0, ind.index).trim() : head;
  const location = front ? front.split(' ')[0] : '';
  const rebuilt = [location, tag, indicator, tail]
    .filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
  return rebuilt + ext;
}

/** The output filename shown for a master: a hand override, else the ceremony
 *  tag applied to the house name, else the plain house master name. */
function masterDisplayName(m, index, count, base) {
  if (state.clipNames[m.path]) return state.clipNames[m.path];
  const generated = masterClipName(base, m.duration, index, count, m.path);
  const tag = state.ceremonyNames[m.path];
  return tag ? replaceTopicWithTag(generated, tag) : generated;
}

/* ------------------------------------------------------------ step: sources */

function renderSources() {
  const c = [];

  c.push(`<div class="card">
    <h3>Backup type</h3>
    <p class="hint">Choose this first. Formal keeps the video-mixer master workflow;
      Informal is for camera-only recordings and renames every filed camera clip.</p>
    <div class="grid2">
      <button class="source-card ${!isInformal() ? 'selected' : ''}" data-backup-type="formal">
        <div class="icon">🎛️</div><div class="body" style="text-align:left">
          <div class="name">Formal</div>
          <div class="hint" style="margin:4px 0 0">Mixer master plus supporting cameras · ProRes/H.265 roles</div>
        </div>
      </button>
      <button class="source-card ${isInformal() ? 'selected' : ''}" data-backup-type="informal">
        <div class="icon">🎥</div><div class="body" style="text-align:left">
          <div class="name">Informal</div>
          <div class="hint" style="margin:4px 0 0">Individual cameras only · no master or codec roles · clips renamed</div>
        </div>
      </button>
    </div>
  </div>`);

  if (state.engine.error) {
    c.push(`<div class="note err"><b>Engine problem.</b> ${esc(state.engine.error)}</div>`);
  } else if (state.engine.info && !state.engine.info.ffprobe) {
    c.push(`<div class="note err"><b>ffprobe not found,</b> so clip lengths and codecs
      can't be read. Click Locate ffprobe.</div>`);
  }

  if (isInformal()) {
    const structure = state.sources.find((source) => source.role === 'template');
    c.push(`<div class="card">
      <h3>Informal backup setup</h3>
      <p class="hint">Import the folder structure and choose where the finished session is
        written. Camera SD cards are detected and assigned on the Cameras page.</p>
      <div class="row" style="margin-bottom:12px">
        <button class="sm ${state.template ? '' : 'primary'}" id="btnAddZip">
          ${state.template ? 'Replace structure zip…' : 'Import structure zip…'}</button>
        ${structure ? '<button class="sm ghost" id="btnRemoveTemplate">Remove structure</button>' : ''}
      </div>
      ${structure ? `<div class="source-card selected">
        <div class="icon">🗜️</div>
        <div class="body"><div class="name">${esc(structure.label)}</div>
          <div class="path">${esc(structure.path)}</div>
          <div class="hint" style="margin:4px 0 0">${state.templates.length} session${
            state.templates.length === 1 ? '' : 's'} available on the Folder page</div>
        </div><span class="badge">Structure</span>
      </div>` : `<div class="empty" style="margin-bottom:14px">
        <div class="big">🗜️</div><div>No structure ZIP imported.</div>
      </div>`}
      <div class="field" style="margin-top:14px">
        <span>Output directory</span>
        <div class="row">
          <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;
            white-space:nowrap;color:${state.informalDest ? 'var(--text)' : 'var(--muted)'}">
            ${state.informalDest ? esc(state.informalDest) : 'Choose where the arranged session will be written'}</span>
          <button class="sm ${state.informalDest ? '' : 'primary'}" id="btnInformalDest">Choose…</button>
          ${state.informalDest ? '<button class="sm ghost" id="btnInformalDestClear">Reset</button>' : ''}
        </div>
      </div>
      ${state.template && state.informalDest
        ? '<div class="note ok" style="margin-top:14px"><b>Ready.</b> Continue to choose the session; import the SD cards on Page 3.</div>'
        : ''}
    </div>`);

    c.push(clipsOnlyCardHtml());

    c.push(`<div class="card" id="renameDrop">
      <h3>Rename &amp; fix clip counts</h3>
      <p class="hint">A standalone cleanup for footage that is <b>already filed</b>. Point it at a
        drive or folder holding informal sessions and it renames raw camera clips to
        <span class="mono">Cam-NN Event Name Clip-001</span> and rewrites each folder's
        <span class="mono">Clips-NN</span> count to match the real number of clips inside. You
        preview every change before anything is written.</p>
      <div class="row">
        <button class="sm primary" id="btnRenameTool">Choose folder to rename…</button>
        <span class="hint" style="margin:0">or drop a folder on this card. Works independently
          of the backup steps above.</span>
      </div>
    </div>`);

    c.push(`<div class="card">
      <h3>Compare a drive to the duration list</h3>
      <p class="hint">Export the duration/clip list from Frappe (CSV or Excel), then compare it
        against a drive here — fully offline. Each session is flagged on-drive-only, in-CSV-only, or a duration/clip mismatch.</p>
      <div class="row">
        <button class="sm" id="btnVerifyCsv">Compare a folder to a CSV/Excel…</button>
      </div>
    </div>`);
    return c.join('');
  }

  c.push(`<div class="card">
    <h3>Detected drives</h3>
    <p class="hint">External and removable volumes — your system disk is never listed.</p>
    <div class="row" style="margin-bottom:12px">
      <button class="sm" id="btnRescan">Rescan drives</button>
      <button class="sm" id="btnAddFolder">Add folder as source…</button>
      <button class="sm ${state.template ? '' : 'primary'}" id="btnAddZip">
        ${state.template ? 'Replace structure zip…' : 'Import structure zip…'}</button>
    </div>`);

  if (!state.volumes.length && !state.sources.length) {
    c.push(`<div class="empty"><div class="big">💾</div>
      <div>No drives detected yet.</div>
      <div style="margin-top:4px">Import the structure zip for the folder name, then plug in
        the SSDs and press Rescan — or point the app at a folder by hand.</div>
    </div>`);
  }

  for (const v of state.volumes) {
    const added = state.sources.some((s) => s.path === v.path);
    c.push(`<div class="source-card ${added ? 'selected' : ''}">
      <div class="icon">💾</div>
      <div class="body">
        <div class="name">${esc(v.label)} ${v.note ? `<span class="badge">${esc(v.note)}</span>` : ''}</div>
        <div class="path">${esc(v.path)}</div>
        <div class="hint" style="margin:4px 0 0">
          ${fmtBytes(v.total_bytes - v.free_bytes)} used of ${fmtBytes(v.total_bytes)} ·
          ${fmtBytes(v.free_bytes)} free</div>
      </div>
      <button class="sm ${added ? 'danger' : 'primary'}" data-add="${esc(v.path)}"
        data-label="${esc(v.label)}">${added ? 'Remove' : 'Use as source'}</button>
    </div>`);
  }
  c.push(`</div>`);

  if (state.sources.length) {
    c.push(`<div class="card">
      <div class="row" style="align-items:flex-start;margin-bottom:12px">
        <div style="flex:1;min-width:0">
          <h3>Sources in this job</h3>
          <p class="hint" style="margin:0">Each source becomes its own copy of the session folder.</p>
        </div>
        <button class="sm primary" id="btnClassify"
          ${state.sources.length ? '' : 'disabled'}>Probe codecs &amp; assign roles</button>
      </div>`);
    for (const s of state.sources) {
      const r = s.report;
      const fam = r ? r.family : null;
      c.push(`<div class="source-card">
        <div class="icon">${s.kind === 'zip' ? '🗜️' : s.kind === 'folder' ? '📁' : '💾'}</div>
        <div class="body">
          <div class="name">${esc(s.label)}
            ${fam ? `<span class="badge ${fam}">${esc(r.family_label)}</span>` : ''}
            ${r && r.confidence ? `<span class="badge">${Math.round(r.confidence * 100)}% of sampled bytes</span>` : ''}
          </div>
          <div class="path">${esc(s.path)}</div>
          <div class="hint" style="margin:4px 0 0">
            ${r ? `${r.file_count} video files · ${fmtBytes(r.total_bytes)} · probed ${r.probed}`
                : 'Not probed yet'}
            ${r && r.error ? ` · <span style="color:var(--err)">${esc(r.error)}</span>` : ''}
          </div>
        </div>
        <div class="role-pick">
          ${s.kind === 'zip'
            ? `<span class="badge template" title="A structure zip is always the folder structure — no need to pick a role">Structure</span>`
            : `<div class="seg">
            ${['prores', 'h265', 'sd', 'template', 'other'].map((role) => `
              <button data-role="${role}" data-path="${esc(s.path)}"
                class="${s.role === role ? 'on' : ''}">${
                  { prores: 'ProRes', h265: 'H.265', sd: 'SD card',
                    template: 'Structure', other: 'Other' }[role]}</button>`).join('')}
          </div>`}
          <button class="sm ghost" data-remove="${esc(s.path)}">Remove</button>
        </div>
      </div>
      ${s.role === 'template' ? '' : `
      <div class="row" style="margin:-4px 0 10px 48px">
        <span class="hint" style="margin:0">Output destination</span>
        <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;
          white-space:nowrap;color:${s.dest ? 'var(--text)' : 'var(--muted)'}">
          ${esc(s.dest || s.path)}${s.dest ? '' : '  (same as source; optional)'}</span>
        <button class="sm" data-dest="${esc(s.path)}">Choose…</button>
        ${s.dest ? `<button class="sm ghost" data-dest-clear="${esc(s.path)}">Reset</button>` : ''}
      </div>`}`);
    }
    if (state.assignment) {
      const a = state.assignment;
      c.push(`<div class="note ${a.confident ? 'ok' : 'warn'}">
        <b>${a.confident ? 'Roles assigned automatically.' : 'Check these roles.'}</b>
        ${esc(a.reason)}</div>`);
    }
    c.push(`</div>`);
  }
  c.push(clipsOnlyCardHtml());
  return c.join('');
}

/** Switch between Formal and Informal, dropping everything chosen for the other. */
function setBackupType(next) {
  if (next === state.backupType) return;
  state.backupType = next;
  state.assignment = null;
  state.masters = {};
  state.ceremonyNames = {};
  state.masterSource = null;
  state.mastersFiled = false;
  state.filedSessions = {};
  state.clipsOnly = false;
  state.camSeededKey = null;
  state.completedCams = new Set();
  state.assign = {};
  state.selection = [];
  state.cardCams = {};
  state.plan = null; state.namingPreview = null;
  state.runResult = null;
  if (isInformal()) {
    state.sources.forEach((source) => {
      if (source.role !== 'template') source.role = 'other';
    });
  }
}

function wireSources() {
  document.querySelectorAll('[data-backup-type]').forEach((button) =>
    button.addEventListener('click', () => {
      setBackupType(button.dataset.backupType);
      render();
    }));
  $('btnRescan')?.addEventListener('click', rescanVolumes);
  $('btnAddFolder')?.addEventListener('click', async () => {
    const p = await window.api.pickFolder('Choose a footage folder');
    if (p) addSource(p, p.split(/[\\/]/).pop() || p, 'folder');
  });
  $('btnAddZip')?.addEventListener('click', addZipSource);
  $('btnClassify')?.addEventListener('click', classifySources);
  $('btnInformalDest')?.addEventListener('click', async () => {
    const chosen = await window.api.pickFolder('Choose the informal backup output directory');
    if (!chosen) return;
    state.informalDest = chosen;
    state.plan = null; state.namingPreview = null;
    state.runResult = null;
    render();
  });
  $('btnInformalDestClear')?.addEventListener('click', () => {
    state.informalDest = '';
    state.plan = null; state.namingPreview = null;
    state.runResult = null;
    render();
  });
  $('btnRemoveTemplate')?.addEventListener('click', () => {
    state.sources = state.sources.filter((source) => source.role !== 'template');
    state.scheduleRun = null;
    if (typeof syncRelease === 'function') syncRelease().catch(() => {});
    state.template = null;
    state.templates = [];
    state.plan = null; state.namingPreview = null;
    render();
  });
  $('btnRenameTool')?.addEventListener('click', () => openRenameTool());
  makeFolderDropTarget($('renameDrop'), (folder) => openRenameTool(folder));
  $('btnClipsOnly')?.addEventListener('click', enterClipsOnly);
  $('btnClipsOnlyExit')?.addEventListener('click', exitClipsOnly);
  $('btnSecondCopy')?.addEventListener('click', addSecondCopy);
  $('btnSecondCopyOff')?.addEventListener('click', dropSecondCopy);
  $('btnVerifyCsv')?.addEventListener('click', () => openVerifyCsv());

  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    // The button toggles: "Use as source" adds it, "Added" takes it back off.
    const existing = state.sources.find((s) => s.path === b.dataset.add);
    if (existing) {
      if (existing.role === 'template') {
        state.template = null;
        state.templates = [];
      }
      state.sources = state.sources.filter((s) => s.path !== b.dataset.add);
      state.plan = null; state.namingPreview = null;
      render();
    } else {
      addSource(b.dataset.add, b.dataset.label, 'volume');
    }
  }));
  document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    const gone = state.sources.find((s) => s.path === b.dataset.remove);
    if (gone && gone.role === 'template') {
      state.template = null;
      state.templates = [];
    }
    state.sources = state.sources.filter((s) => s.path !== b.dataset.remove);
    state.plan = null; state.namingPreview = null;
    render();
  }));

  document.querySelectorAll('[data-dest]').forEach((b) => b.addEventListener('click', async () => {
    const chosen = await window.api.pickFolder('Choose where this drive\u2019s session folder goes');
    if (!chosen) return;
    const src = state.sources.find((x) => x.path === b.dataset.dest);
    if (src) { src.dest = chosen; state.plan = null; state.namingPreview = null; render(); }
  }));
  document.querySelectorAll('[data-dest-clear]').forEach((b) => b.addEventListener('click', () => {
    const src = state.sources.find((x) => x.path === b.dataset.destClear);
    if (src) { delete src.dest; state.plan = null; state.namingPreview = null; render(); }
  }));
  document.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
    const s = state.sources.find((x) => x.path === b.dataset.path);
    if (!s) return;
    // Only the Structure donor is exclusive — there is one folder-structure zip.
    // Codec roles may repeat: two drives can both be ProRes / H.265 / SD backups,
    // each keeping its own master and getting its own copy of the session folder.
    if (b.dataset.role === 'template') {
      state.sources.forEach((x) => { if (x !== s && x.role === 'template') x.role = 'other'; });
    }
    const was = s.role;
    s.role = b.dataset.role;
    state.plan = null; state.namingPreview = null;
    if (s.role === 'template') loadTemplate(s);
    else if (was === 'template') {
      state.template = null;
      state.templates = [];
      render();
    }
    else render();
  }));
}

async function rescanVolumes() {
  try {
    const r = await call('list_volumes', {}, { label: 'Scanning drives' });
    state.volumes = r.volumes;
    if (!r.volumes.length) toast('No removable drives found.');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

function addSource(path, label, kind) {
  if (state.sources.some((s) => s.path === path)) return;
  state.sources.push({ path, label, kind, role: 'other', report: null });
  render();
}

async function addZipSource() {
  const zip = await window.api.pickZip();
  if (!zip) return;
  try {
    const info = await call('inspect_zip', { path: zip }, { label: 'Reading zip' });
    // The zip the operator just picked is taken as the structure directly — no
    // extra confirmation. It is always replaceable and never writes anything on
    // its own, so a prompt here only adds a click.
    const r = await call('extract_zip', { path: zip },
      { label: `Extracting ${info.label}` });
    // “Replace” means exactly one active structure source. Keep footage drives,
    // but remove the prior extracted template before registering the new one.
    // A zip picked by hand is not a schedule row's backup.
    state.scheduleRun = null;
    if (typeof syncRelease === 'function') syncRelease().catch(() => {});
    state.sources = state.sources.filter((source) => source.role !== 'template');
    state.template = null;
    state.templates = [];
    // A structure zip is always the template, whether or not anything is in it.
    addSource(r.path, info.label, 'zip');
    const added = state.sources.find((x) => x.path === r.path);
    if (added) {
      added.role = 'template';
      await loadTemplate(added);
    }
  } catch (e) { toast(e.message, 'err'); }
}

/** Read the session folder name and cam layout out of a structure source. */
async function loadTemplate(src) {
  try {
    const found = await call('detect_structures', { root: src.path },
      { label: `Reading ${src.label}` });
    if (!found.sessions.length) {
      toast(`No session folder found in ${src.label}.`, 'err');
      src.role = 'other';
      state.template = null;
      state.templates = [];
    } else {
      state.templates = found.sessions;
      await activateTemplateSession(0, false);
      toast(found.sessions.length > 1
        ? `${found.sessions.length} sessions found — choose one on the Folder page.`
        : `Structure: ${found.sessions[0].session_name.slice(0, 40)}…`, 'ok');
    }
    state.plan = null; state.namingPreview = null;
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/** Make one imported session the sole target and discard state from the prior one. */
async function activateTemplateSession(index, announce = true) {
  const next = state.templates[Number(index)];
  if (!next) return;
  state.template = next;
  state.renameBase = null;
  adoptFolderName(stripClipsToken(next.base_name || next.session_name || ''));
  state.jobNameOverride = null;
  state.clipNames = {}; state.ceremonyNames = {}; state.clipTitle = ''; state.namingPreview = null;
  state.filedMasterInfo = {};
  state.camNames = {};
  // Both modes now mirror the structure exactly — a 2-cam structure gets 2 cam
  // folders, no phantom third, and a 0-cam structure gets none. Informal then
  // files clips into the session root (the "Root" target); formal, and any cam
  // shortfall, is still topped up on the Cameras page (Add Cam / card import).
  state.camCount = selectionRules.importedCamCount(next, 0);
  state.masters = {};
  state.masterSource = null;
  state.mastersFiled = false;
  state.filedSessions = {};
  state.camSeededKey = null;
  state.completedCams = new Set();
  state.assign = {};
  state.selection = [];
  state.lastPicked = null;
  state.cameraFilterQuery = '';
  state.cameraFilterCam = 'all';
  state.cameraFilterIdentity = 'all';
  state.cameraSort = 'camera-time';
  state.skipExistingBySize = true;
  state.cardCams = {};
  state.activeDay = null;
  state.byDate = null;
  state.plan = null; state.namingPreview = null;
  state.runResult = null;
  state.pairVerify = null;
  const src = primarySource();
  if (src && allFiles(src).length) {
    await applyDateSuggestion(src);
    ensureDefaultAssignments();
  }
  if (announce) toast(`Selected session: ${next.session_name}`, 'ok');
  render();
}

async function classifySources() {
  if (isInformal()) return;
  try {
    const r = await call('classify', { roots: footageSources().map((s) => s.path) },
      { label: 'Probing codecs' });
    r.reports.forEach((rep) => {
      const s = state.sources.find((x) => x.path === rep.root);
      if (s) s.report = rep;
    });
    state.assignment = r.assignment;
    state.sources.forEach((s) => {
      if (r.assignment.prores === s.path) s.role = 'prores';
      else if (r.assignment.h265 === s.path) s.role = 'h265';
    });
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/* ------------------------------------------------------------ step: session */

/* ---------------------------------------------- clips-only ("add clips later") */

// A shortcut for footage that arrives after the session was first backed up:
// point at the existing session folder(s) and jump straight to camera assignment.
// Clips are filed in place (no master, nothing renamed on the folder) — the same
// path a normal run uses once its master has already been filed.

function clipsOnlySessions() {
  if (isInformal()) {
    return state.filedSessions.informal ? [state.filedSessions.informal] : [];
  }
  const f = footageSources();
  if (!f.length) {
    return [state.filedSessions.other, state.filedSessions.other2].filter(Boolean);
  }
  return f.map((s) => state.filedSessions[filedKeyFor(s.path)]).filter(Boolean);
}

function clipsOnlyCardHtml() {
  const chosen = clipsOnlySessions();
  const status = state.clipsOnly && chosen.length
    ? `<div class="note ok" style="margin-top:12px"><b>Clips-only mode.</b>
        Adding clips into:${chosen.map((p) => `<div class="mono" style="margin-top:4px">${esc(p)}</div>`).join('')}
        <div style="margin-top:6px">Continue to the Cameras page to select and file the clips.</div></div>`
    : '';
  return `<div class="card">
    <h3>Only camera clips (add to an existing session)</h3>
    <p class="hint">Already backed up the master or an earlier batch, and more camera clips arrived
      later? Skip the master step: choose the existing session folder and jump straight to camera
      assignment, then bring in the late clips with <b>Add files</b> / <b>Add a folder</b>. They are
      filed into that folder in place and renamed as usual${isInformal() ? '' : '; the master is left untouched'}.
      ${isInformal() ? '' : 'Add the clips to one SSD copy or to both: the copy on the other SSD is offered when it is connected, or add it with <b>＋ Second SSD copy</b>.'}</p>
    <div class="row">
      <button class="sm primary" id="btnClipsOnly">${
        state.clipsOnly ? 'Re-choose existing session…' : 'Only camera clips…'}</button>
      ${secondCopyButton()}
      ${state.clipsOnly ? '<button class="sm ghost" id="btnClipsOnlyExit">Exit clips-only</button>' : ''}
      <span class="hint" style="margin:0">${isInformal()
        ? 'No structure zip needed.'
        : 'No source drive required — pick the session folder; the same session on the other SSD is found for you.'}</span>
    </div>
    ${status}
  </div>`;
}

async function enterClipsOnly() {
  // Chosen by hand here, so it is not a schedule row's backup.
  state.scheduleRun = null;
  if (typeof syncRelease === 'function') await syncRelease();
  if (isInformal()) {
    const folder = await window.api.pickFolder(
      'Choose the existing session folder to add clips to');
    if (!folder) return;
    let d;
    try {
      d = await call('detect_structure', { root: folder }, { label: 'Reading session' });
    } catch (e) { toast(e.message, 'err'); return; }
    const sessionPath = d.session_path || folder;
    state.informalDest = parentDir(sessionPath);
    state.template = null; state.templates = [];
    state.filedSessions = { informal: sessionPath };
  } else {
    const sources = footageSources();
    if (!sources.length) {
      // Simple path, just like informal: pick the existing session folder and go.
      // The late clips are added by hand on the Cameras page (Add files / folder).
      const folder = await window.api.pickFolder(
        'Choose the existing session folder to add clips to');
      if (!folder) return;
      let d;
      try {
        d = await call('detect_structure', { root: folder }, { label: 'Reading session' });
      } catch (e) { toast(e.message, 'err'); return; }
      const first = d.session_path || folder;
      state.filedSessions = { other: first };
      // The same session on the other SSD: offer to file the clips there too.
      const twin = await findSessionCopies(first);
      if (twin && await window.api.confirm({
        message: 'Add the clips to both SSD copies?',
        detail: `The same session is also on another drive:\n${twin}\n\nChoose "Only this one" to file into ${first} alone.`,
        confirmLabel: 'Both copies', cancelLabel: 'Only this one', danger: false,
      })) state.filedSessions.other2 = twin;
    } else {
      // Source drive(s) already added: file into each drive's own session folder,
      // so a two-SSD job updates both copies in one pass.
      const filed = {};
      for (const s of sources) {
        const folder = await window.api.pickFolder(
          `Choose the existing session folder for ${s.label}`);
        if (!folder) return;               // cancelled — leave any prior state intact
        let d;
        try {
          d = await call('detect_structure', { root: folder }, { label: 'Reading session' });
        } catch (e) { toast(e.message, 'err'); return; }
        const sessionPath = d.session_path || folder;
        filed[filedKeyFor(s.path)] = sessionPath;
        s.dest = parentDir(sessionPath);
        state.detected[s.path] = d;
      }
      state.filedSessions = filed;
    }
  }
  await finishClipsOnlyEntry();
}

/**
 * Clips-only into session folders already known (the event schedule found
 * them on the drives): one per SSD copy, at most two. Any source drives and
 * structure set up for another backup are put aside.
 */
async function clipsOnlyInto(paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return;
  state.template = null; state.templates = [];
  state.sources = [];
  if (isInformal()) {
    state.informalDest = parentDir(list[0]);
    state.filedSessions = { informal: list[0] };
  } else {
    state.filedSessions = { other: list[0], ...(list[1] ? { other2: list[1] } : {}) };
  }
  await finishClipsOnlyEntry();
}

/** The other connected drives' copy of a session folder, or null. */
async function findSessionCopies(sessionPath) {
  try {
    const job = parentDir(sessionPath);
    // Every other connected drive: not the one this copy sits on.
    const here = pathKey(sessionPath);
    const roots = (state.volumes || []).map((v) => v.path)
      .filter((r) => !here.startsWith(`${pathKey(r).replace(/\/+$/, '')}/`));
    if (!roots.length) return null;
    const jobName = job.split(/[\\/]/).pop();
    const r = await call('schedule_find_sessions',
      { roots, job: jobName, session: sessionPath.split(/[\\/]/).pop() });
    const other = (r.found || []).find((f) => pathKey(f.session_path) !== pathKey(sessionPath));
    return other ? other.session_path : null;
  } catch (_) {
    return null;   // nothing found is not an error: one copy is fine
  }
}

/** The "second SSD copy" control on the clips-only card, when it applies. */
function secondCopyButton() {
  if (!state.clipsOnly || isInformal() || footageSources().length || !state.filedSessions.other) return '';
  return state.filedSessions.other2
    ? '<button class="sm ghost" id="btnSecondCopyOff">Only the first copy</button>'
    : '<button class="sm" id="btnSecondCopy">＋ Second SSD copy…</button>';
}

async function addSecondCopy() {
  const folder = await window.api.pickFolder('Choose the same session folder on the other SSD');
  if (!folder) return;
  let d;
  try {
    d = await call('detect_structure', { root: folder }, { label: 'Reading session' });
  } catch (e) { toast(e.message, 'err'); return; }
  const second = d.session_path || folder;
  if (pathKey(parentDir(parentDir(second))) === pathKey(parentDir(parentDir(state.filedSessions.other)))) {
    toast('That is the same drive as the first copy — choose the folder on the other SSD.', 'warn');
    return;
  }
  state.filedSessions.other2 = second;
  state.plan = null; state.namingPreview = null; state.runResult = null;
  state.camSeededKey = null;
  await ensureExistingCamNamesSeeded();
  render();
}

function dropSecondCopy() {
  delete state.filedSessions.other2;
  state.plan = null; state.namingPreview = null; state.runResult = null;
  render();
}

async function finishClipsOnlyEntry() {
  state.clipsOnly = true;
  state.mastersFiled = true;              // reuse the in-place, no-master plan path
  state.masters = {}; state.masterSource = null;
  state.plan = null; state.namingPreview = null; state.runResult = null;
  // Learn the real (possibly suffixed) names of the cameras already in the
  // folder, so the Cameras page shows "Cam-05 (Drone)" and a clip assigned to
  // cam 5 files into that folder instead of a new bare "Cam-05".
  await ensureExistingCamNamesSeeded();
  toast('Clips-only mode on — assign the camera clips on the next page.', 'ok');
  goStep(2);
}

// The existing session folder(s) being completed, whichever flow we're in:
// clips-only, an informal add, or a formal drive whose session was detected or
// filed earlier. Empty when starting a fresh folder (nothing to adopt).
function completingFolderPaths() {
  const paths = [];
  if (state.clipsOnly) {
    for (const v of Object.values(state.filedSessions)) if (v) paths.push(v);
  } else if (isInformal()) {
    if (state.filedSessions.informal) paths.push(state.filedSessions.informal);
  } else {
    for (const s of footageSources()) {
      const filed = state.filedSessions[filedKeyFor(s.path)];
      const det = state.detected[s.path] && state.detected[s.path].session_path;
      if (filed) paths.push(filed);
      else if (det) paths.push(det);
    }
  }
  return paths.filter(Boolean);
}

// Adopt existing suffixed cam names once per session context, before the Cameras
// page is used — covers clips-only AND the normal "add cameras to an existing
// folder" flow (after a copy, or reopening a folder completed earlier).
async function ensureExistingCamNamesSeeded() {
  const key = completingFolderPaths().map((p) => pathKey(p)).sort().join('|');
  if (!key || key === state.camSeededKey) return;
  state.camSeededKey = key;
  await seedExistingCamNames();
  render();
}

// Read the destination's existing camera folders and adopt any suffixed names
// (Cam-05 (Drone), Cam-08 (MM Drone), Cam-05 (Audio)) so the Cameras page shows
// them and files into them, rather than creating a bare "Cam-NN" duplicate.
async function seedExistingCamNames() {
  try {
    const spec = buildSpec();
    spec.targets = (spec.targets || []).map((t) => ({ ...t, cams: {} }));
    if (!spec.targets.length) return;
    const plan = await call('build_plan', spec);   // silent: no footer takeover
    state.existingCamCounts = selectionRules.existingCamCounts(plan, state.camNames);
    for (const t of plan.targets || []) {
      // existing_cam_folders lists every camera folder on disk (empty ones too),
      // so a resumed session shows a chip for each without first visiting Folder.
      // Fall back to existing_cams for an older engine that omits the new field.
      const folders = Object.keys(t.existing_cam_folders || {}).length
        ? Object.entries(t.existing_cam_folders).map(([num, name]) => [Number(num), String(name).trim()])
        : Object.keys(t.existing_cams || {}).map((name) => {
            const m = /^Cam-(\d+)\b/i.exec(String(name).trim());
            return [m ? Number(m[1]) : NaN, String(name).trim()];
          });
      for (const [num, clean] of folders) {
        if (!Number.isFinite(num)) continue;
        const bare = `Cam-${String(num).padStart(2, '0')}`;
        // Grow the count to cover this folder's number, whether it is bare
        // "Cam-05" or suffixed "Cam-05 (Drone)", so it renders as a chip.
        state.camCount = Math.max(state.camCount, num);
        // Only adopt a suffixed name, and never overwrite one the operator typed.
        if (clean !== bare && !(state.camNames[num] || '').trim()) {
          state.camNames[num] = clean;
        }
      }
    }
  } catch (e) {
    // A failed seed (e.g. the engine was still starting) must be retryable, so
    // clear the guard that would otherwise suppress the next attempt.
    state.camSeededKey = null;
    // Non-fatal: without seeding the chips just stay bare "Cam-NN".
  }
}

function exitClipsOnly() {
  state.clipsOnly = false;
  state.mastersFiled = false;
  state.filedSessions = {};
  state.camSeededKey = null;
  state.plan = null; state.namingPreview = null; state.runResult = null;
  goStep(0);
}

function renderClipsOnlyFolder() {
  const chosen = clipsOnlySessions();
  const rows = chosen
    .map((p) => `<div class="mono" style="margin-top:4px">${esc(p)}</div>`).join('');
  return `<div class="card">
    <h3>Clips-only — existing session</h3>
    <p class="hint">Late-arriving camera clips will be filed straight into the folder(s) below and
      renamed in the usual scheme. No master is needed and the folder name is left as it is.</p>
    <div class="note ok">${rows || 'No session chosen yet — go back to Sources.'}</div>
    <p class="hint" style="margin-top:12px">Continue to <b>Cameras</b> to select the clips with
      <b>Add files</b> / <b>Add a folder</b>, then review and copy as normal.</p>
  </div>`;
}

function renderSession() {
  if (state.clipsOnly) return renderClipsOnlyFolder();

  const src = primarySource();
  if (!src) return `<div class="empty"><div class="big">📁</div>Add a source first.</div>`;

  if (state.template) return renderTemplateFolder(src);

  const d = state.detected[src.path];
  if (!d) {
    return `<div class="card">
      <h3>Read the folder from the drive</h3>
      <p class="hint">The app looks for the session folder on
        <span class="mono">${esc(src.label)}</span> — the one holding
        “Clips for Insert” — and reads its name from the disk.</p>
      <button class="primary" id="btnDetect">Find the session folder</button>
    </div>`;
  }

  if (!d.session_path) {
    return `<div class="card">
      <h3>No session folder found</h3>
      <div class="note warn">${esc(d.reason)}</div>
      <p class="hint">Choose the folder, or create a new one.</p>
      <div class="row">
        <button class="primary" id="btnPickSession">Choose the session folder…</button>
        <button id="btnCreateMode">Create a new folder instead</button>
      </div>
      ${state.session.destMode === 'create' ? createFolderForm() : ''}
    </div>`;
  }

  const masters = chosenMasters();
  const dur = masterTotalSeconds();
  const diskBase = stripClipsToken(d.base_name || d.session_name);
  const renamed = state.renameBase != null && state.renameBase !== diskBase;
  const base = renamed ? state.renameBase : diskBase;
  const durLabel = fmtDurAuto(dur);
  const already = d.has_dur && d.current_dur != null;
  const unchanged = already && dur != null && Math.abs(d.current_dur - dur) < 1;
  const cams = Array.from({ length: state.camCount }, (_, index) => index + 1);

  return `
  <div class="card">
    <h3>Edit session folder</h3>
    <p class="hint">${esc(d.reason)} The current name is read from disk; edit the field
      below if the session folder should be renamed.</p>
    <div class="preview-name">
      ${d.job_name ? `📁 ${esc(d.job_name)}<br>` : ''}
      <span class="${d.job_name ? 'indent1' : ''}" style="display:inline-block">📁
        ${esc(base)}${isInformal() ? '' : ` <b>Dur-${esc(durLabel)}</b>`} ${nameCount(isInformal() ? base : `${base} Dur-${durLabel}`)}</span>
      ${isInformal() || !cams.length ? ''
        : '<div class="indent2" style="color:var(--muted)">📁 Clips for Insert</div>'}
      ${cams.map((n) => `<div class="${isInformal() ? 'indent2' : 'indent3'}" style="color:var(--muted)">📁 ${esc(camLabel(n))}</div>`).join('')}
      ${isInformal() && state.camCount === 0
        ? '<div class="indent2" style="color:var(--muted)">📄 clips filed here (session root — no camera folders)</div>'
        : (isInformal() && rootAssignedCount() > 0
          ? `<div class="indent2" style="color:var(--muted)">📄 + ${rootAssignedCount()} clip${rootAssignedCount() === 1 ? '' : 's'} in the session root</div>`
          : '')}
    </div>
    <div class="row" style="margin:10px 0 0;align-items:center;gap:8px">
      <label class="field" style="flex:1;max-width:520px;margin:0"><span>Edit session folder name${
        renamed ? ' <b style="color:var(--accent)">(renamed)</b>' : ''}</span>
        <input type="text" id="fRename" value="${esc(base)}"
          placeholder="${esc(diskBase)}" /></label>
      ${renamed ? '<button class="sm ghost" id="btnRenameReset">Reset to disk name</button>' : ''}
    </div>
    ${nameCleanupControls(diskBase)}
    <p class="hint" style="margin:8px 0 0">${isInformal()
      ? 'No mixer master or Dur- calculation is used. Every camera clip is renamed from this event name after assignment.'
      : `The bold <b>Dur-${esc(durLabel)}</b> is the only part the app adds. Edit the name above
      to rename the folder${renamed ? ` — it is renamed from <span class="mono">${esc(diskBase)}</span> on copy`
        : '; leave it to keep the folder\'s existing name'}. The Dur-/Clips- tokens are kept for you.`}
      Camera folders are managed on the Cameras step.</p>
    ${!isInformal() && already ? `<div class="note ${unchanged ? 'ok' : 'warn'}" style="margin-top:10px">
      ${unchanged
        ? `This folder already reads <b>Dur-${esc(fmtDurLike(d.current_dur, d.session_name))}</b> and matches the
           master, so its name will not change.`
        : `Dur- will change from <b>${esc(fmtDurLike(d.current_dur, d.session_name))}</b> to
           <b>${esc(durLabel)}</b> to match the master.`}
    </div>` : ''}
    <div class="row" style="margin-top:12px">
      <button class="sm ghost" id="btnRedetect">Look again</button>
      <button class="sm ghost" id="btnPickSession">Choose a different folder…</button>
    </div>
  </div>

  ${isInformal() ? '' : `<div class="card">
    <h3>Master clip${masters.length > 1 ? 's' : ''}</h3>
    <p class="hint">The Dur- token is read from ${masters.length > 1 ? 'these files' : 'this file'}.
      Tick more than one if the session was recorded in several — the folder's Dur- becomes
      their total and each is renamed with its own Dur- and a Clip-NN.</p>
    ${(d.master_candidates || []).length ? `
      <table><thead><tr><th style="width:1%"></th><th>File</th>
        <th class="num">Length</th><th>Codec</th><th class="num">Size</th></tr></thead>
      <tbody>${d.master_candidates.map((c) => `
        <tr><td><input type="checkbox" data-master="${esc(c.path)}"
              data-msrc="${esc(src.path)}"
              ${masters.some((m) => m.path === c.path) ? 'checked' : ''} style="width:auto" /></td>
          <td class="mono">${esc(c.name)}</td>
          <td class="num">${esc(fmtClock(c.duration))}</td>
          <td><span class="badge ${esc(c.family || '')}">${esc(c.video_codec || '?')}</span></td>
          <td class="num">${fmtBytes(c.size)}</td></tr>`).join('')}
      </tbody></table>
      ${masters.length > 1 ? `<p class="hint" style="margin:10px 0 0">
        ${masters.map((m) => esc(fmtDurAuto(m.duration))).join(' + ')} =
        <b>${esc(durLabel)}</b> on the folder, with <b>Clips-${
          String(masters.length).padStart(2, '0')}</b>.</p>` : ''}`
      : `<div class="note err">No master recording in this folder, so Dur- can't be set.
         Add it here or choose another folder.</div>`}
  </div>`}

  <div class="card">
    <h3>Filing the clips</h3>
    <p class="hint">${isInformal()
      ? `There is no mixer master. Assigned clips are arranged into their camera folders and renamed
         <b>Cam-NN Event Name Clip-001.ext</b> in modified-time order. On the same drive they are
         relocated; to another drive they are copied.`
      : `The master is <b>moved</b> into the folder — it is already on this drive,
         so it just relocates. Camera clips are <b>copied</b> to both SSDs. Nothing is ever
         deleted; clear the camera cards yourself when you are ready.`}</p>
    <label class="field" style="max-width:340px"><span>Verification</span>
      <select id="fVerify">
        <option value="size">Size check (fast)</option>
        <option value="hash">Checksum every file (bit-exact, slower)</option>
        <option value="none">None</option>
      </select></label>
    ${isInformal() ? '' : `<p class="hint" style="margin:0">Moving is the usual choice when the clips are already
      on the right drive and only need filing — copying leaves a second copy behind at the
      folder's top level.</p>`}
  </div>`;
}

/**
 * Give every clip in play a cam, defaulting to Cam-01.
 *
 * Landing on the Cameras page with everything set to Skip means the common case
 * — one camera, all clips to Cam-01 — needs a click per clip for no reason.
 * Skip stays available, it is just no longer the default.
 */
/** Split clips by camera/card identity, with recording format as a fallback. */
function camGroupsFromPool(files) {
  return selectionRules.cameraGroups(files, window.api.platform);
}

// What sort of source a clip is, used to auto-name its camera folder so the
// preview reads e.g. "Cam-05 (Audio)" / "Cam-06 (Drone)" before the copy.
const AUDIO_CLIP_EXTS = new Set(['wav', 'mp3', 'aac', 'm4a', 'flac', 'ogg',
                                 'opus', 'wma', 'aif', 'aiff']);

function clipKind(file) {
  const name = String((file && (file.name || file.path)) || '').split(/[\\/]/).pop();
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (AUDIO_CLIP_EXTS.has(ext)) return 'audio';
  if (/^dji_/i.test(name)) {
    const stem = name.replace(/\.[^.]+$/, '');
    // DJI names the AV-mode files "..._D_AV"; the plain (motion-master) files
    // have no AV token.
    return /(^|_)av(?=_|$)/i.test(stem) ? 'drone_av' : 'drone_mm';
  }
  return 'camera';
}

function kindSuffix(kind) {
  return kind === 'audio' ? ' (Audio)'
    : kind === 'drone_av' ? ' (Drone)'
      : kind === 'drone_mm' ? ' (MM Drone)' : '';
}

// Group clips for auto-suggest, keeping audio, AV-drone and motion-drone as
// their own cameras rather than merging them by drive/format.
function camGroupsWithKind(files) {
  const byKind = {};
  for (const f of files || []) (byKind[clipKind(f)] = byKind[clipKind(f)] || []).push(f);
  const out = [];
  for (const kind of ['camera', 'audio', 'drone_av', 'drone_mm']) {
    for (const g of selectionRules.cameraGroups(byKind[kind] || [], window.api.platform)) {
      out.push({ kind, files: g });
    }
  }
  return out;
}

// Give a camera a "(Audio)" / "(Drone)" / "(MM Drone)" folder name from the
// clips assigned to it — only when its clips are all one such kind and the
// operator hasn't typed their own name for it.
function applyKindCamName(cam, kind) {
  const suffix = kindSuffix(kind);
  if (!suffix) return;
  const current = (state.camNames[cam] || '').trim();
  const isDefault = !current || /^Cam-\d+(\s*\(.*\))?$/i.test(current);
  if (isDefault) state.camNames[cam] = `Cam-${String(cam).padStart(2, '0')}${suffix}`;
}

// The kind suffix a cam folder has earned from its current clips: a kind tag
// when every assigned clip is that one non-camera kind, otherwise nothing.
function camKindSuffix(files) {
  if (!files.length) return '';
  const kinds = new Set(files.map(clipKind));
  if (kinds.size !== 1) return '';                 // mixed → no tag
  const [only] = kinds;
  return only === 'camera' ? '' : kindSuffix(only);
}

// Re-derive the "(Audio)" / "(Drone)" / "(MM Drone)" tag on every cam folder
// from the clips it currently holds. Moving audio/drone clips out of a folder
// (or into another) must carry the tag with them: a folder left holding regular
// video loses the tag, the folder that received the clips gains it. Only auto /
// default names are touched — a name the operator typed is left alone.
function reconcileKindCamNames() {
  const src = primarySource();
  if (!src) return;
  const byCam = {};
  for (const f of cameraFiles(src)) {
    const cam = state.assign[f.path];
    if (typeof cam === 'number') (byCam[cam] = byCam[cam] || []).push(f);
  }
  for (let cam = 1; cam <= state.camCount; cam += 1) {
    const current = (state.camNames[cam] || '').trim();
    const isDefault = !current || /^Cam-\d+(\s*\(.*\))?$/i.test(current);
    if (!isDefault) continue;                        // operator-named, leave it
    const suffix = camKindSuffix(byCam[cam] || []);
    const name = `Cam-${String(cam).padStart(2, '0')}${suffix}`;
    if (suffix) state.camNames[cam] = name;
    else delete state.camNames[cam];                 // back to a bare Cam-NN
  }
}

/** A cam's folder name: the custom name if set, else "Cam-NN". Cam 0 is Root. */
function camLabel(n) {
  if (Number(n) <= 0) return 'Root';
  return (state.camNames[n] || '').trim() || `Cam-${String(n).padStart(2, '0')}`;
}

function ensureDefaultAssignments() {
  const src = primarySource();
  if (!src) return;
  for (const f of cameraFiles(src)) {
    if (state.assign[f.path] === undefined) {
      state.assign[f.path] = defaultAssignmentFor(f);
    }
  }
}

/** Select every clip from one day and skip the rest — the day buttons' action. */
function selectDay(day) {
  const src = primarySource();
  if (!src) return;
  const cam = firstEmptyCam();
  for (const f of cameraFiles(src)) {
    state.assign[f.path] = (!day || f.shoot_date === day) ? cam : 'skip';
  }
  state.activeDay = day || null;
  state.plan = null; state.namingPreview = null;
}

/**
 * Clips long enough to plausibly be the program recording.
 *
 * The Folder page only needs to answer "which file sets the Dur- token", and a
 * list of eighty 6-second camera clips buries the one 60-minute file that is
 * the actual answer. Anything at least half the length of the longest clip
 * qualifies; the full list is one click away when the heuristic misfires.
 */
/**
 * The clips offered as masters for one drive: those at the drive ROOT.
 *
 * The program recording lives at the drive root; camera clips are nested in
 * card folders. Showing only root files keeps the picker to the handful of
 * files that could actually be the master. "Show all" lifts the root filter.
 */
function drivePlausibleMasters(src) {
  if (state.showAllMasters) return filePool(src);
  const picked = new Set(mastersFor(src).map((m) => m.path));
  return filePool(src).filter((c) => atDriveRoot(c, src) || picked.has(c.path));
}

function plausibleMasters() {
  const all = masterCandidates();
  if (state.showAllMasters || all.length <= 1) return all;
  const longest = Math.max(...all.map((c) => c.file.duration || 0));
  if (!longest) return all;
  const picked = masterPaths();
  const kept = all.filter((c) => (c.file.duration || 0) >= longest * 0.5
    || picked.has(c.file.path));
  return kept.length ? kept : all;
}

/** Every clip in play on every footage drive, tagged with the drive it is on. */
function masterCandidates() {
  const out = [];
  for (const f of footageSources()) {
    for (const file of filePool(f)) out.push({ file, source: f });
  }
  return out;
}

/** The Folder step when the name came from an imported structure template. */
/** One drive's footage controls and its own master-clip picker, as a column. */
function renderDriveColumn(f) {
  const loaded = allFiles(f).length;
  const inPlay = selected(f).length;
  const held = skipped(f).length;
  const base = state.clipTitle || state.renameBase || stripClipsToken((state.template && (state.template.base_name
    || state.template.session_name)) || '');
  const masters = mastersFor(f);
  const total = masterTotalFor(f);
  const shown = drivePlausibleMasters(f);

  return `<div class="drive-col">
    <div class="drive-col-head">
      <div>
        <div class="name">${esc(f.label)} <span class="badge ${f.role}">${esc(f.role)}</span></div>
        <div class="path">${esc(f.path)}</div>
      </div>
      <div class="row" style="gap:6px">
        <button class="sm ${loaded ? '' : 'primary'}" data-scan="${esc(f.path)}"
          title="Reads only the drive root, where the master lives">Scan</button>
        <button class="sm" data-deepscan="${esc(f.path)}"
          title="Walks the whole drive for footage nested in card folders">Detailed scan</button>
        <button class="sm" data-addfiles="${esc(f.path)}">Add files…</button>
        <button class="sm" data-addfolder="${esc(f.path)}">Folder…</button>
      </div>
    </div>
    <div class="row" style="margin:8px 0">
      ${loaded ? `<span class="badge ${inPlay ? 'ok' : 'warn'}">${inPlay} selected</span>`
        : '<span class="badge warn">nothing loaded</span>'}
      ${held ? `<span class="badge">${held} on Skip</span>` : ''}
      ${masters.length ? `<span class="badge ${f.role}">master ${
        esc(fmtDurAuto(total))}${masters.length > 1 ? ` · ${masters.length} clips` : ''}</span>` : ''}
    </div>
    ${loaded ? `
      <div class="scroll" style="max-height:300px"><table>
        <colgroup><col style="width:32px" /><col />
          <col style="width:70px" /><col style="width:88px" /></colgroup>
        <thead><tr>
        <th class="chk"></th><th>Master clip</th>
        <th class="num">Length</th><th class="num">Size</th></tr></thead>
      <tbody>${shown.map((c) => `
        <tr><td class="chk"><input type="checkbox" data-master="${esc(c.path)}"
              data-msrc="${esc(f.path)}"
              ${masters.some((m) => m.path === c.path) ? 'checked' : ''} /></td>
          <td class="mono" title="${esc(c.name)}">${esc(c.name)}</td>
          <td class="num">${esc(fmtClock(c.duration))}</td>
          <td class="num">${fmtBytes(c.size)}</td></tr>`).join('')}
      </tbody></table></div>
      ${filePool(f).length > shown.length || state.showAllMasters ? `
        <p class="hint" style="margin:8px 0 0">Showing ${shown.length} of ${filePool(f).length}
          — short camera clips hidden.
          <a href="#" data-allmasters="1">${state.showAllMasters
            ? 'likely masters only' : 'show all'}</a></p>` : ''}
      ${masters.filter((m) => offSessionDate(m)).length ? `
        <div class="note warn" style="margin:8px 0 0">
          ${(() => {
            const off = masters.filter((m) => offSessionDate(m));
            return `${off.map((m) => esc(m.name)).join(', ')} ${off.length > 1 ? "weren't" : "wasn't"}
              recorded on ${esc(fmtDay(sessionDate()))}. Check ${off.length > 1
                ? "they're the right masters" : "it's the right master"}.`;
          })()}</div>` : ''}
      ${masters.length ? `
        <p class="hint" style="margin:10px 0 4px">Renamed after the folder:</p>
        <div class="preview-name" style="font-size:11px">${masters.map((m, i) => {
          const nm = masterDisplayName(m, i + 1, masters.length, base);
          return `🎬 ${esc(nm)} ${nameCount(nm)}`;
        }).join('<br>')}
        </div>
        ${masters.length > 1 ? `<p class="hint" style="margin:6px 0 0">${
          masters.map((m) => esc(fmtDurAuto(m.duration))).join(' + ')} =
          <b>${esc(fmtDurAuto(total))}</b>, Clips-${String(masters.length).padStart(2, '0')}.</p>` : ''}`
        : '<p class="hint" style="margin:8px 0 0">Tick the program recording above.</p>'}
      ${ceremonySection(f)}`
      : `<div class="note warn" style="margin:0">No files loaded. Click Scan or Add files.</div>`}
  </div>`;
}

// Formal only: offer to include and rename the session's short bookend clips.
// Each distinct short clip is listed once — the earliest with a choice of
// "Pujyashree's Welcome" or "Pujyashree's Entry", the latest as "Pujyashree's
// Exit" — with the label checkboxes shown beneath the clip name. The labels for
// a clip are mutually exclusive because the tag is recorded per path, so when a
// drive has only one short clip its single block offers all three.
function ceremonySection(f) {
  const { entry, exit } = selectionRules.entryExitCeremonyClips(filePool(f), CEREMONY_MAX_SECONDS);
  if (!entry && !exit) return '';
  const single = entry && exit && entry.path === exit.path;
  const choice = (kind, clip) => {
    const checked = state.ceremonyNames[clip.path] === ceremonyTag(kind);
    return `<label style="display:inline-flex;gap:6px;align-items:center;cursor:pointer;width:auto">
      <input type="checkbox" style="width:auto" data-ceremony="${kind}"
        data-cpath="${esc(clip.path)}" data-csrc="${esc(f.path)}" ${checked ? 'checked' : ''} />
      <b>Pujyashree's ${kind}</b></label>`;
  };
  const block = (clip, kinds) => {
    if (!clip) return '';
    return `<div style="margin:8px 0 0">
      <div><span class="mono">${esc(clip.name)}</span> (${esc(fmtClock(clip.duration))})</div>
      <div class="row" style="gap:16px;margin:4px 0 0 22px">
        ${kinds.map((kind) => choice(kind, clip)).join('')}
      </div>
    </div>`;
  };
  return `<div class="note info" style="margin:10px 0 0">
    <div style="font-weight:600;margin-bottom:2px">Pujyashree's Welcome / Entry / Exit</div>
    <p class="hint" style="margin:0 0 6px">The shortest bookend clips (under 8 min) are
      usually the entry and exit recordings. Tick a label to include the clip as a master
      and rename it. Only one label applies to a clip at a time.</p>
    ${single
      ? block(entry, ['Welcome', 'Entry', 'Exit'])
      : `${block(entry, ['Welcome', 'Entry'])}${block(exit, ['Exit'])}`}
  </div>`;
}

/** Preserve the imported tree while applying camera folders added/removed here. */
function editedTemplateDirs(template) {
  return selectionRules.normalizedTemplateDirs(template, state.camCount, isInformal());
}

/** The editable camera-folder skeleton when completing an existing folder. */
function cameraStructureDirs() {
  return Array.from({ length: state.camCount }, (_, index) =>
    `${isInformal() ? '' : 'Clips for Insert/'}Cam-${String(index + 1).padStart(2, '0')}`);
}

/** All sessions carried by the structure ZIP; exactly one is active per plan. */
function renderTemplateSessionChoices() {
  const choices = state.templates.length ? state.templates : [state.template].filter(Boolean);
  const current = pathKey((state.template && state.template.session_path) || '');
  return `<div class="card">
    <h3>Choose session from structure</h3>
    <p class="hint">The structure contains ${choices.length} session${choices.length === 1 ? '' : 's'}.
      Select the event that belongs to the footage you are backing up now. You can return and
      choose another event later—the backup order does not matter.</p>
    ${choices.map((choice, index) => {
      const selected = pathKey(choice.session_path) === current;
      const count = selectionRules.importedCamCount(choice, 0);
      return `<label class="source-card ${selected ? 'selected' : ''}" style="cursor:pointer">
        <input type="radio" name="template-session" data-template-session="${index}"
          ${selected ? 'checked' : ''} style="width:auto;margin-top:3px" />
        <div class="body">
          <div class="name">${esc(choice.session_name)}</div>
          <div class="path">${esc(choice.job_name || 'No job folder')}</div>
          <div class="hint" style="margin:4px 0 0">${count} camera folder${count === 1 ? '' : 's'}
            ${choice.session_date ? ` · ${esc(fmtDay(choice.session_date))}` : ''}</div>
        </div>
      </label>`;
    }).join('')}
  </div>`;
}

// Clean up a session name read from a structure zip or from disk: drop a
// repeated word and a long "Satsang on Topic" topic. The result becomes the
// session name (as if typed), which the master filenames follow. Tick boxes
// under the name field put either part back.
function adoptFolderName(original) {
  const info = selectionRules.cleanSessionName(original);
  if (!info.repeat && !info.topic) {
    state.nameCleanup = null;
    return;
  }
  state.nameCleanup = { original, repeat: info.repeat, topic: info.topic,
                        keepRepeat: false, keepTopic: false };
  state.renameBase = info.name !== original ? info.name : null;
}

function applyNameCleanup() {
  const c = state.nameCleanup;
  if (!c) return;
  const name = selectionRules.cleanSessionName(
    c.original, { keepRepeat: c.keepRepeat, keepTopic: c.keepTopic }).name;
  state.renameBase = name !== c.original ? name : null;
  state.plan = null; state.namingPreview = null;
}

function nameCleanupControls(original) {
  const c = state.nameCleanup;
  if (!c || c.original !== original) return '';
  const box = (key, checked, label) => `<label class="row" style="gap:8px;align-items:center;margin:4px 0;cursor:pointer">
      <input type="checkbox" style="width:auto" data-namekeep="${key}" ${checked ? 'checked' : ''} />
      <span>${label}</span></label>`;
  return `<div class="note info" style="margin:10px 0 0">
    <div style="font-weight:600;margin-bottom:4px">Name shortened automatically</div>
    ${c.repeat ? box('repeat', c.keepRepeat,
      `Keep repeated word <b>${esc(c.repeat.join(', '))}</b>`) : ''}
    ${c.topic ? box('topic', c.keepTopic,
      `Keep topic <span class="mono">${esc(c.topic)}</span> (${Array.from(c.topic).length} characters)`) : ''}
  </div>`;
}

// A day's first session is usually filed before the zip has a second one, so
// it lands without "01 ". When the zip numbers its sessions, look in the job
// folder on every destination for such folders and offer to number them.
async function refreshSessionNumbering() {
  state.sessionNumbering = [];
  const t = state.template;
  if (!t) return;
  const sep = window.api.platform === 'win32' ? '\\' : '/';
  const job = state.jobNameOverride != null ? state.jobNameOverride : (t.job_name || '');
  const roots = isInformal() ? [destOf(primarySource())] : footageSources().map(destOf);
  const jobDirs = [...new Set(roots.filter(Boolean)
    .map((root) => (job ? root.replace(/[\\/]+$/, '') + sep + job : root)))];
  const sessions = (state.templates.length ? state.templates : [t])
    .map((x) => x.session_name).filter(Boolean);
  if (!jobDirs.length || !sessions.length) return;
  try {
    const r = await call('find_unnumbered_sessions', { job_dirs: jobDirs, sessions });
    state.sessionNumbering = r.renames || [];
  } catch {
    // Only a suggestion; without it the backup works exactly as before.
  }
  render();
}

function sessionNumberingNote() {
  const list = state.sessionNumbering || [];
  if (!list.length) return '';
  const leaf = (path) => String(path).split(/[\\/]/).pop();
  const drive = (path) => String(path).split(/[\\/]/)[0] || '/';
  return `<div class="card">
    <div class="note warn">
      <b>${list.length === 1 ? 'An earlier session has' : `${list.length} earlier session folders have`}
        no session number.</b> It was filed before this day had a second session.
      ${list.map((r) => `<div class="mono" style="margin-top:8px">${esc(drive(r.path))} ${esc(leaf(r.path))}
        <br>↳ ${esc(leaf(r.new_path))}</div>`).join('')}
      <div class="row" style="margin-top:10px">
        <button class="sm primary" id="btnNumberSessions">Add the number${list.length === 1 ? '' : 's'}</button>
      </div>
    </div>
  </div>`;
}

function renderTemplateFolder(src) {
  const t = state.template;
  const masters = chosenMasters();
  const dur = masterTotalSeconds();
  const templateBase = stripClipsToken(t.base_name || t.session_name);
  const renamed = state.renameBase != null && state.renameBase !== templateBase;
  const base = renamed ? state.renameBase : templateBase;
  const originalJob = t.job_name || '';
  const jobName = state.jobNameOverride != null ? state.jobNameOverride : originalJob;
  const jobRenamed = jobName !== originalJob;
  const durLabel = fmtDurAuto(dur);
  const cams = Array.from({ length: state.camCount }, (_, index) => index + 1);

  return `
  ${renderTemplateSessionChoices()}
  ${sessionNumberingNote()}
  <div class="card">
    <h3>Edit job and session folders</h3>
    <p class="hint">Edit the imported job and session names here before copying. The preview updates
      after you press Enter or leave a field.</p>
    <div class="preview-name">
      ${jobName ? `📁 ${esc(jobName)} ${nameCount(jobName)}<br>` : ''}
      <span class="${jobName ? 'indent1' : ''}" style="display:inline-block">📁
        ${esc(base)}${isInformal() ? '' : ` <b>Dur-${esc(durLabel)}</b>`} ${nameCount(isInformal() ? base : `${base} Dur-${durLabel}`)}</span>
      ${isInformal() || !(cams.length || (t.tree || []).some((e) =>
          /^clips for insert\/?$/i.test(String(e).replace(/\\/g, '/')))) ? ''
        : '<div class="indent2" style="color:var(--muted)">📁 Clips for Insert</div>'}
      ${cams.map((n) => `<div class="${isInformal() ? 'indent2' : 'indent3'}" style="color:var(--muted)">📁 ${esc(camLabel(n))}</div>`).join('')}
      ${isInformal() && state.camCount === 0
        ? '<div class="indent2" style="color:var(--muted)">📄 clips filed here (session root — no camera folders)</div>'
        : (isInformal() && rootAssignedCount() > 0
          ? `<div class="indent2" style="color:var(--muted)">📄 + ${rootAssignedCount()} clip${rootAssignedCount() === 1 ? '' : 's'} in the session root</div>`
          : '')}
    </div>
    <div class="grid2" style="margin-top:12px">
      <label class="field"><span>Edit job folder${
        jobRenamed ? ' <b style="color:var(--accent)">(renamed)</b>' : ''}</span>
        <input type="text" id="fStructureJob" value="${esc(jobName)}"
          placeholder="${esc(originalJob)}" /></label>
      <label class="field"><span>Edit session folder${
        renamed ? ' <b style="color:var(--accent)">(renamed)</b>' : ''}</span>
        <input type="text" id="fRename" value="${esc(base)}"
          placeholder="${esc(templateBase)}" /></label>
    </div>
    ${nameCleanupControls(templateBase)}
    <div class="row" style="margin-top:10px">
      ${(renamed || jobRenamed)
        ? '<button class="sm ghost" id="btnFolderNamesReset">Reset folder names</button>' : ''}
    </div>
    <p class="hint" style="margin:8px 0 0">${isInformal()
      ? 'No mixer master or codec role is required. Camera clips will be renamed from the event name shown above.'
      : `The bold <b>Dur-${esc(durLabel)}</b> is the only part the app adds${t.has_dur && dur != null
        ? (fmtDurLike(t.current_dur, t.session_name) === durLabel
            ? `, and it already matches what the structure came with`
            : `, replacing the <b>Dur-${esc(fmtDurLike(t.current_dur, t.session_name))}</b>
               placeholder the structure came with`)
        : ''}.`} Empty camera folders are recreated with the names shown above.</p>
    <div class="row" style="margin-top:12px">
      ${isInformal()
        ? `<span class="badge informal">Output → ${esc(state.informalDest)}</span>`
        : footageSources().map((f) => `<span class="badge ${f.role}">${esc(f.label)}
          → ${esc(destOf(f).split(/[\\/]/).pop() || destOf(f))}</span>`).join('')}
    </div>
  </div>

  ${isInformal() ? '' : `<div class="card">
    <h3>Footage &amp; master clip</h3>
    <p class="hint">The structure carries no footage, so load it from each drive. The master is
      the program recording at the drive's root, dated ${esc(fmtDay(sessionDate()) || 'the session day')};
      the app pre-selects it and leaves the rest for you. Pick each drive's master independently —
      the same recording, one file per codec.</p>
    <div class="drive-cols">
      ${footageSources().map((f) => renderDriveColumn(f)).join('')}
    </div>
    ${dateSuggestion()}
  </div>`}

  <div class="card">
    <h3>Filing the clips</h3>
    <p class="hint">${isInformal()
      ? `There is no mixer master. Assigned camera clips are arranged into their camera folders and renamed
         <b>Cam-NN Event Name Clip-001.ext</b> in modified-time order. Clips are imported from
         the mounted SD cards into the output directory.`
      : `The master is <b>moved</b> into the folder — it is already on this drive,
         so it just relocates. Camera clips are <b>copied</b> to both SSDs. Nothing is ever
         deleted; clear the camera cards yourself when you are ready.`}</p>
    <label class="field" style="max-width:340px"><span>Verification</span>
      <select id="fVerify">
        <option value="size">Size check (fast)</option>
        <option value="hash">Checksum every file (bit-exact, slower)</option>
        <option value="none">None</option>
      </select></label>
  </div>`;
}

function createFolderForm() {
  return `
    <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:14px">
      <div class="grid2">
        <label class="field"><span>Job number</span>
          <input type="text" id="fJob" value="${esc(state.session.jobNumber)}" placeholder="3017" /></label>
        <label class="field"><span>Shoot date</span>
          <input type="date" id="fDate" value="${esc(state.session.date)}" /></label>
      </div>
      <label class="field"><span>Folder name</span>
        <input type="text" id="fTitle" value="${esc(state.session.title)}"
          placeholder="Adalaj Soneri … General Satsang E." /></label>
      <div class="preview-name">${sessionPreview()}</div>
    </div>`;
}

/** Preview for the fallback path where no folder exists yet and one is typed. */
function sessionPreview() {
  const master = chosenMaster();
  const date = state.session.date || (master ? master.shoot_iso.slice(0, 10) : '');
  const job = state.session.jobNumber.trim();
  const typed = state.session.title.trim() || 'Folder name';
  const durLabel = fmtDurAuto(masterTotalSeconds());
  const hasOwnDate = /\bDt-\d{1,2}-[A-Za-z]{3}-\d{2,4}\b/.test(typed);
  const jobLine = job && date ? `📁 ${esc(job)} <b>Dt-${esc(jobDateLabel(date))}</b><br>` : '';
  return jobLine +
    `<span class="${jobLine ? 'indent1' : ''}" style="display:inline-block">📁 ` +
    `${esc(typed.replace(/\s*\bDur-(?:\d+h)?(?:\d+m)?\d+s\b/i, ''))}` +
    `${date && !hasOwnDate ? ` <b>Dt-${esc(formatDateToken(date))}</b>` : ''}` +
    `${isInformal() ? '' : ` <b>Dur-${esc(durLabel)}</b>`}</span>`;
}

/** Drop a 'Clips-02' token — the count is recomputed from the chosen masters. */
function stripClipsToken(name) {
  return String(name || '').replace(/\s*\bClips-\d+\b/i, '').trim();
}

/** The name a master clip will be given, derived from the folder. */
function masterClipName(folderBase, seconds, index, count, path) {
  const ext = /\.[^./\\]+$/.exec(path || '');
  const base = stripClipsToken(folderBase)
    .replace(/\s*\bDur-(?=\d)(?:\d+h)?(?:\d+m)?(?:\d+s)?\b/i, '')
    .replace(/\s*\bClip-\d+\b/i, '')
    .replace(/^\d+\s+/, '')
    .trim();
  return `${base} Dur-${fmtDurAuto(seconds)}`
    + (count > 1 ? ` Clip-${String(index).padStart(2, '0')}` : '')
    + (ext ? ext[0] : '');
}

function jobDateLabel(iso) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${M[m - 1]} ${y}`;
}

function formatDateToken(iso) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${M[m - 1]}-${String(y).slice(2)}`;
}

function wireSession() {
  document.querySelectorAll('[data-template-session]').forEach((radio) =>
    radio.addEventListener('change', () => {
      if (radio.checked) activateTemplateSession(Number(radio.dataset.templateSession));
    }));
  $('btnDetect')?.addEventListener('click', () => detectStructure(primarySource()));
  $('btnRedetect')?.addEventListener('click', () => detectStructure(primarySource(), true));
  $('btnCreateMode')?.addEventListener('click', () => {
    state.session.destMode = 'create'; render();
  });
  $('btnPickSession')?.addEventListener('click', async () => {
    const chosen = await window.api.pickFolder('Choose the session folder');
    if (chosen) await detectStructure(primarySource(), true, chosen);
  });

  const fRename = $('fRename');
  if (fRename) {
    const diskBase = fRename.placeholder;
    const commit = () => {
      const v = fRename.value.trim();
      if (v !== (state.renameBase ?? diskBase)) state.nameCleanup = null;
      state.renameBase = (v && v !== diskBase) ? v : null;
      state.plan = null; state.namingPreview = null;
    };
    // Re-render on blur/Enter only, so typing does not steal focus mid-word.
    fRename.addEventListener('change', () => { commit(); render(); });
    fRename.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commit(); render(); }
    });
  }
  document.querySelectorAll('[data-namekeep]').forEach((box) => box.addEventListener('change', () => {
    if (!state.nameCleanup) return;
    state.nameCleanup[box.dataset.namekeep === 'repeat' ? 'keepRepeat' : 'keepTopic'] = box.checked;
    applyNameCleanup();
    render();
  }));
  // Resetting restores the original name, which is the same as keeping both parts.
  const keepAllCleanup = () => {
    if (state.nameCleanup) Object.assign(state.nameCleanup, { keepRepeat: true, keepTopic: true });
  };
  $('btnRenameReset')?.addEventListener('click', () => {
    keepAllCleanup();
    state.renameBase = null; state.plan = null; state.namingPreview = null; render();
  });

  const fStructureJob = $('fStructureJob');
  if (fStructureJob) {
    const original = fStructureJob.placeholder;
    const commit = () => {
      const value = fStructureJob.value.trim();
      state.jobNameOverride = value !== original ? value : null;
      state.plan = null; state.namingPreview = null;
    };
    fStructureJob.addEventListener('change', () => { commit(); render(); });
    fStructureJob.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { commit(); render(); }
    });
  }

  $('btnNumberSessions')?.addEventListener('click', async () => {
    const list = state.sessionNumbering || [];
    if (!list.length) return;
    const ok = await window.api.confirm({
      message: `Rename ${list.length} folder${list.length === 1 ? '' : 's'} to add the session number?`,
      detail: list.map((r) => `${r.path}\n  -> ${String(r.new_path).split(/[\\/]/).pop()}`).join('\n'),
      confirmLabel: 'Rename',
    });
    if (!ok) return;
    try {
      const r = await call('apply_session_numbers', { renames: list },
        { label: 'Numbering earlier sessions' });
      if (r.errors.length) toast(r.errors.join(' '), 'warn');
      else toast(`Renamed ${r.renamed.length} folder${r.renamed.length === 1 ? '' : 's'}.`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    await refreshSessionNumbering();
  });

  $('btnFolderNamesReset')?.addEventListener('click', () => {
    keepAllCleanup();
    state.renameBase = null;
    state.jobNameOverride = null;
  state.clipNames = {}; state.clipTitle = ''; state.namingPreview = null;
    state.plan = null; state.namingPreview = null;
    render();
  });

  const bySrc = (attr) => (b) => state.sources.find((x) => x.path === b.dataset[attr]);
  document.querySelectorAll('[data-scan]').forEach((b) => b.addEventListener('click', () =>
    scanSource(bySrc('scan')(b), true)));
  document.querySelectorAll('[data-deepscan]').forEach((b) => b.addEventListener('click', () =>
    scanSource(bySrc('deepscan')(b), true, true)));
  document.querySelectorAll('[data-addfiles]').forEach((b) => b.addEventListener('click', () =>
    addFootage('files', bySrc('addfiles')(b))));
  document.querySelectorAll('[data-addfolder]').forEach((b) => b.addEventListener('click', () =>
    addFootage('folder', bySrc('addfolder')(b))));
  wireDayButtons();
  $('btnAddFiles')?.addEventListener('click', () => addFootage('files'));
  $('btnAddFolder2')?.addEventListener('click', () => addFootage('folder'));

  document.querySelectorAll('[data-master]').forEach((box) => box.addEventListener('change', () => {
    const from = box.dataset.msrc || primarySource().path;
    const path = box.dataset.master;
    // Each drive keeps its own masters — ticking one never touches the other.
    const current = state.masters[from];
    const picks = new Set(Array.isArray(current) ? current : (current ? [current] : []));
    if (box.checked) picks.add(path); else { picks.delete(path); delete state.ceremonyNames[path]; }
    state.masters[from] = [...picks];
    delete state.assign[path];     // promoted to master, no longer a cam clip
    if (!state.masterSource || !(state.masters[state.masterSource] || []).length) {
      state.masterSource = from;   // cams are assigned against a drive that has a master
    }
    state.plan = null; state.namingPreview = null;
    ensureDefaultAssignments();
    render();
  }));
  document.querySelectorAll('[data-ceremony]').forEach((box) => box.addEventListener('change', () => {
    const kind = box.dataset.ceremony;          // 'Entry' | 'Exit'
    const path = box.dataset.cpath;
    const from = box.dataset.csrc;
    const tag = ceremonyTag(kind);
    // Ticking includes the short clip as a master (so it files at the session
    // root and counts toward Dur-) and swaps its topic for the tag; unticking
    // undoes both. The tag is recorded per path, so the two labels stay
    // mutually exclusive when a drive has only one short clip.
    const current = state.masters[from];
    const picks = new Set(Array.isArray(current) ? current : (current ? [current] : []));
    if (box.checked) {
      picks.add(path);
      delete state.assign[path];      // promoted to master, no longer a cam clip
      state.ceremonyNames[path] = tag;
      if (!state.masterSource || !(state.masters[state.masterSource] || []).length) {
        state.masterSource = from;
      }
    } else {
      picks.delete(path);
      if (state.ceremonyNames[path] === tag) delete state.ceremonyNames[path];
    }
    state.masters[from] = [...picks];
    state.plan = null; state.namingPreview = null;
    ensureDefaultAssignments();
    render();
  }));
  document.querySelectorAll('[data-allmasters]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    state.showAllMasters = !state.showAllMasters;
    render();
  }));

  ['fJob', 'fTitle', 'fDate'].forEach((id) => $(id)?.addEventListener('input', (e) => {
    state.session[{ fJob: 'jobNumber', fTitle: 'title', fDate: 'date' }[id]] = e.target.value;
    const box = document.querySelector('.preview-name');
    if (box) box.innerHTML = sessionPreview();
  }));

  if ($('fVerify')) {
    $('fVerify').value = state.session.verify || 'size';
    $('fVerify').addEventListener('change', (e) => {
      state.session.verify = e.target.value; state.plan = null; state.namingPreview = null;
    });
  }
}

/**
 * Pull clips straight off mounted camera cards.
 *
 * Canon XF cards mount as CanonA_0006 / CanonB_0021 and keep their clips at
 * XFVC/REEL_<n>, where the number differs per card. The letter identifies the
 * body, so CanonA lands in Cam-01, CanonB in Cam-02, and so on — already
 * assigned, and still changeable per clip.
 */
async function importCameraCards() {
  const src = primarySource();
  if (!src) return;
  try {
    const r = await call('find_camera_cards', {}, { label: 'Looking for camera cards' });

    // Card discovery is a snapshot, not an append operation. Remove every clip
    // supplied by the previous snapshot before loading what is mounted now. This
    // prevents an ejected card's paths and assignments from leaking into a plan.
    const previousSelection = state.selection.slice();
    const refreshed = selectionRules.removeCardImports(
      state.extraFiles[src.path] || [], state.assign, state.selection, window.api.platform);
    state.extraFiles[src.path] = refreshed.files;
    state.assign = refreshed.assignments;
    state.selection = refreshed.selection;

    // A card that is no longer mounted must not keep reserving a camera number.
    // Completed cameras remain protected independently by completedCams.
    const cardKey = (card) => selectionRules.cameraGroupKey({
      name: (card.files && card.files[0]) || '',
      path: (card.files && card.files[0]) || '',
      card_volume: card.volume,
      card_label: card.label,
    }, window.api.platform);
    const mountedKeys = new Set((r.cards || []).map(cardKey));
    for (const key of Object.keys(state.cardCams)) {
      if (!mountedKeys.has(key)) delete state.cardCams[key];
    }

    if (!r.card_count) {
      await applyDateSuggestion(src);
      state.plan = null; state.namingPreview = null;
      render();
      return toast(`No camera cards found.${refreshed.removedCount
        ? ` Removed ${refreshed.removedCount} clip${refreshed.removedCount === 1 ? '' : 's'}`
          + ' from cards that are no longer connected.' : ''}`, 'err');
    }

    // Each distinct card is a distinct camera. Compare every card's name against
    // the ones already inserted: a name seen before keeps its cam; a new name is
    // assigned the next free cam number (Cam-02, Cam-03, …).
    // A new card takes the next free cam number — skipping both cards already
    // inserted this session AND cams already filled in the folder we're
    // completing, so a swapped card never lands on an already-done camera.
    const nextFreeCam = () => {
      return nextFreeCams(1, Object.values(state.cardCams))[0];
    };
    for (const c of r.cards) {
      const key = cardKey(c);
      if (state.cardCams[key] == null) state.cardCams[key] = nextFreeCam();
    }
    const camByPath = new Map();
    const paths = [];
    for (const c of r.cards) {
      const cam = state.cardCams[cardKey(c)];
      for (const f of c.files) { paths.push(f); camByPath.set(pathKey(f), cam); }
    }
    if (!paths.length) {
      await applyDateSuggestion(src);
      state.plan = null; state.namingPreview = null;
      render();
      return toast(`No clips on the ${r.card_count === 1 ? 'connected card'
        : `${r.card_count} connected cards`}.`, 'err');
    }

    const probed = await call('add_files', { paths, session_date: sessionDate() },
      { label: 'Reading card clips' });
    warnIfUnprobed(probed);

    const currentKeys = new Set(probed.files.map((f) => pathKey(f.path)));
    state.selection = [...new Set([...state.selection, ...previousSelection.filter((p) => currentKeys.has(pathKey(p)))])];
    const kept = state.extraFiles[src.path] || [];
    const seen = new Set(kept.map((file) => pathKey(file.path)));
    state.extraFiles[src.path] = kept.concat(
      probed.files.filter((file) => !seen.has(pathKey(file.path))).map((file) => {
        const card = r.cards.find((candidate) => candidate.files.some(
          (path) => pathKey(path) === pathKey(file.path)));
        return { ...file, manual: true, origin: 'camera-card',
                 card_label: card ? card.label : '', card_volume: card ? card.volume : '' };
      }));

    await applyDateSuggestion(src);
    // Set the cams after the suggestion runs, so the card's letter wins.
    for (const f of probed.files) {
      const cam = camByPath.get(pathKey(f.path));
      if (cam) state.assign[f.path] = cam;
    }
    // Name a card's cam folder by what it holds — an audio recorder becomes
    // "(Audio)", a DJI card "(Drone)" / "(MM Drone)".
    for (const c of r.cards) {
      const cam = state.cardCams[cardKey(c)];
      if (!cam) continue;
      const kinds = new Set((c.files || []).map(
        (p) => clipKind({ path: p, name: String(p).split(/[\\/]/).pop() })));
      if (kinds.size === 1) applyKindCamName(cam, [...kinds][0]);
    }
    state.camCount = Math.max(state.camCount, ...Object.values(state.cardCams));
    state.plan = null; state.namingPreview = null;

    toast(`Refreshed ${probed.count} clip(s) from ${r.card_count} mounted card(s) — `
      + r.cards.map((c) => `${c.label} (${c.volume}) → ${camLabel(state.cardCams[cardKey(c)])}`)
          .join(', '), 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/** Add footage the operator picked by hand, for when the structure carries none. */
async function addFootage(kind, target = null) {
  const src = target || primarySource();
  if (!src) return;
  const paths = kind === 'folder'
    ? [await window.api.pickFolder('Choose a folder of footage')].filter(Boolean)
    : await window.api.pickVideoFiles();
  if (!paths || !paths.length) return;
  try {
    const r = await call('add_files', { paths, session_date: sessionDate() },
      { label: 'Reading footage' });
    warnIfUnprobed(r);
    if (!r.count) {
      toast(r.rejected_count
        ? `Skipped ${r.rejected_count} file${r.rejected_count === 1 ? '' : 's'} in a trash folder.`
        : 'No video files found there.', 'err');
      return render();
    }
    const existing = state.extraFiles[src.path] || [];
    const seen = new Set(existing.map((f) => f.path));
    const added = r.files.filter((f) => !seen.has(f.path))
      .map((f) => ({ ...f, manual: true }));
    state.extraFiles[src.path] = existing.concat(added);

    await applyDateSuggestion(src);
    pruneAssignments();
    ensureDefaultAssignments();

    toast(added.length
      ? `Added ${added.length} clip(s) from ${src.label} — selected and ready to assign.${
          r.rejected_count ? ` Skipped ${r.rejected_count} in a trash folder.` : ''}`
      : `Already loaded: ${r.count} clip${r.count === 1 ? '' : 's'} from ${src.label}.`,
      added.length ? 'ok' : 'warn');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/**
 * Re-run the last-modified breakdown over everything loaded, and adopt the
 * suggestion when the folder's stated date matches a day on the drive.
 *
 * A drive routinely holds more than one shoot, so this is what separates this
 * session's files from the rest without the operator sifting through them.
 */
async function applyDateSuggestion(_src) {
  // The breakdown spans every footage drive, so loading one drive does not
  // discard what another already contributed.
  const sources = isInformal() ? [primarySource()].filter(Boolean) : footageSources();
  const all = sources.flatMap((f) => allFiles(f));
  if (!all.length) { state.byDate = null; return; }
  try {
    state.byDate = await call('group_dates',
      { files: all, session_date: sessionDate() });
    if (state.byDate.matched_session_date && state.activeDay === null) {
      state.activeDay = state.byDate.suggested_date;
    }
    suggestMasters();
    state.plan = null; state.namingPreview = null;
  } catch (e) { toast(e.message, 'err'); }
}

/** The suggestion banner, shown wherever footage is listed. */
function dateSuggestion() {
  const g = state.byDate;
  if (!g || !g.dates.length) return '';
  const active = state.activeDay;
  const suggested = g.dates.find((d) => d.date === g.suggested_date);

  const buttons = `
    <div class="row" style="margin-top:8px">
      ${g.dates.map((d) => `<button class="sm ${active === d.date ? 'primary' : ''}"
        data-day="${esc(d.date)}">${esc(fmtDay(d.date))} · ${d.count}${
          d.is_session_date ? ' ★' : ''}</button>`).join('')}
      <button class="sm ${active ? '' : 'primary'}" data-day="">Select all · ${
        g.dates.reduce((n, d) => n + d.count, 0)}</button>
    </div>`;

  if (g.date_mismatch) {
    return `
      <div class="note warn">
        <b>No files are dated ${esc(fmtDay(g.session_date))}</b>, the folder's date.
        All files are selected; pick a day below to narrow them.${buttons}
      </div>`;
  }
  if (!suggested || g.dates.length < 2) return '';

  return `
    <div class="note ${g.matched_session_date ? 'ok' : 'warn'}">
      <b>${suggested.count} clip${suggested.count === 1 ? '' : 's'} from
      ${esc(fmtDay(g.suggested_date))}</b> ${suggested.count === 1 ? 'is' : 'are'} selected;
      the other ${g.other_count} ${g.other_count === 1 ? 'is' : 'are'} set to Skip.
      Click a day to switch.${buttons}
    </div>`;
}

function fmtDay(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${M[m - 1]} ${y}`;
}

function wireDayButtons() {
  document.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
    selectDay(b.dataset.day || null);
    render();
  }));
}

/** Read the session folder off a source and seed the cam assignment from it. */
async function detectStructure(src, force = false, overrideRoot = null) {
  if (!src || (state.detected[src.path] && !force)) return;
  try {
    const d = await call('detect_structure', { root: overrideRoot || src.path },
      { label: `Reading ${src.label}` });
    state.detected[src.path] = d;
    if (!isInformal() && d.suggested_master && !state.masters[src.path]) {
      state.masters[src.path] = [d.suggested_master.path];
      state.masterSource = state.masterSource || src.path;
    }
    if (!state.template) {
      // A rename is tied to the specific folder it was typed for; a different
      // folder starts from its own name.
      state.renameBase = null;
      state.nameCleanup = null;
      if (d.session_path) adoptFolderName(stripClipsToken(d.base_name || d.session_name || ''));
      state.camNames = {};
      // Existing cam clips stay on disk and are used only to find the next free
      // camera number. They must never be re-added to the copy plan.
      state.assign = {};
    }
    state.camCount = selectionRules.cameraCountAfterDetection(
      state.template, state.camCount, d);
    state.plan = null; state.namingPreview = null;
    if (!d.session_path) toast(d.reason, 'err');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/* ------------------------------------------------------------ step: cameras */

function masterInfo() {
  return chosenMaster();
}

function renderCameras() {
  const src = primarySource();
  if (!src) return `<div class="empty"><div class="big">📁</div>Add a source first.</div>`;

  const pool = filePool(src);
  const scan = state.scans[src.path] || (pool.length ? { files: pool, suggestion: null } : null);
  // Clips-only skips the drive scan (that scan only exists to find a master, and
  // there is none here): the late clips are added directly with Add files/folder.
  if (!scan && !isInformal() && !state.clipsOnly) {
    return `<div class="card">
      <h3>Read the footage</h3>
      <p class="hint">Every video on <span class="mono">${esc(src.label)}</span> is probed for
      duration, codec and last-modified time. Large cards take a moment.</p>
      <button class="primary" id="btnScan">Scan ${esc(src.label)}</button>
    </div>`;
  }

  const cams = Array.from({ length: state.camCount }, (_, i) => i + 1);
  const masters = chosenMasters();
  const isMaster = masterPaths();
  // Cam clips are the ones brought in by hand — Import camera cards, Add files,
  // Add a folder. The drive scan is only for finding the master, so scanned
  // clips never appear here; that keeps stray root files out of the cam list.
  const files = cameraFiles(src);
  const identityOptions = new Map();
  for (const file of files) {
    const key = selectionRules.cameraGroupKey(file, window.api.platform);
    if (identityOptions.has(key)) continue;
    // Cameras are grouped by their source card/drive, so label the option by
    // that source rather than any one clip's (unreliable) filename prefix.
    const rootMatch = /^[a-z]:[\\/]/i.exec(file.path || '');
    const source = file.card_volume || (rootMatch ? rootMatch[0] : '');
    identityOptions.set(key, file.card_label
      ? `${file.card_label}${source ? ` · ${source}` : ''}`
      : (source || key.replace(/^[^:]+:/, '')));
  }
  if (state.cameraFilterIdentity !== 'all'
      && !identityOptions.has(state.cameraFilterIdentity)) {
    state.cameraFilterIdentity = 'all';
  }
  const shownFiles = selectionRules.filterCameraFiles(files, state.assign, {
    query: state.cameraFilterQuery,
    cam: state.cameraFilterCam,
    identity: state.cameraFilterIdentity,
    sort: state.cameraSort,
  }, window.api.platform);
  const counts = {};
  cams.forEach((n) => { counts[n] = 0; });
  let skipped = 0;
  for (const f of files) {
    const a = state.assign[f.path];
    if (a === undefined || a === 'skip') skipped++;
    else counts[a] = (counts[a] || 0) + 1;
  }

  // The badge is only worth showing when the list actually mixes days.
  const mixedDates = new Set(files.map((f) => f.shoot_date)).size > 1;
  const noClips = files.length === 0;

  // Drop selections for clips no longer in the list, so the batch bar's count
  // never counts ghosts.
  const visible = new Set(files.map((f) => f.path));
  state.selection = state.selection.filter((p) => visible.has(p));
  const picked = new Set(state.selection);

  const rows = shownFiles.map((f) => {
    const a = state.assign[f.path] ?? 'skip';
    return `<tr class="${picked.has(f.path) ? 'sel' : ''}" data-path="${esc(f.path)}">
      <td style="width:1%"><input type="checkbox" class="rowsel" data-path="${esc(f.path)}"
          ${picked.has(f.path) ? 'checked' : ''} style="width:auto"
          title="Include this clip in the backup. Shift-click for a range." /></td>
      <td><div style="font-weight:600">${esc(f.name)}</div>
          <div class="hint" style="margin:0">${esc(f.width || '?')}×${esc(f.height || '?')}
          @ ${esc(f.fps ?? '?')} · <span class="badge ${f.family}">${esc(f.video_codec || '?')}</span></div></td>
      <td class="num">${esc(fmtClock(f.duration))}</td>
      <td>${esc(fmtTime(f.shoot_iso))}
        ${mixedDates && sessionDate() && f.shoot_date === sessionDate()
          ? '<span class="badge ok">session date</span>' : ''}
        ${mixedDates && sessionDate() && f.shoot_date !== sessionDate()
          ? '<span class="badge warn">other day</span>' : ''}</td>
      <td class="num">${fmtBytes(f.size)}</td>
      <td><div class="seg">
        ${isInformal() ? `<button class="${a === ROOT_CAM ? 'on' : ''}" data-assign="${ROOT_CAM}"
           data-file="${esc(f.path)}" title="File into the session root — no camera folder">Root</button>` : ''}
        ${cams.map((n) => `<button class="${a === n ? 'on' : ''}" data-assign="${n}"
           data-file="${esc(f.path)}">${n}</button>`).join('')}
        <button class="${a === 'skip' ? 'on skip' : ''}" data-assign="skip" data-file="${esc(f.path)}">Skip</button>
      </div></td>
    </tr>`;
  }).join('');

  const drives = isInformal() ? [] : footageSources();
  const pairInfo = drives.length > 1
    ? `<div class="note info">These clips are filed to <b>all ${drives.length} drives</b>
         (${drives.map((d) => esc(d.label)).join(', ')}) — the SSDs are kept as identical
         backups. Each drive keeps its own master (${drives.map((d) => esc(d.role)).join(' / ')}).</div>`
    : '';

  return `
  <div class="card">
    <h3>Assign clips to cameras</h3>
    <p class="hint">With nothing checked, every clip that has a camera (not Skip) is copied.
      Check clips to limit the backup to just those; Skipped clips are never copied.
      Existing cam folders are counted for the next suggestion, but their
      filed clips are never selected again.${isInformal()
        ? ' The Copy page previews the new modified-time sequence names before anything moves.' : ''}</p>
    ${masters.length ? `<div class="note info">
      Master${masters.length > 1 ? 's' : ''}:
      ${masters.map((m) => `<b>${esc(m.name)}</b> (${esc(fmtDurAuto(m.duration))})`).join(', ')}
      — ${masters.length > 1 ? 'stay' : 'stays'} at the top of the session folder and
      ${masters.length > 1 ? 'total' : 'sets'} the folder's Dur-
      <b>${esc(fmtDurAuto(masterTotalSeconds()))}</b>. Change on the Folder step.</div>` : ''}
    <div class="row" style="margin-bottom:12px">
      <button class="sm primary" id="btnCards">${state.mastersFiled
        ? 'Add another camera (import card)' : 'Import camera cards'}</button>
      <button class="sm" id="btnAddFiles">Add files…</button>
      <button class="sm" id="btnAddFolder2">Add a folder…</button>
      <button class="sm" id="btnAutoGroup">Auto-suggest by camera</button>
      <button class="sm" id="btnAddCam">Add ${esc(camLabel(state.camCount + 1))}</button>
      <button class="sm" id="btnRemoveCam" ${state.camCount <= 1 ? 'disabled' : ''}>Remove ${esc(camLabel(state.camCount))}</button>
      <button class="sm" id="btnClearAssign">Clear all</button>
      <div class="spacer"></div>
      <button class="sm ghost" id="btnRescanFiles">${isInformal() ? 'Re-scan cards' : 'Re-scan'}</button>
    </div>
    <div class="row" style="margin-bottom:6px">
      ${isInformal() ? `<span class="badge" title="Clips filed straight into the session folder, no camera subfolder">Root : ${counts[ROOT_CAM] || 0}</span>` : ''}
      ${cams.map((n) => `<span class="badge" style="gap:4px">
        <input type="text" data-camname="${n}" value="${esc(camLabel(n))}"
          title="Rename this camera's folder"
          style="width:${Math.max(64, camLabel(n).length * 8)}px;background:transparent;
          border:none;border-bottom:1px dashed var(--line);color:inherit;padding:0 2px;font:inherit" />
        : ${counts[n] || 0}${state.existingCamCounts[n]
          ? ` <span class="hint" style="margin:0;opacity:.8" title="Clips already filed in this camera folder on disk">· ${state.existingCamCounts[n]} on disk</span>`
          : ''}</span>`).join('')}
      <span class="badge">Skipped: ${skipped}</span>
    </div>
    ${pairInfo}
    ${noClips ? `<div class="empty"><div class="big">🎥</div>
      <div>No cam clips yet.</div>
      <div style="margin-top:4px">Press <b>Import camera cards</b>, or add clips with
        <b>Add files…</b> / <b>Add a folder…</b>.${isInformal()
          ? ' Re-scan cards refreshes what is currently mounted and removes stale card entries.'
          : ' The drive scan is only used to find the master, so it does not fill this list.'}</div></div>` : ''}
    ${noClips ? '' : `<div class="row" style="margin:10px 0 8px;align-items:flex-end">
      <label class="field" style="flex:1;min-width:220px;margin:0"><span>Filter files</span>
        <input id="fCameraFilter" type="search" value="${esc(state.cameraFilterQuery)}"
          placeholder="Filename, A_0003, card or drive…" /></label>
      <label class="field" style="width:170px;margin:0"><span>Assignment</span>
        <select id="fCameraFilterCam">
          <option value="all">All cameras</option>
          ${isInformal() ? `<option value="${ROOT_CAM}" ${state.cameraFilterCam === String(ROOT_CAM) ? 'selected' : ''}>Root</option>` : ''}
          ${cams.map((n) => `<option value="${n}" ${state.cameraFilterCam === String(n) ? 'selected' : ''}>${esc(camLabel(n))}</option>`).join('')}
          <option value="skip" ${state.cameraFilterCam === 'skip' ? 'selected' : ''}>Skipped</option>
        </select></label>
      <label class="field" style="width:210px;margin:0"><span>Source / camera</span>
        <select id="fCameraFilterIdentity">
          <option value="all">All sources</option>
          ${[...identityOptions.entries()].map(([key, label]) => `<option value="${esc(key)}"
            ${state.cameraFilterIdentity === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select></label>
      <label class="field" style="width:180px;margin:0"><span>Sort</span>
        <select id="fCameraSort">
          <option value="camera-time" ${state.cameraSort === 'camera-time' ? 'selected' : ''}>Camera, then time</option>
          <option value="time" ${state.cameraSort === 'time' ? 'selected' : ''}>Time, oldest first</option>
          <option value="name" ${state.cameraSort === 'name' ? 'selected' : ''}>Filename A–Z</option>
          <option value="size" ${state.cameraSort === 'size' ? 'selected' : ''}>Largest first</option>
        </select></label>
      <span class="badge">${shownFiles.length} of ${files.length} shown</span>
      <button class="sm ghost" id="btnClearFilters" ${
        state.cameraFilterQuery || state.cameraFilterCam !== 'all'
          || state.cameraFilterIdentity !== 'all' ? '' : 'disabled'}>Clear filters</button>
    </div>
    <div class="row" id="batchBar" style="margin-bottom:8px;align-items:center">
      <label class="badge" style="gap:6px"><input type="checkbox" id="selAll" style="width:auto"
        ${shownFiles.length && shownFiles.every((f) => picked.has(f.path)) ? 'checked' : ''} />
        Include all shown</label>
      ${state.selection.length ? `<b>${state.selection.length} selected</b>
        <span class="hint" style="margin:0">→ assign to</span>
        ${isInformal() ? `<button class="sm" data-batch="${ROOT_CAM}">Root</button>` : ''}
        ${cams.map((n) => `<button class="sm" data-batch="${n}">${esc(camLabel(n))}</button>`).join('')}
        <button class="sm" data-batch="skip">Skip</button>
        <button class="sm ghost" id="btnClearSel">Clear selection</button>`
        : '<span class="hint" style="margin:0">Nothing ticked means every shown clip is copied to its camera. Tick clips to back up only those.</span>'}
    </div>`}
    ${!noClips && !shownFiles.length ? '<div class="empty"><div>No files match these filters.</div></div>' : ''}
    <div class="scroll" ${noClips || !shownFiles.length ? 'style="display:none"' : ''}><table>
      <thead><tr><th style="width:1%"></th><th>File</th><th class="num">Length</th>
        <th>Last modified</th>
        <th class="num">Size</th><th style="width:1%">Goes to</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function wireCameras() {
  $('btnScan')?.addEventListener('click', () => scanSource(primarySource()));
  $('btnRescanFiles')?.addEventListener('click', () => {
    if (isInformal()) importCameraCards();
    else scanSource(primarySource(), true);
  });
  $('btnAddFiles')?.addEventListener('click', () => addFootage('files'));
  $('btnAddFolder2')?.addEventListener('click', () => addFootage('folder'));
  $('btnCards')?.addEventListener('click', importCameraCards);
  wireDayButtons();

  const resetCameraListScroll = () => {
    const list = document.querySelector('.scroll');
    if (list) list.scrollTop = 0;
  };
  $('fCameraFilter')?.addEventListener('input', (event) => {
    state.cameraFilterQuery = event.target.value;
    resetCameraListScroll();
    render();
    const field = $('fCameraFilter');
    if (field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  });
  $('fCameraFilterCam')?.addEventListener('change', (event) => {
    state.cameraFilterCam = event.target.value;
    resetCameraListScroll();
    render();
  });
  $('fCameraFilterIdentity')?.addEventListener('change', (event) => {
    state.cameraFilterIdentity = event.target.value;
    resetCameraListScroll();
    render();
  });
  $('fCameraSort')?.addEventListener('change', (event) => {
    state.cameraSort = event.target.value;
    resetCameraListScroll();
    render();
  });
  $('btnClearFilters')?.addEventListener('click', () => {
    state.cameraFilterQuery = '';
    state.cameraFilterCam = 'all';
    state.cameraFilterIdentity = 'all';
    resetCameraListScroll();
    render();
  });

  document.querySelectorAll('[data-assign]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.assign;
    state.assign[b.dataset.file] = v === 'skip' ? 'skip' : Number(v);
    reconcileKindCamNames();
    state.plan = null; state.namingPreview = null;
    render();
  }));

  // Batch selection: tick clips (Shift for a range, Ctrl/Cmd to add one), then
  // send the whole selection to one cam at once.
  const rowOrder = () => [...document.querySelectorAll('.rowsel')].map((x) => x.dataset.path);
  document.querySelectorAll('.rowsel').forEach((cb) => cb.addEventListener('click', (e) => {
    const order = rowOrder();
    const path = cb.dataset.path;
    const sel = new Set(state.selection);
    if (e.shiftKey && state.lastPicked && order.includes(state.lastPicked)) {
      const i = order.indexOf(state.lastPicked);
      const j = order.indexOf(path);
      const [lo, hi] = i < j ? [i, j] : [j, i];
      for (let k = lo; k <= hi; k += 1) sel.add(order[k]);
    } else if (sel.has(path)) sel.delete(path);
    else sel.add(path);
    state.lastPicked = path;
    state.selection = [...sel];
    state.plan = null; state.namingPreview = null;
    render();
  }));
  $('selAll')?.addEventListener('click', (e) => {
    const shown = new Set(rowOrder());
    state.selection = e.target.checked ? [...new Set([...state.selection, ...shown])]
      : state.selection.filter((p) => !shown.has(p));
    state.plan = null; state.namingPreview = null;
    state.lastPicked = null;
    render();
  });
  $('btnClearSel')?.addEventListener('click', () => {
    state.selection = []; state.lastPicked = null; state.plan = null; state.namingPreview = null; render();
  });
  document.querySelectorAll('[data-batch]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.batch;
    const val = v === 'skip' ? 'skip' : Number(v);
    for (const p of state.selection) state.assign[p] = val;
    reconcileKindCamNames();
    state.lastPicked = null; state.plan = null; state.namingPreview = null;
    render();
  }));

  document.querySelectorAll('[data-camname]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const n = Number(inp.dataset.camname);
      const v = inp.value.trim();
      if (v && v !== `Cam-${String(n).padStart(2, '0')}`) state.camNames[n] = v;
      else delete state.camNames[n];
      state.plan = null; state.namingPreview = null;
      render();
    });
  });
  $('btnAddCam')?.addEventListener('click', () => { state.camCount++; render(); });
  $('btnRemoveCam')?.addEventListener('click', () => {
    const gone = state.camCount;
    Object.keys(state.assign).forEach((k) => {
      if (state.assign[k] === gone) state.assign[k] = 'skip';
    });
    state.camCount--; render();
  });
  $('btnClearAssign')?.addEventListener('click', () => {
    state.assign = {}; state.plan = null; state.namingPreview = null; render();
  });

  $('btnAutoGroup')?.addEventListener('click', async () => {
    const src = primarySource();
    // Group exactly the clips shown on this page. Whole-drive scan results,
    // existing filed clips and master files are deliberately excluded.
    const clips = cameraFiles(src);
    if (!clips.length) return toast('No clips to group.', 'err');

    try {
      // Ask the planner for the exact destination session paths, but send no new
      // camera clips. Its existing_cams report counts only folders containing
      // footage; an empty Cam-01/Cam-02/Cam-03 therefore remains available.
      const checkSpec = buildSpec();
      checkSpec.targets = checkSpec.targets.map((target) => ({ ...target, cams: {} }));
      const destinationPlan = await call('build_plan', checkSpec,
        { label: 'Checking existing camera folders' });
      const occupied = selectionRules.occupiedCamNumbers(destinationPlan, state.camNames);
      // Surface how many clips already sit in each on-disk cam folder, so the
      // chips below show the existing count beside the newly-assigned one.
      state.existingCamCounts = selectionRules.existingCamCounts(destinationPlan, state.camNames);
      const groups = camGroupsWithKind(clips);
      const previousCount = state.camCount;
      const suggestedCams = nextFreeCams(groups.length, occupied);
      groups.forEach((grp, i) => {
        const cam = suggestedCams[i];
        for (const f of grp.files) state.assign[f.path] = cam;
        applyKindCamName(cam, grp.kind);   // "(Audio)" / "(Drone)" / "(MM Drone)"
      });
      state.camCount = Math.max(state.camCount, ...suggestedCams);
      state.plan = null; state.namingPreview = null;
      const added = suggestedCams.filter((cam) => cam > previousCount);
      const placement = added.length
        ? ` Existing empty folders were exhausted, so ${added.map(camLabel).join(', ')} was added.`
        : ` Lowest empty: ${suggestedCams.map(camLabel).join(', ')}.`;
      toast(groups.length === 1
        ? `All ${clips.length} clip(s) look like one camera — assigned to ${camLabel(suggestedCams[0])}.${placement}`
        : `Grouped ${clips.length} clip(s) into ${groups.length} available cameras by source card/drive.${placement}`);
      render();
    } catch (e) { toast(`Couldn't read the existing camera folders: ${e.message}`, 'err'); }
  });

}

// Entering the Folder step: detect the session structure, then load every
// selected footage drive's root so each drive's master clip is ready to pick
// without the operator pressing Scan on every column. Runs the drives one after
// another so they share the single busy indicator cleanly; scanSource and
// detectStructure both skip anything already loaded, so re-entering the step
// (or having pressed Scan by hand) costs nothing.
async function enterFolderStep() {
  if (!state.template) await detectStructure(primarySource());
  else refreshSessionNumbering();
  if (isInformal()) return;
  for (const src of footageSources()) {
    await scanSource(src);
  }
}

// The engine lists files without length/codec when ffprobe cannot run here
// (e.g. a build made for a newer macOS) and says why, instead of stalling.
function warnIfUnprobed(result) {
  if (result && result.warning) {
    toast(`${result.warning} Clip lengths and codecs are blank. Click Locate ffprobe to fix.`, 'warn');
  }
}

async function scanSource(src, force = false, deep = false) {
  if (!src || (state.scans[src.path] && !force)) return;
  try {
    // The quick Scan reads only the drive root, where the program master lives;
    // Detailed scan walks the whole drive for footage nested in card folders.
    const r = await call('scan',
      { root: src.path, session_date: sessionDate(), max_depth: deep ? 8 : 0 },
      { label: `Reading ${src.label}${deep ? ' — whole drive' : ''}` });
    state.scans[src.path] = r;
    warnIfUnprobed(r);
    if (!r.files.length) toast(`No video files found on ${src.label}.`, 'err');
    else { await applyDateSuggestion(src); pruneAssignments(); ensureDefaultAssignments(); }
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/* --------------------------------------------------------------- step: copy */

function buildSpec() {
  const a = primarySource();
  const targets = [];

  // Only clips currently in play can reach the plan. state.assign is a record of
  // choices, not a source of truth about what exists.
  const camsFor = (mapPath) => selectionRules.camsForAssignments(
    state.assign, selected(a), mapPath, window.api.platform);

  const t = state.template;

  /** A template names the folder and is written to the chosen destination;
   *  otherwise the folder already on the drive is completed in place. */
  const targetFor = (src, cams, masterList) => {
    // A completed or partially completed run can have the master already filed
    // on one destination but not the other. Treat each target independently so
    // resuming never moves that master again or invents a second session folder.
    const role = isInformal() ? 'informal' : src.role;
    const filed = state.filedSessions[filedKeyFor(src.path)];
    const masterAlreadyFiled = Boolean(filed);
    // Once filed, only masters that now sit in that session folder are sent:
    // each maps to itself (skipped) unless its name was edited, in which case it
    // is renamed in place. Originals that have moved away are never looked for.
    const inFiled = (path) => pathKey(parentDir(path)) === pathKey(filed);
    const masters = masterAlreadyFiled ? masterList.filter(inFiled) : masterList;
    // An operator-typed replacement for the session folder's base name, applied
    // when completing a folder already on the drive.
    const rename = state.renameBase ? { session_rename: state.renameBase } : {};
    const base = { role, source_root: src.path, dest_root: destOf(src),
                   masters: isInformal() ? [] : masters, cams, cam_names: state.camNames,
                   clip_names: state.clipNames, ceremony_names: state.ceremonyNames,
                   clip_title: state.clipTitle,
                   allow_no_master: isInformal(), rename_camera_clips: isInformal(),
                   direct_camera_folders: isInformal(),
                   skip_existing_by_size: isInformal() && state.skipExistingBySize,
                   template_dirs: t ? editedTemplateDirs(t) : cameraStructureDirs() };
    // After the first copy, file additional cameras straight into the existing
    // session folder, so nothing about the master or the name is recomputed.
    if (filed) {
      return { ...base, ...rename, session_source: filed };
    }
    if (t) {
      return { ...base, session_name: state.renameBase || t.session_name,
               job_name: state.jobNameOverride != null ? state.jobNameOverride : t.job_name };
    }
    return { ...base, ...rename,
             session_source: (state.detected[src.path] || {}).session_path || null };
  };

  // Both SSDs are backups of each other, so the same cam clips are filed to each
  // — the imported card clips are copied to both drives identically. Only the
  // master differs, because it is that drive's own recording (ProRes vs H.265).
  const chosenPaths = (src) => {
    const raw = state.masters[src.path];
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
  };
  const cams = camsFor((p) => p);
  const footage = footageSources();
  if (isInformal() || !footage.length) {
    // Informal, or a clips-only run with no source drive added: one logical
    // target filing into a single chosen folder ...
    targets.push(targetFor(a, cams, isInformal() ? [] : chosenPaths(a)));
    // ... and the same clips into the session's copy on the other SSD.
    const second = !isInformal() && state.clipsOnly && state.filedSessions.other2;
    if (second) {
      const root = parentDir(second);
      targets.push(targetFor({ path: root, dest: root, label: 'Second copy', kind: 'folder', role: 'other' }, cams, []));
    }
  } else {
    // Every selected footage drive becomes its own copy of the session folder.
    // Drives that happen to share a codec role (both ProRes, both H.265, both
    // Other) are copied to just the same — each keeps whatever master was picked
    // on it, and the review page shows one breakdown per drive.
    for (const src of footage) {
      targets.push(targetFor(src, cams, chosenPaths(src)));
    }
  }

  return {
    title: state.session.title,
    job_number: state.session.jobNumber,
    date: state.session.date || undefined,
    add_date: state.session.addDate !== false,
    mode: 'copy',   // retained for the manifest; the engine relocates or copies automatically
    verify: state.session.verify || 'size',
    backup_type: state.backupType,
    windows_compatible: window.api.platform === 'win32',
    targets,
  };
}

function renderCopy() {
  if (!state.plan) {
    return `<div class="card">
      <h3>Build the plan</h3>
      <p class="hint">Every source file is probed and its destination name worked out.
        Nothing is written to disk at this stage.${isInformal()
          ? ' Every camera clip rename will be shown for approval.' : ''}</p>
      ${!isInformal() && footageSources().length > 1
        ? `<div class="note info">The camera selection will be copied to
        <b>all ${footageSources().length} destination drives</b>. Each drive keeps its own
        selected master.</div>` : ''}
      <button class="primary" id="btnPlan">Build plan</button>
    </div>`;
  }

  const p = state.plan;
  const existingMatches = p.targets.flatMap((target) => target.existing_matches || []);
  const trees = p.targets.map((t) => `
    <div class="card">
      <h3><span class="badge ${t.role}">${esc(t.role)}</span>
        ${t.in_place ? 'Completing the existing folder' : 'Creating a new folder'}</h3>
      <p class="hint">${esc(t.dest_root)} · ${t.items.length} file(s) to file ·
        ${fmtBytes(t.total_bytes)} · ${fmtBytes(t.free_bytes)} free</p>
      ${t.rename_to ? `<div class="note info">
          <div>Folder renamed:</div>
          <div class="mono" style="margin-top:4px;opacity:.7">${esc(t.rename_from)}</div>
          <div class="mono" style="margin-top:2px">↳ ${esc(t.rename_to)}</div>
        </div>`
        : t.in_place ? `<div class="note ok">The folder name is already complete —
            only the clips need filing.</div>` : ''}
      ${t.space_error ? `<div class="note err">${esc(t.space_error)}</div>` : ''}
      ${t.warnings.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}
      <div class="tree">
        ${t.job_folder ? `<div class="dir">📁 ${esc(t.job_folder)}</div>` : ''}
        <div class="dir ${t.job_folder ? 'indent1' : ''}">📁 ${esc(t.session_folder)}
          ${sizeBadge(t.total_bytes, 'total')} ${pathCount(t.session_path)}</div>
        ${isInformal() ? '' : (t.master_present && !t.items.some((i) => i.kind === 'master')
          ? '<div class="ren indent2">🎬 <span style="color:var(--ok)">master already filed, kept</span></div>'
          : masterRows(t))}
        ${isInformal() || !((t.ensure_dirs || []).some((d) => /^clips for insert(\/|$)/i.test(d))
          || t.items.some((i) => i.kind === 'clip')
          || Object.keys(t.existing_cams || {}).length)
          ? '' : '<div class="dir indent2">📁 Clips for Insert</div>'}
        ${camGroups(t)}
        ${t.items.filter((i) => i.kind === 'renumber').map((i) => `<div class="ren indent2">
          <b>${esc(i.original_name)}</b> <span style="color:var(--muted)">· already filed, renamed to
          ${esc(String(i.dst).split(/[\\/]/).pop())} now that more clips are joining it</span></div>`).join('')}
      </div>
    </div>`).join('');

  // Cams are copied to both drives, so the empty set is the same on each.
  const empties = p.targets.length ? emptyCams(p.targets[0]) : [];
  const emptyNotice = empties.length ? `
    <div class="card">
      <div class="note warn">
        <b>${empties.map((n) => esc((p.targets[0].cam_names || {})[n]
          || `Cam-${String(n).padStart(2, '0')}`)).join(', ')}
        ${empties.length > 1 ? 'have' : 'has'} no clips</b> and will be created empty.
        Add clips now, or continue.
      </div>
      <div class="row">
        <button class="sm primary" id="btnNoticeImportCard">📇 Import camera card</button>
        ${empties.map((n) => `<button class="sm" data-addcam="${n}">
          Add files to ${esc((p.targets[0].cam_names || {})[n]
            || `Cam-${String(n).padStart(2, '0')}`)}…</button>`).join('')}
        <div class="spacer"></div>
        <button class="sm ghost" id="btnLeaveEmpty">Leave empty, continue</button>
      </div>
    </div>` : '';

  const status = state.runResult ? renderRunResult() : '';

  return `
    ${p.warnings.length ? `<div class="note warn"><b>${p.warnings.length} warning${
       p.warnings.length === 1 ? '' : 's'}.</b> See each drive below.</div>` : ''}
    <div class="card">
      <div class="row">
        <div>${(() => {
          const per = p.targets.map((t) => t.items.length);
          const allEqual = per.length > 1 && per.every((n) => n === per[0]);
          return allEqual
            ? `<b>${per[0]} clip(s) to each of ${p.targets.length} drive(s)</b> · `
              + `${fmtBytes(p.targets[0].total_bytes)} per drive`
            : `<b>${p.item_count} file(s) to file</b> · ${fmtBytes(p.total_bytes)}`;
        })()} ·
          ${isInformal() ? 'camera clips arranged and renamed' : 'master moved · clips copied'} · verify <b>${esc(p.verify)}</b>
          ${(p.renames || []).length ? `· <b>${p.renames.length} folder rename(s)</b>` : ''}
          <br><span class="hint">Only the clips you assigned on the Cameras page are
            included — anything on Skip is untouched.${isInformal()
              ? ' Same-drive clips are moved into the structure; clips going to another drive are copied.'
              : ' No source files are deleted.'}</span></div>
        <div class="spacer"></div>
        <button class="sm" id="btnCopyImportCard">📇 Import camera card</button>
        <button class="sm" id="btnReplan">Rebuild plan</button>
      </div>
      <div class="hint" style="margin-top:6px">
        Swapped a card? Press <b>Import camera card</b> — a new card is added to the next cam
        folder${state.runResult ? ' and filed straight into the folders already on disk' : ''},
        and the plan updates.</div>
    </div>
    ${isInformal() && existingMatches.length ? `<div class="card">
      <label class="row" style="align-items:flex-start;cursor:pointer">
        <input type="checkbox" id="fSkipExistingBySize" style="width:auto;margin-top:3px"
          ${state.skipExistingBySize ? 'checked' : ''} />
        <span><b>Skip ${existingMatches.length} matching source clip${existingMatches.length === 1 ? '' : 's'} already filed.</b><br>
          <span class="hint">Each match is one-to-one, inside its assigned Cam folder, using the exact byte size.
          ${state.skipExistingBySize
            ? ` Only ${p.item_count} unmatched clip${p.item_count === 1 ? '' : 's'} will be copied.`
            : ' All assigned clips are currently included; check this option to skip the matches.'}</span></span>
      </label>
    </div>` : ''}
    ${status}
    ${emptyNotice}
    ${trees}`;
}

function masterRows(t) {
  const items = t.items.filter((i) => i.kind === 'master');
  if (!items.length) {
    return `<div class="ren indent2">${t.master_present
      ? 'Existing master in destination · kept'
      : 'No master selected for this destination'}</div>`;
  }
  return items.map((i) => `<div class="ren indent2">🎬
    <span style="color:var(--muted)">${esc(i.original_name)} →</span>
    <b>${esc(i.dst.split(/[\\/]/).pop())}</b> ${sizeBadge(i.size)} ${pathCount(i.final_dst || i.dst)}
    <span style="color:var(--muted)">· ${fmtDurAuto(i.duration)}</span></div>`).join('');
}

/** Every cam number the plan defines — from its folder list and its clips. */
function definedCams(t) {
  const nums = new Set();
  for (const d of t.ensure_dirs || []) {
    const m = /Cam-(\d+)/i.exec(d);
    if (m) nums.add(Number(m[1]));
  }
  t.items.filter((i) => i.kind === 'clip').forEach((i) => nums.add(i.cam));
  if (!nums.size) for (let n = 1; n <= state.camCount; n++) nums.add(n);
  return [...nums].sort((a, b) => a - b);
}

/** Cam numbers that will be created with no clips in them. */
function emptyCams(t) {
  // A folder is empty only when it has neither a newly assigned clip nor clips
  // already on disk. The tree directly below uses the same existing_cams data.
  return selectionRules.emptyCamNumbers(definedCams(t), t, state.camNames);
}

function camGroups(t) {
  const byCam = {};
  t.items.filter((i) => i.kind === 'clip').forEach((i) => {
    (byCam[i.cam] = byCam[i.cam] || []).push(i);
  });
  const names = t.cam_names || {};
  // Root clips (informal cam 0) sit in the session folder itself, not a "Cam-00".
  const ROOT_KEY = '<root>';
  const fname = (n) => (Number(n) === ROOT_CAM ? ROOT_KEY
    : names[n] || names[String(n)] || `Cam-${String(n).padStart(2, '0')}`);
  const existing = t.existing_cams || {};      // folder name -> clips already on disk
  const folderIndent = t.direct_camera_folders ? 'indent2' : 'indent3';
  const filePadding = t.direct_camera_folders ? 48 : 72;

  // Cam folders to show: those with new clips, those defined, and those already
  // on disk from an earlier pass — so a filed Cam-01 never looks like it vanished.
  const shown = new Map();                     // display name -> { newItems, existing }
  for (const cam of definedCams(t)) shown.set(fname(cam), { newItems: byCam[cam] || [], existing: 0 });
  for (const [folder, n] of Object.entries(existing)) {
    const cur = shown.get(folder) || { newItems: [], existing: 0 };
    cur.existing = n;
    shown.set(folder, cur);
  }

  const order = (a, b) => (a[0] === ROOT_KEY ? -1 : b[0] === ROOT_KEY ? 1 : a[0].localeCompare(b[0]));
  return [...shown.entries()].sort(order).map(([folder, info]) => {
    const already = info.existing
      ? ` <span style="color:var(--ok)">· ${info.existing} already filed, kept</span>` : '';
    const emptyTag = (!info.newItems.length && !info.existing)
      ? ' <span style="color:var(--warn)">· empty</span>' : '';
    const folderBytes = info.newItems.reduce((sum, i) => sum + (i.size || 0), 0);
    const label = folder === ROOT_KEY ? '📄 In the session folder (no camera folder)' : `📁 ${esc(folder)}`;
    const head = `<div class="dir ${folderIndent}">${label}${already}${
      info.newItems.length ? ` <span style="color:var(--accent)">· +${info.newItems.length} new</span> ${
        sizeBadge(folderBytes, 'total')}` : ''}${emptyTag}</div>`;
    return head + info.newItems.map((i) => `<div class="ren ${folderIndent}" style="padding-left:${filePadding}px">
      <b>${esc(i.original_name)}</b> ${sizeBadge(i.size)} ${pathCount(i.final_dst || i.dst)}
      <span style="color:var(--muted)">· ${fmtDur(i.duration)}${
        i.original_name !== i.dst.split(/[\\/]/).pop()
          ? ` · renamed to ${esc(i.dst.split(/[\\/]/).pop())}${
            ''}` : ''}</span>
      </div>`).join('');
  }).join('');
}

function renderRunResult() {
  const r = state.runResult;
  const kind = r.failed ? 'err' : r.cancelled ? 'warn' : 'ok';
  return `<div class="card">
    <div class="note ${kind}">
      <b>${r.cancelled ? 'Cancelled.' : r.failed ? 'Finished with errors.' : 'Done.'}</b>
      ${r.copied} filed, ${r.skipped} already present, ${r.failed} failed ·
      ${fmtBytes(r.bytes)} in ${r.seconds}s${
        r.copied_bytes && r.copy_seconds > 0
          ? ` · copied ${fmtBytes(r.copied_bytes)} at ${fmtBytes(r.rate_bps)}/s`
          + (isInformal()
            ? ` (same-drive relocations are instant and not counted)`
            : ` (masters relocated instantly, not counted)`)
          : ''}
    </div>
    ${r.cancelled || r.failed ? `<div class="note info">
      The approved plan is retained. Files already completed are kept, and <b>Start copy</b>
      safely resumes only the remaining work before you swap another card.</div>` : ''}
    ${(r.renames || []).map((rn) => `<div class="note ${rn.done ? 'ok' : 'warn'}">
      ${rn.done ? `Folder renamed to <span class="mono">${esc(rn.to)}</span>`
                : `Folder not renamed: ${esc(rn.message)}`}</div>`).join('')}
    ${r.errors.map((e) => `<div class="note err mono">${esc(e)}</div>`).join('')}
    <div class="row">
      <button class="primary" id="btnOpenAll">📂 Open ${isInformal() ? 'session folder' : 'both Clips for Insert folders'}</button>
      <span class="hint" style="margin:0">${isInformal()
        ? `the session folder containing the Cam folders${cardFolders().length
            ? ` + ${cardFolders().length} camera card${cardFolders().length > 1 ? 's' : ''}` : ''}`
        : `one window with each drive's Clips for Insert folder as a tab${cardFolders().length
            ? `, and a second window with ${cardFolders().length} camera card${
                cardFolders().length > 1 ? 's' : ''} as tabs` : ''}`}</span>
      ${cardFolders().length ? `<button class="sm" id="btnOpenCards">📇 Open copied cards only</button>` : ''}
    </div>
    <div class="row" style="margin-top:8px">
      ${(r.manifests || []).map((m) => `<button class="sm" data-open="${esc(m.json)}">
        Open manifest (${m.file_count} files)</button>`).join('')}
      ${state.plan.targets.map((t) => `<button class="sm" data-reveal="${esc(t.session_path)}">
        Reveal ${esc(t.role)} folder</button>`).join('')}
      <div class="spacer"></div>
      <button class="sm primary" id="btnGoVerify">${isInformal() ? 'Verify the filed clips' : 'Compare the copies'} →</button>
    </div>
  </div>`;
}

/** The session folder on each destination drive. */
function destFolders() {
  return (state.plan ? state.plan.targets : []).map((t) => t.session_path);
}

/** Join one child folder without assuming Windows or POSIX separators. */
function childFolder(parent, child) {
  const text = String(parent || '').replace(/[\\/]+$/, '');
  return text + (text.includes('\\') ? '\\' : '/') + child;
}

/** The comparison-friendly folder on each SSD, one level below the session. */
function clipsForInsertFolders() {
  return isInformal()
    ? destFolders()
    : destFolders().map((folder) => childFolder(folder, 'Clips for Insert'));
}

/** The volume a path lives on (/Volumes/NAME on macOS, a drive letter on Windows). */
function volumeOf(path) {
  const p = String(path);
  const mac = /^(\/Volumes\/[^/]+)/.exec(p);
  if (mac) return mac[1].toLowerCase();
  const win = /^([A-Za-z]:)[\\/]/.exec(p);
  if (win) return win[1].toLowerCase();
  return ('/' + p.split(/[\\/]/).filter(Boolean)[0] || '').toLowerCase();
}

/**
 * The camera-card folders the clips were copied FROM.
 *
 * A master relocates within its own SSD, so its source volume matches a
 * destination — that is not a card. A card is external footage: a source on a
 * volume that holds no destination. Its clip folder (the REEL) is opened.
 */
function cardFolders() {
  if (!state.plan) return [];
  const destVols = new Set(destFolders().map(volumeOf));
  const dirs = new Set();
  for (const t of state.plan.targets) {
    for (const i of t.items) {
      if (destVols.has(volumeOf(i.src))) continue;   // same drive as a dest → not a card
      const dir = parentDir(i.src);
      if (dir) dirs.add(dir);
    }
  }
  return [...dirs];
}

/** Every folder the "open all" button reveals: destinations first, then cards. */
function finderTargets() {
  return [...new Set([...clipsForInsertFolders(), ...cardFolders()])];
}

/**
 * The same folders split into two groups for the tabbed open: every drive's
 * "Clips for Insert" folder in one window, every camera-card folder in another,
 * so the operator compares destinations against sources side by side. Empty
 * groups are dropped (an informal job has no separate cards window).
 */
function finderGroups() {
  const dests = [...new Set(clipsForInsertFolders())];
  const cards = [...new Set(cardFolders())];
  return [dests, cards].filter((g) => g.length);
}

function wireCopy() {
  $('btnPlan')?.addEventListener('click', doPlan);
  $('btnReplan')?.addEventListener('click', doPlan);
  // Import a swapped-in card from the Copy step, then rebuild the plan so the new
  // clips appear in their cam folders. After a copy this files them straight into
  // the folders already on disk (buildSpec targets the filed session, no master).
  const importThenReplan = async () => {
    if (state.runResult && (state.runResult.failed || state.runResult.cancelled)) {
      toast('Resume the unfinished copy before changing cards.', 'warn');
      return;
    }
    const before = selected(primarySource()).length;
    await importCameraCards();
    if (selected(primarySource()).length > before || state.plan === null) await doPlan();
  };
  $('btnCopyImportCard')?.addEventListener('click', importThenReplan);
  $('btnNoticeImportCard')?.addEventListener('click', importThenReplan);
  document.querySelectorAll('[data-addcam]').forEach((b) => b.addEventListener('click', () =>
    addClipsToCam(Number(b.dataset.addcam))));
  $('btnLeaveEmpty')?.addEventListener('click', () =>
    toast('Empty cam folders will still be created.', 'ok'));
  $('fSkipExistingBySize')?.addEventListener('change', async (event) => {
    state.skipExistingBySize = event.target.checked;
    await doPlan();
  });
  $('btnGoVerify')?.addEventListener('click', () => {
    state.compareRoots = state.plan.targets.map((t) => t.session_path);
    state.pairVerify = null;
    goStep(4);
  });
  $('btnOpenAll')?.addEventListener('click', async () => {
    const res = await window.api.openFolderGroups(finderGroups());
    if (res.missing && res.missing.length) {
      toast(`Opened ${res.opened.length} folder${res.opened.length === 1 ? '' : 's'}. `
        + `${res.missing.length} not found; a card may be ejected.`, 'warn');
    } else {
      toast(`Opened ${res.opened.length} folder(s) — destinations and cards in separate windows.`, 'ok');
    }
  });
  // The destination drives are often already open from the last card, so this
  // opens just the cards that were copied, as tabs in one window.
  $('btnOpenCards')?.addEventListener('click', async () => {
    const res = await window.api.openFolderGroups([[...new Set(cardFolders())]]);
    if (res.missing && res.missing.length) {
      toast(`Opened ${res.opened.length} card${res.opened.length === 1 ? '' : 's'}. `
        + `${res.missing.length} not found; a card may be ejected.`, 'warn');
    } else {
      toast(`Opened ${res.opened.length} copied card${res.opened.length === 1 ? '' : 's'}.`, 'ok');
    }
  });
  document.querySelectorAll('[data-reveal]').forEach((b) =>
    b.addEventListener('click', () => window.api.reveal(b.dataset.reveal)));
  document.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => window.api.open(b.dataset.open)));
}

/** Pick footage for a specific cam from the Copy step, then rebuild the plan. */
async function addClipsToCam(cam) {
  const src = primarySource();
  if (!src) return;
  const paths = await window.api.pickVideoFiles();
  if (!paths || !paths.length) return;
  try {
    const r = await call('add_files', { paths, session_date: sessionDate() },
      { label: `Reading clips for Cam-${String(cam).padStart(2, '0')}` });
    if (!r.count) return toast('No video files found there.', 'err');
    const existing = state.extraFiles[src.path] || [];
    const seen = new Set(existing.map((f) => f.path));
    const added = r.files.filter((f) => !seen.has(f.path)).map((f) => ({ ...f, manual: true }));
    state.extraFiles[src.path] = existing.concat(added);
    // These clips go to the cam the operator picked, on both drives.
    for (const f of added) state.assign[f.path] = cam;
    state.selection = [...new Set([...state.selection, ...added.map((f) => f.path)])];
    state.camCount = Math.max(state.camCount, cam);
    toast(`Added ${added.length} clip(s) to Cam-${String(cam).padStart(2, '0')}.`, 'ok');
    await doPlan();               // rebuild so the review reflects the new clips
  } catch (e) { toast(e.message, 'err'); }
}

async function doPlan() {
  try {
    state.plan = null; state.namingPreview = null;
    state.runResult = null;
    // Both SSDs are filed identically, so there is nothing to match up first.
    const nextPlan = await call('build_plan', buildSpec(), { label: 'Building plan' });
    const unexpected = selectionRules.unexpectedPlanClips(
      nextPlan, state.assign, selected(primarySource()), window.api.platform);
    if (unexpected.length) {
      throw new Error(`Safety check stopped the plan: ${unexpected.length} camera clip(s) `
        + 'did not match the current Cameras-page selection. Refresh the cards and build again.');
    }
    state.plan = nextPlan;
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/**
 * Re-read destination folders after every run, including cancellation.
 *
 * The plan is a pre-copy snapshot. Once even one file lands it is stale, so
 * Back/Next and retry must use what is actually on disk. A destination with a
 * filed master becomes an in-place target on the next plan; populated cameras
 * are reserved immediately for the next card.
 */
async function reconcileRunState(plan, result) {
  const moved = new Map();                 // pathKey(original) -> filed path
  for (const item of result.items || []) {
    const present = item.status === 'done'
      || (item.status === 'skipped' && /already present/i.test(item.message || ''));
    if (present && item.kind === 'clip') state.completedCams.add(Number(item.cam));
    if (present && item.kind === 'master' && item.src && item.dst
        && pathKey(item.src) !== pathKey(item.dst)) {
      moved.set(pathKey(item.src), item.dst);
    }
  }
  // Masters now live in the session folder. Point the selection, and any edited
  // or ceremony names, at the filed files so a later plan can rename them.
  if (moved.size) {
    for (const [src, raw] of Object.entries(state.masters)) {
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      state.masters[src] = list.map((path) => moved.get(pathKey(path)) || path);
    }
    for (const names of [state.clipNames, state.ceremonyNames]) {
      for (const [oldPath, value] of Object.entries(names)) {
        const filedPath = moved.get(pathKey(oldPath));
        if (filedPath) { delete names[oldPath]; names[filedPath] = value; }
      }
    }
  }

  for (const target of plan.targets || []) {
    // Match the rename by source path — two drives can share a codec role, so the
    // role alone no longer identifies a single target.
    const rename = (result.renames || []).find((entry) =>
      (entry.source || entry.role) === (target.source_root || target.role));
    const root = rename && rename.done
      ? target.session_path
      : (target.staging_path || target.session_path);
    if (!root) continue;
    try {
      const detected = await call('detect_structure', { root });
      for (const [cam, paths] of Object.entries(detected.cams || {})) {
        if ((paths || []).length) state.completedCams.add(Number(cam));
      }
      for (const file of detected.master_candidates || []) {
        if (file && file.path) state.filedMasterInfo[pathKey(file.path)] = file;
      }
      if (detected.session_path && (isInformal()
          || (detected.master_candidates || []).length)) {
        state.filedSessions[filedKeyFor(target.source_root)] = detected.session_path;
      }
    } catch {
      // The normal run result still explains any failure. A missing/ejected
      // destination simply cannot contribute fresh resume state.
    }
  }
  const keys = (plan.targets || []).map((target) => filedKeyFor(target.source_root));
  if (keys.length && keys.every((key) => state.filedSessions[key])) {
    state.mastersFiled = true;
  }
}

async function doRun() {
  const p = state.plan;
  const full = p.targets.map((t) => t.space_error).filter(Boolean);
  if (full.length) {
    await window.api.confirm({ message: 'Not enough space to copy', detail: full.join('\n'),
      confirmLabel: 'OK', danger: true });
    return;
  }
  const renames = (p.renames || []).map((r) => `\n  ${r.from}\n    ↳ ${r.to}`).join('');
  const ok = await window.api.confirm({
    message: p.item_count
      ? (isInformal()
          ? `Arrange and rename ${p.item_count} camera clip(s)?`
          : `File ${p.item_count} clip(s) and rename the session folder?`)
      : 'Rename the session folder?',
    detail: (isInformal()
      ? 'There is no master. Clips are placed into their assigned camera folders and renamed '
        + 'in modified-time order. Same-drive files are relocated; files from a card or another drive are copied.\n'
      : 'The master moves into the folder on its own drive. Camera clips are copied to '
        + `${footageSources().length > 1 ? 'every selected drive' : 'the drive'}. `
        + 'Nothing is deleted — clear the cards yourself afterwards.\n') +
      (renames ? `\nFolder rename:${renames}\n` : '') +
      '\nThe folder is renamed only after every file lands successfully.',
    confirmLabel: 'Go ahead',
    danger: false,
  });
  if (!ok) return;
  try {
    state.runResult = null;
    state.runResult = await call('execute_plan', { plan: p, write_manifest: true },
      { label: 'Copying' });
    const r = state.runResult;
    if (!r.failed && !r.cancelled) {
      await reconcileRunState(p, r);
      // The masters are filed and the folders named; remember where, so adding a
      // camera afterwards goes straight into these folders without re-detection.
      state.mastersFiled = true;
      for (const t of p.targets) state.filedSessions[filedKeyFor(t.source_root)] = t.session_path;
      // Started from an event schedule row: read its duration back into the row.
      await scheduleAfterRun(p);
      // Clips that landed are done. Drop them from the pool and the assignment so
      // a later card swap does not try to re-plan them from a now-ejected card.
      const filed = new Set((r.items || [])
        .filter((i) => i.kind === 'clip' && (i.status === 'done' || i.status === 'skipped'))
        .map((i) => i.src));
      for (const target of p.targets || []) {
        for (const match of target.existing_matches || []) filed.add(match.src);
      }
      for (const path of filed) delete state.assign[path];
      for (const key of Object.keys(state.extraFiles)) {
        state.extraFiles[key] = state.extraFiles[key].filter((f) => !filed.has(f.path));
      }
      for (const key of Object.keys(state.scans)) {
        if (state.scans[key] && state.scans[key].files) {
          state.scans[key].files = state.scans[key].files.filter((f) => !filed.has(f.path));
        }
      }
    } else {
      // Retain the exact approved plan. execute_plan is idempotent: a retry skips
      // verified destinations and continues the unfinished items, including any
      // master rename that did not happen before cancellation.
      state.plan = p;
    }
    toast(r.failed ? `${r.failed} file(s) failed.` : `Copied ${r.copied} files.`,
      r.failed ? 'err' : 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/* ------------------------------------------------------------- step: verify */

/**
 * Every copied camera-card clip, paired with the ORIGINAL it was copied from.
 *
 * The card is the reference: each SSD's copy is checked against the card clip it
 * came from, which confirms the copy is faithful — and if both drives match the
 * card, they match each other. Masters relocated in place (no card source) and
 * are not part of this.
 */
function cardCopyChecks() {
  if (!state.plan) return [];
  const out = [];
  for (const t of state.plan.targets) {
    for (const i of t.items) {
      if (i.kind !== 'clip') continue;      // masters have no card source
      out.push({ name: i.original_name, role: t.role,
        source: i.src, copy: i.final_dst || i.dst });
    }
  }
  return out;
}

/** Distinct camera-card folders the clips came from, for the message. */
function sourceCardLabels() {
  const dirs = new Set(cardCopyChecks().map((c) => parentDir(c.source).split(/[\\/]/).pop()));
  return [...dirs].filter(Boolean);
}

function renderVerify() {
  const checks = cardCopyChecks();
  const canVerify = checks.length > 0;
  const roots = state.compareRoots;
  const rows = roots.map((r, i) => `
    <div class="row" style="margin-bottom:8px">
      <span class="badge ${i === 0 ? 'ok' : ''}">${i === 0 ? 'Reference' : `Copy ${i}`}</span>
      <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(r)}</span>
      <button class="sm ghost" data-drop-root="${i}">Remove</button>
    </div>`).join('');

  const drives = [...new Set(checks.map((c) => c.role))];
  const cards = sourceCardLabels();

  return `
  <div class="card">
    <h3>Verify the copied clips against the camera card${cards.length > 1 ? 's' : ''}</h3>
    <p class="hint">${isInformal()
      ? `Checks each filed clip against its original when that original is still available.
         Same-drive clips are relocated, so they can instead be checked with the folder comparison below.`
      : `Checks every clip copied from the camera card${cards.length > 1 ? 's' : ''}
         against the original still on the card — on ${esc(drives.join(' and '))}. If both copies
         match the card, the copy is faithful and the two SSDs are identical. Masters relocated in
         place and are not part of this.`}</p>
    ${canVerify ? `<div class="note info">
        <b>${checks.length} copy check(s)</b> — ${esc(cards.join(', ') || 'card clips')} →
        ${esc(drives.join(' + '))}. The cards must stay connected for this:</div>
      <div class="row">
        <button class="primary" id="btnVerifyPairs">Verify (size, fast)</button>
        <button class="sm" id="btnVerifyPairsHash">Checksum verify (bit-exact)</button>
      </div>`
      : `<div class="note warn">Nothing to check yet. Run the copy first.</div>`}
  </div>
  ${state.pairVerify ? renderPairVerify() : ''}

  <details style="margin-top:6px">
    <summary class="hint" style="cursor:pointer">Compare arbitrary folders instead</summary>
    <div class="card" style="margin-top:8px">
      <p class="hint">Compare any folders by hand — folder tree, names, durations. Sizes and
        codecs legitimately differ between drives, so those are reported as information.</p>
      ${rows || '<div class="hint">Nothing added yet.</div>'}
      <div class="row" style="margin-top:10px">
        <button class="sm" id="btnAddCompare">Add folder…</button>
        <div class="spacer"></div>
        <button class="sm" id="btnCompare" ${roots.length < 2 ? 'disabled' : ''}>Compare (fast)</button>
        <button class="sm" id="btnDeep" ${roots.length < 2 ? 'disabled' : ''}>Checksum verify…</button>
      </div>
    </div>
    ${state.compare ? renderCompareResult() : ''}
    ${state.deep ? renderDeepResult() : ''}
  </details>`;
}

/** Result card for the card→copy verification, with every check listed. */
function renderPairVerify() {
  const v = state.pairVerify;
  const rows = (v.results || []).map((r) => `
    <tr>
      <td>${r.match ? '<span class="badge ok">match</span>'
                    : '<span class="badge err">differs</span>'}</td>
      <td class="mono">${esc(r.name)}</td>
      <td class="num">${r.size_a != null ? fmtBytes(r.size_a) : '—'}</td>
      <td class="num">${r.size_b != null ? fmtBytes(r.size_b) : '—'}</td>
      <td>${esc(r.detail)}</td>
    </tr>`).join('');
  return `<div class="card">
    <div class="note ${v.ok ? 'ok' : 'err'}">
      <b>${v.ok ? 'Every copy matches the camera card.'
                : `${v.mismatched.length} of ${v.checked} ${v.checked === 1 ? 'copy doesn\'t' : 'copies don\'t'} match the card.`}</b>
      Checked by ${esc(v.algorithm)}.
    </div>
    <div class="scroll" style="max-height:420px"><table>
      <thead><tr><th style="width:1%"></th><th>Clip → drive</th>
        <th class="num">Card</th><th class="num">Copy</th><th>Result</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${v.ok ? `<p class="hint" style="margin:10px 0 0">${isInformal()
      ? 'Each checked file is identical to its available original.'
      : 'Each copied clip is identical to its camera-card original, so both SSDs are faithful, matching backups.'}</p>` : ''}
  </div>`;
}

function renderCompareResult() {
  const c = state.compare;
  if (c.error) {
    return `<div class="card"><div class="note err"><b>Comparison failed:</b>
      ${esc(c.error)}</div></div>`;
  }
  return c.pairs.map((p) => {
    const errs = p.mismatched.filter((m) => !m.info_only);
    const infos = p.mismatched.filter((m) => m.info_only);
    return `<div class="card">
      <h3>${esc(p.reference.split(/[\\/]/).pop())} ↔ ${esc(p.other.split(/[\\/]/).pop())}</h3>
      <div class="note ${p.ok ? 'ok' : 'err'}">
        <b>${p.ok ? 'These folders match.' : 'Differences found.'}</b>
        ${p.matched} matched · ${p.missing_from_other.length} missing · ${p.extra_in_other.length} extra
        · ${errs.length} mismatched · folder structure ${p.tree_equal ? 'identical' : 'differs'}
      </div>
      ${p.missing_from_other.length ? `<div class="note err">
        <b>Missing from the second folder:</b><br>
        ${p.missing_from_other.map((f) => esc(f.name)).join('<br>')}</div>` : ''}
      ${p.extra_in_other.length ? `<div class="note warn">
        <b>Only in the second folder:</b><br>
        ${p.extra_in_other.map((f) => esc(f.name)).join('<br>')}</div>` : ''}
      ${errs.length ? `<table><thead><tr><th>File</th><th>Problem</th></tr></thead><tbody>
        ${errs.map((m) => `<tr><td class="mono">${esc(m.a.name)}</td>
          <td>${m.issues.filter((i) => i.severity === 'error')
                 .map((i) => `<b>${esc(i.field)}</b> — ${esc(i.detail)}`).join('<br>')}</td></tr>`).join('')}
      </tbody></table>` : ''}
      ${infos.length ? `<details style="margin-top:8px"><summary class="hint">
        ${infos.length} expected difference(s) between codecs</summary>
        <table><tbody>${infos.map((m) => `<tr><td class="mono">${esc(m.a.name)}</td>
          <td class="hint">${esc(m.issues[0].detail)} — ${fmtBytes(m.issues[0].a)} vs
          ${fmtBytes(m.issues[0].b)}</td></tr>`).join('')}</tbody></table></details>` : ''}
    </div>`;
  }).join('');
}

function renderDeepResult() {
  const d = state.deep;
  return `<div class="card">
    <h3>Checksum verification</h3>
    <div class="note ${d.ok ? 'ok' : 'err'}">
      <b>${d.ok ? 'Every checked file is bit-identical.' : `${d.mismatched.length} file(s) differ.`}</b>
      ${d.checked} files checked with ${esc(d.algorithm)}.
    </div>
    ${d.mismatched.map((m) => `<div class="note err mono">
      ${esc(m.a.split(/[\\/]/).pop())} — ${esc(m.error || 'digests differ')}</div>`).join('')}
  </div>`;
}

function wireVerify() {
  const runPairVerify = async (mode) => {
    const checks = cardCopyChecks();
    if (!checks.length) return;
    try {
      state.pairVerify = await call('verify_pairs',
        { pairs: checks.map((c) => [c.source, c.copy]), mode,
          labels: checks.map((c) => `${c.name} → ${c.role}`) },
        { label: mode === 'hash' ? 'Checksumming against the card' : 'Verifying against the card' });
      toast(state.pairVerify.ok ? 'Every copy matches the camera card.'
        : `${state.pairVerify.mismatched.length} ${state.pairVerify.mismatched.length === 1 ? "copy doesn't" : "copies don't"} match the card.`,
        state.pairVerify.ok ? 'ok' : 'err');
      render();
    } catch (e) { toast(e.message, 'err'); }
  };
  $('btnVerifyPairs')?.addEventListener('click', () => runPairVerify('size'));
  $('btnVerifyPairsHash')?.addEventListener('click', async () => {
    const ok = await window.api.confirm({
      message: `Checksum ${cardCopyChecks().length} copied clip(s) against the card?`,
      detail: 'Each clip is read end to end on the card and on the SSD. Bit-exact, but slower '
            + 'over USB. The camera cards must stay connected.',
      confirmLabel: 'Checksum',
    });
    if (ok) runPairVerify('hash');
  });

  $('btnAddCompare')?.addEventListener('click', async () => {
    const p = await window.api.pickFolder('Choose a session folder to compare');
    if (p && !state.compareRoots.includes(p)) { state.compareRoots.push(p); render(); }
  });
  document.querySelectorAll('[data-drop-root]').forEach((b) => b.addEventListener('click', () => {
    state.compareRoots.splice(Number(b.dataset.dropRoot), 1);
    state.compare = null; state.deep = null; render();
  }));
  $('btnCompare')?.addEventListener('click', async () => {
    try {
      state.deep = null;
      state.compare = await call('compare', { roots: state.compareRoots },
        { label: 'Comparing folders' });
      toast(state.compare.ok ? 'Folders match.' : 'Differences found — see the report.',
        state.compare.ok ? 'ok' : 'err');
      render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('btnDeep')?.addEventListener('click', async () => {
    const ok = await window.api.confirm({
      message: 'Checksum every matching file?',
      detail: isInformal()
        ? 'Both folders are read end to end. Large recordings over USB can take a long time.'
        : 'Both copies are read end to end. On large ProRes files over USB this can take '
            + 'a long time.\n\nOnly files with the same codec on both sides can match — a ProRes '
            + 'file and its H.265 twin are different encodings and will always differ.',
      confirmLabel: 'Verify',
    });
    if (!ok) return;
    try {
      state.deep = await call('deep_verify', { roots: state.compareRoots.slice(0, 2) },
        { label: 'Checksumming' });
      render();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ------------------------------------------------------------------ render */

const RENDERERS = [renderSources, renderSession, renderCameras, renderCopy, renderVerify];
const WIRERS = [wireSources, wireSession, wireCameras, wireCopy, wireVerify];

function goStep(i) {
  if (state.busy) {
    toast('Wait for the current task to finish, or press Cancel.', 'warn');
    return;
  }
  if (!stepReady(i)) return;
  if (state.step === 3 && i < 3 && state.runResult
      && (state.runResult.failed || state.runResult.cancelled)) {
    toast('Resume the unfinished copy first.', 'warn');
    return;
  }
  // A review plan is a snapshot. Once the operator leaves Copy, always rebuild
  // it from the current selections and on-disk state before it can run again.
  if (state.step === 3 && i < 3) {
    state.plan = null; state.namingPreview = null;
    state.runResult = null;
  }
  state.view = 'steps';
  state.step = i;
  render();
  // In template mode the ZIP already supplied the structure. Scanning a footage
  // drive here used to race with it and could replace a three-camera ZIP with
  // Cam-04 (or whatever old structure happened to exist on that drive).
  if (i === 1) enterFolderStep();
  if (i === 2 && !isInformal()) scanSource(primarySource());
  // Entering the Cameras page: adopt the real (suffixed) names of cameras that
  // already exist in the folder being completed — after a copy, or when
  // reopening a folder filed earlier — so a clip assigned to cam 5 goes into
  // "Cam-05 (Drone)" instead of a new bare "Cam-05". Guarded to run once.
  if (i === 2) ensureExistingCamNamesSeeded();
}

/** Open the Event schedule page; the backup steps keep their state underneath. */
function showSchedule() {
  if (state.busy) {
    toast('Wait for the current task to finish, or press Cancel.', 'warn');
    return;
  }
  state.view = 'schedule';
  render();
}

function render() {
  const onSchedule = state.view === 'schedule';
  const onReport = state.view === 'report';
  $('backupMode').textContent = isInformal() ? 'Informal backup' : 'Formal backup';
  const run = state.scheduleRun;
  const steps = `
    <li class="${onSchedule ? 'active' : ''} ${state.busy ? 'disabled' : ''}" data-view="schedule">
      <span class="num">≡</span><span>Event schedule</span></li>
    ${run ? `<li class="step-note mono" title="This backup was started from the event schedule">${esc(typeof syncAccount === 'function' && syncAccount() && !syncAvailable() ? 'Backup in progress' : run.id)}</li>` : ''}`
    + STEPS.map((s, i) => `
    <li class="${!onSchedule && !onReport && i === state.step ? 'active' : ''} ${state.busy || !stepReady(i) ? 'disabled' : ''}
        ${i < state.step && stepReady(i) ? 'done' : ''}" data-step="${i}">
      <span class="num">${i + 1}</span><span>${s.label}</span></li>`).join('')
    + `<li class="${onReport ? 'active' : ''} ${state.busy ? 'disabled' : ''}" data-view="report">
      <span class="num">▤</span><span>Report</span></li>`;
  // The nav and top buttons are rewritten only when they change: a background redraw
  // must not knock the keyboard focus off them.
  if (PAINT.setHtml($('steps'), steps)) {
    document.querySelectorAll('[data-step]').forEach((li) =>
      li.addEventListener('click', () => goStep(Number(li.dataset.step))));
    document.querySelector('[data-view="schedule"]')?.addEventListener('click', showSchedule);
    document.querySelector('[data-view="report"]')?.addEventListener('click', showReport);
  }

  const topActions = `
    ${state.engine.info && !state.engine.info.ffprobe
      ? '<button class="sm" id="btnFindFfprobe">Locate ffprobe</button>' : ''}
    <button class="sm ghost" id="btnRestart">Restart engine</button>
    ${['win32', 'darwin'].includes(window.api.platform) ? `<button class="sm ghost" id="btnDns" title="Sets DNS to 1.1.1.1 and 1.0.0.1 on the active Wi-Fi/Ethernet connection (asks for administrator permission), then restarts AV Backup.">Set Cloudflare DNS &amp; restart (${window.api.platform === 'win32' ? 'Windows' : 'Mac'})</button>` : ''}
    ${typeof showSync === 'function' ? '<button class="sm" id="btnAccount">Account</button>' : ''}`;
  if (PAINT.setHtml($('topActions'), topActions)) {
    $('btnAccount')?.addEventListener('click', () => showSync().catch(() => toast('Save failed; account view could not open.', 'err')));
    $('btnRestart').addEventListener('click', restartEngine);
    $('btnDns')?.addEventListener('click', setCloudflareDns);
    $('btnFindFfprobe')?.addEventListener('click', locateFfprobe);
  }

  if (state.view === 'account') {
    $('stepTitle').textContent = 'Account'; $('stepHint').textContent = 'Team sync settings and review';
    syncPaint(); $('footer').innerHTML = ''; return;
  }
  if (typeof syncAccount === 'function' && syncAccount() && !syncAvailable() && (onSchedule || onReport)) {
    $('content').innerHTML = '<div class="card">Team data is unavailable. Open Account to sign in or check access.</div>';
    $('footer').innerHTML = ''; return;
  }
  if (onSchedule) {
    $('stepTitle').textContent = 'Event schedule';
    $('stepHint').textContent = 'Read the schedule, check every row, then start each session\'s backup from its row.';
    // Keep the table's scroll and the row the keyboard is on (Space re-renders).
    const snap = scheduleSnapshot();
    schedulePaint();
    scheduleRestore(snap);
    renderFooter();
    renderModals();
    return;
  }
  if (onReport) {
    $('stepTitle').textContent = 'Report';
    $('stepHint').textContent = 'Every session on record, plus the rows of the event schedules. Gaps in the numbering show in yellow.';
    const snap = scheduleSnapshot();
    reportPaint();
    scheduleRestore(snap);
    renderFooter();
    renderModals();
    return;
  }

  $('stepTitle').textContent = STEPS[state.step].title;
  $('stepHint').textContent = isInformal()
    ? [
        'Choose Informal, import the structure, and select the output directory.',
        'Edit the job and session folder names. No mixer master is required.',
        'Assign individual recordings to cameras; their new sequence names are previewed next.',
        'Review every destination and renamed clip before starting.',
        'Check the arranged camera folders and files.',
      ][state.step]
    : STEPS[state.step].hint;

  // A full re-render rebuilds the content and would reset any scrolled list to
  // the top — jarring when you assign a clip halfway down the Cameras page. Keep
  // the scroll position of the clip list across the render.
  const priorScroll = document.querySelector('.scroll')?.scrollTop || 0;
  // The naming editor belongs where clip names are actually decided: for formal
  // that is the Folder step (the master takes the session name; camera clips keep
  // their originals), for informal it is the Cameras step (every camera clip is
  // renamed from the event name — the Folder step's own "Edit session folder"
  // already covers the folder name there).
  const namingStep = isInformal() ? state.step === 2 : state.step === 1;
  $('content').innerHTML = RENDERERS[state.step]()
    + (namingStep && primarySource() ? renderNamingEditor() : '');
  WIRERS[state.step]();
  wireNamingEditor();
  const list = document.querySelector('.scroll');
  if (list && priorScroll) list.scrollTop = priorScroll;

  renderFooter();
  renderModals();
}

// One modal host, for the rename tool.
function renderModals() {
  const host = $('modal');
  if (!host) return;
  if (state.rename && state.rename.open) return renderRenameModal();
  if (state.verify && state.verify.open) return renderVerifyModal();
  host.innerHTML = '';
  host.classList.remove('show');
}

function renderFooter() {
  const b = state.busy;
  if (b) {
    $('footer').innerHTML = `
      <div style="flex:1">
        <div class="row"><b>${esc(b.label)}</b>
          <span class="hint" style="margin:0">${esc(b.detail || '')}</span></div>
        <div class="bar"><div style="width:${b.percent != null ? b.percent : 15}%"></div></div>
        <div class="progress-meta"><span>${esc(b.left || '')}</span><span>${esc(b.right || '')}</span></div>
      </div>
      <button class="danger" id="btnCancel">Cancel</button>`;
    $('btnCancel').addEventListener('click', () => {
      window.api.cancel(b.id);
      toast('Cancelling after the current file…');
    });
    return;
  }
  if (state.view === 'schedule') {
    $('footer').innerHTML = scheduleFooterHtml();
    wireScheduleFooter();
    return;
  }
  if (state.view === 'report') {
    $('footer').innerHTML = reportFooterHtml();
    wireReportFooter();
    return;
  }
  const prev = state.step > 0;
  const next = state.step < STEPS.length - 1 && stepReady(state.step + 1);
  $('footer').innerHTML = `
    <button id="btnPrev">${prev ? '← Back' : '← Event schedule'}</button>
    <div class="spacer"></div>
    <span class="hint" style="margin:0">${esc(footerHint())}</span>
    ${state.step === 3 && state.plan ? `<button class="primary" id="btnRun">
      ${state.runResult ? 'Run again' : 'Start copy'}</button>` : ''}
    ${state.step !== 3 || stepReady(4)
      ? `<button class="primary" id="btnNext" ${next ? '' : 'disabled'}>Next →</button>` : ''}`;
  $('btnRun')?.addEventListener('click', doRun);
  $('btnPrev').addEventListener('click', () => (state.step > 0 ? goStep(state.step - 1) : showSchedule()));
  $('btnNext')?.addEventListener('click', () => goStep(state.step + 1));
}

function footerHint() {
  switch (state.step) {
    case 0: return isInformal()
      ? (!state.template ? 'Import the structure ZIP to continue'
        : !state.informalDest ? 'Choose an output directory to continue'
          : 'Structure and output are ready')
      : state.sources.length ? `${state.sources.length} source(s) selected`
                             : 'Add at least one source to continue';
    case 1: return isInformal() ? 'No master required · continue to camera assignment'
      : chosenMasters().length
      ? `Folder Dur- will read ${fmtDurAuto(masterTotalSeconds())}`
        + (chosenMasters().length > 1 ? ` from ${chosenMasters().length} clips` : '')
      : 'Pick the master clip to continue';
    case 2: {
      const n = selected(primarySource()).length;
      return n ? `${n} clip(s) included in backup` : 'No clips to include yet — import or add clips';
    }
    case 3: return state.runResult ? 'Copy finished' : '';
    default: return '';
  }
}

/* ------------------------------------------ rename / clip-count tool (modal) */

// A self-contained utility for footage that is ALREADY filed: pick a folder,
// preview the clip renames and Clips-NN count fixes, then apply. It runs
// outside the five-step backup wizard so it never touches that flow's state.

// The folder a drop carries: a dropped folder itself, or a dropped file's folder.
// Must run inside the drop event, while the browser still exposes the items.
function droppedFolder(event) {
  const dt = event.dataTransfer;
  if (!dt || !dt.files || !dt.files.length) return null;
  const entry = dt.items && dt.items[0] && dt.items[0].webkitGetAsEntry
    ? dt.items[0].webkitGetAsEntry() : null;
  const file = dt.files[0];
  const path = window.api.pathForFile ? window.api.pathForFile(file) : file.path;
  if (!path) return null;
  return entry && !entry.isDirectory ? parentDir(path) : path;
}

// Highlight `el` while a folder is dragged over it, and hand the dropped folder
// to `onFolder`.
function makeFolderDropTarget(el, onFolder) {
  if (!el) return;
  const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  el.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    el.classList.add('dropping');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('dropping');
  });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    el.classList.remove('dropping');
    const folder = droppedFolder(e);
    if (folder) onFolder(folder);
  });
}

async function openRenameTool(folder) {
  const root = folder || await window.api.pickFolder(
    'Choose a drive or folder holding informal sessions to rename');
  if (!root) return;
  state.rename = { open: true, root, plan: null, scanning: false,
                   applying: false, result: null };
  render();
  await previewRename();
}

async function previewRename() {
  const r = state.rename;
  if (!r || !r.root) return;
  r.scanning = true; r.result = null; r.plan = null;
  render();
  try {
    r.plan = await call('plan_rename', { root: r.root });
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    r.scanning = false;
    render();
  }
}

async function chooseRenameFolder() {
  const root = await window.api.pickFolder(
    'Choose a drive or folder holding informal sessions to rename');
  if (!root) return;
  state.rename.root = root;
  await previewRename();
}

async function applyRename() {
  const r = state.rename;
  if (!r || !r.plan) return;
  const { file_count: files, folder_count: folders } = r.plan;
  const ok = await window.api.confirm({
    message: `Rename ${files} clip${files === 1 ? '' : 's'} and update ` +
             `${folders} folder count${folders === 1 ? '' : 's'}?`,
    detail: 'This renames files on disk in place. The names come from each ' +
            'folder’s event name and the clip order by shot time.',
    confirmLabel: 'Rename now',
  });
  if (!ok) return;
  r.applying = true; render();
  try {
    r.result = await call('apply_rename', { plan: r.plan },
                          { label: 'Renaming clips and folders' });
    const errs = (r.result.errors || []).length;
    toast(`Renamed ${r.result.renamed_files} file(s) and ` +
          `${r.result.renamed_folders} folder(s)` +
          (errs ? ` · ${errs} problem(s)` : ''), errs ? 'warn' : 'ok');
    // Reflect the new state of disk: the just-applied plan is now stale.
    r.plan = null;
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    r.applying = false; render();
  }
}

function closeRenameTool() {
  state.rename = null;
  render();
}

function renameRowsHtml(rows, kind) {
  const shown = rows.slice(0, 400);
  const extra = rows.length - shown.length;
  const body = shown.map((row) => `<tr>
    <td class="mono old">${esc(row.rel_old)}</td>
    <td class="arrow">→</td>
    <td class="mono new">${esc(row.rel_new)}${
      kind === 'folder' ? ` <span class="badge">${row.count} clip${
        row.count === 1 ? '' : 's'}</span>` : ''}</td>
  </tr>`).join('');
  return `<table class="rename-table">${body}</table>${
    extra ? `<p class="hint" style="margin:8px 0 0">…and ${extra} more not shown.</p>` : ''}`;
}

function renderRenameModal() {
  const host = $('modal');
  if (!host) return;
  const r = state.rename;
  if (!r || !r.open) { host.innerHTML = ''; host.classList.remove('show'); return; }
  host.classList.add('show');

  const plan = r.plan;
  const nothing = plan && !plan.file_count && !plan.folder_count;
  let bodyHtml;
  if (r.scanning) {
    bodyHtml = `<div class="empty"><div class="big">🔎</div>
      <div>Scanning ${esc(r.root)}…</div></div>`;
  } else if (r.result) {
    const errs = r.result.errors || [];
    bodyHtml = `<div class="note ok"><b>Done.</b> Renamed
      ${r.result.renamed_files} file(s) and ${r.result.renamed_folders} folder(s).</div>
      ${errs.length ? `<div class="note warn"><b>${errs.length} problem(s):</b>
        <ul style="margin:6px 0 0 16px;padding:0">${errs.slice(0, 20)
          .map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
      <p class="hint">You can preview again to confirm everything is now clean, or close.</p>`;
  } else if (!plan) {
    bodyHtml = `<div class="empty"><div class="big">📂</div>
      <div>Drop a folder here, or choose one, to preview the renames.</div></div>`;
  } else if (nothing) {
    bodyHtml = `<div class="note ok"><b>Nothing to change.</b> Every clip already
      follows the naming scheme and every Clips-NN count is correct.</div>`;
  } else {
    bodyHtml = `<div class="note info">${plan.file_count} clip(s) will be renamed ·
      ${plan.folder_count} folder count(s) will be updated.</div>
      ${plan.folders.length ? `<h4 class="rename-h">Folder clip counts</h4>
        ${renameRowsHtml(plan.folders, 'folder')}` : ''}
      ${plan.files.length ? `<h4 class="rename-h">Clip renames</h4>
        ${renameRowsHtml(plan.files, 'file')}` : ''}`;
  }

  const canApply = plan && !nothing && !r.scanning && !r.applying;
  host.innerHTML = `<div class="modal-backdrop" data-close="1">
    <div class="modal-panel" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div>
          <h3 style="margin:0">Rename &amp; fix clip counts</h3>
          <div class="path" style="margin-top:4px">${esc(r.root || '')}</div>
        </div>
        <button class="sm ghost" id="btnRenameClose">Close</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-foot">
        <button class="sm" id="btnRenameChoose" ${r.applying ? 'disabled' : ''}>Choose folder…</button>
        <button class="sm ghost" id="btnRenamePreview" ${r.scanning || r.applying ? 'disabled' : ''}>Preview again</button>
        <div class="spacer"></div>
        <button class="primary" id="btnRenameApply" ${canApply ? '' : 'disabled'}>
          ${r.applying ? 'Renaming…' : 'Apply renames'}</button>
      </div>
    </div>
  </div>`;

  host.querySelector('[data-close]')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeRenameTool();
  });
  $('btnRenameClose')?.addEventListener('click', closeRenameTool);
  $('btnRenameChoose')?.addEventListener('click', chooseRenameFolder);
  makeFolderDropTarget(host.querySelector('.modal-panel'), async (folder) => {
    if (r.scanning || r.applying) return;
    state.rename.root = folder;
    await previewRename();          // starts from an empty list for the new folder
  });
  $('btnRenamePreview')?.addEventListener('click', previewRename);
  $('btnRenameApply')?.addEventListener('click', applyRename);
}

/* --------------------------------------- offline CSV verification (page) */

// The offline twin of the Frappe sync: pick a drive and a duration CSV that
// was exported from Frappe while online, then diff them with no network. The
// result is a side-by-side, colour-coded comparison plus a report CSV — the
// same highlighting the standalone vidcount template produces.

async function openVerifyCsv() {
  const root = await window.api.pickFolder(
    'Choose the drive or folder holding the sessions to verify');
  if (!root) return;
  const csv = await window.api.pickCsv();
  if (!csv) return;
  state.verify = { open: true, root, csv, busy: false, result: null, error: null,
                   show: { match: true, diff: true, scan_only: true,
                           master_only: true, special: true } };
  render();
  await runVerify();
}

async function chooseVerifyFolder() {
  const root = await window.api.pickFolder(
    'Choose the drive or folder holding the sessions to verify');
  if (!root) return;
  state.verify.root = root;
  await runVerify();
}

async function chooseVerifyCsv() {
  const csv = await window.api.pickCsv();
  if (!csv) return;
  state.verify.csv = csv;
  await runVerify();
}

async function runVerify() {
  const v = state.verify;
  if (!v || !v.root || !v.csv) return;
  v.busy = true; v.result = null; v.error = null;
  render();
  try {
    v.result = await call('verify_csv',
      { root: v.root, csv_path: v.csv },
      { label: 'Comparing drive to CSV' });
    const c = v.result.counts;
    toast(`Verify: ${c.match} match, ${c.diff} mismatch, ` +
          `${c.scan_only} on-drive-only, ${c.master_only} in-Frappe-only` +
          (c.special ? `, ${c.special} Sankul/DJM.` : '.'),
          (c.diff || c.scan_only || c.master_only) ? 'warn' : 'ok');
  } catch (e) {
    v.error = e.message;
    toast(e.message, 'err');
  } finally {
    v.busy = false;
    render();
  }
}

function closeVerify() {
  state.verify = null;
  render();
}

const VERIFY_FLAG = {
  match:       { label: 'OK',              cls: 'ok'   },
  diff:        { label: 'Mismatch',        cls: 'diff' },
  scan_only:   { label: 'On drive only',   cls: 'scan' },
  master_only: { label: 'In Frappe only',  cls: 'master' },
  special:     { label: 'Sankul / DJM',    cls: 'special' },
};

// The category decides the row colour and which filter box owns it. It is set
// by the engine (Sankul/DJM rows take precedence over match/mismatch/in-Frappe);
// fall back to the raw flag for older results.
const verifyCat = (r) => r.category || r.flag;

function verifyRowsHtml(rows) {
  const shown = rows.slice(0, 1000);
  const extra = rows.length - shown.length;
  const body = shown.map((r) => {
    const f = VERIFY_FLAG[verifyCat(r)] || { label: verifyCat(r), cls: '' };
    const delta = (r.clip_delta === null || r.clip_delta === 0) ? ''
      : (r.clip_delta > 0 ? `+${r.clip_delta}` : `${r.clip_delta}`);
    return `<tr class="v-${f.cls}">
      <td><span class="badge ${f.cls === 'ok' ? 'ok' : 'warn'}">${esc(f.label)}</span></td>
      <td class="mono">${esc(r.id)}</td>
      <td class="mono">${esc(String(r.master_duration || '—'))}</td>
      <td class="mono">${esc(String(r.scan_duration || '—'))}</td>
      <td class="mono">${esc(String(r.master_clips || '—'))}</td>
      <td class="mono">${esc(String(r.scan_clips || '—'))}
        ${delta ? `<span class="hint" style="margin:0">(${esc(delta)})</span>` : ''}</td>
      <td class="hint" style="margin:0">${esc(r.note || '')}</td>
    </tr>`;
  }).join('');
  return `<div class="scroll" style="max-height:440px"><table class="verify-table">
    <thead><tr>
      <th>Status</th><th>ID</th>
      <th>Duration (Frappe)</th><th>Duration (Drive)</th>
      <th>Clips (Frappe)</th><th>Clips (Drive)</th><th>Note</th>
    </tr></thead>
    <tbody>${body}</tbody></table></div>${
    extra ? `<p class="hint" style="margin:8px 0 0">…and ${extra} more not shown (all are in the report).</p>` : ''}`;
}

function renderVerifyModal() {
  const host = $('modal');
  const v = state.verify;
  host.classList.add('show');

  let body;
  if (v.busy) {
    body = `<div class="empty"><div class="big">🔎</div>
      <div>Reading durations and comparing to the CSV…</div></div>`;
  } else if (v.error) {
    body = `<div class="note err"><b>CSV check failed:</b> ${esc(v.error)}</div>`;
  } else if (v.result) {
    const c = v.result.counts;
    const rows = v.result.rows || [];
    const show = v.show || (v.show = { match: true, diff: true, scan_only: true,
                                       master_only: true, special: true });
    const filtered = rows.filter((r) => show[verifyCat(r)] !== false);
    const clean = !c.diff && !c.scan_only && !c.master_only;
    const chk = (flag, cls, label, count) => `<label class="v-filter">
        <input type="checkbox" id="vf_${flag}" ${show[flag] === false ? '' : 'checked'}>
        <span class="sw ${cls}"></span>${label} <b>${count || 0}</b></label>`;
    body = `<div class="note ${clean ? 'ok' : 'warn'}">
        <b>${c.match}</b> match · <b>${c.diff}</b> mismatch ·
        <b>${c.scan_only}</b> on drive only · <b>${c.master_only}</b> in Frappe only ·
        <b>${c.special || 0}</b> Sankul/DJM
        <span class="hint" style="margin:0">· ${v.result.scanned} on drive, ${v.result.master} in Frappe</span></div>
      <div class="v-filters">
        <span class="hint" style="margin:0">Show:</span>
        ${chk('scan_only', 'v-scan', 'On drive only', c.scan_only)}
        ${chk('master_only', 'v-master', 'In Frappe only', c.master_only)}
        ${chk('special', 'v-special', 'Sankul / DJM', c.special)}
        ${chk('diff', 'v-diff', 'Mismatch', c.diff)}
        ${chk('match', 'v-ok', 'Match', c.match)}
      </div>
      ${!rows.length
        ? '<div class="note info">Nothing to compare — no sessions on the drive and no rows in the Frappe file.</div>'
        : !filtered.length
          ? '<div class="note info">No rows match the current filter — tick a box above to show some.</div>'
          : verifyRowsHtml(filtered)}
      ${v.result.report_path ? `<div class="note info" style="margin-top:10px">Highlighted report written to:
        <div class="mono" style="margin-top:4px">${esc(v.result.report_path)}</div>
        <button class="sm" id="btnVerifyReveal" style="margin-top:8px">Reveal report</button></div>` : ''}`;
  } else {
    body = '';
  }

  host.innerHTML = `<div class="modal-backdrop" data-close="1">
    <div class="modal-panel wide" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div><h3 style="margin:0">Offline verify — Drive vs Frappe</h3>
        <div class="path" style="margin-top:4px">Drive: ${esc(v.root || '')}</div>
        <div class="path" style="margin-top:2px">Frappe file: ${esc(v.csv || '')}</div></div>
        <button class="sm ghost" id="btnVerifyClose">Close</button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">
        <button class="sm" id="btnVerifyFolder" ${v.busy ? 'disabled' : ''}>Choose folder…</button>
        <button class="sm" id="btnVerifyPickCsv" ${v.busy ? 'disabled' : ''}>Choose CSV…</button>
        <button class="sm ghost" id="btnVerifyRerun" ${v.busy ? 'disabled' : ''}>Run again</button>
        <div class="spacer"></div>
        <button class="primary" id="btnVerifyDone" ${v.busy ? 'disabled' : ''}>Done</button>
      </div>
    </div>
  </div>`;
  host.querySelector('[data-close]')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget && !v.busy) closeVerify();
  });
  $('btnVerifyClose')?.addEventListener('click', () => { if (!v.busy) closeVerify(); });
  $('btnVerifyDone')?.addEventListener('click', closeVerify);
  $('btnVerifyFolder')?.addEventListener('click', chooseVerifyFolder);
  $('btnVerifyPickCsv')?.addEventListener('click', chooseVerifyCsv);
  $('btnVerifyRerun')?.addEventListener('click', runVerify);
  $('btnVerifyReveal')?.addEventListener('click', () => {
    if (v.result && v.result.report_path) window.api.reveal(v.result.report_path);
  });
  ['match', 'diff', 'scan_only', 'master_only', 'special'].forEach((flag) => {
    const el = $(`vf_${flag}`);
    el?.addEventListener('change', () => {
      (v.show || (v.show = {}))[flag] = el.checked;
      render();
    });
  });
}

/* ------------------------------------------------------------------- boot */

if (typeof window.api.onBeforeClose === 'function') window.api.onBeforeClose(async () => {
  if (typeof scheduleFlush === 'function') await scheduleFlush();
  if (typeof colWidthSaveTimer !== 'undefined') clearTimeout(colWidthSaveTimer);
  if (state.colWidths) await window.api.setSettings({ colWidths: state.colWidths });
});

window.api.onProgress(({ id, data }) => {
  if (!state.busy || state.busy.id !== id) return;
  const b = state.busy;
  if (data.stage === 'copy') {
    b.percent = data.percent;
    b.detail = data.current || '';
    b.left = `${fmtBytes(data.bytes_done)} of ${fmtBytes(data.bytes_total)}`;
    const speed = Number(data.rate_bps) > 0 ? `${fmtBytes(data.rate_bps)}/s` : '';
    const eta = data.eta_seconds != null
      ? `${Math.floor(data.eta_seconds / 60)}m ${data.eta_seconds % 60}s left` : '';
    b.right = [speed, eta].filter(Boolean).join(' · ');
  } else if (data.total) {
    b.percent = Math.round((data.done / data.total) * 100);
    b.detail = data.name || data.root || '';
    b.left = `${data.done} of ${data.total}`;
    b.right = '';
  } else {
    b.detail = data.name || data.root || '';
  }
  // Repaint the footer only — re-rendering the whole page mid-copy is wasteful.
  renderFooter();
});

window.api.onStatus((msg) => {
  if (msg.state === 'ready') {
    state.engine = { ready: true, info: msg.info, error: null };
    $('engineDot').className = 'dot ok';
    $('engineText').textContent = msg.info.ffprobe
      ? `Engine ready · Python ${msg.info.python}`
      : 'Engine ready · ffprobe missing';
    render();
  } else if (msg.state === 'exited') {
    state.engine = { ready: false, info: null, error: `Engine stopped (code ${msg.code}).` };
    $('engineDot').className = 'dot err';
    $('engineText').textContent = 'Engine stopped';
    render();
  }
});

async function setCloudflareDns() {
  // Main re-checks its own busy flag; this also covers an unsaved prepared plan or schedule run.
  if (state.busy || state.scheduleRun || (state.plan && !state.runResult)) {
    toast('Finish or cancel the current backup before changing DNS and restarting.', 'warn');
    return;
  }
  try {
    const r = await window.api.dns.setCloudflare();
    if (!r.ok && r.code !== 'cancelled') toast(r.error, r.code === 'busy' ? 'warn' : 'err');
  } catch (e) { toast(e.message, 'err'); }
}

async function restartEngine() {
  const r = await window.api.restart();
  if (r.ok) { state.engine = { ready: true, info: r.result, error: null }; toast('Engine restarted', 'ok'); }
  else { state.engine.error = r.error; toast(r.error, 'err'); }
  render();
}

async function locateFfprobe() {
  const p = await window.api.pickExecutable();
  if (!p) return;
  try {
    const r = await call('configure', { ffprobe: p });
    state.engine.info = { ...state.engine.info, ...r };
    await window.api.setSettings({ ffprobe: p });
    toast(r.ffprobe ? 'ffprobe set.' : 'That file isn\'t a working ffprobe.', r.ffprobe ? 'ok' : 'err');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

// A file dropped outside a drop target must not navigate the window away.
if (typeof window.addEventListener === 'function') {
  ['dragover', 'drop'].forEach((type) => window.addEventListener(type, (e) => {
    if ([...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files')) e.preventDefault();
  }));
}

(async function boot() {
  render();
  try {
    const settings = await window.api.getSettings();
    if (!(typeof syncInit === 'function' && await syncInit())) await restoreSchedules(settings);
    render();
    let info = await call('ping');
    if (settings.ffprobe && !info.ffprobe) {
      info = { ...info, ...await call('configure', { ffprobe: settings.ffprobe }) };
    }
    state.engine = { ready: true, info, error: null };
    $('engineDot').className = 'dot ok';
    $('engineText').textContent = info.ffprobe
      ? `Engine ready · Python ${info.python}`
      : 'Engine ready · ffprobe missing';
    reportPreload();
    await rescanVolumes();
  } catch (e) {
    state.engine = { ready: false, info: null, error: e.message };
    $('engineDot').className = 'dot err';
    $('engineText').textContent = 'Engine failed';
    render();
  }
})();

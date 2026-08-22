'use strict';

/* ------------------------------------------------------------------ state */

const state = {
  step: 0,
  engine: { ready: false, info: null, error: null },
  volumes: [],
  sources: [],          // {path, label, kind, role, report}
  assignment: null,
  scans: {},            // sourcePath -> {files, suggestion}
  detected: {},         // sourcePath -> the session folder found on it
  template: null,       // structure + name imported from a zip/folder of empty folders
  extraFiles: {},       // sourcePath -> files the operator picked by hand
  byDate: null,         // last-modified breakdown of the loaded footage
  activeDay: null,      // the day last bulk-selected, for highlighting only
  masters: {},          // sourcePath -> chosen master file path
  masterSource: null,   // the drive the master was picked from
  cardCams: {},         // card label -> cam number (distinct card = distinct camera)
  camNames: {},         // cam number -> custom folder name (default "Cam-NN")
  mastersFiled: false,  // true once the first copy is done; later adds skip masters
  filedSessions: {},    // role -> final session folder, for adding cameras afterwards
  pairing: null,
  session: { title: '', jobNumber: '', date: '', destMode: 'inPlace', destRoots: {} },
  assign: {},           // primary file path -> 'master' | cam number | 'skip'
  camCount: 3,
  plan: null,
  runResult: null,
  compare: null,
  deep: null,
  compareRoots: [],
  pairVerify: null,     // focused result: copied clips identical on both SSDs
  busy: null,           // {label, id, percent, detail}
};

const STEPS = [
  { key: 'sources', label: 'Sources', title: 'Sources',
    hint: 'Import the structure zip, then add the drives holding the footage and set where each one writes.' },
  { key: 'session', label: 'Folder', title: 'Session folder',
    hint: 'The folder name comes from the structure. Load the footage — clips from the session date are pre-selected.' },
  { key: 'cameras', label: 'Cameras', title: 'Camera assignment',
    hint: 'Choose which clip belongs to which cam. The same choice is mirrored onto the other SSD.' },
  { key: 'copy', label: 'Copy', title: 'Review and copy',
    hint: 'Nothing is written until you press Start. Files keep their own names — only the folder name gains Dur-.' },
  { key: 'verify', label: 'Verify', title: 'Compare copies',
    hint: 'Check the two SSDs (and the SD card) hold the same session, file for file.' },
];

/* ---------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(1)} ${u[i]}`;
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
    case 1: return footageSources().length > 0;
    case 2: return !!detection() && chosenMasters().length > 0;
    case 3: return chosenMasters().length > 0;
    case 4: return true;
    default: return false;
  }
}

/** Sources that carry footage — the template is a structure donor, not footage. */
function footageSources() {
  return state.sources.filter((s) => s.role !== 'template');
}

function primarySource() {
  const f = footageSources();
  // Cams are assigned against one drive and mirrored to the other. Prefer the
  // drive the operator marked, then one that has masters picked, then by codec.
  return f.find((s) => s.path === state.masterSource)
      || f.find((s) => (state.masters[s.path] || []).length)
      || f.find((s) => s.role === 'prores') || f.find((s) => s.role === 'h265') || f[0];
}

/** Where a source's output goes; defaults to the source drive itself. */
function destOf(src) {
  return (src && (src.dest || src.path)) || '';
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
  const scanned = (state.scans[src.path] || {}).files || [];
  const extra = state.extraFiles[src.path] || [];
  const seen = new Set(scanned.map((f) => f.path));
  return scanned.concat(extra.filter((f) => !seen.has(f.path)));
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

/** Clips loaded but not selected for this session. */
function skipped(src) {
  return filePool(src).filter((f) => state.assign[f.path] === 'skip');
}

/** Clips that will actually be filed. */
function selected(src) {
  return filePool(src).filter((f) => typeof state.assign[f.path] === 'number');
}

/**
 * The default cam for a freshly loaded clip.
 *
 * Clips from the session date the folder states are selected; anything else
 * starts on Skip, visible and one click from being included. A clip picked by
 * hand is an explicit request, so it is selected whatever day it carries — the
 * drives do not always preserve shoot timestamps through a copy.
 */
function defaultAssignmentFor(file) {
  if (file.manual) return 1;
  const day = sessionDate();
  if (!day || !file.shoot_date) return 1;
  return file.shoot_date === day ? 1 : 'skip';
}

/** Every path currently in play, across every footage drive. */
function livePaths() {
  return new Set(footageSources().flatMap((f) => filePool(f)).map((f) => f.path));
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
    if (!live.has(path)) delete state.assign[path];
  }
  if (state.pairing) {
    const stale = Object.keys(state.pairing.matches).some((p) => !live.has(p));
    if (stale) state.pairing = null;      // pairing was made against a different set
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
  const pool = ((detection() && detection().master_candidates) || []).concat(filePool(src));
  return picks
    .map((path) => pool.find((f) => f.path === path))
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

/** Pre-select each drive's root/date masters, leaving manual picks alone. */
function suggestMasters() {
  if (state.mastersFiled) return;    // the master is already filed; do not re-detect
  for (const f of footageSources()) {
    const already = state.masters[f.path];
    if (Array.isArray(already) && already.length) continue;   // operator has chosen
    const sug = suggestedMastersFor(f);
    if (sug.length) {
      state.masters[f.path] = sug.map((x) => x.path);
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
  const primary = mastersFor(primarySource());
  if (primary.length) return primary;
  const d = detection();
  return d && d.suggested_master ? [d.suggested_master] : [];
}

function chosenMaster() {
  return chosenMasters()[0] || null;
}

function isMasterPath(path) {
  return masterPaths().has(path);
}

/** Paths of every master, for excluding them from the cam clip list. */
function masterPaths() {
  return new Set(chosenMasters().map((f) => f.path));
}

/** The folder's Dur- token: the total of every master clip. */
function masterTotalSeconds() {
  const timed = chosenMasters().map((f) => f.duration).filter((d) => d != null);
  return timed.length ? timed.reduce((a, b) => a + b, 0) : null;
}

function secondarySource() {
  const p = primarySource();
  return footageSources().find((s) => s !== p && (s.role === 'prores' || s.role === 'h265'));
}

/* ------------------------------------------------------------ step: sources */

function renderSources() {
  const c = [];

  if (state.engine.error) {
    c.push(`<div class="note err"><b>Engine problem.</b> ${esc(state.engine.error)}</div>`);
  } else if (state.engine.info && !state.engine.info.ffprobe) {
    c.push(`<div class="note err"><b>ffprobe not found.</b> Durations and codec detection
      need it. Install ffmpeg, then press “Locate ffprobe”.</div>`);
  }

  c.push(`<div class="card">
    <h3>Detected drives</h3>
    <p class="hint">Removable volumes only — your system disk is never listed.</p>
    <div class="row" style="margin-bottom:12px">
      <button class="sm" id="btnRescan">Rescan drives</button>
      <button class="sm" id="btnAddFolder">Add folder as source…</button>
      <button class="sm ${state.template ? '' : 'primary'}" id="btnAddZip">
        ${state.template ? 'Replace structure zip…' : 'Import structure zip…'}</button>
      <div class="spacer"></div>
      <button class="sm primary" id="btnClassify"
        ${state.sources.length ? '' : 'disabled'}>Probe codecs &amp; assign roles</button>
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
    c.push(`<div class="card"><h3>Sources in this job</h3>
      <p class="hint">Each source becomes its own copy of the session folder.</p>`);
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
          <div class="seg">
            ${['prores', 'h265', 'sd', 'template', 'other'].map((role) => `
              <button data-role="${role}" data-path="${esc(s.path)}"
                class="${s.role === role ? 'on' : ''}">${
                  { prores: 'ProRes', h265: 'H.265', sd: 'SD card',
                    template: 'Structure', other: 'Other' }[role]}</button>`).join('')}
          </div>
          <button class="sm ghost" data-remove="${esc(s.path)}">Remove</button>
        </div>
      </div>
      ${s.role === 'template' ? '' : `
      <div class="row" style="margin:-4px 0 10px 48px">
        <span class="hint" style="margin:0">Destination</span>
        <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;
          white-space:nowrap;color:${s.dest ? 'var(--text)' : 'var(--muted)'}">
          ${esc(s.dest || s.path)}${s.dest ? '' : '  (the source drive itself)'}</span>
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
  return c.join('');
}

function wireSources() {
  $('btnRescan')?.addEventListener('click', rescanVolumes);
  $('btnAddFolder')?.addEventListener('click', async () => {
    const p = await window.api.pickFolder('Choose a footage folder');
    if (p) addSource(p, p.split(/[\\/]/).pop() || p, 'folder');
  });
  $('btnAddZip')?.addEventListener('click', addZipSource);
  $('btnClassify')?.addEventListener('click', classifySources);

  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    // The button toggles: "Use as source" adds it, "Added" takes it back off.
    const existing = state.sources.find((s) => s.path === b.dataset.add);
    if (existing) {
      if (existing.role === 'template') state.template = null;
      state.sources = state.sources.filter((s) => s.path !== b.dataset.add);
      state.plan = null;
      render();
    } else {
      addSource(b.dataset.add, b.dataset.label, 'volume');
    }
  }));
  document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    const gone = state.sources.find((s) => s.path === b.dataset.remove);
    if (gone && gone.role === 'template') state.template = null;
    state.sources = state.sources.filter((s) => s.path !== b.dataset.remove);
    state.plan = null;
    render();
  }));

  document.querySelectorAll('[data-dest]').forEach((b) => b.addEventListener('click', async () => {
    const chosen = await window.api.pickFolder('Choose where this drive\u2019s session folder goes');
    if (!chosen) return;
    const src = state.sources.find((x) => x.path === b.dataset.dest);
    if (src) { src.dest = chosen; state.plan = null; render(); }
  }));
  document.querySelectorAll('[data-dest-clear]').forEach((b) => b.addEventListener('click', () => {
    const src = state.sources.find((x) => x.path === b.dataset.destClear);
    if (src) { delete src.dest; state.plan = null; render(); }
  }));
  document.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
    const s = state.sources.find((x) => x.path === b.dataset.path);
    if (!s) return;
    // Roles other than "other" are exclusive: two ProRes targets is always a mistake.
    if (b.dataset.role !== 'other') {
      state.sources.forEach((x) => { if (x !== s && x.role === b.dataset.role) x.role = 'other'; });
    }
    const was = s.role;
    s.role = b.dataset.role;
    state.plan = null;
    if (s.role === 'template') loadTemplate(s);
    else if (was === 'template') { state.template = null; render(); }
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
    const ok = await window.api.confirm({
      message: `Use “${info.label}” as the folder structure?`,
      detail: `${info.folder_count} folders, ${info.video_count} video files.\n\n`
        + `It supplies the session folder name and the cam layout. `
        + (info.video_count
            ? `The ${info.video_count} clip(s) inside will be available as footage too.`
            : `You pick the footage yourself from the source drive.`),
      confirmLabel: 'Use as structure',
    });
    if (!ok) return;
    const r = await call('extract_zip', { path: zip },
      { label: `Extracting ${info.label}` });
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
    const d = await call('detect_structure', { root: src.path },
      { label: `Reading ${src.label}` });
    if (!d.session_path) {
      toast(`No session folder found in ${src.label}: ${d.reason}`, 'err');
      src.role = 'other';
      state.template = null;
    } else {
      state.template = d;
      state.camCount = Math.max(3,
        ...(d.tree || []).map((t) => {
          const m = /Cam-(\d+)$/.exec(t);
          return m ? Number(m[1]) : 0;
        }));
      toast(`Structure: ${d.session_name.slice(0, 40)}…`, 'ok');
    }
    state.plan = null;
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function classifySources() {
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

function renderSession() {
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
      <h3>No session folder recognised</h3>
      <div class="note warn">${esc(d.reason)}</div>
      <p class="hint">Point the app at the folder yourself, or build a new one from a
        name you type.</p>
      <div class="row">
        <button class="primary" id="btnPickSession">Choose the session folder…</button>
        <button id="btnCreateMode">Create a new folder instead</button>
      </div>
      ${state.session.destMode === 'create' ? createFolderForm() : ''}
    </div>`;
  }

  const masters = chosenMasters();
  const dur = masterTotalSeconds();
  const base = stripClipsToken(d.base_name || d.session_name);
  const durLabel = fmtDurAuto(dur);
  const already = d.has_dur && d.current_dur != null;
  const unchanged = already && dur != null && Math.abs(d.current_dur - dur) < 1;

  return `
  <div class="card">
    <h3>Folder found on the drive</h3>
    <p class="hint">${esc(d.reason)} Nothing here was typed — it is read from the disk.</p>
    <div class="preview-name">
      ${d.job_name ? `📁 ${esc(d.job_name)}<br>` : ''}
      <span class="${d.job_name ? 'indent1' : ''}" style="display:inline-block">📁
        ${esc(base)} <b>Dur-${esc(durLabel)}</b></span>
    </div>
    <p class="hint" style="margin:8px 0 0">
      The bold <b>Dur-${esc(durLabel)}</b> is the only part the app adds. Everything else
      is the folder's existing name, left exactly as it is.</p>
    ${already ? `<div class="note ${unchanged ? 'ok' : 'warn'}" style="margin-top:10px">
      ${unchanged
        ? `This folder already reads <b>Dur-${esc(fmtDurLike(d.current_dur, d.session_name))}</b> and matches the
           master, so its name will not change.`
        : `This folder currently reads <b>Dur-${esc(fmtDurLike(d.current_dur, d.session_name))}</b>, but the master
           is <b>${esc(durLabel)}</b>. The token will be corrected.`}
    </div>` : ''}
    <div class="row" style="margin-top:12px">
      <button class="sm ghost" id="btnRedetect">Look again</button>
      <button class="sm ghost" id="btnPickSession">Choose a different folder…</button>
    </div>
  </div>

  <div class="card">
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
      : `<div class="note err">No video file sits directly in the session folder, so
         there is nothing to read a duration from. Put the program recording there,
         or choose a different folder.</div>`}
  </div>

  <div class="card">
    <h3>Filing the clips</h3>
    <p class="hint">The master is <b>moved</b> into the folder — it is already on this drive,
      so it just relocates. Camera clips are <b>copied</b> to both SSDs. Nothing is ever
      deleted; clear the camera cards yourself when you are ready.</p>
    <label class="field" style="max-width:340px"><span>Verification</span>
      <select id="fVerify">
        <option value="size">Size check (fast)</option>
        <option value="hash">Checksum every file (bit-exact, slower)</option>
        <option value="none">None</option>
      </select></label>
    <p class="hint" style="margin:0">Moving is the usual choice when the clips are already
      on the right drive and only need filing — copying leaves a second copy behind at the
      folder's top level.</p>
  </div>`;
}

/**
 * Give every clip in play a cam, defaulting to Cam-01.
 *
 * Landing on the Cameras page with everything set to Skip means the common case
 * — one camera, all clips to Cam-01 — needs a click per clip for no reason.
 * Skip stays available, it is just no longer the default.
 */
/**
 * Split clips into likely cameras by their recording signature.
 *
 * Two bodies rarely agree on resolution, frame rate and codec all at once, so
 * that triple separates them. Everything matching lands in one group — which is
 * the right answer for a single-camera shoot.
 */
function camGroupsFromPool(files) {
  const groups = new Map();
  for (const f of files) {
    const key = `${f.width}x${f.height}@${f.fps}/${f.video_codec}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return [...groups.values()]
    .sort((a, b) => b.length - a.length)
    .map((g) => g.sort((x, y) => (x.mtime || 0) - (y.mtime || 0)));
}

/** A cam's folder name: the custom name if set, else "Cam-NN". */
function camLabel(n) {
  return (state.camNames[n] || '').trim() || `Cam-${String(n).padStart(2, '0')}`;
}

function ensureDefaultAssignments() {
  const src = primarySource();
  if (!src) return;
  for (const f of filePool(src)) {
    if (isMasterPath(f.path)) continue;
    if (state.assign[f.path] === undefined) {
      state.assign[f.path] = defaultAssignmentFor(f);
    }
  }
}

/** Select every clip from one day and skip the rest — the day buttons' action. */
function selectDay(day) {
  const src = primarySource();
  if (!src) return;
  for (const f of filePool(src)) {
    if (isMasterPath(f.path)) continue;
    state.assign[f.path] = (!day || f.shoot_date === day) ? 1 : 'skip';
  }
  state.activeDay = day || null;
  state.plan = null;
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
  const base = stripClipsToken((state.template && (state.template.base_name
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
        <button class="sm ${loaded ? '' : 'primary'}" data-scan="${esc(f.path)}">Scan</button>
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
          ${masters.filter((m) => offSessionDate(m)).map((m) => esc(m.name)).join(', ')}
          — not from ${esc(fmtDay(sessionDate()))}. Master clips should be this session's
          recording.</div>` : ''}
      ${masters.length ? `
        <p class="hint" style="margin:10px 0 4px">Renamed after the folder:</p>
        <div class="preview-name" style="font-size:11px">${masters.map((m, i) => `🎬 ${
          esc(masterClipName(base, m.duration, i + 1, masters.length, m.path))}`).join('<br>')}
        </div>
        ${masters.length > 1 ? `<p class="hint" style="margin:6px 0 0">${
          masters.map((m) => esc(fmtDurAuto(m.duration))).join(' + ')} =
          <b>${esc(fmtDurAuto(total))}</b>, Clips-${String(masters.length).padStart(2, '0')}.</p>` : ''}`
        : '<p class="hint" style="margin:8px 0 0">Tick the program recording above.</p>'}`
      : `<div class="note warn" style="margin:0">Nothing loaded — Scan or Add files.</div>`}
  </div>`;
}

function renderTemplateFolder(src) {
  const t = state.template;
  const masters = chosenMasters();
  const dur = masterTotalSeconds();
  const base = stripClipsToken(t.base_name || t.session_name);
  const durLabel = fmtDurAuto(dur);
  const pool = filePool(src);
  const cams = (t.tree || []).filter((x) => /Cam-\d+$/.test(x));

  return `
  <div class="card">
    <h3>Folder name from the imported structure</h3>
    <p class="hint">Read from the structure you imported — not typed, and not altered.</p>
    <div class="preview-name">
      ${t.job_name ? `📁 ${esc(t.job_name)}<br>` : ''}
      <span class="${t.job_name ? 'indent1' : ''}" style="display:inline-block">📁
        ${esc(base)} <b>Dur-${esc(durLabel)}</b></span>
      ${cams.map((c) => `<div class="indent2" style="color:var(--muted)">📁 ${esc(c)}</div>`).join('')}
    </div>
    <p class="hint" style="margin:8px 0 0">The bold <b>Dur-${esc(durLabel)}</b> is the only
      part the app adds${t.has_dur && dur != null
        ? (fmtDurLike(t.current_dur, t.session_name) === durLabel
            ? `, and it already matches what the structure came with`
            : `, replacing the <b>Dur-${esc(fmtDurLike(t.current_dur, t.session_name))}</b>
               placeholder the structure came with`)
        : ''}. The empty cam folders are recreated exactly as the structure defines them.</p>
    <div class="row" style="margin-top:12px">
      ${footageSources().map((f) => `<span class="badge ${f.role}">${esc(f.label)}
        → ${esc(destOf(f).split(/[\\/]/).pop() || destOf(f))}</span>`).join('')}
    </div>
  </div>

  <div class="card">
    <h3>Footage &amp; master clip</h3>
    <p class="hint">The structure carries no footage, so load it from each drive. The master is
      the program recording at the drive's root, dated ${esc(fmtDay(sessionDate()) || 'the session day')};
      the app pre-selects it and leaves the rest for you. Pick each drive's master independently —
      the same recording, one file per codec.</p>
    <div class="drive-cols">
      ${footageSources().map((f) => renderDriveColumn(f)).join('')}
    </div>
    ${dateSuggestion()}
  </div>

  <div class="card">
    <h3>Filing the clips</h3>
    <p class="hint">The master is <b>moved</b> into the folder — it is already on this drive,
      so it just relocates. Camera clips are <b>copied</b> to both SSDs. Nothing is ever
      deleted; clear the camera cards yourself when you are ready.</p>
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
    ` <b>Dur-${esc(durLabel)}</b></span>`;
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
  $('btnDetect')?.addEventListener('click', () => detectStructure(primarySource()));
  $('btnRedetect')?.addEventListener('click', () => detectStructure(primarySource(), true));
  $('btnCreateMode')?.addEventListener('click', () => {
    state.session.destMode = 'create'; render();
  });
  $('btnPickSession')?.addEventListener('click', async () => {
    const chosen = await window.api.pickFolder('Choose the session folder');
    if (chosen) await detectStructure(primarySource(), true, chosen);
  });

  const bySrc = (attr) => (b) => state.sources.find((x) => x.path === b.dataset[attr]);
  document.querySelectorAll('[data-scan]').forEach((b) => b.addEventListener('click', () =>
    scanSource(bySrc('scan')(b), true)));
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
    if (box.checked) picks.add(path); else picks.delete(path);
    state.masters[from] = [...picks];
    delete state.assign[path];     // promoted to master, no longer a cam clip
    if (!state.masterSource || !(state.masters[state.masterSource] || []).length) {
      state.masterSource = from;   // cams are assigned against a drive that has a master
    }
    state.plan = null;
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
      state.session.verify = e.target.value; state.plan = null;
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
    if (!r.card_count) {
      return toast(`No camera cards mounted. Looked for ${r.searched.join(' and ')}.`, 'err');
    }

    // Each distinct card is a distinct camera. Compare every card's name against
    // the ones already inserted: a name seen before keeps its cam; a new name is
    // assigned the next free cam number (Cam-02, Cam-03, …).
    const nextFreeCam = () => {
      const used = new Set(Object.values(state.cardCams));
      let n = 1; while (used.has(n)) n += 1; return n;
    };
    for (const c of r.cards) {
      if (state.cardCams[c.label] == null) state.cardCams[c.label] = nextFreeCam();
    }
    const camByPath = new Map();
    const paths = [];
    for (const c of r.cards) {
      const cam = state.cardCams[c.label];
      for (const f of c.files) { paths.push(f); camByPath.set(f, cam); }
    }
    if (!paths.length) {
      return toast(`Found ${r.card_count} card(s) but no clips inside them.`, 'err');
    }

    const probed = await call('add_files', { paths, session_date: sessionDate() },
      { label: 'Reading card clips' });

    const existing = state.extraFiles[src.path] || [];
    const seen = new Set(existing.map((f) => f.path));
    state.extraFiles[src.path] = existing.concat(
      probed.files.filter((f) => !seen.has(f.path)).map((f) => ({ ...f, manual: true })));

    await applyDateSuggestion(src);
    // Set the cams after the suggestion runs, so the card's letter wins.
    for (const f of probed.files) {
      const cam = camByPath.get(f.path);
      if (cam) state.assign[f.path] = cam;
    }
    state.camCount = Math.max(state.camCount, ...Object.values(state.cardCams));
    state.plan = null;

    toast(`${probed.count} clip(s) from ${r.card_count} card(s) — `
      + r.cards.map((c) => `${c.label} → ${camLabel(state.cardCams[c.label])}`)
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
    if (!r.count) { toast('No video files found there.', 'err'); return render(); }
    const existing = state.extraFiles[src.path] || [];
    const seen = new Set(existing.map((f) => f.path));
    const added = r.files.filter((f) => !seen.has(f.path))
      .map((f) => ({ ...f, manual: true }));
    state.extraFiles[src.path] = existing.concat(added);

    await applyDateSuggestion(src);
    pruneAssignments();
    ensureDefaultAssignments();

    toast(added.length
      ? `Added ${added.length} clip(s) from ${src.label} — selected and ready to assign.`
      : `Those ${r.count} clip(s) were already loaded from ${src.label}.`,
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
  const all = footageSources().flatMap((f) => allFiles(f));
  if (!all.length) { state.byDate = null; return; }
  try {
    state.byDate = await call('group_dates',
      { files: all, session_date: sessionDate() });
    if (state.byDate.matched_session_date && state.activeDay === null) {
      state.activeDay = state.byDate.suggested_date;
    }
    suggestMasters();
    state.plan = null;
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
        <b>Nothing here carries a timestamp from ${esc(fmtDay(g.session_date))}</b>, the date
        the folder states — drives often lose the original times when footage is copied.
        Everything is loaded and selected; choose a day below to narrow it, or just use the
        Cameras page.${buttons}
      </div>`;
  }
  if (!suggested || g.dates.length < 2) return '';

  return `
    <div class="note ${g.matched_session_date ? 'ok' : 'warn'}">
      <b>${suggested.count} clip(s) carry ${esc(fmtDay(g.suggested_date))}</b>
      — ${esc(g.suggestion_basis)} — and are selected. The other
      ${g.other_count} are loaded but set to Skip.
      Clicking a day selects that day and skips the rest; nothing is ever hidden.${buttons}
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
    if (d.suggested_master && !state.masters[src.path]) {
      state.masters[src.path] = [d.suggested_master.path];
      state.masterSource = state.masterSource || src.path;
    }
    // Clips already filed into a cam folder keep that cam; the rest start unassigned.
    state.assign = {};
    for (const [cam, paths] of Object.entries(d.cams || {})) {
      for (const path of paths) state.assign[path] = Number(cam);
    }
    state.camCount = Math.max(3, ...Object.keys(d.cams || {}).map(Number), 0);
    state.plan = null;
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
  if (!scan) {
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
  const files = pool.filter((f) => !isMaster.has(f.path) && f.manual);
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

  const rows = files.map((f) => {
    const a = state.assign[f.path] ?? 'skip';
    return `<tr>
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
        ${cams.map((n) => `<button class="${a === n ? 'on' : ''}" data-assign="${n}"
           data-file="${esc(f.path)}">${n}</button>`).join('')}
        <button class="${a === 'skip' ? 'on skip' : ''}" data-assign="skip" data-file="${esc(f.path)}">Skip</button>
      </div></td>
    </tr>`;
  }).join('');

  const sec = secondarySource();
  const prim = src;
  const secName = sec ? sec.label : 'the other drive';
  const pairInfo = sec
    ? `<div class="note info">These clips are filed to <b>both</b> ${esc(prim.label)} and
         ${esc(secName)} — the two SSDs are kept as identical backups. Each drive keeps its
         own master (${esc(prim.role)} / ${esc(sec.role)}).</div>`
    : '';

  return `
  <div class="card">
    <h3>Assign clips to cameras</h3>
    <p class="hint">Each clip goes to the numbered Cam folder you pick. Skipped clips stay
      where they are. Clips already filed in a cam folder are pre-selected.</p>
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
      <button class="sm" id="btnAddCam">Add cam (${state.camCount})</button>
      <button class="sm" id="btnRemoveCam" ${state.camCount <= 1 ? 'disabled' : ''}>Remove cam</button>
      <button class="sm" id="btnClearAssign">Clear all</button>
      <div class="spacer"></div>
      <button class="sm ghost" id="btnRescanFiles">Re-scan</button>
    </div>
    <div class="row" style="margin-bottom:6px">
      ${cams.map((n) => `<span class="badge" style="gap:4px">
        <input type="text" data-camname="${n}" value="${esc(camLabel(n))}"
          title="Rename this camera's folder"
          style="width:${Math.max(64, camLabel(n).length * 8)}px;background:transparent;
          border:none;border-bottom:1px dashed var(--line);color:inherit;padding:0 2px;font:inherit" />
        : ${counts[n] || 0}</span>`).join('')}
      <span class="badge">Skipped: ${skipped}</span>
    </div>
    ${pairInfo}
    ${noClips ? `<div class="empty"><div class="big">🎥</div>
      <div>No cam clips yet.</div>
      <div style="margin-top:4px">Press <b>Import camera cards</b>, or add clips with
        <b>Add files…</b> / <b>Add a folder…</b>. The drive scan is only used to find the
        master, so it does not fill this list.</div></div>` : ''}
    <div class="scroll" ${noClips ? 'style="display:none"' : ''}><table>
      <thead><tr><th>File</th><th class="num">Length</th><th>Last modified</th>
        <th class="num">Size</th><th style="width:1%">Goes to</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function wireCameras() {
  $('btnScan')?.addEventListener('click', () => scanSource(primarySource()));
  $('btnRescanFiles')?.addEventListener('click', () => scanSource(primarySource(), true));
  $('btnAddFiles')?.addEventListener('click', () => addFootage('files'));
  $('btnAddFolder2')?.addEventListener('click', () => addFootage('folder'));
  $('btnCards')?.addEventListener('click', importCameraCards);
  wireDayButtons();

  document.querySelectorAll('[data-assign]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.assign;
    state.assign[b.dataset.file] = v === 'skip' ? 'skip' : Number(v);
    state.plan = null;
    render();
  }));

  document.querySelectorAll('[data-camname]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const n = Number(inp.dataset.camname);
      const v = inp.value.trim();
      if (v && v !== `Cam-${String(n).padStart(2, '0')}`) state.camNames[n] = v;
      else delete state.camNames[n];
      state.plan = null;
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
    state.assign = {}; state.pairing = null; state.plan = null; render();
  });

  $('btnAutoGroup')?.addEventListener('click', () => {
    const src = primarySource();
    // Grouped from the clips actually in play, masters excluded.
    const clips = filePool(src).filter((f) => !isMasterPath(f.path));
    if (!clips.length) return toast('No clips to group.', 'err');

    const groups = camGroupsFromPool(clips);
    groups.forEach((files, i) => {
      for (const f of files) state.assign[f.path] = i + 1;
    });
    state.camCount = Math.max(state.camCount, groups.length);
    state.plan = null;
    toast(groups.length === 1
      ? `All ${clips.length} clip(s) look like one camera — assigned to Cam-01.`
      : `Grouped ${clips.length} clip(s) into ${groups.length} cams by resolution, `
        + `frame rate and codec. Check before copying.`);
    render();
  });

}

async function scanSource(src, force = false) {
  if (!src || (state.scans[src.path] && !force)) return;
  try {
    const r = await call('scan', { root: src.path, session_date: sessionDate() },
      { label: `Reading ${src.label}` });
    state.scans[src.path] = r;
    if (!r.files.length) toast(`No video files found on ${src.label}.`, 'err');
    else { await applyDateSuggestion(src); pruneAssignments(); ensureDefaultAssignments(); }
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/**
 * Match the clips chosen on the primary drive to their twins on the other one.
 *
 * Both sides go through filePool, so the pairing sees exactly the files in play
 * — hand-picked as well as scanned, and narrowed by the same day filter. Pairing
 * against a raw drive scan would drag in footage from other shoots.
 */
async function mirrorToSecondary(opts = {}) {
  const quiet = opts.quiet;
  const a = primarySource(), b = secondarySource();
  if (!a || !b) return;
  try {
    if (!allFiles(b).length) {
      await scanSource(b);
      await applyDateSuggestion(a);
    }
    const primary = filePool(a);
    const secondary = filePool(b);
    if (!primary.length || !secondary.length) {
      if (!quiet) toast(`No footage loaded for ${(!primary.length ? a : b).label}.`, 'err');
      return;
    }
    state.pairing = await call('pair', { primary, secondary },
      { label: `Matching ${a.label} → ${b.label}` });
    state.plan = null;
    if (!quiet) render();
  } catch (e) { if (!quiet) toast(e.message, 'err'); }
}

/* --------------------------------------------------------------- step: copy */

function buildSpec() {
  const a = primarySource(), b = secondarySource();
  const master = masterInfo();
  const targets = [];

  // Only clips currently in play can reach the plan. state.assign is a record of
  // choices, not a source of truth about what exists.
  const live = livePaths();
  const camsFor = (mapPath) => {
    const cams = {};
    for (const [p, v] of Object.entries(state.assign)) {
      if (typeof v !== 'number' || !live.has(p)) continue;
      const mapped = mapPath(p);
      if (!mapped) continue;
      (cams[v] = cams[v] || []).push(mapped);
    }
    return cams;
  };

  const t = state.template;

  /** A template names the folder and is written to the chosen destination;
   *  otherwise the folder already on the drive is completed in place. */
  const targetFor = (src, cams, masterList) => {
    // Once the first copy is done, the master is already filed and the folder is
    // named — adding a camera later must not touch or re-detect it.
    const masters = state.mastersFiled ? [] : masterList;
    const base = { role: src.role, source_root: src.path, dest_root: destOf(src),
                   masters, cams, cam_names: state.camNames };
    // After the first copy, file additional cameras straight into the existing
    // session folder, so nothing about the master or the name is recomputed.
    const filed = state.filedSessions[src.role];
    if (state.mastersFiled && filed) {
      return { ...base, session_source: filed };
    }
    if (t) {
      return { ...base, session_name: t.session_name, job_name: t.job_name,
               template_dirs: t.tree };
    }
    return { ...base, session_source: (state.detected[src.path] || {}).session_path || null };
  };

  // Both SSDs are backups of each other, so the same cam clips are filed to each
  // — the imported card clips are copied to both drives identically. Only the
  // master differs, because it is that drive's own recording (ProRes vs H.265).
  const cams = camsFor((p) => p);
  targets.push(targetFor(a, cams, mastersFor(a).map((f) => f.path)));
  if (b) {
    targets.push(targetFor(b, cams, mastersFor(b).map((f) => f.path)));
  }

  return {
    title: state.session.title,
    job_number: state.session.jobNumber,
    date: state.session.date || undefined,
    add_date: state.session.addDate !== false,
    mode: 'copy',   // retained for the manifest; the engine relocates or copies automatically
    verify: state.session.verify || 'size',
    targets,
  };
}

function renderCopy() {
  if (!state.plan) {
    const b = secondarySource();
    return `<div class="card">
      <h3>Build the plan</h3>
      <p class="hint">Every source file is probed and its destination name worked out.
        Nothing is written to disk at this stage.</p>
      ${b && !state.pairing ? `<div class="note warn">
        You have not mirrored the selection to <b>${esc(b.label)}</b> yet, so only
        ${esc(primarySource().label)} will be organised. Go back to Cameras to mirror it.</div>` : ''}
      <button class="primary" id="btnPlan">Build plan</button>
    </div>`;
  }

  const p = state.plan;
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
      ${t.warnings.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}
      <div class="tree">
        ${t.job_folder ? `<div class="dir">📁 ${esc(t.job_folder)}</div>` : ''}
        <div class="dir ${t.job_folder ? 'indent1' : ''}">📁 ${esc(t.session_folder)}</div>
        ${masterRows(t)}
        <div class="dir indent2">📁 Clips for Insert</div>
        ${camGroups(t)}
      </div>
    </div>`).join('');

  // Cams are mirrored across the drives, so the empty set is the same on each.
  const empties = p.targets.length ? emptyCams(p.targets[0]) : [];
  const emptyNotice = empties.length ? `
    <div class="card">
      <div class="note warn">
        <b>${empties.map((n) => esc((p.targets[0].cam_names || {})[n]
          || `Cam-${String(n).padStart(2, '0')}`)).join(', ')}
        ${empties.length > 1 ? 'are' : 'is'} empty.</b>
        ${empties.length > 1 ? 'These folders' : 'This folder'} will be created with no clips
        inside. Add clips now if you have footage for ${empties.length > 1 ? 'them' : 'it'},
        or leave ${empties.length > 1 ? 'them' : 'it'} empty — the ${
          empties.length > 1 ? 'folders are' : 'folder is'} still created either way.
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
    ${p.warnings.length ? `<div class="note warn"><b>${p.warnings.length} warning(s)</b>
       — review the details on each drive below.</div>` : ''}
    <div class="card">
      <div class="row">
        <div><b>${p.item_count} file(s) to file</b> · ${fmtBytes(p.total_bytes)} ·
          master moved · clips copied · verify <b>${esc(p.verify)}</b>
          ${(p.renames || []).length ? `· <b>${p.renames.length} folder rename(s)</b>` : ''}
          <br><span class="hint">Only the clips you assigned on the Cameras page are
            included — anything on Skip is untouched, and no source files are deleted.</span></div>
        <div class="spacer"></div>
        <button class="sm" id="btnCopyImportCard">📇 Import camera card</button>
        <button class="sm" id="btnReplan">Rebuild plan</button>
        <button class="primary" id="btnRun" ${state.busy ? 'disabled' : ''}>
          ${state.runResult ? 'Run again' : 'Start copy'}</button>
      </div>
      <div class="hint" style="margin-top:6px">
        Swapped a card? Press <b>Import camera card</b> — a new card is added to the next cam
        folder${state.runResult ? ' and filed straight into the folders already on disk' : ''},
        and the plan updates.</div>
    </div>
    ${status}
    ${emptyNotice}
    ${trees}`;
}

function masterRows(t) {
  const items = t.items.filter((i) => i.kind === 'master');
  if (!items.length) {
    const m = chosenMaster();
    return `<div class="ren indent2">🎬 <b>${esc(m ? m.name : '—')}</b>
      <span style="color:var(--muted)">· already in place</span></div>`;
  }
  return items.map((i) => `<div class="ren indent2">🎬
    <span style="color:var(--muted)">${esc(i.original_name)} →</span>
    <b>${esc(i.dst.split(/[\\/]/).pop())}</b>
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
  const filled = new Set(t.items.filter((i) => i.kind === 'clip').map((i) => i.cam));
  return definedCams(t).filter((n) => !filled.has(n));
}

function camGroups(t) {
  const byCam = {};
  t.items.filter((i) => i.kind === 'clip').forEach((i) => {
    (byCam[i.cam] = byCam[i.cam] || []).push(i);
  });
  const names = t.cam_names || {};
  const fname = (n) => (names[n] || names[String(n)] || `Cam-${String(n).padStart(2, '0')}`);
  return definedCams(t).map((cam) => {
    const items = byCam[cam] || [];
    const head = `<div class="dir indent3">📁 ${esc(fname(cam))}${
      items.length ? '' : ' <span style="color:var(--warn)">· empty</span>'}</div>`;
    return head + items.map((i) => `<div class="ren indent3" style="padding-left:72px">
      <b>${esc(i.original_name)}</b>
      <span style="color:var(--muted)">· ${fmtDur(i.duration)} · ${fmtBytes(i.size)}${
        i.original_name !== i.dst.split(/[\\/]/).pop()
          ? ` · renamed to ${esc(i.dst.split(/[\\/]/).pop())} to avoid a clash` : ''}</span>
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
          + ` (masters relocated instantly, not counted)`
          : ''}
    </div>
    ${(r.renames || []).map((rn) => `<div class="note ${rn.done ? 'ok' : 'warn'}">
      ${rn.done ? `Folder renamed to <span class="mono">${esc(rn.to)}</span>`
                : `Folder not renamed — ${esc(rn.message)}`}</div>`).join('')}
    ${r.errors.map((e) => `<div class="note err mono">${esc(e)}</div>`).join('')}
    <div class="row">
      <button class="primary" id="btnOpenAll">📂 Open all folders in Finder</button>
      <span class="hint" style="margin:0">${finderTargets().length} window(s):
        each drive's session folder${cardFolders().length
          ? ` + ${cardFolders().length} camera card${cardFolders().length > 1 ? 's' : ''}` : ''}</span>
    </div>
    <div class="row" style="margin-top:8px">
      ${(r.manifests || []).map((m) => `<button class="sm" data-open="${esc(m.json)}">
        Open manifest (${m.file_count} files)</button>`).join('')}
      ${state.plan.targets.map((t) => `<button class="sm" data-reveal="${esc(t.session_path)}">
        Reveal ${esc(t.role)} folder</button>`).join('')}
      <div class="spacer"></div>
      <button class="sm primary" id="btnGoVerify">Compare the copies →</button>
    </div>
  </div>`;
}

/** The session folder on each destination drive. */
function destFolders() {
  return (state.plan ? state.plan.targets : []).map((t) => t.session_path);
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
  return [...new Set([...destFolders(), ...cardFolders()])];
}

function wireCopy() {
  $('btnPlan')?.addEventListener('click', doPlan);
  $('btnReplan')?.addEventListener('click', doPlan);
  // Import a swapped-in card from the Copy step, then rebuild the plan so the new
  // clips appear in their cam folders. After a copy this files them straight into
  // the folders already on disk (buildSpec targets the filed session, no master).
  const importThenReplan = async () => {
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
  $('btnRun')?.addEventListener('click', doRun);
  $('btnGoVerify')?.addEventListener('click', () => {
    state.compareRoots = state.plan.targets.map((t) => t.session_path);
    state.pairVerify = null;
    goStep(4);
  });
  $('btnOpenAll')?.addEventListener('click', async () => {
    const res = await window.api.openFolders(finderTargets());
    if (res.missing && res.missing.length) {
      toast(`${res.opened.length} opened; ${res.missing.length} folder(s) not found `
        + `(a card may have been ejected).`, 'warn');
    } else {
      toast(`Opened ${res.opened.length} Finder window(s).`, 'ok');
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
    state.camCount = Math.max(state.camCount, cam);
    toast(`Added ${added.length} clip(s) to Cam-${String(cam).padStart(2, '0')}.`, 'ok');
    await doPlan();               // rebuild so the review reflects the new clips
  } catch (e) { toast(e.message, 'err'); }
}

async function doPlan() {
  try {
    state.runResult = null;
    // Both SSDs are filed identically, so there is nothing to match up first.
    state.plan = await call('build_plan', buildSpec(), { label: 'Building plan' });
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function doRun() {
  const p = state.plan;
  const renames = (p.renames || []).map((r) => `\n  ${r.from}\n    ↳ ${r.to}`).join('');
  const ok = await window.api.confirm({
    message: p.item_count
      ? `File ${p.item_count} clip(s) and rename the session folder?`
      : 'Rename the session folder?',
    detail:
      'The master moves into the folder on its own drive. Camera clips are copied to '
      + 'both SSDs. Nothing is deleted — clear the cards yourself afterwards.\n' +
      (renames ? `\nFolder rename:${renames}\n` : '') +
      '\nThe folder is renamed only after every file lands successfully.',
    confirmLabel: 'Go ahead',
    danger: false,
  });
  if (!ok) return;
  try {
    state.runResult = await call('execute_plan', { plan: p, write_manifest: true },
      { label: 'Copying' });
    const r = state.runResult;
    if (!r.failed && !r.cancelled) {
      // The masters are filed and the folders named; remember where, so adding a
      // camera afterwards goes straight into these folders without re-detection.
      state.mastersFiled = true;
      for (const t of p.targets) state.filedSessions[t.role] = t.session_path;

      // Clips that landed are done. Drop them from the pool and the assignment so
      // a later card swap does not try to re-plan them from a now-ejected card.
      const filed = new Set((r.items || [])
        .filter((i) => i.kind === 'clip' && (i.status === 'done' || i.status === 'skipped'))
        .map((i) => i.src));
      for (const path of filed) delete state.assign[path];
      for (const key of Object.keys(state.extraFiles)) {
        state.extraFiles[key] = state.extraFiles[key].filter((f) => !filed.has(f.path));
      }
      for (const key of Object.keys(state.scans)) {
        if (state.scans[key] && state.scans[key].files) {
          state.scans[key].files = state.scans[key].files.filter((f) => !filed.has(f.path));
        }
      }
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
    <p class="hint">Checks every clip copied from the camera card${cards.length > 1 ? 's' : ''}
      against the original still on the card — on ${esc(drives.join(' and '))}. If both copies
      match the card, the copy is faithful and the two SSDs are identical. Masters relocated in
      place and are not part of this.</p>
    ${canVerify ? `<div class="note info">
        <b>${checks.length} copy check(s)</b> — ${esc(cards.join(', ') || 'card clips')} →
        ${esc(drives.join(' + '))}. The cards must stay connected for this:</div>
      <div class="row">
        <button class="primary" id="btnVerifyPairs">Verify (size, fast)</button>
        <button class="sm" id="btnVerifyPairsHash">Checksum verify (bit-exact)</button>
      </div>`
      : `<div class="note warn">No camera-card clips were copied, or no copy has run yet.
         Run the copy first.</div>`}
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
                : `${v.mismatched.length} of ${v.checked} copy(ies) do not match the card.`}</b>
      Checked by ${esc(v.algorithm)}.
    </div>
    <div class="scroll" style="max-height:420px"><table>
      <thead><tr><th style="width:1%"></th><th>Clip → drive</th>
        <th class="num">Card</th><th class="num">Copy</th><th>Result</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${v.ok ? `<p class="hint" style="margin:10px 0 0">Each copied clip is identical to its
      camera-card original, so both SSDs are faithful, matching backups.</p>` : ''}
  </div>`;
}

function renderCompareResult() {
  const c = state.compare;
  return c.pairs.map((p) => {
    const errs = p.mismatched.filter((m) => !m.info_only);
    const infos = p.mismatched.filter((m) => m.info_only);
    return `<div class="card">
      <h3>${esc(p.reference.split(/[\\/]/).pop())} ↔ ${esc(p.other.split(/[\\/]/).pop())}</h3>
      <div class="note ${p.ok ? 'ok' : 'err'}">
        <b>${p.ok ? 'These folders match.' : 'Differences found.'}</b>
        ${p.matched} matched · ${p.missing_from_other.length} missing · ${p.extra_in_other.length} extra
        · ${errs.length} mismatched · folder tree ${p.tree_equal ? 'identical' : 'DIFFERENT'}
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
        : `${state.pairVerify.mismatched.length} copy(ies) do not match the card.`,
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
      detail: 'Both copies are read end to end. On large ProRes files over USB this can take '
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
  if (!stepReady(i)) return;
  state.step = i;
  render();
  if (i === 1) detectStructure(primarySource());
  if (i === 2) scanSource(primarySource());
}

function render() {
  $('steps').innerHTML = STEPS.map((s, i) => `
    <li class="${i === state.step ? 'active' : ''} ${!stepReady(i) ? 'disabled' : ''}
        ${i < state.step && stepReady(i) ? 'done' : ''}" data-step="${i}">
      <span class="num">${i + 1}</span><span>${s.label}</span></li>`).join('');
  document.querySelectorAll('[data-step]').forEach((li) =>
    li.addEventListener('click', () => goStep(Number(li.dataset.step))));

  $('stepTitle').textContent = STEPS[state.step].title;
  $('stepHint').textContent = STEPS[state.step].hint;

  $('topActions').innerHTML = `
    ${state.engine.info && !state.engine.info.ffprobe
      ? '<button class="sm" id="btnFindFfprobe">Locate ffprobe</button>' : ''}
    <button class="sm ghost" id="btnRestart">Restart engine</button>`;
  $('btnRestart').addEventListener('click', restartEngine);
  $('btnFindFfprobe')?.addEventListener('click', locateFfprobe);

  $('content').innerHTML = RENDERERS[state.step]();
  WIRERS[state.step]();

  renderFooter();
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
  const prev = state.step > 0;
  const next = state.step < STEPS.length - 1 && stepReady(state.step + 1);
  $('footer').innerHTML = `
    <button id="btnPrev" ${prev ? '' : 'disabled'}>← Back</button>
    <div class="spacer"></div>
    <span class="hint" style="margin:0">${esc(footerHint())}</span>
    <button class="primary" id="btnNext" ${next ? '' : 'disabled'}>Next →</button>`;
  $('btnPrev').addEventListener('click', () => goStep(state.step - 1));
  $('btnNext').addEventListener('click', () => goStep(state.step + 1));
}

function footerHint() {
  switch (state.step) {
    case 0: return state.sources.length ? `${state.sources.length} source(s) selected`
                                        : 'Add at least one source to continue';
    case 1: return chosenMasters().length
      ? `Folder Dur- will read ${fmtDurAuto(masterTotalSeconds())}`
        + (chosenMasters().length > 1 ? ` from ${chosenMasters().length} clips` : '')
      : 'Pick the master clip to continue';
    case 2: {
      const n = Object.values(state.assign).filter((v) => typeof v === 'number').length;
      return n ? `${n} clip(s) assigned` : 'Assign clips to cam folders';
    }
    case 3: return state.runResult ? 'Copy finished' : '';
    default: return '';
  }
}

/* ------------------------------------------------------------------- boot */

window.api.onProgress(({ id, data }) => {
  if (!state.busy || state.busy.id !== id) return;
  const b = state.busy;
  if (data.stage === 'copy') {
    b.percent = data.percent;
    b.detail = data.current || '';
    b.left = `${fmtBytes(data.bytes_done)} of ${fmtBytes(data.bytes_total)}`;
    b.right = data.eta_seconds != null
      ? `${fmtBytes(data.rate_bps)}/s · ${Math.floor(data.eta_seconds / 60)}m ${data.eta_seconds % 60}s left`
      : '';
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
    toast(r.ffprobe ? 'ffprobe set.' : 'That file did not work as ffprobe.', r.ffprobe ? 'ok' : 'err');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

(async function boot() {
  render();
  try {
    const settings = await window.api.getSettings();
    const info = await call('ping');
    state.engine = { ready: true, info, error: null };
    if (settings.ffprobe && !info.ffprobe) await call('configure', { ffprobe: settings.ffprobe });
    $('engineDot').className = 'dot ok';
    $('engineText').textContent = `Engine ready · Python ${info.python}`;
    await rescanVolumes();
  } catch (e) {
    state.engine = { ready: false, info: null, error: e.message };
    $('engineDot').className = 'dot err';
    $('engineText').textContent = 'Engine failed';
    render();
  }
})();

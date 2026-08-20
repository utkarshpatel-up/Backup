'use strict';

/* ------------------------------------------------------------------ state */

const state = {
  step: 0,
  engine: { ready: false, info: null, error: null },
  volumes: [],
  sources: [],          // {path, label, kind, role, report}
  assignment: null,
  scans: {},            // sourcePath -> {files, suggestion}
  pairing: null,
  session: { title: '', jobNumber: '', date: '', destMode: 'inPlace', destRoots: {} },
  assign: {},           // primary file path -> 'master' | cam number | 'skip'
  camCount: 3,
  plan: null,
  runResult: null,
  compare: null,
  deep: null,
  compareRoots: [],
  busy: null,           // {label, id, percent, detail}
};

const STEPS = [
  { key: 'sources', label: 'Sources', title: 'Sources',
    hint: 'Plug in both SSDs. The app probes each one and works out which holds ProRes and which holds H.265.' },
  { key: 'session', label: 'Session', title: 'Session name',
    hint: 'The Dur- token is filled in from the master file automatically.' },
  { key: 'cameras', label: 'Cameras', title: 'Camera assignment',
    hint: 'Choose which clip belongs to which cam. The same choice is mirrored onto the other SSD.' },
  { key: 'copy', label: 'Copy', title: 'Review and copy',
    hint: 'Nothing is written until you press Start. Every rename is listed below first.' },
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
    case 1: return state.sources.length > 0;
    case 2: return state.sources.length > 0 && !!primarySource();
    case 3: return !!Object.values(state.assign).find((v) => v === 'master');
    case 4: return true;
    default: return false;
  }
}

function primarySource() {
  return state.sources.find((s) => s.role === 'prores')
      || state.sources.find((s) => s.role === 'h265')
      || state.sources[0];
}

function secondarySource() {
  const p = primarySource();
  return state.sources.find((s) => s !== p && (s.role === 'prores' || s.role === 'h265'));
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
      <button class="sm" id="btnAddFolder">Add folder…</button>
      <button class="sm" id="btnAddZip">Add zip…</button>
      <div class="spacer"></div>
      <button class="sm primary" id="btnClassify"
        ${state.sources.length ? '' : 'disabled'}>Probe codecs &amp; assign roles</button>
    </div>`);

  if (!state.volumes.length && !state.sources.length) {
    c.push(`<div class="empty"><div class="big">💾</div>
      <div>No drives detected yet.</div>
      <div style="margin-top:4px">Plug in both SSDs and press Rescan — or add a folder or zip by hand.</div>
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
      <button class="sm ${added ? '' : 'primary'}" data-add="${esc(v.path)}"
        data-label="${esc(v.label)}">${added ? 'Added' : 'Use as source'}</button>
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
            ${['prores', 'h265', 'sd', 'other'].map((role) => `
              <button data-role="${role}" data-path="${esc(s.path)}"
                class="${s.role === role ? 'on' : ''}">${
                  { prores: 'ProRes', h265: 'H.265', sd: 'SD card', other: 'Other' }[role]}</button>`).join('')}
          </div>
          <button class="sm ghost" data-remove="${esc(s.path)}">Remove</button>
        </div>
      </div>`);
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

  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () =>
    addSource(b.dataset.add, b.dataset.label, 'volume')));
  document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    state.sources = state.sources.filter((s) => s.path !== b.dataset.remove);
    render();
  }));
  document.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
    const s = state.sources.find((x) => x.path === b.dataset.path);
    if (!s) return;
    // Roles other than "other" are exclusive: two ProRes targets is always a mistake.
    if (b.dataset.role !== 'other') {
      state.sources.forEach((x) => { if (x !== s && x.role === b.dataset.role) x.role = 'other'; });
    }
    s.role = b.dataset.role;
    render();
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
      message: `Extract “${info.label}”?`,
      detail: `${info.video_count} video files, ${fmtBytes(info.uncompressed_bytes)} once extracted.\n` +
              `It will be unpacked to a temporary folder and used as a source.`,
      confirmLabel: 'Extract',
    });
    if (!ok) return;
    const r = await call('extract_zip', { path: zip }, { label: `Extracting ${info.label}` });
    addSource(r.path, info.label, 'zip');
    toast(`Extracted ${info.video_count} clips from ${info.label}`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function classifySources() {
  try {
    const r = await call('classify', { roots: state.sources.map((s) => s.path) },
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
  const master = masterInfo();
  const dur = master ? master.duration : null;
  const date = state.session.date || (master ? master.shoot_iso.slice(0, 10) : '');

  const title = state.session.title.trim() || 'Session title';
  const job = state.session.jobNumber.trim();
  const durLabel = dur != null ? fmtDur(dur) : '…';
  const dateLabel = date ? formatDateToken(date) : '…';

  return `
  <div class="card">
    <h3>Name the session</h3>
    <p class="hint">Type the title exactly as it should read. The date and duration tokens are appended for you.</p>
    <div class="grid2">
      <label class="field"><span>Job number</span>
        <input type="text" id="fJob" value="${esc(state.session.jobNumber)}" placeholder="3017" /></label>
      <label class="field"><span>Shoot date</span>
        <input type="date" id="fDate" value="${esc(date)}" /></label>
    </div>
    <label class="field"><span>Title</span>
      <input type="text" id="fTitle" value="${esc(state.session.title)}"
        placeholder="Adalaj Soneri Satsang Experience session of USA and Canada Satsang Trip, General Satsang E." /></label>
    <div class="preview-name">
      ${job ? `📁 ${esc(job)} <b>Dt-${esc(dateLabel.replace(/-/g, ' ').replace(/ (\d{2})$/, ' 20$1'))}</b><br>` : ''}
      <span class="${job ? 'indent1' : ''}" style="display:inline-block">
        📁 ${esc(title)} <b>Dt-${esc(dateLabel)}</b> <b>Dur-${esc(durLabel)}</b></span>
    </div>
    ${dur == null ? `<div class="note warn" style="margin-top:10px">
       Pick the master file on the Cameras step — the Dur- token comes from it.</div>` : ''}
  </div>

  <div class="card">
    <h3>Where to write</h3>
    <p class="hint">Building the structure on each drive in place is the normal choice — nothing moves between drives.</p>
    <div class="seg" style="margin-bottom:12px">
      <button data-dest="inPlace" class="${state.session.destMode === 'inPlace' ? 'on' : ''}">On each source drive</button>
      <button data-dest="custom" class="${state.session.destMode === 'custom' ? 'on' : ''}">Choose folders</button>
    </div>
    ${state.session.destMode === 'custom' ? state.sources.map((s) => `
      <div class="row" style="margin-bottom:8px">
        <span class="badge ${s.role}">${esc(s.label)}</span>
        <span class="mono" style="flex:1;color:var(--muted)">
          ${esc(state.session.destRoots[s.path] || s.path)}</span>
        <button class="sm" data-dest-pick="${esc(s.path)}">Choose…</button>
      </div>`).join('') : ''}
    <div class="grid2" style="margin-top:6px">
      <label class="field"><span>Transfer mode</span>
        <select id="fMode">
          <option value="copy">Copy (leave originals in place)</option>
          <option value="move">Move (remove originals after verifying)</option>
        </select></label>
      <label class="field"><span>Verification</span>
        <select id="fVerify">
          <option value="size">Size check (fast)</option>
          <option value="hash">Checksum every file (bit-exact, slower)</option>
          <option value="none">None</option>
        </select></label>
    </div>
  </div>`;
}

function formatDateToken(iso) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${M[m - 1]}-${String(y).slice(2)}`;
}

function wireSession() {
  const bind = (id, key) => $(id)?.addEventListener('input', (e) => {
    state.session[key] = e.target.value;
    if (id === 'fTitle' || id === 'fJob') updatePreviewOnly();
    else render();
  });
  bind('fJob', 'jobNumber');
  bind('fTitle', 'title');
  bind('fDate', 'date');
  $('fMode').value = state.session.mode || 'copy';
  $('fVerify').value = state.session.verify || 'size';
  $('fMode')?.addEventListener('change', (e) => { state.session.mode = e.target.value; });
  $('fVerify')?.addEventListener('change', (e) => { state.session.verify = e.target.value; });

  document.querySelectorAll('[data-dest]').forEach((b) => b.addEventListener('click', () => {
    state.session.destMode = b.dataset.dest; render();
  }));
  document.querySelectorAll('[data-dest-pick]').forEach((b) => b.addEventListener('click', async () => {
    const p = await window.api.pickFolder('Choose a destination folder');
    if (p) { state.session.destRoots[b.dataset.destPick] = p; render(); }
  }));
}

/** Re-render only the name preview, so typing does not steal focus. */
function updatePreviewOnly() {
  const master = masterInfo();
  const date = state.session.date || (master ? master.shoot_iso.slice(0, 10) : '');
  const box = document.querySelector('.preview-name');
  if (!box || !date) return;
  const job = state.session.jobNumber.trim();
  const title = state.session.title.trim() || 'Session title';
  const durLabel = master && master.duration != null ? fmtDur(master.duration) : '…';
  box.innerHTML =
    (job ? `📁 ${esc(job)} <b>Dt-${esc(formatDateToken(date).replace(/-/g, ' ').replace(/ (\d{2})$/, ' 20$1'))}</b><br>` : '') +
    `<span class="${job ? 'indent1' : ''}" style="display:inline-block">📁 ${esc(title)} ` +
    `<b>Dt-${esc(formatDateToken(date))}</b> <b>Dur-${esc(durLabel)}</b></span>`;
}

/* ------------------------------------------------------------ step: cameras */

function masterInfo() {
  const src = primarySource();
  if (!src || !state.scans[src.path]) return null;
  const path = Object.keys(state.assign).find((p) => state.assign[p] === 'master');
  return state.scans[src.path].files.find((f) => f.path === path) || null;
}

function renderCameras() {
  const src = primarySource();
  if (!src) return `<div class="empty"><div class="big">📁</div>Add a source first.</div>`;

  const scan = state.scans[src.path];
  if (!scan) {
    return `<div class="card">
      <h3>Read the footage</h3>
      <p class="hint">Every video on <span class="mono">${esc(src.label)}</span> is probed for
      duration, codec and last-modified time. Large cards take a moment.</p>
      <button class="primary" id="btnScan">Scan ${esc(src.label)}</button>
    </div>`;
  }

  const cams = Array.from({ length: state.camCount }, (_, i) => i + 1);
  const counts = {};
  cams.forEach((n) => { counts[n] = 0; });
  let masterCount = 0, skipped = 0;
  for (const f of scan.files) {
    const a = state.assign[f.path];
    if (a === 'master') masterCount++;
    else if (a === 'skip' || a === undefined) skipped++;
    else counts[a] = (counts[a] || 0) + 1;
  }

  const rows = scan.files.map((f) => {
    const a = state.assign[f.path] ?? 'skip';
    return `<tr>
      <td><div style="font-weight:600">${esc(f.name)}</div>
          <div class="hint" style="margin:0">${esc(f.width || '?')}×${esc(f.height || '?')}
          @ ${esc(f.fps ?? '?')} · <span class="badge ${f.family}">${esc(f.video_codec || '?')}</span></div></td>
      <td class="num">${esc(fmtClock(f.duration))}</td>
      <td>${esc(fmtTime(f.shoot_iso))}</td>
      <td class="num">${fmtBytes(f.size)}</td>
      <td><div class="seg">
        <button class="${a === 'master' ? 'on master' : ''}" data-assign="master" data-file="${esc(f.path)}">Master</button>
        ${cams.map((n) => `<button class="${a === n ? 'on' : ''}" data-assign="${n}"
           data-file="${esc(f.path)}">${n}</button>`).join('')}
        <button class="${a === 'skip' ? 'on skip' : ''}" data-assign="skip" data-file="${esc(f.path)}">Skip</button>
      </div></td>
    </tr>`;
  }).join('');

  const sec = secondarySource();
  const pairInfo = state.pairing
    ? (state.pairing.unmatched_primary.length
        ? `<div class="note warn"><b>${state.pairing.unmatched_primary.length} file(s)
             have no twin</b> on ${esc(sec ? sec.label : 'the other drive')} and will be copied
             to that drive's structure only if a match is found.
             ${esc(state.pairing.unmatched_primary.map((p) => p.split(/[\\/]/).pop()).join(', '))}</div>`
        : `<div class="note ok">All ${Object.keys(state.pairing.matches).length} files matched
             to their twin on ${esc(sec ? sec.label : 'the other drive')}.</div>`)
    : (sec ? `<div class="note info">Press <b>Mirror to ${esc(sec.label)}</b> to match these files
              against the other drive.</div>` : '');

  return `
  <div class="card">
    <h3>Assign clips to cameras</h3>
    <p class="hint">Exactly one file must be the <b>Master</b> — it sets the session's Dur- token.
      Everything marked with a number lands in that Cam folder. Skipped files are not copied.</p>
    <div class="row" style="margin-bottom:12px">
      <button class="sm" id="btnAutoGroup">Auto-suggest by camera</button>
      <button class="sm" id="btnLongestMaster">Longest file = master</button>
      <button class="sm" id="btnAddCam">Add cam (${state.camCount})</button>
      <button class="sm" id="btnRemoveCam" ${state.camCount <= 1 ? 'disabled' : ''}>Remove cam</button>
      <button class="sm" id="btnClearAssign">Clear all</button>
      <div class="spacer"></div>
      ${sec ? `<button class="sm primary" id="btnMirror">Mirror to ${esc(sec.label)}</button>` : ''}
      <button class="sm ghost" id="btnRescanFiles">Re-scan</button>
    </div>
    <div class="row" style="margin-bottom:6px">
      <span class="badge ${masterCount === 1 ? 'ok' : 'warn'}">Master: ${masterCount}</span>
      ${cams.map((n) => `<span class="badge">Cam-${String(n).padStart(2, '0')}: ${counts[n] || 0}</span>`).join('')}
      <span class="badge">Skipped: ${skipped}</span>
    </div>
    ${pairInfo}
    <div class="scroll"><table>
      <thead><tr><th>File</th><th class="num">Length</th><th>Last modified</th>
        <th class="num">Size</th><th style="width:1%">Goes to</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function wireCameras() {
  $('btnScan')?.addEventListener('click', () => scanSource(primarySource()));
  $('btnRescanFiles')?.addEventListener('click', () => scanSource(primarySource(), true));

  document.querySelectorAll('[data-assign]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.assign;
    if (v === 'master') {
      // Only one master per session; clear any previous choice.
      for (const k of Object.keys(state.assign)) {
        if (state.assign[k] === 'master') state.assign[k] = 'skip';
      }
      state.assign[b.dataset.file] = 'master';
    } else {
      state.assign[b.dataset.file] = v === 'skip' ? 'skip' : Number(v);
    }
    state.plan = null;
    render();
  }));

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

  $('btnLongestMaster')?.addEventListener('click', () => {
    const files = state.scans[primarySource().path].files;
    const longest = files.reduce((a, b) =>
      ((b.duration || 0) > (a?.duration || 0) ? b : a), null);
    if (!longest) return;
    Object.keys(state.assign).forEach((k) => {
      if (state.assign[k] === 'master') state.assign[k] = 'skip';
    });
    state.assign[longest.path] = 'master';
    toast(`Master set to ${longest.name} (${fmtDur(longest.duration)})`, 'ok');
    render();
  });

  $('btnAutoGroup')?.addEventListener('click', () => {
    const scan = state.scans[primarySource().path];
    const master = Object.keys(state.assign).find((k) => state.assign[k] === 'master');
    let cam = 0;
    for (const g of scan.suggestion.groups) {
      cam++;
      for (const f of g.files) {
        if (f.path === master) continue;
        state.assign[f.path] = cam;
      }
    }
    state.camCount = Math.max(state.camCount, cam);
    toast(`Grouped by ${scan.suggestion.basis} into ${cam} cam(s). Check before copying.`);
    render();
  });

  $('btnMirror')?.addEventListener('click', mirrorToSecondary);
}

async function scanSource(src, force = false) {
  if (!src || (state.scans[src.path] && !force)) return;
  try {
    const r = await call('scan', { root: src.path }, { label: `Reading ${src.label}` });
    state.scans[src.path] = r;
    if (!r.files.length) toast(`No video files found on ${src.label}.`, 'err');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function mirrorToSecondary() {
  const a = primarySource(), b = secondarySource();
  if (!a || !b) return;
  try {
    if (!state.scans[b.path]) await scanSource(b);
    state.pairing = await call('pair', {
      primary: state.scans[a.path].files,
      secondary: state.scans[b.path].files,
    }, { label: `Matching against ${b.label}` });
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/* --------------------------------------------------------------- step: copy */

function buildSpec() {
  const a = primarySource(), b = secondarySource();
  const master = masterInfo();
  const targets = [];

  const camsFor = (mapPath) => {
    const cams = {};
    for (const [p, v] of Object.entries(state.assign)) {
      if (v === 'skip' || v === 'master' || v === undefined) continue;
      const mapped = mapPath(p);
      if (!mapped) continue;
      (cams[v] = cams[v] || []).push(mapped);
    }
    return cams;
  };

  const destFor = (s) => (state.session.destMode === 'custom'
    ? (state.session.destRoots[s.path] || s.path) : s.path);

  targets.push({
    role: a.role, source_root: a.path, dest_root: destFor(a),
    master: master ? master.path : null, cams: camsFor((p) => p),
  });

  if (b && state.pairing) {
    const m = state.pairing.matches;
    targets.push({
      role: b.role, source_root: b.path, dest_root: destFor(b),
      master: master ? (m[master.path] || null) : null,
      cams: camsFor((p) => m[p] || null),
    });
  }

  return {
    title: state.session.title,
    job_number: state.session.jobNumber,
    date: state.session.date || undefined,
    mode: state.session.mode || 'copy',
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
      <h3><span class="badge ${t.role}">${esc(t.role)}</span> ${esc(t.session_folder.slice(0, 60))}…</h3>
      <p class="hint">${esc(t.dest_root)} · ${t.items.length} files ·
        ${fmtBytes(t.total_bytes)} · ${fmtBytes(t.free_bytes)} free</p>
      ${t.warnings.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}
      <div class="tree">
        ${t.job_folder ? `<div class="dir">📁 ${esc(t.job_folder)}</div>` : ''}
        <div class="dir ${t.job_folder ? 'indent1' : ''}">📁 ${esc(t.session_folder)}</div>
        ${t.items.filter((i) => i.kind === 'master').map((i) => `
          <div class="ren indent2">🎬 ${esc(i.original_name)} → <b>${esc(i.dst.split(/[\\/]/).pop())}</b></div>`).join('')}
        <div class="dir indent2">📁 Clips for Insert</div>
        ${camGroups(t)}
      </div>
    </div>`).join('');

  const status = state.runResult ? renderRunResult() : '';

  return `
    ${p.warnings.length ? `<div class="note warn"><b>${p.warnings.length} warning(s)</b>
       — review the details on each drive below.</div>` : ''}
    <div class="card">
      <div class="row">
        <div><b>${p.item_count} files</b> · ${fmtBytes(p.total_bytes)} total ·
          mode <b>${esc(p.mode)}</b> · verify <b>${esc(p.verify)}</b></div>
        <div class="spacer"></div>
        <button class="sm" id="btnReplan">Rebuild plan</button>
        <button class="primary" id="btnRun" ${state.busy ? 'disabled' : ''}>
          ${state.runResult ? 'Run again' : 'Start copy'}</button>
      </div>
    </div>
    ${status}
    ${trees}`;
}

function camGroups(t) {
  const byCam = {};
  t.items.filter((i) => i.kind === 'clip').forEach((i) => {
    (byCam[i.cam] = byCam[i.cam] || []).push(i);
  });
  return Object.keys(byCam).sort((a, b) => a - b).map((cam) => `
    <div class="dir indent3">📁 Cam-${String(cam).padStart(2, '0')}</div>
    ${byCam[cam].map((i) => `<div class="ren indent3" style="padding-left:72px">
      ${esc(i.original_name)} → <b>${esc(i.dst.split(/[\\/]/).pop())}</b>
      <span style="color:var(--muted)">· ${fmtBytes(i.size)}</span></div>`).join('')}`).join('');
}

function renderRunResult() {
  const r = state.runResult;
  const kind = r.failed ? 'err' : r.cancelled ? 'warn' : 'ok';
  return `<div class="card">
    <div class="note ${kind}">
      <b>${r.cancelled ? 'Cancelled.' : r.failed ? 'Finished with errors.' : 'Copy complete.'}</b>
      ${r.copied} copied, ${r.skipped} already present, ${r.failed} failed ·
      ${fmtBytes(r.bytes)} in ${r.seconds}s
      ${r.seconds > 0 ? `(${fmtBytes(r.bytes / r.seconds)}/s)` : ''}
    </div>
    ${r.errors.map((e) => `<div class="note err mono">${esc(e)}</div>`).join('')}
    <div class="row">
      ${(r.manifests || []).map((m) => `<button class="sm" data-open="${esc(m.json)}">
        Open manifest (${m.file_count} files)</button>`).join('')}
      ${state.plan.targets.map((t) => `<button class="sm" data-reveal="${esc(t.session_path)}">
        Reveal ${esc(t.role)} folder</button>`).join('')}
      <div class="spacer"></div>
      <button class="sm primary" id="btnGoVerify">Compare the copies →</button>
    </div>
  </div>`;
}

function wireCopy() {
  $('btnPlan')?.addEventListener('click', doPlan);
  $('btnReplan')?.addEventListener('click', doPlan);
  $('btnRun')?.addEventListener('click', doRun);
  $('btnGoVerify')?.addEventListener('click', () => {
    state.compareRoots = state.plan.targets.map((t) => t.session_path);
    goStep(4);
  });
  document.querySelectorAll('[data-reveal]').forEach((b) =>
    b.addEventListener('click', () => window.api.reveal(b.dataset.reveal)));
  document.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => window.api.open(b.dataset.open)));
}

async function doPlan() {
  try {
    state.runResult = null;
    state.plan = await call('build_plan', buildSpec(), { label: 'Building plan' });
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function doRun() {
  const p = state.plan;
  const ok = await window.api.confirm({
    message: p.mode === 'move'
      ? `Move ${p.item_count} files into the new structure?`
      : `Copy ${p.item_count} files (${fmtBytes(p.total_bytes)})?`,
    detail: p.mode === 'move'
      ? 'Originals are deleted from the source once each file verifies. This cannot be undone.'
      : 'Originals stay where they are. Existing, matching files are skipped.',
    confirmLabel: p.mode === 'move' ? 'Move files' : 'Start copy',
    danger: p.mode === 'move',
  });
  if (!ok) return;
  try {
    state.runResult = await call('execute_plan', { plan: p, write_manifest: true },
      { label: 'Copying' });
    const r = state.runResult;
    toast(r.failed ? `${r.failed} file(s) failed.` : `Copied ${r.copied} files.`,
      r.failed ? 'err' : 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
}

/* ------------------------------------------------------------- step: verify */

function renderVerify() {
  const roots = state.compareRoots;
  const rows = roots.map((r, i) => `
    <div class="row" style="margin-bottom:8px">
      <span class="badge ${i === 0 ? 'ok' : ''}">${i === 0 ? 'Reference' : `Copy ${i}`}</span>
      <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(r)}</span>
      <button class="sm ghost" data-drop-root="${i}">Remove</button>
    </div>`).join('');

  return `
  <div class="card">
    <h3>Folders to compare</h3>
    <p class="hint">The first folder is the reference. Add the ProRes session folder, the H.265
      session folder, and the SD card if you still have it.</p>
    ${rows || '<div class="hint">Nothing added yet.</div>'}
    <div class="row" style="margin-top:10px">
      <button class="sm" id="btnAddCompare">Add folder…</button>
      <div class="spacer"></div>
      <button class="primary" id="btnCompare" ${roots.length < 2 ? 'disabled' : ''}>
        Compare (fast)</button>
      <button class="sm" id="btnDeep" ${roots.length < 2 ? 'disabled' : ''}>
        Checksum verify…</button>
    </div>
  </div>
  ${state.compare ? renderCompareResult() : ''}
  ${state.deep ? renderDeepResult() : ''}`;
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
    case 1: return state.session.title.trim() ? '' : 'A title is recommended before copying';
    case 2: return masterInfo() ? `Master: ${masterInfo().name}` : 'Mark one file as Master to continue';
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

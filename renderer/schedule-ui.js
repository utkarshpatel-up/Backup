'use strict';

/* Event schedule: the app's first page, where a backup usually starts. The
 * schedule is read offline (OCR for pictures and PDFs, the engine for
 * Word/Excel/CSV), drafted into master rows by schedule-logic.js and corrected
 * by the operator. Each row can start its own backup — the row stands in for a
 * structure zip, giving the job and session folder names and the camera
 * folders — and when that backup finishes, the row's duration, clip and camera
 * counts are read back from the folder it filed. The rows are saved as an .xlsx
 * in the Raw Satsang Master's layout.
 *
 * Every schedule read is an "assignment" kept on disk (schedules.json) until the
 * operator deletes it. One is open at a time; Close puts it with the past ones,
 * from where it can be opened and edited again.
 * Uses app.js's shared state, render(), call(), toast() and the backup steps. */

const SCHEDULE = window.VIngestSchedule;
const SCHEDULE_VOCAB = window.VIngestScheduleVocab || {};
const SCHEDULE_PICTURES = ['png', 'jpg', 'jpeg'];
const SCHEDULE_TABLES = ['docx', 'xlsx', 'xlsm', 'csv'];
const SCHEDULE_DEFAULTS = { author: 'DD', format: 'HD', camsFormal: 3, camsInformal: 1 };
// Fields that live only while the app runs, never written to disk.
const SCHEDULE_RUNTIME = ['busy', 'error', 'showSource', 'memory', 'undo'];

/** The city list: an imported one, or the one built into the app. */
function scheduleCities() {
  if (!state.cities) state.cities = SCHEDULE.parseCities(window.VIngestCityRows || []);
  return state.cities;
}

/* ------------------------------------------------------- assignments */

const newScheduleId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** "15/10/2026 – 03/11/2026": the first and last day a schedule holds. */
function scheduleRange(item) {
  const days = (item.sessions || []).map(SCHEDULE.sessionDay).filter(Boolean).sort();
  if (!days.length) return String(item.file || 'Empty schedule').split(/[\\/]/).pop();
  const a = SCHEDULE.toIndian(days[0]), b = SCHEDULE.toIndian(days[days.length - 1]);
  return a === b ? a : `${a} – ${b}`;
}

/** Give a stored assignment the fields the page works with. */
function scheduleHydrate(item, settings = {}) {
  item.busy = null;
  item.error = null;
  item.showSource = false;
  item.memory = settings.scheduleMemory || { titles: [], places: [] };
  item.rows = item.rows || [];
  item.sessions = item.sessions || [];
  item.starts = item.starts || {};
  item.defaults = { ...SCHEDULE_DEFAULTS, ...(settings.scheduleDefaults || {}), ...(item.defaults || {}) };
  return item;
}

/** Load the assignments (and an imported city list) when the app starts. */
async function restoreSchedules(settings) {
  let store = await window.api.getStore('schedules').catch(() => null);
  if (!store || !Array.isArray(store.items)) {
    store = { openId: null, items: [] };
    // The single schedule earlier versions kept in settings becomes the first assignment.
    const d = settings && settings.scheduleDraft;
    if (d && Array.isArray(d.sessions) && d.sessions.length) {
      const item = { id: newScheduleId(), created: new Date().toISOString(), file: d.file || '',
        rows: d.rows || [], read: d.read || null, sessions: d.sessions, starts: d.starts || {},
        defaults: d.defaults || {}, scan: d.scan || null, saved: d.saved || null };
      store = { openId: item.id, items: [item] };
    }
  }
  store.items.forEach((item) => scheduleHydrate(item, settings));
  state.schedules = store;
  state.schedule = store.items.find((x) => x.id === store.openId) || null;
  if (settings && settings.colWidths) state.colWidths = { schedule: {}, report: {}, ...settings.colWidths };
  const cities = await window.api.getStore('cities').catch(() => null);
  if (cities && Array.isArray(cities.rows)) {
    state.cities = SCHEDULE.parseCities(cities.rows);
    state.citySource = cities.file || 'imported';
  }
  if (settings && settings.scheduleDraft) {
    scheduleRemember();
    window.api.setSettings({ scheduleDraft: null }).catch(() => {});
  }
}

let scheduleRememberTimer = null;
/** Write every assignment to disk: a backup day spans many app sessions. */
function scheduleRemember() {
  clearTimeout(scheduleRememberTimer);
  scheduleRememberTimer = setTimeout(() => {
    const all = state.schedules || { openId: null, items: [] };
    const items = all.items.filter((x) => !x.busy).map((x) => {
      const out = { ...x };
      for (const k of SCHEDULE_RUNTIME) delete out[k];
      if (out.read) out.read = { skipped: out.read.skipped || [] };
      return out;
    });
    window.api.setStore('schedules', { openId: state.schedule ? state.schedule.id : null, items }).catch(() => {});
  }, 400);
}

async function openSchedule(file) {
  if (state.schedule && state.schedule.busy) return;
  if (state.schedule && !await window.api.confirm({
    message: `Close the schedule ${scheduleRange(state.schedule)} and read a new one?`,
    detail: 'It is kept under Past schedules, with everything in it, until you delete it.',
    confirmLabel: 'Close and continue', danger: false,
  })) return;
  const path = file || await window.api.pickSchedule();
  if (!path) return;
  const settings = await window.api.getSettings().catch(() => ({}));
  const prev = state.schedule;
  const item = scheduleHydrate({
    id: newScheduleId(), created: new Date().toISOString(), file: path, rows: [], read: null,
    sessions: [], scan: null, saved: null,
    starts: { ...(settings.scheduleStarts || {}) },
    defaults: prev ? { ...prev.defaults } : {},
  }, settings);
  item.busy = 'Reading the schedule…';
  if (!state.schedules) state.schedules = { openId: null, items: [] };
  state.schedules.items.unshift(item);
  state.schedule = item;
  state.view = 'schedule';
  render();
  await readSchedule();
}

/** PDF pages as PNG data URLs, rendered with pdf.js in this window. */
async function schedulePdfPages(path) {
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '../node_modules/pdfjs-dist/build/pdf.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('The PDF reader could not be loaded.'));
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.min.js';
  }
  const bytes = await window.api.readScheduleFile(path);
  const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
  const pages = [];
  for (let n = 1; n <= Math.min(pdf.numPages, 10); n++) {
    const page = await pdf.getPage(n);
    // About 2000 px wide: the size the poster pictures OCR well at.
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, Math.max(1, 2000 / base.width)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    pages.push(canvas.toDataURL('image/png'));
  }
  return pages;
}

function scheduleError(e) {
  // ipcRenderer.invoke wraps the message: "Error invoking remote method 'x': Error: …"
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

async function readSchedule() {
  const s = state.schedule;
  const ext = String(s.file).split('.').pop().toLowerCase();
  try {
    let rows = [];
    if (SCHEDULE_PICTURES.includes(ext)) {
      rows = (await window.api.ocrScheduleFile(s.file)).rows;
    } else if (ext === 'pdf') {
      const pages = await schedulePdfPages(s.file);
      for (let i = 0; i < pages.length; i++) {
        s.busy = `Reading page ${i + 1} of ${pages.length}…`;
        render();
        rows.push(...(await window.api.ocrScheduleImage(pages[i])).rows);
      }
    } else if (SCHEDULE_TABLES.includes(ext)) {
      rows = (await call('schedule_read_table', { path: s.file })).rows;
    } else {
      throw new Error(`Can't read .${ext} files — use a JPG/PNG picture, PDF, Word, Excel or CSV schedule.`);
    }
    s.rows = rows;
    s.read = SCHEDULE.readRows(rows);
    s.sessions = SCHEDULE.draftSessions(s.read, s.memory, s.defaults);
    // A city the list knows: remember its record, so Geolocation fills in.
    for (const row of s.sessions) {
      const c = SCHEDULE.cityOf(row, scheduleCities());
      if (c) row.geo = c.name;
    }
    if (!s.sessions.length) {
      s.error = 'No dated sessions were found in this schedule. Check "What was read" below — '
        + 'a photo taken at an angle reads worse than the original picture.';
      s.showSource = true;
    }
  } catch (e) {
    s.error = scheduleError(e);
  } finally {
    s.busy = null;
    scheduleRemember();
    render();
  }
}

/** Close the open schedule; it stays under Past schedules, ready to open again. */
function closeSchedule() {
  state.schedule = null;
  scheduleRemember();
  render();
}

function reopenSchedule(id) {
  const item = state.schedules.items.find((x) => x.id === id);
  if (!item) return;
  state.schedule = item;
  scheduleRemember();
  render();
}

async function deleteSchedule(id) {
  const item = state.schedules.items.find((x) => x.id === id);
  if (!item) return;
  const done = item.sessions.filter((r) => r.backedUp).length;
  if (!await window.api.confirm({
    message: `Delete the schedule ${scheduleRange(item)}?`,
    detail: `Its ${item.sessions.length} session row${item.sessions.length === 1 ? '' : 's'}`
      + `${done ? ` (${done} backed up)` : ''} are removed from the app for good. `
      + 'Saved .xlsx files and the backed-up folders are not touched.',
    confirmLabel: 'Delete', danger: true,
  })) return;
  state.schedules.items = state.schedules.items.filter((x) => x !== item);
  if (state.schedule === item) state.schedule = null;
  if (state.scheduleRun && state.scheduleRun.scheduleId === id) state.scheduleRun = null;
  scheduleRemember();
  render();
}

/* ------------------------------------------------------------ editing */

const scheduleFind = (key, s = state.schedule) => s.sessions.find((x) => x.key === Number(key));
const listText = (a) => (a || []).join(', ');
const listOf = (t) => String(t || '').split(',').map((x) => x.trim()).filter(Boolean);

// Redraw once the keyboard has moved on: a cell's change fires as Tab leaves it,
// before the focus reaches the next cell, and redrawing then would drop the
// focus (and the page's scroll) back at the top.
let scheduleRenderTimer = null;
function scheduleRerender() {
  clearTimeout(scheduleRenderTimer);
  scheduleRenderTimer = setTimeout(render, 0);
}

/** A new year, month or day typed into one part of a row's date. */
function scheduleDatePart(row, part, value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.date || '') || [null, '', '', ''];
  const parts = { y: m[1], m: m[2], d: m[3] };
  const v = String(value).trim();
  parts[part] = part === 'y' ? v : v.padStart(2, '0');
  return `${parts.y}-${parts.m}-${parts.d}`;
}

function scheduleSet(key, field, value) {
  const row = scheduleFind(key);
  if (!row) return;
  if (field === 'include') row.include = !!value;
  else if (field === 'events' || field === 'languages') row[field] = listOf(value);
  else if (field === 'folder' || field === 'session') row[field] = String(value).trim().toUpperCase() || null;
  else if (field === 'camPlan') row.camPlan = String(value).trim() === '' ? null : Number(value);
  else if (field === 'y' || field === 'm' || field === 'd') row.date = scheduleDatePart(row, field, value);
  else if (field === 'city') {
    // The city list offers the record ID where several cities share a name.
    const c = SCHEDULE.findCity(value, scheduleCities());
    row.city = c ? c.city : String(value).trim();
    row.geo = c ? c.name : null;
  } else row[field] = typeof value === 'string' ? value.trim() : value;
  const flagged = ['y', 'm', 'd'].includes(field) ? 'date' : field;
  if (flagged === 'session' || flagged === 'date') delete row.flags.session;
  delete row.flags[flagged];
  state.schedule.saved = null;
  scheduleRemember();
  scheduleRerender();
}

/**
 * An unplanned session, not on the schedule, added by hand below row `key` (or
 * at the end): it keeps that row's day, type, place and event, since an extra
 * session is usually held where the planned one was; its topic is left blank.
 */
function scheduleAddRow(key) {
  const s = state.schedule;
  const i = key == null ? s.sessions.length - 1 : s.sessions.findIndex((x) => x.key === Number(key));
  const like = s.sessions[i];
  const copy = like ? JSON.parse(JSON.stringify(like)) : {
    include: true, date: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
    start: null, end: null, hint: null, type: 'Formal', activity: '', place: '', city: '',
    events: [], languages: [], author: s.defaults.author || 'DD', format: s.defaults.format || 'HD',
    folder: null, camPlan: null,
  };
  copy.key = s.sessions.reduce((m, x) => Math.max(m, x.key), 0) + 1;
  copy.include = true;
  copy.session = null;
  copy.topic = '';
  copy.title = ''; copy.subtitle = ''; copy.placeText = ''; copy.source = 'Unplanned — added by hand';
  copy.duration = ''; copy.clips = ''; copy.cameras = ''; copy.backedUp = null;
  copy.flags = {
    session: 'Unplanned session added by hand — set M/E or the session number.',
    topic: 'Unplanned session — fill in what it was about.',
  };
  s.sessions.splice(i + 1, 0, copy);
  s.saved = null;
  scheduleRemember();
  render();
  scheduleFocusRow(copy.key);
}

/**
 * Remove rows from the open schedule. The last removal can be undone (until the
 * next one), so a slip costs nothing; a row that was already backed up asks first.
 */
async function scheduleDeleteRows(keys) {
  const s = state.schedule;
  const want = new Set(keys.map(Number));
  const rows = s.sessions.filter((r) => want.has(r.key));
  if (!rows.length) return;
  const done = rows.filter((r) => r.backedUp).length;
  if (done && !await window.api.confirm({
    message: `Delete ${rows.length === 1 ? 'a session that was' : `${rows.length} rows, ${done} of them`} backed up already?`,
    detail: 'The row leaves the schedule; the backed-up folder on the drive is not touched.',
    confirmLabel: 'Delete', danger: true,
  })) return;
  const at = rows.map((r) => ({ row: r, index: s.sessions.indexOf(r) }));
  s.sessions = s.sessions.filter((r) => !want.has(r.key));
  if (state.scheduleRun && state.scheduleRun.scheduleId === s.id && want.has(state.scheduleRun.key)) state.scheduleRun = null;
  s.undo = { at, label: rows.length === 1 ? `Deleted the ${SCHEDULE.toIndian(rows[0].date)} row.` : `Deleted ${rows.length} rows.` };
  s.saved = null;
  scheduleRemember();
  render();
}

function scheduleUndoDelete() {
  const s = state.schedule;
  if (!s.undo) return;
  for (const { row, index } of s.undo.at.sort((a, b) => a.index - b.index)) {
    s.sessions.splice(Math.min(index, s.sessions.length), 0, row);
  }
  s.undo = null;
  scheduleRemember();
  render();
}

function scheduleTickAll(on) {
  for (const row of state.schedule.sessions) row.include = on;
  state.schedule.saved = null;
  scheduleRemember();
  render();
}

/** Put the keyboard on a row's tick box: ↑/↓ then move between rows, Space ticks. */
function scheduleFocusRow(key) {
  const box = $('content').querySelector(`.sch-table input[type=checkbox][data-k="${key}"]`);
  if (!box) return;
  box.focus({ preventScroll: true });
  box.closest('tr').scrollIntoView({ block: 'nearest' });
}

/** The page's and table's scroll and the focused field, kept across a redraw. */
function scheduleSnapshot() {
  const el = document.activeElement;
  const field = el && el.dataset && el.id ? { id: el.id }
    : el && el.dataset && el.dataset.k && el.dataset.f ? { k: el.dataset.k, f: el.dataset.f }
      : el && el.dataset && el.dataset.col ? { col: el.dataset.col }
        : el && el.dataset && el.dataset.filter ? { filter: el.dataset.filter } : null;
  let caret = null;
  try { caret = el && typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null; } catch (_) { /* not text */ }
  const table = document.querySelector('.sch-scroll');
  const c = $('content');
  return { field, caret, top: table ? table.scrollTop : 0, left: table ? table.scrollLeft : 0,
    page: c.scrollTop, pageLeft: c.scrollLeft };
}

function scheduleRestore(snap) {
  const table = document.querySelector('.sch-scroll');
  if (table) { table.scrollTop = snap.top; table.scrollLeft = snap.left; }
  const c = $('content');
  c.scrollTop = snap.page;
  c.scrollLeft = snap.pageLeft;
  const f = snap.field;
  if (!f) return;
  const el = f.id ? $(f.id)
    : f.col ? c.querySelector(`[data-col="${f.col}"]`)
      : f.filter ? c.querySelector(`[data-filter="${f.filter}"]`)
      : c.querySelector(`[data-k="${f.k}"][data-f="${f.f}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (snap.caret && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(snap.caret[0], snap.caret[1]); } catch (_) { /* not text */ }
  }
}

function scheduleApplyDefaults() {
  const s = state.schedule;
  s.defaults.author = $('schAuthor').value.trim() || 'DD';
  s.defaults.format = $('schFormat').value;
  for (const row of s.sessions) { row.author = s.defaults.author; row.format = s.defaults.format; }
  window.api.setSettings({ scheduleDefaults: s.defaults }).catch(() => {});
  scheduleRemember();
  render();
}

/** Problems that would make Frappe refuse a row, plus the drafting notes, per row and field. */
function scheduleProblems() {
  const s = state.schedule;
  const found = SCHEDULE.check(s.sessions, s.starts, SCHEDULE_VOCAB, scheduleCities());
  for (const row of s.sessions) {
    if (!row.include) continue;
    const mine = found.get(row.key) || {};
    for (const [field, msg] of Object.entries(row.flags || {})) {
      if (!mine[field]) mine[field] = { msg, hard: false };
    }
    if (Object.keys(mine).length) found.set(row.key, mine);
  }
  return found;
}

const hardOf = (problems) => Object.values(problems || {}).filter((p) => p.hard);
/** Red problems that stop a backup starting — all but the duration, which the backup supplies. */
const blocksStart = (problems) => hardOf(problems).filter((p) => !p.after);

async function scheduleFillFromDrive() {
  const s = state.schedule;
  const root = await window.api.pickFolder('Choose the drive or folder holding this event\'s filed sessions');
  if (!root) return;
  try {
    const res = await call('schedule_scan', { root }, { label: 'Reading session durations' });
    const r = SCHEDULE.applyScan(s.sessions, s.starts, res.sessions);
    for (const row of r.missing) {
      if (row.include) row.flags.duration = 'No folder for this session on the drive.';
    }
    s.scan = { root: res.root, filled: r.filled, missing: r.missing.filter((x) => x.include).length };
    toast(`Filled ${r.filled} session${r.filled === 1 ? '' : 's'} from the drive`
      + (s.scan.missing ? `; ${s.scan.missing} not found` : '') + '.', s.scan.missing ? 'warn' : 'ok');
  } catch (e) {
    toast(scheduleError(e), 'err');
  }
  scheduleRemember();
  render();
}

/** Replace the built-in city list with a newer export of Frappe's City doctype. */
async function scheduleImportCities() {
  const file = await window.api.pickTable('Choose the city list exported from Frappe (ID, City Name, State, Country)');
  if (!file) return;
  try {
    const rows = (await call('schedule_read_table', { path: file })).rows;
    const cities = SCHEDULE.parseCities(rows);
    if (!cities.length) throw new Error('No City column was found in that file.');
    await window.api.setStore('cities', { file, rows });
    state.cities = cities;
    state.citySource = file;
    // Rows whose city the new list knows get its record.
    for (const item of (state.schedules || { items: [] }).items) {
      for (const row of item.sessions) {
        const c = SCHEDULE.cityOf(row, cities);
        row.geo = c ? c.name : null;
      }
    }
    scheduleRemember();
    toast(`City list updated: ${cities.length} cities.`, 'ok');
  } catch (e) {
    toast(scheduleError(e), 'err');
  }
  render();
}

async function scheduleSave() {
  const s = state.schedule;
  const rows = SCHEDULE.sheetRows(s.sessions, s.starts, scheduleCities());
  if (!rows.length) { toast('Tick at least one session to save.', 'warn'); return; }
  // Red cells are what Frappe's import would refuse. They warn, they don't
  // block: a working copy with gaps is often exactly what is wanted.
  const problems = scheduleProblems();
  const red = s.sessions.filter((r) => r.include && blocksStart(problems.get(r.key)).length);
  const noDuration = s.sessions.filter((r) => r.include && !blocksStart(problems.get(r.key)).length
    && hardOf(problems.get(r.key)).length).length;
  if (red.length || noDuration) {
    const reasons = [...new Set(red.flatMap((r) => blocksStart(problems.get(r.key)).map((p) => p.msg)))];
    const lines = [];
    if (red.length) {
      lines.push(`${red.length} row${red.length === 1 ? ' has' : 's have'} a red cell:`,
        ...reasons.slice(0, 4).map((m) => `  • ${m}`),
        ...(reasons.length > 4 ? [`  • …and ${reasons.length - 4} more`] : []));
    }
    if (noDuration) lines.push(`${noDuration} session${noDuration === 1 ? ' has' : 's have'} no duration yet.`);
    if (!await window.api.confirm({
      message: 'Some rows would be refused by the Frappe import.',
      detail: `${lines.join('\n')}\n\nFix them first, or save this as a working copy anyway.`,
      confirmLabel: 'Save anyway', cancelLabel: 'Go back and fix', danger: false,
    })) return;
  }
  // Named after the schedule's dates, so each event gets a file of its own.
  const days = s.sessions.filter((x) => x.include).map(SCHEDULE.sessionDay).sort();
  const dmy = (d) => SCHEDULE.toIndian(d).replace(/\//g, '-');
  const span = days.length ? (days[0] === days[days.length - 1] ? dmy(days[0])
    : `${dmy(days[0])}_to_${dmy(days[days.length - 1])}`) : 'event';
  const target = await window.api.saveXlsx(`Event_Schedule_${span}.xlsx`);
  if (!target) return;
  try {
    const res = await call('schedule_write', { path: target, rows });
    s.saved = res.path;
    // Learn the operator's corrections and suggest the next folder numbers.
    s.memory = SCHEDULE.learn(s.memory, s.sessions);
    const nums = SCHEDULE.assignNumbers(s.sessions, s.starts);
    const next = {};
    for (const type of ['Formal', 'Informal']) {
      const used = s.sessions.filter((x) => x.include && x.type === type)
        .map((x) => Number((nums.get(x.key) || {}).folder)).filter(Number.isFinite);
      if (used.length) next[type === 'Formal' ? 'formal' : 'informal'] = Math.max(...used) + 1;
    }
    // The next schedule starts after this one; this one keeps its own numbers.
    await window.api.setSettings({ scheduleMemory: s.memory, scheduleStarts: { ...s.starts, ...next } });
    toast(`Saved ${rows.filter((r) => r[0]).length} sessions.`, 'ok');
  } catch (e) {
    toast(scheduleError(e), 'err');
  }
  scheduleRemember();
  render();
}

/* ------------------------------------------------------- backups */

/**
 * Start a backup from one row, in place of a structure zip: the row's job and
 * session folders (with its camera folders) are made as an empty structure and
 * loaded as the template, then the backup carries on from Sources as usual.
 */
async function scheduleStartBackup(key) {
  const s = state.schedule;
  const row = scheduleFind(key);
  if (!row || state.busy) return;
  const hard = blocksStart(scheduleProblems().get(row.key));
  if (hard.length) { toast(`Fix this row first: ${hard[0].msg}`, 'warn'); return; }
  const plan = SCHEDULE.folderPlan(s.sessions, s.starts, s.defaults).get(row.key);
  if (!plan) return;
  const busyWithOther = state.scheduleRun && state.scheduleRun.key !== row.key && state.template;
  if ((busyWithOther || row.backedUp) && !await window.api.confirm({
    message: row.backedUp ? `${plan.id} was backed up already. Start it again?` : `Start a backup for ${plan.id}?`,
    detail: `${plan.jobName}\n  ${plan.sessionName}\n\n`
      + (busyWithOther ? `The backup for ${state.scheduleRun.id} that is set up now is put aside.` : ''),
    confirmLabel: 'Start backup', danger: false,
  })) return;
  try {
    const r = await call('schedule_structure',
      { job: plan.jobName, session: plan.sessionName, cams: plan.cams },
      { label: `Preparing ${plan.id}` });
    setBackupType(plan.type === 'Informal' ? 'informal' : 'formal');
    state.sources = state.sources.filter((x) => x.role !== 'template');
    state.template = null;
    state.templates = [];
    addSource(r.path, `Schedule · ${plan.id}`, 'zip');
    const added = state.sources.find((x) => x.path === r.path);
    if (!added) return;
    added.role = 'template';
    await loadTemplate(added);
    if (!state.template) return;
    state.scheduleRun = { key: row.key, id: plan.id, scheduleId: s.id };
    // Started but not yet finished: if this backup is interrupted, the row
    // offers "Clips only" to complete the session already on the drive.
    row.startedAt = new Date().toISOString();
    scheduleRemember();
    toast(`${plan.id}: add the ${plan.type === 'Informal' ? 'output folder' : 'drives'} and carry on as usual.`, 'ok');
    goStep(0);
  } catch (e) {
    toast(scheduleError(e), 'err');
  }
}

/**
 * Finish a row whose session is already on the drive — a backup that stopped
 * part way (an error, a pulled cable) or camera clips that arrived late. The
 * row's session folder is found on each connected SSD, its duration, clip and
 * camera counts are read from the folder as it stands, and the backup goes
 * straight to the Cameras page in clips-only mode: the master and the folder
 * name are left as they are.
 */
async function scheduleClipsOnly(key) {
  const s = state.schedule;
  const row = scheduleFind(key);
  if (!row || state.busy) return;
  const hard = blocksStart(scheduleProblems().get(row.key));
  if (hard.length) { toast(`Fix this row first: ${hard[0].msg}`, 'warn'); return; }
  const plan = SCHEDULE.folderPlan(s.sessions, s.starts, s.defaults).get(row.key);
  if (!plan) return;
  try {
    const vols = await call('list_volumes', {});
    state.volumes = vols.volumes || state.volumes;
  } catch (_) { /* use the drives listed already */ }
  let found = [];
  try {
    const r = await call('schedule_find_sessions',
      { roots: (state.volumes || []).map((v) => v.path), job: plan.jobName, session: plan.sessionName },
      { label: `Looking for ${plan.id} on the drives` });
    found = r.found || [];
  } catch (e) { toast(scheduleError(e), 'err'); return; }
  const informal = plan.type === 'Informal';
  let paths = found.map((f) => f.session_path).slice(0, informal ? 1 : 2);
  if (paths.length) {
    const ok = await window.api.confirm({
      message: `Add camera clips to ${plan.id}'s existing session?`,
      detail: `${paths.join('\n')}\n\nThe master and the folder name are left as they are; `
        + 'the duration and clip count are read from the folder.'
        + (found.length > paths.length ? `\n(Also found on ${found.length - paths.length} more drive(s), not used.)` : ''),
      confirmLabel: 'Add camera clips', danger: false,
    });
    if (!ok) return;
  } else {
    // Not on a connected drive under that name: let the operator point at it.
    const folder = await window.api.pickFolder(
      `${plan.id} wasn't found on the connected drives — choose its session folder`);
    if (!folder) return;
    try {
      const d = await call('detect_structure', { root: folder }, { label: 'Reading session' });
      paths = [d.session_path || folder];
    } catch (e) { toast(scheduleError(e), 'err'); return; }
  }
  // The row takes its duration, clips and cameras from the folder as it is now.
  try {
    const res = await call('schedule_scan', { root: parentDir(paths[0]) });
    SCHEDULE.applyScan(s.sessions, s.starts, res.sessions);
  } catch (_) { /* filled again when the copy finishes */ }
  row.startedAt = row.startedAt || new Date().toISOString();
  scheduleRemember();
  setBackupType(informal ? 'informal' : 'formal');
  state.scheduleRun = { key: row.key, id: plan.id, scheduleId: s.id, clipsOnly: true };
  await clipsOnlyInto(paths);
  toast(`${plan.id}: ${row.duration ? `${row.duration}, ${row.clips} clip${Number(row.clips) === 1 ? '' : 's'} so far. ` : ''}`
    + 'Bring in the camera clips (Import camera cards, or Add files).', 'ok');
}

/**
 * After a copy started from a schedule row: read the duration, clip and camera
 * counts back from the job folder(s) it filed into, the same way the drive scan
 * does, so the row is complete without a separate "Fill from drive". The row's
 * schedule may have been closed meanwhile; it is found among the past ones.
 */
async function scheduleAfterRun(plan) {
  const run = state.scheduleRun;
  if (!run) return;
  const s = ((state.schedules && state.schedules.items) || []).find((x) => x.id === run.scheduleId) || state.schedule;
  if (!s) return;
  const row = scheduleFind(run.key, s);
  if (!row) return;
  const jobs = [...new Set((plan.targets || []).map((t) => parentDir(t.session_path)).filter(Boolean))];
  for (const job of jobs) {
    try {
      const res = await call('schedule_scan', { root: job });
      SCHEDULE.applyScan(s.sessions, s.starts, res.sessions);
      if (row.duration) break;
    } catch (_) { /* the copy itself succeeded; the row can still be filled from the drive */ }
  }
  row.backedUp = new Date().toISOString();
  s.saved = null;
  scheduleRemember();
  toast(row.duration
    ? `${run.id}: ${row.duration}, ${row.clips} clip${row.clips === 1 ? '' : 's'} — written to the event schedule.`
    : `${run.id}: backed up, but its duration could not be read — use Fill durations from drive.`,
  row.duration ? 'ok' : 'warn');
}

/* ------------------------------------------------------------ page */

/* -------------------------------------------------- pick-lists */

// The dropdown lists live outside the page in one hidden holder, built once and
// rewritten only when their values change: thousands of topics are too many to
// rebuild on every keystroke's redraw.
const datalistSigs = new Map();

/** Fill <datalist id> with `options` ([value] or [[value, label]]) if they changed. */
function setDatalist(id, options) {
  let host = $('datalists');
  if (!host) {
    host = document.createElement('div');
    host.id = 'datalists';
    host.hidden = true;
    document.body.appendChild(host);
  }
  const sig = `${options.length}|${JSON.stringify(options[0] || '')}|${JSON.stringify(options[options.length - 1] || '')}`;
  let list = document.getElementById(id);
  if (list && datalistSigs.get(id) === sig) return;
  if (!list) {
    list = document.createElement('datalist');
    list.id = id;
    host.appendChild(list);
  }
  datalistSigs.set(id, sig);
  list.innerHTML = options.map((o) => (Array.isArray(o)
    ? `<option value="${esc(o[0])}" label="${esc(o[1])}">` : `<option value="${esc(o)}">`)).join('');
}

/** Distinct values, most used first; the first spelling of each wins. */
function pickValues(...lists) {
  const count = new Map();
  const shown = new Map();
  for (const list of lists) {
    for (const raw of list || []) {
      for (const v of Array.isArray(raw) ? raw : [raw]) {
        const t = String(v ?? '').replace(/\s+/g, ' ').trim();
        if (!t || !/[a-z0-9]/i.test(t)) continue;
        const k = t.toLowerCase();
        if (!shown.has(k)) shown.set(k, t);
        count.set(k, (count.get(k) || 0) + 1);
      }
    }
  }
  return [...shown.keys()].sort((a, b) => count.get(b) - count.get(a)).map((k) => shown.get(k));
}

/** Every value the schedules and the Report's existing data hold for `field`. */
function knownValues(field) {
  const out = [];
  for (const item of ((state.schedules && state.schedules.items) || [])) {
    for (const row of item.sessions || []) out.push(row[field]);
  }
  for (const rec of ((state.report && state.report.existing) || [])) out.push(rec[field]);
  return out;
}

/** The schedule grid's lists: the master's values, plus the existing data and schedules. */
function scheduleDatalists() {
  setDatalist('schActivities', pickValues(SCHEDULE_VOCAB.activities, knownValues('activity')));
  setDatalist('schPlaces', pickValues(SCHEDULE_VOCAB.places, knownValues('place')));
  setDatalist('schTopics', pickValues(SCHEDULE_VOCAB.topics, knownValues('topic')));
  setDatalist('schEvents', pickValues(SCHEDULE_VOCAB.events, knownValues('events')));
  setDatalist('schLanguages', pickValues(SCHEDULE_VOCAB.languages, knownValues('languages')));
  setDatalist('schSessions', ['M', 'E', 'M1', 'M2', 'M3', 'E1', 'E2', 'E3', '1', '2', '3', '4', '5', '6']);
  setDatalist('schAuthors', ['DD', 'DJM', 'NM']);
  // Cities by name; where a name is shared, by record ID ("Springfield-Illinois-United States").
  const cities = scheduleCities();
  const count = new Map();
  for (const c of cities) count.set(c.city.toLowerCase(), (count.get(c.city.toLowerCase()) || 0) + 1);
  setDatalist('schCityList', cities.map((c) => (count.get(c.city.toLowerCase()) > 1
    ? [c.name, `${c.state}, ${c.country}`] : [c.city, `${c.state}, ${c.country}`])));
}

/** Open a field's pick-list on click, not only from its small arrow. */
function openPickerOnClick(el) {
  if (!el.list) return;
  el.addEventListener('mousedown', () => {
    if (typeof el.showPicker !== 'function') return;
    try { el.showPicker(); } catch (_) { /* not allowed right now */ }
  });
}

// The grid's columns, in the order of Frappe's Raw Video Data Report. The tick
// box, row buttons, ID and Folder stay put while the rest scrolls sideways.
const SCHEDULE_HEAD = [['y', 'Year'], ['m', 'M'], ['d', 'D'], ['activity', 'Activity'], ['author', 'Author'],
  ['format', 'Format'], ['type', 'Satsang Type'], ['city', 'City'], ['state', 'State'], ['country', 'Country'],
  ['place', 'Place Detail'], ['session', 'Session'], ['events', 'Event Type'], ['topic', 'Topic/Description'],
  ['languages', 'Language'], ['duration', 'Duration'], ['clips', 'No of clips'], ['cameras', 'No of cameras'],
  ['camPlan', 'Cam folders']];

/* ---------------------------------------------------- column widths */

// Each column can be dragged wider or narrower from the grip at the right of
// its header (double-click the grip for the default). The widths are kept in
// settings, one set for the schedule and one for the report.
function colWidths(scope) {
  if (!state.colWidths) state.colWidths = { schedule: {}, report: {} };
  if (!state.colWidths[scope]) state.colWidths[scope] = {};
  return state.colWidths[scope];
}

/** One <style> holding every dragged width, so a redraw keeps them. */
function applyColWidths() {
  let tag = $('colWidthStyle');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'colWidthStyle';
    document.head.appendChild(tag);
  }
  const rules = [];
  const fixed = (sel, w) => `${sel} { width: ${w}px; min-width: ${w}px; max-width: ${w}px; }`;
  const sched = colWidths('schedule');
  for (const [k, w] of Object.entries(sched)) {
    if (k === 'id' || k === 'folder') continue;
    rules.push(`.sch-table:not(.rep-table) .c-${k} .sch-in { width: ${w}px; }`,
      `.sch-table:not(.rep-table) td.c-${k}.sch-ro { width: ${w}px; max-width: ${w}px; overflow: hidden; text-overflow: ellipsis; }`);
  }
  // The frozen ID and Folder columns: a wider ID moves the Folder column along,
  // since both stay pinned at the left while the rest scrolls.
  const FZ3_LEFT = 296;
  if (sched.id) {
    rules.push(fixed('.sch-table:not(.rep-table) .fz3', sched.id),
      `.sch-table:not(.rep-table) .fz3 { overflow: hidden; text-overflow: ellipsis; }`,
      `.sch-table:not(.rep-table) .fz4 { left: ${FZ3_LEFT + sched.id}px; }`);
  }
  if (sched.folder) {
    rules.push(fixed('.sch-table:not(.rep-table) .fz4', sched.folder),
      `.sch-table:not(.rep-table) .fz4 .sch-in { width: ${Math.max(30, sched.folder - 12)}px; }`);
  }
  const rep = colWidths('report');
  for (const [k, w] of Object.entries(rep)) {
    if (k === 'id' || k === 'folder') continue;
    rules.push(fixed(`.rep-table th.c-${k}, .rep-table td.c-${k}`, w));
  }
  if (rep.id) rules.push(fixed('.rep-table .rz1', rep.id), `.rep-table .rz2 { left: ${rep.id}px; }`);
  if (rep.folder) rules.push(fixed('.rep-table .rz2', rep.folder));
  tag.textContent = rules.join('\n');
}

/** A header cell with a width grip. */
const resizableTh = (key, label, cls = '') =>
  `<th class="c-${key} ${cls}">${label}<span class="col-grip" data-grip="${key}" title="Drag to widen or narrow · double-click for the default"></span></th>`;

let colWidthSaveTimer = null;
function wireColumnResize(table, scope) {
  if (!table) return;
  applyColWidths();
  table.querySelectorAll('[data-grip]').forEach((grip) => {
    const key = grip.dataset.grip;
    grip.addEventListener('dblclick', (e) => {
      e.preventDefault();
      delete colWidths(scope)[key];
      applyColWidths();
      window.api.setSettings({ colWidths: state.colWidths }).catch(() => {});
    });
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const th = grip.parentElement;
      // Start from what the column's box (or cell) is now.
      const frozen = th.classList.contains('fz');
      const box = scope === 'schedule' && !frozen
        ? table.querySelector(`tbody .c-${key} .sch-in`) || table.querySelector(`tbody td.c-${key}`) : th;
      const start = box ? box.getBoundingClientRect().width : th.getBoundingClientRect().width;
      const x0 = e.clientX;
      document.body.classList.add('col-resizing');
      const move = (ev) => {
        colWidths(scope)[key] = Math.round(Math.max(36, Math.min(900, start + ev.clientX - x0)));
        applyColWidths();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('col-resizing');
        clearTimeout(colWidthSaveTimer);
        colWidthSaveTimer = setTimeout(() => window.api.setSettings({ colWidths: state.colWidths }).catch(() => {}), 300);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  });
}

function scheduleTableHtml(problems) {
  const s = state.schedule;
  const cities = scheduleCities();
  const nums = SCHEDULE.assignNumbers(s.sessions, s.starts);
  const plans = SCHEDULE.folderPlan(s.sessions, s.starts, s.defaults);
  const prob = (row, field) => (problems.get(row.key) || {})[field];
  // Default widths; a column dragged wider or narrower overrides them.
  const WIDTH = { city: 'w-city', place: 'w-wide', events: 'w-mid', topic: 'w-wide', languages: 'w-lang' };
  const LONG = new Set(['city', 'place', 'events', 'topic', 'languages']);
  const cell = (row, field, value, opts = {}) => {
    const p = prob(row, opts.flag || field);
    const text = String(value ?? '');
    // Hovering a text box shows its whole text, however narrow the column.
    const hint = [p ? p.msg : '', opts.title || '', LONG.has(field) && text ? text : ''].filter(Boolean).join('\n');
    return `<td class="c-${field} ${opts.td || ''}"><input class="sch-in ${opts.cls || WIDTH[field] || ''} ${p ? `flag${p.hard ? ' err' : ''}` : ''}" data-k="${row.key}"
      data-f="${field}" value="${esc(text)}" ${opts.list ? `list="${opts.list}"` : ''}
      ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''}
      title="${esc(hint)}"></td>`;
  };
  // A menu always lists every option; a value not on it (from an older sheet) is kept.
  const select = (row, field, options, cls) => {
    const p = prob(row, field);
    const value = row[field] ?? '';
    const all = value && !options.includes(value) ? [value, ...options] : options;
    return `<td class="c-${field}"><select class="sch-in ${cls || (field === 'type' ? 'w-type' : 'w-fmt')} ${p ? `flag${p.hard ? ' err' : ''}` : ''}"
      data-k="${row.key}" data-f="${field}" title="${esc(p ? p.msg : '')}">
      ${value ? '' : '<option selected value="">—</option>'}
      ${all.map((t) => `<option ${value === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></td>`;
  };
  const activities = pickValues(SCHEDULE_VOCAB.activities);
  const authors = pickValues(['DD', 'DJM', 'NM'], knownValues('author'));
  const body = s.sessions.map((row) => {
    const n = nums.get(row.key) || {};
    const plan = plans.get(row.key);
    const id = row.include ? SCHEDULE.masterId(row, n.folder, n.session) : '—';
    const blocked = row.include && blocksStart(problems.get(row.key)).length;
    const running = state.scheduleRun && state.scheduleRun.key === row.key && state.scheduleRun.scheduleId === s.id;
    const startTitle = plan ? `${plan.jobName}\n  ${plan.sessionName}\n  ${plan.cams} camera folder${plan.cams === 1 ? '' : 's'}` : '';
    const [y, m, d] = /^\d{4}-\d{2}-\d{2}$/.test(row.date || '') ? row.date.split('-') : ['', '', ''];
    const c = SCHEDULE.cityOf(row, cities);
    const idProblem = prob(row, 'folder') || prob(row, 'session');
    return `<tr class="${row.include ? '' : 'sch-off'} ${running ? 'sch-running' : ''}" data-row="${row.key}">
      <td class="fz fz1"><input type="checkbox" data-k="${row.key}" data-f="include" ${row.include ? 'checked' : ''}
        title="Include this session in the sheet (Space ticks, ↑/↓ moves between rows)"></td>
      <td class="fz fz2"><div class="sch-acts">${row.include ? `<button class="sm ${row.backedUp ? '' : 'primary'}" data-start="${row.key}"
        ${blocked || state.busy ? 'disabled' : ''} title="${esc(blocked
          ? `Fix the red cells first: ${blocksStart(problems.get(row.key))[0].msg}` : startTitle)}">
        ${row.backedUp ? 'Backed up ✓' : running ? 'In progress…' : 'Start backup'}</button>
        <button class="sm ${row.startedAt && !row.backedUp && !running ? 'primary' : 'ghost'}" data-clips="${row.key}"
          ${blocked || state.busy ? 'disabled' : ''} title="${esc(row.startedAt && !row.backedUp
            ? 'This backup did not finish: add the camera clips to the session already on the drive'
            : 'Add camera clips to this session already on the drive (late clips, or a backup that stopped)')}">Clips only</button>` : ''}
        <button class="sm ghost" data-add="${row.key}" title="Add an unplanned session below this one (same day, place and event)">＋</button>
        <button class="sm ghost sch-del" data-del="${row.key}" title="Delete this row (Undo brings it back)">✕</button></div></td>
      <td class="fz fz3 mono sch-id ${idProblem && idProblem.hard ? 'sch-id-err' : ''}"
        title="${esc(idProblem ? idProblem.msg : row.source || '')}">${esc(id)}</td>
      ${cell(row, 'folder', row.folder, { cls: 'w-num', td: 'fz fz4', placeholder: n.folder != null ? String(n.folder) : '' })}
      ${cell(row, 'y', y, { cls: 'w-year', flag: 'date', placeholder: 'yyyy' })}
      ${cell(row, 'm', m, { cls: 'w-small', flag: 'date', placeholder: 'mm' })}
      ${cell(row, 'd', d, { cls: 'w-small', flag: 'date', placeholder: 'dd',
        title: row.start ? `Starts ${row.start}` : '' })}
      ${select(row, 'activity', activities, 'w-act')}
      ${select(row, 'author', authors, 'w-auth')}
      ${select(row, 'format', ['HD', '4K', 'DV'])}
      ${select(row, 'type', ['Formal', 'Informal'])}
      ${cell(row, 'city', row.city, { list: 'schCityList', title: 'Starts the session folder name and fills Geolocation' })}
      <td class="sch-ro c-state" title="${esc(c ? c.state : '')}">${esc(c ? c.state : '')}</td>
      <td class="sch-ro c-country" title="${esc(c ? c.country : '')}">${esc(c ? c.country : '')}</td>
      ${cell(row, 'place', row.place, { list: 'schPlaces',
        title: row.placeText ? `On the schedule: ${row.placeText}` : '' })}
      ${cell(row, 'session', row.session, { list: 'schSessions', cls: 'w-num', placeholder: n.session || '',
        title: row.type === 'Formal' ? 'M before noon, E from noon till next morning; M1, M2 / E1, E2 when there are several'
          : 'Informal sessions are 1, 2, 3 in the day' })}
      ${cell(row, 'events', listText(row.events), { list: 'schEvents',
        title: 'Several? Separate with commas — each extra one gets its own row in the sheet.' })}
      ${cell(row, 'topic', row.topic, { list: 'schTopics',
        title: `On the schedule: ${row.title || ''}${row.subtitle ? ` — ${row.subtitle}` : ''}` })}
      ${cell(row, 'languages', listText(row.languages), { list: 'schLanguages',
        title: 'Several? Separate with commas.' })}
      ${cell(row, 'duration', row.duration, { cls: 'w-dur', title: 'Filled in after the backup — or like 1h 2m 3s' })}
      ${cell(row, 'clips', row.clips, { cls: 'w-small' })}
      ${cell(row, 'cameras', row.cameras, { cls: 'w-small' })}
      ${cell(row, 'camPlan', row.camPlan ?? '', { cls: 'w-small',
        placeholder: String(SCHEDULE.camsFor(row, s.defaults)),
        title: 'Camera folders the backup creates (more can be added on the Cameras page)' })}
    </tr>`;
  }).join('');
  const ticked = s.sessions.filter((x) => x.include).length;
  return `<div class="sch-scroll"><table class="sch-table">
    <thead><tr><th class="fz fz1"><input type="checkbox" id="schTickAll" ${ticked && ticked === s.sessions.length ? 'checked' : ''}
      ${ticked && ticked < s.sessions.length ? 'data-some="1"' : ''} title="Tick all / untick all"></th>
      <th class="fz fz2"></th>${resizableTh('id', 'Raw Video Id', 'fz fz3')}${resizableTh('folder', 'Folder', 'fz fz4')}
      ${SCHEDULE_HEAD.map(([k, h]) => resizableTh(k, h)).join('')}</tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function scheduleSourceHtml() {
  const s = state.schedule;
  const rows = (s.rows || []).map((r) => `<tr><td>${r.map((c) => esc(c).replace(/\n/g, '<br>'))
    .join('</td><td>')}</td></tr>`).join('');
  const skipped = s.read && s.read.skipped && s.read.skipped.length
    ? `<p class="hint">Breaks left out: ${s.read.skipped.map((x) => esc(x.days.map(SCHEDULE.toIndian).join(' – '))).join(', ')}</p>` : '';
  return `<details class="sch-source" ${s.showSource ? 'open' : ''}>
    <summary>What was read from the schedule (${(s.rows || []).length} lines)</summary>
    ${skipped}
    <div class="sch-src-scroll"><table class="rename-table">${rows}</table></div>
  </details>`;
}

/** The kept assignments, newest first, each by the dates it holds. */
function schedulePastHtml() {
  const items = ((state.schedules && state.schedules.items) || []).filter((x) => x !== state.schedule && !x.busy);
  if (!items.length) return '';
  const firstDay = (x) => (x.sessions || []).map(SCHEDULE.sessionDay).filter(Boolean).sort()[0] || '';
  items.sort((a, b) => (firstDay(b) || b.created || '').localeCompare(firstDay(a) || a.created || ''));
  return `<div class="card" style="margin-top:14px">
    <h3>Past schedules</h3>
    <p class="hint">Kept with everything in them until you delete them. Open one to edit it again.</p>
    <table class="sch-past">
      <thead><tr><th>Dates</th><th>Sessions</th><th>Backed up</th><th>Schedule file</th><th></th></tr></thead>
      <tbody>${items.map((x) => {
        const ticked = x.sessions.filter((r) => r.include).length;
        const done = x.sessions.filter((r) => r.include && r.backedUp).length;
        return `<tr>
          <td><b>${esc(scheduleRange(x))}</b></td>
          <td>${ticked}</td>
          <td>${done}${ticked ? ` of ${ticked}` : ''}</td>
          <td class="mono sch-past-file" title="${esc(x.file || '')}">${esc(String(x.file || '').split(/[\\/]/).pop())}</td>
          <td class="sch-past-acts"><button class="sm primary" data-reopen="${x.id}">Open</button>
            <button class="sm ghost" data-delete="${x.id}">Delete</button></td></tr>`;
      }).join('')}</tbody>
    </table>
  </div>`;
}

function renderSchedulePage() {
  const s = state.schedule;
  if (!s) {
    return `<div class="card" id="scheduleDrop">
      <h3>Start from the event schedule</h3>
      <p class="hint">Read the event's schedule — a WhatsApp poster, a photo, a PDF, or a Word, Excel or
        CSV file — into rows laid out like the <b>Raw Satsang Master</b>. Pictures and PDFs are read on this
        computer (no internet, no AI). Check every row, then press <b>Start backup</b> on a row: it sets up
        that session's folders, so no structure zip is needed.</p>
      <div class="row">
        <button class="sm primary" id="btnSchedule">Choose schedule…</button>
        <span class="hint" style="margin:0">or drop the schedule file on this card.</span>
      </div>
    </div>
    ${schedulePastHtml()}
    <div class="note" style="margin-top:12px">No schedule for this backup? Go to <b>Sources</b> and import a
      structure zip as before.</div>`;
  }
  if (s.busy) {
    return `<div class="card"><div class="empty"><div class="big">🔎</div><div>${esc(s.busy)}</div>
      <div class="hint">Pictures are read on this computer; the first one takes a few seconds longer.</div></div></div>`;
  }
  const problems = scheduleProblems();
  const included = s.sessions.filter((r) => r.include);
  const errors = included.filter((r) => blocksStart(problems.get(r.key)).length).length;
  const waiting = included.filter((r) => !blocksStart(problems.get(r.key)).length
    && hardOf(problems.get(r.key)).length).length;
  const warned = included.filter((r) => !hardOf(problems.get(r.key)).length
    && Object.keys(problems.get(r.key) || {}).length).length;
  const done = included.filter((r) => r.backedUp).length;
  const run = state.scheduleRun && state.scheduleRun.scheduleId === s.id && scheduleFind(state.scheduleRun.key);
  const cities = scheduleCities();
  return `<div class="card">
      <div class="row" style="align-items:flex-start">
        <div style="flex:1;min-width:0"><h3 style="margin:0">Event schedule · ${esc(scheduleRange(s))}</h3>
          <div class="path" style="margin-top:4px">${esc(s.file || '')}</div></div>
        <button class="sm" id="schAnother">Read another schedule…</button>
        <button class="sm" id="schDrive" ${s.sessions.length ? '' : 'disabled'}
          title="Read durations, clip and camera counts from the filed session folders">Fill durations from drive…</button>
        <button class="sm" id="schCities" title="${esc(`${cities.length} cities · ${state.citySource || 'built in'}\nReplace it with a newer export of Frappe's City list`)}">City list (${cities.length})…</button>
        ${s.saved ? '<button class="sm ghost" id="schReveal">Show saved file</button>' : ''}
        <button class="sm" id="schClose" title="Put this schedule with the past ones (nothing is lost) and get ready for the next">Close schedule</button>
      </div>
      ${s.error ? `<div class="note err" style="margin-top:10px">${esc(s.error)}</div>` : ''}
      <div class="row sch-settings" style="margin-top:12px">
        <label class="field"><span>First Formal folder no.</span>
          <input id="schFormal" class="sch-in w-num" value="${esc(s.starts.formal ?? '')}" placeholder="e.g. 3058"></label>
        <label class="field"><span>First Informal folder no.</span>
          <input id="schInformal" class="sch-in w-num" value="${esc(s.starts.informal ?? '')}" placeholder="e.g. 2620"></label>
        <label class="field"><span>Author</span>
          <input id="schAuthor" class="sch-in w-num" value="${esc(s.defaults.author)}" list="schAuthors"></label>
        <label class="field"><span>Format</span>
          <select id="schFormat" class="sch-in w-fmt">${['HD', '4K', 'DV'].map((t) =>
            `<option ${s.defaults.format === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <button class="sm" id="schApply" title="Set this author and format on every row">Apply to all rows</button>
        <label class="field"><span>Cam folders · Formal</span>
          <input id="schCamsFormal" class="sch-in w-small" value="${esc(s.defaults.camsFormal ?? 3)}"></label>
        <label class="field"><span>Informal</span>
          <input id="schCamsInformal" class="sch-in w-small" value="${esc(s.defaults.camsInformal ?? 1)}"></label>
      </div>
    </div>
    ${s.sessions.length ? `<div class="note ${errors ? 'err' : warned ? 'warn' : 'ok'}" style="margin:12px 0">
      <b>${included.length}</b> session${included.length === 1 ? '' : 's'} ticked${done ? ` · <b>${done}</b> backed up` : ''}${waiting
        ? ` · <b>${waiting}</b> waiting for a backup to fill the duration` : ''}${errors
        ? ` · <b>${errors}</b> with a <b>red</b> required field to fix` : ''}${warned
        ? ` · <b>${warned}</b> with a yellow cell to check` : ''}
      ${run && !run.backedUp ? `<br>Backup in progress: <b>${esc(state.scheduleRun.id)}</b>` : ''}
      ${s.scan ? `<br>Durations read from <span class="mono">${esc(s.scan.root)}</span>:
        ${s.scan.filled} filled${s.scan.missing ? `, ${s.scan.missing} not on the drive` : ''}.` : ''}
      ${s.saved ? `<br>Saved to <span class="mono">${esc(s.saved)}</span>.` : ''}</div>
    ${scheduleTableHtml(problems)}` : ''}
    <div class="row" style="margin-top:8px">
      <button class="sm" id="schAddRow" title="A session that was not on the schedule — or use ＋ on a row to add it below that row">＋ Add unplanned session</button>
      ${s.sessions.some((r) => !r.include) ? `<button class="sm ghost" id="schDelUnticked"
        title="Remove every row that is not ticked">✕ Delete unticked rows (${s.sessions.filter((r) => !r.include).length})</button>` : ''}
      ${s.undo ? `<span class="hint" style="margin:0">${esc(s.undo.label)}</span>
        <button class="sm" id="schUndo">Undo</button>` : ''}
    </div>
    ${scheduleSourceHtml()}`;
}

function wireSchedulePage() {
  if (state.schedule && !state.schedule.busy) scheduleDatalists();
  $('btnSchedule')?.addEventListener('click', () => openSchedule());
  const host = $('content');
  host.querySelectorAll('[data-reopen]').forEach((b) => b.addEventListener('click', () => reopenSchedule(b.dataset.reopen)));
  host.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', () => deleteSchedule(b.dataset.delete)));
  const drop = $('scheduleDrop');
  if (drop) {
    const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
    drop.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); drop.classList.add('dropping'); } });
    drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('dropping'); });
    drop.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      drop.classList.remove('dropping');
      const file = e.dataTransfer.files[0];
      const p = file && window.api.pathForFile ? window.api.pathForFile(file) : null;
      if (p) openSchedule(p);
    });
  }
  const s = state.schedule;
  if (!s || s.busy) return;
  $('schClose')?.addEventListener('click', closeSchedule);
  $('schAnother')?.addEventListener('click', () => openSchedule());
  $('schDrive')?.addEventListener('click', scheduleFillFromDrive);
  $('schCities')?.addEventListener('click', scheduleImportCities);
  $('schReveal')?.addEventListener('click', () => window.api.reveal(s.saved));
  $('schApply')?.addEventListener('click', scheduleApplyDefaults);
  for (const [id, key] of [['schFormal', 'formal'], ['schInformal', 'informal']]) {
    $(id)?.addEventListener('change', (e) => {
      const v = e.target.value.trim();
      s.starts[key] = v === '' ? undefined : Number(v);
      s.saved = null;
      scheduleRemember();
      scheduleRerender();
    });
  }
  for (const [id, key] of [['schCamsFormal', 'camsFormal'], ['schCamsInformal', 'camsInformal']]) {
    $(id)?.addEventListener('change', (e) => {
      const v = Number(e.target.value.trim());
      s.defaults[key] = Number.isFinite(v) && v >= 0 ? v : undefined;
      window.api.setSettings({ scheduleDefaults: s.defaults }).catch(() => {});
      scheduleRemember();
      scheduleRerender();
    });
  }
  host.querySelectorAll('.sch-table [data-k][data-f]').forEach((el) => {
    el.addEventListener('change', () => scheduleSet(el.dataset.k, el.dataset.f, el.type === 'checkbox' ? el.checked : el.value));
    openPickerOnClick(el);
  });
  host.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => scheduleAddRow(b.dataset.add)));
  $('schAddRow')?.addEventListener('click', () => scheduleAddRow(null));
  host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => scheduleDeleteRows([b.dataset.del])));
  $('schDelUnticked')?.addEventListener('click', () => scheduleDeleteRows(s.sessions.filter((r) => !r.include).map((r) => r.key)));
  $('schUndo')?.addEventListener('click', scheduleUndoDelete);
  const all = $('schTickAll');
  if (all) {
    all.indeterminate = !!all.dataset.some;
    all.addEventListener('change', () => scheduleTickAll(all.checked));
  }
  wireScheduleKeys(host.querySelector('.sch-table'));
  wireColumnResize(host.querySelector('.sch-table'), 'schedule');
  host.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => scheduleStartBackup(b.dataset.start)));
  host.querySelectorAll('[data-clips]').forEach((b) => b.addEventListener('click', () => scheduleClipsOnly(b.dataset.clips)));
  host.querySelector('details.sch-source')?.addEventListener('toggle', (e) => { s.showSource = e.target.open; });
}

/**
 * Row by row from the keyboard: clicking a row (outside its fields) puts the
 * focus on its tick box; ↑/↓ move to the row above/below and Space ticks it.
 * Text fields and menus keep their own arrow keys.
 */
function wireScheduleKeys(table) {
  if (!table) return;
  table.addEventListener('mousedown', (e) => {
    const tr = e.target.closest('tbody tr');
    if (!tr || e.target.closest('input, select, button, textarea')) return;
    e.preventDefault();
    scheduleFocusRow(tr.dataset.row);
  });
  table.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const box = e.target;
    if (!box.matches('tbody input[type=checkbox][data-k]')) return;
    const tr = box.closest('tr');
    const next = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
    e.preventDefault();
    if (next) scheduleFocusRow(next.dataset.row);
  });
}

function scheduleFooterHtml() {
  const s = state.schedule;
  const included = s && !s.busy ? s.sessions.filter((r) => r.include).length : 0;
  return `<div class="spacer"></div>
    <span class="hint" style="margin:0">${s ? (s.busy ? '' : `${included} session${included === 1 ? '' : 's'} in the sheet`)
      : 'Choose a schedule, or go to Sources to import a structure zip'}</span>
    ${s ? `<button class="primary" id="schSave" ${s.busy || !included ? 'disabled' : ''}>Save .xlsx…</button>` : ''}
    <button id="schToSources">Sources →</button>`;
}

function wireScheduleFooter() {
  $('schSave')?.addEventListener('click', scheduleSave);
  $('schToSources')?.addEventListener('click', () => goStep(0));
}

'use strict';

/* Event schedule: the app's first page, where a backup usually starts. The
 * schedule is read offline (OCR for pictures and PDFs, the engine for
 * Word/Excel/CSV), drafted into master rows by schedule-logic.js and corrected
 * by the operator. Each row can start its own backup — the row stands in for a
 * structure zip, giving the job and session folder names and the camera
 * folders — and when that backup finishes, the row's duration, clip and camera
 * counts are read back from the folder it filed. The rows are saved as an .xlsx
 * in the Raw Satsang Master's layout, and kept between launches.
 * Uses app.js's shared state, render(), call(), toast() and the backup steps. */

const SCHEDULE = window.VIngestSchedule;
const SCHEDULE_VOCAB = window.VIngestScheduleVocab || {};
const SCHEDULE_PICTURES = ['png', 'jpg', 'jpeg'];
const SCHEDULE_TABLES = ['docx', 'xlsx', 'xlsm', 'csv'];

async function openSchedule(file) {
  const path = file || await window.api.pickSchedule();
  if (!path) return;
  const prev = state.schedule;
  if (prev && prev.sessions.length && !await window.api.confirm({
    message: 'Replace the current event schedule?',
    detail: `Its ${prev.sessions.length} rows are replaced by the new schedule. Save it as .xlsx first if you still need it.`,
    confirmLabel: 'Replace', danger: true,
  })) return;
  const settings = await window.api.getSettings().catch(() => ({}));
  state.schedule = {
    open: true, file: path, busy: 'Reading the schedule…', error: null,
    rows: [], read: null, sessions: [], scan: null, saved: null, showSource: false,
    memory: settings.scheduleMemory || { titles: [], places: [] },
    starts: prev ? prev.starts : { ...(settings.scheduleStarts || {}) },
    defaults: prev ? prev.defaults
      : { author: 'DD', format: 'HD', camsFormal: 3, camsInformal: 1, ...(settings.scheduleDefaults || {}) },
  };
  state.view = 'schedule';
  render();
  await readSchedule();
}

/** Bring back the schedule that was open when the app last closed. */
function restoreSchedule(settings) {
  const d = settings && settings.scheduleDraft;
  if (!d || !Array.isArray(d.sessions)) return;
  state.schedule = {
    open: true, busy: null, error: null, showSource: false,
    file: d.file || '', rows: d.rows || [], read: d.read || null, sessions: d.sessions,
    scan: d.scan || null, saved: d.saved || null,
    memory: settings.scheduleMemory || { titles: [], places: [] },
    starts: d.starts || {},
    defaults: { author: 'DD', format: 'HD', camsFormal: 3, camsInformal: 1, ...(d.defaults || {}) },
  };
}

let scheduleRememberTimer = null;
/** Keep the schedule across launches: a backup day spans many app sessions. */
function scheduleRemember() {
  clearTimeout(scheduleRememberTimer);
  scheduleRememberTimer = setTimeout(() => {
    const s = state.schedule;
    const draft = s && !s.busy ? {
      file: s.file, rows: s.rows, read: s.read ? { skipped: s.read.skipped || [] } : null,
      sessions: s.sessions, starts: s.starts, defaults: s.defaults, scan: s.scan, saved: s.saved,
    } : null;
    window.api.setSettings({ scheduleDraft: draft }).catch(() => {});
  }, 400);
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

async function closeSchedule() {
  if (!await window.api.confirm({
    message: 'Close this event schedule?',
    detail: 'Its rows are cleared from the app. Save it as .xlsx first if you still need it.',
    confirmLabel: 'Close schedule', danger: true,
  })) return;
  state.schedule = null;
  state.scheduleRun = null;
  scheduleRemember();
  render();
}

/* ------------------------------------------------------------ editing */

const scheduleFind = (key) => state.schedule.sessions.find((x) => x.key === Number(key));
const listText = (a) => (a || []).join(', ');
const listOf = (t) => String(t || '').split(',').map((x) => x.trim()).filter(Boolean);

function scheduleSet(key, field, value) {
  const row = scheduleFind(key);
  if (!row) return;
  if (field === 'include') row.include = !!value;
  else if (field === 'events' || field === 'languages') row[field] = listOf(value);
  else if (field === 'folder' || field === 'session') row[field] = String(value).trim().toUpperCase() || null;
  else if (field === 'camPlan') row.camPlan = String(value).trim() === '' ? null : Number(value);
  else if (field === 'date') row.date = SCHEDULE.fromIndian(value) || String(value).trim();
  else row[field] = typeof value === 'string' ? value.trim() : value;
  if (field === 'session' || field === 'date') delete row.flags.session;
  delete row.flags[field];
  state.schedule.saved = null;
  scheduleRemember();
  render();
}

function scheduleDuplicate(key) {
  const s = state.schedule;
  const i = s.sessions.findIndex((x) => x.key === Number(key));
  if (i < 0) return;
  const copy = JSON.parse(JSON.stringify(s.sessions[i]));
  copy.key = Math.max(...s.sessions.map((x) => x.key)) + 1;
  copy.session = null;
  copy.duration = ''; copy.clips = ''; copy.cameras = ''; copy.backedUp = null;
  copy.flags = { ...copy.flags, session: 'Added by hand — set M/E or the session number.' };
  s.sessions.splice(i + 1, 0, copy);
  scheduleRemember();
  render();
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
  const found = SCHEDULE.check(s.sessions, s.starts, SCHEDULE_VOCAB);
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

async function scheduleSave() {
  const s = state.schedule;
  const rows = SCHEDULE.sheetRows(s.sessions, s.starts);
  if (!rows.length) { toast('Tick at least one session to save.', 'warn'); return; }
  const problems = scheduleProblems();
  const blocked = s.sessions.filter((r) => r.include && blocksStart(problems.get(r.key)).length);
  if (blocked.length) {
    toast(`${blocked.length} row${blocked.length === 1 ? ' has' : 's have'} a red cell Frappe would refuse — `
      + 'hover it to see why, fix it, then save.', 'warn');
    return;
  }
  // Only durations missing: those sessions are not backed up yet. Fine as a
  // working copy, but Frappe refuses those rows until they are filled in.
  const noDuration = s.sessions.filter((r) => r.include && hardOf(problems.get(r.key)).length).length;
  if (noDuration && !await window.api.confirm({
    message: `${noDuration} session${noDuration === 1 ? ' has' : 's have'} no duration yet.`,
    detail: 'Duration is required in Frappe, so the import refuses those rows until they are backed up '
      + '(or filled from the drive). Save this as a working copy anyway?',
    confirmLabel: 'Save anyway', danger: false,
  })) return;
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
    state.scheduleRun = { key: row.key, id: plan.id };
    toast(`${plan.id}: add the ${plan.type === 'Informal' ? 'output folder' : 'drives'} and carry on as usual.`, 'ok');
    goStep(0);
  } catch (e) {
    toast(scheduleError(e), 'err');
  }
}

/**
 * After a copy started from a schedule row: read the duration, clip and camera
 * counts back from the job folder(s) it filed into, the same way the drive scan
 * does, so the row is complete without a separate "Fill from drive".
 */
async function scheduleAfterRun(plan) {
  const s = state.schedule;
  const run = state.scheduleRun;
  if (!s || !run) return;
  const row = scheduleFind(run.key);
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

function scheduleDatalists() {
  const opts = (id, list) => `<datalist id="${id}">${(list || [])
    .filter((v) => /[a-z]/i.test(v)).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  return opts('schActivities', SCHEDULE_VOCAB.activities) + opts('schPlaces', SCHEDULE_VOCAB.places)
    + opts('schTopics', SCHEDULE_VOCAB.topics) + opts('schEvents', SCHEDULE_VOCAB.events)
    + opts('schLanguages', SCHEDULE_VOCAB.languages);
}

function scheduleTableHtml(problems) {
  const s = state.schedule;
  const nums = SCHEDULE.assignNumbers(s.sessions, s.starts);
  const plans = SCHEDULE.folderPlan(s.sessions, s.starts, s.defaults);
  const cell = (row, field, value, opts = {}) => {
    const p = (problems.get(row.key) || {})[field];
    return `<td><input class="sch-in ${opts.cls || ''} ${p ? `flag${p.hard ? ' err' : ''}` : ''}" data-k="${row.key}"
      data-f="${field}" value="${esc(value ?? '')}" ${opts.list ? `list="${opts.list}"` : ''}
      ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''}
      title="${esc(p ? p.msg : opts.title || '')}"></td>`;
  };
  const select = (row, field, options) => {
    const p = (problems.get(row.key) || {})[field];
    return `<td><select class="sch-in ${field === 'type' ? 'w-type' : 'w-fmt'} ${p ? `flag${p.hard ? ' err' : ''}` : ''}"
      data-k="${row.key}" data-f="${field}" title="${esc(p ? p.msg : '')}">
      ${options.includes(row[field]) ? '' : '<option selected value="">—</option>'}
      ${options.map((t) => `<option ${row[field] === t ? 'selected' : ''}>${t}</option>`).join('')}</select></td>`;
  };
  const body = s.sessions.map((row) => {
    const n = nums.get(row.key) || {};
    const plan = plans.get(row.key);
    const id = row.include ? SCHEDULE.masterId(row, n.folder, n.session) : '—';
    const blocked = row.include && blocksStart(problems.get(row.key)).length;
    const running = state.scheduleRun && state.scheduleRun.key === row.key;
    const startTitle = plan ? `${plan.jobName}\n  ${plan.sessionName}\n  ${plan.cams} camera folder${plan.cams === 1 ? '' : 's'}` : '';
    return `<tr class="${row.include ? '' : 'sch-off'} ${running ? 'sch-running' : ''}">
      <td><input type="checkbox" data-k="${row.key}" data-f="include" ${row.include ? 'checked' : ''}
        title="Include this session in the sheet"></td>
      <td class="mono sch-id" title="${esc(row.source || '')}">${esc(id)}</td>
      ${cell(row, 'date', SCHEDULE.toIndian(row.date), { cls: 'w-date', placeholder: 'dd/mm/yyyy',
        title: row.start ? `Starts ${row.start}` : 'dd/mm/yyyy' })}
      ${select(row, 'type', ['Formal', 'Informal'])}
      ${cell(row, 'folder', row.folder, { cls: 'w-num', placeholder: n.folder != null ? String(n.folder) : '' })}
      ${cell(row, 'session', row.session, { cls: 'w-num', placeholder: n.session || '',
        title: row.type === 'Formal' ? 'M before noon, E from noon till next morning; M1, M2 / E1, E2 when there are several'
          : 'Informal sessions are 1, 2, 3 in the day' })}
      ${select(row, 'format', ['HD', '4K', 'DV'])}
      ${cell(row, 'activity', row.activity, { list: 'schActivities', cls: 'w-mid' })}
      ${cell(row, 'place', row.place, { list: 'schPlaces', cls: 'w-wide',
        title: row.placeText ? `On the schedule: ${row.placeText}` : '' })}
      ${cell(row, 'city', row.city, { cls: 'w-city', title: 'Starts the session folder name, e.g. Adalaj' })}
      ${cell(row, 'topic', row.topic, { list: 'schTopics', cls: 'w-wide',
        title: `On the schedule: ${row.title || ''}${row.subtitle ? ` — ${row.subtitle}` : ''}` })}
      ${cell(row, 'events', listText(row.events), { list: 'schEvents', cls: 'w-mid',
        title: 'Several? Separate with commas — each extra one gets its own row in the sheet.' })}
      ${cell(row, 'languages', listText(row.languages), { list: 'schLanguages', cls: 'w-lang',
        title: 'Several? Separate with commas.' })}
      ${cell(row, 'duration', row.duration, { cls: 'w-dur', title: 'Filled in after the backup — or like 1h 2m 3s' })}
      ${cell(row, 'clips', row.clips, { cls: 'w-small' })}
      ${cell(row, 'cameras', row.cameras, { cls: 'w-small' })}
      ${cell(row, 'camPlan', row.camPlan ?? '', { cls: 'w-small',
        placeholder: String(SCHEDULE.camsFor(row, s.defaults)),
        title: 'Camera folders the backup creates (more can be added on the Cameras page)' })}
      <td><button class="sm ghost" data-dup="${row.key}" title="Add another session like this one">＋</button></td>
      <td class="sch-go">${row.include ? `<button class="sm ${row.backedUp ? '' : 'primary'}" data-start="${row.key}"
        ${blocked || state.busy ? 'disabled' : ''} title="${esc(blocked
          ? `Fix the red cells first: ${blocksStart(problems.get(row.key))[0].msg}` : startTitle)}">
        ${row.backedUp ? 'Backed up ✓' : running ? 'In progress…' : 'Start backup'}</button>` : ''}</td>
    </tr>`;
  }).join('');
  return `<div class="sch-scroll"><table class="sch-table">
    <thead><tr><th></th><th>ID</th><th>Date</th><th>Type</th><th>Folder</th><th>Session</th>
      <th>Format</th><th>Activity</th><th>Place</th><th>City</th><th>Topic / description</th><th>Event type</th>
      <th>Language</th><th>Duration</th><th>Clips</th><th>Cams</th><th title="Camera folders to create">Cam folders</th>
      <th></th><th></th></tr></thead>
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
    <div class="sch-scroll" style="max-height:260px"><table class="rename-table">${rows}</table></div>
  </details>`;
}

function renderSchedulePage() {
  const s = state.schedule;
  if (!s) {
    return `<div class="card" id="scheduleDrop">
      <h3>Start from the event schedule</h3>
      <p class="hint">Read the event's schedule — a WhatsApp poster, a photo, a PDF, or a Word, Excel or
        CSV file — into rows laid out like the <b>Raw Satsang Master</b>: IDs, folder and session numbers,
        dates, activity, place, topic, event type and language. Pictures and PDFs are read on this computer
        (no internet, no AI). Check every row, then press <b>Start backup</b> on a row: it sets up that
        session's folders, so no structure zip is needed. Its duration, clips and cameras are filled in
        when the copy finishes.</p>
      <div class="row">
        <button class="sm primary" id="btnSchedule">Choose schedule…</button>
        <span class="hint" style="margin:0">or drop the schedule file on this card.</span>
      </div>
    </div>
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
  const run = state.scheduleRun && scheduleFind(state.scheduleRun.key);
  return `<div class="card">
      <div class="row" style="align-items:flex-start">
        <div style="flex:1;min-width:0"><h3 style="margin:0">Event schedule</h3>
          <div class="path" style="margin-top:4px">${esc(s.file || '')}</div></div>
        <button class="sm" id="schAnother">Read another schedule…</button>
        <button class="sm" id="schDrive" ${s.sessions.length ? '' : 'disabled'}
          title="Read durations, clip and camera counts from the filed session folders">Fill durations from drive…</button>
        ${s.saved ? '<button class="sm ghost" id="schReveal">Show saved file</button>' : ''}
        <button class="sm ghost" id="schClose">Close schedule</button>
      </div>
      ${s.error ? `<div class="note err" style="margin-top:10px">${esc(s.error)}</div>` : ''}
      <div class="row sch-settings" style="margin-top:12px">
        <label class="field"><span>First Formal folder no.</span>
          <input id="schFormal" class="sch-in w-num" value="${esc(s.starts.formal ?? '')}" placeholder="e.g. 3058"></label>
        <label class="field"><span>First Informal folder no.</span>
          <input id="schInformal" class="sch-in w-num" value="${esc(s.starts.informal ?? '')}" placeholder="e.g. 2620"></label>
        <label class="field"><span>Author</span>
          <input id="schAuthor" class="sch-in w-num" value="${esc(s.defaults.author)}"></label>
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
        ? ` · <b>${warned}</b> with a yellow cell to check` : ''} — hover a cell to see why.
      <b>Red</b> = required by Frappe (folder, session, type, date, format, author, duration, event type);
      <b>yellow</b> = worth a look, not required.
      Each day gets the next folder in its series; a number typed in a row is kept.
      Formal: <b>M</b> before noon, <b>E</b> from noon till next morning; <b>M1, M2</b> / <b>E1, E2</b> when a half has several.
      Informal: <b>1, 2, 3</b>.
      ${run && !run.backedUp ? `<br>Backup in progress: <b>${esc(state.scheduleRun.id)}</b> — its duration fills in when the copy finishes.` : ''}
      ${s.scan ? `<br>Durations read from <span class="mono">${esc(s.scan.root)}</span>:
        ${s.scan.filled} filled${s.scan.missing ? `, ${s.scan.missing} not on the drive` : ''}.` : ''}
      ${s.saved ? `<br>Saved to <span class="mono">${esc(s.saved)}</span>.` : ''}</div>
    ${scheduleTableHtml(problems)}` : ''}
    ${scheduleSourceHtml()}
    ${scheduleDatalists()}`;
}

function wireSchedulePage() {
  $('btnSchedule')?.addEventListener('click', () => openSchedule());
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
  const host = $('content');
  $('schClose')?.addEventListener('click', closeSchedule);
  $('schAnother')?.addEventListener('click', () => openSchedule());
  $('schDrive')?.addEventListener('click', scheduleFillFromDrive);
  $('schReveal')?.addEventListener('click', () => window.api.reveal(s.saved));
  $('schApply')?.addEventListener('click', scheduleApplyDefaults);
  for (const [id, key] of [['schFormal', 'formal'], ['schInformal', 'informal']]) {
    $(id)?.addEventListener('change', (e) => {
      const v = e.target.value.trim();
      s.starts[key] = v === '' ? undefined : Number(v);
      s.saved = null;
      scheduleRemember();
      render();
    });
  }
  for (const [id, key] of [['schCamsFormal', 'camsFormal'], ['schCamsInformal', 'camsInformal']]) {
    $(id)?.addEventListener('change', (e) => {
      const v = Number(e.target.value.trim());
      s.defaults[key] = Number.isFinite(v) && v >= 0 ? v : undefined;
      window.api.setSettings({ scheduleDefaults: s.defaults }).catch(() => {});
      scheduleRemember();
      render();
    });
  }
  host.querySelectorAll('[data-k][data-f]').forEach((el) => el.addEventListener('change', () =>
    scheduleSet(el.dataset.k, el.dataset.f, el.type === 'checkbox' ? el.checked : el.value)));
  host.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', () => scheduleDuplicate(b.dataset.dup)));
  host.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => scheduleStartBackup(b.dataset.start)));
  host.querySelector('details.sch-source')?.addEventListener('toggle', (e) => { s.showSource = e.target.open; });
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

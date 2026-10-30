'use strict';

/* Event schedule -> its own Excel sheet in the Raw Satsang Master's layout: the Sources-page card and its
 * editing panel. The schedule is read offline (OCR for pictures and PDFs, the
 * engine for Word/Excel/CSV), drafted into master rows by schedule-logic.js,
 * corrected by the operator, optionally completed with durations from the drive,
 * and saved as an .xlsx. Uses app.js's shared state, render(), call() and toast(). */

const SCHEDULE = window.VIngestSchedule;
const SCHEDULE_VOCAB = window.VIngestScheduleVocab || {};
const SCHEDULE_PICTURES = ['png', 'jpg', 'jpeg'];
const SCHEDULE_TABLES = ['docx', 'xlsx', 'xlsm', 'csv'];

function scheduleCardHtml() {
  return `<div class="card" id="scheduleDrop">
    <h3>Event schedule → Excel sheet</h3>
    <p class="hint">Turn an event's schedule into its own Excel file, laid out like the
      <b>Raw Satsang Master</b>: IDs, folder and session numbers, dates, topics, places and
      event types — one file per schedule. Pictures and PDFs
      are read on this computer (no internet, no AI); Word, Excel and CSV schedules work too.
      You check every row before saving, and durations, clip and camera counts can be filled in
      from the drive once the footage is filed.</p>
    <div class="row">
      <button class="sm primary" id="btnSchedule">Choose schedule…</button>
      <span class="hint" style="margin:0">or drop the schedule file on this card.</span>
    </div>
  </div>`;
}

function wireScheduleCard() {
  $('btnSchedule')?.addEventListener('click', () => openSchedule());
  const el = $('scheduleDrop');
  if (!el) return;
  const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); el.classList.add('dropping'); } });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('dropping'); });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    el.classList.remove('dropping');
    const file = e.dataTransfer.files[0];
    const p = file && window.api.pathForFile ? window.api.pathForFile(file) : null;
    if (p) openSchedule(p);
  });
}

async function openSchedule(file) {
  const path = file || await window.api.pickSchedule();
  if (!path) return;
  const settings = await window.api.getSettings().catch(() => ({}));
  const prev = state.schedule;
  state.schedule = {
    open: true, file: path, busy: 'Reading the schedule…', error: null,
    rows: [], read: null, sessions: [], scan: null, saved: null, showSource: false,
    memory: settings.scheduleMemory || { titles: [], places: [] },
    starts: prev ? prev.starts : { ...(settings.scheduleStarts || {}) },
    defaults: prev ? prev.defaults : { author: 'DD', format: 'HD', ...(settings.scheduleDefaults || {}) },
  };
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
    if (!s.sessions.length) {
      s.error = 'No dated sessions were found in this schedule. Check "What was read" below — '
        + 'a photo taken at an angle reads worse than the original picture.';
      s.showSource = true;
    }
  } catch (e) {
    s.error = scheduleError(e);
  } finally {
    s.busy = null;
    render();
  }
}

function closeSchedule() {
  state.schedule = null;
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
  else if (field === 'folder' || field === 'session') row[field] = String(value).trim() || null;
  else row[field] = value;
  if (field === 'session' || field === 'start') delete row.flags.session;
  delete row.flags[field];
  state.schedule.saved = null;
  render();
}

function scheduleDuplicate(key) {
  const s = state.schedule;
  const i = s.sessions.findIndex((x) => x.key === Number(key));
  if (i < 0) return;
  const copy = JSON.parse(JSON.stringify(s.sessions[i]));
  copy.key = Math.max(...s.sessions.map((x) => x.key)) + 1;
  copy.session = null;
  copy.duration = ''; copy.clips = ''; copy.cameras = '';
  copy.flags = { ...copy.flags, session: 'Added by hand — set M/E or the time.' };
  s.sessions.splice(i + 1, 0, copy);
  render();
}

function scheduleApplyDefaults() {
  const s = state.schedule;
  s.defaults.author = $('schAuthor').value.trim() || 'DD';
  s.defaults.format = $('schFormat').value;
  for (const row of s.sessions) { row.author = s.defaults.author; row.format = s.defaults.format; }
  window.api.setSettings({ scheduleDefaults: s.defaults }).catch(() => {});
  render();
}

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
    s.scan = { root: res.root, ...r, missing: r.missing.filter((x) => x.include).length };
    toast(`Filled ${r.filled} session${r.filled === 1 ? '' : 's'} from the drive`
      + (s.scan.missing ? `; ${s.scan.missing} not found` : '') + '.', s.scan.missing ? 'warn' : 'ok');
  } catch (e) {
    toast(scheduleError(e), 'err');
  }
  render();
}

async function scheduleSave() {
  const s = state.schedule;
  const rows = SCHEDULE.sheetRows(s.sessions, s.starts);
  if (!rows.length) { toast('Tick at least one session to save.', 'warn'); return; }
  if (rows.some((r) => r[0] && /\?{4}/.test(r[0]))) {
    toast('Enter the first Formal and Informal folder numbers first.', 'warn');
    return;
  }
  // Named after the schedule's dates, so each event gets a file of its own.
  const days = s.sessions.filter((x) => x.include).map((x) => x.date).sort();
  const span = days.length ? (days[0] === days[days.length - 1] ? days[0]
    : `${days[0]}_to_${days[days.length - 1]}`) : 'event';
  const target = await window.api.saveXlsx(`Event_Schedule_${span}.xlsx`);
  if (!target) return;
  try {
    const res = await call('schedule_write', { path: target, rows });
    s.saved = res.path;
    // Learn the operator's corrections and suggest the next folder numbers.
    s.memory = SCHEDULE.learn(s.memory, s.sessions);
    const nums = SCHEDULE.assignNumbers(s.sessions, s.starts);
    const next = { ...s.starts };
    for (const type of ['Formal', 'Informal']) {
      const used = s.sessions.filter((x) => x.include && x.type === type)
        .map((x) => Number((nums.get(x.key) || {}).folder)).filter(Number.isFinite);
      if (used.length) next[type === 'Formal' ? 'formal' : 'informal'] = Math.max(...used) + 1;
    }
    await window.api.setSettings({ scheduleMemory: s.memory, scheduleStarts: next });
    toast(`Saved ${rows.filter((r) => r[0]).length} sessions.`, 'ok');
  } catch (e) {
    toast(scheduleError(e), 'err');
  }
  render();
}

/* ------------------------------------------------------------ panel */

function scheduleDatalists() {
  const opts = (id, list) => `<datalist id="${id}">${(list || [])
    .filter((v) => /[a-z]/i.test(v)).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  return opts('schActivities', SCHEDULE_VOCAB.activities) + opts('schPlaces', SCHEDULE_VOCAB.places)
    + opts('schTopics', SCHEDULE_VOCAB.topics) + opts('schEvents', SCHEDULE_VOCAB.events)
    + opts('schLanguages', SCHEDULE_VOCAB.languages);
}

function scheduleTableHtml() {
  const s = state.schedule;
  const nums = SCHEDULE.assignNumbers(s.sessions, s.starts);
  const cell = (row, field, value, opts = {}) => {
    const flag = row.flags[field];
    return `<td><input class="sch-in ${opts.cls || ''} ${flag ? 'flag' : ''}" data-k="${row.key}"
      data-f="${field}" value="${esc(value ?? '')}" ${opts.list ? `list="${opts.list}"` : ''}
      ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ''}
      ${opts.type ? `type="${opts.type}"` : ''}
      title="${esc(flag || opts.title || '')}"></td>`;
  };
  const body = s.sessions.map((row) => {
    const n = nums.get(row.key) || {};
    const id = row.include ? SCHEDULE.masterId(row, n.folder, n.session) : '—';
    return `<tr class="${row.include ? '' : 'sch-off'}">
      <td><input type="checkbox" data-k="${row.key}" data-f="include" ${row.include ? 'checked' : ''}
        title="Include this session in the sheet"></td>
      <td class="mono sch-id" title="${esc(row.source || '')}">${esc(id)}</td>
      ${cell(row, 'date', row.date, { type: 'date', cls: 'w-date' })}
      <td><select class="sch-in w-type" data-k="${row.key}" data-f="type">
        ${['Formal', 'Informal'].map((t) => `<option ${row.type === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select></td>
      ${cell(row, 'folder', row.folder, { cls: 'w-num', placeholder: n.folder != null ? String(n.folder) : '' })}
      ${cell(row, 'session', row.session, { cls: 'w-num', placeholder: n.session || '' })}
      <td><select class="sch-in w-fmt" data-k="${row.key}" data-f="format">
        ${['HD', '4K', 'DV'].map((t) => `<option ${row.format === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select></td>
      ${cell(row, 'activity', row.activity, { list: 'schActivities', cls: 'w-mid' })}
      ${cell(row, 'place', row.place, { list: 'schPlaces', cls: 'w-wide',
        title: row.placeText ? `On the schedule: ${row.placeText}` : '' })}
      ${cell(row, 'topic', row.topic, { list: 'schTopics', cls: 'w-wide',
        title: `On the schedule: ${row.title}${row.subtitle ? ` — ${row.subtitle}` : ''}` })}
      ${cell(row, 'events', listText(row.events), { list: 'schEvents', cls: 'w-mid',
        title: 'Several? Separate with commas — each extra one gets its own row in the sheet.' })}
      ${cell(row, 'languages', listText(row.languages), { list: 'schLanguages', cls: 'w-lang',
        title: 'Several? Separate with commas.' })}
      ${cell(row, 'duration', row.duration, { cls: 'w-dur', title: 'Like 1h 2m 3s — or fill from the drive' })}
      ${cell(row, 'clips', row.clips, { cls: 'w-small' })}
      ${cell(row, 'cameras', row.cameras, { cls: 'w-small' })}
      <td><button class="sm ghost" data-dup="${row.key}" title="Add another session like this one">＋</button></td>
    </tr>`;
  }).join('');
  return `<div class="sch-scroll"><table class="sch-table">
    <thead><tr><th></th><th>ID</th><th>Date</th><th>Type</th><th>Folder</th><th>Session</th>
      <th>Format</th><th>Activity</th><th>Place</th><th>Topic / description</th><th>Event type</th>
      <th>Language</th><th>Duration</th><th>Clips</th><th>Cams</th><th></th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function scheduleSourceHtml() {
  const s = state.schedule;
  const rows = (s.rows || []).map((r) => `<tr><td>${r.map((c) => esc(c).replace(/\n/g, '<br>'))
    .join('</td><td>')}</td></tr>`).join('');
  const skipped = s.read && s.read.skipped.length
    ? `<p class="hint">Breaks left out: ${s.read.skipped.map((x) => esc(x.days.join(' – '))).join(', ')}</p>` : '';
  return `<details class="sch-source" ${s.showSource ? 'open' : ''}>
    <summary>What was read from the schedule (${(s.rows || []).length} lines)</summary>
    ${skipped}
    <div class="sch-scroll" style="max-height:260px"><table class="rename-table">${rows}</table></div>
  </details>`;
}

function renderScheduleModal() {
  const host = $('modal');
  const s = state.schedule;
  host.classList.add('show');
  const flagged = s.sessions.filter((r) => r.include && Object.keys(r.flags).length).length;
  const included = s.sessions.filter((r) => r.include).length;
  let body;
  if (s.busy) {
    body = `<div class="empty"><div class="big">🔎</div><div>${esc(s.busy)}</div>
      <div class="hint">Pictures are read on this computer; the first one takes a few seconds longer.</div></div>`;
  } else {
    body = `${s.error ? `<div class="note err">${esc(s.error)}</div>` : ''}
      <div class="row sch-settings">
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
      </div>
      ${s.sessions.length ? `<div class="note ${flagged ? 'warn' : 'ok'}" style="margin:10px 0">
        <b>${included}</b> session${included === 1 ? '' : 's'} ticked${flagged
          ? ` · <b>${flagged}</b> with a highlighted cell to check (hover it to see why)` : ''}.
        Each day gets the next folder number in its series; a number typed in a row is kept.
        ${s.scan ? `<br>Durations read from <span class="mono">${esc(s.scan.root)}</span>:
          ${s.scan.filled} filled${s.scan.missing ? `, ${s.scan.missing} not on the drive` : ''}.` : ''}
        ${s.saved ? `<br>Saved to <span class="mono">${esc(s.saved)}</span>.` : ''}</div>
      ${scheduleTableHtml()}` : ''}
      ${scheduleSourceHtml()}
      ${scheduleDatalists()}`;
  }
  host.innerHTML = `<div class="modal-backdrop" data-close="1">
    <div class="modal-panel full" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div><h3 style="margin:0">Event schedule → Excel sheet</h3>
          <div class="path" style="margin-top:4px">${esc(s.file || '')}</div></div>
        <div class="spacer"></div>
        <button class="sm ghost" id="schClose" ${s.busy ? 'disabled' : ''}>Close</button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">
        <button class="sm" id="schAnother" ${s.busy ? 'disabled' : ''}>Read another schedule…</button>
        <button class="sm" id="schDrive" ${s.busy || !s.sessions.length ? 'disabled' : ''}
          title="Read durations, clip and camera counts from the filed session folders">Fill durations from drive…</button>
        <div class="spacer"></div>
        ${s.saved ? '<button class="sm ghost" id="schReveal">Show saved file</button>' : ''}
        <button class="primary" id="schSave" ${s.busy || !included ? 'disabled' : ''}>Save .xlsx…</button>
      </div>
    </div>
  </div>`;

  $('schClose')?.addEventListener('click', closeSchedule);
  $('schAnother')?.addEventListener('click', () => openSchedule());
  $('schDrive')?.addEventListener('click', scheduleFillFromDrive);
  $('schSave')?.addEventListener('click', scheduleSave);
  $('schReveal')?.addEventListener('click', () => window.api.reveal(s.saved));
  $('schApply')?.addEventListener('click', scheduleApplyDefaults);
  for (const [id, key] of [['schFormal', 'formal'], ['schInformal', 'informal']]) {
    $(id)?.addEventListener('change', (e) => {
      const v = e.target.value.trim();
      s.starts[key] = v === '' ? undefined : Number(v);
      s.saved = null;
      render();
    });
  }
  host.querySelectorAll('[data-k][data-f]').forEach((el) => el.addEventListener('change', () =>
    scheduleSet(el.dataset.k, el.dataset.f, el.type === 'checkbox' ? el.checked : el.value)));
  host.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', () => scheduleDuplicate(b.dataset.dup)));
  host.querySelector('details.sch-source')?.addEventListener('toggle', (e) => { s.showSource = e.target.open; });
}

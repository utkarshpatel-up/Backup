'use strict';

/* Report: every session on record — the existing data (the master sheet, or a
 * download of Frappe's Raw Video Data Report) plus the rows of every event
 * schedule — in one grid laid out like Frappe's report, with its filters. Holes
 * in the folder numbering (and Informal session numbers missing in a folder)
 * are called out in yellow. Uses app.js's shared state, render(), call(), toast()
 * and schedule-ui.js's assignments and city list. */

const REPORT_PAGE = 300;

// Frappe's filter panel, in its order: [key, label, kind].
const REPORT_FILTERS = [
  ['year', 'Year', 'text'], ['activity', 'Activity', 'menu'], ['country', 'Country', 'text'],
  ['state', 'State', 'text'], ['city', 'City', 'text'], ['place', 'Place Details', 'text'],
  ['events', 'Event Type', 'text'], ['topic', 'Topic/Description', 'text'], ['languages', 'Language', 'text'],
  ['type', 'Satsang Type', 'select:Formal,Informal'], ['folderFrom', 'Folder From', 'text'],
  ['folderTo', 'Folder To', 'text'], ['dateFrom', 'Date From', 'date'], ['dateTo', 'Date To', 'date'],
  ['author', 'Author', 'menu'], ['format', 'Format', 'select:HD,4K,DV'],
  ['source', 'Source', 'select:Existing data,Event schedule,In both'],
];

/** Where a record came from, as the Source filter names it. */
const reportSource = (rec) => (rec.source !== 'schedule' ? 'Existing data'
  : rec.alsoExisting ? 'In both' : 'Event schedule');

// The grid: [column key, header]; ID and Folder are frozen.
const REPORT_COLUMNS = [
  ['year', 'Year'], ['month', 'M'], ['day', 'D'], ['activity', 'Activity'], ['author', 'Author'],
  ['format', 'Format'], ['type', 'Satsang Type'], ['city', 'City'], ['state', 'State'], ['country', 'Country'],
  ['place', 'Place Detail'], ['session', 'Session'], ['events', 'Event Type'], ['topic', 'Topic/Description'],
  ['languages', 'Language'], ['duration', 'Duration'], ['clips', 'No of clips'], ['cameras', 'No of cameras'],
  ['remarks', 'Remarks'],
];

function reportState() {
  if (!state.report) state.report = { file: null, existing: null, loading: false, error: null, filters: {}, columns: {}, limit: REPORT_PAGE };
  // This computer's local-mode corrections never overlay the team's report (team edits live in the record).
  if (!state.report.edits) state.report.edits = typeof syncAccount === 'function' && syncAccount() ? {} : reportLoadEdits();
  return state.report;
}

// Cells of existing data the operator corrected. Local mode: {ID: {field: text}}, kept on this computer.
// Team mode: the team's record is changed itself and lists its corrected cells in `edited`, so it syncs.
const REPORT_EDITS_KEY = 'avb.reportEdits';
const REPORT_EDITABLE = new Set(['activity', 'author', 'format', 'type', 'city', 'state', 'country', 'place', 'session',
  'events', 'topic', 'languages', 'duration', 'clips', 'cameras', 'remarks']);
const REPORT_LIST_FIELDS = new Set(['events', 'languages']);
let reportEditRev = 0;
function reportLoadEdits() {
  try { const e = JSON.parse(localStorage.getItem(REPORT_EDITS_KEY) || '{}'); return e && typeof e === 'object' ? e : {}; } catch (_) { return {}; }
}
function reportEdit(id, key, text) {
  const r = reportState();
  const rec = (r.existing || []).find((x) => x.id === id);
  if (!rec || !REPORT_EDITABLE.has(key)) return;
  const value = REPORT_LIST_FIELDS.has(key) ? text.split(/[,;]/).map((v) => v.trim()).filter(Boolean) : text.trim();
  if (typeof syncAccount === 'function' && syncAccount()) {
    // Team mode: the change goes into the team's copy and uploads like any other edit.
    if (!syncAvailable()) { toast('Sign in under Account to edit the team report.', 'warn'); return; }
    const shown = String(Array.isArray(value) ? value.join(', ') : value);
    if (String(reportValue(rec, key)) === shown) return;
    // `edited` maps each corrected cell to the text it had before, so editing it back can un-mark it.
    const was = { ...(rec.edited && !Array.isArray(rec.edited) ? rec.edited : {}) };
    // Clipped to the server's 2000-char limit (a long list cell could exceed it and stall syncing).
    if (!(key in was)) was[key] = String(reportValue(rec, key)).slice(0, 2000);
    const back = was[key] === shown;
    if (back) delete was[key];
    const next = { ...rec, [key]: value };
    if (Object.keys(was).length) next.edited = was; else delete next.edited;
    r.existing = r.existing.map((x) => (x === rec ? next : x));
    reportEditRev++;
    scheduleRemember();
    render();
    return;
  }
  const same = String(reportValue(rec, key)) === String(Array.isArray(value) ? value.join(', ') : value);
  const mine = r.edits[id] || (r.edits[id] = {});
  if (same) delete mine[key]; else mine[key] = value;
  if (!Object.keys(mine).length) delete r.edits[id];
  reportEditRev++;
  try { localStorage.setItem(REPORT_EDITS_KEY, JSON.stringify(r.edits)); } catch (_) { /* kept for this session only */ }
  render();
}

/* ------------------------------------------------- one record's history */

// "NAME changed value of FIELD from A to B", one line per field a version changed.
const HISTORY_FIELDS = { date: 'Date', type: 'Satsang Type', activity: 'Activity', place: 'Place Detail', city: 'City', topic: 'Topic/Description',
  events: 'Event Type', languages: 'Language', author: 'Author', format: 'Format', duration: 'Duration', clips: 'No of clips',
  cameras: 'No of cameras', folder: 'Folder', session: 'Session', remarks: 'Remarks', state: 'State', country: 'Country', include: 'Included' };
const historyText = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
/** One version {by, mine, action, payload, previous} of a report_record or session -> lines. */
function historyLines(h, type) {
  const who = h.mine ? 'You' : h.by || 'A team member';
  const p = h.payload || {}, prev = h.previous || {};
  if (h.action === 'delete') return [`${who} deleted it`];
  if (h.action === 'restore') return [`${who} restored it`];
  if (h.action === 'create' || !h.previous) return [`${who} ${type === 'report_record' ? 'imported it from Excel' : 'added it in the event schedule'}`];
  const out = [];
  for (const [k, label] of Object.entries(HISTORY_FIELDS)) {
    const a = historyText(prev[k]), b = historyText(p[k]);
    if (a !== b) out.push(`${who} changed value of ${label} from "${a}" to "${b}"`);
  }
  if (!out.length && prev.edited && !p.edited) out.push(`${who} marked it as uploaded to Frappe`);
  return out;
}
async function showRecordHistory(type, key, id) {
  const h = { type, key, id, items: null, error: '' };
  state.recordHistory = h;
  state.view = 'history';
  render();
  try { h.items = await window.api.sync.recordHistory(type, key); }
  catch (e) { h.error = e && e.message ? e.message : 'The history could not be loaded.'; }
  if (state.recordHistory === h && state.view === 'history') render();
}
function recordHistoryHtml() {
  const h = state.recordHistory;
  const lines = (h.items || []).flatMap((it) => historyLines(it, h.type).map((t) => `<li>${esc(t)} <span class="hint">— ${esc(fmtTime(it.at))}</span></li>`));
  const body = h.error ? `<div class="note err">${esc(h.error)}</div>`
    : h.items == null ? '<p class="hint">Loading…</p>'
      : lines.length ? `<ul class="sync-history">${lines.join('')}</ul>` : '<p class="hint">No changes on the team server yet.</p>';
  return `<div class="card"><h3 class="mono" style="margin:0 0 4px">${esc(h.id)}</h3>
    <p class="hint" style="margin:0 0 8px">${h.type === 'session' ? 'Added from an event schedule' : 'Report entry'} · every change by the team, newest first</p>${body}</div>`;
}

/** Orange (edited), purple and blue (schedule) rows as an .xlsx ready to upload to Frappe. */
function reportExportFrappe() {
  const rows = reportRecords().all.filter((rec) => rec.source === 'schedule' || rec.edited?.size);
  return reportExport(rows, 'Frappe_Upload');
}

/** After the rows are in Frappe: take the orange off every corrected entry, for the whole team. */
async function reportMarkUploaded() {
  const r = reportState();
  const marked = (r.existing || []).filter((x) => x.edited && Object.keys(x.edited).length).length;
  if (!marked) return;
  if (!syncAvailable()) { toast('Sign in under Account first.', 'warn'); return; }
  const ok = await window.api.confirm({ message: `Mark ${marked} corrected entr${marked === 1 ? 'y' : 'ies'} as uploaded to Frappe?`,
    detail: 'The orange is removed on every computer, and Save as Excel no longer includes them. The corrected values stay.', confirmLabel: 'Mark as uploaded' });
  if (!ok) return;
  r.existing = r.existing.map((x) => { if (!x.edited) return x; const { edited, ...rest } = x; void edited; return rest; });
  reportEditRev++;
  scheduleRemember();
  toast(`${marked} entr${marked === 1 ? 'y' : 'ies'} marked as uploaded.`, 'ok');
  render();
}

/** Save the entries the filters leave as an .xlsx, which can be chosen again later as the existing data. */
async function reportExport(only, prefix = 'Raw_Video_Report') {
  const r = reportState();
  const records = only || reportShown(reportRecords().all);
  if (!records.length) { toast(only ? 'Nothing to save — no edited or scheduled rows yet.' : 'Nothing to export — no entries match these filters.', 'warn'); return; }
  const day = new Date().toISOString().slice(0, 10);
  const filtered = !only && records.length < reportRecords().all.length;
  const target = await window.api.saveXlsx(`${prefix}_${day}${filtered ? '_filtered' : ''}.xlsx`, only ? 'Save the rows for Frappe' : 'Export the report entries');
  if (!target) return;
  try {
    const sheet = SCHEDULE.reportSheet(records);
    const res = await call('report_write', { path: target, columns: sheet.columns, rows: sheet.rows });
    r.exported = res.path;
    toast(`Exported ${records.length.toLocaleString()} entries.`, 'ok');
  } catch (e) {
    toast(scheduleError(e), 'err');
  }
  render();
}

/** Read the existing-data file the operator chose (remembered in settings). */
async function reportLoad(file) {
  if (typeof syncAccount === 'function' && syncAccount()) return;
  const r = reportState();
  r.file = file;
  r.loading = true;
  r.error = null;
  render();
  try {
    const rows = (await call('schedule_read_table', { path: file })).rows;
    r.existing = SCHEDULE.parseReport(rows, scheduleCities());
    if (!r.existing.length) throw new Error('No Raw Video Id / ID column was found in that file.');
  } catch (e) {
    r.existing = null;
    r.error = scheduleError(e);
  } finally {
    r.loading = false;
    render();
  }
}

async function reportChooseFile() {
  const account = typeof syncAccount === 'function' && syncAccount();
  if (account && !syncAvailable()) { toast('Sign in under Account first, then import the file.', 'warn'); await showSync(); return; }
  const file = await window.api.pickTable('Choose the existing data: the Raw Satsang Master, or a download of the Raw Video Data Report');
  if (!file) return;
  await window.api.setSettings({ reportSource: file }).catch(() => {});
  if (!account) { await reportLoad(file); return; }
  // Team mode: preview, confirm, then queue every record for upload (syncImport in sync-ui.js).
  try { await syncImport(); toast('Import queued. The records upload in the background; see Account for progress.', 'ok'); }
  catch (e) { toast(e && e.message ? e.message : 'The import could not be completed.', 'err'); }
  render();
}

/** At start-up: read the remembered existing data in the background, so its
 * topics and places are offered on the schedule page too. */
async function reportPreload() {
  if (typeof syncAccount === 'function' && syncAccount()) return;
  const r = reportState();
  if (r.existing || r.loading) return;
  const settings = await window.api.getSettings().catch(() => ({}));
  if (settings.reportSource) await reportLoad(settings.reportSource);
}

/** Opening the page: read the remembered file the first time. */
async function showReport() {
  if (state.busy) { toast('Wait for the current task to finish, or press Cancel.', 'warn'); return; }
  state.view = 'report';
  const r = reportState();
  render();
  if (!(typeof syncAccount === 'function' && syncAccount()) && !r.existing && !r.loading && !r.error) {
    const settings = await window.api.getSettings().catch(() => ({}));
    if (settings.reportSource) await reportLoad(settings.reportSource);
  }
}

/** Every record: existing data, then each schedule's ticked rows over it. */
let reportMemo = null;
function reportRecords() {
  const r = reportState();
  const cities = scheduleCities();
  const items = ((state.schedules && state.schedules.items) || []).filter((item) => !item.busy);
  // Schedule rows are edited in place, so the memo is keyed by their content, not identity.
  const key = JSON.stringify(items.map((item) => [item.sessions, item.starts, item.file])) + `|${reportEditRev}`;
  if (reportMemo && reportMemo.existing === r.existing && reportMemo.cities === cities && reportMemo.key === key) return reportMemo.value;
  const scheduled = [];
  for (const item of items) scheduled.push(...SCHEDULE.scheduleRecords(item.sessions, item.starts, cities, scheduleRange(item)));
  const existing = (r.existing || []).map((rec) => (r.edits[rec.id] ? { ...rec, ...r.edits[rec.id], edited: new Set(Object.keys(r.edits[rec.id])) }
    : rec.edited ? { ...rec, edited: new Set(Array.isArray(rec.edited) ? rec.edited : Object.keys(rec.edited)) } : rec));
  const all = SCHEDULE.mergeReport(existing, scheduled);
  reportMemo = { existing: r.existing, cities, key, value: { all, scheduled: scheduled.length, gaps: SCHEDULE.findGaps(all) } };
  return reportMemo.value;
}

function reportValue(rec, key) {
  if (key === 'year') return (rec.date || '').slice(0, 4);
  if (key === 'month') return rec.date ? String(+rec.date.slice(5, 7)) : '';
  if (key === 'day') return rec.date ? String(+rec.date.slice(8, 10)) : '';
  const v = rec[key];
  return Array.isArray(v) ? v.join(', ') : v ?? '';
}

/** The records the filters and column filters leave. */
function reportShown(all) {
  const r = reportState();
  // Column filters match what the cell shows, so Year/M/D filter as written.
  const { source: wantSource, ...frappeFilters } = r.filters;
  return SCHEDULE.filterReport(all, frappeFilters)
    .filter((rec) => !wantSource || reportSource(rec) === wantSource
      || (wantSource === 'Event schedule' && rec.source === 'schedule'))
    .filter((rec) => Object.entries(r.columns).every(([k, q]) => !String(q || '').trim()
      || String(k === 'id' ? rec.id : k === 'folder' ? rec.folder : reportValue(rec, k)).toLowerCase()
        .includes(String(q).trim().toLowerCase())));
}

/** The page as paint regions. The filter boxes' typed values stay out of it: they are the DOM's to keep. */
function reportRegions() {
  const r = reportState();
  const { all, scheduled, gaps } = reportRecords();
  const shown = reportShown(all);
  const page = shown.slice(0, r.limit);
  // A gap's yellow line goes under the last listed row of the folder it sits below.
  const lastOf = new Map();
  page.forEach((rec, i) => lastOf.set(`${SCHEDULE.seriesOf(rec)}|${rec.folder}`, i));
  const gapAt = new Map();
  for (const g of gaps) {
    const i = lastOf.get(`${g.series}|${g.after}`);
    if (i == null) continue;
    if (!gapAt.has(i)) gapAt.set(i, []);
    gapAt.get(i).push(g.text);
  }
  const width = REPORT_COLUMNS.length + 2;
  const team = typeof syncAccount === 'function' && syncAccount();
  const rows = page.flatMap((rec, i) => {
    // Schedule rows are blue; one that replaces an entry already in the existing
    // data (same ID) is purple and labelled, so it can't be taken for a new one.
    const both = rec.source === 'schedule' && rec.alsoExisting;
    const tag = rec.source !== 'schedule' ? ''
      : both ? '<span class="rep-tag both">Schedule · replaces existing</span>'
        : '<span class="rep-tag sch">Schedule</span>';
    const edited = rec.source !== 'schedule' && rec.edited?.size;
    const hist = team && (rec.source === 'schedule' ? rec.uid && ['session', rec.uid] : edited && ['report_record', rec.id.trim().toUpperCase()]);
    const idText = hist ? `<button type="button" class="rep-hist" data-hist-type="${hist[0]}" data-hist-key="${esc(hist[1])}" data-hist-id="${esc(rec.id)}"
        title="Show every change to this entry">${esc(rec.id)}</button>` : esc(rec.id);
    const row = `<tr data-id="${esc(rec.id)}" class="${both ? 'rep-both' : rec.source === 'schedule' ? 'rep-sch' : ''}">
      <td class="fz rz1 mono${edited ? ' rep-edit-id' : ''}" title="${esc(rec.source === 'schedule'
        ? `From the event schedule ${rec.schedule}${both ? '. The existing data has an entry with this ID too; this row shows the version from the schedule.' : ''}${rec.backedUp ? ' · backed up' : ''}`
        : edited ? 'Existing data, corrected (orange cells)' : 'Existing data')}"><div class="rep-id">${idText}${tag}</div></td>
      <td class="fz rz2">${esc(rec.folder ?? '')}</td>
      ${REPORT_COLUMNS.map(([k]) => {
        const v = reportValue(rec, k);
        const canEdit = rec.source !== 'schedule' && REPORT_EDITABLE.has(k);
        return `<td class="c-${k}${rec.edited?.has(k) ? ' rep-edit' : ''}${canEdit ? ' rep-ed' : ''}" data-k="${k}"${String(v).length > 20 ? ` title="${esc(v)}"` : ''}>${esc(v)}</td>`;
      }).join('')}</tr>`;
    return [row, ...(gapAt.get(i) || []).map((t) => `<tr class="rep-gap"><td colspan="${width}">⚠ ${esc(t)}</td></tr>`)];
  });
  if (!rows.length) rows.push(`<tr><td colspan="${width}" class="hint" style="padding:14px">Nothing matches these filters.</td></tr>`);
  const account = typeof syncAccount === 'function' && syncAccount();
  const source = r.loading ? '<span class="hint" style="margin:0">Reading the existing data…</span>'
    : r.existing ? `<span class="mono" title="${esc(r.file)}">${esc(String(r.file).split(/[\\/]/).pop())}</span>
        · <b>${r.existing.length.toLocaleString()}</b> sessions`
      : '<span class="hint" style="margin:0">No existing data chosen yet — only the event schedules are listed.</span>';
  return {
    title: `<div style="flex:1 1 320px;min-width:0"><h3 style="margin:0">Raw Video Data Report</h3>
          <div class="hint" style="margin:4px 0 0">Existing data: ${source} · Event schedules: <b>${scheduled}</b> sessions</div></div>
        <button class="sm" id="repFrappe" title="Open the Frappe report site">Frappe Report</button>
        <button class="sm" id="repFile">${account ? 'Import file to team…' : r.existing ? 'Change file…' : 'Choose existing data…'}</button>
        ${r.file && !account ? '<button class="sm ghost" id="repReload" title="Read the file again">Refresh</button>' : ''}`,
    export: `<button class="sm" id="repExport" ${shown.length ? '' : 'disabled'}
          title="Save the entries these filters leave as an .xlsx. It can be chosen again later as the existing data.">Export ${shown.length.toLocaleString()} entries…</button>`,
    tail: `${account && all.some((x) => x.edited?.size) ? '<button class="sm" id="repUploaded" title="After uploading to Frappe: remove the orange on every computer">Mark as uploaded</button>' : ''}
      <button class="sm" id="repFrappeXlsx" title="Save every orange (edited), purple and blue (schedule) row as an .xlsx to upload to Frappe">Save as Excel</button>
      ${r.exported ? '<button class="sm ghost" id="repExported">Show exported file</button>' : ''}`,
    error: (r.error ? `<div class="note err" style="margin-top:10px">${esc(r.error)}</div>` : '')
      + (account && syncUI.status.failed?.length ? `<div class="note err" style="margin-top:10px">${syncUI.status.failed.length} change${syncUI.status.failed.length === 1 ? '' : 's'}
        could not be uploaded, so other computers do not have ${syncUI.status.failed.length === 1 ? 'it' : 'them'}. The team server may need updating; see Account.</div>` : ''),
    filters: reportFiltersHtml(all, {}),
    gaps: gaps.length ? `<div class="rep-gaps"><b>${gaps.length} gap${gaps.length === 1 ? '' : 's'} in the numbering:</b>
      ${gaps.slice(0, 12).map((g) => esc(g.text)).join(' · ')}${gaps.length > 12 ? ` · and ${gaps.length - 12} more` : ''}</div>` : '',
    count: `${shown.length.toLocaleString()} record${shown.length === 1 ? '' : 's'}${shown.length < all.length ? ` of ${all.length.toLocaleString()}` : ''}`,
    thead: reportHeadHtml({}),
    rows,
    more: shown.length > page.length ? `<div class="row" style="margin-top:8px">
      <button class="sm" id="repMore">Show ${Math.min(REPORT_PAGE, shown.length - page.length)} more</button>
      <span class="hint" style="margin:0">${page.length.toLocaleString()} of ${shown.length.toLocaleString()} shown</span></div>` : '',
  };
}

/** The filter panel, with `values` in its boxes. */
function reportFiltersHtml(all, values) {
  return REPORT_FILTERS.map(([k, label, kind]) => {
    const v = values[k] ?? '';
    const list = REPORT_LISTS.includes(k) ? ` list="repList_${k}"` : '';
    if (kind === 'menu') {
      // A short list (Activity, Author): every value in the data, in a menu.
      const options = reportMenu(all, k);
      return `<select class="sch-in rep-f" data-filter="${k}" aria-label="${label}"><option value="">${label}</option>
        ${options.map((o) => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    }
    if (kind.startsWith('select:')) {
      return `<select class="sch-in rep-f" data-filter="${k}" aria-label="${label}"><option value="">${label}</option>
        ${kind.slice(7).split(',').map((o) => `<option ${v === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    }
    if (kind === 'date') {
      return `<input class="sch-in rep-f" data-filter="${k}" aria-label="${label}" placeholder="${label} (dd/mm/yyyy)"
        value="${esc(v ? SCHEDULE.toIndian(v) : '')}">`;
    }
    return `<input class="sch-in rep-f" data-filter="${k}" aria-label="${label}" placeholder="${label}" value="${esc(v)}"${list}>`;
  }).join('');
}

/** A menu's values, worked out once per set of records. */
const reportMenus = new WeakMap();
function reportMenu(all, k) {
  if (!reportMenus.has(all)) reportMenus.set(all, {});
  const menus = reportMenus.get(all);
  if (!menus[k]) menus[k] = pickValues(all.map((rec) => rec[k]), k === 'activity' ? SCHEDULE_VOCAB.activities : []);
  return menus[k];
}

/** The column headers, with `values` in their filter boxes. */
function reportHeadHtml(values) {
  return `<tr>${resizableTh('id', 'Raw Video Id', 'fz rz1')}${resizableTh('folder', 'Folder', 'fz rz2')}
          ${REPORT_COLUMNS.map(([k, h]) => resizableTh(k, h)).join('')}</tr>
        <tr class="rep-colf"><th class="fz rz1"><input class="sch-in" data-col="id" aria-label="Filter Raw Video Id" value="${esc(values.id || '')}"></th>
          <th class="fz rz2"><input class="sch-in" data-col="folder" aria-label="Filter Folder" value="${esc(values.folder || '')}"></th>
          ${REPORT_COLUMNS.map(([k, h]) => `<th class="c-${k}"><input class="sch-in" data-col="${k}" aria-label="Filter ${h}" value="${esc(values[k] || '')}"></th>`).join('')}</tr>`;
}

function renderReportPage(regions = reportRegions()) {
  const r = reportState();
  return `<div class="card">
      <div class="row" style="align-items:center;flex-wrap:wrap">
        <div class="region" data-region="title">${regions.title}</div>
        <div class="region" data-region="export">${regions.export}</div>
        <div class="region" data-region="tail">${regions.tail}</div>
      </div>
      <div data-region="error">${regions.error}</div>
      <div class="rep-filters" data-region="filters">${reportFiltersHtml(reportRecords().all, r.filters)}</div>
    </div>
    <div data-region="gaps">${regions.gaps}</div>
    <div class="rep-count" data-region="count" role="status">${regions.count}</div>
    <div class="sch-scroll rep-scroll"><table class="sch-table rep-table">
      <thead data-region="thead">${reportHeadHtml(r.columns)}</thead>
      <tbody data-region="rows">${regions.rows.join('')}</tbody>
    </table></div>
    <div data-region="more">${regions.more}</div>`;
}

/** Draw the page, touching only what these records and filters change. */
function reportPaint() {
  const regions = reportRegions();
  PAINT.paint($('content'), reportState(), regions, {
    full: () => renderReportPage(regions), wire: wireReportPage,
    rewire: (fresh) => fresh.forEach(wireReportButtons),
    structural: ['title', 'tail', 'error', 'filters', 'thead'],
  });
}

// Filters that offer the values in the data to pick from.
const REPORT_LISTS = ['activity', 'country', 'state', 'city', 'place', 'events', 'topic', 'languages', 'author'];

/** The filters' pick-lists: every value in the report (and the city list). */
function reportDatalists(all) {
  if (reportDatalists.from === all) return;
  reportDatalists.from = all;
  const values = (k) => all.map((rec) => rec[k]);
  const cities = scheduleCities();
  const extra = { city: cities.map((c) => c.city), state: cities.map((c) => c.state),
    country: cities.map((c) => c.country), activity: SCHEDULE_VOCAB.activities,
    events: SCHEDULE_VOCAB.events, languages: SCHEDULE_VOCAB.languages };
  for (const k of REPORT_LISTS) setDatalist(`repList_${k}`, pickValues(values(k), extra[k]));
}

/** The two buttons a filter change redraws. */
function wireReportButtons(root) {
  root.querySelector('#repExport')?.addEventListener('click', () => reportExport());
  root.querySelector('#repFrappeXlsx')?.addEventListener('click', reportExportFrappe);
  root.querySelector('#repUploaded')?.addEventListener('click', () => reportMarkUploaded().catch((e) => toast(e?.message || 'Could not mark as uploaded.', 'err')));
  root.querySelector('#repMore')?.addEventListener('click', () => { reportState().limit += REPORT_PAGE; render(); });
}

let reportFilterTimer = null;
function wireReportPage() {
  const r = reportState();
  reportDatalists(reportRecords().all);
  wireColumnResize(document.querySelector('.rep-table'), 'report');
  $('repFile')?.addEventListener('click', reportChooseFile);
  $('repFrappe')?.addEventListener('click', () => window.api.openFrappe());
  $('repReload')?.addEventListener('click', () => reportLoad(r.file));
  wireReportButtons($('content'));
  // A blue, purple or orange row's Raw Video ID opens that entry's history.
  document.querySelector('.rep-table tbody')?.addEventListener('click', (e) => {
    const b = e.target.closest('button.rep-hist');
    if (b) showRecordHistory(b.dataset.histType, b.dataset.histKey, b.dataset.histId);
  });
  // Double-click a cell of the existing data to correct it; Enter or leaving the box saves, Esc cancels.
  document.querySelector('.rep-table tbody')?.addEventListener('dblclick', (e) => {
    const td = e.target.closest('td.rep-ed');
    if (!td || td.querySelector('input')) return;
    const id = td.parentElement.dataset.id, k = td.dataset.k, old = td.textContent;
    const input = Object.assign(document.createElement('input'), { className: 'sch-in rep-in', value: old });
    td.textContent = ''; td.appendChild(input); input.focus(); input.select();
    let done = false;
    // The old text goes back first: a no-op edit repaints nothing, so the cell must not keep the box.
    const finish = (save) => { if (done) return; done = true; td.textContent = old; if (save && input.value !== old) reportEdit(id, k, input.value); };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') finish(true); else if (ev.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
  });
  $('repExported')?.addEventListener('click', () => window.api.reveal(r.exported));
  // Every filter applies by itself: menus and picked values at once, typing
  // after a short pause. A date counts only once it is a whole dd/mm/yyyy (or
  // emptied), so a half-typed date never empties the list.
  const apply = (el) => {
    const k = el.dataset.filter;
    const v = el.value.trim();
    let next = v;
    if (k === 'dateFrom' || k === 'dateTo') {
      // A four-digit year only: "01/10/20" is still being typed, not 2020.
      next = /^\d{1,2}[./-]\d{1,2}[./-]\d{4}$|^\d{4}-\d{2}-\d{2}$/.test(v) ? SCHEDULE.fromIndian(v) : null;
      if (next == null) { if (v) return; next = ''; }
    }
    if ((r.filters[k] ?? '') === next) return;
    r.filters[k] = next;
    r.limit = REPORT_PAGE;
    render();
  };
  document.querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('change', () => { clearTimeout(reportFilterTimer); apply(el); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(reportFilterTimer); apply(el); } });
    if (el.tagName !== 'SELECT') {
      el.addEventListener('input', () => {
        clearTimeout(reportFilterTimer);
        reportFilterTimer = setTimeout(() => apply(el), 300);
      });
    }
    openPickerOnClick(el);
  });
  // The filter under each column header narrows as you type.
  document.querySelectorAll('[data-col]').forEach((el) => el.addEventListener('input', () => {
    r.columns[el.dataset.col] = el.value;
    r.limit = REPORT_PAGE;
    clearTimeout(reportFilterTimer);
    reportFilterTimer = setTimeout(render, 250);
  }));
}

function reportFooterHtml() {
  return `<button id="repBack">← Event schedule</button><div class="spacer"></div>
    <span class="hint" style="margin:0"><span class="rep-tag sch">Schedule</span> from an event schedule ·
      <span class="rep-tag both">Schedule · replaces existing</span> same ID as an existing entry, schedule's version shown ·
      yellow lines mark gaps in the numbering</span>`;
}

function wireReportFooter() {
  $('repBack')?.addEventListener('click', showSchedule);
}

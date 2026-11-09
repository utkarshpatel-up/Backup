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
];

function reportState() {
  if (!state.report) state.report = { file: null, existing: null, loading: false, error: null, filters: {}, columns: {}, limit: REPORT_PAGE };
  return state.report;
}

/** Save the entries the filters leave as an .xlsx, which can be chosen again later as the existing data. */
async function reportExport() {
  const r = reportState();
  const records = reportShown(reportRecords().all);
  if (!records.length) { toast('Nothing to export — no entries match these filters.', 'warn'); return; }
  const day = new Date().toISOString().slice(0, 10);
  const filtered = records.length < reportRecords().all.length;
  const target = await window.api.saveXlsx(`Raw_Video_Report_${day}${filtered ? '_filtered' : ''}.xlsx`, 'Export the report entries');
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
  const key = JSON.stringify(items.map((item) => [item.sessions, item.starts, item.file]));
  if (reportMemo && reportMemo.existing === r.existing && reportMemo.cities === cities && reportMemo.key === key) return reportMemo.value;
  const scheduled = [];
  for (const item of items) scheduled.push(...SCHEDULE.scheduleRecords(item.sessions, item.starts, cities, scheduleRange(item)));
  const all = SCHEDULE.mergeReport(r.existing || [], scheduled);
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
  const rows = page.flatMap((rec, i) => {
    // Schedule rows are blue; one that replaces an entry already in the existing
    // data (same ID) is purple and labelled, so it can't be taken for a new one.
    const both = rec.source === 'schedule' && rec.alsoExisting;
    const tag = rec.source !== 'schedule' ? ''
      : both ? '<span class="rep-tag both">Schedule · replaces existing</span>'
        : '<span class="rep-tag sch">Schedule</span>';
    const row = `<tr class="${both ? 'rep-both' : rec.source === 'schedule' ? 'rep-sch' : ''}">
      <td class="fz rz1 mono" title="${esc(rec.source === 'schedule'
        ? `From the event schedule ${rec.schedule}${both ? '. The existing data has an entry with this ID too; this row shows the version from the schedule.' : ''}${rec.backedUp ? ' · backed up' : ''}`
        : 'Existing data')}"><div class="rep-id">${esc(rec.id)}${tag}</div></td>
      <td class="fz rz2">${esc(rec.folder ?? '')}</td>
      ${REPORT_COLUMNS.map(([k]) => {
        const v = reportValue(rec, k);
        return `<td class="c-${k}"${String(v).length > 20 ? ` title="${esc(v)}"` : ''}>${esc(v)}</td>`;
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
        <button class="sm" id="repFile">${account ? 'Import file to team…' : r.existing ? 'Change file…' : 'Choose existing data…'}</button>
        ${r.file && !account ? '<button class="sm ghost" id="repReload" title="Read the file again">Refresh</button>' : ''}`,
    export: `<button class="sm" id="repExport" ${shown.length ? '' : 'disabled'}
          title="Save the entries these filters leave as an .xlsx. It can be chosen again later as the existing data.">Export ${shown.length.toLocaleString()} entries…</button>`,
    tail: `${r.exported ? '<button class="sm ghost" id="repExported">Show exported file</button>' : ''}`,
    error: r.error ? `<div class="note err" style="margin-top:10px">${esc(r.error)}</div>` : '',
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
  root.querySelector('#repExport')?.addEventListener('click', reportExport);
  root.querySelector('#repMore')?.addEventListener('click', () => { reportState().limit += REPORT_PAGE; render(); });
}

let reportFilterTimer = null;
function wireReportPage() {
  const r = reportState();
  reportDatalists(reportRecords().all);
  wireColumnResize(document.querySelector('.rep-table'), 'report');
  $('repFile')?.addEventListener('click', reportChooseFile);
  $('repReload')?.addEventListener('click', () => reportLoad(r.file));
  wireReportButtons($('content'));
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

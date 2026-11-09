async ({ iterations }) => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const frame = () => new Promise((r) => { const t = setTimeout(r, 100); requestAnimationFrame(() => { clearTimeout(t); setTimeout(r, 0); }); });
  const settle = async () => { await frame(); await frame(); };
  const layout = () => void document.body.offsetHeight;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const content = document.getElementById('content');
  // Wait until `done()` holds after DOM mutations: the first frame the change is on the page.
  const changed = (done) => new Promise((resolve, reject) => {
    if (done()) return resolve();
    const ob = new MutationObserver(() => { if (done()) { ob.disconnect(); clearTimeout(to); resolve(); } });
    ob.observe(document.getElementById('content'), { subtree: true, childList: true, characterData: true, attributes: true });
    const to = setTimeout(() => { ob.disconnect(); reject(new Error('scenario change never happened: ' + JSON.stringify({view: state.view, sv: state.schedule?.sessions?.[150]?.place, dom: document.querySelector('tr[data-row="770151"] [data-f="place"]')?.value, tag: document.querySelector('tr[data-row="770151"] [data-f="place"]')?.tagName, count: document.querySelectorAll('tr[data-row]').length, busy: !!state.busy}) + done)); }, 8000);
  });

  // Phase timings: same names before and after, where a name still exists.
  const phases = {};
  const wrap = (holder, name, label) => {
    const fn = holder[name];
    if (typeof fn !== 'function') return;
    holder[name] = function (...args) {
      const t = performance.now();
      try { return fn.apply(this, args); }
      finally { const p = phases[label || name] ||= { calls: 0, ms: 0 }; p.calls++; p.ms += performance.now() - t; }
    };
  };
  for (const n of ['render', 'renderReportPage', 'wireReportPage', 'reportRecords', 'reportShown', 'reportDatalists', 'pickValues', 'knownValues',
    'renderSchedulePage', 'wireSchedulePage', 'scheduleDatalists', 'scheduleProblems', 'scheduleTableHtml', 'syncSnapshot', 'syncRefresh']) wrap(window, n);
  for (const n of ['mergeReport', 'findGaps', 'filterReport', 'scheduleRecords', 'assignNumbers']) wrap(SCHEDULE, n, `SCHEDULE.${n}`);

  const longtasks = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => longtasks.push(e.duration))).observe({ entryTypes: ['longtask'] });
  const stat = (a) => { const s = [...a].sort((x, y) => x - y), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), min: +s[0].toFixed(1), max: +s[s.length - 1].toFixed(1) }; };
  const out = {};
  const scenario = async (name, fn, setup, n = iterations, before) => {
    if (setup) await setup();
    await settle();
    for (const k of Object.keys(phases)) delete phases[k];
    longtasks.length = 0;
    const samples = [];
    for (let i = 0; i < n; i++) {
      if (before) await before(i);
      await settle();
      const t = performance.now();
      await fn(i);
      layout();
      samples.push(performance.now() - t);
    }
    await settle();
    const p = {};
    for (const [k, v] of Object.entries(phases)) p[k] = { calls_per_run: +(v.calls / n).toFixed(2), ms_per_run: +(v.ms / n).toFixed(2) };
    out[name] = { ...stat(samples), dom_nodes: content.getElementsByTagName('*').length, longtasks: longtasks.length, longtask_ms_max: Math.round(Math.max(0, ...longtasks)), phases: p };
  };

  // ------------------------------------------------------------------ report
  // Coming from the other page, as a person does: that page is on screen when the timer starts.
  await scenario('report_open', () => showReport(), null, iterations, () => { state.view = 'schedule'; render(); });
  await scenario('report_idle_rerender', () => render());
  await scenario('report_column_filter_keystroke', async (i) => {
    const el = content.querySelector('[data-col="city"]');
    el.focus();
    const before = document.querySelector('.rep-count').textContent;
    el.value = i % 2 ? 'mum' : 'pun';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await changed(() => document.querySelector('.rep-count').textContent !== before);
  });
  out.report_column_filter_keystroke.note = 'includes the page debounce (250 ms)';
  const filterEl = content.querySelector('[data-col="city"]');
  out.report_filter_keeps_focus = { focus_on_filter: document.activeElement?.dataset?.col === 'city', value: document.activeElement?.value };
  await scenario('report_text_filter_change', async (i) => {
    const el = content.querySelector('[data-filter="city"]');
    const before = document.querySelector('.rep-count').textContent;
    el.value = i % 2 ? 'sur' : 'del';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await changed(() => document.querySelector('.rep-count').textContent !== before);
  }, async () => {
    const r = reportState(); r.columns = {}; r.filters = {}; r.limit = 300; render();
  });
  await scenario('report_show_more_to_1200', async () => {
    const r = reportState(); r.filters = {}; r.columns = {}; r.limit = 300; render();
    for (let k = 0; k < 3; k++) {
      const rows = () => content.querySelectorAll('.rep-table tbody tr').length;
      const before = rows();
      document.getElementById('repMore').click();
      await changed(() => rows() > before);
    }
  }, null, 5);

  // ---------------------------------------------------------------- schedule
  await scenario('schedule_open', async () => { showSchedule(); await tick(); }, null, iterations, () => { state.view = 'report'; render(); });
  await scenario('schedule_idle_rerender', () => render());
  await scenario('schedule_cell_edit', async (i) => {
    const el = content.querySelector('tr[data-row="770151"] [data-f="place"]');
    const stamp = `Edited place ${i}`;
    el.value = stamp;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await changed(() => state.schedule.sessions[150].place === stamp
      && content.querySelector('tr[data-row="770151"] [data-f="place"]').value === stamp
      && content.querySelector('tr[data-row="770151"] [data-f="place"]') !== el);
  }, () => { state.view = 'schedule'; render(); });
  await sleep(600); // the edit debounce flushes through the mock commit
  await scenario('schedule_tick_row', async (i) => {
    const box = () => content.querySelector('tr[data-row="770041"] [data-f="include"]');
    const el = box(), was = el.checked;
    el.checked = !was;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await changed(() => box() !== el && box().checked === !was);
  });
  await sleep(600);

  // -------------------------------------------------------------------- sync
  await scenario('sync_snapshot', () => { syncSnapshot(); });
  const status = await window.api.sync.status();
  const quiet = async () => { document.activeElement?.blur?.(); await sleep(500); };
  await scenario('sync_status_event_unchanged_data_on_report', async () => { await syncStatus(structuredClone(status)); }, async () => { await quiet(); reportState().limit = 300; state.view = 'report'; render(); }, 8);
  await scenario('sync_status_event_unchanged_data_on_schedule', async () => { await syncStatus(structuredClone(status)); }, async () => { state.view = 'schedule'; render(); }, 8);

  // ---------------------------------------------------------------- account
  await scenario('account_open_signed_in', () => showSync(), null, iterations, () => { state.view = 'schedule'; render(); });
  await scenario('account_progress_event', async (i) => { window.__fireProgress({ pending: 500 - i, sending: 1 }); await tick(); });
  await scenario('account_background_render', () => render());
  if (window.gc) { window.gc(); out.heap_mb_after_gc = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1); }
  return out;
}

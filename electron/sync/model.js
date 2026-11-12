'use strict';
// The renderer's schedule data <-> sync targets. Pure functions, no I/O.
//
// A *snapshot* is what the renderer shows: { schedules: {openId, items}, team, cities,
// report }. It becomes targets ({ "type/key": {type, key, a, payload} }) plus a
// device-only *overlay* (file paths, saved .xlsx, scan root, numeric row keys).
// toView() goes the other way. Whatever the renderer was shown is rebuilt through
// fromSnapshot() too, so an unchanged row always compares equal to its base.
const { SPEC, UUID, payloadProblems, keyProblem, naturalKey } = require('./spec');
const { sourceTargets, unpackLines } = require('./source-pack');

const tid = (type, key) => `${type}/${key}`;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** JSON with sorted keys: two equal payloads give one string, whatever their key order. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? null : v);
}

/* ------------------------------------------------------------ row order */

const DIG = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** A key strictly between a and b (b null: no upper bound), never ending in '0'; null if none fits. */
function between(a, b) {
  let r = '';
  for (let i = 0; i < 64; i++) {
    const ca = i < a.length ? DIG.indexOf(a[i]) : 0;
    const cb = b === null ? 62 : i < b.length ? DIG.indexOf(b[i]) : -1;
    if (cb === -1) return null;
    if (cb - ca > 1) { r += DIG[(ca + cb) >> 1]; return r.length <= 64 ? r : null; }
    r += DIG[ca];
    if (cb - ca === 1) b = null;
  }
  return null;
}
const validOrder = (k) => typeof k === 'string' && /^[0-9A-Za-z]{1,64}$/.test(k);

/** n keys spread between lo and hi by bisection, so a long run stays short. */
function spread(lo, hi, n, out) {
  if (n <= 0) return true;
  const mid = between(lo, hi);
  if (mid === null) return false;
  const left = (n - 1) >> 1;
  if (!spread(lo, mid, left, out)) return false;
  out.push(mid);
  return spread(mid, hi, n - 1 - left, out);
}

/**
 * Order keys for rows in display order: the longest run of existing increasing keys is
 * kept (so moving or inserting one row changes only that row), the rest get new keys.
 */
function orderKeys(existing) {
  const n = existing.length;
  const len = new Array(n).fill(0), prev = new Array(n).fill(-1);
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (!validOrder(existing[i])) continue;
    len[i] = 1;
    for (let j = 0; j < i; j++) {
      if (len[j] && existing[j] < existing[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
    if (best < 0 || len[i] > len[best]) best = i;
  }
  const keep = new Set();
  for (let i = best; i >= 0; i = prev[i]) keep.add(i);
  const out = new Array(n);
  let i = 0, lo = '';
  while (i < n) {
    if (keep.has(i)) { out[i] = existing[i]; lo = existing[i]; i++; continue; }
    let j = i;
    while (j < n && !keep.has(j)) j++;
    const made = [];
    if (!spread(lo, j < n ? existing[j] : null, j - i, made)) {
      const all = [];   // no room left between two keys: renumber the whole schedule
      spread('', null, n, all);
      return all;
    }
    for (let k = i; k < j; k++) out[k] = made[k - i];
    i = j;
  }
  return out;
}

/* ------------------------------------------------------------ payloads */

const basename = (p) => String(p || '').split(/[\\/]/).pop();
const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined && !(typeof obj[k] === 'number' && !Number.isFinite(obj[k]))) out[k] = obj[k];
  return out;
};
// Kept on the device: the numeric key, and the fields the renderer only uses while running.
const ROW_LOCAL = new Set(['key', 'uid', 'orderKey', 'busy', 'error']);
const ROW_FIELDS = Object.keys(SPEC.session).filter((k) => k !== 'orderKey');
const REPORT_LOCAL = new Set(['source', 'alsoExisting', 'label', 'schedule']);
const clip = (s, n) => [...String(s)].slice(0, n).join('');

function sessionPayload(row, orderKey) {
  const p = { orderKey };
  for (const k of ROW_FIELDS) {
    let v = row[k];
    if (v === undefined) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) v = null;
    if (k === 'include') v = !!v;
    if (k === 'flags' && isObj(v) && !Object.keys(v).length) continue;
    // Payloads replace whole, so leaving an empty Remarks out clears it, and a server without the field still accepts the row.
    if (k === 'remarks' && !v) continue;
    p[k] = v;
  }
  if (!('date' in p)) p.date = '';
  if (!('include' in p)) p.include = false;
  return p;
}

function assignmentPayload(item) {
  const p = { label: clip(item.label || basename(item.file) || item.sourceBasename || 'Event schedule', 200) };
  const base = basename(item.file) || item.sourceBasename;
  if (base) p.sourceBasename = base;
  if (item.created) p.createdAt = item.created;
  const defaults = pick(item.defaults, Object.keys(SPEC.team_defaults));
  if (Object.keys(defaults).length) p.defaults = defaults;
  const starts = pick(item.starts, Object.keys(SPEC.team_starts));
  if (Object.keys(starts).length) p.starts = starts;
  return p;
}

/**
 * snapshot -> { targets, overlay, scope, problems, warnings }.
 * `busy` names assignments the renderer is still reading: they are left out entirely,
 * never taken for deleted. `scope` says which parts the snapshot speaks for.
 */
function fromSnapshot(snap, busy = []) {
  const targets = {}, problems = [], warnings = [];
  const busySet = new Set(busy || []);
  const overlay = { openId: null, items: {}, keys: {}, citySource: snap && snap.citySource || null };
  const scope = { assignments: new Set(), team: new Set() };
  const add = (type, key, a, payload, where) => {
    const kp = keyProblem(type, key, payload);
    if (kp) problems.push({ where, field: type, code: kp });
    for (const pr of payloadProblems(type, payload)) problems.push({ where, ...pr });
    targets[tid(type, key)] = { type, key, a, payload };
  };
  const schedules = (snap && snap.schedules) || { items: [] };
  overlay.openId = typeof schedules.openId === 'string' ? schedules.openId : null;
  for (const item of schedules.items || []) {
    if (!item || busySet.has(item.id)) continue;
    const a = item.id;
    const label = item.label || basename(item.file) || item.sourceBasename || 'schedule';
    if (typeof a !== 'string' || !UUID.test(a)) { problems.push({ where: label, field: 'assignment', code: 'invalid_key' }); continue; }
    if (scope.assignments.has(a)) { problems.push({ where: label, field: 'assignment', code: 'duplicate_id' }); continue; }
    scope.assignments.add(a);
    overlay.items[a] = { file: item.file || '', saved: item.saved || null, scan: item.scan || null };
    add('assignment', a, a, assignmentPayload(item), label);
    const rows = Array.isArray(item.sessions) ? item.sessions : [];
    const keys = orderKeys(rows.map((r) => r && r.orderKey));
    const seen = new Set();
    overlay.keys[a] = {};
    rows.forEach((row, i) => {
      const where = `${label}, row ${i + 1}`;
      if (!row || typeof row.uid !== 'string' || !UUID.test(row.uid)) { problems.push({ where, field: 'session', code: 'missing_uid' }); return; }
      if (seen.has(row.uid)) { problems.push({ where, field: 'session', code: 'duplicate_uid' }); return; }
      seen.add(row.uid);
      for (const k of Object.keys(row)) {
        if (!ROW_LOCAL.has(k) && !SPEC.session[k] && row[k] !== undefined) problems.push({ where, field: `session.${k}`, code: 'unknown_field' });
      }
      if (Number.isInteger(row.key)) overlay.keys[a][row.uid] = row.key;
      add('session', row.uid, a, sessionPayload(row, keys[i]), where);
    });
    const src = sourceTargets(a, item.rows, item.read && item.read.skipped);
    for (const t of Object.values(src)) add(t.type, t.key, a, t.payload, `${label}, what was read`);
  }
  const team = snap && snap.team;
  if (team) {
    scope.team.add('team_defaults').add('team_starts').add('learned_title').add('learned_place');
    const d = pick(team.defaults, Object.keys(SPEC.team_defaults));
    if (Object.keys(d).length) add('team_defaults', 'team', null, d, 'Team defaults');
    const s = pick(team.starts, Object.keys(SPEC.team_starts));
    if (Object.keys(s).length) add('team_starts', 'team', null, s, 'Folder number starts');
    const mem = team.memory || {};
    for (const [type, list, fields] of [['learned_title', mem.titles, SPEC.learned_title], ['learned_place', mem.places, SPEC.learned_place]]) {
      for (const x of list || []) {
        const p = pick(x, Object.keys(fields));
        const k = naturalKey(type, p);
        if (k === null) { problems.push({ where: 'Learned corrections', field: type, code: 'missing_field' }); continue; }
        if (!targets[tid(type, k)]) add(type, k, null, p, `Learned: ${clip(p.key, 40)}`);   // newest first wins
      }
    }
  }
  if (Array.isArray(snap && snap.cities)) {
    scope.team.add('city');
    for (const c of snap.cities) {
      const p = pick(c, Object.keys(SPEC.city));
      const k = naturalKey('city', p);
      if (k === null) { problems.push({ where: 'City list', field: 'city', code: 'missing_field' }); continue; }
      if (!targets[tid('city', k)]) add('city', k, null, p, `City ${clip(p.name, 40)}`);
    }
  }
  if (Array.isArray(snap && snap.report)) {
    scope.team.add('report_record');
    const dup = new Map();
    for (const r of snap.report) {
      const p = {};
      for (const [k, v] of Object.entries(r || {})) {
        if (REPORT_LOCAL.has(k) || v === undefined || (k === 'remarks' && !v)) continue;
        p[k] = typeof v === 'number' && !Number.isFinite(v) ? null : v;
      }
      const k = naturalKey('report_record', p);
      if (k === null) { problems.push({ where: 'Report', field: 'report_record', code: 'missing_field' }); continue; }
      // The report shows (and exports) the last record of an ID, as mergeReport does.
      if (targets[tid('report_record', k)]) dup.set(k, (dup.get(k) || 1) + 1);
      add('report_record', k, null, p, `Report ${clip(p.id, 40)}`);
    }
    for (const [k, n] of dup) warnings.push({ code: 'duplicate_report_id', where: k, text: `${n} report records share the ID ${k}; the last one is kept, as the export does.` });
  }
  return { targets, overlay, scope, problems, warnings };
}

/** Whether a target id falls inside what a snapshot speaks for. */
function inScope(t, scope) {
  if (t.type === 'assignment') return false;   // a whole schedule is never deleted by leaving it out
  if (t.a) return scope.assignments.has(t.a);
  return scope.team.has(t.type);
}

/* ------------------------------------------------------------ view */

const ROW_DEFAULTS = { flags: () => ({}), events: () => [], languages: () => [] };

/**
 * Current targets (id -> {type, key, a, payload, at}; deleted ones already left out) and
 * the device overlay -> the renderer's data. Also returns the keyMap it used, which
 * the caller saves so numeric keys stay put.
 */
function toView(current, overlay = {}, meta = {}) {
  const items = new Map(), children = new Map();
  const team = { defaults: null, starts: null, memory: { titles: [], places: [] } };
  const cities = [], report = [];
  for (const t of Object.values(current)) {
    if (t.type === 'assignment') items.set(t.key, t);
    else if (t.a) { if (!children.has(t.a)) children.set(t.a, []); children.get(t.a).push(t); }
    else if (t.type === 'team_defaults') team.defaults = { ...t.payload };
    else if (t.type === 'team_starts') team.starts = { ...t.payload };
    else if (t.type === 'learned_title') team.memory.titles.push([t.at || 0, t.key, { ...t.payload }]);
    else if (t.type === 'learned_place') team.memory.places.push([t.at || 0, t.key, { ...t.payload }]);
    else if (t.type === 'city') cities.push({ state: '', country: '', ...t.payload });
    else if (t.type === 'report_record') report.push({ ...t.payload, events: t.payload.events || [], languages: t.payload.languages || [], source: 'existing' });
  }
  // Learned corrections newest first, as SCHEDULE.learn keeps them (it trims to 300 and
  // breaks ties by position); `at` is the last change's time, so the order survives sync.
  for (const f of ['titles', 'places']) {
    team.memory[f] = team.memory[f].sort((x, y) => y[0] - x[0] || (x[1] < y[1] ? -1 : 1)).map((x) => x[2]);
  }
  const keyMap = {};
  const out = [];
  for (const [a, t] of items) {
    const p = t.payload || {};
    const kids = children.get(a) || [];
    const ov = (overlay.items && overlay.items[a]) || {};
    const keys = { ...((overlay.keys && overlay.keys[a]) || {}) };
    const sessions = kids.filter((x) => x.type === 'session')
      .sort((x, y) => (x.payload.orderKey < y.payload.orderKey ? -1 : x.payload.orderKey > y.payload.orderKey ? 1 : x.key < y.key ? -1 : 1));
    // Numeric keys: the ones this device used before stay; a clash goes to the newcomer.
    const used = new Map();
    for (const r of sessions) {
      const k = keys[r.key];
      if (Number.isInteger(k) && !used.has(k)) used.set(k, r.key);
    }
    let next = Math.max(0, ...used.keys()) + 1;
    const rows = sessions.map((r) => {
      let k = keys[r.key];
      if (!(Number.isInteger(k) && used.get(k) === r.key)) { k = next++; used.set(k, r.key); }
      keys[r.key] = k;
      const row = { ...r.payload, key: k, uid: r.key };
      for (const [f, make] of Object.entries(ROW_DEFAULTS)) if (row[f] === undefined) row[f] = make();
      return row;
    });
    for (const uid of Object.keys(keys)) if (!sessions.some((r) => r.key === uid)) delete keys[uid];
    keyMap[a] = keys;
    const lines = kids.filter((x) => x.type === 'source_line').map((x) => x.payload);
    const skips = kids.filter((x) => x.type === 'source_skip').map((x) => x.payload).sort((x, y) => x.index - y.index);
    out.push({
      id: a, label: p.label, created: p.createdAt || '', file: ov.file || '', sourceBasename: p.sourceBasename || '',
      rows: unpackLines(lines), read: lines.length || skips.length ? { skipped: skips.map((s) => ({ days: s.days, reason: s.reason, rowText: s.rowText })) } : null,
      sessions: rows, starts: { ...(p.starts || {}) }, defaults: { ...(p.defaults || {}) },
      scan: ov.scan || null, saved: ov.saved || null,
      sync: (meta.items && meta.items[a]) || {},
    });
  }
  return {
    schedules: { openId: overlay.openId && items.has(overlay.openId) ? overlay.openId : null, items: out },
    team, cities: cities.length ? cities : null, citySource: overlay.citySource || null,
    report: report.length ? report : null, keyMap,
  };
}

module.exports = { canon, between, orderKeys, fromSnapshot, inScope, toView, tid, sessionPayload, assignmentPayload };

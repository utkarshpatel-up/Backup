'use strict';
// Real schedule content through the database and back, compared field by field.
// Run by run.sh against its throwaway cluster: node roundtrip.js <PG_BIN> <socket dir>
// The pack/unpack helpers are the reference for the app's upload of "What was read".
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const S = require('../../renderer/schedule-logic');
const fixtures = require('../fixtures/schedule-ocr.json');

const [PG_BIN, DIR] = process.argv.slice(2);
let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS  roundtrip: ${name}`); }
  catch (e) { failed += 1; console.log(`FAIL  roundtrip: ${name}  -- ${String(e.message).split('\n')[0]}`); }
};

function sql(user, aal, text) {
  const script = `select t.login('${user}', '${aal}') \\g /dev/null\n${text};\n`;
  const out = execFileSync(`${PG_BIN}/psql`, ['-h', DIR, '-U', 'test_super', '-d', 'avb_test', '-X', '-q', '-At',
    '-v', 'ON_ERROR_STOP=1'], { input: script, maxBuffer: 1 << 28 }).toString().trim().split('\n');
  return out[out.length - 1];
}
const lit = (obj) => {
  const j = JSON.stringify(obj);
  if (j.includes('$j$')) throw new Error('payload contains the quote marker');
  return `$j$${j}$j$::jsonb`;
};
const rpc = (fn, req, user = 'op1') => JSON.parse(sql(user, 'aal1', `select public.${fn}(${lit(req)})`));

// Send ops in batches inside the protocol's limits (500 ops, 2 MiB).
function apply(ops) {
  const results = [];
  let batch = [], size = 0;
  const flush = () => {
    if (!batch.length) return;
    const r = rpc('avb_sync_apply', { protocol_version: 1, mutation_id: crypto.randomUUID(), operations: batch });
    for (const x of r.results) if (x.status !== 'applied') throw new Error(`not applied: ${JSON.stringify(x)}`);
    results.push(...r.results);
    batch = []; size = 0;
  };
  for (const op of ops) {
    const n = Buffer.byteLength(JSON.stringify(op)) * 1.2;
    if (batch.length === 500 || size + n > 1.8e6) flush();
    batch.push(op); size += n;
  }
  flush();
  return results;
}
function pullAll(after = 0) {
  const items = [];
  for (;;) {
    const r = rpc('avb_sync_pull', { protocol_version: 1, after, limit: 500 });
    items.push(...r.items);
    after = r.next_cursor;
    if (!r.has_more) return items;
  }
}

// ---- reference packing of a source line into parts of at most BUDGET bytes of JSON.
// Postgres prints jsonb with extra spaces, so leave room under the 32 KiB payload limit.
const BUDGET = 24000, MAX_CELLS = 256;
const bytes = (cells) => Buffer.byteLength(JSON.stringify(cells)) + 2 * cells.length;
function packLine(cells) {
  const parts = [];
  let cur = [], continues = false;
  const flush = (nextContinues) => { parts.push({ cells: cur, continuesCell: continues }); cur = []; continues = nextContinues; };
  for (const cell of cells) {
    let rest = Array.from(cell);   // by code point, so a character is never split
    for (;;) {
      const whole = rest.join('');
      if (cur.length < MAX_CELLS && bytes([...cur, whole]) <= BUDGET) { cur.push(whole); break; }
      if (cur.length) { flush(false); continue; }
      let lo = 1, hi = rest.length;   // the longest prefix that fits an empty part
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bytes([rest.slice(0, mid).join('')]) <= BUDGET) lo = mid; else hi = mid - 1; }
      cur.push(rest.slice(0, lo).join(''));
      rest = rest.slice(lo);
      flush(true);
    }
  }
  if (cur.length || !parts.length || continues) flush(false);
  return parts;
}
function unpackLines(items) {
  const lines = [];
  for (const p of items.sort((a, b) => a.line - b.line || a.part - b.part)) {
    const line = lines[p.line] || (lines[p.line] = []);
    const cells = p.cells.slice();
    if (p.continuesCell && line.length) line[line.length - 1] += cells.shift() ?? '';
    line.push(...cells);
  }
  return lines;
}
function sourceOps(a, rows, skipped) {
  const ops = [];
  rows.forEach((cells, line) => packLine(cells).forEach((p, part) => ops.push({ op: 'create', type: 'source_line',
    key: `${a}:${line}:${part}`, assignment_key: a, payload: { line, part, cells: p.cells, continuesCell: p.continuesCell } })));
  skipped.forEach((x, index) => ops.push({ op: 'create', type: 'source_skip', key: `${a}:${index}`, assignment_key: a,
    payload: { index, days: x.days, reason: x.reason, rowText: x.rowText } }));
  return ops;
}
const LOCAL_ONLY = new Set(['key']);
const sessionPayload = (row, i) => {
  const out = { orderKey: String(i).padStart(6, '0') };
  for (const [k, v] of Object.entries(row)) if (!LOCAL_ONLY.has(k) && v !== undefined) out[k] = v;
  return out;
};

const start = pullAll().reduce((m, x) => Math.max(m, x.change_seq), 0);

// 1. The four real OCR posters: every line, cell and skipped break comes back exact.
for (const [name, fx] of Object.entries(fixtures)) {
  if (name.startsWith('_')) continue;
  const a = crypto.randomUUID();
  const read = S.readRows(fx.rows);
  apply([{ op: 'create', type: 'assignment', key: a, payload: { label: name, sourceBasename: `${name}.png` } },
    ...sourceOps(a, fx.rows, read.skipped)]);
  const mine = pullAll(start).filter((x) => x.assignment_key === a);
  check(`${name}: ${fx.rows.length} lines identical`, () =>
    assert.deepEqual(unpackLines(mine.filter((x) => x.target_type === 'source_line').map((x) => x.payload)), fx.rows));
  check(`${name}: ${read.skipped.length} skipped breaks identical`, () =>
    assert.deepEqual(mine.filter((x) => x.target_type === 'source_skip').sort((x, y) => x.payload.index - y.payload.index)
      .map(({ payload: p }) => ({ days: p.days, reason: p.reason, rowText: p.rowText })), read.skipped));
  check(`${name}: re-reading the fetched lines gives the same schedule`, () => {
    const back = unpackLines(mine.filter((x) => x.target_type === 'source_line').map((x) => x.payload));
    assert.deepEqual(S.readRows(back, { today: '2026-11-07' }), S.readRows(fx.rows, { today: '2026-11-07' }));
  });
}
check('the fixtures do include skipped breaks', () =>
  assert.ok(Object.keys(fixtures).filter((n) => !n.startsWith('_')).some((n) => S.readRows(fixtures[n].rows).skipped.length)));

// 2. A spreadsheet line beyond one payload: 300 cells, one an Excel-maximum cell of
// Gujarati with emoji on the boundaries. Split into parts, never cut.
{
  const a = crypto.randomUUID();
  const huge = Array.from({ length: 32767 }, (_, i) => (i % 97 === 0 ? '😀' : 'સ')).join('').slice(0, 32767);
  const line = Array.from({ length: 300 }, (_, i) => (i === 7 ? huge : `c${i} "q" \\ \n€`));
  const rows = [['header'], line, [], ['tail']];
  const ops = sourceOps(a, rows, []);
  apply([{ op: 'create', type: 'assignment', key: a, payload: { label: 'big', sourceBasename: 'big.xlsx' } }, ...ops]);
  const back = unpackLines(pullAll(start).filter((x) => x.target_type === 'source_line' && x.assignment_key === a).map((x) => x.payload));
  check(`long line split into ${ops.length - 3} parts and rebuilt exactly`, () => { assert.ok(ops.length - 3 > 2); assert.deepEqual(back, rows); });
}

// 3. Two cities share a name; the row's picked record (geo) and startedAt survive, and
// the export (sheet rows and report records) is the same on the other device.
{
  const a = crypto.randomUUID();
  const cities = [{ name: 'Rampur (GJ)', city: 'Rampur', state: 'Gujarat', country: 'India' },
    { name: 'Rampur (MH)', city: 'Rampur', state: 'Maharashtra', country: 'India' }];
  const fx = fixtures['oct-14-to-nov-5-2026'];
  const sessions = S.draftSessions(S.readRows(fx.rows, { today: '2026-11-07' }), {}, { author: 'DD', format: 'HD' })
    .map((row, i) => ({ ...row, key: i + 1 }));
  sessions[0].city = 'Rampur'; sessions[0].geo = 'Rampur (MH)';
  sessions[1].city = 'Rampur'; sessions[1].geo = 'Rampur (GJ)';
  sessions[1].startedAt = '2026-11-07T10:15:00.000Z';
  const starts = { formal: 2486, informal: 900 };
  apply([
    { op: 'create', type: 'assignment', key: a, payload: { label: 'geo', sourceBasename: 'p.png', starts } },
    ...cities.map((c) => ({ op: 'create', type: 'city', key: c.name.toLowerCase(), payload: c })),
    ...sessions.map((row, i) => ({ op: 'create', type: 'session', key: crypto.randomUUID(), assignment_key: a, payload: sessionPayload(row, i) })),
  ]);
  const all = pullAll(start);
  const back = all.filter((x) => x.target_type === 'session' && x.assignment_key === a)
    .sort((x, y) => (x.payload.orderKey < y.payload.orderKey ? -1 : 1))
    .map((x, i) => { const { orderKey, ...rest } = x.payload; return { ...rest, key: i + 1 }; });
  const backCities = all.filter((x) => x.target_type === 'city').map((x) => x.payload);
  const backStarts = all.find((x) => x.target_key === a).payload.starts;
  check(`${sessions.length} sessions identical, geo and startedAt included`, () => assert.deepEqual(back, sessions));
  check('picked duplicate city keeps its state', () => {
    assert.equal(S.cityOf(back[0], backCities).state, 'Maharashtra');
    assert.equal(S.cityOf(back[1], backCities).state, 'Gujarat');
  });
  check('without geo the duplicate city would be lost', () => assert.equal(S.cityOf({ ...back[0], geo: null }, backCities), null));
  check('exported sheet rows identical', () => assert.deepEqual(S.sheetRows(back, backStarts, backCities), S.sheetRows(sessions, starts, cities)));
  check('report records identical', () => assert.deepEqual(S.scheduleRecords(back, backStarts, backCities), S.scheduleRecords(sessions, starts, cities)));
  check('started-but-unfinished state kept for Clips-only and held numbers', () => {
    assert.equal(back[1].startedAt, '2026-11-07T10:15:00.000Z');
    assert.equal(back[1].backedUp, null);
    assert.deepEqual(S.assignNumbers(back, backStarts), S.assignNumbers(sessions, starts));
  });
}

// run.sh counts the PASS/FAIL lines; a crash above aborts the run.

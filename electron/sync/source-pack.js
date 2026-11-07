'use strict';
// "What was read" (assignment.rows and read.skipped) as source_line / source_skip
// targets. Same algorithm as the reviewed reference, tests/db/roundtrip.js:
// each part's JSON stays under BUDGET bytes (room for jsonb's spacing under 32 KiB);
// a line splits by whole cells first, then inside a cell by code point. Nothing is cut.

const BUDGET = 24000, MAX_CELLS = 256;
const bytes = (cells) => Buffer.byteLength(JSON.stringify(cells)) + 2 * cells.length;

function packLine(cells) {
  const parts = [];
  let cur = [], continues = false;
  const flush = (nextContinues) => { parts.push({ cells: cur, continuesCell: continues }); cur = []; continues = nextContinues; };
  for (const cell of cells) {
    let rest = Array.from(String(cell ?? ''));
    for (;;) {
      const whole = rest.join('');
      if (cur.length < MAX_CELLS && bytes([...cur, whole]) <= BUDGET) { cur.push(whole); break; }
      if (cur.length) { flush(false); continue; }
      let lo = 1, hi = rest.length;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bytes([rest.slice(0, mid).join('')]) <= BUDGET) lo = mid; else hi = mid - 1; }
      cur.push(rest.slice(0, lo).join(''));
      rest = rest.slice(lo);
      flush(true);
    }
  }
  if (cur.length || !parts.length || continues) flush(false);
  return parts;
}

/** [{line, part, cells, continuesCell}] -> rows; missing line numbers become empty lines. */
function unpackLines(items) {
  const lines = [];
  for (const p of items.slice().sort((a, b) => a.line - b.line || a.part - b.part)) {
    const line = lines[p.line] || (lines[p.line] = []);
    const cells = p.cells.slice();
    if (p.continuesCell && line.length) line[line.length - 1] += cells.shift() ?? '';
    line.push(...cells);
  }
  for (let i = 0; i < lines.length; i++) if (!lines[i]) lines[i] = [];
  return lines;
}

/** Targets for one assignment's rows and skipped breaks: { id: {type, key, a, payload} }. */
function sourceTargets(a, rows, skipped) {
  const out = {};
  (rows || []).forEach((cells, line) => packLine(Array.isArray(cells) ? cells : []).forEach((p, part) => {
    const key = `${a}:${line}:${part}`;
    out[`source_line/${key}`] = { type: 'source_line', key, a, payload: { line, part, cells: p.cells, continuesCell: p.continuesCell } };
  }));
  (skipped || []).forEach((x, index) => {
    const key = `${a}:${index}`;
    out[`source_skip/${key}`] = { type: 'source_skip', key, a,
      payload: { index, days: (x.days || []).slice(), reason: String(x.reason ?? ''), rowText: String(x.rowText ?? '') } };
  });
  return out;
}

module.exports = { packLine, unpackLines, sourceTargets, BUDGET };

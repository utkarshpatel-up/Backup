'use strict';
// node perf-summary.js baseline.json [after.json]: one line per scenario, medians side by side.
const load = (f) => require(require('node:path').resolve(f));
const [a, b] = process.argv.slice(2).map(load);
for (const [k, v] of Object.entries(a)) {
  if (v && v.median != null) {
    const w = b && b[k];
    console.log(k.padEnd(46), `med ${String(v.median).padStart(8)}`, `p95 ${String(v.p95).padStart(8)}`, `nodes ${String(v.dom_nodes).padStart(6)}`, `long ${String(v.longtasks).padStart(3)}`,
      w ? `| after med ${String(w.median).padStart(8)} p95 ${String(w.p95).padStart(8)} nodes ${String(w.dom_nodes).padStart(6)} long ${String(w.longtasks).padStart(3)}  (${Math.round((1 - w.median / v.median) * 100)}% faster)` : '');
    if (process.env.PHASES) for (const r of [v, w]) if (r) console.log('     ', Object.entries(r.phases).sort((x, y) => y[1].ms_per_run - x[1].ms_per_run).slice(0, 8).map(([n, x]) => `${n}=${x.ms_per_run}ms×${x.calls_per_run}`).join('  '));
  } else if (v && typeof v === 'object' && k !== 'size') {
    console.log(k, JSON.stringify(v)); if (b) console.log('  after:', JSON.stringify(b[k]));
  } else if (k === 'heap_mb_after_gc') console.log(k, v, b ? `-> ${b[k]}` : '');
}

'use strict';
const fs = require('node:fs');
const SIZE = { report: 20000, past: 12, pastRows: 100, open: 300 };
module.exports = async ({ open, run, out, app, root }) => {
  const win = await open({ flow: 'signedin', ...SIZE });
  const results = await run(win, 'perf-scenarios.js', { iterations: 15 });
  const signedOut = await open({ flow: 'signedout' });
  const formResults = await run(signedOut, 'perf-form.js', {});
  const report = { root, electron: process.versions.electron, chrome: process.versions.chrome, size: SIZE, ...results, form: formResults };
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

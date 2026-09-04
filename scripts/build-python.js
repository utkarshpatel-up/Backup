'use strict';

// Cross-platform launcher for the PyInstaller build. `python3` is not normally
// a command on Windows, while `py -3` is not available on macOS/Linux.
const { spawnSync } = require('child_process');

const requested = process.env.VINGEST_PYTHON;
const candidates = requested
  ? [{ cmd: requested, prefix: [] }]
  : process.platform === 'win32'
    ? [{ cmd: 'py', prefix: ['-3'] }, { cmd: 'python', prefix: [] },
       { cmd: 'python3', prefix: [] }]
    : [{ cmd: 'python3', prefix: [] }, { cmd: 'python', prefix: [] }];

let chosen = null;
for (const candidate of candidates) {
  const check = spawnSync(candidate.cmd, [...candidate.prefix, '--version'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (!check.error && check.status === 0) {
    chosen = candidate;
    break;
  }
}

if (!chosen) {
  console.error('Python 3 was not found. Install Python 3.9+ and enable the Python launcher.');
  process.exit(1);
}

const result = spawnSync(
  chosen.cmd,
  [...chosen.prefix, 'scripts/build_python.py', ...process.argv.slice(2)],
  { stdio: 'inherit', windowsHide: true },
);
if (result.error) {
  console.error(`Could not run ${chosen.cmd}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);

'use strict';

// Cross-platform launcher for the PyInstaller build. `python3` is not normally
// a command on Windows, while `py -3` is not available on macOS/Linux.
const { spawnSync } = require('child_process');
const path = require('path');

const requested = process.env.VINGEST_PYTHON;
const localWindowsPython = path.join(__dirname, '..', '.venv-win', 'Scripts', 'python.exe');
const candidates = requested
  ? [{ cmd: requested, prefix: [] }]
  : process.platform === 'win32'
    ? [{ cmd: localWindowsPython, prefix: [] },
       { cmd: 'py', prefix: ['-3'] }, { cmd: 'python', prefix: [] },
       { cmd: 'python3', prefix: [] }]
    : [{ cmd: 'python3', prefix: [] }, { cmd: 'python', prefix: [] }];

let chosen = null;
for (const candidate of candidates) {
  // A Python executable alone is not sufficient for packaging; keep looking
  // until we find one that has PyInstaller installed.
  const check = spawnSync(candidate.cmd, [...candidate.prefix, '-c', 'import PyInstaller'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (!check.error && check.status === 0) {
    chosen = candidate;
    break;
  }
}

if (!chosen) {
  console.error('Python 3 with PyInstaller was not found. Install it with: python -m pip install pyinstaller xxhash');
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

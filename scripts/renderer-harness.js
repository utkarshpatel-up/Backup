'use strict';
// Runs a renderer harness in real Electron against a mocked window.api and a temp profile:
// no Python engine, network, real account or user data. Usage:
//   node scripts/renderer-harness.js perf|account [--root=<dir holding renderer/>] [--out=<file>]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [mode, ...flags] = process.argv.slice(2);
if (!['perf', 'account'].includes(mode)) { console.error('Usage: renderer-harness.js perf|account [--root=dir] [--out=file]'); process.exit(2); }
const flag = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avb-harness-'));
const env = { ...process.env, AVB_HARNESS_DIR: dir, AVB_HARNESS_MODE: mode,
  AVB_HARNESS_ROOT: path.resolve(flag('root') || path.join(__dirname, '..')),
  AVB_HARNESS_OUT: flag('out') ? path.resolve(flag('out')) : '' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, '../tests/fixtures/renderer-harness/main.cjs')], { env, stdio: 'inherit' });
const timeout = setTimeout(() => { console.error('Harness timed out.'); child.kill('SIGKILL'); }, 600000);
child.on('close', (code) => {
  clearTimeout(timeout);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});

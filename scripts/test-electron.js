'use strict';
// Explicit smoke test, separate from node:test. Never uses the real app profile.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avb-electron-smoke-'));
const env = { ...process.env, AVB_SMOKE_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE;
let completed = false, output = '';
const child = spawn(require('electron'), [path.join(__dirname, '../tests/fixtures/electron-smoke.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  output = (output + chunk.toString()).slice(-4096);
  if (output.includes('AVB_ELECTRON_SMOKE_COMPLETE')) completed = true;
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
const timeout = setTimeout(() => { console.error('Electron smoke test timed out.'); child.kill('SIGKILL'); }, 60000);
function finish(code) {
  clearTimeout(timeout);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = code;
}
child.on('error', (e) => { console.error(e.message); finish(1); });
child.on('close', (code) => {
  if (!completed) console.error('Smoke exited before all checks completed.');
  finish(code === 0 && completed ? 0 : 1);
});

'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

/** Owns the Python worker process and its JSON-lines stdio protocol. */
class PythonBridge {
  constructor({ onProgress, onStatus }) {
    this.onProgress = onProgress || (() => {});
    this.onStatus = onStatus || (() => {});
    this.pending = new Map();
    this.nextId = 1;
    this.proc = null;
    this.ready = null;
  }

  resolveCommands() {
    const exe = process.platform === 'win32' ? 'vingest-core.exe' : 'vingest-core';
    const bundled = path.join(process.resourcesPath || '', 'python', exe);
    if (fs.existsSync(bundled)) return [{ cmd: bundled, args: [] }];

    const script = path.join(__dirname, '..', 'python', 'main.py');
    if (process.env.VINGEST_PYTHON) {
      return [{ cmd: process.env.VINGEST_PYTHON, args: [script] }];
    }
    // A standard Windows Python install may expose only the `py` launcher.
    return process.platform === 'win32'
      ? [{ cmd: 'py', args: ['-3', script] }, { cmd: 'python', args: [script] },
         { cmd: 'python3', args: [script] }]
      : [{ cmd: 'python3', args: [script] },
         { cmd: '/opt/homebrew/bin/python3', args: [script] },
         { cmd: '/usr/bin/python3', args: [script] }, { cmd: 'python', args: [script] }];
  }

  start() {
    if (this.ready) return this.ready;
    const commands = this.resolveCommands();
    this.ready = new Promise((resolve, reject) => {
      const failures = [];

      const attempt = (index) => {
        if (index >= commands.length) {
          this.ready = null;
          reject(new Error(`Could not start the Python engine. ${failures.join(' ')}`.trim()));
          return;
        }

        const { cmd, args } = commands[index];
        let proc;
        let becameReady = false;
        let attemptFinished = false;
        let stderrTail = '';
        try {
          proc = spawn(cmd, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            // Windows often defaults redirected Python stdio to a legacy code
            // page. The protocol must carry arbitrary Unicode footage paths.
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
          });
        } catch (err) {
          failures.push(`${cmd}: ${err.message}`);
          attempt(index + 1);
          return;
        }

        const timer = setTimeout(() => {
          if (attemptFinished || becameReady) return;
          attemptFinished = true;
          failures.push(`${cmd}: no ready response within 20s.`);
          try { proc.kill(); } catch { /* already gone */ }
          attempt(index + 1);
        }, 20000);

        readline.createInterface({ input: proc.stdout }).on('line', (line) => {
          let msg;
          try { msg = JSON.parse(line); } catch { return; }
          if (msg.event === 'ready') {
            if (attemptFinished) return;
            becameReady = true;
            attemptFinished = true;
            clearTimeout(timer);
            this.proc = proc;
            this.onStatus({ state: 'ready', info: msg.data });
            resolve(msg.data);
            return;
          }
          if (msg.event === 'progress') return this.onProgress(msg);
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          msg.ok ? entry.resolve(msg.result)
                 : entry.reject(Object.assign(new Error(msg.error), { traceback: msg.traceback }));
        });

        proc.stderr.on('data', (d) => {
          stderrTail = (stderrTail + d.toString()).slice(-4000);
          this.onStatus({ state: 'stderr', text: d.toString() });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (!becameReady && !attemptFinished) {
            attemptFinished = true;
            failures.push(`${cmd}: ${err.message}`);
            attempt(index + 1);
          }
        });

        proc.on('exit', (code) => {
          clearTimeout(timer);
          if (!becameReady) {
            if (!attemptFinished) {
              attemptFinished = true;
              failures.push(`${cmd}: exited with code ${code}${stderrTail ? ` (${stderrTail.trim()})` : ''}.`);
              attempt(index + 1);
            }
            return;
          }
          const err = new Error(`Python engine exited (code ${code}). ${stderrTail}`.trim());
          for (const [, entry] of this.pending) entry.reject(err);
          this.pending.clear();
          if (this.proc === proc) this.proc = null;
          this.ready = null;
          this.onStatus({ state: 'exited', code, stderr: stderrTail });
        });
      };

      attempt(0);
    });
    return this.ready;
  }

  async call(method, params = {}, id = null) {
    await this.start();
    if (!this.proc) throw new Error('Python engine is not running.');
    const reqId = id != null ? id : this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id: reqId, method, params }) + '\n');
    });
  }

  cancel(targetId) {
    if (!this.proc) return;
    const reqId = this.nextId++;
    this.proc.stdin.write(
      JSON.stringify({ id: reqId, method: 'cancel', params: { target_id: targetId } }) + '\n');
  }

  reserveId() { return this.nextId++; }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    try { proc.stdin.end(); } catch { /* already gone */ }
    // Capture this process so an old shutdown timer cannot kill a replacement.
    setTimeout(() => {
      if (proc.exitCode == null) {
        try { proc.kill(); } catch { /* already gone */ }
      }
    }, 2000);
  }
}

module.exports = { PythonBridge };

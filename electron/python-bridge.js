'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

/**
 * Owns the Python worker process and the JSON-lines protocol on its stdio.
 * Restarts it if it dies, so a crash mid-session does not require a relaunch.
 */
class PythonBridge {
  constructor({ onProgress, onStatus }) {
    this.onProgress = onProgress || (() => {});
    this.onStatus = onStatus || (() => {});
    this.pending = new Map();
    this.nextId = 1;
    this.proc = null;
    this.ready = null;
  }

  resolveCommand() {
    // Packaged: a PyInstaller binary in Resources. Dev: the source tree.
    const exe = process.platform === 'win32' ? 'vingest-core.exe' : 'vingest-core';
    const bundled = path.join(process.resourcesPath || '', 'python', exe);
    if (fs.existsSync(bundled)) return { cmd: bundled, args: [] };

    const script = path.join(__dirname, '..', 'python', 'main.py');
    const candidates = process.platform === 'win32'
      ? ['python', 'py']
      : ['python3', '/opt/homebrew/bin/python3', '/usr/bin/python3', 'python'];
    return { cmd: process.env.VINGEST_PYTHON || candidates[0], args: [script], fallbacks: candidates };
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const { cmd, args } = this.resolveCommand();
      let proc;
      try {
        proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        return reject(new Error(`Could not start the Python engine (${cmd}): ${err.message}`));
      }
      this.proc = proc;

      const timer = setTimeout(
        () => reject(new Error('The Python engine did not report ready within 20s.')), 20000);

      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.event === 'ready') {
          clearTimeout(timer);
          this.onStatus({ state: 'ready', info: msg.data });
          return resolve(msg.data);
        }
        if (msg.event === 'progress') return this.onProgress(msg);
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        msg.ok ? entry.resolve(msg.result)
               : entry.reject(Object.assign(new Error(msg.error), { traceback: msg.traceback }));
      });

      let stderrTail = '';
      proc.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d.toString()).slice(-4000);
        this.onStatus({ state: 'stderr', text: d.toString() });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Python engine failed to launch: ${err.message}`));
      });

      proc.on('exit', (code) => {
        clearTimeout(timer);
        const err = new Error(`Python engine exited (code ${code}). ${stderrTail}`.trim());
        for (const [, entry] of this.pending) entry.reject(err);
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        this.onStatus({ state: 'exited', code, stderr: stderrTail });
        reject(err);
      });
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

  /** Cancel jumps the queue: it is handled on the reader thread, not a worker. */
  cancel(targetId) {
    if (!this.proc) return;
    const reqId = this.nextId++;
    this.proc.stdin.write(
      JSON.stringify({ id: reqId, method: 'cancel', params: { target_id: targetId } }) + '\n');
  }

  reserveId() { return this.nextId++; }

  stop() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch { /* already gone */ }
    setTimeout(() => this.proc && this.proc.kill(), 2000);
  }
}

module.exports = { PythonBridge };

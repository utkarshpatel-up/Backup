'use strict';
const { randomUUID } = require('node:crypto');
const { trustedSender } = require('./ipc-security');

class FlushHandshake {
  constructor({ ipcMain, getWindow, appUrl, timeoutMs = 10000 }) {
    Object.assign(this, { getWindow, appUrl, timeoutMs });
    this.pending = new Map();
    ipcMain.on('app:flush-result', (event, result) => {
      if (!trustedSender(event, getWindow(), appUrl) || !result || typeof result.id !== 'string' || typeof result.ok !== 'boolean') return;
      const wait = this.pending.get(result.id);
      if (!wait || event.senderFrame !== wait.frame || event.sender !== wait.win.webContents) return;
      this.finish(result.id, result.ok ? null : new Error('The editor could not save its pending changes.'));
    });
  }
  finish(id, error) {
    const wait = this.pending.get(id);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.pending.delete(id);
    if (error) wait.reject(error); else wait.resolve();
  }
  request(win) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const wait = { win, frame: win.webContents.mainFrame, resolve, reject };
      wait.timer = setTimeout(() => this.finish(id, new Error('The editor did not confirm that its pending changes were saved.')), this.timeoutMs);
      this.pending.set(id, wait);
      try { win.webContents.send('app:flush-request', { id }); } catch (e) { this.finish(id, e); }
    });
  }
  cancel(win) {
    for (const [id, wait] of this.pending) if (wait.win === win) this.finish(id, new Error('The editor window closed.'));
  }
}

/** One close attempt at a time. Never wait for network uploads. */
class CloseCoordinator {
  constructor({ isBusy, confirmStop, flushRenderer, flushLocal, confirmDiscard, cancelled }) {
    Object.assign(this, { isBusy, confirmStop, flushRenderer, flushLocal, confirmDiscard, cancelled });
    this.pending = null;
    this.approved = false;
  }
  /** Save only: true when the editor and local store saved. Never discards, never sets `approved`; failure restores the editor. */
  flushStrict() {
    if (this.pending) return Promise.resolve(false);
    const run = Promise.resolve().then(async () => {
      if (this.isBusy()) return false;
      await this.flushRenderer(); await this.flushLocal();
      return true;
    }).catch(() => false).then((ok) => { this.pending = null; if (!ok) this.cancelled(); return ok; });
    this.pending = run;
    return run;
  }
  request() {
    if (this.approved) return Promise.resolve(true);
    if (this.pending) return this.pending;
    const run = Promise.resolve().then(async () => {
      if (this.isBusy() && !await this.confirmStop()) return false;
      try { await this.flushRenderer(); await this.flushLocal(); }
      catch (_) { if (!await this.confirmDiscard()) return false; }
      this.approved = true;
      return true;
    }).catch(() => false).finally(() => {
      this.pending = null;
      if (!this.approved) this.cancelled();
    });
    this.pending = run;
    return run;
  }
}

module.exports = { FlushHandshake, CloseCoordinator };

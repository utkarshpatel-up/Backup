'use strict';
// CloseCoordinator.flushStrict against the real FlushHandshake (no stubbed closer).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { FlushHandshake, CloseCoordinator } = require('../electron/close-coordinator');

function realCloser({ rendererOk = true, localOk = true, busy = () => false } = {}) {
  const ipc = new EventEmitter();
  const frame = { url: 'file:///app/renderer/index.html' };
  const wc = new EventEmitter(); wc.mainFrame = frame;
  const win = { webContents: wc, isDestroyed: () => false };
  const spies = { discard: 0, stop: 0, cancelled: 0 };
  wc.send = (_c, { id }) => setImmediate(() => ipc.emit('app:flush-result', { sender: wc, senderFrame: frame }, { id, ok: rendererOk }));
  const flush = new FlushHandshake({ ipcMain: ipc, getWindow: () => win, appUrl: 'file:///app/renderer/index.html', timeoutMs: 200 });
  const closer = new CloseCoordinator({
    isBusy: busy,
    confirmStop: async () => { spies.stop++; return true; },
    flushRenderer: () => flush.request(win),
    flushLocal: async () => { if (!localOk) throw new Error('disk'); },
    confirmDiscard: async () => { spies.discard++; return true; },   // would approve a discard if ever asked
    cancelled: () => { spies.cancelled++; },
  });
  return { closer, spies };
}

test('strict save: saved edits resolve true and never set close approval', async () => {
  const { closer, spies } = realCloser();
  assert.equal(await closer.flushStrict(), true);
  assert.equal(closer.approved, false);
  assert.equal(spies.discard + spies.stop + spies.cancelled, 0);
});

test('strict save: failed renderer or local save never discards or approves, and restores the editor', async () => {
  for (const opts of [{ rendererOk: false }, { localOk: false }]) {
    const { closer, spies } = realCloser(opts);
    assert.equal(await closer.flushStrict(), false);
    assert.equal(closer.approved, false);
    assert.equal(closer.pending, null);
    assert.equal(spies.discard, 0);
    assert.equal(spies.cancelled, 1);   // editor un-inerted
    // A later normal close is still gated by the usual handshake.
    assert.equal(await closer.request(), true);   // via confirmDiscard spy, i.e. the normal path
    assert.equal(spies.discard, 1);
  }
});

test('strict save: an unanswered editor times out as a save failure', async () => {
  const { closer, spies } = realCloser();
  closer.flushRenderer = () => new FlushHandshake({ ipcMain: new EventEmitter(), getWindow: () => null, appUrl: 'x', timeoutMs: 20 }).request({ webContents: { mainFrame: {}, send() {} } });
  assert.equal(await closer.flushStrict(), false);
  assert.equal(spies.discard, 0); assert.equal(closer.approved, false);
});

test('strict save: busy or an in-flight close attempt refuses', async () => {
  const a = realCloser({ busy: () => true });
  assert.equal(await a.closer.flushStrict(), false);
  assert.equal(a.spies.stop, 0);
  const b = realCloser();
  const first = b.closer.request();
  assert.equal(await b.closer.flushStrict(), false);
  await first;
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { trustedSender, trustedHandle, restrictNavigation } = require('../electron/ipc-security');
const { registerSyncIpc, validate } = require('../electron/sync/ipc');
const { createSyncHost } = require('../electron/sync/host');
const { FlushHandshake, CloseCoordinator } = require('../electron/close-coordinator');
const { SyncError } = require('../electron/sync/client');

const URL = 'file:///app/renderer/index.html';
const ID = '11111111-1111-4111-8111-111111111111';
function windowFixture() {
  const wc = new EventEmitter();
  wc.mainFrame = { url: URL }; wc.sent = [];
  wc.send = (...args) => wc.sent.push(args);
  wc.setWindowOpenHandler = (fn) => { wc.openHandler = fn; };
  return { webContents: wc, isDestroyed: () => false };
}
function ipcFixture() {
  const ipc = new EventEmitter(); ipc.handles = new Map();
  ipc.handle = (channel, fn) => ipc.handles.set(channel, fn);
  return ipc;
}
const eventFor = (w) => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('privileged IPC requires the exact app window, main frame and local page', () => {
  const w = windowFixture(), ipc = ipcFixture(), event = eventFor(w);
  assert.equal(trustedSender(event, w, URL), true);
  assert.equal(trustedSender({ ...event, senderFrame: { url: URL } }, w, URL), false);
  assert.equal(trustedSender(eventFor(windowFixture()), w, URL), false);
  for (const url of ['https://evil.invalid', 'file:///app/other.html', `${URL}?query`]) {
    w.webContents.mainFrame.url = url;
    assert.equal(trustedSender(event, w, URL), false);
  }
  w.webContents.mainFrame.url = `${URL}#schedule`;
  const handle = trustedHandle(ipc, () => w, URL);
  let called = 0;
  handle('filesystem:write', () => ++called);
  assert.equal(ipc.handles.get('filesystem:write')(event), 1);
  assert.throws(() => ipc.handles.get('filesystem:write')({ ...event, senderFrame: null }), /Untrusted/);
  assert.equal(called, 1);
});

test('navigation, redirects, subframes, webviews and popups cannot open untrusted pages', () => {
  const w = windowFixture(), wc = w.webContents;
  restrictNavigation(wc, URL);
  for (const kind of ['will-navigate', 'will-redirect']) {
    let denied = false;
    wc.emit(kind, { preventDefault: () => { denied = true; } }, 'https://evil.invalid');
    assert.equal(denied, true);
    denied = false;
    wc.emit(kind, { preventDefault: () => { denied = true; } }, `${URL}#x`);
    assert.equal(denied, false);
  }
  for (const kind of ['will-frame-navigate', 'will-attach-webview']) {
    let denied = false;
    wc.emit(kind, { isMainFrame: false, url: URL, preventDefault: () => { denied = true; } });
    assert.equal(denied, true);
  }
  assert.deepEqual(wc.openHandler({ url: URL }), { action: 'deny' });
});

test('account IPC accepts only typed bounded actions and returns safe errors', async () => {
  const w = windowFixture(), ipc = ipcFixture();
  let calls = 0;
  const engine = new EventEmitter();
  engine.status = () => ({ mode: 'local', signedIn: false });
  engine.publicConfig = () => ({ enabled: false, keyHint: '' });
  engine.signIn = async () => { calls++; throw new Error('password hunter2 access_token=short'); };
  engine.deleteAssignment = async () => { throw new SyncError('forbidden', 'admin_required', 'Only an admin can delete or restore a whole schedule.'); };
  const host = { engine, status: engine.status };
  registerSyncIpc({ ipcMain: ipc, getWindow: () => w, appUrl: URL, getHost: () => host });
  const invoke = ipc.handles.get('sync:invoke');
  assert.equal((await invoke(eventFor(w), 'status')).result.mode, 'local');
  assert.equal((await invoke(eventFor(w), 'signIn', { email: 'a@b.c', password: 'hunter2' })).ok, false);
  assert.equal(calls, 1);
  const error = await invoke(eventFor(w), 'signIn', { email: 'a@b.c', password: 'hunter2' });
  assert.ok(!JSON.stringify(error).includes('hunter2') && !JSON.stringify(error).includes('access_token'));
  for (const [action, args] of [
    ['arbitrary', {}], ['status', { token: 'x' }], ['signIn', { email: 'a', password: 'b', url: 'https://evil.invalid' }],
    ['deleteAssignment', { id: ID, rev: -1 }], ['commit', { baseRev: 1, snapshot: {}, busy: ['bad'] }],
    ['mfaVerify', { code: '123456' }], ['signUp', { email: 'a@b.c', password: 'pw' }], ['setConfig', { enabled: true, url: 'https://x.test', key: 'k' }], ['protect', { assignmentId: ID }],
    ['commit', { baseRev: 1, snapshot: JSON.parse('{"__proto__":{}}') }],
  ]) assert.equal((await invoke(eventFor(w), action, args)).error.code, 'invalid_arguments');
  assert.equal((await invoke(eventFor(windowFixture()), 'signIn', { email: 'a', password: 'b' })).error.code, 'untrusted_frame');
  assert.equal((await invoke(eventFor(w), 'deleteAssignment', { id: ID, rev: 1 })).error.code, 'admin_required');
  validate('commit', { baseRev: 1, snapshot: { schedules: { items: [] } }, busy: [ID] });
});

test('locked accounts cannot expose their cache by forging backup protection over IPC', async () => {
  const w = windowFixture(), ipc = ipcFixture();
  const engine = new EventEmitter();
  engine.status = () => ({ locked: true });
  engine.view = () => { throw new Error('must not open cache'); };
  const { invoke } = registerSyncIpc({ ipcMain: ipc, getWindow: () => w, appUrl: URL, getHost: () => ({ engine, status: engine.status }) });
  assert.equal((await invoke(eventFor(w), 'view')).result.locked, true);
  assert.equal((await invoke(eventFor(w), 'protect', { assignmentId: ID, uid: ID })).error.code, 'locked');
});

test('closing refuses new account actions but accepts the last local commit', async () => {
  const w = windowFixture(), ipc = ipcFixture(), calls = [];
  const engine = new EventEmitter();
  engine.status = () => ({ locked: false });
  engine.commit = (p) => { calls.push(p.baseRev); return { ok: true }; };
  engine.signIn = () => assert.fail('no new sign-in during close');
  const { invoke } = registerSyncIpc({ ipcMain: ipc, getWindow: () => w, appUrl: URL,
    getHost: () => ({ engine, status: engine.status }), isClosing: () => true });
  assert.equal((await invoke(eventFor(w), 'signIn', { email: 'a@b.c', password: 'x' })).error.code, 'closing');
  assert.equal((await invoke(eventFor(w), 'commit', { baseRev: 5, snapshot: {} })).ok, true);
  assert.deepEqual(calls, [5]);
});

test('preload commits the focused field before flushing and hides callback errors', async () => {
  const ipc = new EventEmitter(), sent = [], order = [];
  ipc.send = (channel, payload) => sent.push({ channel, payload });
  ipc.invoke = async () => ({ ok: true, result: { mode: 'local' } });
  let api;
  const document = { documentElement: { inert: false }, activeElement: { blur: () => order.push('blur') } };
  const context = vm.createContext({ document, process: { platform: 'test' }, require: (name) => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: ipc, webUtils: {} };
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8'), context);
  api.onBeforeClose(async () => { order.push('save'); });
  ipc.emit('app:flush-request', {}, { id: 'first' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['blur', 'save']);
  assert.equal(sent[0].payload.ok, true);
  assert.equal(document.documentElement.inert, true);
  ipc.emit('app:close-cancelled');
  assert.equal(document.documentElement.inert, false);
  api.onBeforeClose(() => { throw new Error('password hunter2'); });
  ipc.emit('app:flush-request', {}, { id: 'second' });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent[1].payload.ok, false);
  assert.ok(!JSON.stringify(sent).includes('hunter2'));
  assert.equal(api.sync.invoke, undefined);
  let status;
  const unsubscribe = api.sync.onStatus((value) => { status = value; });
  ipc.emit('sync:status', { sender: 'must not cross bridge' }, { phase: 'offline' });
  assert.deepEqual(status, { phase: 'offline' });
  unsubscribe();
  ipc.emit('sync:status', {}, { phase: 'online' });
  assert.equal(status.phase, 'offline');
});

test('sync host forces redirect:error and omitted credentials on its fetch, and startup errors leave local mode available', async () => {
  const calls = [];
  class Engine {
    constructor(args) { this.args = args; }
    init() { this.didInit = true; }
    status() { return { mode: 'local' }; }
    flushLocal() { calls.push('local disk barrier'); }
  }
  const host = createSyncHost({ dir: '/tmp/test', safeStorage: {}, fetch: (...a) => { calls.push(a); return Promise.resolve('ok'); }, Engine });
  assert.equal(host.engine.didInit, true);
  assert.equal(calls.length, 0, 'initialization does not itself send any request');
  await host.engine.args.fetch('https://team.invalid', { redirect: 'follow', credentials: 'include' });
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].credentials, 'omit');
  host.flushLocal();
  assert.equal(calls[1], 'local disk barrier');
  class Broken extends Engine { init() { throw new Error('secret startup detail'); } }
  const failed = createSyncHost({ dir: '/tmp/test', Engine: Broken });
  assert.equal(failed.engine, null);
  assert.equal(failed.status().mode, 'local');
  assert.ok(!failed.status().error.includes('secret'));
});

test('flush acknowledgement must match the request, window and captured main frame', async () => {
  const w = windowFixture(), ipc = ipcFixture();
  const flush = new FlushHandshake({ ipcMain: ipc, getWindow: () => w, appUrl: URL, timeoutMs: 500 });
  let finished = false;
  const pending = flush.request(w).then(() => { finished = true; });
  const id = w.webContents.sent[0][1].id;
  ipc.emit('app:flush-result', eventFor(w), { id: 'wrong', ok: true });
  ipc.emit('app:flush-result', eventFor(windowFixture()), { id, ok: true });
  ipc.emit('app:flush-result', { ...eventFor(w), senderFrame: { url: URL } }, { id, ok: true });
  await Promise.resolve(); assert.equal(finished, false);
  ipc.emit('app:flush-result', eventFor(w), { id, ok: true });
  await pending;
  assert.equal(flush.pending.size, 0);
});

test('flush failure and timeout reject instead of approving unsaved shutdown', async () => {
  const w = windowFixture(), ipc = ipcFixture();
  const flush = new FlushHandshake({ ipcMain: ipc, getWindow: () => w, appUrl: URL, timeoutMs: 10 });
  const failed = flush.request(w);
  ipc.emit('app:flush-result', eventFor(w), { id: w.webContents.sent[0][1].id, ok: false });
  await assert.rejects(failed, /could not save/);
  await assert.rejects(flush.request(w), /did not confirm/);
  assert.equal(flush.pending.size, 0);
});

test('close waits for saves once and never waits for an upload', async () => {
  const save = deferred(), calls = [];
  const c = new CloseCoordinator({ isBusy: () => false, confirmStop: () => assert.fail('no copy'),
    flushRenderer: () => { calls.push('renderer'); return save.promise; },
    flushLocal: () => { calls.push('disk'); }, confirmDiscard: () => assert.fail('saved'), cancelled: () => assert.fail('approved'),
  });
  const first = c.request(), second = c.request();
  assert.equal(first, second);
  await Promise.resolve(); assert.deepEqual(calls, ['renderer']);
  assert.equal(c.approved, false);
  save.resolve(); assert.equal(await first, true);
  assert.deepEqual(calls, ['renderer', 'disk']);
  assert.equal(await c.request(), true);
});

test('running-copy cancellation and failed-save cancellation keep the window open', async () => {
  let flushed = 0, cancelled = 0, discard = false, busy = true;
  const c = new CloseCoordinator({ isBusy: () => busy, confirmStop: async () => false,
    flushRenderer: () => { flushed++; throw new Error('disk'); }, flushLocal: () => {},
    confirmDiscard: () => discard, cancelled: () => cancelled++,
  });
  assert.equal(await c.request(), false);
  assert.equal(flushed, 0);
  busy = false;
  assert.equal(await c.request(), false);
  assert.equal(cancelled, 2);
  discard = true;
  assert.equal(await c.request(), true, 'only an explicit discard permits closing after failure');
});

test('renderer flush waits for a debounced schedule and can retry a failed local save', async () => {
  const calls = [], save = deferred(); let fail = false;
  const context = vm.createContext({ window: { api: { setStore: async (_name, value) => {
    calls.push(value); if (fail) throw new Error('disk'); await save.promise;
  } } }, state: { schedules: { items: [{ id: 'a', sessions: [], rows: [], busy: null, undo: { x: 1 } }] }, schedule: { id: 'a' } },
  setTimeout, clearTimeout, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/schedule-ui.js'), 'utf8'), context);
  const saving = vm.runInContext('scheduleRemember(); scheduleFlush()', context);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].items[0].undo, undefined);
  save.resolve(); await saving;
  fail = true;
  await assert.rejects(vm.runInContext('scheduleFlush()', context), /disk/);
  fail = false;
  await vm.runInContext('scheduleFlush()', context);
  assert.equal(calls.length, 3);
});

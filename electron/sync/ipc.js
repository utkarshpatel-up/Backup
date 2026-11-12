'use strict';
const { trustedSender } = require('../ipc-security');
const { SyncError } = require('./client');
const { VaultError } = require('./vault');
const { UUID } = require('./spec');

function invalid() { throw new SyncError('refused', 'invalid_arguments', 'Invalid account action arguments.'); }
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function fields(v, allowed) {
  if (!object(v) || Object.keys(v).some((k) => !allowed.includes(k))) invalid();
}
const string = (v, max) => typeof v === 'string' && v.length <= max;
const uuid = (v) => typeof v === 'string' && UUID.test(v);
const revision = (v) => Number.isSafeInteger(v) && v >= 0;
const head = (v) => v == null || uuid(v);
function jsonData(v, depth = 0) {
  if (depth > 32) invalid();
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number' && Number.isFinite(v)) return;
  if (Array.isArray(v)) { for (const x of v) jsonData(x, depth + 1); return; }
  if (!object(v)) invalid();
  for (const [k, x] of Object.entries(v)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) invalid();
    jsonData(x, depth + 1);
  }
}

function validate(action, p) {
  const noArgs = ['status', 'getConfig', 'forgetEmail', 'signOut', 'view', 'syncNow', 'conflicts', 'reviews'];
  if (noArgs.includes(action)) { fields(p, []); return; }
  switch (action) {
    case 'setConfig':
      fields(p, ['enabled', 'serverUrl']);
      if (typeof p.enabled !== 'boolean' || !string(p.serverUrl, 2048)) invalid();
      return;
    case 'signIn':
      fields(p, ['email', 'password']);
      if (!string(p.email, 320) || !string(p.password, 1024)) invalid();
      return;
    case 'signUp':
      fields(p, ['email', 'password', 'name']);
      if (!string(p.email, 320) || !string(p.password, 1024) || !string(p.name, 200)) invalid();
      return;
    case 'history':
      fields(p, ['before']);
      if (p.before !== undefined && !(Number.isSafeInteger(p.before) && p.before > 0)) invalid();
      return;
    case 'commit':
      fields(p, ['baseRev', 'snapshot', 'busy']);
      if (!revision(p.baseRev) || !object(p.snapshot)) invalid();
      jsonData(p.snapshot);
      if (Buffer.byteLength(JSON.stringify(p.snapshot)) > 64 * 1024 * 1024) invalid();
      if (p.busy !== undefined && (!Array.isArray(p.busy) || p.busy.length > 10000 || !p.busy.every(uuid))) invalid();
      return;
    case 'protect':
      fields(p, ['assignmentId', 'uid', 'baseRev']);
      if (p.baseRev !== undefined && !revision(p.baseRev)) invalid();
      if (Object.keys(p).length && (!uuid(p.assignmentId) || !uuid(p.uid))) invalid();
      return;
    case 'deleteAssignment': case 'restoreAssignment':
      fields(p, ['id', 'rev']); if (!uuid(p.id) || !revision(p.rev)) invalid(); return;
    case 'resolve':
      fields(p, ['conflictId', 'choice', 'expectedHead']);
      if (!uuid(p.conflictId) || !['keep_current', 'accept_incoming', 'mine'].includes(p.choice) || !head(p.expectedHead)) invalid();
      return;
    case 'review':
      fields(p, ['id', 'action', 'expectedHead']);
      if (!string(p.id, 512) || !p.id.includes('/') || !['discard', 'retry'].includes(p.action) || !head(p.expectedHead)) invalid();
      return;
    case 'importLocal':
      fields(p, ['confirm', 'report']); if (typeof p.confirm !== 'boolean') invalid();
      if (p.report !== undefined) {
        if (!Array.isArray(p.report)) invalid();
        jsonData(p.report);
        if (Buffer.byteLength(JSON.stringify(p.report)) > 64 * 1024 * 1024) invalid();
      }
      return;
    default: invalid();
  }
}

function safeError(e) {
  if (e instanceof SyncError) return { kind: e.kind, code: e.code, message: e.message };
  if (e instanceof VaultError) return { kind: 'storage', code: e.code, message: e.message };   // fixed texts, no secrets
  // Only a system error code or the error's class name: never its text, which could quote a path or token.
  const code = e && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(e.code) ? e.code : (e && e.constructor && e.constructor.name) || 'action_failed';
  return { kind: 'local', code, message: 'The account action could not be completed on this computer.' };
}

function registerSyncIpc({ ipcMain, getWindow, appUrl, getHost, isClosing = () => false }) {
  const invoke = async (event, action, p = {}) => {
    try {
      if (!trustedSender(event, getWindow(), appUrl)) throw new SyncError('forbidden', 'untrusted_frame', 'Untrusted app frame.');
      if (typeof action !== 'string') invalid();
      validate(action, p);
      if (isClosing() && !['status', 'getConfig', 'view', 'commit'].includes(action)) {
        throw new SyncError('refused', 'closing', 'The app is preparing to close.');
      }
      const host = getHost();
      if (action === 'status') return { ok: true, result: host.status() };
      const engine = host && host.engine;
      if (!engine) throw new SyncError('config', 'unavailable', 'Account services are unavailable. Local files remain available.');
      const locked = engine.status().locked;
      if (locked && action === 'view') return { ok: true, result: { signedIn: true, locked: true, status: engine.status() } };
      if (locked && action === 'protect' && Object.keys(p).length) {
        throw new SyncError('forbidden', 'locked', 'This account is no longer an active team member.');
      }
      let result;
      switch (action) {
        case 'getConfig': result = engine.publicConfig(); break;
        case 'forgetEmail': result = engine.forgetEmail(); break;
        case 'setConfig': result = engine.setConfig(p); break;
        case 'signIn': result = await engine.signIn(p.email, p.password); break;
        case 'signUp': result = await engine.signUp(p.email, p.password, p.name); break;
        case 'signOut': result = await engine.signOut(); break;
        case 'view': result = engine.view(); break;
        case 'commit': result = engine.commit(p); break;
        case 'syncNow': result = await engine.syncNow(); break;
        case 'conflicts': result = engine.conflicts(); break;
        case 'history': result = await engine.history(p.before); break;
        case 'reviews': result = engine.reviews(); break;
        case 'resolve': result = await engine.resolve(p); break;
        case 'review': result = engine.review(p); break;
        case 'deleteAssignment': result = await engine.deleteAssignment(p); break;
        case 'restoreAssignment': result = await engine.restoreAssignment(p); break;
        case 'protect': result = engine.protect(Object.keys(p).length ? p : null); break;
        case 'importLocal': result = engine.importLocal(p); break;
        default: invalid();
      }
      return { ok: true, result };
    } catch (e) { return { ok: false, error: safeError(e) }; }
  };
  ipcMain.handle('sync:invoke', invoke);
  const sendTo = (channel, value) => {
    const win = getWindow();
    if (!win || win.isDestroyed() || !trustedSender({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, win, appUrl)) return;
    win.webContents.send(channel, value());
  };
  const publish = () => sendTo('sync:status', () => getHost().status());
  // Upload progress: just the counts, so the page updates without reloading the team data.
  const progress = () => sendTo('sync:progress', () => { const s = getHost().status(); return { pending: s.pending, sending: s.sending }; });
  const engine = getHost() && getHost().engine;
  if (engine) {
    for (const event of ['status', 'changed', 'reset']) engine.on(event, publish);
    engine.on('progress', progress);
  }
  return { invoke, publish };
}

module.exports = { registerSyncIpc, validate, safeError };

'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const subscribe = (channel, fn) => {
  if (typeof fn !== 'function') throw new Error('Expected a callback.');
  const listener = (_event, value) => fn(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
async function accountAction(action, payload = {}) {
  const reply = await ipcRenderer.invoke('sync:invoke', action, payload);
  if (!reply || !reply.ok) {
    const detail = reply && reply.error;
    const error = new Error(detail && detail.message || 'Account action failed.');
    error.code = detail && detail.code || 'action_failed';
    error.kind = detail && detail.kind || 'local';
    throw error;
  }
  return reply.result;
}

let closeFlush = null, flushing = null, previousInert = false, closing = false;
ipcRenderer.on('app:flush-request', async (_event, request) => {
  if (!request || typeof request.id !== 'string') return;
  if (!closing) {
    // Grid edits commit on change/blur. Capture the focused cell before taking
    // the save snapshot, rather than losing its last keystrokes on Cmd-W.
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    previousInert = !!(document.documentElement && document.documentElement.inert);
    closing = true;
    if (document.documentElement) document.documentElement.inert = true;
  }
  try {
    if (!closeFlush) throw new Error('Editor not ready.');
    if (!flushing) flushing = Promise.resolve().then(() => closeFlush()).finally(() => { flushing = null; });
    await flushing;
    ipcRenderer.send('app:flush-result', { id: request.id, ok: true });
  } catch (_) { ipcRenderer.send('app:flush-result', { id: request.id, ok: false }); }
});
ipcRenderer.on('app:close-cancelled', () => {
  if (closing && document.documentElement) document.documentElement.inert = previousInert;
  closing = false;
});

/** The renderer gets this narrow surface only — no Node, no fs, no spawn. */
contextBridge.exposeInMainWorld('api', {
  call: (method, params, id) => ipcRenderer.invoke('py:call', { method, params, id }),
  reserveId: () => ipcRenderer.invoke('py:reserveId'),
  cancel: (targetId) => ipcRenderer.invoke('py:cancel', targetId),
  restart: () => ipcRenderer.invoke('py:restart'),

  onProgress: (fn) => ipcRenderer.on('py:progress', (_e, msg) => fn(msg)),
  onStatus: (fn) => ipcRenderer.on('py:status', (_e, msg) => fn(msg)),

  pickFolder: (title) => ipcRenderer.invoke('dialog:pickFolder', title),
  pickZip: () => ipcRenderer.invoke('dialog:pickZip'),
  pickCsv: () => ipcRenderer.invoke('dialog:pickCsv'),
  pickVideoFiles: () => ipcRenderer.invoke('dialog:pickVideoFiles'),
  pickExecutable: () => ipcRenderer.invoke('dialog:pickExecutable'),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  pickSchedule: () => ipcRenderer.invoke('dialog:pickSchedule'),
  saveXlsx: (defaultName, title) => ipcRenderer.invoke('dialog:saveXlsx', defaultName, title),
  // Offline OCR of a schedule picture: a file path, or a PNG data URL (a PDF page).
  ocrScheduleFile: (file) => ipcRenderer.invoke('schedule:ocrFile', file),
  ocrScheduleImage: (dataUrl) => ipcRenderer.invoke('schedule:ocrImage', dataUrl),
  readScheduleFile: (file) => ipcRenderer.invoke('schedule:readPdf', file),
  getStore: (name) => ipcRenderer.invoke('store:get', name),
  setStore: (name, data) => ipcRenderer.invoke('store:set', name, data),
  pickTable: (title) => ipcRenderer.invoke('dialog:pickTable', title),

  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  open: (p) => ipcRenderer.invoke('shell:open', p),
  openFolders: (paths) => ipcRenderer.invoke('shell:openFolders', paths),
  openFolderGroups: (groups) => ipcRenderer.invoke('shell:openFolderGroups', groups),

  setBusy: (busy) => ipcRenderer.invoke('app:setBusy', busy),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onBeforeClose: (fn) => {
    if (typeof fn !== 'function') throw new Error('Expected a callback.');
    closeFlush = fn;
    return () => { if (closeFlush === fn) closeFlush = null; };
  },

  // Explicit actions only: no arbitrary IPC channel, method, URL or raw token API.
  sync: {
    status: () => accountAction('status'),
    getConfig: () => accountAction('getConfig'),
    setConfig: (config) => accountAction('setConfig', config),
    signIn: (email, password) => accountAction('signIn', { email, password }),
    signOut: () => accountAction('signOut'),
    view: () => accountAction('view'),
    commit: (change) => accountAction('commit', change),
    syncNow: () => accountAction('syncNow'),
    conflicts: () => accountAction('conflicts'),
    reviews: () => accountAction('reviews'),
    resolve: (choice) => accountAction('resolve', choice),
    review: (choice) => accountAction('review', choice),
    deleteAssignment: (target) => accountAction('deleteAssignment', target),
    restoreAssignment: (target) => accountAction('restoreAssignment', target),
    mfaStatus: () => accountAction('mfaStatus'),
    mfaEnroll: () => accountAction('mfaEnroll'),
    mfaVerify: (code) => accountAction('mfaVerify', { code }),
    protect: (target) => accountAction('protect', target || {}),
    importLocal: (confirm, report) => accountAction('importLocal', { confirm, ...(report ? { report } : {}) }),
    onStatus: (fn) => subscribe('sync:status', fn),
  },

  // A dropped File no longer carries .path (Electron 32+); ask for it here.
  pathForFile: (file) => webUtils.getPathForFile(file),

  platform: process.platform,
});

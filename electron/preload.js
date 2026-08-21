'use strict';
const { contextBridge, ipcRenderer } = require('electron');

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
  pickVideoFiles: () => ipcRenderer.invoke('dialog:pickVideoFiles'),
  pickExecutable: () => ipcRenderer.invoke('dialog:pickExecutable'),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),

  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  open: (p) => ipcRenderer.invoke('shell:open', p),
  openFolders: (paths) => ipcRenderer.invoke('shell:openFolders', paths),

  setBusy: (busy) => ipcRenderer.invoke('app:setBusy', busy),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  platform: process.platform,
});

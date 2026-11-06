'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  reportCachePath: () => ipcRenderer.invoke('report:cachePath'),
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

  // A dropped File no longer carries .path (Electron 32+); ask for it here.
  pathForFile: (file) => webUtils.getPathForFile(file),

  platform: process.platform,
});

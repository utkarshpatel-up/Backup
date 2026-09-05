'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { PythonBridge } = require('./python-bridge');
app.setName('AV Backup');

let win = null;
let bridge = null;

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch { return {}; }
}
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2));
  return next;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    title: 'AV Backup',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    width: 1360,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12141a' : '#f6f7f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.maximize();

  // A long copy must not be lost to a stray Cmd-W.
  win.on('close', (e) => {
    if (!global.__vingestBusy) return;
    e.preventDefault();
    dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Keep running', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'A copy is still running.',
      detail: 'Quitting now leaves the session folder incomplete.',
    }).then(({ response }) => {
      if (response === 1) { global.__vingestBusy = false; win.destroy(); }
    });
  });
}

function createBridge() {
  bridge = new PythonBridge({
    onProgress: (msg) => send('py:progress', msg),
    onStatus: (msg) => send('py:status', msg),
  });
  return bridge;
}

app.whenReady().then(() => {
  createBridge();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (bridge) bridge.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ------------------------------------------------------------------ IPC

ipcMain.handle('py:call', async (_e, { method, params, id }) => {
  try {
    const result = await bridge.call(method, params, id);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message, traceback: err.traceback };
  }
});

ipcMain.handle('py:reserveId', () => bridge.reserveId());
ipcMain.handle('py:cancel', (_e, targetId) => { bridge.cancel(targetId); return true; });
ipcMain.handle('py:restart', async () => {
  if (bridge) bridge.stop();
  createBridge();
  try { return { ok: true, result: await bridge.start() }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('app:setBusy', (_e, busy) => { global.__vingestBusy = !!busy; return true; });

ipcMain.handle('dialog:pickFolder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, {
    title: title || 'Choose a folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickVideoFiles', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose footage',
    filters: [{ name: 'Video', extensions: ['mov', 'mp4', 'mxf', 'm4v', 'avi', 'mts',
                                            'm2ts', 'mkv', 'braw', 'r3d'] }],
    properties: ['openFile', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:pickZip', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a zip archive',
    defaultPath: app.getPath('downloads'),
    filters: [{ name: 'Zip archives', extensions: ['zip'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickExecutable', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Locate ffprobe',
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:confirm', async (_e, { message, detail, confirmLabel, danger }) => {
  const r = await dialog.showMessageBox(win, {
    type: danger ? 'warning' : 'question',
    buttons: [confirmLabel || 'Continue', 'Cancel'],
    defaultId: danger ? 1 : 0,
    cancelId: 1,
    message,
    detail,
  });
  return r.response === 0;
});

ipcMain.handle('shell:reveal', (_e, p) => {
  fs.existsSync(p) ? shell.showItemInFolder(p) : shell.openPath(path.dirname(p));
  return true;
});
ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));

// Open each existing folder as its own window (Finder on macOS, Explorer on Win).
ipcMain.handle('shell:openFolders', async (_e, paths) => {
  const opened = [];
  const missing = [];
  for (const p of paths || []) {
    if (p && fs.existsSync(p)) { await shell.openPath(p); opened.push(p); }
    else if (p) missing.push(p);
  }
  return { opened, missing };
});

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch));

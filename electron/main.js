'use strict';
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { PythonBridge } = require('./python-bridge');
const { openFolderGroups } = require('./open-folders');
const { ScheduleOcr } = require('./schedule-ocr');
app.setName('AV Backup');

let win = null;
let bridge = null;
let scheduleOcr = null;   // started on the first schedule picture

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

// ------------------------------------------------------------------ theme
// The app ships dark by default. The choice is forced through nativeTheme so it
// wins over the OS setting, and the renderer's CSS (which already carries a full
// dark palette under prefers-color-scheme: dark) follows it live — no reload.
function currentTheme() {
  return loadSettings().theme === 'light' ? 'light' : 'dark';   // default dark
}
function applyTheme(theme) {
  nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          id: 'toggle-dark',
          label: 'Toggle dark mode',
          type: 'checkbox',
          checked: currentTheme() === 'dark',
          accelerator: isMac ? 'Cmd+Shift+D' : 'Ctrl+Shift+D',
          click: (item) => {
            const next = currentTheme() === 'dark' ? 'light' : 'dark';
            saveSettings({ theme: next });
            applyTheme(next);
            item.checked = next === 'dark';
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ role: 'about' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
      // Keep working when the window is minimised or behind another app: Chromium
      // otherwise slows its timers to a crawl, and pdf.js stalls drawing a
      // schedule's pages until the window comes back.
      backgroundThrottling: false,
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
  applyTheme(currentTheme());   // force dark (default) before the window paints
  buildMenu();
  createBridge();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (bridge) bridge.stop();
  if (scheduleOcr) scheduleOcr.close();
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
  const label = title || 'Choose a folder';
  const r = await dialog.showOpenDialog(win, {
    title: label,
    // macOS open panels do not show `title`; `message` is the text the Finder
    // panel actually displays, so set both to keep the prompt visible there —
    // e.g. which drive's session folder to pick under "Only camera clips".
    message: label,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickVideoFiles', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose footage',
    message: 'Choose footage',   // macOS shows `message`, not `title`
    // Media is the default, but audio recorders, images and text guideline
    // files are all selectable — pick "All files" for anything else.
    filters: [
      { name: 'Media (video & audio)', extensions: [
        'mov', 'mp4', 'mxf', 'm4v', 'avi', 'mts', 'm2ts', 'mkv', 'braw', 'r3d', 'crm',
        'wav', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'wma', 'aif', 'aiff'] },
      { name: 'Video', extensions: ['mov', 'mp4', 'mxf', 'm4v', 'avi', 'mts',
                                    'm2ts', 'mkv', 'braw', 'r3d', 'crm'] },
      { name: 'Audio', extensions: ['wav', 'mp3', 'aac', 'm4a', 'flac', 'ogg',
                                    'opus', 'wma', 'aif', 'aiff'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:pickZip', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a zip archive',
    message: 'Choose a zip archive',   // macOS shows `message`, not `title`
    defaultPath: app.getPath('downloads'),
    filters: [{ name: 'Zip archives', extensions: ['zip'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickCsv', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the duration list exported from Frappe (CSV or Excel)',
    message: 'Choose the duration list exported from Frappe (CSV or Excel)',
    defaultPath: app.getPath('downloads'),
    filters: [
      { name: 'Duration list (CSV or Excel)', extensions: ['csv', 'xlsx', 'xlsm'] },
      { name: 'CSV files', extensions: ['csv'] },
      { name: 'Excel files', extensions: ['xlsx', 'xlsm'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickExecutable', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Locate ffprobe',
    message: 'Locate ffprobe',   // macOS shows `message`, not `title`
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

// Open groups of folders as tabbed windows — one window per group (destinations
// in one, camera cards in another), the folders inside it as tabs.
ipcMain.handle('shell:openFolderGroups', (_e, groups) =>
  openFolderGroups(groups, shell, process.platform));

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch));

// ------------------------------------------------------- event schedules

const SCHEDULE_IMAGES = ['png', 'jpg', 'jpeg'];

ipcMain.handle('dialog:pickSchedule', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the event schedule',
    message: 'Choose the event schedule',   // macOS shows `message`, not `title`
    defaultPath: app.getPath('downloads'),
    filters: [
      { name: 'Schedule (picture, PDF, Word, Excel, CSV)',
        extensions: [...SCHEDULE_IMAGES, 'pdf', 'docx', 'xlsx', 'xlsm', 'csv'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:saveXlsx', async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(win, {
    title: "Save the event's sheet",
    message: "Save the event's sheet",
    defaultPath: path.join(app.getPath('downloads'), defaultName || 'Event_Schedule.xlsx'),
    filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
  });
  return r.canceled ? null : r.filePath;
});

/** Read one schedule picture (a file path, or a PDF page rendered by the renderer). */
async function readSchedulePicture(image) {
  if (image.isEmpty()) {
    throw new Error('That picture could not be opened. Save it as a JPG or PNG and try again.');
  }
  const { width, height } = image.getSize();
  if (!scheduleOcr) scheduleOcr = new ScheduleOcr(app.getPath('userData'));
  return scheduleOcr.read(image.toPNG(), { width, height, data: image.toBitmap(), order: 'bgra' });
}

ipcMain.handle('schedule:ocrFile', (_e, file) => readSchedulePicture(nativeImage.createFromPath(file)));
ipcMain.handle('schedule:ocrImage', (_e, dataUrl) => readSchedulePicture(nativeImage.createFromDataURL(dataUrl)));
// The PDF's bytes for pdf.js in the renderer, which has no file access of its own.
ipcMain.handle('schedule:readPdf', (_e, file) => {
  if (!/\.pdf$/i.test(String(file))) throw new Error('Not a PDF.');
  return new Uint8Array(fs.readFileSync(file));
});

// Bigger app data kept beside settings.json: the event schedules (every
// assignment until the operator deletes it) and an imported city list.
const STORES = new Set(['schedules', 'cities']);
const storeFile = (name) => path.join(app.getPath('userData'), `${name}.json`);
ipcMain.handle('store:get', (_e, name) => {
  if (!STORES.has(name)) throw new Error(`Unknown store: ${name}`);
  try { return JSON.parse(fs.readFileSync(storeFile(name), 'utf8')); } catch { return null; }
});
ipcMain.handle('store:set', (_e, name, data) => {
  if (!STORES.has(name)) throw new Error(`Unknown store: ${name}`);
  const file = storeFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write then rename, so a crash mid-write never leaves a half file behind.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
  return true;
});

ipcMain.handle('dialog:pickTable', async (_e, title) => {
  const label = title || 'Choose a spreadsheet';
  const r = await dialog.showOpenDialog(win, {
    title: label,
    message: label,   // macOS shows `message`, not `title`
    defaultPath: app.getPath('downloads'),
    filters: [{ name: 'Excel or CSV', extensions: ['xlsx', 'xlsm', 'csv'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

'use strict';
// Electron main for scripts/renderer-harness.js. Loads the renderer offscreen with a mock
// preload, so nothing shows on screen and nothing leaves the temp profile.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.AVB_HARNESS_DIR;
if (!dir || !fs.existsSync(dir)) throw new Error('Requires scripts/renderer-harness.js.');
app.setPath('userData', dir);
app.setPath('sessionData', dir);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('js-flags', '--expose-gc');
app.on('window-all-closed', () => {});   // the checks open one window after another
const fail = (e) => { console.error(e && e.stack || e); app.exit(1); };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

const root = process.env.AVB_HARNESS_ROOT;
const consoleErrors = [];

async function open(params, width = 1280, height = 820) {
  const win = new BrowserWindow({ width, height, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: false, sandbox: true, preload: path.join(__dirname, 'mock-preload.js'), backgroundThrottling: false } });
  win.webContents.setFrameRate(60);
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) consoleErrors.push(message); });
  win.webContents.on('render-process-gone', (_e, d) => fail(new Error(`renderer gone: ${d.reason}`)));
  await win.loadFile(path.join(root, 'renderer/index.html'), { query: params });
  await until(win, 'typeof state !== "undefined" && window.__booted && !state.busy');
  return win;
}
async function until(win, expr, timeout = 30000) {
  const start = Date.now();
  while (!await win.webContents.executeJavaScript(`!!(${expr})`)) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const run = (win, file, arg) => win.webContents.executeJavaScript(
  `(${fs.readFileSync(path.join(__dirname, file), 'utf8')})(${JSON.stringify(arg || {})})`);

app.whenReady().then(async () => {
  const mode = process.env.AVB_HARNESS_MODE;
  const shared = { open, run, until, app, root, consoleErrors, out: process.env.AVB_HARNESS_OUT, dir };
  await require(mode === 'perf' ? './perf.cjs' : './account.cjs')(shared);
  if (consoleErrors.length) throw new Error(`Renderer console errors:\n${consoleErrors.join('\n')}`);
  app.exit(0);
}).catch(fail);

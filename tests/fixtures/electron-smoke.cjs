'use strict';
// Runs under the actual Electron binary, not Node or a mocked browser.
const electron = require('electron');
const { app, net } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const { once } = require('node:events');
const { Client } = require('../../electron/sync/client');
const { createSyncHost } = require('../../electron/sync/host');
const dir = process.env.AVB_SMOKE_DIR;
if (!dir || !fs.existsSync(dir)) throw new Error('Requires the isolated smoke-test runner.');
app.setPath('userData', dir);
app.setPath('sessionData', dir);
process.on('uncaughtException', (error) => { console.error(error.stack); app.exit(1); });
process.on('unhandledRejection', (error) => { console.error(error && error.stack || error); app.exit(1); });
const NativeWindow = electron.BrowserWindow;
const windows = [], errors = [], servers = [];
let mainWindow;
class HiddenWindow extends NativeWindow {
  constructor(options) { super({ ...options, show: false }); windows.push(this); }
  maximize() {} // The test never takes over the user's screen.
}
const testElectron = Object.create(electron);
Object.defineProperty(testElectron, 'BrowserWindow', { value: HiddenWindow });
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'electron' && parent && parent.filename === path.resolve(__dirname, '../../electron/main.js')) return testElectron;
  return load.call(this, request, parent, ...rest);
};
app.on('web-contents-created', (_event, wc) => {
  wc.on('preload-error', (_e, _file, error) => errors.push(error.message));
  wc.on('render-process-gone', (_e, detail) => errors.push(`renderer gone: ${detail.reason}`));
});
const listen = async (server) => { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
const waitFor = async (fn, timeout = 15000) => {
  const start = Date.now();
  while (!await fn()) {
    if (Date.now() - start > timeout) throw new Error('Smoke readiness condition timed out.');
    await new Promise((r) => setTimeout(r, 30));
  }
};
const closeServers = async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
};
function pdfFixture() {
  const stream = 'BT /F1 24 Tf 30 100 Td (AV Backup smoke) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return `${text}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

// Listener is installed before the production entry point registers its ready callback.
app.on('browser-window-created', (_event, win) => {
  if (mainWindow) return;
  mainWindow = win;
  win.webContents.once('did-finish-load', () => run().catch(async (error) => {
    console.error('Electron smoke failed:', error.stack);
    await closeServers();
    app.exit(1);
  }));
});

async function run() {
  const w = mainWindow;
  await waitFor(async () => w.webContents.executeJavaScript('typeof state !== "undefined" && (state.engine.ready || !!state.engine.error) && !state.busy'));
  assert.equal(errors.length, 0, errors.join('\n'));
  const preferences = w.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  const status = await w.webContents.executeJavaScript('window.api.sync.status()');
  assert.equal(status.mode, 'local');
  assert.equal(status.signedIn, false);
  assert.equal(fs.existsSync(path.join(dir, 'accounts')), false);
  assert.equal(await w.webContents.executeJavaScript('typeof window.api.pathForFile'), 'function');
  console.log(`PASS Electron ${process.versions.electron}: isolated local-mode startup and sandboxed preload`);

  // The Account page on the real preload: drawn once, then left alone by a redraw, without touching the local profile.
  const account = await w.webContents.executeJavaScript(`showSync().then(() => {
    const page = document.querySelector('.sync-page'), advanced = document.getElementById('syncAdvanced');
    const url = document.getElementById('syncServerUrl'); url.value = 'typing';
    render();
    return { samePage: page === document.querySelector('.sync-page'), kept: document.getElementById('syncServerUrl').value, closed: !advanced.open, on: document.getElementById('syncEnabled').checked };
  })`);
  assert.deepEqual(account, { samePage: true, kept: 'typing', closed: true, on: false });
  await w.webContents.executeJavaScript('showSchedule()');
  console.log('PASS Account page renders and keeps typed fields on the real preload');

  const pdfPath = path.join(dir, 'smoke.pdf');
  fs.writeFileSync(pdfPath, pdfFixture());
  const pages = await w.webContents.executeJavaScript(`schedulePdfPages(${JSON.stringify(pdfPath)}).then(pages => ({ count: pages.length, png: pages[0].startsWith('data:image/png') }))`);
  assert.deepEqual(pages, { count: 1, png: true });
  const recognized = await w.webContents.executeJavaScript(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 180;
    const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 800, 180);
    context.fillStyle = 'black'; context.font = '54px sans-serif'; context.fillText('AV BACKUP SMOKE', 25, 110);
    return window.api.ocrScheduleImage(canvas.toDataURL()).then(result => result.rows.length);
  })()`);
  assert.ok(recognized > 0);
  console.log('PASS sandbox compatibility: real PDF rendering and local OCR through preload/main');

  const outside = new HiddenWindow({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: path.resolve(__dirname, '../../electron/preload.js') } });
  const outsideFile = path.join(dir, 'outside.html');
  fs.writeFileSync(outsideFile, '<!doctype html><title>Untrusted smoke page</title>');
  await outside.loadFile(outsideFile);
  const denied = await outside.webContents.executeJavaScript('window.api.getSettings().then(() => "unexpected success", e => e.message)');
  assert.match(denied, /Untrusted app frame/);
  outside.destroy();
  console.log('PASS real IPC denies a different window using the same preload');

  let destinationRequests = 0;
  const target = await listen(http.createServer((_req, res) => { destinationRequests++; res.end('{}'); }));
  let redirect = false;
  const source = await listen(http.createServer((_req, res) => {
    if (redirect) { res.writeHead(302, { Location: target }); res.end(); }
    else { res.setHeader('Content-Type', 'application/json'); res.end('{"protocol_version":1}'); }
  }));
  const host = createSyncHost({ dir: path.join(dir, 'transport'), safeStorage: electron.safeStorage });
  const client = new Client({ serverUrl: source, fetch: host.engine.fetchImpl });
  assert.deepEqual(await client.rpc('smoke-only-token', 'avb_me'), { protocol_version: 1 });
  redirect = true;
  await assert.rejects(client.rpc('smoke-only-token', 'avb_me'));
  assert.equal(destinationRequests, 0);
  console.log('PASS app transport (Node fetch) redirect:error: redirect destination receives no request or token');

  const key = path.join(dir, 'tls-key.pem'), cert = path.join(dir, 'tls-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'pipe' });
  const tls = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => res.end('{}'));
  await listen(tls);
  const tlsBase = `https://127.0.0.1:${tls.address().port}`;
  const badTls = new Client({ serverUrl: tlsBase, fetch: host.engine.fetchImpl });
  await assert.rejects(badTls.rpc('smoke-only-token', 'avb_me'));
  console.log('PASS untrusted TLS certificate is refused, with no certificate bypass');

  let prevented = false;
  for (const eventName of ['will-navigate', 'will-frame-navigate']) {
    w.webContents.on(eventName, (event) => { if (event.defaultPrevented) prevented = true; });
  }
  const originalUrl = w.webContents.getURL();
  await w.webContents.executeJavaScript(`location.href = ${JSON.stringify(source)}; undefined`);
  await waitFor(() => prevented);
  assert.equal(w.webContents.getURL(), originalUrl);
  const count = NativeWindow.getAllWindows().length;
  await w.webContents.executeJavaScript(`window.open(${JSON.stringify(source)}); undefined`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(NativeWindow.getAllWindows().length, count);
  console.log('PASS real navigation and popup blocking');

  await w.webContents.executeJavaScript(`(() => {
    const item = { id: 'smoke-schedule', sessions: [], rows: [['smoke']], starts: {}, defaults: {} };
    state.schedules = { openId: item.id, items: [item] }; state.schedule = item;
    const input = document.createElement('input'); document.body.append(input);
    input.addEventListener('change', () => { item.label = input.value; scheduleRemember(); });
    input.focus();
    scheduleRemember();
  })()`);
  await w.webContents.insertText('typed-before-close');
  const closed = once(w, 'closed');
  w.close();
  await closed;
  const store = JSON.parse(fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8'));
  assert.equal(store.items[0].id, 'smoke-schedule');
  assert.equal(store.openId, 'smoke-schedule');
  assert.equal(store.items[0].label, 'typed-before-close', 'the focused field commits before the close snapshot');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS real close handshake saves the pending schedule to isolated userData');
  await closeServers();
  if (process.platform !== 'darwin') {
    console.log('AVB_ELECTRON_SMOKE_COMPLETE'); app.exit(0); return;
  }
  // macOS keeps the app alive after closing its window. Reopen, then exercise
  // app.quit(), the path used by the menu/keyboard command rather than Cmd-W.
  const created = once(app, 'browser-window-created');
  app.emit('activate');
  const [, second] = await created;
  await once(second.webContents, 'did-finish-load');
  await waitFor(() => second.webContents.executeJavaScript('typeof state !== "undefined" && (state.engine.ready || !!state.engine.error) && !state.busy'));
  await second.webContents.executeJavaScript('state.schedule.label = "saved-on-app-quit"; scheduleRemember();');
  app.once('will-quit', () => {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8'));
      assert.equal(saved.items[0].label, 'saved-on-app-quit');
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log('PASS macOS app.quit() also waits for the pending local save');
      console.log('AVB_ELECTRON_SMOKE_COMPLETE');
    } catch (error) { console.error(error.stack); app.exit(1); }
  });
  app.quit();
}

require('../../electron/main');

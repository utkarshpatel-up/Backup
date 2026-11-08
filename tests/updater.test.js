'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdater, isNewer, updateMode, parseRelease } = require('../electron/updater');

const REL = 'https://github.com/utkarshpatel-up/Backup/releases/';
const release = (over = {}) => ({
  tag_name: 'v1.7.0', html_url: `${REL}tag/v1.7.0`, body: '- New thing',
  assets: [{ name: 'AV-Backup-1.7.0-mac-arm64.dmg', size: 5, browser_download_url: `${REL}download/v1.7.0/AV-Backup-1.7.0-mac-arm64.dmg` }],
  ...over,
});

test('isNewer compares numerically', () => {
  assert.equal(isNewer('v1.10.0', '1.9.9'), true);
  assert.equal(isNewer('1.7.0', '1.7.0'), false);
  assert.equal(isNewer('1.6.10', '1.7.0'), false);
  assert.equal(isNewer('2.0.0-beta', '1.9.0'), true);
});

test('updateMode: only an installed Windows copy self-installs', () => {
  const app = { isPackaged: true, getName: () => 'AV Backup' };
  const exe = 'C:\\Users\\x\\AppData\\Local\\Programs\\av-backup\\AV Backup.exe';
  assert.equal(updateMode({ app, platform: 'win32', execPath: exe, exists: (p) => p.endsWith('Uninstall AV Backup.exe') }), 'install');
  assert.equal(updateMode({ app, platform: 'win32', execPath: exe, exists: () => false }), 'page');   // portable zip
  assert.equal(updateMode({ app, platform: 'darwin' }), 'dmg');
  assert.equal(updateMode({ app: { ...app, isPackaged: false }, platform: 'darwin' }), 'page');
});

test('parseRelease keeps only this repo\'s assets for this arch', () => {
  const r = parseRelease(release(), 'arm64');
  assert.equal(r.version, '1.7.0');
  assert.equal(r.dmg.name, 'AV-Backup-1.7.0-mac-arm64.dmg');
  assert.equal(parseRelease(release(), 'x64').dmg, null);
  const foreign = release({ assets: [{ ...release().assets[0], browser_download_url: 'https://evil.example/x.dmg' }] });
  assert.equal(parseRelease(foreign, 'arm64').dmg, null);
  assert.throws(() => parseRelease(release({ html_url: 'https://evil.example/' })));
  // From 1.7.2 one universal DMG serves both chips, and wins over a per-chip one.
  const uni = { name: 'AV-Backup-1.7.2-mac-universal.dmg', size: 7, browser_download_url: `${REL}download/v1.7.2/AV-Backup-1.7.2-mac-universal.dmg` };
  for (const arch of ['arm64', 'x64']) assert.equal(parseRelease(release({ assets: [...release().assets, uni] }), arch).dmg.name, uni.name);
});

function fakeUpdater({ size, bytes, json = release() }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avb-upd-'));
  const opened = [], states = [];
  const app = { isPackaged: true, getName: () => 'AV Backup', getVersion: () => '1.6.9', getPath: () => dir };
  const net = { fetch: async (url) => (url.includes('api.github.com')
    ? { ok: true, status: 200, json: async () => ({ ...json, assets: [{ ...json.assets[0], name: `AV-Backup-1.7.0-mac-${process.arch}.dmg`, size }] }) }
    : { ok: true, status: 200, body: (async function* () { yield Buffer.from(bytes); })() }) };
  const shell = { openPath: async (p) => { opened.push(p); return ''; }, openExternal: async (u) => { opened.push(u); } };
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try { return { u: createUpdater({ app, shell, net, send: (s) => states.push(s.phase), approveQuit: async () => true }), dir, opened, states }; }
  finally { Object.defineProperty(process, 'platform', { value: realPlatform }); }
}

test('mac: newer release is offered with its notes, DMG downloaded and opened', async () => {
  const { u, dir, opened } = fakeUpdater({ size: 5, bytes: 'hello' });
  const s = await u.check();
  assert.equal(s.phase, 'available'); assert.equal(s.version, '1.7.0'); assert.equal(s.notes, '- New thing');
  assert.equal((await u.download()).phase, 'opened');
  assert.equal(opened[0], path.join(dir, `AV-Backup-1.7.0-mac-${process.arch}.dmg`));
  assert.equal(fs.readFileSync(opened[0], 'utf8'), 'hello');
});

test('mac: a truncated download is deleted and never opened', async () => {
  const { u, dir, opened } = fakeUpdater({ size: 9, bytes: 'hello' });
  await u.check();
  const s = await u.download();
  assert.equal(s.phase, 'available'); assert.match(s.message, /could not be downloaded/);
  assert.deepEqual(opened, []); assert.deepEqual(fs.readdirSync(dir), []);
});

test('same version is "up to date"', async () => {
  const { u } = fakeUpdater({ size: 5, bytes: 'hello', json: release({ tag_name: 'v1.6.9' }) });
  assert.equal((await u.check()).phase, 'none');
});

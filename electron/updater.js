'use strict';
// In-app updates from this repo's GitHub Releases (published by .github/workflows/release.yml
// when a version tag is pushed). The release body is the version's CHANGELOG.md section.
//   - Windows, installed copy: electron-updater downloads only the changed blocks of the
//     installer and installs it on restart (after the app's normal save-before-quit).
//   - macOS: the builds are not signed with an Apple Developer ID, so macOS does not let the
//     app replace itself. Download this Mac's DMG and open it; the user drags it to Applications.
//   - Anything else (the portable Windows zip, running from source): open the release page.
const fs = require('fs');
const path = require('path');

const REPO = 'utkarshpatel-up/Backup';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const PAGE_PREFIX = `https://github.com/${REPO}/releases/`;

/** True when version a is newer than b ("v1.10.0" > "1.9.2"); pre-release suffixes are ignored. */
function isNewer(a, b) {
  const parts = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** 'install' (Windows installer copy), 'dmg' (packaged Mac) or 'page'. */
function updateMode({ app, platform = process.platform, execPath = process.execPath, exists = fs.existsSync }) {
  if (!app.isPackaged) return 'page';
  if (platform === 'darwin') return 'dmg';
  // The NSIS installer puts its uninstaller next to the exe; the portable zip has none.
  if (platform === 'win32' && exists(path.join(path.dirname(execPath), `Uninstall ${app.getName()}.exe`))) return 'install';
  return 'page';
}

/** The parts of a GitHub "latest release" answer the app uses, validated; throws on anything else. */
function parseRelease(json, arch = process.arch) {
  if (!json || typeof json.tag_name !== 'string' || typeof json.html_url !== 'string' || !json.html_url.startsWith(PAGE_PREFIX)) {
    throw new Error('unexpected release');
  }
  const ok = (a, suffix) => a && typeof a.name === 'string' && a.name.endsWith(suffix)
    && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(DOWNLOAD_PREFIX)
    && Number.isSafeInteger(a.size) && a.size > 0;
  const assets = Array.isArray(json.assets) ? json.assets : [];
  // Releases from 1.7.2 carry one universal DMG; earlier ones one per chip.
  const dmg = assets.find((a) => ok(a, '-mac-universal.dmg')) || assets.find((a) => ok(a, `-mac-${arch}.dmg`));
  return {
    version: json.tag_name.replace(/^v/, ''),
    notes: typeof json.body === 'string' ? json.body.slice(0, 20000) : '',
    page: json.html_url,
    dmg: dmg ? { name: path.basename(dmg.name), url: dmg.browser_download_url, size: dmg.size } : null,
  };
}

function createUpdater({ app, shell, net, send, approveQuit }) {
  const mode = updateMode({ app });
  let release = null, busy = false, nsis = null;
  let state = { phase: 'idle', current: app.getVersion(), mode };
  const set = (patch) => { state = { ...state, ...patch }; send(state); return state; };
  const fail = (message) => set({ phase: 'error', message });

  async function check() {
    if (busy) return state;
    set({ phase: 'checking', message: '' });
    try {
      const res = await net.fetch(LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AV-Backup-updater' }, cache: 'no-store' });
      if (res.status === 404) return set({ phase: 'none' });   // no published release yet
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      release = parseRelease(await res.json());
    } catch (_) {
      return fail('Could not check for updates. Check the internet connection and try again.');
    }
    if (!isNewer(release.version, state.current)) return set({ phase: 'none' });
    return set({ phase: 'available', version: release.version, notes: release.notes });
  }

  function nsisUpdater() {
    if (nsis) return nsis;
    nsis = require('electron-updater').autoUpdater;
    nsis.autoDownload = false;
    nsis.autoInstallOnAppQuit = true;   // a downloaded update also installs on a normal quit
    nsis.on('download-progress', (p) => set({ phase: 'downloading', percent: Math.round(p.percent || 0) }));
    return nsis;
  }

  async function downloadDmg(dmg) {
    const dir = app.getPath('downloads');
    const file = path.join(dir, dmg.name), part = `${file}.part`;
    const res = await net.fetch(dmg.url, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const out = fs.createWriteStream(part);
    let got = 0;
    try {
      for await (const chunk of res.body) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        set({ phase: 'downloading', percent: Math.min(99, Math.round((got / dmg.size) * 100)) });
      }
    } finally { await new Promise((r) => out.end(r)); }
    // A short or padded file is a broken download: never open it.
    if (got !== dmg.size) { fs.rmSync(part, { force: true }); throw new Error('size mismatch'); }
    fs.renameSync(part, file);
    return file;
  }

  async function download() {
    if (busy || state.phase !== 'available' || !release) return state;
    if (mode === 'page' || (mode === 'dmg' && !release.dmg)) { await shell.openExternal(release.page); return state; }
    busy = true;
    set({ phase: 'downloading', percent: 0, message: '' });
    try {
      if (mode === 'install') {
        const u = nsisUpdater();
        const found = await u.checkForUpdates();
        if (!found || !found.updateInfo || !isNewer(found.updateInfo.version, state.current)) throw new Error('no update in latest.yml');
        await u.downloadUpdate();
        return set({ phase: 'ready', version: found.updateInfo.version });
      }
      const file = await downloadDmg(release.dmg);
      const err = await shell.openPath(file);
      if (err) throw new Error(err);
      return set({ phase: 'opened', file });
    } catch (_) {
      // Stay 'available' so the button can be pressed again.
      return set({ phase: 'available', message: 'The update could not be downloaded. Try again, or open the release page.' });
    } finally { busy = false; }
  }

  async function restart() {
    if (mode !== 'install' || state.phase !== 'ready' || !nsis) return state;
    // Same save-and-confirm path as closing the window; a "Keep app open" answer cancels.
    if (!await approveQuit()) return state;
    nsis.quitAndInstall(true, true);
    return state;
  }

  const openPage = () => (release ? shell.openExternal(release.page) : shell.openExternal(PAGE_PREFIX)).then(() => state);
  return { status: () => state, check, download, restart, openPage };
}

module.exports = { createUpdater, isNewer, updateMode, parseRelease };

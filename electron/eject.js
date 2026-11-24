'use strict';
/**
 * Eject a card with one shortcut, from anywhere — Explorer included.
 *
 * Windows has no eject key of its own (Finder's Cmd+E has no Explorer twin), so
 * the app registers a system-wide shortcut while it runs. On a press it looks at
 * the window in front: an Explorer window gives the drive of its selected item,
 * else of the folder it shows. With no Explorer drive, the page ejects the
 * camera cards of the backup on screen. The page decides whether a drive is in
 * use before anything is ejected; the system drive is never ejected.
 */
const { execFile } = require('child_process');
const fs = require('fs');

const ACCELERATORS = process.platform === 'darwin'
  ? ['Command+Alt+E', 'Command+Alt+J']
  : ['Control+Alt+E', 'Control+Alt+J'];

/** The drive a path is on: 'M:' on Windows, '/Volumes/NAME' on the Mac. */
function driveOf(p, platform = process.platform) {
  const s = String(p || '');
  if (platform === 'win32') {
    const m = /^([A-Za-z]):/.exec(s);
    return m ? `${m[1].toUpperCase()}:` : '';
  }
  const m = /^\/Volumes\/[^/]+/.exec(s);
  return m ? m[0] : '';
}

/**
 * The drive(s) to eject from what the front Explorer window shows: the
 * selected items' drives, else the shown folders' (several tabs may share a
 * window). More than one drive is ambiguous: nothing is chosen.
 */
function pickDrives(target, platform = process.platform) {
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const drives = (paths) => [...new Set(list(paths).map((p) => driveOf(p, platform)).filter(Boolean))];
  const fromSelection = drives(target && target.selected);
  const chosen = fromSelection.length ? fromSelection : drives(target && target.folders);
  if (chosen.length > 1) return { drives: [], ambiguous: chosen };
  return { drives: chosen, ambiguous: [] };
}

/** Drives that must never be ejected: Windows' own and the one the app runs from. */
function protectedDrives(platform = process.platform, appPath = process.execPath) {
  if (platform === 'win32') {
    return new Set([String(process.env.SystemDrive || 'C:').toUpperCase(), driveOf(appPath, platform)].filter(Boolean));
  }
  return new Set([driveOf(appPath, platform)].filter(Boolean));
}

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }));
  });
}

const WIN_FRONT_EXPLORER = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public class AvbFg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@
$fg = [AvbFg]::GetForegroundWindow().ToInt64()
$sel = @(); $dirs = @()
foreach ($w in (New-Object -ComObject Shell.Application).Windows()) {
  try { if ([int64]$w.HWND -ne $fg) { continue } } catch { continue }
  try { foreach ($i in $w.Document.SelectedItems()) { $sel += [string]$i.Path } } catch {}
  try { $dirs += [string]$w.Document.Folder.Self.Path } catch {}
}
ConvertTo-Json -Compress -InputObject @{ selected = @($sel); folders = @($dirs) }
`;

/** What the window in front shows, when it is an Explorer window (Windows only). */
async function frontExplorerTarget(platform = process.platform) {
  if (platform !== 'win32') return { selected: [], folders: [] };
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', WIN_FRONT_EXPLORER]);
  try { return JSON.parse(r.stdout.trim() || '{}'); } catch (_) { return { selected: [], folders: [] }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Eject one drive. Resolves {drive, ejected, error}. */
async function ejectDrive(drive, platform = process.platform, appPath = process.execPath) {
  const key = platform === 'win32' ? String(drive || '').toUpperCase() : String(drive || '');
  if (!key || protectedDrives(platform, appPath).has(key)) {
    return { drive, ejected: false, error: 'This is a system drive; it is never ejected.' };
  }
  if (platform === 'win32') {
    if (!/^[A-Z]:$/.test(drive)) return { drive, ejected: false, error: 'Not a drive letter.' };
    await run('powershell.exe', ['-NoProfile', '-Command',
      `(New-Object -comObject Shell.Application).Namespace(17).ParseName('${drive}').InvokeVerb('Eject')`], 60000);
    // Explorer's Eject reports nothing back: the drive going away is the answer.
    for (let i = 0; i < 16; i += 1) {
      if (!fs.existsSync(`${drive}\\`)) return { drive, ejected: true, error: '' };
      await sleep(500);
    }
    return { drive, ejected: false, error: 'Windows did not eject it — a program still has a file on it open.' };
  }
  if (!/^\/Volumes\/[^/]+$/.test(drive)) return { drive, ejected: false, error: 'Not a removable volume.' };
  const r = await run('diskutil', ['eject', drive], 60000);
  return { drive, ejected: r.ok, error: r.ok ? '' : (r.stderr.trim() || 'Eject failed') };
}

module.exports = { ACCELERATORS, driveOf, pickDrives, protectedDrives, frontExplorerTarget, ejectDrive };

'use strict';
//
// Open sets of folders as GROUPED, TABBED windows in the OS file manager.
//
// The "Open both Clips for Insert folders" button hands us groups: the first is
// every destination drive's "Clips for Insert" folder, the second is every
// camera-card folder the clips came from. We open ONE window per group with the
// folders inside it as tabs, so the operator gets destinations in one window and
// cards in another to compare side by side — instead of a scatter of separate
// windows landing wherever the shell chose.
//
// Neither Windows Explorer nor macOS Finder exposes a supported API to open a
// folder as a tab, so the tab step is UI automation (SendKeys / System Events)
// run best-effort. If it cannot run, each group still opens — its folders as
// plain windows — so the button never silently does nothing.
//
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

/** Keep only folders that still exist; report the rest as missing. */
function partitionExisting(groups) {
  const opened = [];
  const missing = [];
  const cleaned = groups.map((g) => {
    const keep = [];
    for (const p of g || []) {
      if (p && fs.existsSync(p)) { keep.push(p); opened.push(p); }
      else if (p) missing.push(p);
    }
    return keep;
  }).filter((g) => g.length);
  return { cleaned, opened, missing };
}

// ---------------------------------------------------------------- Windows

// SendKeys treats + ^ % ~ ( ) { } [ ] as control characters; a literal one must
// be wrapped in braces, e.g. "(" -> "{(}". Everything else types as itself.
function sendKeysEscape(text) {
  let out = '';
  for (const ch of String(text)) {
    out += '+^%~(){}[]'.includes(ch) ? `{${ch}}` : ch;
  }
  return out;
}

// The path typed into the address bar needs per-path SendKeys escaping, so each
// path is pre-escaped in JS and carried alongside its raw form (raw for launching
// the first window and matching it in the shell window list).
function windowsScriptFull(groups) {
  const json = JSON.stringify(
    groups.map((g) => g.map((p) => ({ raw: p, keys: sendKeysEscape(p) })))
  ).replace(/'/g, "''");
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Nw {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
}
"@
$groups = ConvertFrom-Json '${json}'
$shell = New-Object -ComObject Shell.Application
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

function Norm($p) { try { return ([IO.Path]::GetFullPath($p)).TrimEnd('\\') } catch { return $p } }
function Find-HWND($p) {
  $target = Norm $p
  foreach ($w in $shell.Windows()) {
    try { if ((Norm $w.Document.Folder.Self.Path) -ieq $target) { return [IntPtr]$w.HWND } } catch {}
  }
  return [IntPtr]::Zero
}

# Tile the group windows across the work area: with two groups the destinations
# land on the left half and the cards on the right, so they sit side by side.
$n = @($groups).Count
$k = 0
foreach ($g in $groups) {
  $paths = @($g)
  if ($paths.Count -eq 0) { $k++; continue }
  Start-Process explorer.exe -ArgumentList ('"' + $paths[0].raw + '"')
  Start-Sleep -Milliseconds 1100
  $h = Find-HWND $paths[0].raw
  if ($h -eq [IntPtr]::Zero) { $k++; continue }
  $x = [int]($wa.X + [math]::Floor($k * $wa.Width / $n))
  $w = [int][math]::Floor($wa.Width / $n)
  [Nw]::ShowWindow($h, 9) | Out-Null          # SW_RESTORE (un-maximize before moving)
  Start-Sleep -Milliseconds 150
  [Nw]::MoveWindow($h, $x, $wa.Y, $w, $wa.Height, $true) | Out-Null
  Start-Sleep -Milliseconds 200
  for ($i = 1; $i -lt $paths.Count; $i++) {
    [Nw]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait('^t')        # new tab (opens on Home)
    Start-Sleep -Milliseconds 800
    [Nw]::SetForegroundWindow($h) | Out-Null               # re-assert focus on the tab
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait('%d')        # Alt+D: focus the address bar
    Start-Sleep -Milliseconds 450
    [System.Windows.Forms.SendKeys]::SendWait('^a')        # select whatever it holds
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait($paths[$i].keys)
    Start-Sleep -Milliseconds 350
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 800
  }
  $k++
}
`;
}

function openWindows(groups) {
  return new Promise((resolve) => {
    const script = windowsScriptFull(groups);
    const file = path.join(os.tmpdir(),
      `av-open-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    try { fs.writeFileSync(file, script, 'utf8'); }
    catch { return resolve(false); }
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file],
      { windowsHide: true, timeout: 60000 },
      (err) => {
        try { fs.unlinkSync(file); } catch {}
        resolve(!err);
      });
  });
}

// ---------------------------------------------------------------- macOS

function applescriptQuote(p) {
  return String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function macScript(groups) {
  let s = 'tell application "Finder" to activate\n';
  for (const g of groups) {
    if (!g.length) continue;
    s += `tell application "Finder"
  set w to make new Finder window
  set target of w to POSIX file "${applescriptQuote(g[0])}"
  set index of w to 1
end tell
delay 0.5
`;
    for (let i = 1; i < g.length; i++) {
      // The keystroke needs Accessibility permission; if it is not granted the
      // try block swallows the error so the folder still opens (as a window), the
      // script still exits 0, and no duplicate fallback opening is triggered.
      s += `try
  tell application "System Events" to tell process "Finder"
    set frontmost to true
    keystroke "t" using command down
  end tell
  delay 0.4
  tell application "Finder"
    set target of front Finder window to POSIX file "${applescriptQuote(g[i])}"
  end tell
on error
  tell application "Finder"
    set w2 to make new Finder window
    set target of w2 to POSIX file "${applescriptQuote(g[i])}"
  end tell
end try
delay 0.35
`;
    }
  }
  return s;
}

function openMac(groups) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', macScript(groups)], { timeout: 60000 },
      (err) => resolve(!err));
  });
}

// ---------------------------------------------------------------- fallback

// If the OS tabbing script fails or is unavailable, open every folder as its own
// window through Electron's shell so the button always does something visible.
async function fallbackOpen(groups, shell) {
  for (const g of groups) {
    for (const p of g) { try { await shell.openPath(p); } catch {} }
  }
}

/**
 * Open each group as one tabbed file-manager window.
 * groups: array of arrays of absolute folder paths.
 * Returns { opened, missing } listing the folders that existed / were gone.
 */
async function openFolderGroups(groups, shell, platform) {
  const { cleaned, opened, missing } = partitionExisting(groups || []);
  if (!cleaned.length) return { opened, missing };
  let ok = false;
  try {
    if (platform === 'win32') ok = await openWindows(cleaned);
    else if (platform === 'darwin') ok = await openMac(cleaned);
  } catch { ok = false; }
  if (!ok) await fallbackOpen(cleaned, shell);
  return { opened, missing };
}

module.exports = { openFolderGroups };

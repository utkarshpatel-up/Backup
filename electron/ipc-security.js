'use strict';

/** Only the expected top-level local page in the app window may use privileged IPC. */
function trustedSender(event, win, appUrl) {
  try {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
    const frame = event.senderFrame;
    if (!frame || frame !== win.webContents.mainFrame) return false;
    const url = new URL(frame.url);
    url.hash = '';
    return url.href === appUrl;
  } catch (_) { return false; }
}

function trustedHandle(ipcMain, getWindow, appUrl) {
  return (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event, getWindow(), appUrl)) throw new Error('Untrusted app frame.');
    return handler(event, ...args);
  });
}

function restrictNavigation(contents, appUrl) {
  const check = (event, url) => {
    try { const u = new URL(url); u.hash = ''; if (u.href === appUrl) return; } catch (_) { /* refuse */ }
    event.preventDefault();
  };
  contents.on('will-navigate', check);
  contents.on('will-redirect', check);
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame === false) event.preventDefault();
    else check(event, event.url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

module.exports = { trustedSender, trustedHandle, restrictNavigation };

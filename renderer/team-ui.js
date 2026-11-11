'use strict';
// Sidebar "Team server" box (electron/team-server.js probes; the page never picks the address).
// Each state is spelled out in text; the dot is decoration only.
(() => {
  const box = document.getElementById('team');
  const lines = document.getElementById('teamLines');
  if (!box || !lines || !window.api || !window.api.teamServer) return;
  const ZT = { connected: ['Connected', 'ok'], disconnected: ['Not connected', 'err'], unknown: ['Not a ZeroTier IP', ''] };
  const PB = { up: ['Running', 'ok'], down: ['Not reachable', 'err'] };
  let shown = null, running = false, again = false, configKey;

  function row(text, cls) {
    const d = document.createElement('div');
    d.className = 'team-line';
    if (cls !== undefined) {
      const dot = document.createElement('span');
      dot.className = `dot ${cls}`; dot.setAttribute('aria-hidden', 'true');
      d.append(dot);
    }
    d.append(text);
    return d;
  }
  function render(s) {
    const items = !s ? [['Status unavailable']]
      : s.mode !== 'account' ? [['Local mode']]
        : [[`ZeroTier: ${(ZT[s.zerotier] || ZT.unknown)[0]}`, (ZT[s.zerotier] || ZT.unknown)[1]],
          [`PocketBase: ${(PB[s.pocketbase] || PB.down)[0]}`, (PB[s.pocketbase] || PB.down)[1]]];
    const key = JSON.stringify(items);
    if (key === shown) return;   // unchanged text is not re-announced every minute
    shown = key;
    lines.replaceChildren(...items.map(([t, c]) => row(t, c)));
  }
  async function refresh() {
    if (running) { again = true; return; }
    running = true;
    try { render(await window.api.teamServer.status()); } catch (_) { render(null); }
    finally { running = false; if (again) { again = false; refresh(); } }
  }

  const open = document.getElementById('btnTeamAccount');
  if (typeof showSync === 'function') {
    open.addEventListener('click', () => showSync().catch(() => toast('Save failed; account view could not open.', 'err')));
  } else open.hidden = true;

  // Called by sync-ui.js on every account status; probe again only when the saved address or mode changed.
  window.teamServerConfigChanged = (config) => {
    const key = JSON.stringify(config || null);
    if (key !== configKey) { configKey = key; refresh(); }
  };
  window.addEventListener('focus', refresh);
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
  refresh();
})();

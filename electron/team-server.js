'use strict';
// Sidebar "Team server" status: is this machine on the server's ZeroTier network, and does PocketBase answer?
// No admin rights, no ZeroTier CLI: interface names differ per OS, so the subnet match is the source of truth.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function ipv4(text) {
  const m = IPV4.exec(String(text));
  if (!m || m.slice(1).some((n) => Number(n) > 255)) return null;
  return m.slice(1).reduce((a, n) => ((a << 8) | Number(n)) >>> 0, 0);
}

/**
 * 'connected' when a non-loopback IPv4 interface shares the server's subnet, 'disconnected' when none does,
 * 'unknown' when the address is not a plain http://<IPv4> (https or a host name: ZeroTier cannot be told apart).
 * `interfaces` is the shape os.networkInterfaces() returns.
 */
function zeroTierState(serverUrl, interfaces) {
  let u;
  try { u = new URL(serverUrl); } catch (_) { return 'unknown'; }
  const server = u.protocol === 'http:' ? ipv4(u.hostname) : null;
  if (server === null || server >>> 24 === 127) return 'unknown';
  for (const list of Object.values(interfaces || {})) {
    for (const i of list || []) {
      if (i.internal || (i.family !== 'IPv4' && i.family !== 4)) continue;
      const addr = ipv4(i.address), mask = ipv4(i.netmask);
      if (addr === null || !mask) continue;   // a 0.0.0.0 mask would match every address
      if (((addr & mask) >>> 0) === ((server & mask) >>> 0)) return 'connected';
    }
  }
  return 'disconnected';
}

/** True only for HTTP 200 from <serverUrl>/api/health within the timeout. No credentials, no redirects. */
async function pocketBaseUp(serverUrl, fetchImpl = globalThis.fetch, timeoutMs = 3000) {
  try {
    const r = await fetchImpl(`${serverUrl}/api/health`, {
      method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    });
    return r.status === 200;
  } catch (_) { return false; }
}

/** `config` is the engine's publicConfig() (or null when account services are unavailable). */
async function teamServerStatus({ config, interfaces, fetch: fetchImpl }) {
  if (!config || !config.enabled || !config.serverUrl) return { mode: 'local' };
  const up = await pocketBaseUp(config.serverUrl, fetchImpl);
  return { mode: 'account', zerotier: zeroTierState(config.serverUrl, interfaces), pocketbase: up ? 'up' : 'down' };
}

module.exports = { zeroTierState, pocketBaseUp, teamServerStatus };

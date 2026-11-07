'use strict';
const { SyncEngine } = require('./engine');

/** Created after Electron ready. No account configuration means no network calls. */
function createSyncHost({ dir, net, safeStorage, Engine = SyncEngine }) {
  let engine = null;
  let failed = false;
  try {
    engine = new Engine({ dir, safeStorage, fetch: (url, init) => net.fetch(url, {
      ...init, redirect: 'error', credentials: 'omit', cache: 'no-store',
    }) });
    engine.init();
  } catch (_) { failed = true; }
  return {
    get engine() { return failed ? null : engine; },
    status() {
      try { if (!failed && engine) return engine.status(); } catch (_) { /* local mode must still start */ }
      return { mode: 'local', signedIn: false, phase: 'error', error: 'Account services could not start. Local files remain available.' };
    },
    flushLocal() {
      // Core commits already persist before acknowledgement. This is a local disk
      // barrier, not a wait for the background upload or any network connection.
      if (!failed && engine) engine.flushLocal();
    },
  };
}

module.exports = { createSyncHost };

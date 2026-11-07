'use strict';
// Account mode: one signed-in team account, its encrypted offline cache and its
// durable upload queue. Main process only. See db/SYNC_CONTRACT.md for the
// server rules this follows.
//
// Per target the engine keeps what the server last said (`server[id]`) and, while
// the device has something the server doesn't, a local entry (`local[id]`):
//   value     the payload the device wants (null = deleted)
//   base      the version that value was made from: the one the screen showed, or
//             this device's own last applied version; never a newer remote head
//   inflight  the mutation it is in, if one was sent; nothing else goes for the target
//             until that answers
//   held      a conflict (or a closed conflict to review): nothing is sent until a
//             person decides
//   error     the server refused it: kept, shown, never retried silently
// A mutation is stored with its exact request body before it is sent and resent
// byte-for-byte until it gets an answer, so a timeout or crash never applies twice.
// When a local entry ends, `server[id].chainHead` records the version a later edit of
// what the screen still shows must be based on: the head it converged to, or, when the
// edit was dropped (kept the other value), its old base, so a further edit conflicts.
const EventEmitter = require('node:events');
const nodeCrypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');
const { Client, SyncError, parseBaseUrl, jwtClaims } = require('./client');
const { SealedFile, SessionStore, writeAtomic, osProtectionAvailable } = require('./vault');
const { fromSnapshot, inScope, toView, canon, tid } = require('./model');
const { MAX_OPS, jsonbBytes, CHILD_TYPES } = require('./spec');

const PROTOCOL = 1;
const REQUEST_BUDGET = 1900000;          // under the 2 MiB request limit, measured as jsonb text
const IDENTITY_FIELDS = ['date', 'type', 'folder', 'session', 'hint', 'start', 'camPlan', 'format', 'author'];
const VIEW_KEEP = 30;
const UNDELETABLE = new Set(['team_defaults', 'team_starts']);

const emptyData = (origin, userId) => ({
  v: 1, origin, userId, identity: null, cursor: 0, server: {}, local: {}, queue: [], conflicts: [],
  overlay: { openId: null, items: {}, keys: {}, citySource: null }, importMap: {}, imports: [], errors: [],
  rejected: null, locked: false, deviceId: nodeCrypto.randomUUID(), members: [],
});

class SyncEngine extends EventEmitter {
  /**
   * dir: the app's userData folder. fetch, safeStorage, fs, now, uuid and setTimeout are
   * injected so tests can run it without Electron or a network.
   */
  constructor({ dir, fetch, safeStorage, fs = nodeFs, now = () => Date.now(), uuid = () => nodeCrypto.randomUUID(),
    setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout, autoSync = true, legacyDir = dir }) {
    super();
    Object.assign(this, { dir, fetchImpl: fetch, safeStorage, fs, now, uuid, setT, clearT, autoSync, legacyDir });
    this.cfgFile = path.join(dir, 'sync-config.json');
    this.sessions = new SessionStore({ file: path.join(dir, 'accounts', 'session.bin'), safeStorage, fs });
    this.acct = null;            // { id, origin, userId, sealed, data }
    this.session = null;         // tokens, memory only once loaded
    this.phase = 'signed_out';
    this.lastError = null;
    this.protected = null;       // { assignmentId, uid } of a prepared or running backup
    this.views = new Map();      // rev -> { entries: Map(id -> {c, base, chain}), items: {a: {rev}} }
    this.rev = 0;
    this.remoteWaiting = false;
    this.running = null;
    this.runningGen = -1;
    // Bumped whenever the signed-in account or session is replaced: a request started
    // before that must not touch the state that follows it (see _live).
    this.gen = 0;
    this.timer = null;
    this.backoff = 0;
    this.outcomes = new Map();   // mutation_id -> {ok, results|error}
  }

  /* ------------------------------------------------------------ config */

  /**
   * The Neon project's two addresses. `url` is not stored: it names the server for the
   * account cache and session (both addresses, so changing either is another server).
   */
  config() {
    let c = {};
    try { c = JSON.parse(this.fs.readFileSync(this.cfgFile, 'utf8')) || {}; } catch (_) { /* not set up */ }
    const authUrl = typeof c.authUrl === 'string' ? c.authUrl : '';
    const dataUrl = typeof c.dataUrl === 'string' ? c.dataUrl : '';
    return { enabled: !!c.enabled && !!authUrl && !!dataUrl, authUrl, dataUrl, url: authUrl && dataUrl ? `${authUrl} ${dataUrl}` : '' };
  }

  setConfig({ enabled, authUrl, dataUrl }) {
    if (this.acct || this.session) throw new SyncError('config', 'signed_in', 'Sign out before changing the server or turning account mode off.');
    if (this.protected) throw new SyncError('config', 'busy', 'Finish or put aside the backup that is set up first.');
    const next = { enabled: !!enabled, authUrl: '', dataUrl: '' };
    if (authUrl || dataUrl || enabled) {
      next.authUrl = parseBaseUrl(authUrl, 'Auth URL');
      next.dataUrl = parseBaseUrl(dataUrl, 'Data API URL');
    }
    writeAtomic(this.fs, this.cfgFile, JSON.stringify(next, null, 2));
    this.gen += 1;   // an unfinished sign-in belongs to the previous configuration
    this.emit('status');
    return this.publicConfig();
  }

  /** What the renderer may see of the config: both addresses are public. */
  publicConfig() {
    const c = this.config();
    return { enabled: c.enabled, authUrl: c.authUrl, dataUrl: c.dataUrl };
  }

  client() {
    const c = this.config();
    if (!c.enabled) throw new SyncError('config', 'not_configured', 'Account mode is not set up.');
    return new Client({ authUrl: c.authUrl, dataUrl: c.dataUrl, fetch: this.fetchImpl });
  }

  /* ------------------------------------------------------------ start, sign in, sign out */

  /** At start-up: reopen the last signed-in account, offline first. */
  init() {
    const c = this.config();
    if (!c.enabled) return this.status();
    const s = this.sessions.load();
    if (s && s.origin === c.url && s.userId) {
      this.session = s;
      try {
        this._open(s.origin, s.userId);
        this.phase = this.acct.data.locked ? 'revoked' : 'offline';
      } catch (e) {
        this.acct = null;
        this.phase = 'error';
        this.lastError = e.message;
      }
      if (this.acct && !this.acct.data.locked) this.kick(0);
    }
    return this.status();
  }

  _acctId(origin, userId) {
    return nodeCrypto.createHash('sha256').update(`${origin}\n${userId}`).digest('hex').slice(0, 32);
  }

  _open(origin, userId) {
    const id = this._acctId(origin, userId);
    const folder = path.join(this.dir, 'accounts', id);
    const sealed = new SealedFile({ file: path.join(folder, 'cache.bin'), keyFile: path.join(folder, 'key.bin'),
      aad: `avb-cache-v1\n${origin}\n${userId}`, safeStorage: this.safeStorage, fs: this.fs });
    const data = sealed.read() || emptyData(origin, userId);
    if (data.origin !== origin || data.userId !== userId) throw new SyncError('config', 'tampered', 'The account data on this computer belongs to another account.');
    this.gen += 1;
    this.acct = { id, folder, origin, userId, sealed, data };
    this.views.clear();
    this.remoteWaiting = true;
    for (const m of data.queue) for (const id2 of m.ids || []) if (data.local[id2]) data.local[id2].inflight = m.mutation_id;
    this.emit('reset');
  }

  /** Throws if the account or session changed since `gen`: a late answer for someone else. */
  _live(gen) {
    if (this.gen !== gen) throw new SyncError('stale', 'stale', 'The account changed while this was running.');
  }

  _close() {
    this.gen += 1;
    this.acct = null;
    this.session = null;
    this.views.clear();
    this.outcomes.clear();
    if (this.timer) { this.clearT(this.timer); this.timer = null; }
    this.emit('reset');
  }

  _save() { this.acct.sealed.write(this.acct.data); }

  /** Local shutdown barrier. Uploads are already durable and do not have to finish. */
  flushLocal() {
    if (this.acct) this._save();
    return { ok: true };
  }

  /**
   * Create a Better Auth account (Neon cannot restrict sign-up, so this grants nothing).
   * Returns the e-mail to pass to the maintainer, who adds the account by id and e-mail.
   */
  async signUp(email, password, name) {
    if (typeof email !== 'string' || typeof password !== 'string' || typeof name !== 'string' || !email.includes('@')
      || password.length < 8 || password.length > 1024 || email.length > 320 || !name.trim() || name.length > 200) {
      throw new SyncError('config', 'bad_login', 'Enter your name, e-mail and a password of at least 8 characters.');
    }
    await this.client().signUp(email.trim(), password, name.trim());
    return { ok: true, email: email.trim() };
  }

  async signIn(email, password) {
    if (this.protected) throw new SyncError('config', 'busy', 'Finish or put aside the backup that is set up before signing in.');
    if (typeof email !== 'string' || typeof password !== 'string' || !email.includes('@') || !password || email.length > 320 || password.length > 1024) {
      throw new SyncError('config', 'bad_login', 'Enter your e-mail and password.');
    }
    if (this.session) throw new SyncError('config', 'signed_in', 'Sign out first.');
    if (!osProtectionAvailable(this.safeStorage)) {
      throw new SyncError('config', 'no_os_encryption', 'This computer cannot protect sign-in tokens or the offline copy (no OS key store), so account mode is unavailable here.');
    }
    const c = this.config();
    const client = this.client();
    const gen = this.gen;
    const tok = await client.signIn(email.trim(), password);
    try { this._live(gen); } catch (e) {
      if (tok && typeof tok.refresh_token === 'string') client.signOut(tok.refresh_token).catch(() => {});
      throw e;
    }
    const session = this._sessionFrom(c.url, tok);
    let me;
    try { me = await client.rpc(session.access_token, 'avb_me'); this._live(gen); } catch (e) {
      client.signOut(session.refresh_token).catch(() => {});
      if (e.kind === 'revoked') throw new SyncError('revoked', 'not_member', 'This account is not an active team member. Ask the maintainer to add you.');
      throw e;
    }
    if (!me || me.protocol_version !== PROTOCOL || me.user_id !== session.userId) throw new SyncError('protocol', 'protocol', 'The server speaks a different sync protocol.');
    if (this.acct && (this.acct.userId !== me.user_id || this.acct.origin !== c.url)) this._close();   // a different person: the old cache stays shut
    try {
      if (!this.acct) this._open(c.url, me.user_id);
      this.sessions.save(session);
    } catch (e) {
      client.signOut(session.refresh_token).catch(() => {});
      if (this.acct && !this.session) this._close();
      throw e;
    }
    this.gen += 1;   // anything still in flight from before this sign-in is stale now
    this.session = session;
    const d = this.acct.data;
    d.identity = { role: me.role, display_name: me.display_name, verifiedAt: new Date(this.now()).toISOString() };
    d.locked = false;   // the server just accepted this person again: held work may go
    this._save();
    this.phase = 'online';
    this.lastError = null;
    this.emit('reset');
    this.kick(0);
    return this.status();
  }

  _sessionFrom(origin, tok) {
    if (!tok || typeof tok.access_token !== 'string' || typeof tok.refresh_token !== 'string') throw new SyncError('protocol', 'bad_token', 'The server sent no session.');
    const claims = jwtClaims(tok.access_token);
    const exp = Number(tok.expires_at) || (claims.exp ? claims.exp : Math.floor(this.now() / 1000) + Number(tok.expires_in || 3600));
    return { origin, userId: claims.sub || (tok.user && tok.user.id), access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: exp };
  }

  /** Sign out: the tokens go; this account's offline copy and unsent changes stay encrypted for its next sign-in. */
  async signOut() {
    if (this.protected) throw new SyncError('config', 'busy', 'Finish or put aside the backup that is set up before signing out.');
    const pending = this.acct ? this.pendingCount() : 0;
    const token = this.session && this.session.refresh_token;   // the session cookie ends the server session
    let client;
    if (token) { try { client = this.client(); } catch (_) { /* still sign out locally if config is damaged */ } }
    // Invalidate local access before waiting for the old server. No response to this
    // sign-out may clear the session or cache of someone who signs in afterwards.
    this.sessions.clear();
    this._close();
    this.phase = 'signed_out';
    this.lastError = null;
    this.emit('status');
    if (client) { try { await client.signOut(token); } catch (_) { /* already signed out locally */ } }
    return { ok: true, pendingKept: pending };
  }

  /* ------------------------------------------------------------ tokens */

  async _token(force) {
    if (!this.session) throw new SyncError('unauthorized', 'signed_out', 'Sign in again.');
    if (force || this.session.expires_at * 1000 - this.now() < 60000) await this._refresh();
    return this.session.access_token;
  }

  _refresh() {
    if (this.refreshing && this.refreshing.gen === this.gen) return this.refreshing.p;
    const gen = this.gen;
    const rt = this.session.refresh_token;
    const p = (async () => {
      try {
        const tok = await this.client().refresh(rt);
        this._live(gen);   // never save one account's tokens over another's
        const s = this._sessionFrom(this.session.origin, tok);
        if (s.userId !== this.session.userId) throw new SyncError('protocol', 'bad_token', 'The server returned another account.');
        this.sessions.save(s);
        this.session = s;
      } catch (e) {
        if (this.gen !== gen) throw new SyncError('stale', 'stale', 'The account changed while this was running.');
        if (e.kind === 'unauthorized' || e.kind === 'refused') {
          // The refresh token is spent or revoked: sign in again. The cache stays for this account.
          this.sessions.clear();
          this.session = null;
          this.phase = 'expired';
          throw new SyncError('unauthorized', 'expired', 'The sign-in has expired. Sign in again; nothing unsent is lost.');
        }
        throw e;
      } finally { if (this.refreshing && this.refreshing.p === p) this.refreshing = null; }
    })();
    this.refreshing = { gen, p };
    return p;
  }

  /** One authenticated call; an expired token is refreshed once and the same request sent again. */
  async _call(name, request, raw) {
    return this._authed((client, token) => client.rpc(token, name, request, raw));
  }

  /** Every answer is checked against the account it was asked for before anyone uses it. */
  async _authed(fn) {
    const gen = this.gen;
    const live = (v) => { this._live(gen); return v; };
    const client = this.client();
    let token = live(await this._token(false));
    try { return live(await fn(client, token)); } catch (e) {
      this._live(gen);
      if (e.kind !== 'unauthorized' || !this.session) throw e;
      token = live(await this._token(true));
      return live(await fn(client, token));
    }
  }

  /* ------------------------------------------------------------ status */

  pendingCount() {
    if (!this.acct) return 0;
    return Object.values(this.acct.data.local).length + this.acct.data.queue.filter((m) => m.kind !== 'sync').length;
  }

  status() {
    const c = this.config();
    const d = this.acct && this.acct.data;
    const local = d ? Object.entries(d.local) : [];
    return {
      mode: c.enabled ? 'account' : 'local',
      configured: !!c.url,
      config: this.publicConfig(),
      encryption: osProtectionAvailable(this.safeStorage),
      signedIn: !!this.acct,
      phase: this.phase,
      user: d && d.identity ? { displayName: d.identity.display_name, role: d.identity.role, verifiedAt: d.identity.verifiedAt } : null,
      locked: !!(d && d.locked),
      pending: local.filter(([, l]) => !l.held && !l.error).length,
      sending: local.filter(([, l]) => l.inflight).length,
      held: local.filter(([, l]) => l.held).length,
      failed: d && d.locked ? [] : local.filter(([, l]) => l.error).map(([id, l]) => ({ id, code: l.error.code, message: l.error.message })).slice(0, 50),
      conflicts: d ? d.conflicts.length : 0,
      rejected: d && d.rejected && !d.locked ? { at: d.rejected.at, problems: d.rejected.problems.slice(0, 50) } : null,
      error: this.lastError,
      lastSync: d ? d.lastSync || null : null,
      remoteWaiting: this.remoteWaiting,
      protected: !!this.protected,
    };
  }

  _setPhase(phase, error = null) {
    const changed = phase !== this.phase || error !== this.lastError;
    this.phase = phase;
    this.lastError = error;
    if (changed) this.emit('status');
  }

  /* ------------------------------------------------------------ the view */

  /** Targets as the device has them now: local values over the server's, deleted ones and their rows left out. */
  _current() {
    const d = this.acct.data;
    const out = {};
    for (const [id, s] of Object.entries(d.server)) {
      if (d.local[id] || !s.head || s.deleted || s.payload === undefined || s.payload === null) continue;
      out[id] = { type: s.type, key: s.key, a: s.a, payload: s.payload, at: s.at ? Date.parse(s.at) || 0 : 0 };
    }
    for (const [id, l] of Object.entries(d.local)) if (l.value !== null) out[id] = { type: l.type, key: l.key, a: l.a, payload: l.value, at: l.at || this.now() };
    for (const [id, t] of Object.entries(out)) if (t.a && t.type !== 'assignment' && !out[tid('assignment', t.a)]) delete out[id];
    return out;
  }

  _baseOf(id) {
    const d = this.acct.data;
    if (d.local[id]) return { base: d.local[id].base, chain: true };
    return { base: d.server[id] ? d.server[id].head : null, chain: false };
  }

  /** The renderer's data now, under a new revision it can commit against. */
  view() {
    if (!this.acct) return { signedIn: false, status: this.status() };
    const d = this.acct.data;
    if (d.locked && !this.protected) return { signedIn: true, locked: true, status: this.status() };
    const current = this._current();
    const rowConflicts = {};
    for (const c of d.conflicts) if (c.assignment_key) rowConflicts[c.assignment_key] = (rowConflicts[c.assignment_key] || 0) + 1;
    const meta = { items: {} };
    for (const [id, t] of Object.entries(current)) {
      if (t.type !== 'assignment') continue;
      const s = d.server[id];
      meta.items[t.key] = { aggregateRev: s && s.rev != null ? s.rev : null, onServer: !!(s && s.head), conflicts: rowConflicts[t.key] || 0,
        pending: Object.values(d.local).filter((l) => l.a === t.key).length };
    }
    const data = toView(current, d.overlay, meta);
    if (canon(data.keyMap) !== canon(d.overlay.keys)) {
      d.overlay.keys = data.keyMap;
      // Showing the data must not fail on a full disk; the next successful save keeps these keys.
      try { this._save(); } catch (_) { this.lastError = 'Could not save on this computer; changes stay on screen.'; }
    }
    delete data.keyMap;
    const shown = fromSnapshot(data, []);
    const entries = new Map();
    for (const [id, t] of Object.entries(shown.targets)) entries.set(id, { c: canon(t.payload), ...this._baseOf(id), t });
    const rev = this._remember({ entries, items: meta.items });
    this.remoteWaiting = false;
    data.deleted = d.identity && d.identity.role === 'admin' ? Object.values(d.server)
      .filter((s) => s.type === 'assignment' && s.deleted && s.lastPayload).map((s) => ({ id: s.key, label: s.lastPayload.label || '', aggregateRev: s.rev })) : [];
    return { signedIn: true, rev, data, status: this.status() };
  }

  _remember(v) {
    this.rev += 1;
    this.views.set(this.rev, v);
    while (this.views.size > VIEW_KEEP) {
      const oldest = [...this.views.keys()].find((key) => key !== this.protected?.baseRev);
      this.views.delete(oldest);
    }
    return this.rev;
  }

  /* ------------------------------------------------------------ commit */

  /**
   * The renderer's whole snapshot, diffed against the exact view it was showing
   * (`baseRev`), never against the newest state: a row that arrived after that view is
   * not deleted by being absent, and assignments still being read (`busy`) are skipped.
   * Durable before it returns.
   */
  commit({ baseRev, snapshot, busy }) {
    if (!this.acct) throw new SyncError('config', 'signed_out', 'Not signed in.');
    const d = this.acct.data;
    const base = this.views.get(baseRev);
    if (!base) throw new SyncError('config', 'stale_view', 'The schedule on screen is out of date; it is reloaded. Re-enter the last change if it is missing.');
    const built = fromSnapshot(snapshot, busy);
    if (built.problems.length) {
      // Nothing is queued, but nothing is lost either: the whole snapshot is kept encrypted.
      d.rejected = { at: new Date(this.now()).toISOString(), problems: built.problems.slice(0, 200), snapshot };
      this._save();
      this.emit('status');
      return { ok: false, problems: built.problems.slice(0, 200), warnings: built.warnings };
    }
    const changes = [];
    for (const [id, t] of Object.entries(built.targets)) {
      const was = base.entries.get(id);
      if (!was || was.c !== canon(t.payload)) changes.push({ id, t, payload: t.payload, was });
    }
    for (const [id, was] of base.entries) {
      if (!built.targets[id] && inScope(was.t, built.scope)) changes.push({ id, t: was.t, payload: null, was });
    }
    this._checkProtected(changes);
    const undo = JSON.stringify({ local: d.local, overlay: d.overlay, rejected: d.rejected, server: d.server });
    try {
      this._commitApply(d, built, changes, snapshot);
    } catch (e) {
      Object.assign(d, JSON.parse(undo));   // nothing half-applied in memory when the disk refused it
      throw new SyncError('disk', 'write_failed', `The change could not be saved on this computer (${e.code || 'disk error'}). It is still on screen; fix the disk and it is saved again.`);
    }
    // What the screen shows now: its own snapshot over the base, with the bases the edits used.
    const entries = new Map(base.entries);
    for (const ch of changes) {
      if (ch.payload === null) entries.delete(ch.id);
      else entries.set(ch.id, { c: canon(ch.payload), ...this._baseOf(ch.id), t: ch.t });
    }
    const rev = this._remember({ entries, items: base.items });
    if (changes.length) { this.emit('status'); this.kick(800); }
    return { ok: true, rev, changed: changes.length, warnings: built.warnings, remoteWaiting: this.remoteWaiting };
  }

  _commitApply(d, built, changes, snapshot) {
    for (const ch of changes) this._setLocal(ch);
    d.overlay.openId = built.overlay.openId;
    for (const a of built.scope.assignments) {
      d.overlay.items[a] = built.overlay.items[a];
      d.overlay.keys[a] = { ...(d.overlay.keys[a] || {}), ...built.overlay.keys[a] };
    }
    if (snapshot && 'citySource' in snapshot) d.overlay.citySource = built.overlay.citySource;
    d.rejected = null;
    this._save();
  }

  _checkProtected(changes) {
    const p = this.protected;
    if (!p) return;
    for (const ch of changes) {
      if (ch.t.type !== 'session' || ch.t.key !== p.uid) continue;
      if (ch.payload === null) throw new SyncError('refused', 'protected', 'This row\'s backup is set up or running; it cannot be deleted now.');
      const before = ch.was ? JSON.parse(ch.was.c) : {};
      for (const f of IDENTITY_FIELDS) {
        if (canon(before[f]) !== canon(ch.payload[f])) throw new SyncError('refused', 'protected', `This row's backup is set up or running; its ${f} cannot change now.`);
      }
    }
  }

  _setLocal({ id, t, payload, was }) {
    const d = this.acct.data;
    if (payload === null && UNDELETABLE.has(t.type)) return;
    const l = d.local[id];
    const at = this.now();
    // A refused value stays refused until a person retries it from the review list.
    if (l) { l.value = payload; l.at = at; return; }
    const s = d.server[id];
    let base = was ? (was.chain && s && 'chainHead' in s ? s.chainHead : was.base) : null;
    // Brought back after a deletion this device saw: restore from that tombstone.
    if (!was && s && s.deleted && s.head) base = s.head;
    d.local[id] = { type: t.type, key: t.key, a: t.a || null, value: payload, base, inflight: null, held: null, error: null, at };
  }

  /* ------------------------------------------------------------ backup protection */

  /** The row a prepared or running backup was set up from: its identity can't change under it. */
  protect(p) {
    const ok = p && typeof p.assignmentId === 'string' && typeof p.uid === 'string';
    const was = this.protected;
    this.protected = ok ? { assignmentId: p.assignmentId, uid: p.uid, baseRev: p.baseRev } : null;
    if (was && !this.protected) { this.emit('status'); this.kick(0); }
    return { ok: true };
  }

  /* ------------------------------------------------------------ the sync loop */

  kick(ms = 0) {
    if (!this.autoSync || !this.acct) return;
    if (this.timer) this.clearT(this.timer);
    this.timer = this.setT(() => { this.timer = null; this.syncNow().catch(() => {}); }, ms);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  /** Check membership, pull, read conflicts, upload, pull again. One run at a time. */
  syncNow() {
    if (!this.acct) return Promise.resolve(this.status());
    if (this.running && this.runningGen === this.gen) { this.again = true; return this.running; }
    const gen = this.gen;
    const run = (async () => {
      try {
        do {
          this.again = false;
          await this._cycle();
        } while (this.again && this.gen === gen);
        if (this.gen === gen) { this.backoff = 0; this.kick(30000); }
      } catch (e) {
        if (this.gen === gen && e.kind !== 'stale') this._onError(e);   // a late failure of a previous account is not this one's
      } finally { if (this.running === run) this.running = null; }
      return this.status();
    })();
    this.running = run;
    this.runningGen = gen;
    return run;
  }

  async _cycle() {
    const acct = this.acct;
    if (!acct || !this.session) {
      if (acct && this.phase !== 'revoked') this._setPhase('expired', 'Sign in again to sync. Changes made here are kept.');
      return;
    }
    this._setPhase(this.phase === 'online' ? 'online' : 'connecting', this.lastError);
    const me = await this._call('avb_me');
    if (this.acct !== acct) return;
    if (!me || me.user_id !== acct.userId) throw new SyncError('protocol', 'other_user', 'The server answered for another account.');
    acct.data.identity = { role: me.role, display_name: me.display_name, verifiedAt: new Date(this.now()).toISOString() };
    if (acct.data.locked) { acct.data.locked = false; }
    this._save();
    this._setPhase('online');
    try { const members = await this._call('avb_team_members'); if (Array.isArray(members)) acct.data.members = members.map((m) => ({ user_id: m.user_id, display_name: m.display_name })); } catch (_) { /* names only */ }
    await this._pull(acct);
    await this._conflicts(acct);
    await this._flush(acct);
    await this._pull(acct);
    await this._conflicts(acct);
    acct.data.lastSync = new Date(this.now()).toISOString();
    this._save();
    this.emit('status');
  }

  _onError(e) {
    if (!this.acct) return;
    if (e.kind === 'revoked') {
      this.acct.data.locked = true;   // the cache is shut and the queue held until the server accepts this person again
      this._save();
      this._setPhase('revoked', 'This account is no longer an active team member. Its offline copy is locked and unsent changes are held.');
      this.emit('reset');
      return;
    }
    if (e.kind === 'unauthorized') { this._setPhase('expired', e.message); return; }
    if (e.kind === 'offline') this._setPhase('offline', 'Offline. Changes are kept and sent when the server can be reached.');
    else this._setPhase('error', e.message);
    this.backoff = Math.min(60000, (this.backoff || 2000) * 2);
    this.kick(this.backoff);
  }

  async _pull(acct) {
    for (;;) {
      const r = await this._call('avb_sync_pull', { protocol_version: PROTOCOL, after: acct.data.cursor, limit: 500 });
      if (this.acct !== acct) return;
      if (!r || !Array.isArray(r.items)) throw new SyncError('protocol', 'protocol', 'Unexpected answer from the server.');
      let changed = false;
      for (const it of r.items) {
        const id = tid(it.target_type, it.target_key);
        const s = acct.data.server[id] || { type: it.target_type, key: it.target_key, a: it.assignment_key || null };
        if (it.target_type === 'assignment' && s.payload) s.lastPayload = s.payload;
        Object.assign(s, { head: it.head_version_id, deleted: !!it.deleted, payload: it.payload, rev: it.aggregate_rev, oc: it.open_conflicts, by: it.updated_by, at: it.updated_at, seq: it.change_seq });
        if (it.target_type === 'assignment' && it.payload) s.lastPayload = it.payload;
        acct.data.server[id] = s;
        if (!acct.data.local[id]) changed = true;
        this._converge(id);
      }
      acct.data.cursor = r.next_cursor;   // stored only with the page it belongs to
      this._save();
      if (changed) { this.remoteWaiting = true; this.emit('changed'); }
      if (!r.has_more) return;
    }
  }

  /** A local entry the server now agrees with is done. */
  _converge(id) {
    const d = this.acct.data;
    const l = d.local[id], s = d.server[id];
    if (!l || l.inflight || l.held || l.error || !s) return;
    const same = l.value === null ? (s.deleted || !s.head) : (!s.deleted && s.head && s.payload !== undefined && canon(s.payload) === canon(l.value));
    if (same) this._end(id, s.head);
  }

  /** Drop a local entry; a later edit of what the screen still shows is based on `chainHead`. */
  _end(id, chainHead) {
    const d = this.acct.data;
    if (d.server[id]) d.server[id].chainHead = chainHead || null;
    delete d.local[id];
  }

  async _conflicts(acct) {
    const all = [];
    let after = 0;
    for (;;) {
      const r = await this._call('avb_conflicts', { protocol_version: PROTOCOL, status: 'open', after, limit: 100 });
      if (this.acct !== acct) return;
      all.push(...(r.items || []));
      after = r.next_cursor;
      if (!r.has_more) break;
    }
    const d = acct.data;
    const open = new Set(all.map((c) => c.conflict_id));
    const before = canon(d.conflicts.map((c) => c.conflict_id).sort());
    d.conflicts = all;
    for (const [id, l] of Object.entries(d.local)) {
      if (!l.held || l.held.review || open.has(l.held.conflictId)) continue;
      // Someone closed it. If the result is what this device wanted, done; otherwise a person decides.
      l.held = { review: true, conflictId: l.held.conflictId, kind: l.held.kind };
      const s = d.server[id];
      if (s && (l.value === null ? s.deleted : (!s.deleted && s.payload !== undefined && canon(s.payload) === canon(l.value)))) this._end(id, s.head);
    }
    this._save();
    if (before !== canon(all.map((c) => c.conflict_id).sort())) { this.remoteWaiting = true; this.emit('changed'); }
  }

  /** Send queued mutations in order; build the next from ready local entries. */
  async _flush(acct) {
    for (let guard = 0; guard < 1000; guard++) {
      if (this.acct !== acct || acct.data.locked) return;
      let m = acct.data.queue[0];
      if (!m) {
        const undo = JSON.stringify({ local: acct.data.local, queue: acct.data.queue });
        m = this._build();
        if (!m) return;
        acct.data.queue.push(m);
        try { this._save(); } catch (e) {   // the exact request is on disk before it is sent, or not sent at all
          Object.assign(acct.data, JSON.parse(undo));
          throw new SyncError('disk', 'write_failed', `Could not save on this computer (${e.code || 'disk error'}); nothing was sent.`);
        }
      }
      let res;
      try {
        res = await this._call('avb_sync_apply', undefined, m.body);
      } catch (e) {
        if (this.acct !== acct) return;
        // Same request again later. 'stale' (the session was replaced mid-request) says
        // nothing about this mutation, which may well have been applied.
        if (['offline', 'busy', 'server', 'unauthorized', 'revoked', 'stale'].includes(e.kind)) throw e;
        this._refuse(m, e);
        continue;
      }
      if (this.acct !== acct) return;
      this._apply(m, res);
    }
  }

  _refuse(m, e) {
    const d = this.acct.data;
    // A rollback may have reconstructed queue objects while this request waited.
    d.queue = d.queue.filter((x) => x.mutation_id !== m.mutation_id);
    const err = { code: e.code || 'refused', message: e.message || 'Refused by the server.', at: new Date(this.now()).toISOString() };
    for (const id of m.ids) {
      const l = d.local[id];
      if (l && l.inflight === m.mutation_id) { l.inflight = null; l.error = err; }
    }
    d.errors = [...d.errors, { ...err, kind: m.kind, ids: m.ids.slice(0, 20) }].slice(-50);
    this._outcome(m.mutation_id, { ok: false, error: err });
    this._save();
    this.emit('status');
  }

  _outcome(id, v) {
    this.outcomes.set(id, v);
    while (this.outcomes.size > 200) this.outcomes.delete(this.outcomes.keys().next().value);
  }

  _build() {
    const d = this.acct.data;
    const ops = [], ids = [];
    let bytes = 200;
    const order = Object.entries(d.local).sort(([, x], [, y]) => (x.type === 'assignment' ? 0 : 1) - (y.type === 'assignment' ? 0 : 1));
    const creatingParents = new Set();
    for (const [id, l] of order) {
      if (l.inflight || l.held || l.error) continue;
      this._converge(id);
      if (!d.local[id]) continue;
      const s = d.server[id];
      let op;
      if (l.value === null) {
        if (!s || !s.head || s.deleted) { delete d.local[id]; continue; }
        if (!l.base) { delete d.local[id]; continue; }   // never seen here: nothing to delete
        op = { op: 'delete', type: l.type, key: l.key, base_version_id: l.base };
      } else if (!s || !s.head || !l.base) {
        op = { op: 'create', type: l.type, key: l.key, payload: l.value };
        if (CHILD_TYPES.has(l.type)) op.assignment_key = l.a;
      } else if (s.deleted && l.base === s.head) {
        op = { op: 'restore', type: l.type, key: l.key, base_version_id: l.base };
      } else {
        op = { op: 'update', type: l.type, key: l.key, base_version_id: l.base, payload: l.value };
      }
      if (CHILD_TYPES.has(l.type)) {
        const parent = d.server[tid('assignment', l.a)];
        if (!(parent && parent.head) && !creatingParents.has(l.a)) continue;   // after its schedule exists
      }
      const n = jsonbBytes(op) + 2;
      if (ops.length >= MAX_OPS || bytes + n > REQUEST_BUDGET) break;
      if (l.type === 'assignment' && op.op === 'create') creatingParents.add(l.key);
      ops.push(op); ids.push(id);
      bytes += n;
    }
    if (!ops.length) { this._save(); return null; }
    const mutation_id = this.uuid();
    const m = { mutation_id, kind: 'sync', ids, body: JSON.stringify({ p_request: { protocol_version: PROTOCOL, mutation_id, operations: ops } }), at: new Date(this.now()).toISOString() };
    for (const id of ids) d.local[id].inflight = mutation_id;
    return m;
  }

  _apply(m, res) {
    const d = this.acct.data;
    if (!res || res.mutation_id !== m.mutation_id || !Array.isArray(res.results) || res.results.length !== m.ids.length) {
      throw new SyncError('protocol', 'protocol', 'Unexpected answer from the server.');
    }
    const ops = JSON.parse(m.body).p_request.operations;
    let conflicted = false;
    res.results.forEach((r, i) => {
      const id = m.ids[i];
      const op = ops[i];
      const had = d.server[id];
      const s = had || { type: r.target_type, key: r.target_key, a: op.assignment_key || (r.target_type === 'assignment' ? r.target_key : null) };
      // A resent mutation gets the server's stored answer, which can be older than what a
      // pull has brought since. Only an answer built on what this cache holds may change
      // it; anything newer than the cache comes with the next pull (its seq is past the cursor).
      const fresh = !had || (had.head || null) === (op.base_version_id || op.expected_head_version_id || null);
      const newer = (cur) => r.aggregate_rev != null && !(cur > r.aggregate_rev);   // revisions only rise
      if (s.a && r.target_type !== 'assignment') { const p = d.server[tid('assignment', s.a)]; if (p && newer(p.rev)) p.rev = r.aggregate_rev; }
      if (r.target_type === 'assignment' && newer(s.rev)) s.rev = r.aggregate_rev;
      const l = d.local[id];
      if (r.status === 'applied' || r.status === 'noop' || r.status === 'resolved') {
        const version = r.version_id || r.head_version_id;
        const head = r.head_version_id || version;
        if (fresh) {
          s.head = head;
          s.deleted = !!r.deleted;
          if (op.op === 'restore' || op.op === 'restore_assignment') s.payload = undefined;
          else if (op.op === 'resolve_conflict') s.payload = m.resolvedPayload === undefined ? s.payload : m.resolvedPayload;
          else if (op.op === 'delete' || op.op === 'delete_assignment') { if (s.payload) s.lastPayload = s.payload; s.payload = null; }
          else s.payload = op.payload;
          d.server[id] = s;
        }
        if (l && l.inflight === m.mutation_id) {
          l.inflight = null;
          if (m.kind === 'sync') {
            // Done unless it was edited again while being sent; a restore still owes its value.
            const sent = op.op === 'delete' ? null : op.op === 'restore' ? undefined : op.payload;
            if (sent !== undefined && canon(l.value) === canon(sent)) this._end(id, version);
            else { l.base = version; this._converge(id); }
          } else if (m.kind === 'resolve' && l.held && l.held.conflictId === op.conflict_id) {
            // Kept the other value: this edit ends, and a further edit of it on screen conflicts.
            if (m.choice === 'keep_current') this._end(id, l.base);
            else { l.held = null; l.base = head; this._converge(id); }   // a newer draft goes next, on this head
          }
          // Someone else's conflict on this target: this device's own draft keeps its base.
        }
      } else if (r.status === 'conflict') {
        conflicted = true;
        if (fresh) {
          if (s.head !== r.head_version_id) s.payload = undefined;   // the pull fills it in
          s.head = r.head_version_id;
          s.deleted = !!r.deleted;
          d.server[id] = s;
        }
        if (l && l.inflight === m.mutation_id) { l.inflight = null; l.held = { conflictId: r.conflict_id, kind: r.conflict_kind }; }
      }
    });
    d.queue = d.queue.filter((x) => x.mutation_id !== m.mutation_id);
    this._outcome(m.mutation_id, { ok: true, results: res.results });
    this._save();
    if (conflicted || m.kind !== 'sync') { this.remoteWaiting = true; this.emit('changed'); }
    this.emit('status');
  }

  /** Queue one prepared mutation (a resolution or an admin action) and send it now; resolves with its outcome. */
  async _sendNow(ops, meta) {
    const d = this.acct.data;
    const mutation_id = this.uuid();
    const m = { mutation_id, ids: meta.ids, body: JSON.stringify({ p_request: { protocol_version: PROTOCOL, mutation_id, operations: ops } }), at: new Date(this.now()).toISOString(), ...meta };
    const undo = JSON.stringify({ local: d.local, queue: d.queue });
    try {
      for (const id of m.ids) if (d.local[id]) d.local[id].inflight = mutation_id;
      d.queue.push(m);
      this._save();
    } catch (e) {
      Object.assign(d, JSON.parse(undo));
      throw new SyncError('disk', 'write_failed', `Could not save on this computer (${e.code || 'disk error'}); nothing was sent.`);
    }
    await this.syncNow();
    const out = this.outcomes.get(mutation_id);
    if (!out) throw new SyncError('offline', 'queued', 'Not sent yet (offline?). It is kept and sent when the server can be reached.');
    if (!out.ok) throw new SyncError('refused', out.error.code, out.error.message);
    return out.results;
  }

  /* ------------------------------------------------------------ conflicts */

  /** Open conflicts for the review screen, with each alternative's value, author and time. */
  conflicts() {
    if (!this.acct || this.acct.data.locked) return [];
    const d = this.acct.data;
    const names = new Map((d.members || []).map((m) => [m.user_id, m.display_name]));
    const ver = (v) => v && { versionId: v.version_id, payload: v.payload, by: names.get(v.actor_id) || 'someone', at: v.created_at, mine: v.actor_id === this.acct.userId };
    const current = this._current();
    return d.conflicts.map((c) => {
      const id = tid(c.target_type, c.target_key);
      const l = d.local[id];
      const a = c.assignment_key && (current[tid('assignment', c.assignment_key)] || d.server[tid('assignment', c.assignment_key)]);
      return {
        conflictId: c.conflict_id, kind: c.kind, targetType: c.target_type, targetKey: c.target_key,
        schedule: a && (a.payload || a.lastPayload) ? (a.payload || a.lastPayload).label : '',
        base: ver(c.base), detected: ver(c.detected_head), incoming: ver(c.incoming), current: ver(c.current_head),
        targetDeleted: !!c.target_deleted, assignmentRev: c.assignment_rev,
        expectedHead: c.current_head ? c.current_head.version_id : null,
        draft: l && l.held && l.held.conflictId === c.conflict_id ? { value: l.value } : null,
        busy: !!(l && l.inflight),
      };
    });
  }

  /** Local edits a person must look at: refused by the server, or a conflict someone else closed. */
  reviews() {
    if (!this.acct || this.acct.data.locked) return [];
    return Object.entries(this.acct.data.local).filter(([, l]) => l.error || (l.held && l.held.review))
      .map(([id, l]) => ({ id, type: l.type, key: l.key, value: l.value, current: this.acct.data.server[id]?.payload ?? null, expectedHead: this.acct.data.server[id]?.head ?? null, reason: l.error ? l.error.message : 'Your change was not used when the conflict was closed.' }));
  }

  /** Decide a conflict: keep_current, accept_incoming, or mine (this device's latest draft, as a merged value). */
  async resolve({ conflictId, choice, expectedHead }) {
    if (!this.acct || this.acct.data.locked) throw new SyncError('config', 'signed_out', 'Not signed in.');
    const d = this.acct.data;
    const c = d.conflicts.find((x) => x.conflict_id === conflictId);
    if (!c) throw new SyncError('refused', 'conflict_not_found', 'That conflict is no longer open.');
    const head = c.current_head ? c.current_head.version_id : null;
    if ((expectedHead || null) !== head) throw new SyncError('refused', 'stale_resolution', 'It changed since you looked. Review it again.');
    const id = tid(c.target_type, c.target_key);
    const l = d.local[id];
    if (l && l.inflight) throw new SyncError('refused', 'busy', 'A change to this row is being sent; try again in a moment.');
    if (!['keep_current', 'accept_incoming', 'mine'].includes(choice)) throw new SyncError('refused', 'invalid_resolution', 'Unknown choice.');
    const op = { op: 'resolve_conflict', conflict_id: conflictId, resolution: choice === 'mine' ? 'merged' : choice };
    if (head) op.expected_head_version_id = head;
    let resolvedPayload = choice === 'accept_incoming' ? (c.incoming ? c.incoming.payload : null) : undefined;
    if (choice === 'mine') {
      if (!l || l.value === null) throw new SyncError('refused', 'no_draft', 'There is no edited value on this computer to keep.');
      op.payload = l.value;
      resolvedPayload = l.value;
    }
    await this._sendNow([op], { kind: 'resolve', ids: [id], choice, resolvedPayload });
    return this.status();
  }

  /** A refused or reviewed local edit: send it again on what is shown now, or drop it. */
  review({ id, action, expectedHead }) {
    if (!this.acct || this.acct.data.locked) throw new SyncError('forbidden', 'locked', 'Sign in with an active account to review drafts.');
    const d = this.acct && this.acct.data;
    const l = d && d.local[id];
    if (!l || !(l.error || (l.held && l.held.review))) throw new SyncError('refused', 'not_found', 'Nothing to review there.');
    if (action === 'discard') this._end(id, l.base);
    else if (action === 'retry') {
      const s = d.server[id];
      if ((expectedHead || null) !== (s ? s.head : null)) throw new SyncError('refused', 'stale_resolution', 'It changed since you looked. Review it again.');
      l.error = null; l.held = null; l.base = s && s.head ? s.head : null;
    } else throw new SyncError('refused', 'invalid', 'Unknown action.');
    this._save();
    this.remoteWaiting = true;
    this.emit('changed');
    this.kick(0);
    return this.status();
  }

  /* ------------------------------------------------------------ whole schedules (admins) */

  async _freshAdmin() {
    if (!this.acct || this.acct.data.locked) throw new SyncError('config', 'signed_out', 'Not signed in.');
    const me = await this._call('avb_me');   // online, now: a cached role never unlocks this
    if (!me || me.user_id !== this.acct.userId) throw new SyncError('protocol', 'other_user', 'The server answered for another account.');
    this.acct.data.identity = { role: me.role, display_name: me.display_name, verifiedAt: new Date(this.now()).toISOString() };
    this._save();
    if (me.role !== 'admin') throw new SyncError('forbidden', 'admin_required', 'Only an admin can delete or restore a whole schedule.');
  }

  /**
   * Delete a whole schedule as it was on screen in view `rev`: if anyone changed it
   * since, the server keeps it and records a stale attempt instead.
   */
  async deleteAssignment({ id, rev }) {
    const v = this.views.get(rev);
    const shown = v && v.items[id];
    if (!shown || !Number.isInteger(shown.aggregateRev)) throw new SyncError('refused', 'stale_view', 'Reload the schedule and review it again before deleting.');
    if (this.protected && this.protected.assignmentId === id) throw new SyncError('refused', 'protected', 'A backup from this schedule is set up or running.');
    const d = this.acct && this.acct.data;
    if (d && Object.values(d.local).some((l) => l.a === id || l.key === id)) throw new SyncError('refused', 'pending', 'This schedule has changes not yet on the server; let them upload (or discard them) first.');
    await this._freshAdmin();
    const aid = tid('assignment', id);
    const r = (await this._sendNow([{ op: 'delete_assignment', assignment_key: id, expected_aggregate_rev: shown.aggregateRev }], { kind: 'admin', ids: [aid] }))[0];
    if (r.status === 'conflict') return { ok: false, stale: true, message: 'Someone changed this schedule after you reviewed it, so it was not deleted. Review it again.' };
    return { ok: true };
  }

  async restoreAssignment({ id, rev }) {
    if (!Number.isInteger(rev)) throw new SyncError('refused', 'invalid', 'Unknown schedule revision.');
    await this._freshAdmin();
    // syncNow (inside _sendNow) pulls after sending, which brings back the restored payload.
    try {
      await this._sendNow([{ op: 'restore_assignment', assignment_key: id, expected_aggregate_rev: rev }], { kind: 'admin', ids: [tid('assignment', id)] });
    } catch (e) {
      if (e.code === 'aggregate_rev_mismatch') return { ok: false, stale: true, message: 'This schedule changed since you looked (a late edit arrived). Review it again.' };
      throw e;
    }
    return { ok: true };
  }

  /* ------------------------------------------------------------ one-time import of this computer's data */

  /**
   * Copy this computer's local schedules, city list and learned settings into the team,
   * once and only when asked. The originals are left untouched and backed up; ids are
   * mapped once per account, so running it again sends nothing twice. Nothing is queued
   * unless everything fits the server's limits.
   */
  importLocal({ confirm, report }) {
    if (!this.acct || this.acct.data.locked) throw new SyncError('config', 'signed_out', 'Not signed in.');
    const d = this.acct.data;
    const read = (name) => { try { return JSON.parse(this.fs.readFileSync(path.join(this.legacyDir, name), 'utf8')); } catch (_) { return null; } };
    const schedules = read('schedules.json');
    const cities = read('cities.json');
    const settings = read('settings.json') || {};
    const S = require('../../renderer/schedule-logic');
    const map = (k) => (d.importMap[k] = d.importMap[k] || this.uuid());
    const items = ((schedules && schedules.items) || []).filter((x) => x && x.id).map((x) => ({
      ...x, id: map(`a:${x.id}`), label: x.label || undefined,
      sessions: (x.sessions || []).map((r) => {
        const { busy, error, ...row } = r;
        void busy; void error;
        return { ...row, uid: map(`r:${x.id}:${r.key}`), orderKey: undefined };
      }),
    }));
    const snap = {
      schedules: { openId: null, items },
      ...(report ? { report } : {}),
      team: { defaults: settings.scheduleDefaults || {}, starts: settings.scheduleStarts || {}, memory: settings.scheduleMemory || { titles: [], places: [] } },
      cities: cities && Array.isArray(cities.rows) ? S.parseCities(cities.rows) : null,
    };
    const built = fromSnapshot(snap, []);
    if (built.problems.length) {
      if (!confirm) this._save();   // the id map, so a second preview gives the same ids
      return { ok: false, problems: built.problems.slice(0, 200), counts: null };
    }
    // Possible duplicates: the same source file and days as a schedule the team has.
    const current = this._current();
    const warnings = built.warnings.slice();
    const days = (a) => Object.values(built.targets).filter((t) => t.type === 'session' && t.a === a).map((t) => t.payload.date).filter(Boolean);
    for (const item of items) {
      const mine = new Set(days(item.id));
      for (const t of Object.values(current)) {
        if (t.type !== 'assignment' || t.key === item.id || !t.payload.sourceBasename) continue;
        if (t.payload.sourceBasename !== (built.targets[tid('assignment', item.id)].payload.sourceBasename)) continue;
        const theirs = Object.values(current).filter((x) => x.type === 'session' && x.a === t.key).map((x) => x.payload.date);
        if (theirs.some((x) => mine.has(x))) warnings.push({ code: 'possible_duplicate', where: t.payload.label, text: `"${t.payload.label}" may be the same schedule (${t.payload.sourceBasename}). Both are kept; delete one if it is a duplicate.` });
      }
    }
    // Mapped ids (schedules, rows, what was read) already sent are skipped, so a second run sends
    // nothing twice. Natural keys (cities, learned, report, team) equal to the team's are skipped;
    // different ones are sent as creates, which the server keeps as create_collision conflicts.
    const MAPPED = new Set(['assignment', 'session', 'source_line', 'source_skip']);
    const fresh = Object.entries(built.targets).filter(([id, t]) => {
      if (d.local[id]) return false;
      const s = d.server[id];
      if (!(s && s.head)) return true;
      return !MAPPED.has(t.type) && !s.deleted && s.payload !== undefined && canon(s.payload) !== canon(t.payload);
    });
    const counts = { schedules: items.length, rows: fresh.filter(([, t]) => t.type === 'session').length, targets: fresh.length };
    if (!confirm) { this._save(); return { ok: true, preview: true, counts, warnings }; }
    if (this.protected) throw new SyncError('config', 'busy', 'Finish or put aside the backup that is set up first.');
    // Copies of the originals beside this account's cache; the originals are not touched.
    const backup = path.join(this.acct.folder, 'import-backup', new Date(this.now()).toISOString().replace(/[:.]/g, '-'));
    this.fs.mkdirSync(backup, { recursive: true });
    for (const name of ['schedules.json', 'cities.json', 'settings.json']) {
      const src = path.join(this.legacyDir, name);
      if (this.fs.existsSync(src)) this.fs.copyFileSync(src, path.join(backup, name));
    }
    for (const [id, t] of fresh) d.local[id] = { type: t.type, key: t.key, a: t.a || null, value: t.payload, base: null, inflight: null, held: null, error: null, at: this.now() };
    for (const item of items) {
      d.overlay.items[item.id] = { file: item.file || '', saved: item.saved || null, scan: item.scan || null };
      d.overlay.keys[item.id] = Object.fromEntries(item.sessions.filter((r) => Number.isInteger(r.key)).map((r) => [r.uid, r.key]));
    }
    d.imports.push({ at: new Date(this.now()).toISOString(), ...counts });
    this._save();
    this.remoteWaiting = true;
    this.emit('changed');
    this.kick(0);
    return { ok: true, counts, warnings };
  }
}

module.exports = { SyncEngine, IDENTITY_FIELDS };

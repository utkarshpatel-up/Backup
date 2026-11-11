'use strict';
// TEST ONLY. The team's PocketBase server as the app's fetch sees it: the real sync rules
// (server/pb_hooks/avb_core.js) on an in-memory SQLite database, behind a stand-in for
// PocketBase's users auth API and the /api/avb/rpc routes (server/pb_hooks/avb.pb.js). The
// rules are the server's own; the auth and HTTP layers imitate PocketBase's documented
// behaviour (tokens are NOT real JWT signatures), not PocketBase itself.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createCore, errorResponse, SCHEMA } = require('../../server/pb_hooks/avb_core');

const ROOT = path.join(__dirname, '..', '..');

/** SQLite with PocketBase's avb_members collection table and the sync schema. */
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE avb_members (id TEXT PRIMARY KEY, user TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT FALSE, display_name TEXT NOT NULL DEFAULT '')`);
  for (const sql of SCHEMA) db.exec(sql);
  return db;
}

/** The core's {:name} parameters as node:sqlite named parameters. */
function adapter(db) {
  const prep = (sql, params) => {
    const names = new Set();
    const text = sql.replace(/\{:(\w+)\}/g, (_, n) => { names.add(n); return `:${n}`; });
    const bound = {};
    for (const n of names) bound[n] = params[n] === undefined ? null : params[n];
    return [db.prepare(text), bound];
  };
  return {
    all: (sql, params = {}) => { const [st, b] = prep(sql, params); return st.all(b).map((r) => JSON.parse(r.j)); },
    run: (sql, params = {}) => { const [st, b] = prep(sql, params); st.run(b); },
  };
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const pbId = () => crypto.randomBytes(8).toString('hex').slice(0, 15);

class FakeServer {
  constructor() {
    this.db = database();
    this.serverUrl = 'http://10.147.20.5:8090';     // a ZeroTier address
    this.config = { enabled: true, serverUrl: this.serverUrl };
    this.clock = { now: Date.parse('2026-11-08T09:00:00Z') };
    this.users = new Map();        // email -> {id, password}
    this.access = new Map();       // token -> {sub, exp}: PocketBase auth tokens (one token, refreshed while valid)
    this.offline = false;
    this.loseNextApply = false;    // run the apply, then drop the answer (a timeout after commit)
    this.requests = [];            // {path, raw} as sent to /api/avb
    this.ttl = 7 * 24 * 3600;      // PocketBase's default auth token lifetime
    this.core = createCore({ db: adapter(this.db), uuid: () => crypto.randomUUID(),
      now: () => new Date(this.clock.now).toISOString(), sha256: (s) => crypto.createHash('sha256').update(s).digest('hex') });
  }
  addUser(email, role, name, password = 'pw-' + crypto.randomBytes(4).toString('hex')) {
    const id = pbId();
    this.users.set(email, { id, password });
    if (role) this.db.prepare('INSERT INTO avb_members (id, user, role, is_active, display_name) VALUES (?, ?, ?, 1, ?)').run(pbId(), id, role, name);
    return { id, email, password };
  }
  /** What the maintainer does in the PocketBase dashboard (avb_members). */
  setMember(email, role, active) {
    const id = this.users.get(email).id;
    const up = this.db.prepare('UPDATE avb_members SET role = ?, is_active = ? WHERE user = ?').run(role, active ? 1 : 0, id);
    if (!up.changes) this.db.prepare('INSERT INTO avb_members (id, user, role, is_active) VALUES (?, ?, ?, ?)').run(pbId(), id, role, active ? 1 : 0);
  }
  _token(sub) {
    const exp = Math.floor(this.clock.now / 1000) + this.ttl;
    const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ id: sub, collectionId: '_pb_users_auth_', type: 'auth', refreshable: true, exp })}.${crypto.randomBytes(16).toString('hex')}`;
    this.access.set(token, { sub, exp });
    return token;
  }
  _auth(init) {
    const tok = this.access.get(((init.headers && init.headers.Authorization) || '').replace(/^Bearer /, ''));
    return tok && tok.exp * 1000 > this.clock.now ? tok : null;
  }
  /** What the app's fetch is given. */
  fetch = async (href, init = {}) => {
    if (init.redirect !== 'error') throw new Error('test: the client must refuse redirects');
    const url = new URL(href);
    if (this.offline || url.origin !== new URL(this.serverUrl).origin) throw new TypeError('fetch failed');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const p = url.pathname;
    const unauthorized = () => this._json(401, { status: 401, message: 'The request requires valid record authorization token.', data: {} });
    if (init.method === 'POST' && p === '/api/collections/users/records') {
      if (this.users.has(body.email)) return this._json(400, { status: 400, message: 'Failed to create record.', data: { email: { code: 'validation_not_unique', message: 'Value must be unique.' } } });
      const u = this.addUser(body.email, null, '', body.password);
      return this._json(200, { id: u.id, email: body.email, name: body.name, collectionName: 'users' });
    }
    if (init.method === 'POST' && p === '/api/collections/users/auth-with-password') {
      const u = this.users.get(body.identity);
      if (!u || u.password !== body.password) return this._json(400, { status: 400, message: 'Failed to authenticate.', data: {} });
      return this._json(200, { token: this._token(u.id), record: { id: u.id, email: body.identity, collectionName: 'users' } });
    }
    if (init.method === 'POST' && p === '/api/collections/users/auth-refresh') {
      const tok = this._auth(init);
      if (!tok) return unauthorized();
      return this._json(200, { token: this._token(tok.sub), record: { id: tok.sub, collectionName: 'users' } });
    }
    const rpc = /^\/api\/avb\/rpc\/([a-z_]+)$/.exec(p);
    if (!rpc || init.method !== 'POST') return this._json(404, { status: 404, message: 'The requested resource wasn\'t found.', data: {} });
    this.requests.push({ path: p, raw: init.body });
    const tok = this._auth(init);
    if (!tok) return unauthorized();
    let out;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      out = this.core.call(rpc[1], tok.sub, body === undefined ? {} : body);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      const r = errorResponse(e);
      if (r.status >= 500) throw e;   // a bug in the rules: fail the test loudly
      return this._json(r.status, r.body);
    }
    if (rpc[1] === 'avb_sync_apply' && this.loseNextApply) { this.loseNextApply = false; throw new TypeError('fetch failed'); }
    return this._json(200, out);
  };
  _json(status, obj, headers = {}) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }
}

/** safeStorage as Electron gives it, with an OS key store; encrypted bytes never hold the text. */
function fakeSafeStorage({ available = true, backend = 'keychain' } = {}) {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(s) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    decryptString(b) {
      const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

/** The real fs, with writes that can be made to fail (a full or pulled disk). */
function faultyFs() {
  const f = Object.create(fs);
  f.fail = false;
  f.writeSync = (...a) => { if (f.fail) { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; } return fs.writeSync(...a); };
  return f;
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avb-sync-app-'));

module.exports = { FakeServer, fakeSafeStorage, faultyFs, tmpDir, ROOT, database, adapter };

'use strict';
// TEST ONLY. A throwaway PostgreSQL 16 on a Unix socket under /private/tmp (deleted after),
// with tests/db/shim.sql and the reviewed migration, and a stand-in for the HTTP side: a
// fake Managed Better Auth (cookie session + short JWT; it is NOT real authentication) and
// a Neon Data API-shaped router that runs each RPC as the `authenticated` role with the
// JWT claims pg_session_jwt would expose. The RPC rules are therefore the real database's;
// the auth and HTTP layers are imitations of documented behaviour, not Neon itself.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATION = path.join(ROOT, 'db', 'migrations', '20261107000000_av_backup_sync_v1.sql');

function pgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  try { return execFileSync('pg_config', ['--bindir']).toString().trim(); } catch (_) { return null; }
}

class Pg {
  static available() { const b = pgBin(); return !!(b && fs.existsSync(path.join(b, 'initdb'))); }
  constructor() {
    this.bin = pgBin();
    const base = fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir();
    this.dir = fs.mkdtempSync(path.join(base, 'avb-sync-'));
    const run = (cmd, args) => execFileSync(path.join(this.bin, cmd), args, { stdio: 'pipe' });
    run('initdb', ['-D', `${this.dir}/data`, '-U', 'test_super', '-A', 'trust', '-E', 'UTF8', '--locale=C']);
    run('pg_ctl', ['-D', `${this.dir}/data`, '-w', '-l', `${this.dir}/log`, '-o', `-c listen_addresses='' -c unix_socket_directories='${this.dir}' -c fsync=off`, 'start']);
    this.psql('postgres', 'create database avb_test');
    this.psql('avb_test', null, ['-f', path.join(ROOT, 'tests', 'db', 'shim.sql')]);
    this.psql('avb_test', null, ['-U', 'neondb_owner', '-f', MIGRATION]);
    this.psql('avb_test', `
      create schema t;
      grant usage on schema t to authenticated;
      create function t.login(p_sub text) returns void language plpgsql as $$
      begin
        perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated')::text, false);
        perform set_config('role', 'authenticated', false);
      end $$;
      grant execute on function t.login(text) to authenticated;`);
    this.psql('postgres', 'alter database avb_test is_template true');
    this.n = 0;
  }
  psql(db, sql, extra = [], user = 'test_super') {
    const args = ['-h', this.dir, '-U', user, '-d', db, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', ...extra];
    const i = extra.indexOf('-U'); if (i >= 0) args.splice(2, 2);
    return execFileSync(path.join(this.bin, 'psql'), args, { input: sql == null ? undefined : `\\set VERBOSITY verbose\n${sql}\n`, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString();
  }
  /** A fresh database cloned from the migrated template. */
  database() {
    const db = `avb_t${++this.n}`;
    this.psql('postgres', `create database ${db} template avb_test`);
    return db;
  }
  stop() {
    try { execFileSync(path.join(this.bin, 'pg_ctl'), ['-D', `${this.dir}/data`, '-m', 'immediate', 'stop'], { stdio: 'pipe' }); } catch (_) { /* gone */ }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

const lit = (obj) => {
  const j = JSON.stringify(obj);
  if (j.includes('$j$')) throw new Error('payload contains the quote marker');
  return `$j$${j}$j$::jsonb`;
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const COOKIE = '__Secure-neon-auth.session_token';

/** The team's Neon project as the app's fetch sees it: Auth and the Data API on their own hosts. */
class FakeServer {
  constructor(pg, db) {
    Object.assign(this, { pg, db });
    this.authUrl = 'https://ep-test.neonauth.team.test/neondb/auth';
    this.dataUrl = 'https://ep-test.apirest.team.test/neondb/rest/v1';
    this.config = { enabled: true, authUrl: this.authUrl, dataUrl: this.dataUrl };
    this.clock = { now: Date.parse('2026-11-08T09:00:00Z') };
    this.users = new Map();        // email -> {id, password}
    this.access = new Map();       // JWT -> {sub, exp}: what the Data API accepts
    this.refresh = new Map();      // session cookie value -> {sub}: Better Auth's session
    this.offline = false;
    this.loseNextApply = false;    // run the apply, then drop the answer (a timeout after commit)
    this.requests = [];            // {path, raw} as sent
    this.ttl = 900;                // Neon's JWTs last about 15 minutes
  }
  addUser(email, role, name, password = 'pw-' + crypto.randomBytes(4).toString('hex')) {
    const id = this.pg.psql(this.db, `insert into neon_auth."user" (email) values ('${email}') returning id`).trim();
    this.users.set(email, { id, password });
    if (role) this.pg.psql(this.db, `select avb_private.set_member('${id}', '${email}', '${role}', true, '${name}')`, [], 'neondb_owner');
    return { id, email, password };
  }
  setMember(email, role, active) {
    this.pg.psql(this.db, `select avb_private.set_member('${this.users.get(email).id}', '${email}', '${role}', ${active})`, [], 'neondb_owner');
  }
  _jwt(sub) {
    const exp = Math.floor(this.clock.now / 1000) + this.ttl;
    const origin = new URL(this.authUrl).origin;
    const token = `${b64({ alg: 'EdDSA' })}.${b64({ sub, role: 'authenticated', exp, iat: exp - this.ttl, iss: origin, aud: origin })}.${crypto.randomBytes(16).toString('hex')}`;
    this.access.set(token, { sub, exp });
    return token;
  }
  _session(init) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE.replace(/[.]/g, '\\.')}=([^;]+)`).exec((init.headers && init.headers.Cookie) || '');
    return m ? this.refresh.get(m[1]) : null;
  }
  /** What the app's fetch is given. */
  fetch = async (href, init = {}) => {
    if (init.redirect !== 'error') throw new Error('test: the client must refuse redirects');
    const url = new URL(href);
    if (this.offline) throw new TypeError('fetch failed');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const authBase = new URL(this.authUrl), dataBase = new URL(this.dataUrl);
    if (url.origin === authBase.origin && url.pathname.startsWith(`${authBase.pathname}/`)) {
      const p = url.pathname.slice(authBase.pathname.length + 1);
      // Better Auth refuses cookie-bearing writes from an untrusted Origin.
      if (init.method !== 'GET' && init.headers.Origin !== authBase.origin) return this._json(403, { code: 'INVALID_ORIGIN', message: 'Invalid origin' });
      if (p === 'sign-up/email' && init.method === 'POST') {
        if (this.users.has(body.email)) return this._json(422, { code: 'USER_ALREADY_EXISTS', message: 'User already exists' });
        const id = this.pg.psql(this.db, `insert into neon_auth."user" (email) values ('${body.email.replace(/'/g, "''")}') returning id`).trim();
        this.users.set(body.email, { id, password: body.password });
        const value = `${crypto.randomBytes(24).toString('hex')}.${crypto.randomBytes(8).toString('hex')}`;
        this.refresh.set(value, { sub: id });
        return this._json(200, { token: value.split('.')[0], user: { id, email: body.email } },
          { 'Set-Cookie': `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax` });
      }
      if (p === 'sign-in/email' && init.method === 'POST') {
        const u = this.users.get(body.email);
        if (!u || u.password !== body.password) return this._json(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });
        const value = `${crypto.randomBytes(24).toString('hex')}.${crypto.randomBytes(8).toString('hex')}`;
        this.refresh.set(value, { sub: u.id });
        return this._json(200, { token: value.split('.')[0], user: { id: u.id, email: body.email } },
          { 'Set-Cookie': `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax` });
      }
      const sess = this._session(init);
      if (p === 'token' && init.method === 'GET') {
        if (!sess) return this._json(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });
        return this._json(200, { token: this._jwt(sess.sub) });
      }
      if (p === 'sign-out' && init.method === 'POST') {
        for (const [k, v] of this.refresh) if (sess && v.sub === sess.sub) this.refresh.delete(k);
        return this._json(200, { success: true });
      }
      return this._json(404, { message: 'not found' });
    }
    if (url.origin !== dataBase.origin) throw new TypeError('fetch failed');
    this.requests.push({ path: url.pathname + url.search, raw: init.body });
    const rpc = new RegExp(`^${dataBase.pathname}/rpc/(avb_[a-z_]+)$`).exec(url.pathname);
    if (!rpc) return this._json(404, { message: 'not found' });
    const tok = this.access.get((init.headers.Authorization || '').replace(/^Bearer /, ''));
    if (!(tok && tok.exp * 1000 > this.clock.now)) return this._json(401, { code: 'PGRST303', message: 'JWT expired' });
    const arg = rpc[1] === 'avb_me' || rpc[1] === 'avb_team_members' ? '' : lit(body.p_request);
    let out;
    try {
      out = this.pg.psql(this.db, `select t.login('${tok.sub}') \\g /dev/null\nselect public.${rpc[1]}(${arg})`);
    } catch (e) {
      const m = /ERROR:\s+([0-9A-Z]{5}): ([^\n]*)/.exec(String(e.stderr || e.message));
      const code = m ? m[1] : 'XX000';
      return this._json(code === '42501' ? 403 : code === 'P0001' ? 400 : 500, { code, message: m ? m[2] : 'error', details: null });
    }
    if (rpc[1] === 'avb_sync_apply' && this.loseNextApply) { this.loseNextApply = false; throw new TypeError('fetch failed'); }
    return this._json(200, JSON.parse(out.trim().split('\n').pop()));
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

module.exports = { Pg, FakeServer, fakeSafeStorage, faultyFs, tmpDir, ROOT, lit };

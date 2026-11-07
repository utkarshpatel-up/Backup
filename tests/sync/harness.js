'use strict';
// TEST ONLY. A throwaway PostgreSQL 16 on a Unix socket under /private/tmp (deleted after),
// with tests/supabase/shim.sql and the reviewed migration, and a stand-in for the HTTP
// side: a fake GoTrue (it is NOT real authentication) and a PostgREST-shaped router that
// runs each RPC as the `authenticated` role with the JWT claims PostgREST would set. The
// RPC rules are therefore the real database's; the auth and HTTP layers are imitations.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20261107000000_av_backup_sync_v1.sql');

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
    this.psql('avb_test', null, ['-f', path.join(ROOT, 'tests', 'supabase', 'shim.sql')]);
    this.psql('avb_test', null, ['-U', 'postgres', '-f', MIGRATION]);
    this.psql('avb_test', `
      create schema t;
      grant usage on schema t to authenticated;
      create function t.login(p_sub uuid, p_aal text) returns void language plpgsql as $$
      begin
        perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated', 'aal', p_aal)::text, false);
        perform set_config('role', 'authenticated', false);
      end $$;
      grant execute on function t.login(uuid, text) to authenticated;`);
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
const PUBLISHABLE = 'sb_publishable_testOnlyKey_0123456789';

/** The team server as the app's fetch sees it. */
class FakeServer {
  constructor(pg, db, { origin = 'https://team.test' } = {}) {
    Object.assign(this, { pg, db, origin });
    this.clock = { now: Date.parse('2026-11-08T09:00:00Z') };
    this.users = new Map();        // email -> {id, password, factors}
    this.access = new Map();       // token -> {sub, aal, exp}
    this.refresh = new Map();      // token -> {sub, aal}
    this.offline = false;
    this.loseNextApply = false;    // run the apply, then drop the answer (a timeout after commit)
    this.requests = [];            // {path, body} as sent
    this.ttl = 3600;
  }
  addUser(email, role, name, password = 'pw-' + crypto.randomBytes(4).toString('hex')) {
    const id = this.pg.psql(this.db, `insert into auth.users (email) values ('${email}') returning id`).trim();
    if (role) this.pg.psql(this.db, `select avb_private.set_member('${email}', '${role}', true, '${name}')`);
    this.users.set(email, { id, password, factors: [] });
    return { id, email, password };
  }
  setMember(email, role, active) { this.pg.psql(this.db, `select avb_private.set_member('${email}', '${role}', ${active})`); }
  _issue(sub, aal) {
    const exp = Math.floor(this.clock.now / 1000) + this.ttl;
    const access = `${b64({ alg: 'none' })}.${b64({ sub, aal, exp, role: 'authenticated' })}.${crypto.randomBytes(16).toString('hex')}`;
    const refresh = crypto.randomBytes(24).toString('hex');
    this.access.set(access, { sub, aal, exp });
    this.refresh.set(refresh, { sub, aal });
    return { access_token: access, refresh_token: refresh, expires_in: this.ttl, expires_at: exp, token_type: 'bearer', user: { id: sub } };
  }
  /** What the app's fetch is given. */
  fetch = async (href, init = {}) => {
    if (init.redirect !== 'error') throw new Error('test: the client must refuse redirects');
    const url = new URL(href);
    if (url.origin !== this.origin) throw new TypeError('fetch failed');
    if (this.offline) throw new TypeError('fetch failed');
    if (init.headers.apikey !== PUBLISHABLE) return this._json(401, { message: 'Invalid API key' });
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.requests.push({ path: url.pathname + url.search, raw: init.body });
    const auth = (init.headers.Authorization || '').replace(/^Bearer /, '');
    const tok = this.access.get(auth);
    const live = tok && tok.exp * 1000 > this.clock.now;
    const p = url.pathname;
    if (p === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'password') {
        const u = this.users.get(body.email);
        if (!u || u.password !== body.password) return this._json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return this._json(200, this._issue(u.id, 'aal1'));
      }
      const r = this.refresh.get(body.refresh_token);
      if (!r) return this._json(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
      this.refresh.delete(body.refresh_token);   // rotated
      return this._json(200, this._issue(r.sub, r.aal));
    }
    if (p.startsWith('/auth/v1/')) {
      if (!live) return this._json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
      const u = [...this.users.values()].find((x) => x.id === tok.sub);
      if (p === '/auth/v1/logout') {
        for (const [k, v] of this.access) if (v.sub === tok.sub) this.access.delete(k);
        for (const [k, v] of this.refresh) if (v.sub === tok.sub) this.refresh.delete(k);
        return this._json(204, null);
      }
      if (p === '/auth/v1/user') return this._json(200, { id: u.id, factors: u.factors.map((f) => ({ id: f.id, factor_type: 'totp', status: f.status })) });
      if (p === '/auth/v1/factors') {
        const f = { id: crypto.randomUUID(), status: 'unverified' };
        u.factors.push(f);
        return this._json(200, { id: f.id, type: 'totp', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' } });
      }
      const m = /^\/auth\/v1\/factors\/([^/]+)\/(challenge|verify)$/.exec(p);
      const f = m && u.factors.find((x) => x.id === m[1]);
      if (!f) return this._json(404, { msg: 'not found' });
      if (m[2] === 'challenge') return this._json(200, { id: crypto.randomUUID(), expires_at: 0 });
      if (body.code !== '123456') return this._json(422, { error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' });
      f.status = 'verified';
      return this._json(200, this._issue(u.id, 'aal2'));
    }
    const rpc = /^\/rest\/v1\/rpc\/(avb_[a-z_]+)$/.exec(p);
    if (!rpc) return this._json(404, { message: 'not found' });
    if (!live) return this._json(401, { code: 'PGRST303', message: 'JWT expired' });
    const arg = rpc[1] === 'avb_me' || rpc[1] === 'avb_team_members' ? '' : lit(body.p_request);
    let out;
    try {
      out = this.pg.psql(this.db, `select t.login('${tok.sub}', '${tok.aal}') \\g /dev/null\nselect public.${rpc[1]}(${arg})`);
    } catch (e) {
      const m = /ERROR:\s+([0-9A-Z]{5}): ([^\n]*)/.exec(String(e.stderr || e.message));
      const code = m ? m[1] : 'XX000';
      return this._json(code === '42501' ? 403 : code === 'P0001' ? 400 : 500, { code, message: m ? m[2] : 'error', details: null });
    }
    if (rpc[1] === 'avb_sync_apply' && this.loseNextApply) { this.loseNextApply = false; throw new TypeError('fetch failed'); }
    return this._json(200, JSON.parse(out.trim().split('\n').pop()));
  };
  _json(status, obj) {
    return new Response(status === 204 ? null : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
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

module.exports = { Pg, FakeServer, fakeSafeStorage, faultyFs, tmpDir, PUBLISHABLE, ROOT, lit };

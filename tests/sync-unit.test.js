'use strict';
// Sync modules without a server: the payload rules against the migration's own table,
// source packing, the snapshot model, URL/key/redirect checks and the encrypted files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const spec = require('../electron/sync/spec');
const pack = require('../electron/sync/source-pack');
const model = require('../electron/sync/model');
const { Client, parseBaseUrl, classify, sessionCookie } = require('../electron/sync/client');
const { SealedFile, SessionStore, osProtectionAvailable } = require('../electron/sync/vault');
const { fakeSafeStorage, faultyFs, tmpDir } = require('./sync/harness');
const S = require('../renderer/schedule-logic');
const fixtures = require('./fixtures/schedule-ocr.json');

const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '20261107000000_av_backup_sync_v1.sql'), 'utf8');
const uuid = () => require('node:crypto').randomUUID();

test('the JS payload table is exactly the migration\'s payload_spec', () => {
  const body = MIGRATION.slice(MIGRATION.indexOf('function avb_private.payload_spec'), MIGRATION.indexOf('function avb_private.validate_payload'));
  const sql = {};
  for (const m of body.matchAll(/when '([a-z_]+)' then '(\{[\s\S]*?\})'::jsonb/g)) sql[m[1]] = JSON.parse(m[2]);
  assert.deepEqual(Object.keys(sql).sort(), spec.TYPES.slice().sort());
  for (const t of spec.TYPES) assert.deepEqual(spec.SPEC[t], sql[t], t);
});

test('field bounds count code points and refuse paths, unknown fields and bad dates', () => {
  const ok = (p) => spec.payloadProblems('session', { orderKey: 'V', include: true, date: '2026-11-08', ...p });
  assert.deepEqual(ok({ topic: '😀'.repeat(1000) }), []);                         // 1000 code points, 4000 bytes
  assert.equal(ok({ topic: 'a'.repeat(1001) })[0].code, 'invalid_field');
  assert.equal(ok({ date: '2026-02-30' })[0].code, 'invalid_field');
  assert.equal(ok({ key: 5 })[0].code, 'unknown_field');
  assert.equal(ok({ flags: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, 'x'])) })[0].code, 'invalid_field');
  for (const bad of ['C:poster.pdf', 'a/b.pdf', 'a\\b.pdf']) {
    assert.equal(spec.payloadProblems('assignment', { label: 'x', sourceBasename: bad })[0].code, 'invalid_field', bad);
  }
  assert.equal(spec.payloadProblems('assignment', { label: 'x', defaults: { author: 'DD', bogus: 1 } })[0].field, 'team_defaults.bogus');
  assert.equal(spec.payloadProblems('source_skip', { index: 0, days: [], reason: 'break', rowText: '' })[0].code, 'invalid_field');
  // 32 KiB is measured on jsonb's spaced text, not on compact JSON.
  const near = { key: 'k', topic: 'x'.repeat(1000), events: Array.from({ length: 64 }, () => 'e'.repeat(200)), languages: Array.from({ length: 64 }, () => 'l'.repeat(100)) };
  assert.ok(Buffer.byteLength(JSON.stringify(near)) < spec.jsonbBytes(near));
  assert.equal(spec.jsonbBytes({ a: 1, b: [1, 2], c: 'é' }), Buffer.byteLength('{"a": 1, "b": [1, 2], "c": "é"}'));
});

test('keys follow check_target: natural keys trim spaces only and must match the payload', () => {
  assert.equal(spec.naturalKey('city', { name: '  Rampur (GJ) ' }), 'rampur (gj)');
  assert.equal(spec.naturalKey('report_record', { id: ' dd-f-hd-1-m ' }), 'DD-F-HD-1-M');
  assert.equal(spec.keyProblem('city', 'pune', { name: 'Mumbai' }), 'invalid_key');
  const a = uuid();
  assert.equal(spec.keyProblem('source_line', `${a}:3:1`, { line: 3, part: 1 }), null);
  assert.equal(spec.keyProblem('source_line', `${a}:3:1`, { line: 3, part: 2 }), 'invalid_key');
  assert.equal(spec.keyProblem('session', a.toUpperCase()), 'invalid_key');
});

test('what was read round-trips exactly: the four OCR posters and a line bigger than a payload', () => {
  const a = uuid();
  for (const [name, fx] of Object.entries(fixtures)) {
    if (name.startsWith('_')) continue;
    const read = S.readRows(fx.rows);
    const t = pack.sourceTargets(a, fx.rows, read.skipped);
    for (const x of Object.values(t)) assert.deepEqual(spec.payloadProblems(x.type, x.payload), [], name);
    const lines = Object.values(t).filter((x) => x.type === 'source_line').map((x) => x.payload);
    assert.deepEqual(pack.unpackLines(lines), fx.rows, name);
  }
  const huge = Array.from({ length: 32767 }, (_, i) => (i % 97 === 0 ? '😀' : 'સ')).join('');
  const rows = [['header'], Array.from({ length: 300 }, (_, i) => (i === 7 ? huge : `c${i} "q" \\ \n€`)), [], ['tail']];
  const parts = Object.values(pack.sourceTargets(a, rows, [])).map((x) => x.payload);
  assert.ok(parts.length > 5);
  for (const p of parts) assert.deepEqual(spec.payloadProblems('source_line', p), []);
  assert.deepEqual(pack.unpackLines(parts), rows);
});

const snapshotOf = (items, extra = {}) => ({ schedules: { openId: null, items }, ...extra });
const row = (uid, extra = {}) => ({ key: 1, uid, include: true, date: '2026-11-08', type: 'Formal', topic: 'T', events: [], languages: [], flags: {}, ...extra });

test('row order: inserting or copying a row gives only that row a new order key', () => {
  const keys = model.orderKeys([undefined, undefined, undefined]);
  assert.ok(keys[0] < keys[1] && keys[1] < keys[2]);
  const ins = model.orderKeys([keys[0], undefined, keys[1], keys[2]]);
  assert.deepEqual([ins[0], ins[2], ins[3]], keys);
  assert.ok(ins[0] < ins[1] && ins[1] < ins[2]);
  const copied = model.orderKeys([keys[0], keys[0], keys[1]]);   // a deep-cloned row carries the old key
  assert.equal(copied[0], keys[0]);
  assert.ok(copied[1] > keys[0] && copied[1] < keys[1]);
  const many = model.orderKeys(Array(2000).fill(undefined));
  assert.ok(many.every((k, i) => !i || many[i - 1] < k) && many.every((k) => k.length <= 64 && !k.endsWith('0')));
});

test('a snapshot keeps device-only data off the wire and refuses what cannot sync', () => {
  const a = uuid(), r = uuid();
  const item = { id: a, file: '/Users/me/Desktop/poster.png', created: '2026-11-07T10:00:00.000Z', saved: '/x.xlsx', scan: { root: 'E:/' },
    rows: [['a', 'b']], read: { skipped: [], entries: [{}] }, sessions: [row(r, { geo: 'Rampur (MH)', startedAt: '2026-11-07T10:15:00.000Z' })],
    starts: { formal: 3058 }, defaults: { author: 'DD', format: 'HD', camsFormal: 3, camsInformal: 1 } };
  const b = model.fromSnapshot(snapshotOf([item]));
  assert.deepEqual(b.problems, []);
  const wire = JSON.stringify(b.targets);
  for (const local of ['/Users/me', '/x.xlsx', 'E:/']) assert.ok(!wire.includes(local), local);
  assert.equal(b.targets[`assignment/${a}`].payload.sourceBasename, 'poster.png');
  const s = b.targets[`session/${r}`].payload;
  assert.equal(s.geo, 'Rampur (MH)'); assert.equal(s.startedAt, '2026-11-07T10:15:00.000Z');
  assert.ok(!('key' in s) && !('uid' in s) && !('flags' in s));
  assert.deepEqual(b.overlay.items[a], { file: '/Users/me/Desktop/poster.png', saved: '/x.xlsx', scan: { root: 'E:/' } });
  const bad = model.fromSnapshot(snapshotOf([{ ...item, sessions: [row(r, { surprise: 1 }), row(r), { key: 9 }] }]));
  assert.deepEqual(bad.problems.map((p) => p.code).sort(), ['duplicate_uid', 'missing_uid', 'unknown_field']);
  assert.equal(model.fromSnapshot(snapshotOf([{ ...item, id: 'sabc123' }])).problems[0].code, 'invalid_key');
});

test('view -> snapshot is stable, and numeric row keys stay put while newcomers never collide', () => {
  const a = uuid(), r1 = uuid(), r2 = uuid(), r3 = uuid();
  const built = model.fromSnapshot(snapshotOf([{ id: a, file: 'p.png', sessions: [row(r1, { key: 7 }), row(r2, { key: 3 })], rows: [], read: null }]));
  const v = model.toView(built.targets, built.overlay);
  assert.deepEqual(v.schedules.items[0].sessions.map((x) => [x.uid, x.key]), [[r1, 7], [r2, 3]]);
  const again = model.fromSnapshot(v);
  for (const [id, t] of Object.entries(built.targets)) assert.equal(model.canon(again.targets[id].payload), model.canon(t.payload), id);
  // A remote row arrives with no key on this device, while this device already used key 8 for a row of its own.
  const cur = { ...built.targets, [`session/${r3}`]: { type: 'session', key: r3, a, payload: { orderKey: 'z', include: true, date: '' } } };
  const v2 = model.toView(cur, { ...built.overlay, keys: { [a]: { [r1]: 7, [r2]: 3 } } });
  const keys = v2.schedules.items[0].sessions.map((x) => x.key);
  assert.deepEqual(keys.slice(0, 2), [7, 3]);
  assert.equal(new Set(keys).size, 3);
});

test('learned corrections come back newest first; a report ID twice keeps the last and says so', () => {
  const cur = {
    'learned_title/old': { type: 'learned_title', key: 'old', payload: { key: 'Old' }, at: 1 },
    'learned_title/new': { type: 'learned_title', key: 'new', payload: { key: 'New' }, at: 3 },
    'learned_title/mid': { type: 'learned_title', key: 'mid', payload: { key: 'Mid' }, at: 2 },
  };
  assert.deepEqual(model.toView(cur, {}).team.memory.titles.map((t) => t.key), ['New', 'Mid', 'Old']);
  const b = model.fromSnapshot({ report: [{ id: 'X-1', topic: 'first', source: 'existing' }, { id: 'x-1', topic: 'second' }] });
  assert.equal(b.targets['report_record/X-1'].payload.topic, 'second');
  assert.ok(!('source' in b.targets['report_record/X-1'].payload));
  assert.equal(b.warnings[0].code, 'duplicate_report_id');
});

test('Neon addresses: HTTPS, or HTTP to this computer only; a path but nothing after it', () => {
  assert.equal(parseBaseUrl(' https://ep-x.neonauth.aws.neon.tech/neondb/auth/ ', 'Auth URL'), 'https://ep-x.neonauth.aws.neon.tech/neondb/auth');
  assert.equal(parseBaseUrl('https://ep-x.apirest.aws.neon.tech/neondb/rest/v1', 'Data API URL'), 'https://ep-x.apirest.aws.neon.tech/neondb/rest/v1');
  assert.equal(parseBaseUrl('http://127.0.0.1:54321/neondb/auth', 'Auth URL'), 'http://127.0.0.1:54321/neondb/auth');
  for (const bad of ['http://office-pc/neondb/auth', 'http://192.168.1.20/x', 'ftp://x/y', 'https://u:p@ep.neon.tech/neondb/auth',
    'https://ep.neon.tech/neondb/auth?x=1', 'https://ep.neon.tech/neondb/auth#a', 'ep.neon.tech/neondb/auth', '']) {
    assert.throws(() => parseBaseUrl(bad, 'Auth URL'), (e) => e.kind === 'config', bad);
  }
});

const AUTH = 'https://ep-x.neonauth.test/neondb/auth', DATA = 'https://ep-x.apirest.test/neondb/rest/v1';
const jwtWith = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('Better Auth sign-in: the session cookie comes back as the refresh token, the JWT as the access token', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith('/sign-in/email')) {
      return new Response('{"token":"raw"}', { status: 200, headers: [['Set-Cookie', '__Secure-neon-auth.session_data=x; Path=/'],
        ['Set-Cookie', '__Secure-neon-auth.session_token=abc.sig; Path=/; HttpOnly; Secure']] });
    }
    if (url.endsWith('/token')) return new Response(JSON.stringify({ token: jwtWith({ sub: 'u-1', role: 'authenticated', exp: 99 }) }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const c = new Client({ authUrl: AUTH, dataUrl: DATA, fetch });
  const tok = await c.signIn('a@b.c', 'pw');
  assert.equal(seen[0].url, `${AUTH}/sign-in/email`);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.Origin, 'https://ep-x.neonauth.test', 'Better Auth checks the Origin of writes');
  assert.equal(seen[1].url, `${AUTH}/token`);
  assert.equal(seen[1].init.headers.Cookie, '__Secure-neon-auth.session_token=abc.sig', 'only the session cookie is sent');
  assert.equal(tok.refresh_token, '__Secure-neon-auth.session_token=abc.sig');
  assert.equal(tok.user.id, 'u-1');
  assert.equal(tok.expires_at, 99);
  await c.signOut(tok.refresh_token);
  assert.equal(seen[2].url, `${AUTH}/sign-out`);
  assert.equal(seen[2].init.headers.Cookie, tok.refresh_token);
  // A Better Auth "admin" role would make the Data API refuse every call: say so up front.
  const adminRole = new Client({ authUrl: AUTH, dataUrl: DATA, fetch: async (url) => (url.endsWith('/token')
    ? new Response(JSON.stringify({ token: jwtWith({ sub: 'u', role: 'admin' }) }), { status: 200 })
    : new Response('{}', { status: 200, headers: { 'Set-Cookie': 'better-auth.session_token=z; Path=/' } })) });
  await assert.rejects(adminRole.signIn('a@b.c', 'pw'), (e) => e.code === 'bad_role');
  const noCookie = new Client({ authUrl: AUTH, dataUrl: DATA, fetch: async () => new Response('{}', { status: 200 }) });
  await assert.rejects(noCookie.signIn('a@b.c', 'pw'), (e) => e.code === 'bad_token');
  assert.equal(sessionCookie(new Response('', { headers: { 'Set-Cookie': 'other=1' } })), null);
});

test('the client never follows a redirect, stays inside its base path and leaks no token in errors', async () => {
  const seen = [];
  const reply = (status, body) => async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(body), { status }); };
  const c = (f) => new Client({ authUrl: AUTH, dataUrl: DATA, fetch: f });
  await c(reply(200, { ok: 1 })).rpc('TOKEN-abc', 'avb_me');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].url, `${DATA}/rpc/avb_me`);
  assert.equal(seen[0].init.headers.Authorization, 'Bearer TOKEN-abc');
  assert.equal(seen[0].init.headers.Cookie, undefined, 'the session cookie never goes to the Data API');
  assert.equal(seen[0].init.headers.apikey, undefined);
  await assert.rejects(c(reply(302, {})).rpc('t', 'avb_me'), (e) => e.code === 'redirect');
  const followed = async () => ({ ok: true, status: 200, redirected: true, url: 'https://elsewhere.example/x', text: async () => '{}' });
  await assert.rejects(c(followed).rpc('t', 'avb_me'), (e) => e.code === 'redirect');
  await assert.rejects(c(reply(200, {})).rpc('t', 'avb_secret_stuff'), (e) => e.code === 'bad_rpc');
  await assert.rejects(c(reply(200, {})).request(DATA, 'GET', '../../../neondb_owner'), (e) => e.code === 'bad_url');
  await assert.rejects(c(async () => { throw new TypeError('fetch failed'); }).rpc('t', 'avb_me'), (e) => e.kind === 'offline');
  const long = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz0123456789';
  await assert.rejects(c(reply(418, { message: `bad token ${long}` })).rpc('t', 'avb_me'), (e) => !e.message.includes(long));
  assert.throws(() => new Client({ authUrl: AUTH, dataUrl: DATA }), (e) => e.code === 'no_transport');
});

test('server errors map to offline / expired / revoked / forbidden / refused / busy', () => {
  assert.equal(classify(403, { code: '42501', message: 'avb:not_member' }).kind, 'revoked');
  assert.equal(classify(403, { code: '42501', message: 'avb:admin_required' }).code, 'admin_required');
  assert.equal(classify(401, { code: 'PGRST303', message: 'JWT expired' }).kind, 'unauthorized');
  assert.equal(classify(400, { code: 'P0001', message: 'avb:invalid_field' }).kind, 'refused');
  assert.equal(classify(500, { code: '55P03', message: 'lock' }).kind, 'busy');
  assert.equal(classify(503, {}).kind, 'server');
  assert.equal(classify(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }).code, 'invalid_credentials');
  assert.equal(classify(401, { code: 'UNAUTHORIZED' }).kind, 'unauthorized');
});

test('encrypted cache: no plaintext on disk, tamper and another account\'s file refused, no OS key store refused', () => {
  const dir = tmpDir();
  const ss = fakeSafeStorage();
  const mk = (aad, s = ss) => new SealedFile({ file: path.join(dir, 'cache.bin'), keyFile: path.join(dir, 'key.bin'), aad, safeStorage: s });
  mk('acct-A').write({ secret: 'Shibir topic', n: 1 });
  assert.ok(!fs.readFileSync(path.join(dir, 'cache.bin'), 'utf8').includes('Shibir'));
  assert.deepEqual(mk('acct-A').read(), { secret: 'Shibir topic', n: 1 });
  assert.throws(() => mk('acct-B').read(), (e) => e.code === 'tampered');
  const box = JSON.parse(fs.readFileSync(path.join(dir, 'cache.bin'), 'utf8'));
  box.ct = Buffer.from(Buffer.from(box.ct, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b))).toString('base64');
  fs.writeFileSync(path.join(dir, 'cache.bin'), JSON.stringify(box));
  assert.throws(() => mk('acct-A').read(), (e) => e.code === 'tampered');
  assert.throws(() => mk('x', fakeSafeStorage({ available: false })).write({}), (e) => e.code === 'no_os_encryption');
  assert.equal(osProtectionAvailable(fakeSafeStorage({ backend: 'basic_text' })), false);
  const store = new SessionStore({ file: path.join(dir, 's.bin'), safeStorage: ss });
  store.save({ access_token: 'ACCESS-123', refresh_token: 'REFRESH-456' });
  const raw = fs.readFileSync(path.join(dir, 's.bin'));
  assert.ok(!raw.includes('ACCESS-123') && !raw.includes('REFRESH-456'));
  assert.equal(store.load().refresh_token, 'REFRESH-456');
  assert.throws(() => new SessionStore({ file: path.join(dir, 's2.bin'), safeStorage: fakeSafeStorage({ backend: 'basic_text' }) }).save({}), (e) => e.code === 'no_os_encryption');
  // Keychain prompt denied: a clear reason, and no file left behind.
  const refused = { ...fakeSafeStorage(), encryptString() { throw new Error('Encryption not available'); } };
  assert.throws(() => new SessionStore({ file: path.join(dir, 's3.bin'), safeStorage: refused }).save({}), (e) => e.code === 'os_key_store' && /Always Allow/.test(e.message));
  assert.equal(fs.existsSync(path.join(dir, 's3.bin')), false);
});

test('a failed disk write keeps the previous file whole', () => {
  const dir = tmpDir();
  const ffs = faultyFs();
  const f = new SealedFile({ file: path.join(dir, 'c.bin'), keyFile: path.join(dir, 'k.bin'), aad: 'a', safeStorage: fakeSafeStorage(), fs: ffs });
  f.write({ v: 1 });
  ffs.fail = true;
  assert.throws(() => f.write({ v: 2 }), (e) => e.code === 'ENOSPC');
  ffs.fail = false;
  assert.deepEqual(f.read(), { v: 1 });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('a cache key is used only once it is on disk: a failed first key write, a retry, then a restart reads back', () => {
  const dir = tmpDir();
  const ss = fakeSafeStorage();
  const ffs = faultyFs();
  const files = { file: path.join(dir, 'c.bin'), keyFile: path.join(dir, 'k.bin'), aad: 'acct', safeStorage: ss };
  const f = new SealedFile({ ...files, fs: ffs });
  ffs.fail = true;                                          // the very first write is the key's
  assert.throws(() => f.write({ v: 1 }), (e) => e.code === 'ENOSPC');
  assert.equal(fs.existsSync(files.keyFile), false);
  ffs.fail = false;
  f.write({ v: 1 });                                       // the retry must persist a key too
  assert.deepEqual(new SealedFile(files).read(), { v: 1 }, 'readable after a restart');
  fs.writeFileSync(files.keyFile, 'not a wrapped key');
  assert.throws(() => new SealedFile(files).read(), (e) => e.code === 'bad_key');
});

test('atomic writes finish short writes (Unicode included) and fail safely when the disk stops taking data', () => {
  const { writeAtomic } = require('../electron/sync/vault');
  const dir = tmpDir();
  const file = path.join(dir, 'x.json');
  const text = JSON.stringify({ t: 'સત્સંગ 😀 '.repeat(500) });
  const short = Object.create(fs);
  short.writeSync = (fd, buf, off, len) => fs.writeSync(fd, buf, off, Math.min(len, 7));
  writeAtomic(short, file, text);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  const stuck = Object.create(fs);
  let calls = 0;
  stuck.writeSync = (fd, buf, off, len) => (calls++ ? 0 : fs.writeSync(fd, buf, off, Math.min(len, 5)));
  assert.throws(() => writeAtomic(stuck, file, JSON.stringify({ other: 1 })), (e) => e.code === 'EIO');
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'the previous file is untouched');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('server error text is never echoed: short secrets and unknown codes become fixed messages', () => {
  const { AVB_CODES } = require('../electron/sync/client');
  const codes = new Set([...MIGRATION.matchAll(/fail\('([a-z0-9_]+)'/g)].map((m) => m[1]));
  for (const m of MIGRATION.matchAll(/'avb:([a-z0-9_]+)'/g)) codes.add(m[1]);
  for (const c of codes) assert.ok(AVB_CODES.has(c), `the client knows avb:${c}`);
  const cases = [
    [400, { msg: 'Invalid login credentials for hunter2' }],
    [418, { message: 'token pw-1a2b' }],
    [400, { error_code: 'hunter2', msg: 'x' }],
    [403, { message: 'avb:hunter2' }],
    [422, { code: 'hunter2', message: 'hunter2' }],
    [500, { message: 'hunter2' }],
  ];
  for (const [status, body] of cases) {
    const e = classify(status, body);
    assert.ok(!`${e.message} ${e.code}`.includes('hunter2') && !e.message.includes('pw-1a2b'), JSON.stringify(body));
  }
  assert.equal(classify(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'no user hunter2' }).message, 'Wrong e-mail or password.');
  assert.equal(classify(400, { code: 'P0001', message: 'avb:invalid_field', details: 'session.topic hunter2' }).message, 'avb:invalid_field');
});

'use strict';
// The sync engine end to end against the reviewed migration on a throwaway PostgreSQL 16
// (tests/sync/harness.js). RPC rules are the real database's; Better Auth and the HTTP layer
// are test stand-ins, so nothing here proves anything about a real Neon project, TLS or
// Windows. Skipped when PostgreSQL 16 is not installed (set PG_BIN).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SyncEngine } = require('../electron/sync/engine');
const { Pg, FakeServer, fakeSafeStorage, faultyFs, tmpDir } = require('./sync/harness');
const S = require('../renderer/schedule-logic');
const fixtures = require('./fixtures/schedule-ocr.json');

const pg = Pg.available() ? new Pg() : null;
test.after(() => pg && pg.stop());
const opts = { skip: pg ? false : 'PostgreSQL 16 not found (set PG_BIN)' };

// Everything printed while the engine runs, to prove no token or password is logged.
const printed = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[k];
  console[k] = (...a) => { printed.push(a.map(String).join(' ')); orig.apply(console, a); };
}

function world() {
  const server = new FakeServer(pg, pg.database());
  server.addUser('op1@t.invalid', 'operator', 'Op One');
  server.addUser('op2@t.invalid', 'operator', 'Op Two');
  server.addUser('admin@t.invalid', 'admin', 'Lead');
  return server;
}

async function device(server, email, { dir = tmpDir(), ss = fakeSafeStorage(), fs: f, legacyDir } = {}) {
  const e = new SyncEngine({ dir, fetch: server.fetch, safeStorage: ss, fs: f, autoSync: false, now: () => server.clock.now, legacyDir });
  e.setConfig(server.config);
  if (email) { await e.signIn(email, server.users.get(email).password); await e.syncNow(); }
  Object.assign(e, { _dir: dir, _ss: ss });
  return e;
}
/** A new engine on the same disk and OS key store: the app after a restart or crash. */
function restart(server, e) {
  const n = new SyncEngine({ dir: e._dir, fetch: server.fetch, safeStorage: e._ss, autoSync: false, now: () => server.clock.now });
  n.init();
  return Object.assign(n, { _dir: e._dir, _ss: e._ss });
}

const row = (extra = {}) => ({ key: undefined, uid: crypto.randomUUID(), include: true, date: '2026-11-08', start: null, end: null, hint: 'M', type: 'Formal',
  activity: 'Satsang', place: 'Hall', city: 'Pune', topic: 'Morning', events: ['Shibir'], languages: ['Gujarati'], author: 'DD', format: 'HD',
  duration: '', clips: '', cameras: '', folder: null, session: null, camPlan: null, backedUp: null, title: 'T', subtitle: '', placeText: '', source: 'row', flags: {}, ...extra });
const schedule = (rows = [row(), row({ topic: 'Evening', hint: 'E' })]) => ({ id: crypto.randomUUID(), file: '/Users/op/Desktop/poster.png', created: '2026-11-07T10:00:00.000Z',
  rows: [['Pune shibir'], ['8 Nov', 'Morning']], read: { skipped: [] }, sessions: rows.map((r, i) => ({ ...r, key: i + 1 })),
  starts: { formal: 3058, informal: 2620 }, defaults: { author: 'DD', format: 'HD', camsFormal: 3, camsInformal: 1 }, scan: null, saved: null });

/** The renderer's loop: take the view, change it, commit it against that same view. */
function edit(e, fn, { busy, view } = {}) {
  const v = view || e.view();
  fn(v.data);
  return e.commit({ baseRev: v.rev, snapshot: v.data, busy });
}
const item = (v, id) => (v.data || v).schedules.items.find((x) => x.id === id);
const rowOf = (v, id, uid) => item(v, id).sessions.find((r) => r.uid === uid);
const applies = (server) => server.requests.filter((r) => r.path.endsWith('/rpc/avb_sync_apply')).map((r) => JSON.parse(r.raw).p_request);
async function serverRow(e, uid) {
  const h = await e._call('avb_target_history', { protocol_version: 1, type: 'session', key: uid, limit: 100 });
  return h.items;
}

test('sign-in: role from avb_me, tokens only encrypted on disk, nothing secret returned or printed', opts, async () => {
  const server = world();
  const e = await device(server, 'admin@t.invalid');
  const st = e.status();
  assert.equal(st.user.role, 'admin');
  assert.equal(st.phase, 'online');
  edit(e, (d) => d.schedules.items.push(schedule()));
  await e.syncNow();
  const secrets = [...server.access.keys(), ...server.refresh.keys(), server.users.get('admin@t.invalid').password];
  const shown = JSON.stringify([e.status(), e.view(), e.conflicts(), e.reviews(), e.publicConfig()]);
  const disk = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .map((f) => fs.readFileSync(path.join(dir, f)).toString('latin1')).join('\n');
  const all = disk(e._dir);
  for (const s of secrets) {
    assert.ok(!shown.includes(s), 'returned to the renderer');
    assert.ok(!all.includes(s), 'on disk in plain text');
    assert.ok(!printed.join('\n').includes(s), 'printed');
  }
  assert.ok(!all.includes('Morning') && !all.includes('Pune shibir'), 'cache content is encrypted');
  await assert.rejects(e.signIn('op1@t.invalid', 'x'), (x) => x.code === 'signed_in');
  const wrong = await device(server, null);
  await assert.rejects(wrong.signIn('op1@t.invalid', 'nope'), (x) => x.code === 'invalid_credentials' && !x.message.includes('nope'));
  // Sign-up is open on Neon: an account the maintainer never added gets nothing.
  const outsider = server.addUser('nobody@t.invalid', null, '');
  await assert.rejects(wrong.signIn(outsider.email, outsider.password), (x) => x.kind === 'revoked');
  assert.equal(wrong.status().signedIn, false);
  const noOs = new SyncEngine({ dir: tmpDir(), fetch: server.fetch, safeStorage: fakeSafeStorage({ available: false }), autoSync: false });
  noOs.setConfig(server.config);
  await assert.rejects(noOs.signIn('op1@t.invalid', server.users.get('op1@t.invalid').password), (x) => x.code === 'no_os_encryption');
});

test('a new account (open sign-up) gets nothing until the maintainer adds it by id and e-mail', opts, async () => {
  const server = world();
  const e = await device(server, null);
  const made = await e.signUp('newcomer@t.invalid', 'long-enough-pw', 'New Comer');
  assert.equal(made.email, 'newcomer@t.invalid');
  assert.equal(e.status().signedIn, false, 'creating an account does not sign in');
  assert.equal([...server.refresh.values()].filter((x) => x.sub === server.users.get('newcomer@t.invalid').id).length, 0, 'its session was ended');
  await assert.rejects(e.signIn('newcomer@t.invalid', 'long-enough-pw'), (x) => x.kind === 'revoked');
  assert.equal(e.status().signedIn, false);
  await assert.rejects(e.signUp('x@t.invalid', 'short', 'X'), (x) => x.code === 'bad_login');
  server.setMember('newcomer@t.invalid', 'operator', true);
  await e.signIn('newcomer@t.invalid', 'long-enough-pw');
  await e.syncNow();
  assert.equal(e.status().phase, 'online');
  assert.equal(e.status().user.role, 'operator');
});

test('config refuses plain HTTP to another machine and odd addresses, and cannot change while signed in', opts, async () => {
  const server = world();
  const e = await device(server, null);
  assert.throws(() => e.setConfig({ ...server.config, authUrl: 'http://office-pc/neondb/auth' }), (x) => x.code === 'bad_url');
  assert.throws(() => e.setConfig({ ...server.config, dataUrl: 'https://user:pw@x.test/neondb/rest/v1' }), (x) => x.code === 'bad_url');
  assert.throws(() => e.setConfig({ ...server.config, dataUrl: `${server.dataUrl}?schema=avb_private` }), (x) => x.code === 'bad_url');
  assert.throws(() => e.setConfig({ enabled: true, authUrl: '', dataUrl: server.dataUrl }), (x) => x.code === 'bad_url');
  await e.signIn('op1@t.invalid', server.users.get('op1@t.invalid').password);
  assert.throws(() => e.setConfig({ enabled: false }), (x) => x.code === 'signed_in');
});

test('two devices editing different rows both win and converge', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const b = await device(server, 'op2@t.invalid');
  const s = schedule();
  const [r1, r2] = s.sessions.map((r) => r.uid);
  edit(a, (d) => d.schedules.items.push(s));
  await a.syncNow();
  await b.syncNow();
  assert.equal(item(b.view(), s.id).sessions.length, 2);
  edit(a, (d) => { rowOf({ data: d }, s.id, r1).topic = 'A edit'; });
  edit(b, (d) => { rowOf({ data: d }, s.id, r2).topic = 'B edit'; });
  await a.syncNow(); await b.syncNow(); await a.syncNow();
  for (const e of [a, b]) {
    const v = e.view();
    assert.equal(rowOf(v, s.id, r1).topic, 'A edit');
    assert.equal(rowOf(v, s.id, r2).topic, 'B edit');
    assert.equal(e.status().conflicts, 0);
  }
});

test('a stale snapshot never deletes rows or schedules it did not show; busy schedules are skipped', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const b = await device(server, 'op2@t.invalid');
  const s = schedule();
  edit(a, (d) => d.schedules.items.push(s));
  await a.syncNow(); await b.syncNow();
  const old = a.view();                                   // what A's screen shows
  const extra = row({ topic: 'Added by B' });
  const s2 = schedule();
  edit(b, (d) => { item({ data: d }, s.id).sessions.push({ ...extra, key: 99 }); d.schedules.items.push(s2); });
  await b.syncNow();
  await a.syncNow();
  assert.equal(a.status().remoteWaiting, true);
  // A's screen still has the old view: an edit there must not delete B's row or schedule.
  const r = a.commit({ baseRev: old.rev, snapshot: (() => { const d = structuredClone(old.data); item({ data: d }, s.id).sessions[0].topic = 'A'; return d; })() });
  assert.equal(r.changed, 1);
  // Left out while still being read (busy), or left out at all: never taken for deleted.
  const v = a.view();
  const without = structuredClone(v.data);
  without.schedules.items = without.schedules.items.filter((x) => x.id !== s.id);
  assert.equal(a.commit({ baseRev: v.rev, snapshot: without, busy: [s.id] }).changed, 0);
  assert.equal(a.commit({ baseRev: v.rev, snapshot: without }).changed, 0);
  await a.syncNow(); await b.syncNow();
  for (const e of [a, b]) {
    const now = e.view();
    assert.ok(rowOf(now, s.id, extra.uid), 'B\'s row survives');
    assert.ok(item(now, s2.id), 'B\'s schedule survives');
    assert.equal(item(now, s.id).sessions[0].topic, 'A');
  }
});

test('offline edits of one row go as one change on the version shown, never on a newer remote head', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const b = await device(server, 'op2@t.invalid');
  const s = schedule();
  const uid = s.sessions[0].uid;
  edit(a, (d) => d.schedules.items.push(s));
  await a.syncNow(); await b.syncNow();
  const shownHead = a.acct.data.server[`session/${uid}`].head;
  server.offline = true;
  await a.syncNow();
  assert.equal(a.status().phase, 'offline');
  edit(a, (d) => { rowOf({ data: d }, s.id, uid).topic = 'x1'; });
  edit(a, (d) => { rowOf({ data: d }, s.id, uid).topic = 'x2'; });
  assert.equal(rowOf(a.view(), s.id, uid).topic, 'x2');
  server.offline = false;
  edit(b, (d) => { rowOf({ data: d }, s.id, uid).topic = 'b'; });
  await b.syncNow();
  const before = applies(server).length;
  await a.syncNow();                                       // pulls B's head first, then uploads
  const sent = applies(server).slice(before).flatMap((m) => m.operations).filter((o) => o.key === uid);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].base_version_id, shownHead, 'based on what was shown, not on B\'s newer head');
  assert.equal(sent[0].payload.topic, 'x2');
  const c = a.conflicts().find((x) => x.targetKey === uid);
  assert.equal(c.kind, 'stale_edit');
  assert.equal(c.current.payload.topic, 'b');
  assert.equal(c.draft.value.topic, 'x2');
  assert.equal(rowOf(a.view(), s.id, uid).topic, 'x2', 'the local edit stays on screen');
  await b.syncNow();
  assert.equal(rowOf(b.view(), s.id, uid).topic, 'b', 'B\'s value is not overwritten');
  // An ordinary edit does not close the conflict or send anything for that row.
  edit(a, (d) => { rowOf({ data: d }, s.id, uid).topic = 'x3'; });
  const n = applies(server).length;
  await a.syncNow();
  assert.equal(applies(server).slice(n).flatMap((m) => m.operations).filter((o) => o.key === uid).length, 0);
  assert.equal(a.status().held, 1);
  // Accept the version that was sent: the newer draft (x3) then goes on the resolved head.
  await a.resolve({ conflictId: c.conflictId, choice: 'accept_incoming', expectedHead: c.expectedHead });
  await a.syncNow(); await b.syncNow();
  assert.equal(rowOf(b.view(), s.id, uid).topic, 'x3');
  assert.equal(a.status().conflicts, 0);
  assert.equal(a.status().held + a.status().pending, 0);
});

test('conflict choices: mine sends the latest draft; keeping theirs drops it, and a stale screen edit conflicts again', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const b = await device(server, 'op2@t.invalid');
  const s = schedule();
  const [u1, u2] = s.sessions.map((r) => r.uid);
  edit(a, (d) => d.schedules.items.push(s));
  await a.syncNow(); await b.syncNow();
  server.offline = true;
  const v1 = a.view();
  const after = edit(a, (d) => { rowOf({ data: d }, s.id, u1).topic = 'mine-1'; rowOf({ data: d }, s.id, u2).topic = 'mine-2'; }, { view: v1 });
  server.offline = false;
  edit(b, (d) => { rowOf({ data: d }, s.id, u1).topic = 'theirs-1'; rowOf({ data: d }, s.id, u2).topic = 'theirs-2'; });
  await b.syncNow();
  await a.syncNow();
  const c1 = a.conflicts().find((x) => x.targetKey === u1);
  const c2 = a.conflicts().find((x) => x.targetKey === u2);
  await assert.rejects(a.resolve({ conflictId: c1.conflictId, choice: 'mine', expectedHead: 'not-what-was-shown' }), (x) => x.code === 'stale_resolution');
  await a.resolve({ conflictId: c1.conflictId, choice: 'mine', expectedHead: c1.expectedHead });
  await a.resolve({ conflictId: c2.conflictId, choice: 'keep_current', expectedHead: c2.expectedHead });
  await b.syncNow();
  assert.equal(rowOf(b.view(), s.id, u1).topic, 'mine-1');
  assert.equal(rowOf(b.view(), s.id, u2).topic, 'theirs-2');
  // A's screen was never refreshed and still shows mine-2. Editing there must not silently overwrite theirs-2.
  const stale = structuredClone(v1.data);
  rowOf({ data: stale }, s.id, u1).topic = 'mine-1';
  rowOf({ data: stale }, s.id, u2).topic = 'mine-2 and more';
  a.commit({ baseRev: after.rev, snapshot: stale });
  await a.syncNow();
  const again = a.conflicts().find((x) => x.targetKey === u2);
  assert.ok(again, 'a further edit of the dropped value conflicts');
  await b.syncNow();
  assert.equal(rowOf(b.view(), s.id, u2).topic, 'theirs-2');
  assert.equal(rowOf(b.view(), s.id, u1).topic, 'mine-1', 'the converged row is not re-sent as a conflict');
  assert.equal(a.conflicts().filter((x) => x.targetKey === u1).length, 0);
});

test('resolving someone else\'s conflict on a row never rebases this device\'s own unsent edit of it', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const b = await device(server, 'op2@t.invalid');
  const s = schedule();
  const uid = s.sessions[0].uid;
  edit(a, (d) => d.schedules.items.push(s));
  await a.syncNow(); await b.syncNow();
  server.offline = true;
  edit(b, (d) => { rowOf({ data: d }, s.id, uid).topic = 'b-stale'; });
  server.offline = false;
  edit(a, (d) => { rowOf({ data: d }, s.id, uid).topic = 'a1'; });
  await a.syncNow();
  await b.syncNow();                                       // B's edit becomes a conflict on A's head
  await a.syncNow();
  const c = a.conflicts().find((x) => x.targetKey === uid);
  assert.equal(c.incoming.payload.topic, 'b-stale');
  assert.equal(c.draft, null, 'not this device\'s conflict');
  edit(a, (d) => { rowOf({ data: d }, s.id, uid).topic = 'a2'; });   // A edits on, based on a1
  await a.resolve({ conflictId: c.conflictId, choice: 'accept_incoming', expectedHead: c.expectedHead });
  await a.syncNow(); await b.syncNow();
  assert.equal(rowOf(b.view(), s.id, uid).topic, 'b-stale', 'the accepted value is not overwritten by an edit made before it');
  const mine = a.conflicts().find((x) => x.targetKey === uid);
  assert.equal(mine.kind, 'stale_edit');
  assert.equal(mine.draft.value.topic, 'a2');
});

test('a lost answer or a crash resends the identical request, and the server applies it once', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const s = schedule();
  const uid = s.sessions[0].uid;
  edit(a, (d) => d.schedules.items.push(s));
  await a.syncNow();
  edit(a, (d) => { rowOf({ data: d }, s.id, uid).topic = 'once'; });
  server.loseNextApply = true;                             // applied on the server, answer lost
  await a.syncNow();
  assert.equal(a.status().phase, 'offline');
  const body = a.acct.data.queue[0].body;
  const crashed = restart(server, a);                     // the app dies and starts again
  assert.equal(crashed.acct.data.queue[0].body, body);
  const n = server.requests.length;
  await crashed.syncNow();
  const resent = server.requests.slice(n).filter((r) => r.path.endsWith('/rpc/avb_sync_apply'));
  assert.equal(resent[0].raw, body, 'byte-for-byte the same request');
  assert.equal(crashed.acct.data.queue.length, 0);
  assert.equal(crashed.status().pending, 0);
  const versions = (await serverRow(crashed, uid)).filter((x) => x.accepted);
  assert.equal(versions.length, 2, 'create + one update, not two');
  assert.equal(versions[0].payload.topic, 'once');
});

test('a replayed answer older than what was pulled never overwrites the newer state', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const b = await device(server, 'op2@t.invalid');
  const s = schedule();
  const uid = s.sessions[0].uid;
  edit(a, (d) => d.schedules.items.push(s));
  await a.syncNow();
  await b.syncNow();
  edit(a, (d) => { rowOf({ data: d }, s.id, uid).topic = 'mine'; });
  server.loseNextApply = true;                             // applied on the server, answer lost
  await a.syncNow();
  await b.syncNow();
  edit(b, (d) => { rowOf({ data: d }, s.id, uid).topic = 'theirs, after mine'; });
  await b.syncNow();
  // a pulls (seeing b's edit), then resends: the server answers with the stored, older result.
  await a.syncNow();
  assert.equal(a.acct.data.queue.length, 0);
  assert.equal(rowOf(a.view(), s.id, uid).topic, 'theirs, after mine', 'the newer pulled value stays');
  assert.equal(a.status().pending, 0, 'no leftover draft to resend');
  assert.equal(a.status().conflicts, 0, 'no spurious conflict');
  edit(a, (d) => { rowOf({ data: d }, s.id, uid).topic = 'a again'; });
  await a.syncNow();
  assert.equal(a.status().conflicts, 0, 'a later edit is based on the real head');
  await b.syncNow();
  assert.equal(rowOf(b.view(), s.id, uid).topic, 'a again');
});

test('a session replaced while an upload is in flight keeps that upload queued, never refused', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const s = schedule();
  const uid = s.sessions[0].uid;
  edit(a, (d) => d.schedules.items.push(s));
  await a.syncNow();
  edit(a, (d) => { rowOf({ data: d }, s.id, uid).topic = 'in flight'; });
  const real = a.fetchImpl;
  a.fetchImpl = async (url, init) => {
    const res = await real(url, init);
    if (String(url).includes('avb_sync_apply')) a.gen += 1;   // e.g. a re-sign-in landed meanwhile
    return res;
  };
  await a.syncNow();
  a.fetchImpl = real;
  assert.equal(a.acct.data.queue.length, 1, 'still queued for an exact resend');
  assert.equal(a.status().failed.length, 0, 'not marked as refused');
  await a.syncNow();
  assert.equal(a.acct.data.queue.length, 0);
  assert.equal(a.status().pending, 0);
  const versions = (await serverRow(a, uid)).filter((x) => x.accepted);
  assert.equal(versions.length, 2, 'applied once');
  assert.equal(versions[0].payload.topic, 'in flight');
});

test('a disk that refuses a write loses nothing and sends nothing unsaved', opts, async () => {
  const server = world();
  const ffs = faultyFs();
  const a = await device(server, 'op1@t.invalid', { fs: ffs });
  const s = schedule();
  const v = a.view();
  const snap = structuredClone(v.data);
  snap.schedules.items.push(s);
  ffs.fail = true;
  assert.throws(() => a.commit({ baseRev: v.rev, snapshot: snap }), (x) => x.code === 'write_failed');
  assert.equal(Object.keys(a.acct.data.local).length, 0, 'nothing half-applied in memory');
  ffs.fail = false;
  assert.equal(a.commit({ baseRev: v.rev, snapshot: snap }).ok, true);
  ffs.fail = true;
  const n = applies(server).length;
  await a.syncNow();
  assert.equal(applies(server).length, n, 'not sent when the request could not be saved first');
  assert.equal(a.status().phase, 'error');
  ffs.fail = false;
  await a.syncNow();
  assert.equal(a.status().pending, 0);
  assert.ok(item(a.view(), s.id).sessions.length === 2);
});

test('whole-schedule delete: operators refused, admins need the revision they reviewed', opts, async () => {
  const server = world();
  const op = await device(server, 'op1@t.invalid');
  const op2 = await device(server, 'op2@t.invalid');
  const admin = await device(server, 'admin@t.invalid');
  const s = schedule();
  edit(op, (d) => d.schedules.items.push(s));
  await op.syncNow(); await admin.syncNow(); await op2.syncNow();
  const opView = op.view();
  await assert.rejects(op.deleteAssignment({ id: s.id, rev: opView.rev }), (x) => x.code === 'admin_required');
  // Even sent straight to the server, bypassing the app's own check:
  await assert.rejects(op._sendNow([{ op: 'delete_assignment', assignment_key: s.id, expected_aggregate_rev: item(opView, s.id).sync.aggregateRev }], { kind: 'admin', ids: [`assignment/${s.id}`] }),
    (x) => x.code === 'admin_required');
  const reviewed = admin.view();
  // Someone adds a row after the admin reviewed: the delete must not happen.
  const late = row({ topic: 'Late row' });
  edit(op2, (d) => item({ data: d }, s.id).sessions.push({ ...late, key: 50 }));
  await op2.syncNow();
  await admin.syncNow();
  const stale = await admin.deleteAssignment({ id: s.id, rev: reviewed.rev });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.ok(item(admin.view(), s.id), 'still there');
  const sc = admin.conflicts().find((c) => c.kind === 'assignment_delete_stale');
  assert.ok(sc);
  await admin.resolve({ conflictId: sc.conflictId, choice: 'keep_current', expectedHead: sc.expectedHead });
  // op (offline since its last pull) edits a row of the schedule about to be deleted.
  await admin.syncNow();
  const r = await admin.deleteAssignment({ id: s.id, rev: admin.view().rev });
  assert.equal(r.ok, true);
  assert.ok(!item(admin.view(), s.id));
  assert.ok(admin.view().data.deleted.some((x) => x.id === s.id));
  edit(op, (d) => { rowOf({ data: d }, s.id, s.sessions[0].uid).topic = 'edited after delete'; }, { view: opView });
  await op.syncNow();
  const pd = op.conflicts().find((c) => c.kind === 'parent_deleted');
  assert.ok(pd, 'kept as a parent_deleted conflict');
  assert.equal(op.status().held, 1, 'the draft is kept on the device');
  await op2.syncNow();
  assert.ok(!item(op2.view(), s.id), 'the schedule stays deleted for everyone');
  // Restore brings every row back; the stale edit still waits for a person.
  const staleDel = admin.view().data.deleted.find((x) => x.id === s.id);
  await admin.syncNow();                                   // op's late edit raised the revision
  assert.equal((await admin.restoreAssignment({ id: s.id, rev: staleDel.aggregateRev })).stale, true);
  const del = admin.view().data.deleted.find((x) => x.id === s.id);
  assert.equal((await admin.restoreAssignment({ id: s.id, rev: del.aggregateRev })).ok, true);
  await op.syncNow(); await op2.syncNow();
  assert.equal(item(op2.view(), s.id).sessions.length, 3);
  const pd2 = op.conflicts().find((c) => c.kind === 'parent_deleted');
  await op.resolve({ conflictId: pd2.conflictId, choice: 'mine', expectedHead: pd2.expectedHead });
  await op2.syncNow();
  assert.equal(rowOf(op2.view(), s.id, s.sessions[0].uid).topic, 'edited after delete');
});

test('a protected backup row: identity fixed, completion still saved, and a remote delete becomes a conflict', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const b = await device(server, 'op2@t.invalid');
  const s = schedule();
  const uid = s.sessions[0].uid;
  edit(a, (d) => d.schedules.items.push(s));
  await a.syncNow(); await b.syncNow();
  a.protect({ assignmentId: s.id, uid });
  const atStart = a.view();
  assert.throws(() => edit(a, (d) => { item({ data: d }, s.id).sessions.shift(); }), (x) => x.code === 'protected');
  assert.throws(() => edit(a, (d) => { rowOf({ data: d }, s.id, uid).date = '2026-11-09'; }), (x) => x.code === 'protected');
  assert.throws(() => edit(a, (d) => { rowOf({ data: d }, s.id, uid).folder = 9999; }), (x) => x.code === 'protected');
  // Meanwhile B deletes that row; A pulls it but its screen keeps the start-time view.
  edit(b, (d) => { item({ data: d }, s.id).sessions = item({ data: d }, s.id).sessions.filter((r) => r.uid !== uid); });
  await b.syncNow(); await a.syncNow();
  const done = structuredClone(atStart.data);
  Object.assign(rowOf({ data: done }, s.id, uid), { duration: '1h 2m', clips: 12, cameras: 3, backedUp: '2026-11-08T12:00:00.000Z' });
  assert.equal(a.commit({ baseRev: atStart.rev, snapshot: done }).ok, true);
  await a.syncNow();
  const c = a.conflicts().find((x) => x.targetKey === uid);
  assert.equal(c.kind, 'edit_vs_delete');
  assert.equal(c.draft.value.backedUp, '2026-11-08T12:00:00.000Z');
  assert.equal(rowOf(a.view(), s.id, uid).clips, 12, 'the completed row stays on this device');
  await b.syncNow();
  assert.ok(!rowOf(b.view(), s.id, uid), 'not silently resurrected');
  a.protect(null);
  assert.equal(a.status().protected, false);
  a.protect({ assignmentId: s.id, uid });
  await assert.rejects(a.signOut(), (x) => x.code === 'busy');
  await assert.rejects(a.signIn('op2@t.invalid', 'x'), (x) => x.code === 'busy');
  a.protect(null);
});

test('revocation locks the cache and holds the queue until the server accepts the person again', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const s = schedule();
  edit(a, (d) => d.schedules.items.push(s));
  await a.syncNow();
  server.setMember('op1@t.invalid', 'operator', false);
  edit(a, (d) => { item({ data: d }, s.id).sessions[0].topic = 'while revoked'; });
  await a.syncNow();
  assert.equal(a.status().phase, 'revoked');
  assert.equal(a.view().locked, true);
  assert.equal(a.view().data, undefined, 'no cached data shown');
  assert.deepEqual(a.conflicts(), []);
  assert.equal(a.status().pending, 1, 'held, not dropped');
  const n = applies(server).length;
  await a.syncNow();
  assert.equal(applies(server).length, n, 'nothing uploaded while revoked');
  const restarted = restart(server, a);
  assert.equal(restarted.status().phase, 'revoked', 'stays locked after a restart, offline');
  assert.equal(restarted.view().locked, true);
  server.setMember('op1@t.invalid', 'operator', true);
  await restarted.syncNow();
  assert.equal(restarted.status().phase, 'online');
  assert.equal(restarted.status().pending, 0);
  assert.equal(item(restarted.view(), s.id).sessions[0].topic, 'while revoked');
});

test('tokens: refresh on 401, expired sign-in keeps the cache, offline keeps working, sign-out isolates accounts', opts, async () => {
  const server = world();
  const dir = tmpDir(), ss = fakeSafeStorage();
  const a = await device(server, 'op1@t.invalid', { dir, ss });
  const s = schedule();
  edit(a, (d) => d.schedules.items.push(s));
  server.access.clear();                                   // access token no longer valid; refresh token is
  await a.syncNow();
  assert.equal(a.status().phase, 'online');
  assert.equal(a.status().pending, 0);
  server.offline = true;
  edit(a, (d) => { item({ data: d }, s.id).sessions[0].topic = 'offline edit'; });
  await a.syncNow();
  assert.equal(a.status().phase, 'offline');
  server.offline = false;
  server.access.clear(); server.refresh.clear();           // signed out elsewhere: refresh fails
  await a.syncNow();
  assert.equal(a.status().phase, 'expired');
  assert.equal(a.status().pending, 1);
  assert.equal(item(a.view(), s.id).sessions[0].topic, 'offline edit', 'the cache still works');
  await a.signIn('op1@t.invalid', server.users.get('op1@t.invalid').password);
  await a.syncNow();
  assert.equal(a.status().pending, 0);
  // An unsent change, then sign-out: it stays with this account, not with the next person.
  server.offline = true;
  const secret = schedule([row({ topic: 'Only op1 has this' })]);
  edit(a, (d) => d.schedules.items.push(secret));
  const out = await a.signOut();
  server.offline = false;
  assert.ok(out.pendingKept > 0);
  assert.equal(a.view().signedIn, false);
  assert.equal(a.status().user, null);
  const b = new SyncEngine({ dir, fetch: server.fetch, safeStorage: ss, autoSync: false, now: () => server.clock.now });
  await b.signIn('op2@t.invalid', server.users.get('op2@t.invalid').password);
  await b.syncNow();
  assert.ok(!item(b.view(), secret.id), 'the next person never sees the previous account\'s unsent data');
  assert.ok(item(b.view(), s.id), 'team data that was uploaded is there');
  await b.signOut();
  // A cache file moved into another account's folder does not open.
  const folder = (email) => path.join(dir, 'accounts', crypto.createHash('sha256').update(`${server.authUrl} ${server.dataUrl}\n${server.users.get(email).id}`).digest('hex').slice(0, 32));
  const fa = folder('op1@t.invalid'), fb = folder('op2@t.invalid');
  const aCache = fs.readFileSync(path.join(fa, 'cache.bin'));
  const bCache = fs.readFileSync(path.join(fb, 'cache.bin'));
  fs.copyFileSync(path.join(fa, 'cache.bin'), path.join(fb, 'cache.bin'));
  fs.copyFileSync(path.join(fa, 'key.bin'), path.join(fb, 'key.bin'));
  const c = new SyncEngine({ dir, fetch: server.fetch, safeStorage: ss, autoSync: false, now: () => server.clock.now });
  await assert.rejects(c.signIn('op2@t.invalid', server.users.get('op2@t.invalid').password), (x) => x.code === 'tampered');
  assert.equal(c.status().signedIn, false);
  assert.equal(fs.existsSync(path.join(dir, 'accounts', 'session.bin')), false, 'no session kept for a refused cache');
  fs.writeFileSync(path.join(fb, 'cache.bin'), bCache);
  // The original owner signs in again and the unsent change goes up under that owner.
  assert.ok(fs.readFileSync(path.join(fa, 'cache.bin')).equals(aCache));
  const back = new SyncEngine({ dir, fetch: server.fetch, safeStorage: ss, autoSync: false, now: () => server.clock.now });
  await back.signIn('op1@t.invalid', server.users.get('op1@t.invalid').password);
  await back.syncNow();
  assert.equal(back.status().pending, 0);
  const seen = new SyncEngine({ dir: tmpDir(), fetch: server.fetch, safeStorage: fakeSafeStorage(), autoSync: false, now: () => server.clock.now });
  seen.setConfig(server.config);
  await seen.signIn('op2@t.invalid', server.users.get('op2@t.invalid').password);
  await seen.syncNow();
  assert.ok(item(seen.view(), secret.id), 'uploaded by its owner after signing in again');
});

test('what was read, geo, startedAt, cities, report and learned memory arrive intact on another device', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const b = await device(server, 'op2@t.invalid');
  const fx = fixtures['oct-14-to-nov-5-2026'];
  const read = S.readRows(fx.rows, { today: '2026-11-07' });
  const sessions = S.draftSessions(read, {}, { author: 'DD', format: 'HD' }).map((r, i) => ({ ...r, key: i + 1, uid: crypto.randomUUID() }));
  sessions[0].city = 'Rampur'; sessions[0].geo = 'Rampur (MH)';
  sessions[1].city = 'Rampur'; sessions[1].geo = 'Rampur (GJ)';
  sessions[1].startedAt = '2026-11-07T10:15:00.000Z';
  Object.assign(sessions[2], { backedUp: '2026-11-07T12:00:00.000Z', duration: '1h 5m 2s', clips: 14, cameras: 3 });
  const s = { ...schedule(), rows: fx.rows, read: { skipped: read.skipped }, sessions };
  const cities = [{ name: 'Rampur (GJ)', city: 'Rampur', state: 'Gujarat', country: 'India' }, { name: 'Rampur (MH)', city: 'Rampur', state: 'Maharashtra', country: 'India' }];
  const report = [{ id: 'DD-F-HD-2400-M', folder: 2400, format: 'HD', session: 'M', author: 'DD', type: 'Formal', date: '2026-10-01', duration: '50m', activity: 'Satsang',
    place: 'Hall', topic: 'Old one', clips: '3', cameras: '2', events: ['Shibir'], languages: ['Gujarati'], city: 'Pune', state: 'Maharashtra', country: 'India', source: 'existing' }];
  edit(a, (d) => {
    d.schedules.items.push(s);
    d.cities = cities;
    d.report = report;
    d.team = { defaults: { author: 'DD', format: 'HD', camsFormal: 3, camsInformal: 1 }, starts: { formal: 3058, informal: 2620 },
      memory: { titles: [{ key: 'Shibir day 1', topic: 'Day 1' }, { key: 'Older title', topic: 'Older' }], places: [{ key: 'Hall A', place: 'Hall', city: 'Pune', languages: [] }] } };
  });
  await a.syncNow(); await b.syncNow();
  const v = b.view().data;
  const got = item(v, s.id);
  assert.deepEqual(got.rows, fx.rows);
  assert.deepEqual(got.read.skipped, read.skipped);
  assert.equal(got.file, '', 'the local path stays on the device that had it');
  assert.equal(got.sourceBasename, 'poster.png');
  const strip = (r) => { const { key, uid, orderKey, ...rest } = r; void key; void orderKey; return { uid, ...rest }; };
  assert.deepEqual(got.sessions.map(strip), sessions.map(strip));
  assert.deepEqual(v.cities.sort((x, y) => x.name.localeCompare(y.name)), cities);
  assert.equal(S.cityOf(got.sessions[0], v.cities).state, 'Maharashtra');
  assert.deepEqual(S.sheetRows(got.sessions, got.starts, v.cities), S.sheetRows(sessions, s.starts, cities));
  assert.deepEqual(v.report, report);
  assert.deepEqual(v.team.starts, { formal: 3058, informal: 2620 });
  assert.deepEqual(v.team.memory.places, [{ key: 'Hall A', place: 'Hall', city: 'Pune', languages: [] }]);
  // Learned order: the one changed last comes first on the other device.
  server.clock.now += 1000;
  edit(a, (d) => { d.team.memory.titles.find((t) => t.key === 'Older title').topic = 'Older, corrected'; });
  await a.syncNow(); await b.syncNow();
  assert.equal(b.view().data.team.memory.titles[0].key, 'Older title');
  // Bounds: a value the server would refuse is never queued, and the snapshot is kept.
  const big = edit(a, (d) => { item({ data: d }, s.id).sessions[0].topic = 'x'.repeat(1001); });
  assert.equal(big.ok, false);
  assert.equal(big.problems[0].field, 'session.topic');
  assert.equal(a.status().rejected.problems[0].code, 'invalid_field');
  assert.equal(a.acct.data.rejected.snapshot.schedules.items.find((x) => x.id === s.id).sessions[0].topic.length, 1001);
  assert.equal(a.status().pending, 0);
});

test('one-time import: opt-in, previewed, bounded, replay-safe, originals untouched, collisions kept as conflicts', opts, async () => {
  const server = world();
  const legacy = tmpDir();
  const old = schedule();
  const oldStore = { openId: 'sold1', items: [{ ...old, id: 'sold1', sessions: old.sessions.map(({ uid, ...r }) => (void uid, r)) },
    { ...schedule(), id: 'sold2', sessions: [{ ...row(), key: 1 }].map(({ uid, ...r }) => (void uid, r)) }] };
  fs.writeFileSync(path.join(legacy, 'schedules.json'), JSON.stringify(oldStore));
  fs.writeFileSync(path.join(legacy, 'cities.json'), JSON.stringify({ file: 'c.xlsx', rows: [['ID', 'City Name', 'State', 'Country'], ['Pune', 'Pune', 'Maharashtra', 'India']] }));
  fs.writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({ scheduleDefaults: { author: 'DD', format: 'HD' }, scheduleStarts: { formal: 10 },
    scheduleMemory: { titles: [{ key: 'K', topic: 'T' }], places: [] }, theme: 'dark', ffprobe: '/opt/ffprobe' }));
  const originals = ['schedules.json', 'cities.json', 'settings.json'].map((f) => fs.readFileSync(path.join(legacy, f)));
  const b = await device(server, 'op2@t.invalid');
  edit(b, (d) => { d.cities = [{ name: 'Pune', city: 'Pune', state: 'Other state', country: 'India' }]; });
  await b.syncNow();
  const a = await device(server, 'op1@t.invalid', { legacyDir: legacy });
  assert.equal(a.view().data.schedules.items.length, 0, 'nothing uploaded just by signing in');
  const preview = a.importLocal({ confirm: false });
  assert.equal(preview.preview, true);
  assert.equal(preview.counts.schedules, 2);
  assert.equal(a.status().pending, 0, 'a preview queues nothing');
  const done = a.importLocal({ confirm: true });
  assert.equal(done.ok, true);
  await a.syncNow();
  const v = a.view().data;
  assert.equal(v.schedules.items.length, 2);
  const ids = v.schedules.items.flatMap((x) => x.sessions.map((r) => r.uid));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(item(v, a.acct.data.importMap['a:sold1']).file.includes('poster.png'), 'path kept locally');
  assert.ok(!JSON.stringify(applies(server)).includes('/opt/ffprobe') && !JSON.stringify(applies(server)).includes('/Users/op'), 'no local paths or runtime settings uploaded');
  const again = a.importLocal({ confirm: true });
  assert.equal(again.counts.targets, 0, 'a second run sends nothing twice');
  ['schedules.json', 'cities.json', 'settings.json'].forEach((f, i) => assert.ok(fs.readFileSync(path.join(legacy, f)).equals(originals[i]), f));
  const backups = fs.readdirSync(path.join(a.acct.folder, 'import-backup'));
  assert.ok(backups.length >= 1 && fs.existsSync(path.join(a.acct.folder, 'import-backup', backups[0], 'schedules.json')));
  const coll = a.conflicts().find((c) => c.targetType === 'city' && c.targetKey === 'pune');
  assert.equal(coll.kind, 'create_collision', 'a different city record is kept as a conflict, not overwritten');
  // The same sheet imported again from another computer's data shows a duplicate warning.
  const legacy2 = tmpDir();
  fs.writeFileSync(path.join(legacy2, 'schedules.json'), JSON.stringify(oldStore));
  const c = await device(server, 'admin@t.invalid', { legacyDir: legacy2 });
  const dup = c.importLocal({ confirm: false });
  assert.ok(dup.warnings.some((w) => w.code === 'possible_duplicate'));
  // A value beyond the limits: nothing at all is queued, and the reason is given.
  const legacy3 = tmpDir();
  fs.writeFileSync(path.join(legacy3, 'schedules.json'), JSON.stringify({ items: [{ ...oldStore.items[0], sessions: [{ ...oldStore.items[0].sessions[0], topic: 'y'.repeat(1001) }] }] }));
  const d = await device(server, 'op1@t.invalid', { legacyDir: legacy3 });
  const refused = d.importLocal({ confirm: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.problems[0].field, 'session.topic');
  assert.equal(d.status().pending, 0);
});

test('the client\'s jsonb size estimate matches PostgreSQL\'s for real payloads', opts, () => {
  const { jsonbBytes } = require('../electron/sync/spec');
  const db = pg.database();
  const samples = [{ a: 1, b: [1, 2, 'x'], c: { d: 'é😀', e: null } }, row(), { cells: ['a "q" \\', '\n€', ''], line: 0, part: 0, continuesCell: false }];
  for (const p of samples) {
    const n = Number(pg.psql(db, `select octet_length($j$${JSON.stringify(p)}$j$::jsonb::text)`).trim());
    assert.equal(jsonbBytes(p), n, JSON.stringify(p).slice(0, 40));
  }
});

test('a locked (revoked) cache shows no review drafts or refused values either', opts, async () => {
  const server = world();
  const a = await device(server, 'op1@t.invalid');
  const s = schedule();
  edit(a, (d) => d.schedules.items.push(s));
  await a.syncNow();
  // A row id the server refuses (it is already a schedule's id): kept locally for review.
  edit(a, (d) => item({ data: d }, s.id).sessions.push({ ...row({ topic: 'Refused draft' }), uid: s.id, key: 77 }));
  await a.syncNow();
  assert.equal(a.reviews().length, 1);
  assert.equal(a.reviews()[0].value.topic, 'Refused draft');
  assert.equal(a.status().failed[0].code, 'uid_collision');
  server.setMember('op1@t.invalid', 'operator', false);
  await a.syncNow();
  assert.equal(a.status().phase, 'revoked');
  assert.deepEqual(a.reviews(), []);
  assert.deepEqual(a.status().failed, []);
  assert.ok(!JSON.stringify([a.status(), a.view(), a.conflicts(), a.reviews()]).includes('Refused draft'));
  a.protect({ assignmentId: s.id, uid: s.sessions[0].uid });   // an active backup may keep its schedule, not open the review list
  assert.deepEqual(a.reviews(), []);
  a.protect(null);
});

/** server.fetch, except the first request that `match`es waits until released. */
function holdOne(server, match) {
  let release, armed = true;
  const held = new Promise((r) => { release = r; });
  let reached;
  const arrived = new Promise((r) => { reached = r; });
  const fetch = async (url, init) => {
    if (armed && match(url, init)) { armed = false; reached(); await held; }
    return server.fetch(url, init);
  };
  return { fetch, release: () => release(), arrived };
}
const bareDevice = (server, fetch) => {
  const e = new SyncEngine({ dir: tmpDir(), fetch, safeStorage: fakeSafeStorage(), autoSync: false, now: () => server.clock.now });
  e.setConfig(server.config);
  return e;
};
const login = (e, server, email) => e.signIn(email, server.users.get(email).password);

test('an old account\'s refresh failing after sign-out and a new sign-in leaves the new session alone', opts, async () => {
  const server = world();
  let refreshing = false;   // sign-in fetches its JWT the same way; hold only the later refresh
  const gate = holdOne(server, (url) => refreshing && new URL(url).pathname.endsWith('/auth/token'));
  const e = bareDevice(server, gate.fetch);
  await login(e, server, 'op1@t.invalid');
  refreshing = true;
  server.access.clear();                                   // op1's next call needs a refresh, which waits
  const old = e.syncNow();
  await gate.arrived;
  server.refresh.clear();                                  // and will fail when it goes
  await e.signOut();
  await login(e, server, 'op2@t.invalid');
  const s = schedule();
  edit(e, (d) => d.schedules.items.push(s));
  const pendingBefore = e.status().pending;
  const draftBefore = structuredClone(e.view().data);
  assert.ok(pendingBefore > 0, 'op2 has unsent targets before the old request returns');
  gate.release();
  await old;
  assert.equal(e.session && e.session.userId, server.users.get('op2@t.invalid').id, 'op2 is still signed in');
  assert.equal(e.status().phase, 'online');
  assert.equal(e.status().user.displayName, 'Op Two');
  assert.equal(e.status().pending, pendingBefore, 'the old request leaves every pending target intact');
  assert.deepEqual(e.view().data, draftBefore, 'the new account\'s full draft is unchanged');
  const again = new SyncEngine({ dir: e.dir, fetch: server.fetch, safeStorage: e.safeStorage, autoSync: false, now: () => server.clock.now });
  again.init();
  assert.equal(again.acct && again.acct.userId, server.users.get('op2@t.invalid').id, 'op2\'s saved session survived on disk');
  await e.syncNow();
  assert.equal(e.status().pending, 0);
});

test('a not_member answer for the old account arriving after a new sign-in does not lock the new account', opts, async () => {
  const server = world();
  const op1 = server.users.get('op1@t.invalid').id;
  let tokenOf1 = null;
  const gate = holdOne(server, (url, init) => String(url).endsWith('/rpc/avb_me') && tokenOf1 && init.headers.Authorization === `Bearer ${tokenOf1}`);
  const e = bareDevice(server, gate.fetch);
  await login(e, server, 'op1@t.invalid');
  tokenOf1 = e.session.access_token;
  const old = e.syncNow();
  await gate.arrived;
  server.setMember('op1@t.invalid', 'operator', false);    // the held call will answer not_member
  await e.signOut();
  await login(e, server, 'op2@t.invalid');
  const s = schedule();
  edit(e, (d) => d.schedules.items.push(s));
  gate.release();
  await old;
  assert.notEqual(e.acct.userId, op1);
  assert.equal(e.acct.data.locked, false);
  assert.equal(e.status().phase, 'online');
  assert.equal(e.view().locked, undefined);
  assert.ok(item(e.view(), s.id));
  await e.syncNow();
  assert.equal(e.status().pending, 0);
  assert.equal(e.status().phase, 'online');
});

test('a late sign-out response cannot clear a newer account or its pending draft', opts, async () => {
  const server = world();
  const gate = holdOne(server, (url) => new URL(url).pathname.endsWith('/auth/sign-out'));
  const e = bareDevice(server, gate.fetch);
  await login(e, server, 'op1@t.invalid');
  const old = e.signOut();
  await gate.arrived;
  await e.signOut();
  await login(e, server, 'op2@t.invalid');
  const s = schedule();
  edit(e, (d) => d.schedules.items.push(s));
  const pendingBefore = e.status().pending;
  const draftBefore = structuredClone(e.view().data);
  gate.release();
  await old;
  assert.equal(e.session.userId, server.users.get('op2@t.invalid').id);
  assert.equal(e.sessions.load().userId, e.session.userId);
  assert.equal(e.status().phase, 'online');
  assert.equal(e.status().pending, pendingBefore);
  assert.deepEqual(e.view().data, draftBefore);
  await e.syncNow();
  assert.equal(e.status().pending, 0);
});

test('changing server configuration invalidates an unfinished sign-in to the previous server', opts, async () => {
  const server = world();
  const gate = holdOne(server, (url) => new URL(url).pathname.endsWith('/auth/sign-in/email'));
  const e = bareDevice(server, gate.fetch);
  const old = login(e, server, 'op1@t.invalid');
  await gate.arrived;
  e.setConfig({ enabled: true, authUrl: 'https://ep-other.neonauth.another-team.test/neondb/auth', dataUrl: 'https://ep-other.apirest.another-team.test/neondb/rest/v1' });
  gate.release();
  await assert.rejects(old, (x) => x.code === 'stale');
  assert.equal(e.session, null);
  assert.equal(e.acct, null);
  assert.equal(e.sessions.load(), null);
  assert.equal(e.publicConfig().authUrl, 'https://ep-other.neonauth.another-team.test/neondb/auth');
  assert.equal(server.requests.filter((r) => r.path.endsWith('/rpc/avb_me')).length, 0);
});

test('a damaged offline cache still requires sign-out before changing the session server', opts, async () => {
  const server = world();
  const original = await device(server, 'op1@t.invalid');
  fs.writeFileSync(path.join(original.acct.folder, 'cache.bin'), 'damaged');
  const e = restart(server, original);
  assert.equal(e.acct, null);
  assert.ok(e.session, 'the protected session was readable even though the cache was not');
  assert.throws(() => e.setConfig({ enabled: true, authUrl: 'https://ep-other.neonauth.another-team.test/neondb/auth', dataUrl: 'https://ep-other.apirest.another-team.test/neondb/rest/v1' }), (x) => x.code === 'signed_in');
  assert.equal(e.publicConfig().authUrl, server.authUrl);
  await e.signOut();
  e.setConfig({ enabled: true, authUrl: 'https://ep-other.neonauth.another-team.test/neondb/auth', dataUrl: 'https://ep-other.apirest.another-team.test/neondb/rest/v1' });
  assert.equal(e.session, null);
  assert.equal(e.sessions.load(), null);
});

test('an admin action whose queue save fails is rolled back and cannot be sent later', opts, async () => {
  const server = world();
  const e = await device(server, 'admin@t.invalid');
  const s = schedule();
  edit(e, (d) => d.schedules.items.push(s));
  await e.syncNow();
  const v = e.view();
  const before = structuredClone({ local: e.acct.data.local, queue: e.acct.data.queue });
  const writesBefore = applies(server).length;
  const sealed = e.acct.sealed;
  const write = sealed.write;
  sealed.write = function (data) {
    if (data.queue.some((m) => m.kind === 'admin')) {
      const error = new Error('disk full'); error.code = 'ENOSPC'; throw error;
    }
    return write.call(this, data);
  };
  await assert.rejects(e.deleteAssignment({ id: s.id, rev: v.rev }), (x) => x.code === 'write_failed');
  sealed.write = write;
  assert.deepEqual({ local: e.acct.data.local, queue: e.acct.data.queue }, before);
  await e.syncNow();
  assert.equal(applies(server).length, writesBefore, 'failed admin request was never sent');
  assert.ok(item(e.view(), s.id), 'the schedule is still live');
});

test('rolling back another action does not retry an in-flight mutation refused by the server', opts, async () => {
  const server = world();
  let refuse = false, attempts = 0;
  const refusing = { fetch: async (url, init) => {
    if (refuse && new URL(url).pathname.endsWith('/rpc/avb_sync_apply')) {
      attempts++;
      return new Response(JSON.stringify({ code: 'P0001', message: 'avb:invalid_field' }), { status: 400 });
    }
    return server.fetch(url, init);
  } };
  const gate = holdOne(refusing, (url) => refuse && new URL(url).pathname.endsWith('/rpc/avb_sync_apply'));
  const e = bareDevice(server, gate.fetch);
  await login(e, server, 'admin@t.invalid');
  const live = schedule();
  edit(e, (d) => d.schedules.items.push(live));
  await e.syncNow();
  const draft = schedule();
  edit(e, (d) => d.schedules.items.push(draft));
  const v = e.view();
  refuse = true;
  const sending = e.syncNow();
  await gate.arrived;
  const sealed = e.acct.sealed, write = sealed.write;
  sealed.write = function (data) {
    if (data.queue.some((m) => m.kind === 'admin')) {
      const error = new Error('disk full'); error.code = 'ENOSPC'; throw error;
    }
    return write.call(this, data);
  };
  await assert.rejects(e.deleteAssignment({ id: live.id, rev: v.rev }), (x) => x.code === 'write_failed');
  sealed.write = write;
  gate.release();
  await sending;
  assert.equal(attempts, 1, 'a permanent refusal waits for user review rather than being resent');
  assert.equal(e.acct.data.queue.length, 0);
  assert.ok(e.status().failed.length > 0);
  assert.ok(item(e.view(), live.id));
  assert.ok(item(e.view(), draft.id), 'the refused draft remains available');
});

test('protected start revision survives many views and completion still conflicts with a remote edit', opts, async () => {
  const server = world(), a = await device(server, 'op1@t.invalid'), b = await device(server, 'op2@t.invalid');
  const s = schedule(); edit(a, (d) => d.schedules.items.push(s)); await a.syncNow(); await b.syncNow();
  const start = a.view(), uid = s.sessions[0].uid;
  a.protect({ assignmentId: s.id, uid, baseRev: start.rev });
  for (let i = 0; i < 45; i++) a.view();
  assert.ok(a.views.has(start.rev));
  edit(b, (d) => { rowOf(d, s.id, uid).topic = 'Edited remotely'; }); await b.syncNow(); await a.syncNow();
  rowOf(start, s.id, uid).duration = '42m';
  assert.equal(a.commit({ baseRev: start.rev, snapshot: start.data }).ok, true);
  a.protect(null); await a.syncNow();
  assert.ok(a.conflicts().some((c) => c.targetKey === uid));
});

test('explicit local import previews parsed report records without queuing and keeps the source unchanged', opts, async () => {
  const server = world(), legacy = tmpDir();
  const original = JSON.stringify({reportSource:'/local/existing.xlsx'});
  fs.writeFileSync(path.join(legacy,'settings.json'),original);
  const a = await device(server,'op1@t.invalid',{legacyDir:legacy});
  const report = [{id:'DD-F-HD-2400-M',folder:2400,session:'M',type:'Formal',author:'DD',format:'HD',date:'2026-10-01'}];
  assert.equal(a.importLocal({confirm:false,report}).ok,true);
  assert.equal(a.status().pending,0);
  assert.equal(a.importLocal({confirm:true,report}).ok,true);
  await a.syncNow();
  const b = await device(server,'op2@t.invalid');
  assert.equal(b.view().data.report[0].id,report[0].id);
  assert.equal(fs.readFileSync(path.join(legacy,'settings.json'),'utf8'),original);
});

test('a 17,000-record existing-data sheet imports in batches and reaches another device; duplicate IDs keep the last', opts, async () => {
  const server = world(), legacy = tmpDir();
  const a = await device(server, 'op1@t.invalid', { legacyDir: legacy });
  const report = Array.from({ length: 17000 }, (_, i) => ({ id: `DD-F-HD-${i + 1}-M`, folder: i + 1, session: 'M', type: 'Formal', author: 'DD',
    format: 'HD', date: '2019-01-01', topic: `Topic ${i}`, events: [], languages: ['Gujarati'] }));
  report.push({ ...report[5], topic: 'Corrected' });   // a repeated ID, as old sheets have
  const preview = a.importLocal({ confirm: false, report });
  assert.equal(preview.ok, true);
  assert.equal(preview.warnings.filter((w) => w.code === 'duplicate_report_id').length, 1);
  assert.equal(a.importLocal({ confirm: true, report }).ok, true);
  let progress = 0;
  a.on('progress', () => { progress += 1; });
  for (let i = 0; i < 60 && a.status().pending; i += 1) await a.syncNow();
  assert.ok(progress >= 34, `one progress event per 500-record batch (got ${progress})`);
  assert.equal(a.status().pending, 0);
  const b = await device(server, 'op2@t.invalid');
  const got = b.view().data.report;
  assert.equal(got.length, 17000);
  assert.equal(got.find((r) => r.id === report[5].id).topic, 'Corrected');
});

test('a database waking from idle (not_authenticated with a fresh token) is retried, not treated as an expired sign-in', opts, async () => {
  const server = world();
  let hiccups = 0;
  const fetch = (url, init) => (String(url).includes('/rpc/') && hiccups-- > 0
    ? Promise.resolve(new Response(JSON.stringify({ code: '42501', message: 'avb:not_authenticated' }), { status: 403, headers: { 'Content-Type': 'application/json' } }))
    : server.fetch(url, init));
  const e = new SyncEngine({ dir: tmpDir(), fetch, safeStorage: fakeSafeStorage(), autoSync: false, now: () => server.clock.now });
  e.setConfig(server.config);
  await e.signIn('op1@t.invalid', server.users.get('op1@t.invalid').password);
  await e.syncNow();
  edit(e, (d) => d.schedules.items.push(schedule()));
  hiccups = 2;   // the call and its retry with a refreshed token both hit the waking database
  let s = await e.syncNow();
  assert.equal(s.phase, 'error');
  assert.notEqual(s.phase, 'expired');
  assert.ok(s.pending > 0);
  s = await e.syncNow();
  assert.equal(s.phase, 'online');
  assert.equal(s.pending, 0);
});

test('completion against the protected base follows our own preparation commit without a spurious conflict', opts, async () => {
  const server=world(), a=await device(server,'op1@t.invalid');
  const s=schedule(); edit(a,d=>d.schedules.items.push(s)); await a.syncNow();
  const shown=a.view(), uid=s.sessions[0].uid;
  rowOf(shown,s.id,uid).startedAt='2026-11-07T10:00:00.000Z';
  const saved=a.commit({baseRev:shown.rev,snapshot:shown.data});
  a.protect({assignmentId:s.id,uid,baseRev:saved.rev}); await a.syncNow();
  rowOf(shown,s.id,uid).duration='42m';
  a.commit({baseRev:saved.rev,snapshot:shown.data}); a.protect(null); await a.syncNow();
  assert.equal(a.conflicts().length,0);
  assert.equal(rowOf(a.view(),s.id,uid).duration,'42m');
});

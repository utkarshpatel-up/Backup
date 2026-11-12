'use strict';
// The server's sync rules (server/pb_hooks/avb_core.js) directly on SQLite: membership,
// the merge table, whole-schedule delete, resolutions, idempotency and all-or-nothing batches.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database, adapter } = require('./sync/harness');
const { createCore, errorResponse } = require('../server/pb_hooks/avb_core');

function server() {
  const db = database();
  const core = createCore({ db: adapter(db), uuid: () => crypto.randomUUID(), now: () => new Date().toISOString(),
    sha256: (s) => crypto.createHash('sha256').update(s).digest('hex') });
  const add = (user, role, active = 1) => db.prepare('INSERT INTO avb_members (id, user, role, is_active, display_name) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), user, role, active, user);
  add('op1', 'operator'); add('op2', 'operator'); add('lead', 'admin'); add('gone', 'operator', 0);
  /** One call in one transaction, as the PocketBase route runs it; a refusal comes back as { error }. */
  const rpc = (user, name, req) => {
    db.exec('BEGIN IMMEDIATE');
    try { const out = core.call(name, user, req === undefined ? {} : { p_request: req }); db.exec('COMMIT'); return out; } catch (e) {
      db.exec('ROLLBACK');
      const r = errorResponse(e);
      if (r.status >= 500) throw e;
      return { error: r.body.message.replace(/^avb:/, ''), status: r.status };
    }
  };
  const apply = (user, operations, mutation_id = crypto.randomUUID()) => rpc(user, 'avb_sync_apply', { protocol_version: 1, mutation_id, operations });
  return { db, rpc, apply };
}
const A = () => crypto.randomUUID();
const sess = (extra = {}) => ({ orderKey: 'a0', include: true, date: '2026-11-08', topic: 'Morning', ...extra });

test('membership is checked live on every call; roles come from avb_members only', () => {
  const s = server();
  assert.deepEqual(s.rpc('op1', 'avb_me'), { protocol_version: 1, user_id: 'op1', role: 'operator', display_name: 'op1' });
  assert.equal(s.rpc('gone', 'avb_me').error, 'not_member');
  assert.equal(s.rpc('stranger', 'avb_me').error, 'not_member');
  assert.equal(s.rpc('', 'avb_me').error, 'not_authenticated');
  assert.equal(s.rpc('gone', 'avb_me').status, 403);
  s.db.prepare("UPDATE avb_members SET is_active = 0 WHERE user = 'op1'").run();
  assert.equal(s.rpc('op1', 'avb_sync_pull', { protocol_version: 1 }).error, 'not_member');
  const team = s.rpc('lead', 'avb_team_members');
  assert.equal(team.length, 4);
  assert.ok(team.every((m) => typeof m.is_active === 'boolean' && !('email' in m)));
});

test('the merge table: applied, noop, stale_edit, delete_vs_edit, edit_vs_delete, restore_required, create_collision, coalescing', () => {
  const s = server();
  const a = A(), k = A();
  let r = s.apply('op1', [{ op: 'create', type: 'assignment', key: a, payload: { label: 'Shibir' } },
    { op: 'create', type: 'session', key: k, assignment_key: a, payload: sess() }]);
  assert.deepEqual(r.results.map((x) => x.status), ['applied', 'applied']);
  assert.equal(r.results[1].aggregate_rev, 2);
  const v1 = r.results[1].version_id;
  // same value again: noop, even from a stale base
  r = s.apply('op2', [{ op: 'update', type: 'session', key: k, base_version_id: v1, payload: sess() }]);
  assert.equal(r.results[0].status, 'noop');
  const v2 = s.apply('op1', [{ op: 'update', type: 'session', key: k, base_version_id: v1, payload: sess({ topic: 'Edited' }) }]).results[0].version_id;
  // op2 still on v1
  r = s.apply('op2', [{ op: 'update', type: 'session', key: k, base_version_id: v1, payload: sess({ topic: 'Mine' }) }]);
  assert.equal(r.results[0].status, 'conflict');
  assert.equal(r.results[0].conflict_kind, 'stale_edit');
  assert.equal(r.results[0].head_version_id, v2, 'the head stays');
  const again = s.apply('op2', [{ op: 'update', type: 'session', key: k, base_version_id: v1, payload: sess({ topic: 'Mine' }) }]);
  assert.equal(again.results[0].conflict_id, r.results[0].conflict_id, 'the same incoming value coalesces');
  r = s.apply('op2', [{ op: 'delete', type: 'session', key: k, base_version_id: v1 }]);
  assert.equal(r.results[0].conflict_kind, 'delete_vs_edit');
  assert.equal(r.results[0].deleted, false, 'not deleted');
  const tomb = s.apply('op1', [{ op: 'delete', type: 'session', key: k, base_version_id: v2 }]).results[0];
  assert.equal(tomb.deleted, true);
  assert.equal(s.apply('op2', [{ op: 'update', type: 'session', key: k, base_version_id: v2, payload: sess({ topic: 'Late' }) }]).results[0].conflict_kind, 'edit_vs_delete');
  assert.equal(s.apply('op2', [{ op: 'update', type: 'session', key: k, base_version_id: tomb.version_id, payload: sess() }]).error, 'restore_required');
  const back = s.apply('op1', [{ op: 'restore', type: 'session', key: k, base_version_id: tomb.version_id }]).results[0];
  assert.equal(back.status, 'applied');
  assert.equal(back.deleted, false);
  r = s.apply('op2', [{ op: 'create', type: 'session', key: k, assignment_key: a, payload: sess({ topic: 'Other' }) }]);
  assert.equal(r.results[0].conflict_kind, 'create_collision');
  const open = s.rpc('op1', 'avb_conflicts', { protocol_version: 1 });
  assert.equal(open.items.length, 4);
  assert.ok(open.items.every((c) => c.incoming && c.current_head && c.current_head.payload.topic === 'Edited'));
  const hist = s.rpc('op1', 'avb_target_history', { protocol_version: 1, type: 'session', key: k, limit: 2 });
  assert.equal(hist.items.length, 2);
  assert.equal(hist.has_more, true);
  const rest = s.rpc('op1', 'avb_target_history', { protocol_version: 1, type: 'session', key: k, before: hist.next_before, limit: 100 });
  assert.ok(rest.items.some((v) => v.accepted === false), 'stored incoming values are in the history');
  const recent = s.rpc('op1', 'avb_recent_history', { protocol_version: 1, limit: 100 });
  assert.ok(recent.items.length > 0 && recent.items.every((v) => v.target_type && v.created_at), 'the team feed lists accepted changes');
  assert.ok(recent.items.some((v) => v.previous && v.payload && v.previous.topic !== v.payload.topic), 'an edit carries the value it replaced');
  assert.ok(recent.items.every((v) => v.actor_name === v.actor_id), 'each change is named by its member');
  const first = s.rpc('op1', 'avb_recent_history', { protocol_version: 1, limit: 2 });
  const next = s.rpc('op1', 'avb_recent_history', { protocol_version: 1, limit: 100, before: first.next_before });
  assert.deepEqual([...first.items, ...next.items].map((v) => v.version_seq), recent.items.map((v) => v.version_seq), 'pages join without gaps or repeats');
  assert.equal(s.rpc('gone', 'avb_recent_history', { protocol_version: 1 }).error, 'not_member');
});

test('whole-schedule delete is admin-only, rev-checked, keeps children, and blocks edits inside it', () => {
  const s = server();
  const a = A(), k = A();
  const made = s.apply('op1', [{ op: 'create', type: 'assignment', key: a, payload: { label: 'X' } },
    { op: 'create', type: 'session', key: k, assignment_key: a, payload: sess() }]).results;
  const rev = made[1].aggregate_rev;
  assert.equal(s.apply('op1', [{ op: 'delete_assignment', assignment_key: a, expected_aggregate_rev: rev }]).error, 'admin_required');
  assert.equal(s.apply('op1', [{ op: 'delete', type: 'assignment', key: a, base_version_id: made[0].version_id }]).error, 'use_delete_assignment');
  const stale = s.apply('lead', [{ op: 'delete_assignment', assignment_key: a, expected_aggregate_rev: rev - 1 }]).results[0];
  assert.equal(stale.conflict_kind, 'assignment_delete_stale');
  assert.equal(stale.deleted, false);
  const rev2 = stale.aggregate_rev;
  assert.equal(s.apply('op1', [{ op: 'resolve_conflict', conflict_id: stale.conflict_id, expected_head_version_id: made[0].version_id, resolution: 'keep_current' }]).error, 'admin_required');
  const del = s.apply('lead', [{ op: 'delete_assignment', assignment_key: a, expected_aggregate_rev: rev2 }]).results[0];
  assert.equal(del.status, 'applied');
  assert.equal(del.deleted, true);
  const inside = s.apply('op2', [{ op: 'update', type: 'session', key: k, base_version_id: made[1].version_id, payload: sess({ topic: 'Late' }) }]).results[0];
  assert.equal(inside.conflict_kind, 'parent_deleted');
  assert.equal(s.apply('op2', [{ op: 'resolve_conflict', conflict_id: inside.conflict_id, expected_head_version_id: made[1].version_id, resolution: 'accept_incoming' }]).error, 'parent_deleted');
  const pulled = s.rpc('op1', 'avb_sync_pull', { protocol_version: 1 });
  const child = pulled.items.find((x) => x.target_key === k);
  assert.equal(child.deleted, false, 'rows are not cascaded');
  assert.equal(child.open_conflicts, 1);
  assert.equal(s.apply('lead', [{ op: 'restore_assignment', assignment_key: a, expected_aggregate_rev: del.aggregate_rev }]).error,
    'aggregate_rev_mismatch', 'the parent_deleted conflict moved the revision on');
  const res = s.apply('lead', [{ op: 'restore_assignment', assignment_key: a, expected_aggregate_rev: inside.aggregate_rev }]).results[0];
  assert.equal(res.status, 'applied');
  assert.equal(res.deleted, false);
  const head = s.rpc('op1', 'avb_sync_pull', { protocol_version: 1 }).items.find((x) => x.target_key === a);
  assert.equal(head.payload.label, 'X', 'restore brings back the value before the tombstone');
});

test('resolutions are decided against the head the person saw; merged payloads are validated', () => {
  const s = server();
  const a = A(), k = A();
  const made = s.apply('op1', [{ op: 'create', type: 'assignment', key: a, payload: { label: 'X' } },
    { op: 'create', type: 'session', key: k, assignment_key: a, payload: sess() }]).results;
  const v2 = s.apply('op1', [{ op: 'update', type: 'session', key: k, base_version_id: made[1].version_id, payload: sess({ topic: 'B' }) }]).results[0].version_id;
  const c = s.apply('op2', [{ op: 'update', type: 'session', key: k, base_version_id: made[1].version_id, payload: sess({ topic: 'C' }) }]).results[0];
  const resolve = (extra) => s.apply('op2', [{ op: 'resolve_conflict', conflict_id: c.conflict_id, ...extra }]);
  assert.equal(resolve({ expected_head_version_id: made[1].version_id, resolution: 'accept_incoming' }).error, 'stale_resolution');
  assert.equal(resolve({ expected_head_version_id: v2, resolution: 'merged' }).error, 'payload_only_for_merged');
  assert.equal(resolve({ expected_head_version_id: v2, resolution: 'merged', payload: sess({ bogus: 1 }) }).error, 'unknown_field');
  const done = resolve({ expected_head_version_id: v2, resolution: 'merged', payload: sess({ topic: 'B+C' }) }).results[0];
  assert.equal(done.status, 'resolved');
  assert.equal(resolve({ expected_head_version_id: done.version_id, resolution: 'keep_current' }).error, 'conflict_not_open');
  assert.equal(s.rpc('op1', 'avb_conflicts', { protocol_version: 1, status: 'resolved' }).items[0].resolution, 'merged');
});

test('a batch is all-or-nothing, touches each target once, and a mutation id is idempotent per user and content', () => {
  const s = server();
  const a = A();
  const bad = s.apply('op1', [{ op: 'create', type: 'assignment', key: a, payload: { label: 'X' } },
    { op: 'create', type: 'session', key: A(), assignment_key: a, payload: sess({ date: '2026-02-30' }) }]);
  assert.equal(bad.error, 'invalid_field');
  assert.equal(s.rpc('op1', 'avb_sync_pull', { protocol_version: 1 }).items.length, 0, 'nothing from the refused batch was kept');
  assert.equal(s.apply('op1', [{ op: 'create', type: 'assignment', key: a, payload: { label: 'X' } },
    { op: 'create', type: 'assignment', key: a, payload: { label: 'Y' } }]).error, 'duplicate_target_in_batch');
  const id = crypto.randomUUID();
  const ops = [{ op: 'create', type: 'assignment', key: a, payload: { label: 'X' } }];
  const first = s.apply('op1', ops, id);
  assert.deepEqual(s.apply('op1', ops, id), first, 'a resend gets the stored answer');
  assert.equal(s.apply('op1', [{ op: 'create', type: 'assignment', key: a, payload: { label: 'Z' } }], id).error, 'mutation_id_reused');
  assert.equal(s.apply('op2', ops, id).error, 'mutation_id_reused');
  assert.equal(s.apply('op1', [{ op: 'create', type: 'session', key: a, assignment_key: a, payload: sess() }]).error, 'uid_collision');
  assert.equal(s.apply('op1', [{ op: 'delete', type: 'team_defaults', key: 'team', base_version_id: A() }]).error, 'not_deletable');
  assert.equal(s.apply('op1', [{ op: 'create', type: 'city', key: 'Pune', payload: { name: 'Pune', city: 'Pune' } }]).error, 'invalid_key');
  assert.equal(s.apply('op1', [{ op: 'create', type: 'city', key: 'pune', payload: { name: ' Pune ', city: 'Pune' } }]).results[0].status, 'applied');
  assert.equal(s.rpc('op1', 'avb_sync_apply', { protocol_version: 2, mutation_id: A(), operations: ops }).error, 'protocol_version_unsupported');
  assert.equal(s.rpc('op1', 'avb_sync_apply', { protocol_version: 1, mutation_id: A(), operations: ops, actor_id: 'lead' }).error, 'unknown_field');
});

test('pull pages by change_seq and every change moves a target to the end', () => {
  const s = server();
  const a = A();
  const ops = [{ op: 'create', type: 'assignment', key: a, payload: { label: 'X' } }];
  for (let i = 0; i < 5; i++) ops.push({ op: 'create', type: 'session', key: A(), assignment_key: a, payload: sess({ orderKey: `a${i}` }) });
  s.apply('op1', ops);
  const p1 = s.rpc('op1', 'avb_sync_pull', { protocol_version: 1, limit: 4 });
  assert.equal(p1.items.length, 4);
  assert.equal(p1.has_more, true);
  const p2 = s.rpc('op1', 'avb_sync_pull', { protocol_version: 1, after: p1.next_cursor, limit: 4 });
  assert.equal(p2.items.length, 2);
  assert.equal(p2.has_more, false);
  const seqs = [...p1.items, ...p2.items].map((x) => x.change_seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert.equal(new Set([...p1.items, ...p2.items].map((x) => x.target_key)).size, 6, 'each target once');
  assert.equal(s.rpc('op1', 'avb_sync_pull', { protocol_version: 1, after: p2.next_cursor }).items.length, 0);
  assert.equal(s.rpc('op1', 'avb_sync_pull', { protocol_version: 1, limit: 501 }).error, 'out_of_range');
});

test('versions, mutations and the member audit are append-only', () => {
  const s = server();
  s.apply('op1', [{ op: 'create', type: 'assignment', key: A(), payload: { label: 'X' } }]);
  for (const sql of ['UPDATE avb_versions SET payload = NULL', 'DELETE FROM avb_versions', 'UPDATE avb_mutations SET response = \'{}\'', 'DELETE FROM avb_mutations']) {
    assert.throws(() => s.db.exec(sql), /avb:append_only/, sql);
  }
});

test('a member with no display_name is named by the name given at sign-up', () => {
  const s = server();
  s.db.prepare("INSERT INTO users (id, email, name) VALUES ('nn', 'nn@example.com', 'Nita N')").run();
  s.db.prepare("INSERT INTO avb_members (id, user, role, is_active, display_name) VALUES ('m-nn', 'nn', 'operator', 1, '')").run();
  assert.equal(s.rpc('nn', 'avb_me').display_name, 'Nita N');
  assert.equal(s.rpc('nn', 'avb_team_members').find((m) => m.user_id === 'nn').display_name, 'Nita N');
  assert.equal(s.rpc('op1', 'avb_me').display_name, 'op1', 'a set display_name still wins');
});

test('a report record with edit marks is taken, and two PCs editing it make a stale_edit', () => {
  const s = server();
  const rec = (extra) => ({ id: 'X-1', topic: 'New', clips: 3, edited: { topic: 'Old' }, ...extra });
  const v1 = s.apply('op1', [{ op: 'create', type: 'report_record', key: 'X-1', payload: rec() }]).results[0];
  assert.equal(v1.status, 'applied');
  s.apply('op1', [{ op: 'update', type: 'report_record', key: 'X-1', base_version_id: v1.version_id, payload: rec({ remarks: 'a' }) }]);
  const r = s.apply('op2', [{ op: 'update', type: 'report_record', key: 'X-1', base_version_id: v1.version_id, payload: rec({ remarks: 'b' }) }]);
  assert.equal(r.results[0].conflict_kind, 'stale_edit');
  assert.equal(s.apply('op1', [{ op: 'create', type: 'report_record', key: 'X-2', payload: { id: 'X-2', edited: ['topic'] } }]).error, 'invalid_field');
});

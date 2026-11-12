'use strict';
// AV Backup team sync, protocol v1: the server's rules (see server/SYNC_CONTRACT.md).
// Plain synchronous JavaScript with no Node or PocketBase API, so the same file runs inside
// PocketBase's JS hooks (avb.pb.js) and under Node in the tests (tests/sync/harness.js).
//
// `db.all(sql, params)` returns one parsed object per row, from the row's single `j` column
// (every query selects `json_object(...) AS j`); `db.run(sql, params)` executes. Parameters
// are written `{:name}`. Callers run each call in ONE transaction: PocketBase serialises
// write transactions on SQLite, so there is one writer at a time and commit order equals
// change_seq order. A thrown AvbError means nothing in the request was applied.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SAFE = 9007199254740991;
const CHILD = { session: 1, source_line: 1, source_skip: 1 };

// field -> [kind, limit, required]. Anything not listed is refused, which keeps local paths,
// themes, column widths and runtime backup state off the server. Must equal electron/sync/spec.js.
const SPEC = {
  assignment: {
    label: ['text', 200, true], sourceBasename: ['basename', 255, false], createdAt: ['timestamp_null', 0, false],
    defaults: ['nested', 'team_defaults', false], starts: ['nested', 'team_starts', false] },
  session: {
    orderKey: ['order_key', 64, true], include: ['bool', 0, true], date: ['date_null', 0, true],
    start: ['text_null', 16, false], end: ['text_null', 16, false], hint: ['text_null', 8, false],
    type: ['text', 32, false], activity: ['text', 200, false], place: ['text', 500, false], city: ['text', 200, false],
    topic: ['text', 1000, false], events: ['list', 200, false], languages: ['list', 100, false],
    author: ['text', 64, false], format: ['text', 16, false], duration: ['scalar', 32, false],
    clips: ['scalar', 32, false], cameras: ['scalar', 32, false], folder: ['scalar', 32, false],
    session: ['scalar', 32, false], camPlan: ['scalar', 32, false], backedUp: ['timestamp_null', 0, false],
    title: ['text', 1000, false], subtitle: ['text', 1000, false], placeText: ['text', 1000, false],
    source: ['text', 4000, false], sharedFolder: ['bool', 0, false], flags: ['text_map', 500, false],
    remarks: ['text', 2000, false], geo: ['text_null', 300, false], startedAt: ['timestamp_null', 0, false] },
  source_line: { line: ['int', 99999, true], part: ['int', 9999, true], cells: ['cells', 256, true], continuesCell: ['bool', 0, true] },
  source_skip: { index: ['int', 99999, true], days: ['date_list', 366, true], reason: ['text', 32, true], rowText: ['text', 32768, true] },
  city: { name: ['text', 300, true], city: ['text', 200, true], state: ['text', 200, false], country: ['text', 200, false] },
  report_record: {
    id: ['text', 300, true], folder: ['scalar', 32, false], format: ['text', 16, false], session: ['scalar', 32, false],
    author: ['text', 64, false], type: ['text', 32, false], date: ['date_null', 0, false], duration: ['scalar', 32, false],
    activity: ['text', 200, false], place: ['text', 500, false], topic: ['text', 1000, false], clips: ['scalar', 32, false],
    cameras: ['scalar', 32, false], events: ['list', 200, false], languages: ['list', 100, false],
    city: ['text', 200, false], state: ['text', 200, false], country: ['text', 200, false], remarks: ['text', 2000, false],
    edited: ['list', 200, false] },
  team_defaults: { author: ['text', 64, false], format: ['text', 16, false], camsFormal: ['scalar', 32, false], camsInformal: ['scalar', 32, false] },
  team_starts: { formal: ['scalar', 32, false], informal: ['scalar', 32, false] },
  learned_title: { key: ['text', 300, true], topic: ['text', 1000, false], type: ['text', 32, false], activity: ['text', 200, false],
    events: ['list', 200, false], languages: ['list', 100, false] },
  learned_place: { key: ['text', 300, true], place: ['text', 500, false], city: ['text', 200, false], languages: ['list', 100, false] },
};

/** state: '42501' identity/permission (HTTP 403), 'P0001' everything else (HTTP 400). */
class AvbError extends Error {
  constructor(code, detail, state) {
    super('avb:' + code);
    this.code = code;
    this.detail = detail == null ? '' : String(detail);
    this.state = state || 'P0001';
  }
}
function fail(code, detail, state) { throw new AvbError(code, detail, state); }

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const kindOf = (v) => (v === undefined ? 'undefined' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isObj = (v) => kindOf(v) === 'object';
const chars = (s) => s.length - (s.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) || []).length; // code points
function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const validTime = (s) => /^\d{4}-\d{2}-\d{2}T/.test(s) && validDate(s.slice(0, 10)) && !isNaN(Date.parse(s));

/** Key-order-independent JSON: equality of two values, and the stored form of a payload. */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const same = (a, b) => canon(a) === canon(b);

function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
/** Bytes of the value written with ", " and ": " separators: the size the clients measure (spec.js jsonbBytes). */
function spacedBytes(v) {
  if (Array.isArray(v)) return 2 + v.reduce((n, x) => n + spacedBytes(x), 0) + Math.max(0, v.length - 1) * 2;
  if (isObj(v)) {
    const ks = Object.keys(v).filter((k) => v[k] !== undefined);
    return 2 + ks.reduce((n, k) => n + utf8Bytes(JSON.stringify(k)) + 2 + spacedBytes(v[k]), 0) + Math.max(0, ks.length - 1) * 2;
  }
  return utf8Bytes(JSON.stringify(v === undefined ? null : v));
}

function checkKeys(obj, allowed, what) {
  if (!isObj(obj)) fail('not_an_object', what);
  for (const k of Object.keys(obj)) if (allowed.indexOf(k) < 0) fail('unknown_field', what + '.' + k);
}
function checkProtocol(req) { if (req.protocol_version !== 1) fail('protocol_version_unsupported', req.protocol_version); }
function uuidField(obj, name) {
  if (typeof obj[name] !== 'string' || !UUID.test(obj[name])) fail('invalid_uuid', name);
  return obj[name];
}
function intField(obj, name, min, max, def) {
  if (!has(obj, name) && def !== undefined) return def;
  const v = obj[name];
  if (typeof v !== 'number') fail('invalid_integer', name);
  if (!Number.isInteger(v) || v < min || v > max) fail('out_of_range', name);
  return v;
}

function fieldOk(kind, max, v) {
  const t = kindOf(v);
  switch (kind) {
    case 'text': return t === 'string' && chars(v) <= max;
    case 'text_null': return t === 'null' || (t === 'string' && chars(v) <= max);
    case 'scalar': return t === 'null' || (t === 'number' && isFinite(v)) || (t === 'string' && chars(v) <= max);
    case 'bool': return t === 'boolean';
    case 'order_key': return t === 'string' && /^[0-9A-Za-z]{1,64}$/.test(v);
    // A file name, never a path: the local location of a file is not server data.
    case 'basename': return t === 'string' && chars(v) <= max && !/[/\\]/.test(v) && !/^[A-Za-z]:/.test(v);
    case 'date_null': return t === 'null' || (t === 'string' && (v === '' || validDate(v)));
    case 'timestamp_null': return t === 'null' || (t === 'string' && validTime(v));
    case 'int': return t === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
    case 'cells': return t === 'array' && v.length <= max && v.every((e) => typeof e === 'string');
    case 'date_list': return t === 'array' && v.length >= 1 && v.length <= max && v.every((e) => typeof e === 'string' && validDate(e));
    case 'list': return t === 'array' && v.length <= 64 && v.every((e) => typeof e === 'string' && chars(e) <= max);
    case 'text_map': return t === 'object' && Object.keys(v).length <= 32
      && Object.keys(v).every((k) => chars(k) <= 64 && typeof v[k] === 'string' && chars(v[k]) <= max);
    default: return false;
  }
}

function validatePayload(type, payload) {
  const spec = SPEC[type];
  if (!isObj(payload)) fail('payload_required', type);
  if (spacedBytes(payload) > 32768) fail('payload_too_large', type);
  checkKeys(payload, Object.keys(spec), type);
  for (const k of Object.keys(spec)) {
    const kind = spec[k][0], max = spec[k][1], required = spec[k][2];
    if (!has(payload, k)) { if (required) fail('missing_field', type + '.' + k); continue; }
    if (kind === 'nested') { validatePayload(max, payload[k]); continue; }
    if (!fieldOk(kind, max, payload[k])) fail('invalid_field', type + '.' + k);
  }
}

// A target's key format, and its tie to the payload: a natural-key record can't be filed
// under another record's key, and two devices importing one sheet share keys.
function checkTarget(type, key, payload) {
  if (typeof key !== 'string') fail('invalid_key', type);
  const p = isObj(payload) ? payload : null;
  const str = (v) => (v == null ? null : typeof v === 'string' ? v : canon(v));
  let natural = null;
  switch (type) {
    case 'assignment': case 'session':
      if (!UUID.test(key)) fail('invalid_key', type);
      break;
    case 'source_line': {
      const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,5}):(\d{1,4})$/.exec(key);
      if (!m || (p && m[2] + ':' + m[3] !== str(p.line) + ':' + str(p.part))) fail('invalid_key', type);
      break;
    }
    case 'source_skip': {
      const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,5})$/.exec(key);
      if (!m || (p && m[2] !== str(p.index))) fail('invalid_key', type);
      break;
    }
    case 'team_defaults': case 'team_starts':
      if (key !== 'team') fail('invalid_key', type);
      break;
    case 'city': natural = str(p && has(p, 'name') ? p.name : key).trim().toLowerCase(); break;
    case 'report_record': natural = str(p && has(p, 'id') ? p.id : key).trim().toUpperCase(); break;
    case 'learned_title': case 'learned_place': natural = str(p && has(p, 'key') ? p.key : key).trim().toLowerCase(); break;
    default: fail('unknown_target_type', type);
  }
  if (natural !== null && (key !== natural || chars(key) < 1 || chars(key) > 300)) fail('invalid_key', type);
}

// ------------------------------------------------------------------ storage

const TARGET_J = `json_object('target_id', target_id, 'target_type', target_type, 'target_key', target_key,
  'assignment_key', assignment_key, 'head_version_id', head_version_id, 'deleted', deleted,
  'aggregate_rev', aggregate_rev, 'change_seq', change_seq)`;
const VERSION_J = `json_object('version_id', version_id, 'version_seq', version_seq, 'target_id', target_id,
  'parent_version_id', parent_version_id, 'action', action, 'accepted', accepted, 'payload', json(payload),
  'actor_id', actor_id, 'mutation_id', mutation_id, 'created_at', created_at)`;

function createCore({ db, uuid, now, sha256 }) {
  const one = (sql, p) => db.all(sql, p || {})[0] || null;
  const target = (where, p) => {
    const t = one(`SELECT ${TARGET_J} AS j FROM avb_targets WHERE ${where}`, p);
    if (t) t.deleted = !!t.deleted;
    return t;
  };
  const byId = (id) => target('target_id = {:id}', { id });
  const byKey = (type, key) => target('target_type = {:type} AND target_key = {:key}', { type, key });
  const assignmentOf = (key) => (key == null ? null : byKey('assignment', key));
  const version = (id) => {
    if (id == null) return null;
    const v = one(`SELECT ${VERSION_J} AS j FROM avb_versions WHERE version_id = {:id}`, { id });
    if (v) v.accepted = !!v.accepted;
    return v;
  };
  const nextSeq = () => one(`SELECT json_object('n', coalesce(max(change_seq), 0) + 1) AS j FROM avb_targets`).n;

  // The live membership check: a still-valid token of a revoked user stops here.
  function member(userId) {
    if (!userId) fail('not_authenticated', null, '42501');
    // The name: the one the maintainer set, else the one given at sign-up.
    const m = one(`SELECT json_object('user_id', mem.user, 'role', mem.role, 'display_name', COALESCE(NULLIF(mem.display_name, ''), NULLIF(u.name, ''), '')) AS j
      FROM avb_members mem LEFT JOIN users u ON u.id = mem.user WHERE mem.user = {:u} AND mem.is_active = 1`, { u: userId });
    if (!m) fail('not_member', null, '42501');
    m.display_name = m.display_name || '';
    return m;
  }
  const requireAdmin = (m) => { if (m.role !== 'admin') fail('admin_required', null, '42501'); };

  // One new change_seq for the target and, if it sits in an assignment, one more
  // aggregate_rev (and change_seq) on the assignment.
  function touch(t) {
    db.run('UPDATE avb_targets SET change_seq = {:s}, aggregate_rev = aggregate_rev + 1 WHERE target_id = {:id}', { s: nextSeq(), id: t.target_id });
    const a = t.target_type === 'assignment' ? null : assignmentOf(t.assignment_key);
    if (a) db.run('UPDATE avb_targets SET change_seq = {:s}, aggregate_rev = aggregate_rev + 1 WHERE target_id = {:id}', { s: nextSeq(), id: a.target_id });
  }
  function addVersion(t, parent, action, accepted, payload, actor, mutation) {
    const id = uuid();
    db.run(`INSERT INTO avb_versions (version_id, target_id, parent_version_id, action, accepted, payload, actor_id, mutation_id, created_at)
      VALUES ({:id}, {:t}, {:parent}, {:action}, {:accepted}, {:payload}, {:actor}, {:mutation}, {:at})`,
    { id, t: t.target_id, parent: parent == null ? null : parent, action, accepted: accepted ? 1 : 0,
      payload: payload == null ? null : canon(payload), actor, mutation, at: now() });
    return id;
  }
  function setHead(t, versionId, deleted) {
    db.run('UPDATE avb_targets SET head_version_id = {:v}, deleted = {:d} WHERE target_id = {:id}', { v: versionId, d: deleted ? 1 : 0, id: t.target_id });
  }
  const parentDeleted = (t) => { const a = assignmentOf(t.assignment_key); return !!(a && a.deleted); };

  // Keep an incoming value that can't be applied. The same value already waiting on this
  // target coalesces into that conflict; nothing is ever dropped.
  function openConflict(t, kind, base, action, incoming, actor, mutation) {
    const open = db.all(`SELECT json_object('conflict_id', c.conflict_id, 'kind', c.kind, 'payload', json(v.payload)) AS j
      FROM avb_conflicts c JOIN avb_versions v ON v.version_id = c.incoming_version_id
      WHERE c.target_id = {:t} AND c.status = 'open' ORDER BY c.conflict_seq`, { t: t.target_id });
    const hit = open.find((c) => same(c.payload, incoming === undefined ? null : incoming));
    if (hit) return { status: 'conflict', conflict_id: hit.conflict_id, conflict_kind: hit.kind, head_version_id: t.head_version_id };
    const inc = addVersion(t, base, action, false, incoming, actor, mutation);
    const id = uuid();
    db.run(`INSERT INTO avb_conflicts (conflict_id, target_id, kind, base_version_id, detected_head_id, incoming_version_id, status, created_at)
      VALUES ({:id}, {:t}, {:kind}, {:base}, {:head}, {:inc}, 'open', {:at})`,
    { id, t: t.target_id, kind, base: base == null ? null : base, head: t.head_version_id, inc, at: now() });
    touch(t);
    return { status: 'conflict', conflict_id: id, conflict_kind: kind, head_version_id: t.head_version_id };
  }

  function resultFor(targetId, extra) {
    const t = byId(targetId);
    const a = assignmentOf(t.assignment_key);
    return Object.assign({}, extra, { target_type: t.target_type, target_key: t.target_key, head_version_id: t.head_version_id,
      deleted: t.deleted, aggregate_rev: a ? a.aggregate_rev : null });
  }

  // ---------------------------------------------------------------- operations

  function applyTargetOp(m, mutation, op) {
    const kind = op.op, type = op.type, key = op.key;
    checkKeys(op, kind === 'create' ? ['op', 'type', 'key', 'assignment_key', 'payload']
      : kind === 'update' ? ['op', 'type', 'key', 'base_version_id', 'payload'] : ['op', 'type', 'key', 'base_version_id'], 'operation');
    checkTarget(type, key, kind === 'create' || kind === 'update' ? op.payload : null);
    // Whole-schedule deletion has one door, and it is not this one.
    if (type === 'assignment' && (kind === 'delete' || kind === 'restore')) fail('use_delete_assignment', null, '42501');
    if ((type === 'team_defaults' || type === 'team_starts') && kind === 'delete') fail('not_deletable', type);

    let incoming = null, base = null, parent = null;
    if (kind === 'create' || kind === 'update') { validatePayload(type, op.payload); incoming = op.payload; }
    let t = byKey(type, key);

    if (kind === 'create') {
      if (has(op, 'assignment_key') !== !!CHILD[type]) fail('assignment_key_only_for_children', type);
      if ((type === 'source_line' || type === 'source_skip') && key.split(':')[0] !== op.assignment_key) fail('invalid_key', type);
      if (CHILD[type]) {
        parent = uuidField(op, 'assignment_key');
        if (!assignmentOf(parent)) fail('assignment_not_found', parent);
      } else if (type === 'assignment') parent = key;
      if (!t) {
        if ((type === 'assignment' || type === 'session')
          && one(`SELECT json_object('x', 1) AS j FROM avb_targets WHERE target_key = {:k} AND target_type IN ('assignment', 'session')`, { k: key })) {
          fail('uid_collision', key);
        }
        db.run(`INSERT INTO avb_targets (target_type, target_key, assignment_key, aggregate_rev, change_seq)
          VALUES ({:type}, {:key}, {:parent}, {:rev}, {:s})`, { type, key, parent, rev: type === 'assignment' ? 0 : null, s: nextSeq() });
        t = byKey(type, key);
      } else if (t.assignment_key !== parent) fail('uid_assignment_mismatch', key);
    } else if (kind === 'update' || kind === 'delete' || kind === 'restore') {
      if (!t) fail('target_not_found', type + ':' + key);
      base = version(uuidField(op, 'base_version_id'));
      if (!base || base.target_id !== t.target_id) fail('base_version_mismatch', op.base_version_id);
      if (kind === 'update' && t.deleted && base.version_id === t.head_version_id && !parentDeleted(t)) fail('restore_required', key);
      if (kind === 'restore') {
        if (base.payload !== null) fail('restore_base_not_tombstone', key);
        // The last accepted value before this tombstone, however it came to be deleted.
        const prev = one(`SELECT json_object('payload', json(payload)) AS j FROM avb_versions WHERE target_id = {:t} AND accepted = 1
          AND payload IS NOT NULL AND version_seq < {:seq} ORDER BY version_seq DESC LIMIT 1`, { t: t.target_id, seq: base.version_seq });
        if (!prev) fail('nothing_to_restore', key);
        incoming = prev.payload;
      }
    } else fail('unknown_op', kind);

    const head = version(t.head_version_id);
    // Same value: nothing to record, and nothing to argue about.
    if (head && same(incoming, head.payload)) return resultFor(t.target_id, { status: 'noop' });

    // No timestamps and no winner: anything not based on the current head waits for a person.
    const baseId = base ? base.version_id : null;
    let conflict = null;
    if (parentDeleted(t)) conflict = 'parent_deleted';
    else if (kind === 'create') conflict = t.head_version_id != null ? 'create_collision' : null;
    else if (baseId !== t.head_version_id) conflict = t.deleted ? 'edit_vs_delete' : incoming === null ? 'delete_vs_edit' : 'stale_edit';
    if (conflict) return resultFor(t.target_id, openConflict(t, conflict, baseId, kind, incoming, m.user_id, mutation));

    const v = addVersion(t, t.head_version_id, kind, true, incoming, m.user_id, mutation);
    setHead(t, v, incoming === null);
    touch(t);
    return resultFor(t.target_id, { status: 'applied', version_id: v });
  }

  function assignmentTarget(op) {
    const key = uuidField(op, 'assignment_key');
    const t = byKey('assignment', key);
    if (!t) fail('assignment_not_found', key);
    return t;
  }

  // Marks only the assignment: children keep their heads, so restore brings back everything
  // and no child value is lost. A stale request never deletes.
  function applyDeleteAssignment(m, mutation, op) {
    requireAdmin(m);
    checkKeys(op, ['op', 'assignment_key', 'expected_aggregate_rev'], 'operation');
    const t = assignmentTarget(op);
    const rev = intField(op, 'expected_aggregate_rev', 0, MAX_SAFE);
    if (t.deleted) return resultFor(t.target_id, { status: 'noop' });
    if (t.aggregate_rev !== rev) {
      return resultFor(t.target_id, openConflict(t, 'assignment_delete_stale', t.head_version_id, 'delete', null, m.user_id, mutation));
    }
    const v = addVersion(t, t.head_version_id, 'delete', true, null, m.user_id, mutation);
    setHead(t, v, true);
    touch(t);
    return resultFor(t.target_id, { status: 'applied', version_id: v });
  }

  function applyRestoreAssignment(m, mutation, op) {
    requireAdmin(m);
    checkKeys(op, ['op', 'assignment_key', 'expected_aggregate_rev'], 'operation');
    const t = assignmentTarget(op);
    const rev = intField(op, 'expected_aggregate_rev', 0, MAX_SAFE);
    if (!t.deleted) return resultFor(t.target_id, { status: 'noop' });
    if (t.aggregate_rev !== rev) fail('aggregate_rev_mismatch', t.aggregate_rev);
    const tomb = version(t.head_version_id);
    const prev = tomb && version(tomb.parent_version_id);
    const payload = prev ? prev.payload : null;
    const v = addVersion(t, t.head_version_id, 'restore', true, payload, m.user_id, mutation);
    setHead(t, v, false);
    touch(t);
    return resultFor(t.target_id, { status: 'applied', version_id: v });
  }

  function conflictById(id) {
    return one(`SELECT json_object('conflict_id', conflict_id, 'target_id', target_id, 'kind', kind, 'status', status,
      'incoming_version_id', incoming_version_id) AS j FROM avb_conflicts WHERE conflict_id = {:id}`, { id });
  }

  function applyResolve(m, mutation, op) {
    checkKeys(op, ['op', 'conflict_id', 'expected_head_version_id', 'resolution', 'payload'], 'operation');
    const c = conflictById(uuidField(op, 'conflict_id'));
    if (!c) fail('conflict_not_found', op.conflict_id);
    if (c.status !== 'open') fail('conflict_not_open', c.conflict_id);
    const res = op.resolution;
    if (['keep_current', 'accept_incoming', 'merged'].indexOf(res) < 0) fail('invalid_resolution', res);
    if (has(op, 'payload') !== (res === 'merged')) fail('payload_only_for_merged', res);
    const t = byId(c.target_id);
    // A deletion attempt that lost its race is the admin's to close, and it can only be
    // closed. To delete, send delete_assignment again against the current revision.
    if (c.kind === 'assignment_delete_stale') {
      requireAdmin(m);
      if (res !== 'keep_current') fail('use_delete_assignment', null, '42501');
    }
    // Decided against what the resolver actually saw, or not at all.
    const expected = has(op, 'expected_head_version_id') && op.expected_head_version_id !== null ? String(op.expected_head_version_id) : null;
    if (expected !== t.head_version_id) fail('stale_resolution', t.head_version_id);

    let v;
    if (res === 'keep_current') v = t.head_version_id;
    else {
      if (parentDeleted(t)) fail('parent_deleted', t.target_key);
      let payload;
      if (res === 'merged') {
        checkTarget(t.target_type, t.target_key, op.payload);
        validatePayload(t.target_type, op.payload);
        payload = op.payload;
      } else payload = version(c.incoming_version_id).payload;
      v = addVersion(t, t.head_version_id, 'resolve', true, payload, m.user_id, mutation);
      setHead(t, v, payload === null);
    }
    db.run(`UPDATE avb_conflicts SET status = 'resolved', resolution = {:res}, resolution_version_id = {:v}, resolved_by = {:by},
      resolved_at = {:at} WHERE conflict_id = {:id}`, { res, v: v == null ? null : v, by: m.user_id, at: now(), id: c.conflict_id });
    touch(t);
    return resultFor(t.target_id, { status: 'resolved', conflict_id: c.conflict_id, version_id: v == null ? null : v });
  }

  // ---------------------------------------------------------------- entry points

  function syncApply(m, req) {
    checkKeys(req, ['protocol_version', 'mutation_id', 'operations'], 'request');
    checkProtocol(req);
    if (spacedBytes(req) > 2097152) fail('request_too_large');
    const mid = uuidField(req, 'mutation_id');
    const ops = req.operations;
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 500) fail('invalid_operations', 'array of 1 to 500');
    const hash = sha256(canon(req));

    const prev = one(`SELECT json_object('actor_id', actor_id, 'request_hash', request_hash, 'response', response) AS j
      FROM avb_mutations WHERE mutation_id = {:id}`, { id: mid });
    if (prev) {
      if (prev.actor_id !== m.user_id || prev.request_hash !== hash) fail('mutation_id_reused', mid);
      return JSON.parse(prev.response);
    }

    const seen = {};
    const results = [];
    ops.forEach((op, i) => {
      if (!isObj(op)) fail('not_an_object', 'operation');
      // The target each op actually touches; a resolution counts as its conflict's target.
      let mark;
      if (op.op === 'resolve_conflict') {
        const c = conflictById(uuidField(op, 'conflict_id'));
        const t = c && byId(c.target_id);
        mark = t ? t.target_type + '/' + t.target_key : null;
      } else if (op.op === 'delete_assignment' || op.op === 'restore_assignment') mark = 'assignment/' + op.assignment_key;
      else mark = op.type + '/' + op.key;
      if (mark !== null && has(seen, mark)) fail('duplicate_target_in_batch', mark);
      if (mark !== null) seen[mark] = true;
      let r;
      switch (op.op) {
        case 'create': case 'update': case 'delete': case 'restore': r = applyTargetOp(m, mid, op); break;
        case 'delete_assignment': r = applyDeleteAssignment(m, mid, op); break;
        case 'restore_assignment': r = applyRestoreAssignment(m, mid, op); break;
        case 'resolve_conflict': r = applyResolve(m, mid, op); break;
        default: fail('unknown_op', op.op);
      }
      results.push(Object.assign({ index: i, op: op.op }, r));
    });

    const response = { protocol_version: 1, mutation_id: mid, results };
    db.run(`INSERT INTO avb_mutations (mutation_id, actor_id, request_hash, response, created_at)
      VALUES ({:id}, {:actor}, {:hash}, {:resp}, {:at})`, { id: mid, actor: m.user_id, hash, resp: JSON.stringify(response), at: now() });
    return response;
  }

  function syncPull(m, req) {
    checkKeys(req, ['protocol_version', 'after', 'limit'], 'request');
    checkProtocol(req);
    const after = intField(req, 'after', 0, MAX_SAFE, 0);
    const limit = intField(req, 'limit', 1, 500, 200);
    const rows = db.all(`SELECT json_object('target_type', t.target_type, 'target_key', t.target_key, 'assignment_key', t.assignment_key,
        'change_seq', t.change_seq, 'head_version_id', t.head_version_id, 'deleted', t.deleted, 'aggregate_rev', t.aggregate_rev,
        'payload', json(v.payload), 'updated_by', v.actor_id, 'updated_at', v.created_at,
        'open_conflicts', (SELECT count(*) FROM avb_conflicts c WHERE c.target_id = t.target_id AND c.status = 'open')) AS j
      FROM avb_targets t LEFT JOIN avb_versions v ON v.version_id = t.head_version_id
      WHERE t.change_seq > {:after} ORDER BY t.change_seq LIMIT {:n}`, { after, n: limit + 1 });
    const items = rows.slice(0, limit).map((r) => Object.assign(r, { deleted: !!r.deleted }));
    return { protocol_version: 1, items, next_cursor: items.length ? items[items.length - 1].change_seq : after, has_more: rows.length > limit };
  }

  const versionJson = (id) => {
    const v = version(id);
    if (!v) return null;
    return { version_id: v.version_id, action: v.action, accepted: v.accepted, parent_version_id: v.parent_version_id, payload: v.payload,
      actor_id: v.actor_id, mutation_id: v.mutation_id, created_at: v.created_at, version_seq: v.version_seq };
  };

  function targetHistory(m, req) {
    checkKeys(req, ['protocol_version', 'type', 'key', 'before', 'limit'], 'request');
    checkProtocol(req);
    const t = typeof req.type === 'string' && typeof req.key === 'string' ? byKey(req.type, req.key) : null;
    if (!t) fail('target_not_found');
    const limit = intField(req, 'limit', 1, 100, 50);
    const before = intField(req, 'before', 1, MAX_SAFE, MAX_SAFE);
    const rows = db.all(`SELECT json_object('version_id', version_id, 'version_seq', version_seq) AS j FROM avb_versions
      WHERE target_id = {:t} AND version_seq < {:before} ORDER BY version_seq DESC LIMIT {:n}`, { t: t.target_id, before, n: limit + 1 });
    const page = rows.slice(0, limit);
    const more = rows.length > limit;
    return { protocol_version: 1, items: page.map((r) => versionJson(r.version_id)),
      next_before: more ? page[page.length - 1].version_seq : null, has_more: more };
  }

  /** Every accepted change by anyone, newest first, each with the value it replaced. */
  function recentHistory(m, req) {
    checkKeys(req, ['protocol_version', 'before', 'limit'], 'request');
    checkProtocol(req);
    const limit = intField(req, 'limit', 1, 100, 50);
    const before = intField(req, 'before', 1, MAX_SAFE, MAX_SAFE);
    const rows = db.all(`SELECT json_object('version_seq', v.version_seq, 'target_type', t.target_type, 'target_key', t.target_key,
        'assignment_key', t.assignment_key, 'action', v.action, 'created_at', v.created_at, 'actor_id', v.actor_id,
        'actor_name', COALESCE(NULLIF(mem.display_name, ''), NULLIF(u.name, ''), ''), 'payload', json(v.payload), 'previous', json(p.payload)) AS j
      FROM avb_versions v JOIN avb_targets t ON t.target_id = v.target_id
        LEFT JOIN avb_versions p ON p.version_id = v.parent_version_id
        LEFT JOIN avb_members mem ON mem.user = v.actor_id LEFT JOIN users u ON u.id = v.actor_id
      WHERE v.accepted = 1 AND t.target_type IN ('assignment', 'session', 'report_record') AND v.version_seq < {:before} ORDER BY v.version_seq DESC LIMIT {:n}`, { before, n: limit + 1 });
    const page = rows.slice(0, limit);
    const more = rows.length > limit;
    return { protocol_version: 1, items: page, next_before: more ? page[page.length - 1].version_seq : null, has_more: more };
  }

  function conflictsList(m, req) {
    checkKeys(req, ['protocol_version', 'status', 'assignment_key', 'after', 'limit'], 'request');
    checkProtocol(req);
    const status = has(req, 'status') && req.status !== null ? req.status : 'open';
    if (['open', 'resolved', 'all'].indexOf(status) < 0) fail('invalid_status', status);
    const assignment = has(req, 'assignment_key') ? uuidField(req, 'assignment_key') : null;
    const after = intField(req, 'after', 0, MAX_SAFE, 0);
    const limit = intField(req, 'limit', 1, 100, 50);
    const rows = db.all(`SELECT json_object('conflict_id', c.conflict_id, 'conflict_seq', c.conflict_seq, 'kind', c.kind, 'status', c.status,
        'target_type', t.target_type, 'target_key', t.target_key, 'assignment_key', t.assignment_key, 'created_at', c.created_at,
        'resolution', c.resolution, 'resolved_by', c.resolved_by, 'resolved_at', c.resolved_at,
        'resolution_version_id', c.resolution_version_id, 'base_version_id', c.base_version_id, 'detected_head_id', c.detected_head_id,
        'incoming_version_id', c.incoming_version_id, 'head_version_id', t.head_version_id, 'target_deleted', t.deleted) AS j
      FROM avb_conflicts c JOIN avb_targets t ON t.target_id = c.target_id
      WHERE c.conflict_seq > {:after} AND ({:status} = 'all' OR c.status = {:status})
        AND ({:a} IS NULL OR t.assignment_key = {:a})
      ORDER BY c.conflict_seq LIMIT {:n}`, { after, status, a: assignment, n: limit + 1 });
    const page = rows.slice(0, limit);
    const items = page.map((p) => {
      const a = assignmentOf(p.assignment_key);
      return { conflict_id: p.conflict_id, conflict_seq: p.conflict_seq, kind: p.kind, status: p.status, target_type: p.target_type,
        target_key: p.target_key, assignment_key: p.assignment_key, created_at: p.created_at, resolution: p.resolution,
        resolved_by: p.resolved_by, resolved_at: p.resolved_at, resolution_version_id: p.resolution_version_id,
        base: versionJson(p.base_version_id), detected_head: versionJson(p.detected_head_id), incoming: versionJson(p.incoming_version_id),
        current_head: versionJson(p.head_version_id), target_deleted: !!p.target_deleted, assignment_rev: a ? a.aggregate_rev : null };
    });
    return { protocol_version: 1, items, next_cursor: page.length ? page[page.length - 1].conflict_seq : after, has_more: rows.length > limit };
  }

  const me = (m) => ({ protocol_version: 1, user_id: m.user_id, role: m.role, display_name: m.display_name });
  const teamMembers = () => db.all(`SELECT json_object('user_id', mem.user, 'display_name', COALESCE(NULLIF(mem.display_name, ''), NULLIF(u.name, ''), ''), 'role', mem.role, 'is_active', mem.is_active) AS j
    FROM avb_members mem LEFT JOIN users u ON u.id = mem.user ORDER BY COALESCE(NULLIF(mem.display_name, ''), NULLIF(u.name, ''), ''), mem.user`).map((x) => Object.assign(x, { display_name: x.display_name || '', is_active: !!x.is_active }));

  const CALLS = { avb_me: me, avb_team_members: teamMembers, avb_sync_apply: syncApply, avb_sync_pull: syncPull,
    avb_conflicts: conflictsList, avb_target_history: targetHistory, avb_recent_history: recentHistory };

  /** One RPC for `userId` (the verified token's record id). `body` is the parsed request body: { p_request }. */
  function call(name, userId, body) {
    if (!has(CALLS, name)) fail('unknown_op', name);
    const m = member(userId);
    if (name === 'avb_me' || name === 'avb_team_members') return CALLS[name](m);
    if (!isObj(body)) fail('not_an_object', 'request');
    return CALLS[name](m, body.p_request);
  }

  return { call };
}

/** The HTTP answer for a thrown error: PostgREST's shape, which the app's client classifies. */
function errorResponse(err) {
  if (err instanceof AvbError || (err && typeof err.code === 'string' && /^avb:/.test(err.message || ''))) {
    return { status: err.state === '42501' ? 403 : 400, body: { code: err.state, message: 'avb:' + err.code, details: err.detail } };
  }
  if (err && /SQLITE_BUSY|database is locked/i.test(String(err.message || err))) {
    return { status: 503, body: { code: '55P03', message: 'busy', details: null } };
  }
  return { status: 500, body: { code: 'XX000', message: 'error', details: null } };
}

// Plain tables, not PocketBase collections: the PocketBase API never exposes them, and only
// the avb routes (avb.pb.js) read or write them. Versions, mutations and the member audit are append-only.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS avb_targets (
    target_id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL CHECK (target_type IN ('assignment', 'session', 'source_line', 'source_skip', 'city',
      'report_record', 'team_defaults', 'team_starts', 'learned_title', 'learned_place')),
    target_key TEXT NOT NULL,
    assignment_key TEXT,
    head_version_id TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    aggregate_rev INTEGER,
    change_seq INTEGER NOT NULL,
    UNIQUE (target_type, target_key),
    CHECK ((target_type = 'assignment') = (aggregate_rev IS NOT NULL)),
    CHECK ((target_type IN ('assignment', 'session', 'source_line', 'source_skip')) = (assignment_key IS NOT NULL)))`,
  'CREATE INDEX IF NOT EXISTS avb_targets_seq ON avb_targets (change_seq)',
  'CREATE INDEX IF NOT EXISTS avb_targets_assignment ON avb_targets (assignment_key)',
  `CREATE TABLE IF NOT EXISTS avb_mutations (
    mutation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS avb_versions (
    version_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id TEXT NOT NULL UNIQUE,
    target_id INTEGER NOT NULL REFERENCES avb_targets (target_id),
    parent_version_id TEXT REFERENCES avb_versions (version_id),
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore', 'resolve')),
    accepted INTEGER NOT NULL,
    payload TEXT,
    actor_id TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    created_at TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS avb_versions_target ON avb_versions (target_id, version_seq)',
  `CREATE TABLE IF NOT EXISTS avb_conflicts (
    conflict_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    conflict_id TEXT NOT NULL UNIQUE,
    target_id INTEGER NOT NULL REFERENCES avb_targets (target_id),
    kind TEXT NOT NULL CHECK (kind IN ('stale_edit', 'delete_vs_edit', 'edit_vs_delete', 'create_collision', 'parent_deleted',
      'assignment_delete_stale')),
    base_version_id TEXT, detected_head_id TEXT, incoming_version_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    resolution TEXT CHECK (resolution IN ('keep_current', 'accept_incoming', 'merged')),
    resolution_version_id TEXT, resolved_by TEXT, resolved_at TEXT, created_at TEXT NOT NULL,
    CHECK ((status = 'resolved') = (resolution IS NOT NULL)))`,
  "CREATE INDEX IF NOT EXISTS avb_conflicts_open ON avb_conflicts (target_id) WHERE status = 'open'",
  `CREATE TABLE IF NOT EXISTS avb_member_audit (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, action TEXT NOT NULL,
    old_role TEXT, new_role TEXT, old_active INTEGER, new_active INTEGER, created_at TEXT NOT NULL)`,
].concat(['avb_versions', 'avb_mutations', 'avb_member_audit'].map((t) =>
  `CREATE TRIGGER IF NOT EXISTS ${t}_append_only BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, 'avb:append_only'); END`))
  .concat(['avb_versions', 'avb_mutations', 'avb_member_audit'].map((t) =>
    `CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'avb:append_only'); END`));

module.exports = { createCore, errorResponse, AvbError, SPEC, SCHEMA, canon, spacedBytes };

/** A random v4 UUID from PocketBase's $security helpers (the JS VM has no crypto.randomUUID). */
function pbUuid(security) {
  const h = security.randomStringWithAlphabet(32, '0123456789abcdef');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-' + '89ab'[parseInt(h[16], 16) & 3] + h.slice(17, 20) + '-' + h.slice(20);
}

/** Who changed a membership, from what to what: written in the same transaction as the change. */
function auditMember(app, action, before, after) {
  const rec = after || before;
  app.db().newQuery(`INSERT INTO avb_member_audit (user_id, action, old_role, new_role, old_active, new_active, created_at)
    VALUES ({:u}, {:a}, {:or}, {:nr}, {:oa}, {:na}, {:at})`).bind({
    u: rec.getString('user'), a: action,
    or: before ? before.getString('role') : null, nr: after ? after.getString('role') : null,
    oa: before ? (before.getBool('is_active') ? 1 : 0) : null, na: after ? (after.getBool('is_active') ? 1 : 0) : null,
    at: new Date().toISOString(),
  }).execute();
}

module.exports.pbUuid = pbUuid;
module.exports.auditMember = auditMember;

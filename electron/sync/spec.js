'use strict';
// The server's payload rules (supabase/migrations/…_av_backup_sync_v1.sql, payload_spec,
// validate_payload, check_target), checked here BEFORE anything is queued: one bad
// value refuses a whole batch on the server. tests/sync-spec.test.js compares this
// table with the migration's, so the two cannot drift apart silently.

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
    geo: ['text_null', 300, false], startedAt: ['timestamp_null', 0, false] },
  source_line: { line: ['int', 99999, true], part: ['int', 9999, true], cells: ['cells', 256, true], continuesCell: ['bool', 0, true] },
  source_skip: { index: ['int', 99999, true], days: ['date_list', 366, true], reason: ['text', 32, true], rowText: ['text', 32768, true] },
  city: { name: ['text', 300, true], city: ['text', 200, true], state: ['text', 200, false], country: ['text', 200, false] },
  report_record: {
    id: ['text', 300, true], folder: ['scalar', 32, false], format: ['text', 16, false], session: ['scalar', 32, false],
    author: ['text', 64, false], type: ['text', 32, false], date: ['date_null', 0, false], duration: ['scalar', 32, false],
    activity: ['text', 200, false], place: ['text', 500, false], topic: ['text', 1000, false], clips: ['scalar', 32, false],
    cameras: ['scalar', 32, false], events: ['list', 200, false], languages: ['list', 100, false],
    city: ['text', 200, false], state: ['text', 200, false], country: ['text', 200, false] },
  team_defaults: { author: ['text', 64, false], format: ['text', 16, false], camsFormal: ['scalar', 32, false], camsInformal: ['scalar', 32, false] },
  team_starts: { formal: ['scalar', 32, false], informal: ['scalar', 32, false] },
  learned_title: { key: ['text', 300, true], topic: ['text', 1000, false], type: ['text', 32, false], activity: ['text', 200, false],
    events: ['list', 200, false], languages: ['list', 100, false] },
  learned_place: { key: ['text', 300, true], place: ['text', 500, false], city: ['text', 200, false], languages: ['list', 100, false] },
};
const TYPES = Object.keys(SPEC);
const CHILD_TYPES = new Set(['session', 'source_line', 'source_skip']);
const MAX_PAYLOAD = 32768, MAX_REQUEST = 2097152, MAX_OPS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const chars = (s) => [...s].length;   // char_length counts code points
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const validTime = (s) => /^\d{4}-\d{2}-\d{2}T/.test(s) && validDate(s.slice(0, 10)) && !Number.isNaN(Date.parse(s));

/** The bytes of jsonb's text form (`{"a": 1, "b": [1, 2]}`), which is what the 32 KiB limit measures. */
function jsonbBytes(v) {
  if (Array.isArray(v)) return 2 + v.reduce((n, x) => n + jsonbBytes(x), 0) + Math.max(0, v.length - 1) * 2;
  if (isObj(v)) {
    const ks = Object.keys(v).filter((k) => v[k] !== undefined);
    return 2 + ks.reduce((n, k) => n + Buffer.byteLength(JSON.stringify(k)) + 2 + jsonbBytes(v[k]), 0) + Math.max(0, ks.length - 1) * 2;
  }
  return Buffer.byteLength(JSON.stringify(v === undefined ? null : v));
}

function fieldOk(kind, max, v) {
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  switch (kind) {
    case 'text': return t === 'string' && chars(v) <= max;
    case 'text_null': return t === 'null' || (t === 'string' && chars(v) <= max);
    case 'scalar': return t === 'null' || (t === 'number' && Number.isFinite(v)) || (t === 'string' && chars(v) <= max);
    case 'bool': return t === 'boolean';
    case 'order_key': return t === 'string' && /^[0-9A-Za-z]{1,64}$/.test(v);
    case 'basename': return t === 'string' && chars(v) <= max && !/[/\\]/.test(v) && !/^[A-Za-z]:/.test(v);
    case 'date_null': return t === 'null' || (t === 'string' && (v === '' || validDate(v)));
    case 'timestamp_null': return t === 'null' || (t === 'string' && validTime(v));
    case 'int': return t === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
    case 'cells': return t === 'array' && v.length <= max && v.every((e) => typeof e === 'string');
    case 'date_list': return t === 'array' && v.length >= 1 && v.length <= max && v.every((e) => typeof e === 'string' && validDate(e));
    case 'list': return t === 'array' && v.length <= 64 && v.every((e) => typeof e === 'string' && chars(e) <= max);
    case 'text_map': return t === 'object' && Object.keys(v).length <= 32
      && Object.entries(v).every(([k, x]) => chars(k) <= 64 && typeof x === 'string' && chars(x) <= max);
    default: return false;
  }
}

/** Problems with one payload, as [{field, code}]; [] means the server would take it. */
function payloadProblems(type, payload, top = true) {
  const spec = SPEC[type];
  if (!spec) return [{ field: type, code: 'unknown_target_type' }];
  if (!isObj(payload)) return [{ field: type, code: 'payload_required' }];
  const out = [];
  if (top && jsonbBytes(payload) > MAX_PAYLOAD) out.push({ field: type, code: 'payload_too_large' });
  for (const k of Object.keys(payload)) if (!spec[k]) out.push({ field: `${type}.${k}`, code: 'unknown_field' });
  for (const [k, [kind, max, req]] of Object.entries(spec)) {
    if (!(k in payload)) { if (req) out.push({ field: `${type}.${k}`, code: 'missing_field' }); continue; }
    if (kind === 'nested') out.push(...payloadProblems(max, payload[k], false));
    else if (!fieldOk(kind, max, payload[k])) out.push({ field: `${type}.${k}`, code: 'invalid_field' });
  }
  return out;
}

/** The key a target must be filed under (check_target). */
function keyProblem(type, key, payload) {
  if (typeof key !== 'string') return 'invalid_key';
  const a = key.split(':')[0];
  switch (type) {
    case 'assignment': case 'session': return UUID.test(key) ? null : 'invalid_key';
    case 'source_line': return /^[0-9a-f-]{36}:\d{1,5}:\d{1,4}$/.test(key) && UUID.test(a)
      && (!payload || key === `${a}:${payload.line}:${payload.part}`) ? null : 'invalid_key';
    case 'source_skip': return /^[0-9a-f-]{36}:\d{1,5}$/.test(key) && UUID.test(a)
      && (!payload || key === `${a}:${payload.index}`) ? null : 'invalid_key';
    case 'team_defaults': case 'team_starts': return key === 'team' ? null : 'invalid_key';
    case 'city': case 'learned_title': case 'learned_place': case 'report_record': {
      const want = naturalKey(type, payload) ?? key;
      return key === want && chars(key) >= 1 && chars(key) <= 300 ? null : 'invalid_key';
    }
    default: return 'unknown_target_type';
  }
}

// Postgres btrim() trims spaces only; lower/upper as JS's for these labels.
function naturalKey(type, payload) {
  if (!payload) return null;
  const f = { city: 'name', report_record: 'id', learned_title: 'key', learned_place: 'key' }[type];
  if (!f || typeof payload[f] !== 'string') return null;
  const v = payload[f].replace(/^ +| +$/g, '');
  return type === 'report_record' ? v.toUpperCase() : v.toLowerCase();
}

module.exports = { SPEC, TYPES, CHILD_TYPES, MAX_PAYLOAD, MAX_REQUEST, MAX_OPS, UUID, jsonbBytes, payloadProblems, keyProblem, naturalKey, chars };

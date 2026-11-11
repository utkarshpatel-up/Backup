/// <reference path="../pb_data/types.d.ts" />
// AV Backup team sync routes. The app calls POST /api/avb/rpc/<name> with the user's PocketBase
// auth token and a body of { "p_request": … }; the rules are in avb_core.js. Each handler runs
// in its own JS context, so everything it needs is required inside it.

routerAdd('POST', '/api/avb/rpc/{name}', (e) => {
  const core = require(`${__hooks}/avb_core.js`);
  let body;
  try {
    body = JSON.parse(toString(e.request.body) || '{}');
  } catch (_) {
    return e.json(400, { code: 'P0001', message: 'avb:not_an_object', details: 'request' });
  }
  const name = e.request.pathValue('name');
  const userId = e.auth ? e.auth.id : '';
  let out, failure = null;
  try {
    // One transaction per call: SQLite has one writer at a time, so commit order equals
    // change_seq order, and a failed call leaves nothing behind.
    e.app.runInTransaction((tx) => {
      const db = {
        all: (sql, params) => {
          const rows = arrayOf(new DynamicModel({ j: '' }));
          tx.db().newQuery(sql).bind(params).all(rows);
          return rows.map((r) => JSON.parse(r.j));
        },
        run: (sql, params) => { tx.db().newQuery(sql).bind(params).execute(); },
      };
      try {
        out = core.createCore({ db, uuid: () => core.pbUuid($security), now: () => new Date().toISOString(),
          sha256: (s) => $security.sha256(s) }).call(name, userId, body);
      } catch (err) { failure = err; throw err; }
    });
  } catch (err) { if (!failure) failure = err; }
  if (failure) {
    const r = core.errorResponse(failure);
    if (r.status >= 500) e.app.logger().error('avb call failed', 'rpc', name, 'error', String(failure));
    return e.json(r.status, r.body);
  }
  return e.json(200, out);
}, $apis.requireAuth('users'), $apis.bodyLimit(4 << 20));

// Every membership change made in the dashboard is written to avb_member_audit (append-only).
onRecordCreate((e) => {
  e.next();
  require(`${__hooks}/avb_core.js`).auditMember(e.app, 'INSERT', null, e.record);
}, 'avb_members');

onRecordUpdate((e) => {
  const before = e.record.original();
  e.next();
  require(`${__hooks}/avb_core.js`).auditMember(e.app, 'UPDATE', before, e.record);
}, 'avb_members');

onRecordDelete((e) => {
  e.next();
  require(`${__hooks}/avb_core.js`).auditMember(e.app, 'DELETE', e.record, null);
}, 'avb_members');

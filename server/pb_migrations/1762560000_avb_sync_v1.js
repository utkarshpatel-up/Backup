/// <reference path="../pb_data/types.d.ts" />
// AV Backup team sync, protocol v1: the sync tables (plain SQLite tables the PocketBase API
// never exposes) and the avb_members collection, which only a superuser can read or edit.
migrate((app) => {
  const { SCHEMA } = require(`${__hooks}/avb_core.js`);
  for (const sql of SCHEMA) app.db().newQuery(sql).execute();

  const users = app.findCollectionByNameOrId('users');
  const members = new Collection({
    type: 'base',
    name: 'avb_members',
    // null rules: superusers only. The app reads membership through /api/avb, never directly.
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: 'user', type: 'relation', required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: false },
      { name: 'role', type: 'select', required: true, maxSelect: 1, values: ['operator', 'admin'] },
      { name: 'is_active', type: 'bool' },
      { name: 'display_name', type: 'text', max: 200 },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_avb_members_user ON avb_members (user)'],
  });
  app.save(members);
}, (app) => {
  app.delete(app.findCollectionByNameOrId('avb_members'));
  for (const t of ['avb_conflicts', 'avb_versions', 'avb_mutations', 'avb_targets', 'avb_member_audit']) {
    app.db().newQuery(`DROP TABLE IF EXISTS ${t}`).execute();
  }
});

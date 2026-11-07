'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const calls = [], state = { schedules: { openId: null, items: [] } };
  let rev = 10;
  const account = { mode: 'account', phase: 'online', signedIn: true, locked: false, user: { role: 'operator' } };
  const api = { getSettings: async () => ({}), setSettings: async (...args) => calls.push(['settings', ...args]),
    getStore: async () => ({ items: [] }), setStore: async (...args) => calls.push(['store', ...args]),
    confirm: async () => false,
    sync: { status: async () => account, onStatus: () => {},
      view: async () => ({ signedIn: true, rev: ++rev, data: { schedules: { items: [], openId: null }, team: {}, cities: [], report: [] } }),
      commit: async (c) => { calls.push(['commit', c]); return { ok: true, rev: ++rev }; },
      protect: async (p) => calls.push(['protect', p]),
      importLocal: async (...args) => { calls.push(['import', ...args]); return { ok: true, counts: { schedules: 1, rows: 2 }, warnings: [] }; },
    } };
  const c = vm.createContext({ window: { api, VIngestSchedule: require('../renderer/schedule-logic') }, state, crypto,
    setTimeout, clearTimeout, console, document: { activeElement: null, addEventListener() {}, querySelectorAll: () => [] },
    render() {}, toast() {}, esc: (x) => String(x ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    call: async () => ({ rows: [] }), $: () => null });
  for (const file of ['schedule-ui.js', 'report-ui.js', 'sync-ui.js']) vm.runInContext(fs.readFileSync(`renderer/${file}`, 'utf8'), c);
  const run = (s) => vm.runInContext(s, c);
  c.account = account;
  run('syncUI.status = account; syncUI.rev = 10;');
  return { c, state, api, calls, run };
}
test('local-mode save still writes only local schedules', async () => {
  const f = fixture(); f.run("syncUI.status = {mode:'local'}");
  await f.run('scheduleFlush()');
  assert.equal(f.calls[0][0], 'store'); assert.equal(f.calls.some((c) => c[0] === 'commit'), false);
});
test('remote views wait for dirty edits, focused input, debounce and busy backup', async () => {
  const f = fixture(); let views = 0;
  f.api.sync.view = async () => { views++; return { signedIn: false }; };
  for (const setup of ['syncUI.dirty=true', 'document.activeElement={tagName:"INPUT"}', 'state.busy={}', 'state.scheduleRun={}', 'syncUI.preparing=true', 'state.schedules.items=[{busy:true}]']) {
    f.run('syncUI.dirty=false; document.activeElement=null; state.busy=null; state.scheduleRun=null; syncUI.preparing=false; state.schedules.items=[]');
    f.run(setup); await f.run('syncRefresh()'); assert.equal(views, 0);
  }
  f.run('state.schedules.items=[]; scheduleRemember()');
  await f.run('syncRefresh()'); assert.equal(views, 0);
  await f.run('scheduleFlush()');
});
test('a view requested while clean is rejected if an edit arrives during IPC', async () => {
  const f = fixture(), d = deferred(); f.api.sync.view = () => d.promise;
  const pending = f.run('syncRefresh()'); f.run('syncUI.dirty=true');
  d.resolve({ signedIn: true, rev: 99, data: { schedules: {items: []} } });
  await pending; assert.equal(f.run('syncUI.rev'), 10);
});
test('commits serialize snapshots and use own returned revision, never a remote status base', async () => {
  const f = fixture(), d = deferred(); let count = 0;
  f.api.sync.commit = async (c) => { f.calls.push(c); if (++count === 1) await d.promise; return { ok: true, rev: 10 + count }; };
  f.state.schedules.items = [{ id: crypto.randomUUID(), sessions: [{ key: 1, title: 'first' }] }];
  const first = f.run('scheduleFlush()');
  f.state.schedules.items[0].sessions[0].title = 'latest';
  const second = f.run('scheduleFlush()'); await Promise.resolve();
  d.resolve(); await first; await second;
  assert.equal(f.calls[0].baseRev, 10); assert.equal(f.calls[1].baseRev, 11);
  assert.equal(f.calls[0].snapshot.schedules.items[0].sessions[0].title, 'first');
  assert.equal(f.calls[1].snapshot.schedules.items[0].sessions[0].title, 'latest');
  assert.match(f.calls[0].snapshot.schedules.items[0].sessions[0].uid, /^[\da-f-]{36}$/);
});
test('shutdown flush drains debounce and failed commit keeps dirty state', async () => {
  const f = fixture(); f.api.sync.commit = async () => { throw new Error('disk'); };
  f.run('scheduleRemember()'); await assert.rejects(f.run('scheduleFlush()'));
  assert.equal(f.run('scheduleRememberTimer'), null); assert.equal(f.run('syncUI.dirty'), true);
  assert.equal(f.calls.some((c) => c[0] === 'store'), false);
});
test('signed-out or locked account never falls back to local stores or report preload', async () => {
  const f = fixture(); f.run('syncUI.status.signedIn=false; syncUI.rev=null');
  let reads = 0; f.api.getSettings = async () => { reads++; return { reportSource: '/private.xlsx' }; };
  await f.run('reportPreload()'); await f.run('scheduleFlush()');
  assert.equal(reads, 0); assert.equal(f.calls.length, 0);
  f.state.report = { existing: [{ id: 'private' }] }; f.state.cities = [{ city: 'private' }];
  await f.run('syncStatus({mode:"account",signedIn:true,locked:true})');
  assert.equal(f.state.report, null);
  assert.equal(JSON.stringify(f.state.cities || []).includes('private'), false, 'the cached list is gone');
});
test('account transitions flush before clearing and block during prepared backup', async () => {
  const f = fixture(); let switched = false;
  f.c.change = async () => { switched = true; assert.equal(f.calls[0][0], 'commit'); };
  f.run('state.scheduleRun={}'); await assert.rejects(f.run('syncTransition(change)')); assert.equal(switched, false);
  f.run('state.scheduleRun=null'); await f.run('syncTransition(change)'); assert.equal(switched, true);
});
test('backup protection is durable before protect and captures the displayed base', async () => {
  const f = fixture(); f.state.schedules.items = [{id:crypto.randomUUID(),sessions:[{key:1}]}];
  await f.run('syncProtect(state.schedules.items[0],state.schedules.items[0].sessions[0])');
  assert.equal(f.calls[0][0], 'commit'); assert.equal(f.calls[1][0], 'protect');
  assert.equal(f.run('syncUI.backupBase'), 11);
  f.run('syncUI.rev=12'); await f.run('syncCommit(syncUI.backupBase)');
  assert.equal(f.calls[2][1].baseRev, 11);
});
test('operators cannot delete whole schedules; an admin can when online and idle', () => {
  const f = fixture(); assert.equal(f.run('syncCanDelete()'), false);
  f.run('syncUI.status.user={role:"admin"}'); assert.equal(f.run('syncCanDelete()'), true);
  f.run('syncUI.status.phase="offline"'); assert.equal(f.run('syncCanDelete()'), false, 'never from a cached role offline');
  f.run('syncUI.status.phase="online"; state.busy={}'); assert.equal(f.run('syncCanDelete()'), false);
  f.run('state.scheduleRun={}'); assert.equal(f.run('syncCanDelete()'), false);
});
test('local import previews and never confirms without explicit approval', async () => {
  const f = fixture(); await f.run('syncImport()');
  assert.deepEqual(f.calls.filter((c) => c[0] === 'import').map((c) => c[1]), [false]);
  f.calls.length = 0; f.api.confirm = async () => true;
  await f.run('syncImport()');
  assert.deepEqual(f.calls.filter((c) => c[0] === 'import').map((c) => c[1]), [false, true]);
});
test('conflict alternatives are escaped text rather than remote HTML', () => {
  const f = fixture(); f.run('syncUI.conflicts=[{schedule:"<img src=x>",current:{payload:{title:"<script>bad</script>"}}}]');
  const html = f.run('renderSyncPage()');
  assert.equal(html.includes('<script>bad'), false); assert.equal(html.includes('<img src=x>'), false);
  assert.equal(html.includes('Keep current'), true); assert.equal(html.includes('Accept incoming'), true);
});
test('revocation flushes unsaved edits into the locked cache before clearing visible data', async () => {
  const f = fixture(); f.state.schedules.items = [{ id: crypto.randomUUID(), sessions: [{ key: 1, topic: 'unsaved' }] }];
  f.run('scheduleRemember()');
  await f.run('syncStatus({mode:"account",signedIn:true,locked:true})');
  assert.equal(f.calls[0][0], 'commit');
  assert.equal(f.calls[0][1].snapshot.schedules.items[0].sessions[0].topic, 'unsaved');
  assert.equal(f.state.schedules.items.length, 0);
});
test('busy snapshots explicitly exclude busy schedules and copied rows get new identities', async () => {
  const f = fixture(); const uid = crypto.randomUUID();
  const item = {id:crypto.randomUUID(), busy:'reading', sessions: [{key:1,uid,startedAt:'2026-01-01T00:00:00Z',flags:{}}]};
  f.state.schedules.items=[item]; f.state.schedule=item;
  f.run('scheduleFocusRow=()=>{}');
  f.run('scheduleAddRow(1)');
  assert.notEqual(item.sessions[1].uid, uid); assert.equal(item.sessions[1].startedAt, undefined);
  await f.run('scheduleFlush()'); assert.equal(f.calls[0][1].busy[0],item.id);
});
test('prepared backup blocks remote replacements and row deletion', async () => {
  const f = fixture(); const s={id:crypto.randomUUID(),sessions:[{key:1,uid:crypto.randomUUID(),flags:{}}]};
  f.state.schedules.items=[s];f.state.schedule=s;f.state.scheduleRun={scheduleId:s.id,key:1};
  await f.run('scheduleDeleteRows([1])'); await f.run('syncRefresh()');
  assert.equal(s.sessions.length,1);assert.equal(f.state.schedule,s);
});
test('import preview carries renderer-parsed local XLSX records through confirmation', async () => {
  const f = fixture();
  f.api.getSettings=async()=>({reportSource:'/local/report.xlsx'});
  f.c.call=async(name,params)=>{assert.equal(name,'schedule_read_table');assert.equal(params.path,'/local/report.xlsx');return {rows:[['Raw Video Id','Date'],['DD-F-HD-2400-M','01/10/2026']]};};
  f.api.confirm=async()=>true; await f.run('syncImport()');
  const imports=f.calls.filter(c=>c[0]==='import');
  assert.equal(imports.length,2);assert.equal(imports[0][2][0].id,'DD-F-HD-2400-M');
  assert.deepEqual(imports[0][2],imports[1][2]);
});
test('async import/edit operations block view replacement and account switching until settled', async () => {
  const f=fixture(),d=deferred();f.c.operation=()=>d.promise;
  const pending=f.run('syncOperation(operation)');
  assert.equal(f.run('syncBusy()'),true);
  await f.run('syncRefresh()'); assert.equal(f.run('syncUI.rev'),10);
  f.c.change=async()=>{}; await assert.rejects(f.run('syncTransition(change)'));
  d.resolve();await pending;assert.equal(f.run('syncUI.operations'),0);
});
test('snapshots retain source lines, skip details, geo and historical start timestamps', async () => {
  const f=fixture(); const s={id:crypto.randomUUID(),rows:[['original'],['changed line']],read:{skipped:[{days:['2026-11-07'],reason:'travel',rowText:'Travel'}]},sessions:[{key:1,uid:crypto.randomUUID(),geo:'Pune city record',startedAt:'2020-01-01T00:00:00Z'}],starts:{}};
  f.state.schedules.items=[s];await f.run('scheduleFlush()');
  const saved=f.calls[0][1].snapshot.schedules.items[0];
  assert.deepEqual(JSON.parse(JSON.stringify(saved.rows)),s.rows);assert.deepEqual(JSON.parse(JSON.stringify(saved.read)),s.read);
  await f.run('syncProtect(state.schedules.items[0],state.schedules.items[0].sessions[0])');
  assert.equal(s.sessions[0].startedAt,'2020-01-01T00:00:00Z');assert.equal(s.sessions[0].geo,'Pune city record');
});

test('an unloaded report or the built-in city list never reads as deleting the team copy', async () => {
  const f = fixture();
  f.state.report = null; f.state.cities = null; f.state.citySource = null;
  f.state.schedules.items = [{ id: crypto.randomUUID(), sessions: [] }];
  vm.runInContext(fs.readFileSync('renderer/schedule-cities.js', 'utf8'), f.c);
  f.c.window.VIngestCityRows = f.c.VIngestCityRows;   // in the app, window is the global object
  f.run('scheduleCities()');   // fills the built-in list, as any city lookup does
  assert.ok(f.state.cities.length > 10);
  await f.run('scheduleFlush()');
  const snap = f.calls.find((c) => c[0] === 'commit')[1].snapshot;
  assert.equal('report' in snap, false, 'no report list: nothing in scope to delete');
  assert.equal('cities' in snap, false, 'built-in cities are not uploaded or used to delete');
  // A view that carries the team's lists makes them part of the snapshot again.
  f.api.sync.view = async () => ({ signedIn: true, rev: 50, data: { schedules: { items: [], openId: null }, team: {},
    cities: [{ name: 'Pune', city: 'Pune', state: 'MH', country: 'India' }], report: [{ id: 'DD-F-HD-1-1' }] } });
  await f.run('syncRefresh()');
  f.calls.length = 0; await f.run('scheduleFlush()');
  const snap2 = f.calls.find((c) => c[0] === 'commit')[1].snapshot;
  assert.equal(snap2.cities.length, 1); assert.equal(snap2.report.length, 1);
  // With no team list, lookups still get the built-in one.
  f.api.sync.view = async () => ({ signedIn: true, rev: 51, data: { schedules: { items: [], openId: null }, team: {}, cities: null, report: null } });
  await f.run('syncRefresh()');
  assert.ok(f.run('scheduleCities().length') > 10);
});
test('a backup start that fails puts the row back as it was, for the team too', async () => {
  const f = fixture();
  const s = { id: crypto.randomUUID(), starts: { formal: 100 }, defaults: {}, sessions: [{ key: 1, uid: crypto.randomUUID(), include: true,
    date: '2026-11-08', type: 'Formal', folder: null, session: null }] };
  f.state.schedules.items = [s];
  const row = s.sessions[0];
  f.c.row = row; f.c.s = s;
  await f.run('syncProtect(s, row, true)');
  assert.ok(row.startedAt); assert.notEqual(row.folder, null);
  f.calls.length = 0;
  await f.run('syncUnprepare()');
  assert.deepEqual(f.calls.map((c) => c[0]), ['protect', 'commit'], 'unprotected first, then saved');
  assert.equal('startedAt' in row, false); assert.equal(row.folder, null); assert.equal(row.session, null);
  const saved = f.calls[1][1].snapshot.schedules.items[0].sessions[0];
  assert.equal(saved.folder, null); assert.equal('startedAt' in saved, false);
  // A start that did set up keeps everything (prepUndo cleared), and an old start time survives an undo.
  row.startedAt = '2020-01-01T00:00:00Z';
  await f.run('syncProtect(s, row, true)');
  f.calls.length = 0; await f.run('syncUnprepare()');
  assert.equal(row.startedAt, '2020-01-01T00:00:00Z');
  await f.run('syncProtect(s, row, false)');
  f.calls.length = 0; await f.run('syncUnprepare()');
  assert.equal(f.calls.length, 0, 'nothing to undo for a Clips-only start');
});

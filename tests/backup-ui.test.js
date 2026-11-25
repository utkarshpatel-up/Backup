'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Expose the selection module on the same window global as a browser.
function setup() {
  const window = { api: { platform: 'win32', onProgress() {}, onStatus() {} } };
  window.VIngestSelection = require('../renderer/selection-logic');
  const context = vm.createContext({ window, console });
  for (const name of ['naming-ui.js', 'app.js']) {
    let code = fs.readFileSync(path.join(__dirname, '..', 'renderer', name), 'utf8');
    if (name === 'app.js') code = code.slice(0, code.indexOf('(async function boot()'));
    vm.runInContext(code, context);
  }
  return (code) => vm.runInContext(code, context);
}

test('informal plan follows ticked clips, or all of them when none are ticked, regardless of filters', () => {
  const run = setup();
  run(`state.backupType = 'informal'; state.informalDest = 'E:/';
    state.template = {session_name: 'Event', job_name: 'Job'};
    state.extraFiles['E:/'] = [{path:'D:/a.MP4',name:'a.MP4',manual:true},
      {path:'D:/b.MP4',name:'b.MP4',manual:true}];
    state.assign = {'D:/a.MP4':1, 'D:/b.MP4':2}; state.selection=['D:/a.MP4'];
    state.cameraFilterCam='2';`);
  // Ticking one clip narrows the plan to just it — the camera filter is irrelevant.
  assert.equal(run('JSON.stringify(buildSpec().targets[0].cams)'), '{"1":["D:/a.MP4"]}');
  // Ticking nothing files every eligible clip.
  run('state.selection=[]');
  assert.equal(run('JSON.stringify(buildSpec().targets[0].cams)'), '{"1":["D:/a.MP4"],"2":["D:/b.MP4"]}');
});

test('the informal card pool ignores a leftover scan of the output drive', () => {
  const run = setup();
  run(`state.backupType = 'informal'; state.informalDest = 'E:/';
    state.template = {session_name: 'Event', job_name: 'Job'};
    // A scan of E: (e.g. from an earlier formal run) sits in state.scans; its
    // root master must never appear as informal camera footage.
    state.scans['E:/'] = {files: [{path:'E:/MASTER.MOV',name:'MASTER.MOV'}]};
    state.extraFiles['E:/'] = [{path:'D:/card.MP4',name:'card.MP4',manual:true}];
    state.assign = {'D:/card.MP4':1};`);
  const names = run("JSON.stringify(cameraFiles(primarySource()).map((f)=>f.name))");
  assert.equal(names, '["card.MP4"]');
});

test('formal backup files every shown clip when nothing is ticked, only ticked ones otherwise', () => {
  const run = setup();
  run(`state.backupType = 'formal';
    state.sources = [{path:'E:/', role:'h265', dest:'E:/'}]; state.masterSource = 'E:/';
    state.extraFiles['E:/'] = [{path:'E:/a.MP4',name:'a.MP4',manual:true},
      {path:'E:/b.MP4',name:'b.MP4',manual:true}];
    state.assign = {'E:/a.MP4':1, 'E:/b.MP4':1}; state.selection = [];`);
  // Nothing ticked → both eligible clips are filed.
  assert.equal(run('selected(primarySource()).length'), 2);
  // Ticking one narrows the backup to just that clip.
  run("state.selection = ['E:/a.MP4']");
  assert.equal(run('selected(primarySource()).length'), 1);
  // A clip explicitly on Skip is never filed, even with nothing ticked.
  run("state.selection = []; state.assign['E:/b.MP4'] = 'skip'");
  assert.equal(run('selected(primarySource()).length'), 1);
});

test('Verify requires successful completion of the current plan', () => {
  const run = setup();
  assert.equal(run('stepReady(4)'), false);
  run('state.plan={}; state.runResult={failed:0,cancelled:false}');
  assert.equal(run('stepReady(4)'), true);
  run('state.runResult.cancelled=true');
  assert.equal(run('stepReady(4)'), false);
  run('state.runResult={failed:1}');
  assert.equal(run('stepReady(4)'), false);
});

test('master lookup uses that source and the selected path survives incomplete scans', () => {
  const run = setup();
  run(`state.sources=[{path:'E:/',role:'h265'}];
    state.masters={'E:/':['E:/selected.MP4']}; state.mastersFiled=true;
    state.template={session_name:'Event'};`);
  assert.equal(run('JSON.stringify(buildSpec().targets[0].masters)'), '["E:/selected.MP4"]');
  run(`state.detected['E:/']={master_candidates:[{path:'E:/selected.MP4',duration:60}]}`);
  assert.equal(run("mastersFor(state.sources[0])[0].duration"), 60);
  assert.match(run('masterRows({items:[],master_present:false})'), /No master selected/);
});

test('character counter becomes red only above 225', () => {
  const run = setup();
  assert.doesNotMatch(run("nameCount('a'.repeat(225))"), /over-limit/);
  assert.match(run("nameCount('a'.repeat(226))"), /over-limit/);
});

test('#42 a schedule backup started after a same-type clips-only job leaves clips-only', () => {
  const run = setup();
  run(`state.backupType = 'formal'; state.clipsOnly = true; state.mastersFiled = true;
    state.filedSessions = {other: 'E:/3064 Job/Old session'}; state.clipsOnlyDate = '2026-11-13';
    state.assign = {'E:/old.MP4': 1};`);
  run(`setBackupType('formal', true);
    state.sources = [{path:'E:/', role:'h265'}, {path:'F:/', role:'prores'}];`);
  assert.equal(run('state.clipsOnly'), false);
  assert.equal(run('JSON.stringify(state.filedSessions)'), '{}');
  assert.equal(run('state.clipsOnlyDate'), null);
  assert.equal(run('JSON.stringify(state.assign)'), '{}');
  // Sources → Folder is open again for the new job's drives.
  assert.equal(run('stepReady(1)'), true);
  // The Formal/Informal toggle still keeps a same-type choice untouched.
  run(`state.assign = {'E:/a.MP4': 2}; setBackupType('formal');`);
  assert.equal(run('JSON.stringify(state.assign)'), '{"E:/a.MP4":2}');
});

test('#41 clips-only knows the session date on first load, and Folder never re-detects it', async () => {
  const run = setup();
  run(`state.backupType = 'formal'; state.clipsOnly = true;
    state.filedSessions = {other: 'E:/3064 Job/Session Dt-13-Nov-26'};
    state.clipsOnlyDate = '2026-11-13';`);
  assert.equal(run('sessionDate()'), '2026-11-13');
  assert.equal(run("defaultAssignmentFor({shoot_date: '2026-11-14'})"), 'skip');
  const calls = [];
  run('window.api').call = async (method) => { calls.push(method); return { ok: true, result: {} }; };
  await run('enterFolderStep()');
  // Detecting would adopt a master and reset the operator's cam assignments.
  assert.deepEqual(calls, []);
});

test('the clip list ticks clips from the keyboard: arrows move, Space ticks, Shift+arrows tick as they go', () => {
  const run = setup();
  // A stand-in page: four clip rows, nothing focused, nothing open.
  run(`var rows = ['a','b','c','d'].map((p) => ({ dataset: { path: p } }));
    var document = { querySelectorAll: (q) => (q === '.rowsel' || q === 'tr[data-path]'
      ? rows.map((r) => ({ ...r, scrollIntoView() {} })) : []), getElementById: () => null };
    render = () => {};
    state.view = 'steps'; state.step = 2; state.busy = null; state.selection = []; state.clipCursor = null;
    var key = (k, shift = false) => clipListKey({ key: k, shiftKey: shift, target: { tagName: 'BODY' },
      preventDefault() {} });`);
  run(`key('ArrowDown'); key(' ');`);                        // first clip highlighted, ticked
  assert.equal(run('state.clipCursor'), 'a');
  assert.equal(run('JSON.stringify(state.selection)'), '["a"]');
  run(`key('ArrowDown'); key('ArrowDown'); key(' ');`);      // skip b, tick c
  assert.equal(run('JSON.stringify(state.selection.sort())'), '["a","c"]');
  run(`key(' ');`);                                          // Space again unticks
  assert.equal(run('JSON.stringify(state.selection)'), '["a"]');
  run(`key('ArrowUp', true); key('ArrowUp', true);`);        // Shift+Up from c ticks c, b, a
  assert.equal(run('JSON.stringify(state.selection.sort())'), '["a","b","c"]');
  run(`key('End');`);
  assert.equal(run('state.clipCursor'), 'd');
  // Typing in a filter box is left alone.
  run(`clipListKey({ key: ' ', target: { tagName: 'INPUT', type: 'text', classList: { contains: () => false } },
    preventDefault() { throw new Error('should not handle'); } });`);
  // Other pages are left alone.
  run(`state.step = 1; key(' ');`);
  assert.equal(run('JSON.stringify(state.selection.sort())'), '["a","b","c"]');
});

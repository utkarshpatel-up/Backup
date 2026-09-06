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

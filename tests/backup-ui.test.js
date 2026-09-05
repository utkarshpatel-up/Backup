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

test('only checked camera clips reach an informal plan, regardless of filters', () => {
  const run = setup();
  run(`state.backupType = 'informal'; state.informalDest = 'E:/';
    state.template = {session_name: 'Event', job_name: 'Job'};
    state.extraFiles['E:/'] = [{path:'D:/a.MP4',name:'a.MP4',manual:true},
      {path:'D:/b.MP4',name:'b.MP4',manual:true}];
    state.assign = {'D:/a.MP4':1, 'D:/b.MP4':2}; state.selection=['D:/a.MP4'];
    state.cameraFilterCam='2';`);
  assert.equal(run('JSON.stringify(buildSpec().targets[0].cams)'), '{"1":["D:/a.MP4"]}');
  run('state.selection=[]');
  assert.equal(run('JSON.stringify(buildSpec().targets[0].cams)'), '{}');
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

test('character counter becomes red only above 150', () => {
  const run = setup();
  assert.doesNotMatch(run("nameCount('a'.repeat(150))"), /over-limit/);
  assert.match(run("nameCount('a'.repeat(151))"), /over-limit/);
});

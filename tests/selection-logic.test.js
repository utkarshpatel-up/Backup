'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../renderer/selection-logic');

test('only current manual non-master, non-trash clips can be camera files', () => {
  const files = [
    { path: 'E:\\CARD\\CAM05.MP4', manual: true },
    { path: 'E:\\$RECYCLE.BIN\\S-1\\OLD.MP4', manual: true },
    { path: 'E:\\MASTER.MOV', manual: true },
    { path: 'E:\\drive-scan.MP4', manual: false },
  ];
  const visible = rules.cameraFiles(files, ['e:/master.mov'], 'win32');
  assert.deepEqual(visible.map((file) => file.path), ['E:\\CARD\\CAM05.MP4']);
});

test('a plan contains only assignments belonging to the current camera list', () => {
  const current = [{ path: 'E:\\CARD\\CAM05.MP4', manual: true }];
  const assignments = {
    'E:\\CARD\\CAM05.MP4': 5,
    'E:\\$RECYCLE.BIN\\OLD.MP4': 1,
    'E:\\MASTER.MOV': 3,
  };
  assert.deepEqual(rules.camsForAssignments(assignments, current, (path) => path, 'win32'), {
    5: ['E:\\CARD\\CAM05.MP4'],
  });
});

test('refreshing cards removes the prior card snapshot and its UI state', () => {
  const oldCard = { path: 'F:\\OLD.MP4', manual: true, origin: 'camera-card' };
  const manual = { path: 'D:\\KEEP.MP4', manual: true };
  const refreshed = rules.removeCardImports(
    [oldCard, manual], { 'f:/old.mp4': 2, 'D:\\KEEP.MP4': 5 },
    ['F:\\OLD.MP4', 'D:\\KEEP.MP4'], 'win32');

  assert.deepEqual(refreshed.files, [manual]);
  assert.deepEqual(refreshed.assignments, { 'D:\\KEEP.MP4': 5 });
  assert.deepEqual(refreshed.selection, ['D:\\KEEP.MP4']);
  assert.equal(refreshed.removedCount, 1);
});

test('the final safety check rejects a clip or camera not shown by the Cameras page', () => {
  const files = [{ path: 'E:\\CARD\\CAM05.MP4', manual: true }];
  const assignments = { 'E:\\CARD\\CAM05.MP4': 5 };
  const safe = { targets: [{ role: 'prores', items: [
    { kind: 'master', src: 'E:\\MASTER.MOV' },
    { kind: 'clip', src: 'E:\\CARD\\CAM05.MP4', cam: 5 },
  ] }] };
  assert.deepEqual(rules.unexpectedPlanClips(safe, assignments, files, 'win32'), []);

  const unsafe = { targets: [{ role: 'prores', items: [
    { kind: 'clip', src: 'E:\\MASTER.MOV', cam: 3 },
    { kind: 'clip', src: 'E:\\$RECYCLE.BIN\\OLD.MP4', cam: 1 },
    { kind: 'clip', src: 'E:\\CARD\\CAM05.MP4', cam: 2 },
  ] }] };
  assert.equal(rules.unexpectedPlanClips(unsafe, assignments, files, 'win32').length, 3);
});

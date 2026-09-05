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

test('a three-camera ZIP remains three cameras when a footage drive has Cam-04', () => {
  const template = {
    tree: [
      'Clips for Insert',
      'Clips for Insert/Cam-01',
      'Clips for Insert/Cam-02',
      'Clips for Insert/Cam-03',
    ],
  };
  const footageDriveDetection = { cams: { 1: [], 2: [], 3: [], 4: [] } };

  const fromZip = rules.importedCamCount(template);
  assert.equal(fromZip, 3);
  assert.equal(rules.cameraCountAfterDetection(
    template, fromZip, footageDriveDetection), 3);
});

test('direct camera folders from a ZIP are normalised to the house layout', () => {
  const template = { tree: ['Cam-01', 'Cam-02'] };
  assert.deepEqual(rules.normalizedTemplateDirs(template, 3), [
    'Clips for Insert',
    'Clips for Insert/Cam-01',
    'Clips for Insert/Cam-02',
    'Clips for Insert/Cam-03',
  ]);
});

test('informal camera folders remain directly below the session', () => {
  const template = { tree: ['Cam-01', 'Cam-02'] };
  assert.deepEqual(rules.normalizedTemplateDirs(template, 3, true), [
    'Cam-01',
    'Cam-02',
    'Cam-03',
  ]);
  assert.deepEqual(rules.normalizedTemplateDirs({
    tree: ['Clips for Insert', 'Clips for Insert/Cam-01'],
  }, 2, true), ['Cam-01', 'Cam-02']);
});

test('informal setup depends only on structure and output, not selected SD sources', () => {
  const structure = { session_name: 'Informal event' };
  assert.equal(rules.informalSetupReady(structure, 'E:\\Backups'), true);
  assert.equal(rules.informalSetupReady(structure, ''), false);
  assert.equal(rules.informalSetupReady(null, 'E:\\Backups'), false);
});

test('auto-suggest separates Canon camera filename prefixes even at identical formats', () => {
  const common = { width: 1920, height: 1080, fps: 25, video_codec: 'hevc' };
  const clips = [
    { ...common, path: 'G:\\XFVC\\A_0027C397H260904_CANON_Proxy.MP4', mtime: 2 },
    { ...common, path: 'F:\\XFVC\\A_0003C801H260904_CANON.MP4', mtime: 3 },
    { ...common, path: 'G:\\XFVC\\A_0027C398H260904_CANON_Proxy.MP4', mtime: 4 },
  ];
  const groups = rules.cameraGroups(clips, 'win32');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.map((file) =>
    rules.cameraFilenamePrefix(file))), [['A_0027', 'A_0027'], ['A_0003']]);
});

test('auto-suggest uses distinct card volumes when filenames carry no camera prefix', () => {
  const common = { width: 1920, height: 1080, fps: 25, video_codec: 'hevc' };
  const groups = rules.cameraGroups([
    { ...common, path: 'F:\\DCIM\\CLIP001.MP4', card_volume: 'F:\\' },
    { ...common, path: 'G:\\DCIM\\CLIP001.MP4', card_volume: 'G:\\' },
  ], 'win32');
  assert.equal(groups.length, 2);
});

test('camera list filters by identity and assignment, then sorts deterministically', () => {
  const files = [
    { path: 'G:\\A_0027C002.MP4', name: 'A_0027C002.MP4', mtime: 20, size: 2 },
    { path: 'F:\\A_0003C002.MP4', name: 'A_0003C002.MP4', mtime: 30, size: 3 },
    { path: 'G:\\A_0027C001.MP4', name: 'A_0027C001.MP4', mtime: 10, size: 1 },
  ];
  const assignments = {
    'G:\\A_0027C002.MP4': 2,
    'F:\\A_0003C002.MP4': 1,
    'G:\\A_0027C001.MP4': 2,
  };
  const shown = rules.filterCameraFiles(files, assignments, {
    identity: 'camera:A_0027', cam: '2', sort: 'camera-time', query: 'a_0027',
  }, 'win32');
  assert.deepEqual(shown.map((file) => file.name), [
    'A_0027C001.MP4', 'A_0027C002.MP4',
  ]);
  assert.deepEqual(rules.filterCameraFiles(files, assignments,
    { sort: 'camera-time' }, 'win32').map((file) => file.name), [
    'A_0003C002.MP4', 'A_0027C001.MP4', 'A_0027C002.MP4',
  ]);
});

test('auto-suggest chooses the lowest camera folder that has no clips', () => {
  const plan = { targets: [
    { existing_cams: { 'Cam-01': 2, 'Cam-02': 0 } },
    { existing_cams: { 'Cam-03': 1 } },
  ] };
  const occupied = rules.occupiedCamNumbers(plan);
  assert.deepEqual(occupied, [1, 3]);
  assert.deepEqual(rules.lowestAvailableCams(1, occupied), [2]);
});

test('auto-suggest adds the next camera when every existing folder is filled', () => {
  const plan = { targets: [{ existing_cams: {
    'Cam-01': 1, 'Cam-02': 4, 'Cam-03': 2,
  } }] };
  const occupied = rules.occupiedCamNumbers(plan);
  assert.deepEqual(rules.lowestAvailableCams(1, occupied), [4]);
});

test('copy review does not call cameras empty when their files are already filed', () => {
  const target = {
    existing_cams: { 'Cam-01': 10, 'Cam-02': 5, 'Cam-03': 13 },
    items: [{ kind: 'clip', cam: 4, original_name: 'NEW.MP4' }],
  };
  assert.deepEqual(rules.emptyCamNumbers([1, 2, 3, 4], target), []);
});

test('copy review reports only folders with no existing or new clips as empty', () => {
  const target = {
    existing_cams: { 'Cam-01': 10 },
    items: [{ kind: 'clip', cam: 3, original_name: 'NEW.MP4' }],
  };
  assert.deepEqual(rules.emptyCamNumbers([1, 2, 3], target), [2]);
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

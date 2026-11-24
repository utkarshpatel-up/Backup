'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { driveOf, pickDrives, protectedDrives, ejectDrive } = require('../electron/eject');

test('a path names its drive', () => {
  assert.equal(driveOf('m:\\DCIM\\100CANON\\A001.MP4', 'win32'), 'M:');
  assert.equal(driveOf('::{20D04FE0-3AEA-1069-A2D8-08002B30309D}', 'win32'), '');   // This PC itself
  assert.equal(driveOf('/Volumes/CanonA_0001/DCIM', 'darwin'), '/Volumes/CanonA_0001');
  assert.equal(driveOf('/Users/me/Desktop', 'darwin'), '');
});

test('the selected card wins over the folder the window shows', () => {
  // This PC open, the SD card selected.
  assert.deepEqual(pickDrives({ selected: ['M:\\'], folders: ['::{20D04FE0}'] }, 'win32'), { drives: ['M:'], ambiguous: [] });
  // Inside the card, nothing selected; PowerShell may send one value, not a list.
  assert.deepEqual(pickDrives({ selected: [], folders: 'M:\\DCIM' }, 'win32'), { drives: ['M:'], ambiguous: [] });
  // No Explorer window in front.
  assert.deepEqual(pickDrives({}, 'win32'), { drives: [], ambiguous: [] });
});

test('two drives in one window choose nothing', () => {
  // Tabs on the card and on an SSD, nothing selected: which one was meant is unknown.
  assert.deepEqual(pickDrives({ selected: [], folders: ['M:\\', 'E:\\H264'] }, 'win32'), { drives: [], ambiguous: ['M:', 'E:'] });
});

test('the system drive is never ejected', async () => {
  const saved = process.env.SystemDrive;
  process.env.SystemDrive = 'C:';
  try {
    assert.ok(protectedDrives('win32', 'D:\\Apps\\AV Backup\\AV Backup.exe').has('C:'));
    assert.ok(protectedDrives('win32', 'D:\\Apps\\AV Backup\\AV Backup.exe').has('D:'));
    const r = await ejectDrive('c:', 'win32', 'D:\\Apps\\AV Backup.exe');
    assert.equal(r.ejected, false);
    assert.match(r.error, /system drive/);
  } finally { process.env.SystemDrive = saved; }
});

test('only plain drive letters and mounted volumes are ejected', async () => {
  assert.equal((await ejectDrive("M:'; Remove-Item x", 'win32', 'C:\\x.exe')).ejected, false);
  assert.equal((await ejectDrive('/Users/me', 'darwin', '/Applications/AV Backup.app')).ejected, false);
});

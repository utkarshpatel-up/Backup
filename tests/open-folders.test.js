'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { windowsScriptFull, macScript } = require('../electron/open-folders');

test('only the camera-card folders are listed by Type when opened', () => {
  const dests = ['E:/3061 Dt-10 Nov 2026/Clips for Insert'], cards = ['H:/PRIVATE/M4ROOT/CLIP'];
  const win = windowsScriptFull([dests, cards], cards);
  assert.match(win, /SortColumns = \$byType/);
  assert.match(win, /System\.ItemTypeText/);
  assert.ok(win.includes(JSON.stringify(cards)), 'the card folder is the one to sort');
  assert.ok(!win.includes(`'${JSON.stringify(dests)}'`), 'the session folder is not');

  const mac = macScript([['/Volumes/SSD/3061/Clips for Insert'], ['/Volumes/CARD/DCIM']], ['/Volumes/CARD/DCIM']);
  assert.match(mac, /set grpKind to \{false\}[\s\S]*set grpKind to \{true\}/, 'destinations unsorted, cards sorted');
  assert.match(mac, /kind column/);
  // Nothing to sort: the scripts carry an empty list.
  assert.ok(windowsScriptFull([dests]).includes("ConvertFrom-Json '[]'"));
  assert.match(macScript([['/a']]), /set grpKind to \{false\}/);
});

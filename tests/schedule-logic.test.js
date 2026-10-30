'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../renderer/schedule-logic');
const { findCells } = require('../electron/schedule-ocr');
const fixtures = require('./fixtures/schedule-ocr.json');

const draft = (name, starts) => {
  const read = S.readRows(fixtures[name].rows);
  const sessions = S.draftSessions(read, {}, { author: 'DD', format: '4K' });
  return { read, sessions, rows: S.sheetRows(sessions, starts) };
};
const byDate = (rows, date) => rows.filter((r) => r[6] === date && r[0]);

test('dates survive OCR superscripts, ranges and month spans', () => {
  assert.deepEqual(S.findDates('15% Oct, Thu', 2026).days, ['2026-10-15']);
  assert.deepEqual(S.findDates('3“ Nov, Tue', 2026).days, ['2026-11-03']);
  assert.deepEqual(S.findDates('17 - 19 August', 2026).days, ['2026-08-17', '2026-08-18', '2026-08-19']);
  assert.deepEqual(S.findDates('28 Oct - 1 Nov', 2026).days,
    ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepEqual(S.findDates('14 ઓક્ટોબર', 2026).days, ['2026-10-14']);
  assert.deepEqual(S.findDates('05/11/2026', 2025).days, ['2026-11-05']);
  assert.equal(S.findDates('9-10 PM', 2026), null);
});

test('times take the end\'s AM/PM unless that would start after the end', () => {
  assert.deepEqual([S.findTime('9-10PM').start, S.findTime('9-10PM').end], ['21:00', '22:00']);
  assert.equal(S.findTime('6:30 - 8:30 PM').start, '18:30');
  assert.equal(S.findTime('10:30 AM - 12 PM').start, '10:30');
  assert.equal(S.findTime('11 - 1 PM').start, '11:00');
  assert.equal(S.findTime('9 - 10:15 PM').end, '22:15');
});

test('LIVE badges and italic OCR debris leave the title', () => {
  assert.equal(S.cleanTitle('જ્ઞાની સંગે ગરબા [CVE (eon)'), 'જ્ઞાની સંગે ગરબા');
  assert.equal(S.cleanTitle('પારાયણ (આપ્તવાણી-2) [LIVE] (to)'), 'પારાયણ (આપ્તવાણી-2)');
  assert.equal(S.cleanTitle('MBA ભાઈઓ શિબિર'), 'MBA ભાઈઓ શિબિર');
});

test('Oct–Nov poster: every programme found, breaks left out', () => {
  const { read, rows } = draft('oct-14-to-nov-5-2026', { formal: 3048, informal: 2612 });
  assert.equal(read.year, 2026);
  assert.deepEqual(read.skipped.map((s) => s.days[0]),
    ['2026-10-14', '2026-10-16', '2026-10-20', '2026-11-04']);
  // As in the real master: Soneri Satsang on the 15th at Dadanagar Hall …
  const oct15 = byDate(rows, '2026-10-15');
  assert.equal(oct15.length, 1);
  assert.deepEqual([oct15[0][0], oct15[0][9], oct15[0][13]],
    ['DD-F-4K-3048-E', 'Dadanagar Hall', 'Soneri Satsang']);
  // … "with PMHT MHTs" on the 19th, Garba on the 17th.
  assert.equal(byDate(rows, '2026-10-19')[0][10], 'with PMHT MHTs');
  assert.equal(byDate(rows, '2026-10-17')[0][13], 'Navratri');
  // The MBA shibir: Bhadran, one folder a day, M and E, brothers then sisters.
  const shibir = byDate(rows, '2026-10-21');
  assert.deepEqual(shibir.map((r) => r[3]), ['E', 'M']);
  assert.ok(shibir.every((r) => r[8] === 'MBA - Bhaio' && r[9] === 'Trimandir, Bhadran' && r[13] === 'Shibir'));
  assert.equal(byDate(rows, '2026-10-29')[0][8], 'MBA - Behno');
  // Two programmes on 3 Nov: the morning Khatmuhurt (Formal) and Gnanvidhi (Informal).
  const nov3 = byDate(rows, '2026-11-03');
  assert.deepEqual(nov3.map((r) => [r[5], r[3], r[13]]).sort(),
    [['Formal', 'M', 'Ground Breaking Ceremony'], ['Informal', '1', 'Gnanvidhi']]);
});

test('a second event type goes on its own row with the other cells blank', () => {
  const { rows } = draft('oct-14-to-nov-5-2026', { formal: 3048, informal: 2612 });
  const i = rows.findIndex((r) => r[6] === '2026-10-17');
  assert.equal(rows[i][13], 'Navratri');
  assert.deepEqual(rows[i + 1].slice(0, 13).filter(Boolean), []);
  assert.equal(rows[i + 1][13], 'Garba');
});

test('Aug poster: Aptavani parayan, and Varanasi sessions in Hindi at Rudraksh', () => {
  const { rows } = draft('aug-24-to-sep-2-2026', { formal: 3019, informal: 2600 });
  // Matches the master's DD-F-4K-3019-E / 3020-E / 3021-E rows.
  assert.deepEqual(byDate(rows, '2026-08-24')[0].slice(0, 4), ['DD-F-4K-3019-E', 3019, '4K', 'E']);
  assert.equal(byDate(rows, '2026-08-25')[0][10], 'Aptavani-2 Parayan');
  const aug29 = byDate(rows, '2026-08-29')[0];
  assert.deepEqual([aug29[0], aug29[9], aug29[10], aug29[14]],
    ['DD-F-4K-3021-E', 'Rudraksh International Cooperation and Convention Centre', 'General Satsang', 'Hindi']);
});

test('two Informal programmes on one day are numbered by time', () => {
  const { rows } = draft('aug-15-to-23-2026', { formal: 3017, informal: 2595 });
  const aug23 = byDate(rows, '2026-08-23');
  // 11 AM darshan is session 1, the 4:30 PM Gnanvidhi session 2, same folder.
  assert.deepEqual(aug23.map((r) => [r[3], r[10]]).sort(),
    [['1', 'Gurupurnima Darshan'], ['2', 'Gnanvidhi Informal Recording']]);
  assert.equal(new Set(aug23.map((r) => r[1])).size, 1);
  assert.equal(byDate(rows, '2026-08-20')[0][10], 'with SMHT MHTs');
});

test('several sessions in one half are M1/M2; a typed number is kept', () => {
  const base = { include: true, type: 'Formal', date: '2026-09-01', author: 'DD', format: 'HD',
    events: [], languages: [], flags: {} };
  const sessions = [
    { ...base, key: 1, start: '10:00' }, { ...base, key: 2, start: '11:30' },
    { ...base, key: 3, start: '21:00' }, { ...base, key: 4, start: '09:00', date: '2026-09-02', folder: '4000' },
  ];
  const n = S.assignNumbers(sessions, { formal: 3100 });
  assert.deepEqual([1, 2, 3].map((k) => n.get(k).session), ['M1', 'M2', 'E']);
  assert.equal(n.get(1).folder, 3100);
  assert.equal(n.get(4).folder, 4000);
  assert.equal(S.masterId(sessions[0], 3100, 'M1'), 'DD-F-HD-3100-M1');
});

test('the operator\'s corrections are remembered for the next schedule', () => {
  const { sessions } = draft('oct-14-to-nov-5-2026', {});
  const ap = sessions.find((s) => /આપ્તપુત્ર/.test(s.title));
  ap.activity = 'Sankul - Old Aptaputra Bhaio';
  const valsad = sessions.find((s) => /ઓધવ/.test(s.placeText));
  valsad.place = 'Shree Odhav Bhavan, Valsad';
  const memory = S.learn({}, sessions);
  const again = S.draftSessions(S.readRows(fixtures['oct-14-to-nov-5-2026'].rows), memory, {});
  const ap2 = again.find((s) => /આપ્તપુત્ર/.test(s.title));
  assert.equal(ap2.activity, 'Sankul - Old Aptaputra Bhaio');
  assert.ok(ap2.flags.activity, 'a remembered value is still flagged for a look');
  assert.equal(again.find((s) => /ઓધવ/.test(s.placeText)).place, 'Shree Odhav Bhavan, Valsad');
});

test('durations from the drive fill the matching sessions only', () => {
  const { sessions } = draft('aug-15-to-23-2026', {});
  const starts = { formal: 3017, informal: 2595 };
  const res = S.applyScan(sessions, starts, [
    { project: '3017', tag: 'E', number: 1, seconds: 3241.9, clips: 1, cams: 3 },
    { project: '2600', tag: null, number: 2, seconds: 61, clips: 4, cams: 0 },
  ]);
  assert.equal(res.filled, 2);
  const aug16 = sessions.find((s) => s.date === '2026-08-16');
  assert.deepEqual([aug16.duration, aug16.clips, aug16.cameras], ['54m 1s', 1, 3]);
  assert.equal(sessions.find((s) => /Gnanvidhi/.test(s.topic) && s.date === '2026-08-23').duration, '1m 1s');
  assert.equal(S.fmtDuration(5609), '1h 33m 29s');
});

test('one line per session (Word paragraphs, a CSV, a photo with no table)', () => {
  const read = S.readRows([
    ['Pujya Deepakbhai Satsang Schedule 5 to 7 December 2026, Surat'],
    ['5th Dec, Sat  General Satsang  6 - 8:30 PM'],
    ['6th Dec, Sun  Gnanvidhi  4:30 - 8 PM'],
    ['7th Dec, Mon  Break'],
  ]);
  assert.deepEqual(read.entries.map((e) => [e.days[0], e.start, e.title]), [
    ['2026-12-05', '18:00', 'General Satsang'],
    ['2026-12-06', '16:30', 'Gnanvidhi'],
  ]);
  assert.deepEqual(read.skipped.map((s) => s.days[0]), ['2026-12-07']);
});

test('table cells are found from ruled lines, including a merged cell', () => {
  // 300x200 white picture: a 3-column table of two rows whose last column is merged.
  const W = 300, H = 200;
  const data = new Uint8Array(W * H * 4).fill(255);
  const ink = (x, y) => { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; };
  for (const y of [10, 190]) for (let x = 10; x < 290; x++) ink(x, y);
  for (let x = 10; x < 200; x++) ink(x, 100);                   // middle line stops at column 3
  for (const x of [10, 100, 200, 289]) for (let y = 10; y <= 190; y++) ink(x, y);
  const rows = findCells({ width: W, height: H, data, order: 'rgba' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, 3);
  assert.equal(rows[0][2], rows[1][2], 'the merged cell is shared by both rows');
  assert.notEqual(rows[0][1], rows[1][1]);
});

const row = (key, over = {}) => ({ key, include: true, type: 'Formal', date: '2026-10-17', start: '21:00',
  author: 'DD', format: 'HD', activity: 'General', place: 'Dadanagar Hall', city: 'Adalaj', duration: '1h 2m 3s',
  topic: 'General Satsang', events: ['Soneri Satsang'], languages: ['Gujarati'], flags: {}, ...over });

test('dates are shown and typed the Indian way, dd/mm/yyyy', () => {
  assert.equal(S.toIndian('2026-10-17'), '17/10/2026');
  assert.equal(S.fromIndian('17/10/2026'), '2026-10-17');
  assert.equal(S.fromIndian('1-2-26'), '2026-02-01');
  assert.equal(S.fromIndian('31/02/2026'), null);
});

test('M before noon, E from noon till next morning; numbered only when a half has several', () => {
  const one = [row(1, { start: '10:00' }), row(2, { start: '15:00' })];
  let n = S.assignNumbers(one, { formal: 3000 });
  assert.deepEqual([1, 2].map((k) => n.get(k).session), ['M', 'E']);
  // A 1:30 AM session belongs to the night before: that day's folder, the next E.
  const late = [row(1, { start: '21:00' }), row(2, { date: '2026-10-18', start: '01:30' })];
  n = S.assignNumbers(late, { formal: 3000 });
  assert.deepEqual([1, 2].map((k) => [n.get(k).folder, n.get(k).session]), [[3000, 'E1'], [3000, 'E2']]);
  assert.equal(S.sheetRows(late, { formal: 3000 })[0][6], '2026-10-17');
});

test('a row gives the folders a structure zip would carry', () => {
  const shibir = [
    row(1, { start: null, hint: 'M', city: 'Bhadran', activity: 'MBA - Bhaio', events: ['Shibir'] }),
    row(2, { start: null, hint: 'E', city: 'Bhadran', activity: 'MBA - Bhaio', events: ['Shibir'] }),
  ];
  const plan = S.folderPlan(shibir, { formal: 3062 });
  assert.equal(plan.get(1).jobName, '3062 Dt-17 Oct 2026');
  assert.equal(plan.get(1).sessionName, '01 Bhadran MBA - Bhaio Shibir General Satsang M. Dt-17-Oct-26');
  assert.equal(plan.get(2).sessionName, '02 Bhadran MBA - Bhaio Shibir General Satsang E. Dt-17-Oct-26');
  assert.equal(plan.get(1).cams, 3);
  // One session alone in its folder carries no number; Informal has no M/E.
  const informal = [row(3, { type: 'Informal', topic: 'Gurupurnima Darshan', events: ['Darshan'] })];
  const p = S.folderPlan(informal, { informal: 2620 }).get(3);
  assert.equal(p.sessionName, 'Adalaj Gurupurnima Darshan Dt-17-Oct-26');
  assert.equal(p.id, 'DD-I-HD-2620-1');
  assert.equal(p.cams, 1);
});

test('rows Frappe would refuse are caught before saving or backing up', () => {
  const vocab = { activities: ['General'], events: ['Soneri Satsang', 'Darshan'], languages: ['Gujarati'] };
  const hard = (sessions, starts) => {
    const out = {};
    for (const [k, v] of S.check(sessions, starts, vocab)) {
      out[k] = Object.keys(v).filter((f) => v[f].hard);
    }
    return out;
  };
  assert.deepEqual(hard([row(1), row(2, { start: '09:00' })], { formal: 3000 }), {});
  // No folder number yet.
  assert.deepEqual(hard([row(1)], {}), { 1: ['folder'] });
  // A lone evening typed as E1, and an informal session typed as M.
  assert.deepEqual(hard([row(1, { session: 'E1' })], { formal: 3000 }), { 1: ['session'] });
  assert.deepEqual(hard([row(1, { type: 'Informal', session: 'M' })], { informal: 2600 }), { 1: ['session'] });
  // Two rows with the same ID, and one folder on two days.
  assert.deepEqual(hard([row(1, { session: 'E' }), row(2, { session: 'E' })], { formal: 3000 }), { 1: ['session'], 2: ['session'] });
  const twoDays = hard([row(1, { folder: '3000' }), row(2, { folder: '3000', date: '2026-10-18' })], {});
  assert.ok(twoDays[1].includes('folder') && twoDays[2].includes('folder'));
  // An event type not in the master list is a warning, not a block.
  const warn = S.check([row(1, { events: ['Made Up'] })], { formal: 3000 }, vocab).get(1);
  assert.equal(warn.events.hard, false);
});

test('only Frappe\'s required fields are red; the rest are yellow', () => {
  const vocab = { activities: ['General'], events: ['Soneri Satsang'], languages: ['Gujarati'] };
  const got = (over) => S.check([row(1, over)], { formal: 3000 }, vocab).get(1) || {};
  // Optional in Frappe: topic, language, city — yellow.
  const optional = got({ topic: '', languages: [], city: '' });
  assert.deepEqual(Object.keys(optional).sort(), ['city', 'languages', 'topic']);
  assert.ok(Object.values(optional).every((p) => !p.hard));
  // Required: format, author and an event type — red.
  assert.equal(got({ format: '' }).format.hard, true);
  assert.equal(got({ author: '' }).author.hard, true);
  assert.equal(got({ events: [] }).events.hard, true);
  // Duration is required too, but only known after the backup: red, yet it
  // does not stop the backup that fills it in.
  const dur = got({ duration: '' }).duration;
  assert.deepEqual([dur.hard, dur.after], [true, true]);
  assert.equal(got({ duration: 'about an hour' }).duration.after, false);
});

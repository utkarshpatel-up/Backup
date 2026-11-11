'use strict';
// A stand-in for electron/preload.js: same window.api surface, canned data, no IPC.
(() => {
  const q = new URLSearchParams(location.search);
  const n = (k, d) => Number(q.get(k) || d);
  const flow = q.get('flow') || 'local'; // local | signedout | signedin | expired | locked
  const REPORT = n('report', 0), PAST = n('past', 0), PASTROWS = n('pastRows', 0), OPEN = n('open', 0);

  // Deterministic, so baseline and after runs see byte-identical data.
  let seed = 12345;
  const rnd = (m) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % m; };
  const CITY = [['Pune', 'Maharashtra'], ['Mumbai', 'Maharashtra'], ['Ahmedabad', 'Gujarat'], ['Surat', 'Gujarat'], ['Delhi', 'Delhi'], ['Bengaluru', 'Karnataka'], ['Jaipur', 'Rajasthan'], ['Indore', 'Madhya Pradesh']];
  const EVENTS = ['Satsang', 'Pran Pratishtha', 'Gyan Vidhi', 'Aarti', 'Parayan', 'Interview', 'Bhakti'];
  const LANG = ['Gujarati', 'Hindi', 'English'];
  const TOPIC = (i) => `Topic ${i % 1800} about understanding the self and daily life number ${i % 97}`;
  const PLACE = (i) => `Hall ${i % 400}, Sector ${i % 31}`;
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const report = [];
  for (let i = 0; i < REPORT; i++) {
    const [city, st] = CITY[rnd(CITY.length)];
    const type = i % 7 === 0 ? 'Informal' : 'Formal', format = i % 9 === 0 ? '4K' : 'HD';
    const folder = Math.floor(i / 2) + 1 + (i > 9000 ? 3 : 0) + (i > 15000 ? 5 : 0);
    report.push({ id: `DD-${type[0]}-${format}-${folder}-${(i % 2) + 1}`, folder, format, session: String((i % 2) + 1), author: i % 11 === 0 ? 'NM' : 'DD', type,
      date: iso(2008 + (i % 18), (i % 12) + 1, (i % 28) + 1), duration: `${1 + (i % 3)}h${i % 60}m`, activity: EVENTS[i % 5] === 'Aarti' ? 'Aarti' : 'Satsang', place: PLACE(i), topic: TOPIC(i),
      clips: i % 40, cameras: 1 + (i % 4), events: [EVENTS[rnd(EVENTS.length)], EVENTS[rnd(EVENTS.length)]], languages: [LANG[i % 3]], city, state: st, country: 'India', source: 'existing' });
  }
  const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  let uid = 1;
  const rows = (count, base) => Array.from({ length: count }, (_, i) => {
    const [city] = CITY[i % CITY.length];
    return { key: base * 10000 + i + 1, uid: uuid(uid++), include: i % 13 !== 0, date: iso(2026, 1 + (base % 12), 1 + (i % 28)), type: i % 5 === 0 ? 'Informal' : 'Formal', format: 'HD', author: 'DD', folder: null, session: null, activity: 'Satsang', place: PLACE(i), topic: TOPIC(i + base), events: [EVENTS[i % EVENTS.length]], languages: [LANG[i % 3]], city, duration: '', clips: '', cameras: '', flags: {} };
  });
  const items = [];
  for (let p = 0; p < PAST; p++) items.push({ id: uuid(9000 + p), created: '2026-01-01T00:00:00.000Z', file: `past-${p}.xlsx`, rows: [], sessions: rows(PASTROWS, p), starts: { formal: 3000 + p * 200, informal: 2000 + p * 200 }, defaults: {} });
  if (OPEN) items.push({ id: uuid(9999), created: '2026-02-01T00:00:00.000Z', file: 'open.xlsx', rows: [], sessions: rows(OPEN, 77), starts: { formal: 6000, informal: 5000 }, defaults: {} });
  const data = { schedules: { openId: OPEN ? uuid(9999) : null, items }, team: {}, cities: null, citySource: null, report, deleted: [] };

  const config = { enabled: flow !== 'local', serverUrl: flow === 'local' ? '' : 'http://10.147.20.5:8090' };
  const status = { mode: flow === 'local' ? 'local' : 'account', configured: flow !== 'local', config, encryption: true,
    signedIn: flow === 'signedin' || flow === 'expired' || flow === 'locked', phase: flow === 'signedin' ? 'online' : flow === 'expired' ? 'expired' : flow === 'locked' ? 'revoked' : 'signed_out',
    user: ['signedin', 'expired', 'locked'].includes(flow) ? { displayName: 'Test Operator', role: 'operator', verifiedAt: '2026-11-01T00:00:00.000Z' } : null,
    locked: flow === 'locked', pending: 0, sending: 0, held: 0, failed: [], conflicts: 0, rejected: null, error: null, lastSync: flow === 'signedin' ? '2026-11-09T10:00:00.000Z' : null, remoteWaiting: false, protected: false };
  let rev = 100;
  const calls = [];
  const sub = (name) => (cb) => { window[name] = cb; return () => {}; };
  const sync = {
    status: async () => structuredClone(mock.status),
    getConfig: async () => mock.status.config,
    setConfig: async (c) => { calls.push(['setConfig', c]); if (mock.setConfig) return mock.setConfig(c); mock.status = { ...mock.status, mode: c.enabled ? 'account' : 'local', config: c, phase: 'signed_out' }; return c; },
    signIn: async (...a) => { calls.push(['signIn', a[0]]); return mock.signIn(...a); },
    signUp: async (...a) => { calls.push(['signUp', a[0], a[2]]); return mock.signUp(...a); },
    signOut: async () => { calls.push(['signOut']); mock.status = { ...mock.status, signedIn: false, user: null, phase: 'signed_out' }; },
    view: async () => { mock.views++; if (!mock.status.signedIn) return { signedIn: false }; if (mock.status.locked) return { signedIn: true, locked: true }; return { signedIn: true, rev: ++rev, data: structuredClone(data), status: structuredClone(mock.status) }; },
    commit: async (c) => { mock.commits++; mock.lastCommit = c; return { ok: true, rev: ++rev }; },
    syncNow: async () => { calls.push(['syncNow']); },
    conflicts: async () => mock.conflicts, reviews: async () => [], resolve: async () => ({ ok: true }), review: async () => ({ ok: true }),
    deleteAssignment: async () => ({ ok: true }), restoreAssignment: async () => ({ ok: true }),
    protect: async () => ({}), importLocal: async () => ({ ok: true, counts: { schedules: 0, rows: 0 }, warnings: [] }),
    onStatus: sub('__fireStatus'), onProgress: sub('__fireProgress'),
  };
  const mock = window.__mock = { status, calls, views: 0, commits: 0, conflicts: [], lastCommit: null,
    signIn: async () => { mock.status = { ...mock.status, signedIn: true, phase: 'online', user: { displayName: 'Test Operator', role: 'operator' } }; return { ok: true }; },
    signUp: async (email) => ({ ok: true, email }) };
  const base = { platform: 'darwin', sync, update: { status: async () => ({}), onStatus: () => () => {} }, dns: { setCloudflare: async () => ({}) },
    call: async (m) => ({ ok: true, result: m === 'ping' ? { python: 'mock', ffprobe: 'mock' } : { volumes: [], rows: [] } }),
    reserveId: async () => 1, getSettings: async () => ({}), getStore: async () => null,
    onProgress: () => {}, onStatus: () => {}, onBeforeClose: () => () => {}, confirm: async () => false };
  window.api = new Proxy(base, { get: (t, k) => (k in t ? t[k] : async () => undefined) });
  // The real boot sequence ends with this rescan.
  window.addEventListener('load', () => setTimeout(() => { window.__booted = true; }, 400));
})();

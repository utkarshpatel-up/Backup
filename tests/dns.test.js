'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FlushHandshake, CloseCoordinator } = require('../electron/close-coordinator');
const { winPowerShell, setCloudflareDns, dnsAndRestart, macDevice, macService, macElevatedScript, winAdapter, DnsError } = require('../electron/dns');

const ORDER = `An asterisk (*) denotes that a network service is disabled.
(1) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)

(*) Old Ethernet
(Hardware Port: Ethernet, Device: en5)
`;
const route = (i) => `   route to: default\n  interface: ${i}\n`;
const fail = (props) => Object.assign(new Error('x'), props);

// A scripted `run`: records every call; handlers by file + a marker in the args.
function mac({ iface = 'en0', order = ORDER, elevate, dns = '1.1.1.1\n1.0.0.1\n' } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === '/sbin/route') return { stdout: route(iface) };
    if (args[0] === '-listnetworkserviceorder') return { stdout: order };
    if (file === '/usr/bin/osascript') { if (elevate) throw elevate; return { stdout: '' }; }
    if (args[0] === '-getdnsservers') return { stdout: dns };
    throw new Error(`unexpected ${file}`);
  };
  return { run, calls };
}

test('macOS: finds the service for the default-route device and elevates only the scoped commands', async () => {
  const { run, calls } = mac();
  assert.deepEqual(await setCloudflareDns({ platform: 'darwin', run }), { adapter: 'Wi-Fi' });
  const script = calls.find((c) => c[0] === '/usr/bin/osascript')[2];
  assert.equal(script, macElevatedScript('Wi-Fi'));
  assert.match(script, /^do shell script ".*networksetup -setdnsservers 'Wi-Fi' 1\.1\.1\.1 1\.0\.0\.1 && .*dscacheutil -flushcache && .*killall -HUP mDNSResponder" with administrator privileges$/);
});

test('macOS: service names are quoted for shell and AppleScript', () => {
  const s = macElevatedScript(`Bob's "Wi-Fi"; rm -rf /`);
  assert.match(s, /'Bob'\\\\''s \\"Wi-Fi\\"; rm -rf \/'/);
});

test('macOS: VPN / non-ethernet device, disabled or unknown service are refused', async () => {
  for (const iface of ['utun3', 'ppp0', 'bridge0', 'en0; reboot']) {
    const m = mac({ iface });
    await assert.rejects(setCloudflareDns({ platform: 'darwin', run: m.run }), (e) => e.code === 'ambiguous' || e.code === 'no_route');
    assert.ok(!m.calls.some((c) => c[0] === '/usr/bin/osascript'));
  }
  await assert.rejects(setCloudflareDns({ platform: 'darwin', run: mac({ iface: 'en5' }).run }), { code: 'no_service' });
  assert.throws(() => macService(`(1) A\n(Hardware Port: X, Device: en0)\n(2) B\n(Hardware Port: Y, Device: en0)\n`, 'en0'), { code: 'ambiguous' });
  assert.throws(() => macDevice('nothing'), { code: 'no_route' });
});

test('macOS: disabled services are refused in both "(*) Name" and "(N) *Name" forms', async () => {
  const star = `(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n\n(2) *Thunderbolt Ethernet\n(Hardware Port: Thunderbolt Ethernet, Device: en7)\n`;
  assert.throws(() => macService(star, 'en7'), { code: 'no_service' });
  assert.equal(macService(star, 'en0'), 'Wi-Fi');
  const m = mac({ iface: 'en7', order: star });
  await assert.rejects(setCloudflareDns({ platform: 'darwin', run: m.run }), { code: 'no_service' });
  assert.ok(!m.calls.some((c) => c[0] === '/usr/bin/osascript'));
});

test('macOS: denied authorization, command failure and unverified DNS are distinct errors', async () => {
  await assert.rejects(setCloudflareDns({ platform: 'darwin', run: mac({ elevate: fail({ stderr: 'execution error: User canceled. (-128)' }) }).run }), { code: 'denied' });
  await assert.rejects(setCloudflareDns({ platform: 'darwin', run: mac({ elevate: fail({ stderr: 'boom' }) }).run }), { code: 'failed' });
  await assert.rejects(setCloudflareDns({ platform: 'darwin', run: mac({ dns: '8.8.8.8\n' }).run }), { code: 'verify' });
  await assert.rejects(setCloudflareDns({ platform: 'darwin', run: mac({ dns: "There aren't any DNS Servers set on Wi-Fi.\n" }).run }), { code: 'verify' });
});

const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const adapter = (o) => ({ index: 7, alias: 'Ethernet', status: 'Up', virtual: false, desc: 'Intel(R) Ethernet', metric: 25, ...o });
function win({ routes = [adapter()], elevate, dns = ['1.1.1.1', '1.0.0.1'] } = {}) {
  const calls = [];
  const run = async (file, args) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    calls.files = (calls.files || []).concat(file);
    if (file !== PS_EXE) throw new Error('unexpected');
    if (cmd.includes('Get-NetRoute')) return { stdout: JSON.stringify(routes) };
    if (cmd.includes('Start-Process')) { if (elevate) throw elevate; return { stdout: '' }; }
    if (cmd.includes('Get-DnsClientServerAddress')) return { stdout: JSON.stringify(dns) };
    throw new Error('unexpected');
  };
  return { run, calls };
}

test('Windows: elevates a Set-DnsClientServerAddress + Clear-DnsClientCache for the active adapter index only', async () => {
  const { run, calls } = win();
  assert.deepEqual(await setCloudflareDns({ platform: 'win32', run }), { adapter: 'Ethernet' });
  const outer = calls.find((c) => c.includes('Start-Process'));
  const inner = Buffer.from(/'-EncodedCommand','([^']+)'/.exec(outer)[1], 'base64').toString('utf16le');
  assert.match(inner, /Set-DnsClientServerAddress -InterfaceIndex 7 -ServerAddresses \('1\.1\.1\.1','1\.0\.0\.1'\)/);
  assert.match(inner, /Clear-DnsClientCache/);
  assert.match(outer, /-Verb RunAs/);
  // Both the unelevated runs and the elevated child use the absolute system PowerShell, never a bare name.
  assert.ok(calls.files.length >= 3 && calls.files.every((f) => f === PS_EXE));
  assert.ok(outer.includes(`-FilePath '${PS_EXE}'`));
  assert.equal(winPowerShell({ SystemRoot: 'D:\\WINNT\\' }), 'D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(winPowerShell({ SystemRoot: '..\\evil' }), PS_EXE);
  assert.equal(winPowerShell({ SystemRoot: "C:\\x';calc;'" }), PS_EXE);
});

test('Windows: lowest metric wins; ties, down, virtual and VPN adapters are refused without elevating', async () => {
  const wifi = adapter({ index: 9, alias: 'Wi-Fi', metric: 50 });
  assert.equal(winAdapter(JSON.stringify([wifi, adapter()])).index, 7);
  assert.equal(winAdapter(JSON.stringify(adapter())).index, 7);   // PowerShell emits a bare object for one route
  const bad = [
    [adapter(), adapter({ index: 9, alias: 'Wi-Fi', metric: 25 })],
    [adapter({ status: 'Disconnected' })],
    [adapter({ virtual: true })],
    [adapter({ index: 12, alias: 'Corp', desc: 'Cisco AnyConnect Secure Mobility Client Virtual Miniport', metric: 1 }), wifi],
    [adapter({ desc: 'WireGuard Tunnel' })],
  ];
  for (const routes of bad) {
    const w = win({ routes });
    await assert.rejects(setCloudflareDns({ platform: 'win32', run: w.run }), { code: 'ambiguous' });
    assert.ok(!w.calls.some((c) => c.includes('Start-Process')));
  }
  assert.throws(() => winAdapter('[]'), { code: 'no_route' });
  assert.throws(() => winAdapter('not json'), { code: 'no_route' });
  assert.throws(() => winAdapter(JSON.stringify([adapter({ index: '7; calc' })])), { code: 'no_route' });
});

test('Windows: UAC denial, failure and unverified DNS', async () => {
  await assert.rejects(setCloudflareDns({ platform: 'win32', run: win({ elevate: fail({ code: 1223 }) }).run }), { code: 'denied' });
  // A real Start-Process failure (even one whose text says "cancel") is not a UAC denial, and DNS "may have changed".
  await assert.rejects(setCloudflareDns({ platform: 'win32', run: win({ elevate: fail({ code: 1, stderr: 'The operation was canceled by the timeout' }) }).run }), (e) => e.code === 'failed' && /may have/.test(e.message));
  await assert.rejects(setCloudflareDns({ platform: 'win32', run: win({ dns: ['1.1.1.1'] }).run }), (e) => e.code === 'verify' && /may have changed/.test(e.message));
  const w = win({ elevate: fail({ code: 1223 }) });
  await assert.rejects(setCloudflareDns({ platform: 'win32', run: w.run }), (e) => e.code === 'denied' && /was not changed/.test(e.message));
  const guard = w.calls.find((c) => c.includes('Start-Process'));
  assert.match(guard, /NativeErrorCode -eq 1223\)\{exit 1223\}.*exit 1\}$/);   // only the native cancel code maps to denial
});

test('unsupported platform never runs anything', async () => {
  const run = async () => { throw new Error('ran'); };
  await assert.rejects(setCloudflareDns({ platform: 'linux', run }), { code: 'unsupported' });
});

// ---- restart orchestration
function harness(o = {}) {
  const log = [];
  const closer = { pending: null, cancelled() {}, flushStrict: async () => { log.push('flush'); return o.flushOk !== false; } };
  return { log, args: {
    platform: 'darwin', isBusy: () => !!o.busy, closer, confirm: async () => o.confirm !== false,
    setDns: async () => { log.push('dns'); if (o.dnsError) throw o.dnsError; },
    relaunch: () => log.push('relaunch'), ...o.extra,
  } };
}

test('restart: DNS verified, then flush, then relaunch — in that order', async () => {
  const h = harness();
  assert.deepEqual(await dnsAndRestart(h.args), { ok: true });
  assert.deepEqual(h.log, ['dns', 'flush', 'relaunch']);
});

test('restart: busy, pending close, cancel and unsupported do nothing', async () => {
  for (const [o, code] of [[{ busy: true }, 'busy'], [{ confirm: false }, 'cancelled'], [{ extra: { platform: 'linux' } }, 'unsupported']]) {
    const h = harness(o);
    assert.equal((await dnsAndRestart(h.args)).code, code);
    assert.deepEqual(h.log, []);
  }
  const h = harness(); h.args.closer.pending = Promise.resolve();
  assert.equal((await dnsAndRestart(h.args)).code, 'busy');
  assert.deepEqual(h.log, []);
});

test('restart: DNS failure or denial never flushes or relaunches', async () => {
  const h = harness({ dnsError: new DnsError('denied', 'nope') });
  assert.deepEqual(await dnsAndRestart(h.args), { ok: false, code: 'denied', error: 'nope' });
  assert.deepEqual(h.log, ['dns']);
});

test('restart: unsaved flush failure keeps the app running and says DNS changed', async () => {
  const h = harness({ flushOk: false });
  const r = await dnsAndRestart(h.args);
  assert.equal(r.code, 'not_restarted');
  assert.match(r.error, /DNS is now Cloudflare/);
  assert.deepEqual(h.log, ['dns', 'flush']);
});

test('restart: a task starting during the admin prompt blocks the relaunch', async () => {
  let busy = false;
  const h = harness({ extra: { isBusy: () => busy, setDns: async () => { busy = true; } } });
  assert.equal((await dnsAndRestart(h.args)).code, 'not_restarted');
  assert.deepEqual(h.log, []);
});

test('wiring: preload exposes only the fixed DNS action and main registers the trusted IPC', () => {
  const fs = require('node:fs'), path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('electron/preload.js'), /dns: \{ setCloudflare: \(\) => ipcRenderer\.invoke\('dns:setCloudflare'\) \}/);
  assert.match(read('electron/main.js'), /handle\('dns:setCloudflare'/);
  const ui = read('renderer/app.js');
  assert.match(ui, /\['win32', 'darwin'\]\.includes\(window\.api\.platform\)/);
  assert.match(ui, /Set Cloudflare DNS &amp; restart \(\$\{window\.api\.platform === 'win32' \? 'Windows' : 'Mac'\}\)/);
  assert.match(read('electron/main.js'), /closer\.approved = true; quittingApproved = true/);
});


// ---- real CloseCoordinator + FlushHandshake (no stubbed closer)
const { EventEmitter } = require('node:events');
function realCloser({ rendererOk = true, localOk = true, busy = () => false } = {}) {
  const ipc = new EventEmitter();
  const frame = { url: 'file:///app/renderer/index.html' };
  const wc = new EventEmitter(); wc.mainFrame = frame;
  const win = { webContents: wc, isDestroyed: () => false };
  const spies = { discard: 0, stop: 0, cancelled: 0 };
  wc.send = (_c, { id }) => setImmediate(() => ipc.emit('app:flush-result', { sender: wc, senderFrame: frame }, { id, ok: rendererOk }));
  const flush = new FlushHandshake({ ipcMain: ipc, getWindow: () => win, appUrl: 'file:///app/renderer/index.html', timeoutMs: 200 });
  const closer = new CloseCoordinator({
    isBusy: busy,
    confirmStop: async () => { spies.stop++; return true; },
    flushRenderer: () => flush.request(win),
    flushLocal: async () => { if (!localOk) throw new Error('disk'); },
    confirmDiscard: async () => { spies.discard++; return true; },   // would approve a discard if ever asked
    cancelled: () => { spies.cancelled++; },
  });
  return { closer, spies };
}
const strictArgs = (closer, extra = {}) => ({ platform: 'darwin', isBusy: () => false, closer, confirm: async () => true, setDns: async () => {}, relaunch: () => { extra.relaunched = true; }, ...extra });

test('real coordinator: saved edits relaunch; close approval is only set by the caller afterwards', async () => {
  const { closer, spies } = realCloser();
  const x = {};
  assert.deepEqual(await dnsAndRestart(strictArgs(closer, x)), { ok: true });
  assert.equal(x.relaunched, true);
  assert.equal(closer.approved, false);
  assert.equal(spies.discard + spies.stop + spies.cancelled, 0);
});

test('real coordinator: failed renderer or local save never discards, never approves, never relaunches', async () => {
  for (const opts of [{ rendererOk: false }, { localOk: false }]) {
    const { closer, spies } = realCloser(opts);
    const x = {};
    const r = await dnsAndRestart(strictArgs(closer, x));
    assert.equal(r.code, 'not_restarted');
    assert.equal(x.relaunched, undefined);
    assert.equal(closer.approved, false);
    assert.equal(closer.pending, null);
    assert.equal(spies.discard, 0);
    assert.equal(spies.cancelled, 1);   // editor un-inerted
    // A later normal close is still gated by the usual handshake.
    assert.equal(await closer.request(), true);   // via confirmDiscard spy, i.e. the normal path
    assert.equal(spies.discard, 1);
  }
});

test('real coordinator: an unanswered editor times out as a save failure', async () => {
  const { closer, spies } = realCloser();
  closer.flushRenderer = () => new FlushHandshake({ ipcMain: new EventEmitter(), getWindow: () => null, appUrl: 'x', timeoutMs: 20 }).request({ webContents: { mainFrame: {}, send() {} } });
  assert.equal((await dnsAndRestart(strictArgs(closer))).code, 'not_restarted');
  assert.equal(spies.discard, 0); assert.equal(closer.approved, false);
});

test('real coordinator: a task starting during the save blocks relaunch and restores the editor', async () => {
  let busy = false;
  const { closer, spies } = realCloser({ busy: () => busy });
  closer.flushLocal = async () => { busy = true; };
  const x = {};
  const r = await dnsAndRestart(strictArgs(closer, { ...x, isBusy: () => busy, relaunch: () => { x.relaunched = true; } }));
  assert.equal(r.code, 'not_restarted'); assert.equal(x.relaunched, undefined);
  assert.equal(closer.approved, false); assert.equal(spies.cancelled, 1); assert.equal(spies.stop, 0);
});

test('real coordinator: busy or an in-flight close attempt refuses a strict save', async () => {
  const a = realCloser({ busy: () => true });
  assert.equal(await a.closer.flushStrict(), false);
  assert.equal(a.spies.stop, 0);
  const b = realCloser();
  const first = b.closer.request();
  assert.equal(await b.closer.flushStrict(), false);
  await first;
});

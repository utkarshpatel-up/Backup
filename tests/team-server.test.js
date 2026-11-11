'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { zeroTierState, pocketBaseUp, teamServerStatus } = require('../electron/team-server');

const SERVER = 'http://10.7.134.203:8090';
const v4 = (address, netmask, extra = {}) => ({ address, netmask, family: 'IPv4', internal: false, ...extra });
const lo = v4('127.0.0.1', '255.0.0.0', { internal: true });

test('zerotier: an IPv4 interface on the server subnet is connected', () => {
  assert.equal(zeroTierState(SERVER, { lo0: [lo], en0: [v4('192.168.1.5', '255.255.255.0')], feth123: [v4('10.7.134.9', '255.255.0.0')] }), 'connected');
  assert.equal(zeroTierState(SERVER, { zt: [v4('10.7.200.1', '255.255.0.0', { family: 4 })] }), 'connected');   // older Node: numeric family
  assert.equal(zeroTierState(SERVER, { zt: [v4('10.7.134.203', '255.255.255.255')] }), 'connected');   // the server itself
});

test('zerotier: no interfaces, IPv6 only, loopback only or a different subnet is not connected', () => {
  assert.equal(zeroTierState(SERVER, {}), 'disconnected');
  assert.equal(zeroTierState(SERVER, undefined), 'disconnected');
  assert.equal(zeroTierState(SERVER, { en0: [{ address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }] }), 'disconnected');
  assert.equal(zeroTierState(SERVER, { lo0: [lo] }), 'disconnected');
  assert.equal(zeroTierState(SERVER, { en0: [v4('10.8.134.9', '255.255.0.0')] }), 'disconnected');
  assert.equal(zeroTierState(SERVER, { en0: [v4('10.7.134.9', '0.0.0.0')] }), 'disconnected');   // a zero mask matches nothing
});

test('zerotier: https, host names, loopback and junk addresses are unknown', () => {
  const ifs = { en0: [v4('10.7.134.9', '255.255.0.0')] };
  for (const url of ['https://10.7.134.203', 'https://team.example.com', 'http://localhost:8090', 'http://127.0.0.1:8090', 'http://10.7.134.999:8090', 'not a url', '']) {
    assert.equal(zeroTierState(url, ifs), 'unknown', url);
  }
});

const fakeFetch = (impl) => { const calls = []; const f = async (url, init) => { calls.push([url, init]); return impl(url, init); }; f.calls = calls; return f; };

test('pocketbase: 200 from /api/health is up, with no credentials and no redirects', async () => {
  const f = fakeFetch(() => ({ status: 200 }));
  assert.equal(await pocketBaseUp(SERVER, f), true);
  const [url, init] = f.calls[0];
  assert.equal(url, `${SERVER}/api/health`);
  assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.method, 'GET');
  assert.equal(init.headers, undefined);   // never a token
  assert.ok(init.signal instanceof AbortSignal);
});

test('pocketbase: 404, 500, network error and timeout are down', async () => {
  assert.equal(await pocketBaseUp(SERVER, fakeFetch(() => ({ status: 404 }))), false);
  assert.equal(await pocketBaseUp(SERVER, fakeFetch(() => ({ status: 500 }))), false);
  assert.equal(await pocketBaseUp(SERVER, fakeFetch(() => { throw new TypeError('fetch failed'); })), false);
  const hang = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const t = Date.now();
  const keepAlive = setTimeout(() => {}, 5000);   // AbortSignal.timeout's timer is unref'd
  assert.equal(await pocketBaseUp(SERVER, hang, 30), false);
  clearTimeout(keepAlive);
  assert.ok(Date.now() - t < 2000);
});

test('status: local mode makes no network call; account mode reports both', async () => {
  const f = fakeFetch(() => ({ status: 200 }));
  assert.deepEqual(await teamServerStatus({ config: null, fetch: f }), { mode: 'local' });
  assert.deepEqual(await teamServerStatus({ config: { enabled: false, serverUrl: SERVER }, fetch: f }), { mode: 'local' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await teamServerStatus({ config: { enabled: true, serverUrl: SERVER }, interfaces: { zt: [v4('10.7.1.1', '255.255.0.0')] }, fetch: f }),
    { mode: 'account', zerotier: 'connected', pocketbase: 'up' });
});

test('wiring: one argument-free IPC call, address read from the saved config, DNS button gone', () => {
  const fs = require('node:fs'), path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('electron/preload.js'), /teamServer: \{ status: \(\) => ipcRenderer\.invoke\('teamServer:status'\) \}/);
  const main = read('electron/main.js');
  assert.match(main, /handle\('teamServer:status', \(_e, \.\.\.args\) => \{\n {2}if \(args\.length\) throw/);
  assert.match(main, /engine\.publicConfig\(\)/);
  assert.doesNotMatch(main + read('electron/preload.js') + read('renderer/app.js'), /dns:setCloudflare|btnDns/);
});

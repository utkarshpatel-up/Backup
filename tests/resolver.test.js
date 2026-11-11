'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { makeLookup, dohOnce, isPublicV4 } = require('../electron/sync/resolver');

// A fake https.get that answers with `json` (or an HTTP status), like Cloudflare's dns-json.
const fakeGet = (json, status = 200) => (url, opts, cb) => {
  const req = new EventEmitter();
  req.destroy = (e) => req.emit('error', e);
  setImmediate(() => {
    const res = new EventEmitter();
    res.statusCode = status;
    res.setEncoding = () => {};
    cb(res);
    res.emit('data', JSON.stringify(json));
    res.emit('end');
  });
  return req;
};
const answer = (...ips) => ({ Answer: ips.map((data) => ({ type: 1, TTL: 60, data })) });
const call = (lookup, name, options = { all: true }) => new Promise((res) => lookup(name, options, (err, a, f) => res({ err, a, f })));

test('isPublicV4 refuses private, loopback, link-local and CGNAT answers', () => {
  for (const a of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '172.16.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'x']) assert.equal(isPublicV4(a), false, a);
  for (const a of ['52.76.36.58', '18.141.96.229', '172.217.116.4']) assert.equal(isPublicV4(a), true, a);
});

test('dohOnce returns public A records and drops private ones', async () => {
  const r = await dohOnce('1.1.1.1', 'x.neon.tech', { get: fakeGet(answer('52.76.36.58', '10.0.0.9')) });
  assert.deepEqual(r.addresses, ['52.76.36.58']);
});

test('dohOnce rejects a non-200 and an empty answer', async () => {
  await assert.rejects(dohOnce('1.1.1.1', 'x', { get: fakeGet({}, 500) }), /status 500/);
  await assert.rejects(dohOnce('1.1.1.1', 'x', { get: fakeGet({ Answer: [] }) }), /no address/);
});

test('system DNS answer is used and DoH is never asked', async () => {
  let asked = 0;
  const lookup = makeLookup({ system: (h, o, cb) => cb(null, [{ address: '1.2.3.4', family: 4 }]), get: () => { asked++; } });
  const r = await call(lookup, 'a.example');
  assert.deepEqual(r.a, [{ address: '1.2.3.4', family: 4 }]);
  assert.equal(asked, 0);
});

test('system DNS error falls back to DoH, in both callback shapes', async () => {
  const lookup = makeLookup({ system: (h, o, cb) => cb(new Error('timeout')), get: fakeGet(answer('52.76.36.58')) });
  assert.deepEqual((await call(lookup, 'a.example')).a, [{ address: '52.76.36.58', family: 4 }]);
  const one = await call(lookup, 'a.example', {});
  assert.equal(one.a, '52.76.36.58');
  assert.equal(one.f, 4);
});

test('a system lookup that never answers is beaten by DoH after the head start', async () => {
  const lookup = makeLookup({ system: () => {}, get: fakeGet(answer('18.140.192.230')), headStart: 10 });
  assert.equal((await call(lookup, 'a.example')).a[0].address, '18.140.192.230');
});

test('a DoH answer is cached until its TTL runs out', async () => {
  let t = 0;
  let asked = 0;
  const get = (...a) => { asked++; return fakeGet(answer('52.76.36.58'))(...a); };
  const lookup = makeLookup({ system: (h, o, cb) => cb(new Error('x')), get, now: () => t });
  await call(lookup, 'a.example');
  await call(lookup, 'a.example');
  assert.equal(asked, 1);
  t = 61 * 1000;
  await call(lookup, 'a.example');
  assert.equal(asked, 2);
});

test('when system DNS and both DoH servers fail, the system error is returned', async () => {
  const lookup = makeLookup({ system: (h, o, cb) => cb(new Error('ESERVFAIL')), get: fakeGet({}, 503) });
  const r = await call(lookup, 'a.example');
  assert.match(r.err.message, /ESERVFAIL/);
});

test('a DoH body cut off mid-way rejects instead of hanging', async () => {
  const get = (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = (e) => req.emit('error', e);
    setImmediate(() => {
      const res = new EventEmitter();
      Object.assign(res, { statusCode: 200, complete: false, setEncoding: () => {} });
      cb(res);
      res.emit('data', '{"Ans');
      res.emit('close');
    });
    return req;
  };
  await assert.rejects(dohOnce('1.1.1.1', 'x', { get }), /aborted/);
});

test('the DoH cache keeps the shortest TTL and answers asynchronously', async () => {
  let t = 0;
  let asked = 0;
  const json = { Answer: [{ type: 1, TTL: 40, data: '52.76.36.58' }, { type: 1, TTL: 250, data: '52.76.36.59' }] };
  const get = (...a) => { asked++; return fakeGet(json)(...a); };
  const lookup = makeLookup({ system: (h, o, cb) => cb(new Error('x')), get, now: () => t });
  await call(lookup, 'a.example');
  let sync = true;
  const p = new Promise((res) => lookup('a.example', { all: true }, () => res(sync)));
  sync = false;
  assert.equal(await p, false);
  t = 41 * 1000;
  await call(lookup, 'a.example');
  assert.equal(asked, 2);
});

// A get that never answers: only the deadline can end it.
const silentGet = () => { const req = new EventEmitter(); req.destroy = () => req.emit('error', new Error('destroyed')); return req; };

test('a DoH server that never answers is abandoned at the deadline', async () => {
  const t0 = Date.now();
  await assert.rejects(dohOnce('1.1.1.1', 'x', { get: silentGet, deadline: 30 }), /timeout/);
  assert.ok(Date.now() - t0 < 1000);
});

test('when everything fails, an expired DoH answer is used instead of an error', async () => {
  let t = 0;
  let live = true;
  const get = (...a) => (live ? fakeGet(answer('52.76.36.58')) : fakeGet({}, 503))(...a);
  const lookup = makeLookup({ system: (h, o, cb) => cb(new Error('ETIMEOUT')), get, now: () => t });
  await call(lookup, 'a.example');
  t = 10 * 60 * 1000;
  live = false;
  const r = await call(lookup, 'a.example');
  assert.equal(r.err, null);
  assert.equal(r.a[0].address, '52.76.36.58');
});

test('a hung system lookup plus silent DoH servers fails within the total budget', async () => {
  const lookup = makeLookup({ system: (h, o, cb) => setTimeout(() => cb(new Error('ETIMEOUT')), 50), get: silentGet, headStart: 10, deadline: 30 });
  const t0 = Date.now();
  const r = await call(lookup, 'a.example');
  assert.match(r.err.message, /ETIMEOUT/);
  assert.ok(Date.now() - t0 < 1000);
});

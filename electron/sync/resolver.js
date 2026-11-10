'use strict';
// A fetch that survives a broken office DNS server. The system lookup runs first; if it fails or is
// slow, the name is looked up over DNS-over-HTTPS at Cloudflare's IP (port 443, so reaching it needs
// no DNS). Only the lookup changes: undici still verifies the certificate against the hostname.
const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');
const { Agent, fetch: undiciFetch } = require('undici');

const DOH_SERVERS = ['1.1.1.1', '1.0.0.1'];
const HEAD_START_MS = 1500;  // system DNS runs alone this long before DoH joins the race
const DOH_DEADLINE_MS = 3000; // per server, whole request: 1.5 + 3 + 3 stays under undici's 10s connect timeout
const MIN_TTL_S = 30;
const MAX_TTL_S = 300;
const MAX_BODY = 65536;

// A DoH answer must never steer a request onto the LAN: private, loopback, link-local, CGNAT,
// multicast and reserved addresses are refused.
const isPublicV4 = (a) => net.isIPv4(a)
  && !/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|22[4-9]\.|2[3-5]\d\.)/.test(a)
  && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);

/** One DoH (dns-json) query for A records; resolves { addresses, ttl } or rejects within `deadline`. */
function dohOnce(server, name, { get = https.get, deadline = DOH_DEADLINE_MS } = {}) {
  return new Promise((resolve, reject) => {
    let req = null;
    let over = false; // settle once: destroy() can re-enter through the 'error' handler
    const timer = setTimeout(() => fail(new Error('doh: timeout')), deadline);
    const fail = (e) => { if (over) return; over = true; clearTimeout(timer); if (req) req.destroy(); reject(e); };
    const ok = (v) => { if (over) return; over = true; clearTimeout(timer); resolve(v); };
    req = get(`https://${server}/dns-query?name=${encodeURIComponent(name)}&type=A`,
      { headers: { accept: 'application/dns-json' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if ((body += c).length > MAX_BODY) fail(new Error('doh: too large')); });
        // A body cut off mid-way fires neither 'end' nor 'error'.
        res.on('close', () => { if (!res.complete) fail(new Error('doh: aborted')); });
        res.on('error', fail);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error(`doh: status ${res.statusCode}`);
            const hits = (JSON.parse(body).Answer || []).filter((r) => r && r.type === 1 && isPublicV4(r.data));
            if (!hits.length) throw new Error('doh: no address');
            const ttl = Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Math.min(...hits.map((r) => r.TTL | 0))));
            ok({ addresses: hits.map((r) => r.data), ttl });
          } catch (e) { fail(e); }
        });
      });
    req.on('error', fail);
  });
}

/** Tries each DoH server in turn; rejects with the last error. */
async function doh(name, opts) {
  let last;
  for (const server of DOH_SERVERS) {
    try { return await dohOnce(server, name, opts); } catch (e) { last = e; }
  }
  throw last;
}

/**
 * lookup(hostname, options, cb) in the shape net.connect expects. DoH answers are cached for their
 * TTL, and an expired one is still used when every live lookup fails: Neon's addresses rarely change,
 * and an intermittent DNS outage is exactly when it is needed. `system`, `get`, `now`, `headStart`
 * and `deadline` are injectable for tests.
 */
function makeLookup({ system = dns.lookup, get, now = Date.now, headStart = HEAD_START_MS, deadline } = {}) {
  const cache = new Map(); // hostname -> { addresses, until }
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (options.family === 6) return system(hostname, options, cb); // DoH here asks for A records only
    const done = (list) => (options.all ? cb(null, list) : cb(null, list[0].address, list[0].family));
    const v4 = (addresses) => addresses.map((address) => ({ address, family: 4 }));

    const hit = cache.get(hostname);
    if (hit && hit.until > now()) return process.nextTick(done, v4(hit.addresses)); // callbacks are async, like dns.lookup

    let settled = false;
    let dohStarted = false;
    let sysError = null;
    let dohError = null;
    const finish = (fn) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const maybeFail = () => {
      if (!sysError || !dohError) return;
      finish(() => (hit ? done(v4(hit.addresses)) : cb(sysError)));
    };
    const startDoh = () => {
      clearTimeout(timer);
      if (dohStarted || settled) return;
      dohStarted = true;
      doh(hostname, { get, deadline }).then(
        (r) => {
          cache.set(hostname, { addresses: r.addresses, until: now() + r.ttl * 1000 });
          finish(() => done(v4(r.addresses)));
        },
        (e) => { dohError = e; maybeFail(); },
      );
    };
    const timer = setTimeout(startDoh, headStart);
    system(hostname, { ...options, all: true }, (err, list) => {
      if (!err && list && list.length) return finish(() => done(list));
      sysError = err || new Error(`no address for ${hostname}`);
      startDoh();
      maybeFail();
    });
  };
}

const agent = new Agent({ connect: { lookup: makeLookup() } });

/** WHATWG fetch (undici) whose DNS falls back to DoH; everything else, TLS included, is stock undici. */
const resilientFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: agent });

module.exports = { resilientFetch, makeLookup, dohOnce, isPublicV4 };

'use strict';
// HTTP calls to the team's PocketBase server: its `users` auth collection (sign-in, token
// refresh, sign-up) and the six sync RPCs at /api/avb/rpc/<name> (server/pb_hooks). Runs in
// the main process only. The renderer never sees a token, a URL or a method: it asks for
// actions by name (see ipc.js).
//
// PocketBase issues one auth token (a JWT, 7 days by default) that is renewed while still
// valid; it plays both the access and the refresh token here, so the engine above is unchanged.

class SyncError extends Error {
  /** kind: offline | unauthorized | revoked | forbidden | refused | busy | server | config | protocol */
  constructor(kind, code, message, status) { super(message); Object.assign(this, { kind, code, status }); }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
// Private IPv4 ranges ZeroTier assigns from (and CGNAT). ZeroTier encrypts the traffic itself,
// so plain http to such an address is not readable on the office network.
const PRIVATE_V4 = /^(10\.\d+|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d+\.\d+$/;

/**
 * The server address, normalised with no trailing slash, or a SyncError: https anywhere, or
 * plain http to this computer or to a private IP address (the server's ZeroTier address).
 */
function parseBaseUrl(text) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch (_) { throw new SyncError('config', 'bad_url', 'Enter the server address, like http://10.147.20.5:8090.'); }
  if (u.username || u.password) throw new SyncError('config', 'bad_url', 'The server address must not contain a user name or password.');
  if (u.search || u.hash) throw new SyncError('config', 'bad_url', 'Enter the server address without anything after a ? or #.');
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && (LOOPBACK.has(u.hostname) || PRIVATE_V4.test(u.hostname))))) {
    throw new SyncError('config', 'bad_url', 'Use the server\'s ZeroTier IP address (http://10.x.x.x:8090) or an https:// address.');
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** The token's claims, read only to tell sessions apart and see its expiry; roles come from avb_me. */
function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch (_) { return {}; }
}

// Server text is never shown or logged: it could quote a password or token. Only these
// known codes pass through (the avb:<code> set the server rules use, checked by a test);
// everything else becomes a fixed message.
const AVB_CODES = new Set(('admin_required aggregate_rev_mismatch append_only assignment_key_only_for_children '
  + 'assignment_not_found base_version_mismatch conflict_not_found conflict_not_open duplicate_target_in_batch invalid_field '
  + 'invalid_integer invalid_key invalid_operations invalid_resolution invalid_status invalid_uuid missing_field '
  + 'mutation_id_reused not_an_object not_authenticated not_deletable not_member nothing_to_restore '
  + 'out_of_range parent_deleted payload_only_for_merged payload_required payload_too_large protocol_version_unsupported '
  + 'request_too_large restore_base_not_tombstone restore_required stale_resolution target_not_found uid_assignment_mismatch '
  + 'uid_collision unknown_field unknown_op unknown_target_type use_delete_assignment').split(' '));
function avbCode(body) {
  const m = body && typeof body.message === 'string' ? /^avb:([a-z0-9_]+)$/.exec(body.message) : null;
  return m && AVB_CODES.has(m[1]) ? m[1] : null;
}

/**
 * Transport contract: `fetch` is injected and must be a WHATWG fetch that honours
 * `redirect: 'error'`. In the app it is Node's own fetch. Never pass a fetch that skips TLS
 * verification and never set NODE_TLS_REJECT_UNAUTHORIZED=0.
 */
class Client {
  constructor({ serverUrl, fetch, timeoutMs = 20000 }) {
    if (typeof fetch !== 'function') throw new SyncError('config', 'no_transport', 'No network transport was given.');
    Object.assign(this, { serverUrl, fetchImpl: fetch, timeoutMs });
  }

  /** One POST to `${serverUrl}/${path}`, never outside it; returns the parsed JSON. */
  async request(path, { token, body, raw } = {}) {
    const url = new URL(`${this.serverUrl}/${path}`);
    const root = new URL(this.serverUrl);
    if (url.origin !== root.origin || !url.pathname.startsWith(`${root.pathname.replace(/\/$/, '')}/`)) {
      throw new SyncError('config', 'bad_url', 'Refused a request outside the configured server.');
    }
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (token) headers.Authorization = token;
    let res;
    try {
      res = await this.fetchImpl(url.href, {
        method: 'POST', headers, body: raw !== undefined ? raw : JSON.stringify(body === undefined ? {} : body),
        // A redirect could carry the token to another host: never follow one.
        redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // fetch wraps the real reason (ECONNREFUSED, EHOSTUNREACH, ETIMEDOUT…) in e.cause; show it so a failure is diagnosable.
      const why = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.name === 'TimeoutError' ? 'timeout' : '');
      throw new SyncError('offline', e && e.name === 'TimeoutError' ? 'timeout' : 'network',
        `The team server could not be reached${why ? ` (${why})` : ''}. Check that ZeroTier is connected and the server is on.`);
    }
    if (res.redirected || (res.url && new URL(res.url).origin !== url.origin) || (res.status >= 300 && res.status < 400)) {
      throw new SyncError('config', 'redirect', 'The server redirected the request; check the server address.');
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (res.ok) return json;
    throw classify(res.status, json);
  }

  // -------------------------------------------------- PocketBase users auth

  _session(json) {
    if (!json || typeof json.token !== 'string' || !json.record || typeof json.record.id !== 'string') {
      throw new SyncError('protocol', 'bad_token', 'The server sent no session.');
    }
    const claims = jwtClaims(json.token);
    return { access_token: json.token, refresh_token: json.token, expires_at: Number(claims.exp) || 0, user: { id: json.record.id } };
  }

  async signIn(email, password) {
    try {
      return this._session(await this.request('api/collections/users/auth-with-password', { body: { identity: email, password } }));
    } catch (e) {
      if (e.kind === 'refused' && e.status === 400) throw new SyncError('refused', 'invalid_credentials', 'Wrong e-mail or password.', 400);
      throw e;
    }
  }
  /** A new account. It gets no session and no access until the maintainer adds it to avb_members. */
  async signUp(email, password, name) {
    try {
      await this.request('api/collections/users/records', { body: { email, password, passwordConfirm: password, name } });
    } catch (e) {
      if (e.kind === 'refused' && e.status === 400) {
        throw new SyncError('refused', e.code === 'validation_not_unique' ? 'email_taken' : 'signup_refused',
          e.code === 'validation_not_unique' ? 'An account with this e-mail already exists.' : 'The server refused the new account; check the e-mail and use a password of at least 8 characters.', 400);
      }
      throw e;
    }
  }
  /** A still-valid token for a fresh one; an expired token answers 401 and needs a new sign-in. */
  async refresh(refreshToken) { return this._session(await this.request('api/collections/users/auth-refresh', { token: refreshToken })); }
  /** PocketBase tokens are stateless: signing out is forgetting the token, which the engine does. */
  async signOut() {}

  // -------------------------------------------------- RPC
  /** `raw` is the exact JSON body, so a retried mutation is byte-for-byte the same request. */
  async rpc(token, name, request, raw) {
    if (!/^avb_(me|team_members|sync_pull|sync_apply|conflicts|target_history)$/.test(name)) throw new SyncError('config', 'bad_rpc', 'Unknown call.');
    return this.request(`api/avb/rpc/${name}`,
      { token, raw: raw !== undefined ? raw : JSON.stringify(request === undefined ? {} : { p_request: request }) });
  }
}

function classify(status, body) {
  const code = body && typeof body.code === 'string' ? body.code : '';
  const avb = avbCode(body);
  if (code === '55P03') return new SyncError('busy', 'lock_timeout', 'The server is busy; retrying.', status);
  if (avb === 'not_member') return new SyncError('revoked', 'not_member', 'This account is no longer an active team member.', status);
  if (avb && code === '42501') return new SyncError(avb === 'not_authenticated' ? 'unauthorized' : 'forbidden', avb, `avb:${avb}`, status);
  if (avb) return new SyncError('refused', avb, `avb:${avb}`, status);
  if (status === 401) return new SyncError('unauthorized', 'unauthorized', 'The sign-in has expired.', status);
  if (status === 429 || status >= 500) return new SyncError('server', `http_${status}`, 'The team server had a problem; retrying.', status);
  // PocketBase field errors: only the e-mail uniqueness code is used, never the server's text.
  const email = body && body.data && body.data.email;
  const field = email && typeof email.code === 'string' && email.code === 'validation_not_unique' ? email.code : `http_${status}`;
  return new SyncError(status === 403 ? 'forbidden' : 'refused', field, `The server refused the request (HTTP ${status}).`, status);
}

module.exports = { Client, SyncError, parseBaseUrl, jwtClaims, classify, AVB_CODES };

'use strict';
// HTTPS calls to the team's Neon project: Managed Better Auth (sign-in, session, JWT) and
// the six public RPCs through the Neon Data API. Runs in the main process only. The
// renderer never sees a token, a cookie, a URL or a method: it asks for actions by name
// (see ipc.js).
//
// Better Auth keeps a session in a cookie; the Data API takes a short-lived JWT (about 15
// minutes) issued from that session. Here the session cookie plays the part of a refresh
// token and the JWT the access token, so the engine above is unchanged. Neon documents
// the SDK, not these raw REST paths: they follow Better Auth's own API and MUST be checked
// against a real Neon project before anyone relies on them (docs/NEON_SETUP.md).

class SyncError extends Error {
  /** kind: offline | unauthorized | revoked | forbidden | refused | busy | server | config | protocol */
  constructor(kind, code, message, status) { super(message); Object.assign(this, { kind, code, status }); }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * A Neon base URL (the Auth URL or the Data API URL, both with a path), normalised with
 * no trailing slash, or a SyncError: HTTPS, or plain HTTP to this computer only.
 */
function parseBaseUrl(text, what) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch (_) { throw new SyncError('config', 'bad_url', `Enter the ${what} from the Neon Console.`); }
  if (u.username || u.password) throw new SyncError('config', 'bad_url', `The ${what} must not contain a user name or password.`);
  if (u.search || u.hash) throw new SyncError('config', 'bad_url', `Enter the ${what} without anything after a ? or #.`);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)))) {
    throw new SyncError('config', 'bad_url', `The ${what} must start with https:// (plain http is allowed only for a test server on this computer).`);
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** The token's subject, read only to tell sessions apart; roles come from avb_me. */
function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch (_) { return {}; }
}

// Server text is never shown or logged: it could quote a password or token. Only these
// known codes pass through (the migration's avb:<code> set, checked by a test, and the
// Better Auth codes the app handles); everything else becomes a fixed message.
const AVB_CODES = new Set(('admin_required aggregate_rev_mismatch append_only assignment_key_only_for_children '
  + 'assignment_not_found base_version_mismatch conflict_not_found conflict_not_open duplicate_target_in_batch invalid_field '
  + 'invalid_integer invalid_key invalid_operations invalid_resolution invalid_status invalid_uuid missing_field '
  + 'mutation_id_reused no_such_auth_user not_an_object not_authenticated not_deletable not_member nothing_to_restore '
  + 'out_of_range parent_deleted payload_only_for_merged payload_required payload_too_large protocol_version_unsupported '
  + 'request_too_large restore_base_not_tombstone restore_required stale_resolution target_not_found uid_assignment_mismatch '
  + 'uid_collision unknown_field unknown_op unknown_target_type use_delete_assignment').split(' '));
// Better Auth error codes the app handles (its `code` field).
const AUTH_CODES = {
  INVALID_EMAIL_OR_PASSWORD: 'Wrong e-mail or password.', INVALID_EMAIL: 'Wrong e-mail or password.',
  INVALID_PASSWORD: 'Wrong e-mail or password.', USER_NOT_FOUND: 'Wrong e-mail or password.',
  EMAIL_NOT_VERIFIED: 'This account is not confirmed yet; open the link in its e-mail first.',
  BANNED_USER: 'This account is blocked.', SESSION_EXPIRED: 'The sign-in has expired.', UNAUTHORIZED: 'The sign-in has expired.',
  TOO_MANY_REQUESTS: 'Too many attempts; wait a minute.',
};
const SIGN_IN_CODES = new Set(['INVALID_EMAIL_OR_PASSWORD', 'INVALID_EMAIL', 'INVALID_PASSWORD', 'USER_NOT_FOUND']);
function avbCode(body) {
  const m = body && typeof body.message === 'string' ? /^avb:([a-z0-9_]+)$/.exec(body.message) : null;
  return m && AVB_CODES.has(m[1]) ? m[1] : null;
}
const authCode = (body) => (body && typeof body.code === 'string' && Object.hasOwn(AUTH_CODES, body.code) ? body.code : null);

/** The session cookie from a Better Auth answer: "name=value" of the *session_token cookie, or null. */
function sessionCookie(res) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of all) {
    const pair = String(c).split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq > 0 && /session_token$/.test(pair.slice(0, eq)) && pair.slice(eq + 1)) return pair;
  }
  return null;
}

/**
 * Transport contract: `fetch` is injected and must be a WHATWG fetch that verifies TLS
 * certificates itself, honours `redirect: 'error'`, lets the caller send a Cookie header
 * and exposes Set-Cookie (headers.getSetCookie). In the app it is Node's own fetch
 * (undici): Neon's certificates are public, so Node's bundled CA list verifies them, and
 * unlike Chromium's net.fetch it leaves the session cookie to this code. Never pass a fetch
 * that skips verification and never set NODE_TLS_REJECT_UNAUTHORIZED=0.
 */
class Client {
  constructor({ authUrl, dataUrl, fetch, timeoutMs = 20000 }) {
    if (typeof fetch !== 'function') throw new SyncError('config', 'no_transport', 'No network transport was given.');
    Object.assign(this, { authUrl, dataUrl, fetchImpl: fetch, timeoutMs });
  }

  /** One request to `${base}/${path}`, never outside `base`; returns { json, res }. */
  async request(base, method, path, { token, cookie, body, raw } = {}) {
    const url = new URL(`${base}/${path}`);
    const root = new URL(base);
    if (url.origin !== root.origin || !url.pathname.startsWith(`${root.pathname}/`)) {
      throw new SyncError('config', 'bad_url', 'Refused a request outside the configured server.');
    }
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    // Better Auth checks the Origin of cookie-bearing writes: name its own, never another.
    if (base === this.authUrl && method !== 'GET') headers.Origin = root.origin;
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await this.fetchImpl(url.href, {
        method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
        // A redirect could carry the token or cookie to another host: never follow one.
        redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new SyncError('offline', e && e.name === 'TimeoutError' ? 'timeout' : 'network', 'The team server could not be reached.');
    }
    if (res.redirected || (res.url && new URL(res.url).origin !== url.origin)) {
      throw new SyncError('config', 'redirect', 'The server redirected the request; check the server address.');
    }
    if (res.status >= 300 && res.status < 400) throw new SyncError('config', 'redirect', 'The server redirected the request; check the server address.');
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (res.ok) return { json, res };
    throw classify(res.status, json);
  }

  // -------------------------------------------------- Managed Better Auth

  /** A JWT for the Data API from a session cookie (Better Auth's JWT plugin, GET /token). */
  async _jwt(cookie) {
    const { json, res } = await this.request(this.authUrl, 'GET', 'token', { cookie });
    if (!json || typeof json.token !== 'string') throw new SyncError('protocol', 'bad_token', 'The server sent no session.');
    const claims = jwtClaims(json.token);
    if (claims.role !== 'authenticated') {
      // Neon's Data API runs a request as the JWT's role: an account given Better Auth's own
      // "admin" role would be refused. The app's admin role is the team membership instead.
      throw new SyncError('config', 'bad_role', 'This sign-in account has a Neon Auth role the Data API cannot use. Remove it in the Neon Console (Auth, Users); team admins are set by the maintainer.');
    }
    return { access_token: json.token, refresh_token: sessionCookie(res) || cookie, expires_at: Number(claims.exp) || 0, user: { id: claims.sub } };
  }

  async signIn(email, password) {
    const { res } = await this.request(this.authUrl, 'POST', 'sign-in/email', { body: { email, password } });
    const cookie = sessionCookie(res);
    if (!cookie) throw new SyncError('protocol', 'bad_token', 'The server sent no session.');
    return this._jwt(cookie);
  }
  /** A new Better Auth account. Its session is ended at once: it has no access until the maintainer adds it. */
  async signUp(email, password, name) {
    const { res } = await this.request(this.authUrl, 'POST', 'sign-up/email', { body: { email, password, name } });
    const cookie = sessionCookie(res);
    if (cookie) await this.signOut(cookie).catch(() => {});
  }
  /** `refreshToken` is the session cookie. */
  refresh(refreshToken) { return this._jwt(refreshToken); }
  async signOut(refreshToken) { await this.request(this.authUrl, 'POST', 'sign-out', { cookie: refreshToken, body: {} }); }

  // -------------------------------------------------- RPC (Neon Data API, PostgREST-compatible)
  /** `raw` is the exact JSON body, so a retried mutation is byte-for-byte the same request. */
  async rpc(token, name, request, raw) {
    if (!/^avb_(me|team_members|sync_pull|sync_apply|conflicts|target_history)$/.test(name)) throw new SyncError('config', 'bad_rpc', 'Unknown call.');
    const { json } = await this.request(this.dataUrl, 'POST', `rpc/${name}`,
      { token, raw: raw !== undefined ? raw : JSON.stringify(request === undefined ? {} : { p_request: request }) });
    return json;
  }
}

function classify(status, body) {
  const code = body && typeof body.code === 'string' ? body.code : '';
  const avb = avbCode(body);
  const auth = authCode(body);
  if (code === '55P03') return new SyncError('busy', 'lock_timeout', 'The server is busy; retrying.', status);
  if (avb === 'not_member') return new SyncError('revoked', 'not_member', 'This account is no longer an active team member.', status);
  if (avb && code === '42501') return new SyncError(avb === 'not_authenticated' ? 'unauthorized' : 'forbidden', avb, `avb:${avb}`, status);
  if (avb) return new SyncError('refused', avb, `avb:${avb}`, status);
  if (auth && SIGN_IN_CODES.has(auth)) return new SyncError('refused', 'invalid_credentials', AUTH_CODES[auth], status);
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303' || auth === 'SESSION_EXPIRED' || auth === 'UNAUTHORIZED') {
    return new SyncError('unauthorized', 'unauthorized', 'The sign-in has expired.', status);
  }
  if (status === 429 || status >= 500) return new SyncError('server', `http_${status}`, 'The team server had a problem; retrying.', status);
  if (auth) return new SyncError(status === 403 ? 'forbidden' : 'refused', auth, AUTH_CODES[auth], status);
  return new SyncError(status === 403 ? 'forbidden' : 'refused', `http_${status}`, `The server refused the request (HTTP ${status}).`, status);
}

module.exports = { Client, SyncError, parseBaseUrl, jwtClaims, classify, sessionCookie, AVB_CODES };

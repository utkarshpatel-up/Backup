'use strict';
// HTTPS calls to the team server: GoTrue (sign-in, refresh, MFA) and the six public
// RPCs. Runs in the main process only. The renderer never sees a token, a URL or a
// method: it asks for actions by name (see ipc.js).

class SyncError extends Error {
  /** kind: offline | unauthorized | revoked | forbidden | refused | busy | server | config | protocol */
  constructor(kind, code, message, status) { super(message); Object.assign(this, { kind, code, status }); }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** The server's origin, or a SyncError: HTTPS, or plain HTTP to this computer only. */
function parseServerUrl(text) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch (_) { throw new SyncError('config', 'bad_url', 'Enter the server address, e.g. https://avbackup.example.org'); }
  if (u.username || u.password) throw new SyncError('config', 'bad_url', 'The server address must not contain a user name or password.');
  if (u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new SyncError('config', 'bad_url', 'Enter only the server address, with no path, e.g. https://avbackup.example.org');
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return u.origin;
  if (u.protocol !== 'https:') throw new SyncError('config', 'bad_url', 'The server address must start with https:// (plain http is allowed only for a test server on this computer, 127.0.0.1).');
  return u.origin;
}

/** Only the publishable key (or a legacy anon key) belongs in the app; never a secret one. */
function checkPublishableKey(text) {
  const k = String(text || '').trim();
  if (/^sb_secret_/i.test(k)) throw new SyncError('config', 'secret_key', 'That is a SECRET key. Never put it in the app: use the publishable key (sb_publishable_…).');
  if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(k)) return k;
  const parts = k.split('.');
  if (parts.length === 3) {
    let claims = null;
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (_) { /* not a JWT */ }
    if (claims && claims.role === 'anon') return k;
    if (claims && claims.role) throw new SyncError('config', 'secret_key', `That key has the "${String(claims.role).slice(0, 20)}" role. Use the publishable (anon) key only.`);
  }
  throw new SyncError('config', 'bad_key', 'Enter the publishable key (sb_publishable_…) or the legacy anon key.');
}

/** The token's subject, read only to tell sessions apart; roles come from avb_me. */
function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch (_) { return {}; }
}

// Server text is never shown or logged: it could quote a password or token. Only these
// known codes pass through (the migration's avb:<code> set, checked by a test, and the
// GoTrue codes the app handles); everything else becomes a fixed message.
const AVB_CODES = new Set(('aal2_required admin_required aggregate_rev_mismatch append_only assignment_key_only_for_children '
  + 'assignment_not_found base_version_mismatch conflict_not_found conflict_not_open duplicate_target_in_batch invalid_field '
  + 'invalid_integer invalid_key invalid_operations invalid_resolution invalid_status invalid_uuid missing_field '
  + 'mutation_id_reused no_such_auth_user not_an_object not_authenticated not_deletable not_member nothing_to_restore '
  + 'out_of_range parent_deleted payload_only_for_merged payload_required payload_too_large protocol_version_unsupported '
  + 'request_too_large restore_base_not_tombstone restore_required stale_resolution target_not_found uid_assignment_mismatch '
  + 'uid_collision unknown_field unknown_op unknown_target_type use_delete_assignment').split(' '));
const AUTH_CODES = {
  invalid_credentials: 'Wrong e-mail or password.',
  refresh_token_not_found: 'The sign-in has expired.', refresh_token_already_used: 'The sign-in has expired.',
  session_not_found: 'The sign-in has expired.', bad_jwt: 'The sign-in has expired.',
  mfa_verification_failed: 'The authenticator code was not accepted.', mfa_challenge_expired: 'The authenticator code expired; try again.',
  mfa_factor_not_found: 'The authenticator is not set up.', mfa_totp_enroll_not_enabled: 'Authenticator codes are not turned on at the server.',
  mfa_verification_rejected: 'The authenticator code was not accepted.', insufficient_aal: 'Confirm with your authenticator code first.',
  over_request_rate_limit: 'Too many attempts; wait a minute.', user_banned: 'This account is blocked.', email_not_confirmed: 'This account is not confirmed yet.',
};
function avbCode(body) {
  const m = body && typeof body.message === 'string' ? /^avb:([a-z0-9_]+)$/.exec(body.message) : null;
  return m && AVB_CODES.has(m[1]) ? m[1] : null;
}
const authCode = (body) => (body && typeof body.error_code === 'string' && Object.hasOwn(AUTH_CODES, body.error_code) ? body.error_code : null);

/**
 * Transport contract: `fetch` is injected and must be a WHATWG fetch that verifies TLS
 * certificates itself and honours `redirect: 'error'`. In the app it is meant to be
 * Electron's `net.fetch` (Chromium's network stack, which trusts the OS certificate
 * store, so a private office CA installed in Windows/macOS is accepted with full
 * verification). Node's own fetch only trusts its bundled CAs (plus NODE_EXTRA_CA_CERTS).
 * Never pass a fetch that skips verification, never set NODE_TLS_REJECT_UNAUTHORIZED=0,
 * and never answer Electron's 'certificate-error' event with "trust it".
 */
class Client {
  constructor({ origin, apikey, fetch, timeoutMs = 20000 }) {
    if (typeof fetch !== 'function') throw new SyncError('config', 'no_transport', 'No network transport was given.');
    Object.assign(this, { origin, apikey, fetchImpl: fetch, timeoutMs });
  }

  async request(method, path, { token, body, raw } = {}) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new SyncError('config', 'bad_url', 'Refused a request outside the configured server.');
    const headers = { apikey: this.apikey, Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await this.fetchImpl(url.href, {
        method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
        // A redirect could carry the token to another host: never follow one.
        redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new SyncError('offline', e && e.name === 'TimeoutError' ? 'timeout' : 'network', 'The team server could not be reached.');
    }
    if (res.redirected || (res.url && new URL(res.url).origin !== this.origin)) {
      throw new SyncError('config', 'redirect', 'The server redirected the request; check the server address.');
    }
    if (res.status >= 300 && res.status < 400) throw new SyncError('config', 'redirect', 'The server redirected the request; check the server address.');
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (res.ok) return json;
    throw classify(res.status, json);
  }

  // -------------------------------------------------- GoTrue
  signIn(email, password) { return this.request('POST', '/auth/v1/token?grant_type=password', { body: { email, password } }); }
  refresh(refreshToken) { return this.request('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } }); }
  signOut(token) { return this.request('POST', '/auth/v1/logout?scope=local', { token }); }
  user(token) { return this.request('GET', '/auth/v1/user', { token }); }
  enrollTotp(token) { return this.request('POST', '/auth/v1/factors', { token, body: { factor_type: 'totp', friendly_name: `AV Backup ${new Date().toISOString().slice(0, 10)}` } }); }
  challenge(token, factorId) { return this.request('POST', `/auth/v1/factors/${encodeURIComponent(factorId)}/challenge`, { token, body: {} }); }
  verify(token, factorId, challengeId, code) {
    return this.request('POST', `/auth/v1/factors/${encodeURIComponent(factorId)}/verify`, { token, body: { challenge_id: challengeId, code } });
  }

  // -------------------------------------------------- RPC
  /** `raw` is the exact JSON body, so a retried mutation is byte-for-byte the same request. */
  rpc(token, name, request, raw) {
    if (!/^avb_(me|team_members|sync_pull|sync_apply|conflicts|target_history)$/.test(name)) throw new SyncError('config', 'bad_rpc', 'Unknown call.');
    return this.request('POST', `/rest/v1/rpc/${name}`, { token, raw: raw !== undefined ? raw : JSON.stringify(request === undefined ? {} : { p_request: request }) });
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
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303' || auth === 'bad_jwt') return new SyncError('unauthorized', 'unauthorized', 'The sign-in has expired.', status);
  if (status === 400 && (auth === 'invalid_credentials' || auth === 'refresh_token_not_found' || auth === 'refresh_token_already_used' || auth === 'session_not_found' || (body && body.error === 'invalid_grant'))) {
    return new SyncError('unauthorized', auth || 'invalid_grant', 'Wrong e-mail or password, or the sign-in has expired.', status);
  }
  if (status === 429 || status >= 500) return new SyncError('server', `http_${status}`, 'The team server had a problem; retrying.', status);
  if (auth) return new SyncError(status === 403 ? 'forbidden' : 'refused', auth, AUTH_CODES[auth], status);
  return new SyncError(status === 403 ? 'forbidden' : 'refused', `http_${status}`, `The server refused the request (HTTP ${status}).`, status);
}

module.exports = { Client, SyncError, parseServerUrl, checkPublishableKey, jwtClaims, classify, AVB_CODES };

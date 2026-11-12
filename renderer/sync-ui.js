'use strict';

// One displayed revision and one durable commit chain. Status events never advance
// the edit base; only a clean view replacement or our own commit can do that.
const syncUI = {
  operations: 0, status: { mode: 'local' }, rev: null, epoch: 0, dirty: false, saving: 0,
  chain: Promise.resolve(), loading: false, changing: false, preparing: false,
  backupBase: null, prepUndo: null, teamCities: false, team: {}, deleted: [], conflicts: [], reviews: [], error: '', waiting: false,
};
function syncAccount() { return syncUI.status.mode === 'account'; }
function syncAvailable() { return syncAccount() && syncUI.status.signedIn && !syncUI.status.locked && syncUI.rev != null; }
function syncBusy() {
  return !!(syncUI.operations || syncUI.preparing || state.busy || state.scheduleRun || state.report?.loading
    || state.schedules?.items.some((s) => s.busy));
}
function syncClean() {
  return !syncUI.dirty && !syncUI.saving && !syncUI.changing && !syncBusy()
    && !scheduleRememberTimer && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
}
function syncSettings(local = {}) {
  return syncAccount() ? { scheduleDefaults: syncUI.team.defaults || {}, scheduleStarts: syncUI.team.starts || {},
    scheduleMemory: syncUI.team.memory || { titles: [], places: [] } } : local;
}
function syncTeamSettings(patch) {
  if (!syncAccount()) return window.api.setSettings(patch);
  if (!syncAvailable()) return Promise.reject(new Error('Account unavailable.'));
  for (const [key, value] of Object.entries(patch)) {
    const field = { scheduleDefaults: 'defaults', scheduleStarts: 'starts', scheduleMemory: 'memory' }[key];
    if (field) syncUI.team[field] = value;
  }
  scheduleRemember();
  return Promise.resolve();
}
function syncClear() {
  syncUI.epoch++; syncUI.rev = null; syncUI.team = {}; syncUI.deleted = [];
  syncUI.conflicts = []; syncUI.reviews = []; syncUI.dirty = false; syncUI.viewSig = null; syncUI.history = null;
  clearTimeout(scheduleRememberTimer); scheduleRememberTimer = null;
  state.schedules = { openId: null, items: [] }; state.schedule = null;
  state.cities = null; state.citySource = null; state.report = null; syncUI.teamCities = false;
}
function syncSnapshot() {
  for (const s of state.schedules?.items || []) {
    for (const r of s.sessions || []) if (!r.uid) r.uid = crypto.randomUUID();
  }
  // Lists go only when this screen holds the team's copy (or a fresh import): an unloaded
  // report or the built-in city list would otherwise read as "delete every record".
  const out = { schedules: { ...state.schedules, openId: state.schedule?.id || null }, team: syncUI.team, citySource: state.citySource };
  if (syncUI.teamCities || state.citySource) out.cities = state.cities;
  const copy = JSON.parse(JSON.stringify(out));
  // Not copied: in account mode this list is only ever replaced whole, never edited.
  if (Array.isArray(state.report?.existing)) copy.report = state.report.existing;
  return copy;
}
function syncCommit(baseRev) {
  if (!syncAccount()) return Promise.resolve();
  if (!syncUI.status.signedIn || syncUI.rev == null) return syncUI.dirty ? Promise.reject(new Error('Account unavailable; edits remain on screen.')) : Promise.resolve();
  const snapshot = syncSnapshot(), epoch = syncUI.epoch;
  const busy = (state.schedules?.items || []).filter((s) => s.busy).map((s) => s.id);
  syncUI.saving++;
  const operation = syncUI.chain.catch(() => {}).then(async () => {
    if (epoch !== syncUI.epoch) throw new Error('Account changed.');
    const result = await window.api.sync.commit({ baseRev: baseRev ?? syncUI.rev, snapshot, busy });
    if (!result.ok) throw new Error('Some entries need correction before they can sync.');
    if (epoch !== syncUI.epoch) return;
    syncUI.rev = result.rev;
    syncUI.error = result.warnings?.length ? 'Possible duplicates were found. Review the imported entries; schedules are kept separately.' : '';
  }).catch((e) => { syncUI.dirty = true; throw e; }).finally(() => { syncUI.saving--; if (syncUI.waiting) setTimeout(() => syncRefresh().catch(() => {}), 0); });
  syncUI.dirty = false;
  syncUI.chain = operation;
  return operation;
}
async function syncRefresh() {
  if (!syncAccount() || !syncClean() || syncUI.loading) { syncUI.waiting = true; return; }
  const epoch = syncUI.epoch;
  syncUI.loading = true;
  try {
    const view = await window.api.sync.view();
    if (epoch !== syncUI.epoch || !syncClean()) { syncUI.waiting = true; return; }
    if (!view.signedIn || view.locked) { syncClear(); return; }
    syncUI.rev = view.rev;
    // Most status events carry the same data: only the base moves. Skip rebuilding the
    // page, which would drop the report's filters and the schedule's row identity.
    const sig = JSON.stringify([view.data, syncUI.status.phase, syncUI.status.user?.role]);
    if (sig === syncUI.viewSig) { syncUI.waiting = false; if (state.view === 'account') render(); return; }
    syncUI.viewSig = sig;
    syncUI.team = view.data.team || {}; syncUI.deleted = view.data.deleted || [];
    state.schedules = view.data.schedules;
    const settings = syncSettings();
    state.schedules.items.forEach((s) => scheduleHydrate(s, settings));
    state.schedule = state.schedules.items.find((s) => s.id === state.schedules.openId) || null;
    // No team list yet: the built-in one (scheduleCities) is used, and not uploaded.
    syncUI.teamCities = Array.isArray(view.data.cities); state.cities = view.data.cities || null; state.citySource = view.data.citySource;
    state.report = { file: 'Team cache', existing: view.data.report || [], loading: false, filters: state.report?.filters || {}, columns: state.report?.columns || {}, limit: state.report?.limit || 300 };
    syncUI.waiting = false;
    render();
  } finally { syncUI.loading = false; }
}
async function syncStatus(status) {
  const lost = syncAccount() && (!status.signedIn || status.locked);
  syncUI.status = status;
  if (lost) {
    if (syncUI.revoking) return;
    syncUI.revoking = true;
    try {
      // Membership loss must not erase a pending debounce. Locked commits stay
      // encrypted and the engine refuses to upload until membership is restored.
      if (status.signedIn && syncUI.rev != null) {
        document.activeElement?.blur?.();
        await scheduleFlush();
      }
      syncUI.conflicts = []; syncUI.reviews = []; syncUI.deleted = [];
      if (!syncBusy()) syncClear();
      render();
    } finally { syncUI.revoking = false; }
    return;
  }
  await syncRefresh();
}
async function syncInit() {
  if (!window.api.sync) return false;
  // Fail closed: a failed status read must never open another account's local files.
  syncUI.status = { mode: 'account' };
  try { syncUI.status = await window.api.sync.status(); }
  catch (_) { syncUI.error = 'Account status is unavailable. Restart the app to try again.'; }
  window.api.sync.onStatus((s) => {
    syncStatus(s).catch(() => { syncUI.error = 'Could not refresh account data.'; })
      .finally(() => { if (state.view === 'account') syncPaint(); });
  });
  window.api.sync.onProgress?.((p) => { Object.assign(syncUI.status, p); if (state.view === 'account') syncPaint(); });
  document.addEventListener('focusout', () => setTimeout(() => {
    if (syncUI.waiting) syncRefresh().catch(() => {});
  }, 0));
  if (syncAccount()) { syncClear(); await syncRefresh(); }
  return syncAccount();
}
async function syncTransition(action) {
  if (syncBusy() || syncUI.changing) throw Object.assign(new Error('Finish or put aside the backup first.'), { kind: 'busy' });
  syncUI.changing = true;
  try {
    await scheduleFlush();
    await action();
    syncClear();
    syncUI.status = await window.api.sync.status();
    if (!syncAccount()) await restoreSchedules(await window.api.getSettings());
  } finally { syncUI.changing = false; }
  await syncRefresh();
  if (!syncAccount()) reportPreload();
}
/** `undoable`: nothing is on the drive yet, so a failed start puts the row back (syncUnprepare). */
async function syncProtect(s, row, undoable = false) {
  if (!syncAccount()) return;
  if (!syncAvailable()) throw new Error('Account unavailable.');
  syncUI.preparing = true;
  syncUI.prepUndo = undoable ? { row, had: 'startedAt' in row, startedAt: row.startedAt, folder: row.folder, session: row.session } : null;
  try {
    row.startedAt = row.startedAt || new Date().toISOString();
    const n = SCHEDULE.assignNumbers(s.sessions, s.starts).get(row.key);
    if (n) { if (row.folder == null) row.folder = n.folder; if (!row.session) row.session = n.session; }
    await scheduleFlush(); await window.api.sync.protect({ assignmentId: s.id, uid: row.uid, baseRev: syncUI.rev }); syncUI.backupBase = syncUI.rev; }
  catch (e) { syncUI.preparing = false; throw e; }
}
/** The start failed before anything reached the drive: the row is as it was, here and for the team. */
async function syncUnprepare() {
  const u = syncUI.prepUndo;
  syncUI.prepUndo = null;
  if (!u) return;
  if (syncAccount()) await window.api.sync.protect();   // identity fields can change only once unprotected
  u.row.folder = u.folder; u.row.session = u.session;
  if (u.had) u.row.startedAt = u.startedAt; else delete u.row.startedAt;
  await scheduleFlush();
}
async function syncOperation(fn) {
  if (!syncAccount()) return fn();
  if (!syncAvailable() || syncBusy() || syncUI.changing) return;
  syncUI.operations++;
  try { return await fn(); }
  finally {
    syncUI.operations--;
    if (syncUI.status.locked) await syncStatus(syncUI.status);
    else if (syncUI.waiting) await syncRefresh();
  }
}
async function syncPreparation(fn) {
  if (!syncAccount()) return fn();
  if (!syncAvailable() || syncUI.preparing || state.scheduleRun) { toast('Finish or put aside the prepared backup first.', 'warn'); return; }
  syncUI.preparing = true;
  try { return await fn(); }
  finally { syncUI.preparing = false; if (!state.scheduleRun) await syncRelease(); }
}
async function syncRelease() {
  syncUI.preparing = false; syncUI.backupBase = null;
  if (syncAccount()) {
    await window.api.sync.protect();
    if (syncUI.status.locked || !syncUI.status.signedIn) { syncClear(); render(); }
    else await syncRefresh();
  }
}
function syncCanDelete() { return syncAvailable() && syncUI.status.user?.role === 'admin' && syncUI.status.phase === 'online' && !syncBusy(); }
async function syncDelete(id) {
  if (!syncCanDelete()) { toast('Only an admin who is online can delete a whole schedule.', 'warn'); return; }
  syncUI.changing = true;
  try {
    await scheduleFlush();
    const rev = syncUI.rev;
    if (!await window.api.confirm({ message: 'Delete this whole team schedule?', detail: 'All operators will lose access to it. An admin can restore it later.', confirmLabel: 'Delete', danger: true })) return;
    const r = await window.api.sync.deleteAssignment({ id, rev });
    if (!r.ok) throw new Error('The schedule changed; review it again.');
  } finally { syncUI.changing = false; }
  await syncRefresh();
}
async function syncImport() {
  if (!syncAvailable() || syncBusy()) throw new Error('Account unavailable or busy.');
  syncUI.changing = true;
  try {
    await scheduleFlush();
    const settings = await window.api.getSettings();
    let report = [];
    if (settings.reportSource) {
      const localCities = await window.api.getStore('cities');
      const cities = SCHEDULE.parseCities(localCities?.rows || window.VIngestCityRows || []);
      report = SCHEDULE.parseReport((await call('schedule_read_table', { path: settings.reportSource }, { label: 'Reading the report file' })).rows, cities);
      if (!report.length) throw new Error('No Raw Video Id / ID column was found in the report file.');
    }
    const preview = await window.api.sync.importLocal(false, report);
    if (!preview.ok) {
      const list = (preview.problems || []).slice(0, 5).map((p) => `${p.where || ''} ${p.field}: ${p.code}`.trim()).join('; ');
      throw new Error(`Some entries need correcting before import${list ? `: ${list}` : ''}.`);
    }
    const warns = preview.warnings || [];
    // A large old sheet can carry thousands of duplicate-ID warnings: show the first few.
    const details = `${preview.counts.schedules} schedules, ${preview.counts.rows} rows, ${report.length} report records. Originals stay unchanged.\n`
      + warns.slice(0, 10).map((w) => w.text).join('\n') + (warns.length > 10 ? `\n…and ${warns.length - 10} more notes.` : '');
    if (!await window.api.confirm({ message: 'Import this computer’s local data into the team?', detail: details, confirmLabel: 'Import', danger: false })) return;
    const result = await window.api.sync.importLocal(true, report);
    if (!result.ok) throw new Error('Import needs review.');
  } finally { syncUI.changing = false; }
  await syncRefresh();
}
async function showSync() {
  await scheduleFlush();
  state.view = 'account';
  syncUI.conflicts = await window.api.sync.conflicts();
  syncUI.reviews = await window.api.sync.reviews();
  render();
  if (syncAvailable()) syncLoadHistory(false);
}
const SYNC_PHASE = {
  online: ['Connected', 'ok'], offline: ['Offline', 'warn'], connecting: ['Connecting', ''], expired: ['Sign-in expired', 'warn'],
  revoked: ['Access removed', 'err'], error: ['Connection problem', 'err'], signed_out: ['Signed out', ''],
};
const syncNeedsSignIn = (s) => !s.signedIn || (s.phase === 'expired' && !s.locked);
const syncField = (id, label, attrs, extra = '') => `<div class="sync-field"><label for="${id}">${label}</label>
    <div class="sync-input">${`<input id="${id}" ${attrs} aria-describedby="${id}Err" spellcheck="false" autocapitalize="off" data-lock-input>`}${extra}</div>
    <p class="sync-err" id="${id}Err" hidden></p></div>`;
// Emails that signed in on this computer, newest first, offered as a dropdown on the sign-in form.
const RECENT_EMAILS_KEY = 'avb.recentEmails';
function syncRecentEmails() {
  try { const l = JSON.parse(localStorage.getItem(RECENT_EMAILS_KEY) || '[]'); return Array.isArray(l) ? l.filter((e) => typeof e === 'string') : []; } catch (_) { return []; }
}
function syncRememberEmail(email) {
  const e = String(email || '').trim();
  if (!e) return;
  try { localStorage.setItem(RECENT_EMAILS_KEY, JSON.stringify([e, ...syncRecentEmails().filter((x) => x.toLowerCase() !== e.toLowerCase())].slice(0, 10))); } catch (_) { /* storage unavailable: no recents */ }
}
const syncEmailField = () => syncField('syncEmail', 'Email', `type="email" autocomplete="username" list="syncRecentEmails" value="${esc(syncUI.draftEmail || '')}"`)
  + `<datalist id="syncRecentEmails">${syncRecentEmails().map((e) => `<option value="${esc(e)}"></option>`).join('')}</datalist>`;
const syncPasswordField = (hint, autocomplete) => syncField('syncPassword', 'Password', `type="password" autocomplete="${autocomplete}" placeholder="${hint}"`,
  '<button type="button" class="ghost sync-eye" data-toggle-password aria-pressed="false" aria-controls="syncPassword">Show</button>');

/** One form at a time: sign in, or (after asking for it) create an account. Hidden while the session is good. */
function syncAuthForm(s) {
  if (!syncNeedsSignIn(s)) return '';
  if (syncUI.authMode === 'create') {
    return `<form class="card sync-card sync-form" id="syncForm" data-form="signup" novalidate aria-labelledby="syncFormTitle">
      <h3 id="syncFormTitle">Create your account</h3>
      <p class="hint">Your account has no access until the maintainer adds you to the team.</p>
      ${syncField('syncName', 'Your name', 'type="text" autocomplete="name"')}
      ${syncEmailField()}
      ${syncPasswordField('At least 8 characters', 'new-password')}
      <button type="submit" id="syncSignUp" class="primary sync-submit" data-lock>Create account</button>
      <button type="button" id="syncToSignIn" class="ghost sync-switch" data-lock>Already have an account? Sign in</button>
    </form>`;
  }
  const expired = s.signedIn;
  return `<form class="card sync-card sync-form" id="syncForm" data-form="signin" novalidate aria-labelledby="syncFormTitle">
      <h3 id="syncFormTitle">${expired ? 'Sign in again' : 'Sign in'}</h3>
      ${expired ? '<p class="hint">Your sign-in has expired. Edits made here are kept and sync after you sign in.</p>' : ''}
      ${syncEmailField()}
      ${syncPasswordField('', 'current-password')}
      <button type="submit" id="syncSignIn" class="primary sync-submit" data-lock>Sign in</button>
      ${expired ? '' : '<button type="button" id="syncToCreate" class="ghost sync-switch" data-lock>New here? Create an account</button>'}
    </form>`;
}
function syncHeroHtml(s, enabled) {
  const [phase, tone] = SYNC_PHASE[s.phase] || [s.phase || '', ''];
  const [title, text] = !enabled ? ['Working on this computer', 'Schedules and reports stay in local files. Turn on the team account to share them.']
    : s.locked ? ['Account locked', 'This account is no longer an active team member. Its offline copy is locked and unsent changes are held.']
      : !s.signedIn ? ['Sign in to open team data', 'Team schedules and report records appear here once you sign in.']
        : ['Team sync', s.phase === 'offline' ? 'Offline. Changes are kept in the encrypted copy and sent when the server can be reached.'
          : 'Schedules and report records stay in step with the team.'];
  return `<div class="sync-hero"><div><h3 id="syncTitle" tabindex="-1">${esc(title)}</h3><p>${esc(text)}</p></div>
    ${enabled && phase ? `<span class="badge ${tone}">${esc(phase)}</span>` : '<span class="badge">Local</span>'}</div>
    ${syncBusy() ? '<p class="note warn sync-busy">A backup is running or prepared. Account changes wait until it finishes.</p>' : ''}`;
}
function syncFeedbackHtml(s) {
  if (syncUI.action) return `<p class="note info" role="status">${esc(SYNC_BUSY_TEXT[syncUI.action] || 'Working…')}</p>`;
  if (syncUI.error) return `<p class="note err" role="alert">${esc(syncUI.error)}</p>`;
  if (syncUI.notice) return `<p class="note ok" role="status">${esc(syncUI.notice)}</p>`;
  // Fixed text only: engine errors are not shown as written.
  return s.error ? '<p class="note warn" role="status">Connection or account action failed. Your saved edits remain on this computer.</p>' : '';
}
/** The upload line. "All sent" is claimed only when online with nothing outstanding. Counts and fixed text only. */
function syncUploadHtml(s) {
  const pending = Number(s.pending || 0), held = Number(s.held || 0), conflicts = Number(s.conflicts || 0), failed = Number(s.failed?.length || 0);
  const count = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const live = !s.locked && (s.phase === 'online' || s.phase === 'connecting');
  const parts = [];
  if (pending) parts.push(live ? `<b>Uploading to the team: ${count(pending, 'change', 'changes')} left.</b> This continues in the background.`
    : `<b>${count(pending, 'change is', 'changes are')} waiting to upload.</b>`);
  if (held) parts.push(`${count(held, 'change is', 'changes are')} held on this computer and not being sent${s.locked ? '' : ' until conflicts are reviewed'}.`);
  if (conflicts) parts.push(`${count(conflicts, 'conflict needs', 'conflicts need')} a decision before syncing can finish.`);
  // The engine lists at most 50 failures.
  if (failed) parts.push(`${failed >= 50 ? '50 or more changes' : count(failed, 'change', 'changes')} could not be sent and stay on this computer.`);
  const clear = !parts.length;
  if (s.locked) parts.push('This account is locked, so nothing is being sent.');
  else if (s.phase === 'expired') parts.push('Sign in again to continue syncing.');
  else if (s.phase === 'online' && clear) parts.push('Everything on this computer has been sent.');
  else if (s.phase === 'connecting' && clear) parts.push('Checking with the team server.');
  else if (!live && pending) parts.push('Uploads resume when the server can be reached.');
  else if (!live && clear) parts.push('Nothing is waiting to upload. Sync can be confirmed once the server can be reached.');
  return parts.join(' ');
}
/** The dashboard in three parts, so a count going down leaves the buttons (and the keyboard focus) alone. */
function syncDashHtml(s) {
  if (!s.signedIn) return { who: '', tiles: '', act: '' };
  const pending = Number(s.pending || 0);
  const tile = (label, value, tone) => `<div class="sync-tile ${value ? tone : ''}"><dt>${label}</dt><dd>${Number(value || 0).toLocaleString()}</dd></div>`;
  const name = s.user?.displayName || 'Signed in';
  return {
    who: `<div class="sync-id"><span class="sync-avatar" aria-hidden="true">${esc(name.trim().charAt(0).toUpperCase() || '?')}</span>
        <div class="sync-who"><h3 id="syncUser" tabindex="-1">${esc(name)}</h3><p class="hint">${esc(s.user?.role || '')}</p></div>
        <button id="syncSignOut" class="sm" data-lock>Sign out</button></div>`,
    tiles: `<dl class="sync-tiles">${tile('Waiting to upload', pending, 'warn')}${tile('Held', s.held, 'warn')}${tile('Conflicts', s.conflicts, 'err')}${tile('Failed', s.failed?.length, 'err')}</dl>
      <p class="sync-upload" role="status">${syncUploadHtml(s)}${s.lastSync ? ` Last synced ${esc(fmtTime(s.lastSync))}.` : ''}</p>`,
    act: syncNeedsSignIn(s) || s.locked ? '' : `<div class="sync-actions"><button id="syncNow" class="primary" data-lock>Sync now</button>
        <button id="syncImport" data-lock>Preview local import…</button></div>`,
  };
}
function syncTeamHtml(s, enabled) {
  return `<section class="card sync-card" aria-labelledby="syncTeamTitle">
      <div class="sync-toggle"><div><h3 id="syncTeamTitle">Team account</h3>
        <p class="hint">Local mode is the default. Account mode shares all schedules and report records with the team; machine paths stay on this computer.</p></div>
      <label class="sync-switch-row"><input id="syncEnabled" type="checkbox" role="switch" ${enabled ? 'checked' : ''} data-lock><span>Use team account</span></label></div>
      ${s.signedIn ? '<p class="hint sync-tuck">Sign out before changing the server or turning account mode off.</p>' : ''}
      <details id="syncAdvanced" class="sync-advanced"><summary>Advanced settings</summary>
        <form id="syncConfigForm" class="sync-form" novalidate>
          <p class="hint">The team server's ZeroTier address. This computer must be joined to the team's ZeroTier network.</p>
          ${syncField('syncServerUrl', 'Server address', `type="url" autocomplete="off" placeholder="http://10.147.20.5:8090" value="${esc(s.config?.serverUrl || '')}"`)}
          <button type="submit" id="syncConfig" data-lock>Save server settings</button>
        </form>
      </details>
      <p class="hint sync-tuck">Offline access uses an encrypted cache. Membership revocation cannot be discovered until the server is reached.</p>
    </section>`;
}
// History: what each team member changed, as "NAME changed value of FIELD from A to B".
const HISTORY_FIELDS = { date: 'Date', type: 'Satsang Type', activity: 'Activity', place: 'Place Detail', city: 'City', topic: 'Topic/Description',
  events: 'Event Type', languages: 'Language', author: 'Author', format: 'Format', duration: 'Duration', clips: 'No of clips',
  cameras: 'No of cameras', folder: 'Folder', session: 'Session', remarks: 'Remarks', state: 'State', country: 'Country', include: 'Included' };
const historyText = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
function historyLines(h) {
  const who = h.actor_name || 'A team member';
  const p = h.payload || {}, prev = h.previous || {};
  const what = h.target_type === 'report_record' ? `report entry ${p.id || prev.id || ''}`
    : h.target_type === 'session' ? `session ${[p.date || prev.date, p.topic || prev.topic].filter(Boolean).join(' ')}`.trim()
      : `schedule ${p.label || prev.label || ''}`.trim();
  if (h.action === 'delete') return [`${who} deleted ${what}`];
  if (h.action === 'restore') return [`${who} restored ${what}`];
  if (h.action === 'create' || !h.previous) {
    return [`${who} ${h.target_type === 'report_record' ? 'imported' : 'added'} ${what}`];
  }
  const out = [];
  for (const [k, label] of Object.entries(HISTORY_FIELDS)) {
    if (!(k in p) && !(k in prev)) continue;
    const a = historyText(prev[k]), b = historyText(p[k]);
    if (a !== b) out.push(`${who} changed value of ${label} from "${a}" to "${b}" on ${what}`);
  }
  if (h.target_type === 'assignment' && prev.label !== p.label) out.push(`${who} renamed ${what} (was "${historyText(prev.label)}")`);
  return out;
}
async function syncLoadHistory(more) {
  const h = syncUI.history || (syncUI.history = { items: [], next: null, loaded: false, error: '' });
  try {
    const r = await window.api.sync.history(more ? h.next : undefined);
    h.items = more ? h.items.concat(r.items) : r.items;
    h.next = r.has_more ? r.next_before : null; h.error = '';
  } catch (e) { h.error = e && e.message ? e.message : 'History could not be loaded.'; }
  h.loaded = true;
  if (state.view === 'account') syncPaint();
}
function syncHistoryHtml() {
  const h = syncUI.history;
  if (!syncAvailable() || !h) return '';
  const rows = h.items.flatMap((it) => historyLines(it).map((t) => `<li>${esc(t)} <span class="hint">— ${esc(fmtTime(it.created_at))}</span></li>`));
  return `<section class="card sync-card" aria-labelledby="syncHistTitle"><h3 id="syncHistTitle">History</h3>
    ${h.error ? `<p class="note err">${esc(h.error)}</p>` : ''}
    ${rows.length ? `<ul class="sync-history">${rows.join('')}</ul>` : `<p class="hint">${h.loaded ? 'No changes yet.' : 'Loading…'}</p>`}
    ${h.next ? '<button id="syncHistMore" class="sm">Show older changes</button>' : ''}</section>`;
}
function syncReviewHtml() {
  const disabled = syncBusy() || syncUI.changing ? 'disabled' : '';
  return `${(syncAvailable() ? syncUI.conflicts : []).map((c, i) => `<div class="card sync-panel"><h3>Conflict: ${esc(c.schedule || c.targetType)}</h3>
      <p>Choose an alternative, then return to the schedule to edit it.</p>
      <pre>${esc(JSON.stringify({ current: c.current, incoming: c.incoming, draft: c.draft }, null, 2))}</pre>
      ${['keep_current', 'accept_incoming', ...(c.draft ? ['mine'] : [])].map((choice) => `<button data-conflict="${i}" data-choice="${choice}" ${disabled || (c.kind === 'assignment_delete_stale' && !syncCanDelete() ? 'disabled' : '')}>${choice === 'keep_current' ? 'Keep current' : choice === 'accept_incoming' ? 'Accept incoming' : 'Keep my draft'}</button>`).join('')}</div>`).join('')}
    ${(syncAvailable() ? syncUI.reviews : []).map((r, i) => `<div class="card sync-panel"><h3>Review saved draft</h3><pre>${esc(JSON.stringify({ current: r.current, draft: r.value }, null, 2))}</pre><button data-discard="${i}" ${disabled}>Discard draft</button><button data-retry="${i}" ${disabled}>Use this draft against the shown current value</button><p>After choosing, return to the schedule to edit.</p></div>`).join('')}
    ${(syncAvailable() ? syncUI.deleted : []).map((s, i) => `<div class="card sync-panel">${esc(s.label)} <button data-restore="${i}" ${syncCanDelete() ? '' : 'disabled'}>Restore schedule</button></div>`).join('')}
    ${syncAvailable() ? '<p class="hint">Deleted schedules are listed only if this device previously saw them. Fresh-device history is unavailable.</p>' : ''}`;
}
/** The page in parts: form regions hold no busy state or typed text, so background updates leave them alone. */
function syncRegions() {
  const s = syncUI.status, enabled = syncAccount();
  return { hero: syncHeroHtml(s, enabled), feedback: syncFeedbackHtml(s), auth: enabled ? syncAuthForm(s) : '',
    ...(enabled ? syncDashHtml(s) : { who: '', tiles: '', act: '' }), aside: enabled && state.scheduleRun && !state.busy ? '<p><button id="syncPutAside">Put aside prepared backup</button></p>' : '',
    team: syncTeamHtml(s, enabled), history: syncHistoryHtml(), review: syncReviewHtml() };
}
function renderSyncPage(regions = syncRegions()) {
  const region = (name, attrs = '') => `<div data-region="${name}"${attrs}>${regions[name]}</div>`;
  return `<div class="sync-page">${region('hero')}${region('feedback', ' aria-live="polite"')}${region('auth')}
    <section class="card sync-card sync-dash" aria-labelledby="syncUser">${region('who')}${region('tiles')}${region('act')}</section>
    ${region('aside')}${region('history')}${region('team')}${region('review')}</div>`;
}
function syncPaint() {
  const regions = syncRegions();
  PAINT.paint($('content'), 'account', regions, { full: () => renderSyncPage(regions), wire: wireSyncPage });
  syncApplyLocks();
}
/** Busy state is set on the controls directly, so it never redraws (and empties) a form. */
function syncApplyLocks() {
  const locked = syncBusy() || syncUI.changing || !!syncUI.action;
  document.querySelectorAll('.sync-page [data-lock]').forEach((el) => {
    el.disabled = locked || (el.id === 'syncEnabled' && !!syncUI.status.signedIn);
    if (el.tagName === 'BUTTON') { if (el.id === syncUI.action) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy'); }
  });
  // Inputs lock only while their own action runs: a backup starting must not take the focus away.
  document.querySelectorAll('.sync-page [data-lock-input]').forEach((el) => { el.disabled = !!syncUI.action; });
  const details = $('syncAdvanced');
  if (details && details.open !== !!syncUI.advancedOpen) details.open = !!syncUI.advancedOpen;
}
const SYNC_BUSY_TEXT = { syncSignIn: 'Signing in…', syncSignUp: 'Creating your account…', syncSignOut: 'Signing out…', syncNow: 'Syncing with the team…', syncImport: 'Preparing the import preview…', syncConfig: 'Saving server settings…', syncPutAside: 'Putting the backup aside…', syncEnabled: 'Changing account mode…' };

function syncFieldError(id, message) {
  const el = $(id), err = $(`${id}Err`);
  if (!el || !err) return;
  err.textContent = message || '';
  err.hidden = !message;
  el.toggleAttribute('aria-invalid', !!message);
  if (message) el.setAttribute('aria-invalid', 'true');
}
/** Field problems for this form (the engine's own rules), or null. */
function syncCheckForm(mode, values) {
  const out = {};
  if (mode === 'signup' && !values.name.trim()) out.syncName = 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+$/.test(values.email.trim())) out.syncEmail = 'Enter a valid email address.';
  if (!values.password) out.syncPassword = 'Enter your password.';
  else if (mode === 'signup' && values.password.length < 8) out.syncPassword = 'Use at least 8 characters.';
  return Object.keys(out).length ? out : null;
}
function syncShowErrors(ids, problems) {
  for (const id of ids) syncFieldError(id, problems && problems[id]);
  const first = problems && ids.find((id) => problems[id]);
  if (first) $(first)?.focus();
  return !first;
}
/** Run one page action: one at a time, with progress and a clear result. */
async function syncAct(id, fn, focusAfter) {
  if (syncUI.action) return;
  syncUI.action = id; syncUI.error = ''; syncUI.notice = '';
  // A focused field counts as an edit in progress and would hold back the view this action loads.
  document.activeElement?.blur?.();
  syncPaint();
  try { await fn(); syncUI.focusNext = focusAfter; }
  // Fixed texts only: account errors from preload (ipc.js safeError) and this page's own plain Error refusals.
  catch (e) {
    const known = e && e.message && (e.kind ? e.kind !== 'local' : e.constructor === Error);
    syncUI.error = known ? e.message : `Action could not be completed (${id}: ${(e && (e.code || e.name)) || 'unknown'}). Check the connection, account permissions and saved entries, then try again.`;
    syncUI.focusNext = $('syncPassword') ? 'syncPassword' : 'syncTitle';
  }
  syncUI.action = null;
  render();
  if ($('syncEnabled')) $('syncEnabled').checked = syncAccount();   // a refused change leaves the switch as it really is
  const el = $(syncUI.focusNext);
  syncUI.focusNext = null;
  if (el) { el.focus(); if (el.id === 'syncPassword') el.select(); }
}
function syncSubmitAuth(form) {
  const mode = form.dataset.form;
  const values = { name: $('syncName')?.value || '', email: $('syncEmail').value, password: $('syncPassword').value };
  if (!syncShowErrors(['syncName', 'syncEmail', 'syncPassword'], syncCheckForm(mode, values))) return;
  if (mode === 'signin') return syncAct('syncSignIn', async () => { await syncTransition(() => window.api.sync.signIn(values.email, values.password)); syncRememberEmail(values.email); syncUI.draftEmail = ''; }, 'syncUser');
  return syncAct('syncSignUp', async () => {
    const r = await window.api.sync.signUp(values.email, values.password, values.name);
    syncUI.notice = `Account created for ${r.email}. Ask the maintainer to add you to the team, then sign in.`;
    syncUI.draftEmail = r.email; syncUI.authMode = 'signin';
  }, 'syncPassword');
}
function syncSubmitConfig() {
  const enabled = $('syncEnabled').checked, serverUrl = $('syncServerUrl').value.trim();
  const problems = enabled && !serverUrl ? { syncServerUrl: 'Enter the server address.' } : {};
  if (Object.keys(problems).length) {
    syncUI.advancedOpen = true; syncApplyLocks();
    syncShowErrors(['syncServerUrl'], problems);
    return;
  }
  syncShowErrors(['syncServerUrl'], null);
  // Off keeps the saved address (not a half-typed one), so it can be turned back on without retyping it.
  const saved = syncUI.status.config || {};
  return syncAct('syncConfig', () => syncTransition(() => window.api.sync.setConfig({ enabled, serverUrl: enabled ? serverUrl : saved.serverUrl || '' })), 'syncTitle');
}
function wireSyncPage() {
  const page = document.querySelector('.sync-page');
  const clicks = {
    syncSignOut: () => syncAct('syncSignOut', () => syncTransition(() => window.api.sync.signOut()), 'syncTitle'),
    syncHistMore: () => syncLoadHistory(true),
    syncNow: () => syncAct('syncNow', async () => { await scheduleFlush(); await window.api.sync.syncNow(); await syncRefresh(); }, 'syncNow'),
    syncImport: () => syncAct('syncImport', syncImport, 'syncImport'),
    syncPutAside: () => syncAct('syncPutAside', async () => {
      if (state.busy) return;
      await scheduleFlush(); state.scheduleRun = null; await syncRelease();
    }, 'syncTitle'),
    syncToCreate: () => syncSwitchForm('create'), syncToSignIn: () => syncSwitchForm('signin'),
  };
  page.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'syncConfigForm') syncSubmitConfig(); else syncSubmitAuth(e.target);
  });
  page.addEventListener('input', (e) => { if (e.target.id) syncFieldError(e.target.id, null); });
  page.addEventListener('change', (e) => { if (e.target.id === 'syncEnabled') syncSubmitConfig(); });
  page.addEventListener('toggle', (e) => { if (e.target.id === 'syncAdvanced') syncUI.advancedOpen = e.target.open; }, true);
  page.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.hasAttribute('data-toggle-password')) {
      const input = $('syncPassword'), show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
      b.setAttribute('aria-pressed', String(show));
    } else if (clicks[b.id]) clicks[b.id]();
    else if (b.dataset.conflict != null) syncResolveConflict(b);
    else if (b.dataset.discard != null) syncReview(b.dataset.discard, 'discard', null, 'Could not discard the draft.');
    else if (b.dataset.retry != null) syncReview(b.dataset.retry, 'retry', syncUI.reviews[+b.dataset.retry].expectedHead, 'The current value changed. Review it again.');
    else if (b.dataset.restore != null) syncRestoreDeleted(b);
  });
}
function syncSwitchForm(mode) {
  syncUI.draftEmail = $('syncEmail')?.value || ''; syncUI.authMode = mode; syncUI.error = ''; syncUI.notice = '';
  syncPaint();
  $(mode === 'create' ? 'syncName' : 'syncEmail')?.focus();
}
async function syncResolveConflict(b) {
  const c = syncUI.conflicts[+b.dataset.conflict];
  if (syncBusy() || (c.kind === 'assignment_delete_stale' && !syncCanDelete())) return;
  try { await window.api.sync.resolve({ conflictId: c.conflictId, choice: b.dataset.choice, expectedHead: c.expectedHead }); await syncRefresh(); await showSync(); }
  catch (_) { toast('Conflict changed or could not be resolved. Review it again.', 'err'); }
}
async function syncReview(index, action, expectedHead, failure) {
  try { await window.api.sync.review({ id: syncUI.reviews[+index].id, action, expectedHead }); await syncRefresh(); await showSync(); }
  catch (_) { toast(failure, 'err'); }
}
async function syncRestoreDeleted(b) {
  if (!syncCanDelete()) return;
  const s = syncUI.deleted[+b.dataset.restore];
  try { const r = await window.api.sync.restoreAssignment({ id: s.id, rev: s.aggregateRev }); if (!r.ok) throw new Error(); await syncRefresh(); }
  catch (_) { toast('Restore needs an admin who is online. Review the schedule again.', 'err'); }
}

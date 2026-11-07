'use strict';

// One displayed revision and one durable commit chain. Status events never advance
// the edit base; only a clean view replacement or our own commit can do that.
const syncUI = {
  operations: 0, status: { mode: 'local' }, rev: null, epoch: 0, dirty: false, saving: 0,
  chain: Promise.resolve(), loading: false, changing: false, preparing: false,
  backupBase: null, prepUndo: null, teamCities: false, enrollmentSecret: '', team: {}, deleted: [], conflicts: [], reviews: [], error: '', waiting: false,
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
  syncUI.epoch++; syncUI.rev = null; syncUI.enrollmentSecret = ''; syncUI.team = {}; syncUI.deleted = [];
  syncUI.conflicts = []; syncUI.reviews = []; syncUI.dirty = false;
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
  if (Array.isArray(state.report?.existing)) out.report = state.report.existing;
  return JSON.parse(JSON.stringify(out));
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
    syncUI.rev = view.rev; syncUI.team = view.data.team || {}; syncUI.deleted = view.data.deleted || [];
    state.schedules = view.data.schedules;
    const settings = syncSettings();
    state.schedules.items.forEach((s) => scheduleHydrate(s, settings));
    state.schedule = state.schedules.items.find((s) => s.id === state.schedules.openId) || null;
    // No team list yet: the built-in one (scheduleCities) is used, and not uploaded.
    syncUI.teamCities = Array.isArray(view.data.cities); state.cities = view.data.cities || null; state.citySource = view.data.citySource;
    state.report = { file: 'Team cache', existing: view.data.report || [], loading: false, filters: {}, columns: {}, limit: 300 };
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
  window.api.sync.onStatus((s) => { syncStatus(s).catch(() => { syncUI.error = 'Could not refresh account data.'; }); });
  document.addEventListener('focusout', () => setTimeout(() => {
    if (syncUI.waiting) syncRefresh().catch(() => {});
  }, 0));
  if (syncAccount()) { syncClear(); await syncRefresh(); }
  return syncAccount();
}
async function syncTransition(action) {
  if (syncBusy() || syncUI.changing) throw new Error('Finish or put aside the backup first.');
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
function syncCanDelete() { return syncAvailable() && syncUI.status.user?.role === 'admin' && syncUI.status.user?.aal === 'aal2' && syncUI.status.phase === 'online' && !syncBusy(); }
async function syncDelete(id) {
  if (!syncCanDelete()) { toast('Deleting schedules requires an online admin with authenticator verification.', 'warn'); return; }
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
      report = SCHEDULE.parseReport((await call('schedule_read_table', { path: settings.reportSource })).rows, cities);
      if (!report.length) throw new Error('The local report source did not contain readable report records.');
    }
    const preview = await window.api.sync.importLocal(false, report);
    if (!preview.ok) throw new Error('Local data contains entries that need correction before import.');
    const details = `${preview.counts.schedules} schedules, ${preview.counts.rows} rows, ${report.length} report records. Originals stay unchanged.\n`
      + (preview.warnings || []).map((w) => w.text).join('\n');
    if (!await window.api.confirm({ message: 'Import this computer’s local data into the team?', detail: details, confirmLabel: 'Import', danger: false })) return;
    const result = await window.api.sync.importLocal(true, report);
    if (!result.ok) throw new Error('Import needs review.');
  } finally { syncUI.changing = false; }
  await syncRefresh();
}
async function showSync() {
  await scheduleFlush();
  state.view = 'account'; syncUI.enrollmentSecret = '';
  syncUI.conflicts = await window.api.sync.conflicts();
  syncUI.reviews = await window.api.sync.reviews();
  render();
}
function renderSyncPage() {
  const s = syncUI.status, enabled = syncAccount();
  const disabled = syncBusy() || syncUI.changing ? 'disabled' : '';
  return `<div class="card sync-panel"><h3>Account and team sync</h3>
    <p>Local mode is the default. Account mode shares all schedules and report records with the team. Machine paths stay on this computer.</p>
    <p>Offline access uses an encrypted cache. Membership revocation cannot be discovered until the server is reached.</p>
    <p>${esc(enabled ? s.locked ? 'Account locked' : s.signedIn ? 'Signed in' : 'Sign in to view team data' : 'Local files')} · ${esc(s.phase || '')}
    ${s.user ? ` · ${esc(s.user.displayName || '')} (${esc(s.user.role || '')})` : ''} · Pending: ${Number(s.pending || 0)} · Held: ${Number(s.held || 0)} · Conflicts: ${Number(s.conflicts || 0)} · Failed: ${Number(s.failed?.length || 0)}</p>
    <p class="note">${esc(syncUI.error || (s.error ? 'Connection or account action failed. Your saved edits remain on this computer.' : ''))}</p>
    <label><input id="syncEnabled" type="checkbox" ${enabled ? 'checked' : ''} ${disabled}> Use team account</label>
    <p><input id="syncUrl" placeholder="https://office.example" value="${esc(s.config?.url || '')}" ${disabled}>
    <input id="syncKey" placeholder="Public anon key" type="password" autocomplete="off" ${disabled}>
    <button id="syncConfig" ${disabled}>Save server settings</button></p>
    ${enabled ? `<p><input id="syncEmail" type="email" autocomplete="off" placeholder="Email" ${disabled}>
    <input id="syncPassword" type="password" autocomplete="off" placeholder="Password" ${disabled}>
    <button id="syncSignIn" ${disabled}>Sign in</button><button id="syncSignOut" ${disabled}>Sign out</button></p>
    <p><button id="syncNow" ${disabled}>Sync now</button><button id="syncImport" ${disabled}>Preview local import…</button></p>
    <p><button id="syncEnroll" ${disabled}>Set up authenticator</button><input id="syncCode" inputmode="numeric" maxlength="6" placeholder="6-digit code">
    <button id="syncVerify" ${disabled}>Verify authenticator</button></p><pre id="syncSecret">${esc(syncUI.enrollmentSecret ? `Authenticator setup secret: ${syncUI.enrollmentSecret}` : '')}</pre>
    ${state.scheduleRun && !state.busy ? '<button id="syncPutAside">Put aside prepared backup</button>' : ''}` : ''}</div>
    ${(syncAvailable() ? syncUI.conflicts : []).map((c, i) => `<div class="card sync-panel"><h3>Conflict: ${esc(c.schedule || c.targetType)}</h3>
      <p>Choose an alternative, then return to the schedule to edit it.</p>
      <pre>${esc(JSON.stringify({ current: c.current, incoming: c.incoming, draft: c.draft }, null, 2))}</pre>
      ${['keep_current', 'accept_incoming', ...(c.draft ? ['mine'] : [])].map((choice) => `<button data-conflict="${i}" data-choice="${choice}" ${disabled || (c.kind === 'assignment_delete_stale' && !syncCanDelete() ? 'disabled' : '')}>${choice === 'keep_current' ? 'Keep current' : choice === 'accept_incoming' ? 'Accept incoming' : 'Keep my draft'}</button>`).join('')}</div>`).join('')}
    ${(syncAvailable() ? syncUI.reviews : []).map((r, i) => `<div class="card sync-panel"><h3>Review saved draft</h3><pre>${esc(JSON.stringify({ current: r.current, draft: r.value }, null, 2))}</pre><button data-discard="${i}" ${disabled}>Discard draft</button><button data-retry="${i}" ${disabled}>Use this draft against the shown current value</button><p>After choosing, return to the schedule to edit.</p></div>`).join('')}
    ${(syncAvailable() ? syncUI.deleted : []).map((s, i) => `<div class="card sync-panel">${esc(s.label)} <button data-restore="${i}" ${syncCanDelete() ? '' : 'disabled'}>Restore schedule</button></div>`).join('')}
    <p class="hint">Deleted schedules are listed only if this device previously saw them. Fresh-device history is unavailable.</p>`;
}
function wireSyncPage() {
  const act = (id, fn) => $(id)?.addEventListener('click', async () => {
    try { syncUI.error = ''; await fn(); }
    catch (_) { syncUI.error = 'Action could not be completed. Check the connection, account permissions and saved entries, then try again.'; }
    render();
  });
  act('syncConfig', () => { const enabled = $('syncEnabled').checked; const c = { enabled, url: enabled ? $('syncUrl').value : '', key: enabled ? $('syncKey').value : '' }; $('syncKey').value = ''; return syncTransition(() => window.api.sync.setConfig(c)); });
  act('syncSignIn', () => { const email = $('syncEmail').value, password = $('syncPassword').value; $('syncPassword').value = ''; return syncTransition(() => window.api.sync.signIn(email, password)); });
  act('syncSignOut', () => syncTransition(() => window.api.sync.signOut()));
  act('syncNow', async () => { await scheduleFlush(); await window.api.sync.syncNow(); await syncRefresh(); });
  act('syncImport', syncImport);
  act('syncPutAside', async () => {
    if (state.busy) return;
    await scheduleFlush(); state.scheduleRun = null; await syncRelease();
  });
  act('syncEnroll', async () => { const e = await window.api.sync.mfaEnroll(); syncUI.enrollmentSecret = e.secret; });
  // Enrollment secret is ephemeral: never stored or inserted as remote markup.
  $('syncEnroll')?.addEventListener('click', (e) => e.stopPropagation());
  act('syncVerify', async () => { const code = $('syncCode').value; $('syncCode').value = ''; await window.api.sync.mfaVerify(code); syncUI.enrollmentSecret = ''; });
  document.querySelectorAll('[data-conflict]').forEach((b) => b.addEventListener('click', async () => {
    const c = syncUI.conflicts[+b.dataset.conflict];
    if (syncBusy() || (c.kind === 'assignment_delete_stale' && !syncCanDelete())) return;
    try { await window.api.sync.resolve({ conflictId: c.conflictId, choice: b.dataset.choice, expectedHead: c.expectedHead }); await syncRefresh(); await showSync(); }
    catch (_) { toast('Conflict changed or could not be resolved. Review it again.', 'err'); }
  }));
  document.querySelectorAll('[data-discard]').forEach((b) => b.addEventListener('click', async () => {
    try { await window.api.sync.review({ id: syncUI.reviews[+b.dataset.discard].id, action: 'discard', expectedHead: null }); await syncRefresh(); await showSync(); }
    catch (_) { toast('Could not discard the draft.', 'err'); }
  }));
  document.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    const r = syncUI.reviews[+b.dataset.retry];
    try { await window.api.sync.review({ id: r.id, action: 'retry', expectedHead: r.expectedHead }); await syncRefresh(); await showSync(); }
    catch (_) { toast('The current value changed. Review it again.', 'err'); }
  }));
  document.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    if (!syncCanDelete()) return;
    const s = syncUI.deleted[+b.dataset.restore];
    try { const r = await window.api.sync.restoreAssignment({ id: s.id, rev: s.aggregateRev }); if (!r.ok) throw new Error(); await syncRefresh(); }
    catch (_) { toast('Restore needs an online admin with authenticator verification. Review the schedule again.', 'err'); }
  }));
}

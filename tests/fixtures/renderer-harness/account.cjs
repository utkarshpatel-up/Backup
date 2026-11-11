'use strict';
// Real Electron, offscreen, mocked APIs. Checks rendered behaviour; PNGs go to --out if given.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nativeTheme } = require('electron');
const pass = (m) => console.log(`PASS ${m}`);
const WIDTHS = [1280, 1040, 720, 560];

module.exports = async ({ open, until, out }) => {
  const js = (w, code) => w.webContents.executeJavaScript(code);
  const tick = () => new Promise((r) => setTimeout(r, 60));
  const shot = async (w, name, width) => {
    if (!out) return;
    fs.mkdirSync(out, { recursive: true });
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(out, `${name}-${width}.png`), (await w.webContents.capturePage()).toPNG());
  };
  const layout = async (w, name) => {
    for (const width of WIDTHS) {
      w.setContentSize(width, 820);
      await tick();
      const m = await js(w, `({ doc: document.documentElement.scrollWidth, win: innerWidth,
        content: document.getElementById('content').scrollWidth - document.getElementById('content').clientWidth,
        clipped: [...document.querySelectorAll('.sync-page input, .sync-page button')].filter(e => e.checkVisibility() && e.getBoundingClientRect().right > document.getElementById('content').getBoundingClientRect().right + 1).map(e => e.id) })`);
      assert.ok(m.doc <= m.win, `${name}@${width}: page scrolls sideways (${m.doc} > ${m.win})`);
      assert.equal(m.content, 0, `${name}@${width}: content scrolls sideways`);
      assert.deepEqual(m.clipped, [], `${name}@${width}: controls cut off`);
      await shot(w, name, width);
    }
    w.setContentSize(1280, 820);
    await tick();
  };
  const go = async (w) => { await js(w, 'showSync()'); await tick(); };
  const page = async (flow, extra = {}) => { const w = await open({ flow, ...extra }); await go(w); return w; };
  const key = async (w, keyCode) => {
    w.webContents.focus();
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    w.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : keyCode });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await tick();
  };

  // ---------------------------------------------------------------- signed out
  let w = await page('signedout');
  await layout(w, 'signed-out');
  let v = await js(w, `({ form: !!document.querySelector('form#syncForm[data-form=signin]'), labelled: [...document.querySelectorAll('.sync-page input:not([type=checkbox])')].every(i => document.querySelector('label[for="'+i.id+'"]')),
    url: document.getElementById('syncServerUrl').checkVisibility(), adv: document.getElementById('syncAdvanced').open })`);
  assert.deepEqual(v, { form: true, labelled: true, url: false, adv: false });
  pass('signed-out page: one labelled sign-in form; server config tucked under Advanced');

  await js(w, `window.__mock.status = { ...window.__mock.status, config: { ...window.__mock.status.config, email: 'me@example.test' } }; window.__fireStatus(structuredClone(window.__mock.status)); showSync();`);
  await until(w, `document.getElementById('syncEmail')?.value === 'me@example.test'`);
  v = await js(w, `({ focus: document.activeElement === document.getElementById('syncPassword'), forget: !!document.getElementById('syncForgetEmail') })`);
  assert.deepEqual(v, { focus: true, forget: true });
  await js(w, `document.getElementById('syncForgetEmail').click()`);
  await until(w, `!document.getElementById('syncForgetEmail')`);
  v = await js(w, `({ email: document.getElementById('syncEmail').value, calls: window.__mock.calls.map(c => c[0]).filter(c => c === 'forgetEmail') })`);
  assert.deepEqual(v, { email: '', calls: ['forgetEmail'] });
  await js(w, `window.__mock.calls.length = 0`);
  pass('remembered e-mail is pre-filled with focus on the password, and Forget e-mail clears it');

  v = await js(w, `(async () => {
    const e = document.getElementById('syncEmail'), p = document.getElementById('syncPassword');
    e.value = 'typed@example.test'; p.value = 'hunter2hunter2'; p.focus(); p.setSelectionRange(3, 3);
    for (let i = 0; i < 50; i++) { window.__fireProgress({ pending: 50 - i, sending: 1 }); window.__fireStatus(structuredClone(window.__mock.status)); render(); await new Promise(r => setTimeout(r, 0)); }
    return { sameNodes: e === document.getElementById('syncEmail') && p === document.getElementById('syncPassword'), email: e.value, pass: p.value, focus: document.activeElement === p, caret: p.selectionStart };
  })()`);
  assert.deepEqual(v, { sameNodes: true, email: 'typed@example.test', pass: 'hunter2hunter2', focus: true, caret: 3 });
  pass('background progress, status and render leave typed values, focus and caret alone');

  v = await js(w, `(() => { const b = document.querySelector('[data-toggle-password]'), p = document.getElementById('syncPassword'); b.click(); const shown = [p.type, b.textContent, b.getAttribute('aria-pressed')]; b.click(); return { shown, hidden: [p.type, b.textContent] }; })()`);
  assert.deepEqual(v, { shown: ['text', 'Hide', 'true'], hidden: ['password', 'Show'] });
  pass('password visibility toggle');

  v = await js(w, `(() => { document.getElementById('syncEmail').value = 'not-an-email'; document.getElementById('syncPassword').value = ''; document.getElementById('syncForm').requestSubmit();
    return { calls: window.__mock.calls.length, email: document.getElementById('syncEmailErr').textContent, invalid: document.getElementById('syncEmail').getAttribute('aria-invalid'), focus: document.activeElement.id, pw: document.getElementById('syncPasswordErr').textContent }; })()`);
  assert.deepEqual(v, { calls: 0, email: 'Enter a valid email address.', invalid: 'true', focus: 'syncEmail', pw: 'Enter your password.' });
  pass('validation names each problem, focuses the first and sends nothing');
  await js(w, `document.getElementById('syncEmail').dispatchEvent(new Event('input', { bubbles: true }))`);
  assert.equal(await js(w, `document.getElementById('syncEmailErr').hidden && !document.getElementById('syncEmail').hasAttribute('aria-invalid')`), true);

  // Wrong password: keyboard submit, loading state, then a named error with the form intact.
  await js(w, `window.__mock.signIn = () => new Promise((_, rej) => { window.__rej = () => rej(Object.assign(new Error('Wrong email or password.'), { kind: 'auth' })); });
    document.getElementById('syncEmail').value = 'typed@example.test'; document.getElementById('syncPassword').value = 'wrong-password'; document.getElementById('syncPassword').focus();`);
  await key(w, 'Return');
  await until(w, 'window.__rej !== undefined');
  v = await js(w, `({ busy: document.getElementById('syncSignIn').getAttribute('aria-busy'), disabled: document.getElementById('syncSignIn').disabled, inputs: document.getElementById('syncEmail').disabled, msg: document.querySelector('[data-region=feedback] [role=status]')?.textContent, calls: window.__mock.calls.at(-1) })`);
  assert.deepEqual(v, { busy: 'true', disabled: true, inputs: true, msg: 'Signing in…', calls: ['signIn', 'typed@example.test'] });
  await shot(w, 'signing-in', 1280);
  pass('Enter submits; loading shows on the button, the fields lock, status is announced');
  await js(w, 'window.__rej()');
  await until(w, `document.querySelector('[data-region=feedback] [role=alert]')`);
  v = await js(w, `({ msg: document.querySelector('[role=alert]').textContent, email: document.getElementById('syncEmail').value, pw: document.getElementById('syncPassword').value, focus: document.activeElement.id, sel: document.activeElement.selectionEnd, on: document.getElementById('syncSignIn').disabled })`);
  assert.deepEqual(v, { msg: 'Wrong email or password.', email: 'typed@example.test', pw: 'wrong-password', focus: 'syncPassword', sel: 14, on: false });
  await shot(w, 'sign-in-error', 1280);
  pass('a refused sign-in names the reason, keeps the form and selects the password');

  // Success: Enter from the password field must still load the team's view.
  const views0 = await js(w, 'window.__mock.views');
  await js(w, `window.__mock.signIn = async () => { window.__mock.status = { ...window.__mock.status, signedIn: true, phase: 'online', user: { displayName: 'Test Operator', role: 'operator' } }; }; document.getElementById('syncPassword').focus();`);
  await key(w, 'Return');
  await until(w, `document.getElementById('syncSignOut')`);
  await until(w, `window.__mock.views > ${views0}`);
  v = await js(w, `({ form: !!document.getElementById('syncForm'), focus: document.activeElement.id, avail: syncAvailable(), commits: window.__mock.commits })`);
  assert.deepEqual(v, { form: false, focus: 'syncUser', avail: true, commits: 0 });
  await layout(w, 'signed-in');
  pass('signing in from the keyboard loads the view and moves focus to the dashboard');
  w.destroy();

  // ------------------------------------------------------------- create account
  w = await page('signedout');
  v = await js(w, `(() => { document.getElementById('syncEmail').value = 'new@example.test'; document.getElementById('syncToCreate').click();
    return { email: document.getElementById('syncEmail').value, focus: document.activeElement.id, form: document.getElementById('syncForm').dataset.form }; })()`);
  assert.deepEqual(v, { email: 'new@example.test', focus: 'syncName', form: 'signup' });
  await layout(w, 'create-account');
  v = await js(w, `(() => { document.getElementById('syncPassword').value = 'short'; document.getElementById('syncForm').requestSubmit();
    return { name: document.getElementById('syncNameErr').textContent, pw: document.getElementById('syncPasswordErr').textContent, calls: window.__mock.calls.length }; })()`);
  assert.deepEqual(v, { name: 'Enter your name.', pw: 'Use at least 8 characters.', calls: 0 });
  await js(w, `document.getElementById('syncName').value = 'New Person'; document.getElementById('syncPassword').value = 'long-enough-pw'; document.getElementById('syncForm').requestSubmit();`);
  await until(w, `document.getElementById('syncForm')?.dataset.form === 'signin'`);
  v = await js(w, `({ note: document.querySelector('[data-region=feedback] .note.ok').textContent, email: document.getElementById('syncEmail').value, pw: document.getElementById('syncPassword').value, focus: document.activeElement.id, call: window.__mock.calls.at(-1) })`);
  assert.deepEqual(v, { note: 'Account created for new@example.test. Ask the maintainer to add you to the team, then sign in.', email: 'new@example.test', pw: '', focus: 'syncPassword', call: ['signUp', 'new@example.test', 'New Person'] });
  await shot(w, 'account-created', 1280);
  pass('create account: validation, then success message and the sign-in form, email carried over');
  w.destroy();

  // ------------------------------------------------------------------ local mode
  w = await page('local');
  await layout(w, 'local');
  v = await js(w, `(() => { document.getElementById('syncEnabled').click(); return { adv: document.getElementById('syncAdvanced').open, err: document.getElementById('syncServerUrlErr').textContent, focus: document.activeElement.id, calls: window.__mock.calls.length }; })()`);
  await tick();
  assert.deepEqual(v, { adv: true, err: 'Enter the server address.', focus: 'syncServerUrl', calls: 0 });
  await js(w, `document.getElementById('syncServerUrl').value = 'http://10.147.20.5:8090'; document.getElementById('syncConfigForm').requestSubmit();`);
  await until(w, `document.getElementById('syncForm')`);
  v = await js(w, `({ call: window.__mock.calls.at(-1), adv: document.getElementById('syncAdvanced').open, on: document.getElementById('syncEnabled').checked })`);
  assert.deepEqual(v, { call: ['setConfig', { enabled: true, serverUrl: 'http://10.147.20.5:8090' }], adv: true, on: true });
  pass('turning the account on asks for a missing address in Advanced, then shows sign-in');
  w.destroy();

  // ------------------------------------------------------ signed-in, data, states
  w = await page('signedin', { report: 2000, past: 2, pastRows: 40, open: 60 });
  v = await js(w, `(async () => {
    const who = document.getElementById('syncUser'); window.__fireProgress({ pending: 7, sending: 1 });
    await new Promise(r => setTimeout(r, 0));
    return { node: who === document.getElementById('syncUser'), tile: document.querySelector('.sync-tile dd').textContent, text: document.querySelector('.sync-upload').textContent.includes('7 changes left') };
  })()`);
  assert.deepEqual(v, { node: true, tile: '7', text: true });
  await js(w, `window.__mock.calls.length = 0; document.getElementById('syncNow').click()`);
  await until(w, `window.__mock.calls.some(c => c[0] === 'syncNow') && !syncUI.action`);
  pass('dashboard: live counts without a redraw; Sync now runs');

  v = await js(w, `(async () => {
    state.view = 'schedule'; render();
    const cell = () => document.querySelector('tr[data-row="770021"] [data-f="place"]');
    const other = document.querySelector('tr[data-row="770031"] [data-f="topic"]');
    other.value = 'still being typed';
    const next = document.querySelector('tr[data-row="770021"] [data-f="topic"]'); next.focus();
    const el = cell(); el.value = 'Edited place'; el.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    const r1 = { saved: state.schedule.sessions[20].place, typedKept: document.querySelector('tr[data-row="770031"] [data-f="topic"]').value, sameOther: other === document.querySelector('tr[data-row="770031"] [data-f="topic"]'), focus: [document.activeElement.dataset.k, document.activeElement.dataset.f] };
    cell().value = 'Second edit'; cell().dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    r1.rewired = state.schedule.sessions[20].place;
    await scheduleFlush(); return r1;
  })()`);
  assert.deepEqual(v, { saved: 'Edited place', typedKept: 'still being typed', sameOther: true, focus: ['770021', 'topic'], rewired: 'Second edit' });
  assert.equal(await js(w, `window.__mock.lastCommit.snapshot.schedules.items.at(-1).sessions[20].place`), 'Second edit');
  pass('schedule edit repaints its row only; other typing and focus survive; the row stays live and saves');

  v = await js(w, `(async () => {
    await showReport(); render();
    const r = reportState(), box = document.querySelector('[data-col="city"]'), wrap = document.querySelector('.rep-scroll');
    wrap.scrollTop = 200; box.focus(); box.value = 'pu'; box.setSelectionRange(1, 1); box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 320));
    const out = { same: box === document.querySelector('[data-col="city"]'), focus: document.activeElement === box, caret: box.selectionStart, count: document.querySelector('.rep-count').textContent.includes(' of ') };
    box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 320));
    document.getElementById('repExport').click();
    out.moreBefore = document.querySelectorAll('.rep-table tbody tr').length;
    document.getElementById('repMore').click(); await new Promise(r => setTimeout(r, 30));
    out.moreAfter = document.querySelectorAll('.rep-table tbody tr').length;
    document.getElementById('repMore').click(); await new Promise(r => setTimeout(r, 30));
    out.moreAfter2 = document.querySelectorAll('.rep-table tbody tr').length;
    r.filters.city = 'zzz-none'; render();
    out.none = document.querySelector('.rep-table tbody').textContent.includes('Nothing matches');
    return out;
  })()`);
  assert.equal(v.same && v.focus && v.count, true, JSON.stringify(v));
  assert.equal(v.caret, 1);
  assert.ok(v.moreAfter > v.moreBefore && v.moreAfter2 > v.moreAfter, JSON.stringify(v));
  assert.equal(v.none, true);
  pass('report filters: the box, focus and caret survive; Show more stays wired after a patch');

  v = await js(w, `(async () => {
    state.report.filters = {}; const before = state.schedules; state.view = 'report'; render(); document.activeElement?.blur?.(); await new Promise(r => setTimeout(r, 450));
    const rev = syncUI.rev, st = await window.api.sync.status(); await syncStatus(st);
    return { sameSchedules: state.schedules === before, revMoved: syncUI.rev !== rev };
  })()`);
  assert.deepEqual(v, { sameSchedules: true, revMoved: true });
  pass('a status event with unchanged data still advances the base revision, without rebuilding');
  w.destroy();

  for (const flow of ['expired', 'locked']) {
    w = await page(flow);
    await layout(w, flow);
    v = await js(w, `({ form: !!document.getElementById('syncForm'), out: !!document.getElementById('syncSignOut') })`);
    assert.deepEqual(v, { form: flow === 'expired', out: true });
    w.destroy();
  }
  pass('expired offers sign-in again; locked offers sign-out only');

  // ---------------------------------------------------------------- sidebar team server
  for (const [flow, want] of [['local', ['Local mode']], ['signedin', ['ZeroTier: Connected', 'PocketBase: Not reachable']]]) {
    w = await open({ flow });
    await tick();
    v = await js(w, `(async () => {
      const lines = [...document.querySelectorAll('#teamLines .team-line')].map(l => l.textContent);
      document.getElementById('btnTeamAccount').click();
      await new Promise(r => setTimeout(r, 60));
      return { lines, live: document.getElementById('teamLines').getAttribute('aria-live'), title: document.getElementById('stepTitle').textContent };
    })()`);
    assert.deepEqual(v, { lines: want, live: 'polite', title: 'Account' });
    w.destroy();
  }
  pass('sidebar team server: text states, and its Account button opens the Account page');

  nativeTheme.themeSource = 'dark';
  w = await page('signedout');
  await shot(w, 'dark-signed-out', 1280);
  w.destroy();
  w = await page('signedin', { report: 200 });
  await shot(w, 'dark-signed-in', 1280);
  nativeTheme.themeSource = 'system';
  w.destroy();
  console.log('AVB_ACCOUNT_UI_COMPLETE');
};

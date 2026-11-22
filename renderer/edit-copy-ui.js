/* ------------------------------------------------ H264 MM Backup (modal) */

// The HyperDeck Studio Mini records the formal master a third time, in H.264,
// for the multimedia team to edit from. It is backed up on its own, at the
// start or the end of the day, never alongside the ProRes/H.265 masters. Its
// files are named exactly like those masters, with the job's folder number in
// front ('3058 Adalaj … E. Dt-17-Oct-26 Dur-44m43s Clip-01.mp4'), and copied
// flat into one output folder. The clips are numbered from this card alone,
// and nothing here feeds a session's Dur- or the report.
//
// The name comes from a structure zip, an event schedule row (right-click),
// or a session folder already filed on an SSD. It runs outside the backup
// steps and never touches their state.

const EDIT_COPY_HINT = 'Named like the H.265/ProRes masters, with the folder number in front.';

/** The folder number at the start of a job folder: '3058 Dt-17 Oct 2026' -> '3058'. */
function editCopyJobNumber(jobName) {
  const m = /^\s*(\d+)\b/.exec(String(jobName || ''));
  return m ? m[1] : '';
}

/** A zip's or a schedule row's session name, shortened the way its masters' folder is. */
function editCopyCleanName(name) {
  const base = stripClipsToken(name);
  return selectionRules.cleanSessionName ? selectionRules.cleanSessionName(base).name : base;
}

async function openEditCopy(preset = {}) {
  const settings = await window.api.getSettings().catch(() => ({}));
  const prev = state.editCopy || {};
  state.editCopy = {
    open: true,
    from: preset.from || prev.from || '',
    fromLabel: preset.fromLabel || prev.fromLabel || '',
    sessions: preset.sessions || prev.sessions || [],
    pick: 0,
    jobNumber: preset.jobNumber ?? prev.jobNumber ?? '',
    sessionName: preset.sessionName ?? prev.sessionName ?? '',
    note: preset.note || '',
    source: prev.source || '',
    dest: prev.dest || settings.editCopyDest || '',
    verify: prev.verify || 'size',
    picked: new Set(),   // ticked clips (by card path); none ticked copies them all
    plan: null, result: null, error: null,
  };
  // An imported structure in this backup: offer its sessions without a second import.
  if (!preset.from && !state.editCopy.from && state.templates && state.templates.length) {
    editCopyUseSessions(state.templates, 'Imported structure', 'zip');
  }
  render();
  if (!state.volumes || !state.volumes.length) {
    try { const v = await call('list_volumes', {}); state.volumes = v.volumes || []; render(); } catch (_) { /* pick by hand */ }
  }
  await editCopyPreview();
}

/** Take the session list of a structure (zip or SSD folder) and use its first session. */
function editCopyUseSessions(sessions, label, from) {
  const e = state.editCopy;
  e.from = from;
  e.fromLabel = label;
  e.sessions = sessions.map((s) => ({ job_name: s.job_name || '', session_name: s.session_name || '' }));
  e.pick = 0;
  editCopyPickSession(0);
}

function editCopyPickSession(index) {
  const e = state.editCopy;
  const s = e.sessions[Number(index)];
  if (!s) return;
  e.pick = Number(index);
  // A filed session folder already wears its final name; a zip's is cleaned as the backup would.
  e.sessionName = e.from === 'folder' ? stripClipsToken(s.session_name) : editCopyCleanName(s.session_name);
  e.jobNumber = editCopyJobNumber(s.job_name) || e.jobNumber;
  e.note = '';
}

async function editCopyImportZip() {
  const zip = await window.api.pickZip();
  if (!zip) return;
  try {
    const info = await call('inspect_zip', { path: zip }, { label: 'Reading zip' });
    const r = await call('extract_zip', { path: zip }, { label: `Extracting ${info.label}` });
    const found = await call('detect_structures', { root: r.path }, { label: `Reading ${info.label}` });
    if (!found.sessions.length) { toast(`No session folder found in ${info.label}.`, 'err'); return; }
    editCopyUseSessions(found.sessions, info.label, 'zip');
    await editCopyPreview();
  } catch (err) { toast(err.message, 'err'); render(); }
}

async function editCopyUseFolder() {
  const folder = await window.api.pickFolder('Choose the session folder (on the SSD) these H.264 files belong to');
  if (!folder) return;
  try {
    const d = await call('detect_structure', { root: folder }, { label: 'Reading session' });
    if (!d.session_path) { toast(d.reason || 'No session folder found there.', 'err'); return; }
    editCopyUseSessions([d], d.session_path, 'folder');
    await editCopyPreview();
  } catch (err) { toast(err.message, 'err'); }
}

async function editCopyChooseSource(path) {
  const chosen = path || await window.api.pickFolder('Choose the HyperDeck Studio Mini SD card, or the folder holding its clips');
  if (!chosen) return;
  state.editCopy.source = chosen;
  await editCopyPreview();
}

async function editCopyChooseDest() {
  const chosen = await window.api.pickFolder('Choose the output folder for the H.264 files (server, HDD or SSD)');
  if (!chosen) return;
  state.editCopy.dest = chosen;
  window.api.setSettings({ editCopyDest: chosen }).catch(() => {});
  await editCopyPreview();
}

/** Rebuild the name preview whenever the name, the card or the output changes. */
async function editCopyPreview() {
  const e = state.editCopy;
  if (!e) return;
  e.plan = null; e.result = null; e.error = null;
  if (!e.source || !e.sessionName.trim()) { render(); return; }
  try {
    // The ticked clips are numbered among themselves: Clip-01, 02 … with no gaps.
    e.plan = await call('edit_copy_plan', {
      source: e.source, dest: e.dest, job_number: e.jobNumber.trim(), session_folder: e.sessionName.trim(),
      picked: [...(e.picked || [])],
    }, { label: 'Reading the H.264 clips' });
    // Keep the ticks on clips still on the card.
    const onCard = new Set(e.plan.items.map((i) => i.src));
    e.picked = new Set([...(e.picked || [])].filter((src) => onCard.has(src)));
  } catch (err) {
    e.error = err.message.replace(/^\w+Error:\s*/, '');
  }
  render();
}

/** The clips this copy takes: the ticked ones, or every clip when none is ticked. */
function editCopyChosen(e) {
  return ((e.plan && e.plan.items) || []).filter((i) => i.status !== 'skip');
}

async function editCopyRun() {
  const e = state.editCopy;
  if (!e || !e.plan) return;
  const chosen = editCopyChosen(e);
  const n = chosen.filter((i) => i.status === 'new').length;
  const ok = await window.api.confirm({
    message: `Copy ${n} H.264 file${n === 1 ? '' : 's'} to the output folder?`,
    detail: `${e.dest}\n\n${chosen.map((i) => i.name).slice(0, 8).join('\n')}`
      + `${chosen.length > 8 ? `\n…and ${chosen.length - 8} more` : ''}\n\nNothing on the SD card is changed. `
      + 'Files already there with the same size are only checked.',
    confirmLabel: 'Start copy', danger: false,
  });
  if (!ok) return;
  try {
    e.result = await call('edit_copy_run', { plan: { ...e.plan, items: chosen }, verify: e.verify },
      { label: 'Copying the H264 MM Backup' });
    const r = e.result;
    if (r.cancelled) toast('H264 MM Backup cancelled. Run it again to finish.', 'warn');
    else if (r.ok) toast(`H264 MM Backup done: ${r.copied} copied, ${r.verified} checked.`, 'ok');
    else toast(`H264 MM Backup finished with ${r.errors.length} problem(s).`, 'warn');
  } catch (err) {
    toast(err.message, 'err');
  }
  render();
}

function closeEditCopy() {
  if (state.busy) return;
  state.editCopy.open = false;
  render();
}

function editCopyItemsHtml(items, picked, busy) {
  const label = { new: '', skip: '<span class="hint">not copied</span>', same: '<span class="badge">already there</span>',
                  conflict: '<span class="badge warn">different file there</span>' };
  const all = items.length && items.every((i) => picked.has(i.src));
  return `<table class="rename-table">
    <tr><td style="width:28px"><input type="checkbox" id="ecPickAll" style="width:auto" ${all ? 'checked' : ''}
      ${busy ? 'disabled' : ''} title="Tick or clear every clip" /></td>
      <td class="hint" colspan="4">${picked.size ? `${picked.size} of ${items.length} ticked — only these are copied`
        : 'None ticked — every clip is copied. Tick clips to copy only those.'}</td></tr>
    ${items.slice(0, 300).map((i) => `<tr>
      <td><input type="checkbox" data-ec-pick="${esc(i.src)}" style="width:auto" ${picked.has(i.src) ? 'checked' : ''}
        ${busy ? 'disabled' : ''} /></td>
      <td class="mono old">${esc(i.original_name)}</td>
      <td class="arrow">→</td>
      <td class="mono new">${esc(i.name)} ${label[i.status] || ''}</td>
      <td class="hint" style="white-space:nowrap">${fmtBytes(i.size)}</td></tr>`).join('')}</table>
    ${items.length > 300 ? `<p class="hint">…and ${items.length - 300} more.</p>` : ''}`;
}

function renderEditCopyModal() {
  const host = $('modal');
  const e = state.editCopy;
  host.classList.add('show');
  const busy = !!state.busy;
  const plan = e.plan;
  const vols = (state.volumes || []).filter((v) => !e.dest || pathKey(v.path) !== pathKey(e.dest));

  const sessionPick = e.sessions.length > 1
    ? `<label class="field"><span>Session</span><select id="ecSession">${e.sessions.map((s, i) =>
        `<option value="${i}" ${i === e.pick ? 'selected' : ''}>${esc(s.session_name)}</option>`).join('')}</select></label>`
    : '';
  const nameCard = `<div class="card">
      <h3>1 · Name</h3>
      <p class="hint">${EDIT_COPY_HINT} Take it from the structure zip, from a session folder already on the
        SSD, or right-click a row on the Event schedule.</p>
      <div class="row" style="margin-bottom:10px">
        <button class="sm ${e.from ? '' : 'primary'}" id="ecZip" ${busy ? 'disabled' : ''}>Import structure zip…</button>
        <button class="sm" id="ecFolder" ${busy ? 'disabled' : ''}>Session folder on SSD…</button>
        ${e.fromLabel ? `<span class="hint mono" style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1"
          title="${esc(e.fromLabel)}">From ${esc(e.fromLabel)}</span>` : ''}
      </div>
      ${sessionPick}
      <div class="grid2" style="grid-template-columns:140px 1fr">
        <label class="field"><span>Folder number</span>
          <input type="text" id="ecJob" value="${esc(e.jobNumber)}" placeholder="3058" inputmode="numeric" /></label>
        <label class="field"><span>Session name (as the master's folder)</span>
          <input type="text" id="ecName" value="${esc(e.sessionName)}" placeholder="Adalaj Soneri Satsang E. Dt-17-Oct-26" /></label>
      </div>
      ${e.note ? `<div class="note warn" style="margin-top:10px">${esc(e.note)}</div>` : ''}
    </div>`;

  const sourceCard = `<div class="card">
      <h3>2 · HyperDeck Studio Mini SD card</h3>
      ${e.source ? `<div class="mono" style="margin-bottom:8px">${esc(e.source)}</div>` : ''}
      <div class="row">
        ${vols.map((v) => `<button class="sm ${e.source && pathKey(e.source) === pathKey(v.path) ? 'primary' : ''}"
          data-ec-vol="${esc(v.path)}" ${busy ? 'disabled' : ''} title="${esc(v.path)}">💾 ${esc(v.label)}</button>`).join('')}
        <button class="sm" id="ecSource" ${busy ? 'disabled' : ''}>Choose folder…</button>
      </div>
    </div>`;

  const destCard = `<div class="card">
      <h3>3 · Output folder</h3>
      <p class="hint">Only the files are written here, with no job or session folders: a server folder, or a single HDD or SSD.</p>
      <div class="row">
        <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${e.dest ? 'var(--text)' : 'var(--muted)'}">
          ${e.dest ? esc(e.dest) : 'Not chosen yet'}</span>
        <button class="sm ${e.dest ? '' : 'primary'}" id="ecDest" ${busy ? 'disabled' : ''}>Choose…</button>
      </div>
      <label class="row" style="gap:8px;margin-top:10px;cursor:pointer">
        <input type="checkbox" id="ecHash" style="width:auto" ${e.verify === 'hash' ? 'checked' : ''} ${busy ? 'disabled' : ''} />
        <span>Check every file by checksum after copying (slower; size is always checked)</span></label>
    </div>`;

  let preview;
  if (e.error) {
    preview = `<div class="note err">${esc(e.error)}</div>`;
  } else if (!plan) {
    preview = `<div class="empty"><div class="big">🎞️</div><div>${!e.sessionName.trim()
      ? 'Choose the name first.' : 'Choose the HyperDeck Studio Mini SD card to see the new names.'}</div></div>`;
  } else {
    const toCopy = editCopyChosen(e).filter((i) => i.status === 'new');
    const toCopyBytes = toCopy.reduce((sum, i) => sum + (Number(i.size) || 0), 0);
    preview = `<div class="note info">${plan.count} clip${plan.count === 1 ? '' : 's'} on the card ·
        ${fmtBytes(plan.total_bytes)} · ${toCopy.length} to copy (${fmtBytes(toCopyBytes)}).
        Clips are numbered from this card; this copy is not counted in the session's duration.</div>
      ${plan.warnings.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}
      ${plan.items.length ? editCopyItemsHtml(plan.items, e.picked, busy) : ''}`;
  }
  let resultHtml = '';
  if (e.result && !e.result.cancelled) {
    const r = e.result;
    resultHtml = `<div class="note ${r.ok ? 'ok' : 'warn'}"><b>${r.ok ? 'Done.' : 'Finished with problems.'}</b>
        ${r.copied} copied · ${r.verified} of ${r.results.length} checked (${r.verify === 'hash' ? 'checksum' : 'size'}).
        ${r.errors.length ? `<ul style="margin:6px 0 0 16px;padding:0">${r.errors.slice(0, 20).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
  }

  const canRun = plan && plan.items.length && e.dest && !busy
    && editCopyChosen(e).some((i) => i.status !== 'conflict');
  const progress = busy ? `<div style="flex:1"><b>${esc(state.busy.label)}</b>
      <div class="bar"><div style="width:${state.busy.percent != null ? state.busy.percent : 15}%"></div></div>
      <div class="progress-meta"><span>${esc(state.busy.left || '')}</span><span>${esc(state.busy.right || '')}</span></div></div>
      <button class="danger sm" id="ecCancel">Cancel</button>` : '<div class="spacer"></div>';

  host.innerHTML = `<div class="modal-backdrop" data-close="1">
    <div class="modal-panel wide" role="dialog" aria-modal="true" aria-labelledby="ecTitle">
      <div class="modal-head">
        <div style="flex:1;min-width:0">
          <h3 style="margin:0" id="ecTitle">H264 MM Backup</h3>
          <div class="path" style="margin-top:4px">${esc(EDIT_COPY_HINT)}</div>
        </div>
        <button class="sm ghost" id="ecClose" ${busy ? 'disabled' : ''}>Close</button>
      </div>
      <div class="modal-body">${nameCard}${sourceCard}${destCard}
        <h4 class="rename-h">New names</h4>${resultHtml}${preview}</div>
      <div class="modal-foot">
        ${progress}
        <button class="primary" id="ecRun" ${canRun ? '' : 'disabled'}>${e.result && !e.result.cancelled ? 'Copy again' : 'Start copy'}</button>
      </div>
    </div>
  </div>`;

  host.querySelector('[data-close]')?.addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) closeEditCopy(); });
  $('ecClose')?.addEventListener('click', closeEditCopy);
  $('ecZip')?.addEventListener('click', editCopyImportZip);
  $('ecFolder')?.addEventListener('click', editCopyUseFolder);
  $('ecSource')?.addEventListener('click', () => editCopyChooseSource());
  $('ecDest')?.addEventListener('click', editCopyChooseDest);
  $('ecRun')?.addEventListener('click', editCopyRun);
  $('ecCancel')?.addEventListener('click', () => { window.api.cancel(state.busy.id); toast('Cancelling after the current file…'); });
  $('ecHash')?.addEventListener('change', (ev) => { e.verify = ev.target.checked ? 'hash' : 'size'; });
  host.querySelectorAll('[data-ec-pick]').forEach((box) => box.addEventListener('change', () => {
    if (box.checked) e.picked.add(box.dataset.ecPick); else e.picked.delete(box.dataset.ecPick);
    editCopyPreview();    // renumber the ticked clips
  }));
  $('ecPickAll')?.addEventListener('change', (ev) => {
    e.picked = ev.target.checked ? new Set(plan.items.map((i) => i.src)) : new Set();
    editCopyPreview();
  });
  host.querySelectorAll('[data-ec-vol]').forEach((b) => b.addEventListener('click', () => editCopyChooseSource(b.dataset.ecVol)));
  $('ecSession')?.addEventListener('change', (ev) => { editCopyPickSession(ev.target.value); editCopyPreview(); });
  const field = (id, key) => {
    const el = $(id);
    if (!el) return;
    const commit = () => { if (e[key] !== el.value) { e[key] = el.value; e.note = ''; editCopyPreview(); } };
    el.addEventListener('change', commit);
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); });
  };
  field('ecJob', 'jobNumber');
  field('ecName', 'sessionName');
  makeFolderDropTarget(host.querySelector('.modal-panel'), (folder) => { if (!busy) editCopyChooseSource(folder); });
}

/** The card under "Only camera clips" on the Formal Sources page. */
function editCopyCardHtml() {
  return `<div class="card">
    <h3>H264 MM Backup</h3>
    <p class="hint">The HyperDeck Studio Mini's H.264 recording of the master, for the multimedia team. Run it on
      its own, at the start or the end of the day: its files get the masters' names with the folder number in front
      (<span class="mono">3058 Soneri Satsang … Dt-17-Oct-26 Clip-01.mp4</span>) and are copied flat into one folder.
      Clips are numbered from the card itself, and this copy never counts toward the session's duration.</p>
    <div class="row">
      <button class="sm primary" id="btnEditCopy">H264 MM Backup…</button>
      <span class="hint" style="margin:0">Also on the Event schedule: right-click a Formal row.</span>
    </div>
  </div>`;
}

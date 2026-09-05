'use strict';

function nameCount(name) {
  const count = Array.from(String(name || '')).length;
  return `<span class="name-count ${count > 150 ? 'over-limit' : ''}">${count} characters${count > 150 ? ' · over 150' : ''}</span>`;
}

function renderNamingEditor() {
  const d = detection() || {};
  const base = state.renameBase || (state.template || {}).session_name || d.session_name || state.session.title;
  const title = state.clipTitle || base || 'Event Name';
  const example = isInformal()
    ? `Cam-01 ${stripClipsToken(title).replace(/\s*\bDur-\S+/ig, '')
      .replace(/\s*\bDt-\d{1,2}-[A-Za-z]+-\d{2,4}/ig, '').replace(/^\d+\s+/, '').trim()} Clip-001.MP4`
    : masterClipName(title, masterTotalSeconds(), 1, 1, '.mov');
  const preview = state.namingPreview;
  return `<div class="card naming-editor">
    <h3>Filename preview and edits</h3>
    <p class="hint">Counts turn red above 150 characters. The full destination path also matters on Windows.
      Shorten the session folder or clip name before copying.</p>
    <label class="field"><span>Clip name base (optional)</span>
      <input id="fClipTitle" type="text" value="${esc(state.clipTitle)}" placeholder="Use session folder name" />
    </label>
    <div class="preview-name">Example filename: ${esc(example)} ${nameCount(example)}</div>
    <p class="hint">The example uses a sample extension and sequence. Load/select your clips, then preview
      their exact names below. Formal camera clips keep their original names unless individually edited.</p>
    <button id="btnPreviewNames" ${state.busy ? 'disabled' : ''}>Preview selected filenames</button>
    ${preview ? preview.targets.map((t) => `<div class="name-preview-target">
      <b>${esc(t.role)} · Session folder</b><div class="preview-name">${esc(t.session_folder)} ${nameCount(t.session_folder)}</div>
      <div class="path">${esc(t.session_path)}</div>
      ${t.items.map((item) => {
        const name = (item.final_dst || item.dst).split(/[\\/]/).pop();
        return `<label class="field"><span>${esc(item.original_name)} → output filename</span>
          <input type="text" data-output-name="${esc(item.src)}" value="${esc(name)}" />
          <span class="path">${esc(item.final_dst || item.dst)}</span></label>`;
      }).join('')}
      ${!t.items.length ? '<p class="hint">No new files selected. Tick camera clips or select a master first.</p>' : ''}
    </div>`).join('') : ''}
  </div>`;
}

function wireNamingEditor() {
  $('fClipTitle')?.addEventListener('change', (e) => {
    state.clipTitle = e.target.value.trim();
    state.plan = null; state.runResult = null; state.namingPreview = null;
    render();
  });
  $('btnPreviewNames')?.addEventListener('click', async () => {
    try {
      const spec = buildSpec();
      const result = await call('build_plan', spec, { label: 'Previewing filenames' });
      state.namingPreview = result;
      render();
    } catch (e) { toast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-output-name]').forEach((field) => {
    field.addEventListener('change', () => {
      state.clipNames[field.dataset.outputName] = field.value.trim();
      state.plan = null; state.runResult = null; state.namingPreview = null;
      render();
      toast('Filename saved. Preview again to check the final name and path.');
    });
  });
  // Live counters never rebuild the input or steal the typing cursor.
  document.querySelectorAll('#fRename, #fStructureJob, #fTitle, #fClipTitle, [data-output-name], [data-camname]').forEach((field) => {
    const count = document.createElement('span');
    field.insertAdjacentElement('afterend', count);
    const update = () => { count.innerHTML = nameCount(field.value); };
    field.addEventListener('input', update);
    update();
  });
}

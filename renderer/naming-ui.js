'use strict';

function nameCount(name, limit = 225) {
  const count = Array.from(String(name || '')).length;
  const over = count > limit;
  return `<span class="name-count ${over ? 'over-limit' : ''}">${count} characters${over ? ` · over ${limit}` : ''}</span>`;
}

// The count that matters most on Windows is the whole destination path, not just
// the file's own name — a long session/job folder can push a short clip past the
// path limit. Show that full-path length wherever we know the path, and alarm
// (red) once it passes 225, well before the 260-character hard limit.
function pathCount(fullPath) {
  return nameCount(fullPath, 225);
}

// Best-effort full destination path for the sample clip name, so the count under
// the example reflects the real path length — folders and all — before a plan is
// previewed. The clip name (event portion) comes from the editable base; the
// folders it lands in are rebuilt from the same pieces the plan uses.
function examplePath(exampleName) {
  const src = primarySource();
  if (!src) return exampleName;
  const sep = (window.api && window.api.platform === 'win32') ? '\\' : '/';
  const d = detection() || {};
  const t = state.template || {};
  const job = state.jobNameOverride != null ? state.jobNameOverride : (t.job_name || d.job_name || '');
  const rawBase = state.renameBase || t.session_name || d.session_name || (state.session || {}).title || '';
  const session = isInformal()
    ? stripClipsToken(rawBase).replace(/\s*\bDur-\S+/ig, '').trim()
    : `${stripClipsToken(rawBase)} Dur-${fmtDurAuto(masterTotalSeconds())}`;
  const dir = [destOf(src), job, session, isInformal() ? 'Cam-01' : '']
    .filter(Boolean).join(sep);
  return dir ? dir + sep + exampleName : exampleName;
}

function renderNamingEditor() {
  const d = detection() || {};
  const base = state.renameBase || (state.template || {}).session_name || d.session_name || state.session.title;
  const title = state.clipTitle || base || 'Event Name';
  const example = isInformal()
    ? `Cam-01 ${stripClipsToken(title).replace(/\s*\bDur-\S+/ig, '')
      .replace(/\s*\bDt-\d{1,2}(?:-\d{1,2}-\d{2,4}|-[A-Za-z]{3,9}-\d{2,4}|\s+[A-Za-z]{3,9}\s+\d{4})\b/ig, '')
      .replace(/^\d+\s+/, '').replace(/\s{2,}/g, ' ').trim()} Clip-001.MP4`
    : masterClipName(title, masterTotalSeconds(), 1, 1, '.mov');
  const preview = state.namingPreview;
  return `<div class="card naming-editor">
    <h3>Filename preview and edits</h3>
    <p class="hint">The count under each name is its full destination path length, which turns red
      past 225 — safely short of the 260-character Windows path limit. Shorten the session folder
      or clip name before copying.</p>
    <label class="field"><span>Clip name base (optional)</span>
      <input id="fClipTitle" type="text" value="${esc(state.clipTitle || base)}" placeholder="Use session folder name" />
    </label>
    <div class="preview-name">Example filename: ${esc(example)}</div>
    ${pathCount(examplePath(example))}
    <p class="hint">The example uses a sample extension and sequence. Load/select your clips, then preview
      their exact names below. Formal camera clips keep their original names unless individually edited.</p>
    <button id="btnPreviewNames" ${state.busy ? 'disabled' : ''}>Preview selected filenames</button>
    ${preview ? preview.targets.map((t) => `<div class="name-preview-target">
      <b>${esc(t.role)} · Session folder</b><div class="preview-name">${esc(t.session_folder)}</div>
      ${pathCount(t.session_path)}
      <div class="path">${esc(t.session_path)}</div>
      ${t.items.map((item) => {
        const full = item.final_dst || item.dst;
        const name = full.split(/[\\/]/).pop();
        const dir = full.slice(0, full.length - name.length);
        return `<label class="field"><span>${esc(item.original_name)} → output filename</span>
          <input type="text" data-output-name="${esc(item.src)}" data-dir="${esc(dir)}" value="${esc(name)}" />
          <span class="path">${esc(full)}</span></label>`;
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
    // Clip-name fields carry the destination directory in data-dir, so their live
    // count reflects the whole path; folder/title fields just count their own text.
    const update = () => {
      count.innerHTML = field.dataset.dir !== undefined
        ? pathCount(field.dataset.dir + field.value)
        : nameCount(field.value);
    };
    field.addEventListener('input', update);
    update();
  });
}

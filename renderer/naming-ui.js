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
// The directory the session folder lands in, rebuilt from the same pieces the
// plan uses, with a trailing separator. A master sits at the session root, so
// this is also the folder its file is written into.
function sessionDirForPreview(src = primarySource()) {
  if (!src) return '';
  const sep = (window.api && window.api.platform === 'win32') ? '\\' : '/';
  const d = detection() || {};
  const t = state.template || {};
  const job = state.jobNameOverride != null ? state.jobNameOverride : (t.job_name || d.job_name || '');
  const rawBase = state.renameBase || t.session_name || d.session_name || (state.session || {}).title || '';
  // The session folder's Dur- token is the total of the masters ON THIS DRIVE,
  // so each drive's preview path reflects its own recording length.
  const timed = mastersFor(src).map((m) => m.duration).filter((x) => x != null);
  const secs = timed.length ? timed.reduce((a, b) => a + b, 0) : masterTotalSeconds();
  const session = isInformal()
    ? stripClipsToken(rawBase).replace(/\s*\bDur-\S+/ig, '').trim()
    : `${stripClipsToken(rawBase)} Dur-${fmtDurAuto(secs)}`;
  const dir = [destOf(src), job, session].filter(Boolean).join(sep);
  return dir ? dir + sep : '';
}

function examplePath(exampleName) {
  const dir = sessionDirForPreview();
  if (!dir) return exampleName;
  const sep = (window.api && window.api.platform === 'win32') ? '\\' : '/';
  // Informal clips land one level deeper, inside a Cam folder.
  return dir + (isInformal() ? `Cam-01${sep}` : '') + exampleName;
}

// Formal jobs carry only a handful of master files, so their rename fields are
// shown inline on the Folder step — no need to press "Preview selected
// filenames" first, which exists mainly to expand the long informal clip list.
function formalMasterEditor() {
  if (isInformal()) return '';
  const base = state.clipTitle || state.renameBase
    || (state.template || {}).session_name || (detection() || {}).session_name
    || state.session.title;
  // Every source drive carries its own master recording — ProRes on one drive,
  // H.265 on another, or several master clips on any of them — so each drive with
  // masters gets its own rename group here, not just the primary drive.
  const drives = footageSources()
    .map((src) => ({ src, masters: mastersFor(src) }))
    .filter((drive) => drive.masters.length);
  if (!drives.length) return '';
  const total = drives.reduce((sum, drive) => sum + drive.masters.length, 0);
  const multiDrive = drives.length > 1;
  const groups = drives.map(({ src, masters }) => {
    const dir = sessionDirForPreview(src);
    const rows = masters.map((m, i) => {
      const value = masterDisplayName(m, i + 1, masters.length, base);
      return `<label class="field"><span>${esc(m.name)} → output filename</span>
        <input type="text" data-output-name="${esc(m.path)}" data-dir="${esc(dir)}" value="${esc(value)}" />
        <span class="path">${esc(dir + value)}</span></label>`;
    }).join('');
    // The drive header is only worth the space once more than one drive has a
    // master to edit; a single drive keeps the plain list it always showed.
    const head = multiDrive
      ? `<div class="name" style="font-weight:600;margin:10px 0 4px">${esc(src.label)}
          <span class="badge ${src.role}">${esc(src.role)}</span></div>`
      : '';
    return `${head}${rows}`;
  }).join('');
  return `<div class="name-preview-target">
    <b>Master filename${total > 1 ? 's' : ''}</b>
    <p class="hint" style="margin:4px 0 10px">Edit any master name right here${
      multiDrive ? ', grouped by the drive it lives on' : ''}. Camera clips keep their original
      names; use <b>Preview selected filenames</b> below only if you want to rename an individual
      camera clip too.</p>
    ${groups}
  </div>`;
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
    ${formalMasterEditor()}
    <p class="hint">The example uses a sample extension and sequence. Load/select your clips, then preview
      their exact names below. Formal camera clips keep their original names unless individually edited.</p>
    <button id="btnPreviewNames" ${state.busy ? 'disabled' : ''}>Preview selected filenames</button>
    ${preview ? preview.targets.map((t) => {
      // Formal masters are already editable inline above, so the preview list
      // only needs the camera clips; informal shows every renamed clip.
      const items = isInformal() ? t.items : t.items.filter((item) => item.kind !== 'master');
      return `<div class="name-preview-target">
      <b>${esc(t.role)} · Session folder</b><div class="preview-name">${esc(t.session_folder)}</div>
      ${pathCount(t.session_path)}
      <div class="path">${esc(t.session_path)}</div>
      ${items.map((item) => {
        const full = item.final_dst || item.dst;
        const name = full.split(/[\\/]/).pop();
        const dir = full.slice(0, full.length - name.length);
        return `<label class="field"><span>${esc(item.original_name)} → output filename</span>
          <input type="text" data-output-name="${esc(item.src)}" data-dir="${esc(dir)}" value="${esc(name)}" />
          <span class="path">${esc(full)}</span></label>`;
      }).join('')}
      ${!items.length ? `<p class="hint">${isInformal()
        ? 'No new files selected. Tick camera clips or select a master first.'
        : 'No camera clips to rename — masters are edited above.'}</p>` : ''}
    </div>`; }).join('') : ''}
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
  document.querySelectorAll('#fRename, #fStructureJob, #fTitle, #fClipTitle, [data-output-name]').forEach((field) => {
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

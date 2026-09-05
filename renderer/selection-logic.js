'use strict';

/* Pure selection rules shared by the renderer and its Node regression tests. */
(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.VIngestSelection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const JUNK_PARTS = new Set([
    '.ds_store', 'thumbs.db', 'desktop.ini', '.spotlight-v100', '.fseventsd',
    '.trashes', '$recycle.bin', 'recycler', 'system volume information',
  ]);

  function pathKey(path, platform = '') {
    const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  function isJunkPath(path) {
    return String(path || '').split(/[\\/]+/).some((part) => {
      const lowered = part.toLowerCase();
      return JUNK_PARTS.has(lowered) || lowered.startsWith('._')
        || lowered.startsWith('.trash-');
    });
  }

  function cameraFiles(files, masterPaths, platform = '') {
    const masters = new Set((masterPaths || []).map((path) => pathKey(path, platform)));
    return (files || []).filter((file) => file && file.manual
      && !isJunkPath(file.path)
      && !masters.has(pathKey(file.path, platform)));
  }

  function cameraFilenamePrefix(file) {
    const path = String((file && (file.name || file.path)) || '');
    const name = path.split(/[\\/]/).pop();
    const match = /^([a-z]+_\d{3,4})(?=c\d)/i.exec(name);
    return match ? match[1].toUpperCase() : '';
  }

  /** Best available camera identity, before recording-format heuristics. */
  function cameraGroupKey(file, platform = '') {
    const prefix = cameraFilenamePrefix(file);
    if (prefix) return `camera:${prefix}`;

    const volume = String((file && file.card_volume) || '');
    if (volume) return `volume:${pathKey(volume, platform)}`;

    const path = String((file && file.path) || '');
    const windowsRoot = /^([a-z]:)[\\/]/i.exec(path);
    if (windowsRoot) return `volume:${windowsRoot[1].toLowerCase()}`;

    const card = String((file && file.card_label) || '').trim().toLowerCase();
    if (card) return `card:${card}`;

    return `format:${file && file.width}x${file && file.height}`
      + `@${file && file.fps}/${file && file.video_codec}`;
  }

  function cameraGroups(files, platform = '') {
    const groups = new Map();
    for (const file of files || []) {
      const key = cameraGroupKey(file, platform);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(file);
    }
    return [...groups.values()]
      .sort((a, b) => b.length - a.length)
      .map((group) => group.sort((x, y) => (x.mtime || 0) - (y.mtime || 0)));
  }

  function filterCameraFiles(files, assignments = {}, options = {}, platform = '') {
    const query = String(options.query || '').trim().toLowerCase();
    const cam = String(options.cam || 'all');
    const identity = String(options.identity || 'all');
    const assignmentFor = (file) => assignments[file.path] == null
      ? 'skip' : String(assignments[file.path]);
    const filtered = (files || []).filter((file) => {
      if (cam !== 'all' && assignmentFor(file) !== cam) return false;
      if (identity !== 'all' && cameraGroupKey(file, platform) !== identity) return false;
      if (!query) return true;
      return [file.name, file.path, file.card_label, file.card_volume,
        cameraFilenamePrefix(file), cameraGroupKey(file, platform)]
        .some((value) => String(value || '').toLowerCase().includes(query));
    });

    const byTime = (a, b) => (Number(a.mtime) || 0) - (Number(b.mtime) || 0)
      || String(a.name || a.path).localeCompare(String(b.name || b.path));
    const sort = options.sort || 'camera-time';
    return filtered.slice().sort((a, b) => {
      if (sort === 'name') {
        return String(a.name || a.path).localeCompare(String(b.name || b.path));
      }
      if (sort === 'size') return (Number(b.size) || 0) - (Number(a.size) || 0) || byTime(a, b);
      if (sort === 'time') return byTime(a, b);
      return cameraGroupKey(a, platform).localeCompare(cameraGroupKey(b, platform))
        || byTime(a, b);
    });
  }

  function camsForAssignments(assignments, files, mapPath = (path) => path,
                              platform = '') {
    const live = new Set((files || []).map((file) => pathKey(file.path, platform)));
    const cams = {};
    for (const [path, value] of Object.entries(assignments || {})) {
      if (typeof value !== 'number' || !live.has(pathKey(path, platform))) continue;
      const mapped = mapPath(path);
      if (!mapped) continue;
      (cams[value] = cams[value] || []).push(mapped);
    }
    return cams;
  }

  function removeCardImports(files, assignments, selection, platform = '') {
    const stale = (files || []).filter((file) => file.origin === 'camera-card');
    const staleKeys = new Set(stale.map((file) => pathKey(file.path, platform)));
    return {
      files: (files || []).filter((file) => file.origin !== 'camera-card'),
      assignments: Object.fromEntries(Object.entries(assignments || {}).filter(
        ([path]) => !staleKeys.has(pathKey(path, platform)))),
      selection: (selection || []).filter((path) => !staleKeys.has(pathKey(path, platform))),
      removedCount: stale.length,
    };
  }

  function importedCamCount(template, minimum = 3) {
    const numbers = Object.keys((template && template.cams) || {})
      .map(Number).filter(Number.isFinite);
    for (const entry of (template && template.tree) || []) {
      const match = /(?:^|\/)Cam-(\d+)(?:\/|$)/i.exec(entry);
      if (match) numbers.push(Number(match[1]));
    }
    return Math.max(minimum, 0, ...numbers);
  }

  function informalSetupReady(template, outputDirectory) {
    return Boolean(template && String(outputDirectory || '').trim());
  }

  /** Build the camera skeleton for the selected workflow. */
  function normalizedTemplateDirs(template, camCount, directCameraFolders = false) {
    const imported = ((template && template.tree) || []).map((entry) => {
      const clean = String(entry || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (directCameraFolders) {
        if (clean.toLowerCase() === 'clips for insert') return '';
        return clean.replace(/^Clips for Insert\//i, '');
      }
      return /^Cam-\d+(?:\/|$)/i.test(clean) ? `Clips for Insert/${clean}` : clean;
    }).filter(Boolean);
    const dirs = [...new Set(imported)];
    if (!directCameraFolders
        && !dirs.some((entry) => entry.toLowerCase() === 'clips for insert')) {
      dirs.unshift('Clips for Insert');
    }
    const kept = dirs.filter((entry) => {
      const match = /(?:^|\/)Cam-(\d+)(?:\/|$)/i.exec(entry);
      return !match || Number(match[1]) <= camCount;
    });
    const present = new Set(kept.map((entry) => {
      const match = /(?:^|\/)Cam-(\d+)$/i.exec(entry);
      return match ? Number(match[1]) : null;
    }).filter((number) => number != null));
    for (let number = 1; number <= camCount; number += 1) {
      if (!present.has(number)) {
        const camera = `Cam-${String(number).padStart(2, '0')}`;
        kept.push(directCameraFolders ? camera : `Clips for Insert/${camera}`);
      }
    }
    return kept;
  }

  /** A footage-drive scan must not replace the layout supplied by a ZIP template. */
  function cameraCountAfterDetection(template, currentCount, detected, minimum = 3) {
    if (template) return currentCount;
    const numbers = Object.keys((detected && detected.cams) || {})
      .map(Number).filter(Number.isFinite);
    return Math.max(minimum, 0, ...numbers);
  }

  function occupiedCamNumbers(plan, camNames = {}) {
    const named = new Map(Object.entries(camNames).map(([number, name]) =>
      [String(name || '').trim().toLowerCase(), Number(number)]));
    const occupied = new Set();
    for (const target of (plan && plan.targets) || []) {
      for (const [folder, count] of Object.entries(target.existing_cams || {})) {
        if (!(Number(count) > 0)) continue;
        const clean = String(folder || '').trim();
        const match = /^Cam-(\d+)$/i.exec(clean);
        const number = match ? Number(match[1]) : named.get(clean.toLowerCase());
        if (Number.isFinite(number)) occupied.add(number);
      }
    }
    return [...occupied].sort((a, b) => a - b);
  }

  function lowestAvailableCams(count, occupied = []) {
    const filled = new Set((occupied || []).map(Number).filter(Number.isFinite));
    const available = [];
    let number = 1;
    while (available.length < count) {
      if (!filled.has(number)) available.push(number);
      number += 1;
    }
    return available;
  }

  function emptyCamNumbers(defined, target, camNames = {}) {
    const filled = new Set(occupiedCamNumbers({ targets: [target] }, camNames));
    for (const item of (target && target.items) || []) {
      if (item.kind === 'clip' && Number.isFinite(Number(item.cam))) {
        filled.add(Number(item.cam));
      }
    }
    return (defined || []).map(Number).filter((number) => !filled.has(number));
  }

  function unexpectedPlanClips(plan, assignments, files, platform = '') {
    const live = new Set((files || []).map((file) => pathKey(file.path, platform)));
    const allowed = new Map();
    for (const [path, cam] of Object.entries(assignments || {})) {
      if (typeof cam === 'number' && live.has(pathKey(path, platform))) {
        allowed.set(pathKey(path, platform), cam);
      }
    }
    const unexpected = [];
    for (const target of (plan && plan.targets) || []) {
      for (const item of target.items || []) {
        if (item.kind !== 'clip') continue;
        const expectedCam = allowed.get(pathKey(item.src, platform));
        if (expectedCam === undefined || Number(item.cam) !== expectedCam) {
          unexpected.push({ role: target.role, src: item.src, cam: item.cam, expectedCam });
        }
      }
    }
    return unexpected;
  }

  return { pathKey, isJunkPath, cameraFiles, cameraFilenamePrefix, cameraGroupKey,
           cameraGroups, filterCameraFiles, camsForAssignments, removeCardImports,
           importedCamCount, informalSetupReady, normalizedTemplateDirs,
           cameraCountAfterDetection, occupiedCamNumbers,
           lowestAvailableCams, emptyCamNumbers, unexpectedPlanClips };
});

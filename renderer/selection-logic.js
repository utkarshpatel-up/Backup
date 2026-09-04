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

  return { pathKey, isJunkPath, cameraFiles, camsForAssignments, removeCardImports,
           unexpectedPlanClips };
});

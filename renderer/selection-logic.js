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

  /**
   * Best available camera identity.
   *
   * A camera is a physical source: one SD card / drive is one camera. The clip's
   * own filename prefix is deliberately NOT used — Canon bodies reuse reel ids
   * like "A_0003" across unrelated cards and even mix several within one card, so
   * grouping by it split one card across cams and merged different cards. The
   * source volume the clip came off is the reliable signal; recording format is
   * only a last resort when nothing identifies the source.
   */
  function cameraGroupKey(file, platform = '') {
    const volume = String((file && file.card_volume) || '');
    if (volume) return `volume:${pathKey(volume, platform)}`;

    const path = String((file && file.path) || '');
    const windowsRoot = /^([a-z]:)[\\/]/i.exec(path);
    if (windowsRoot) return `volume:${windowsRoot[1].toLowerCase()}`;
    const posixMount = /^(\/Volumes\/[^/]+|\/media\/[^/]+\/[^/]+|\/mnt\/[^/]+)/i.exec(path);
    if (posixMount) return `volume:${pathKey(posixMount[1], platform)}`;

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
    // Formal camera folders live in "Clips for Insert". Create it when the zip
    // has it or a camera folder needs it, never as an empty folder of its own.
    if (!directCameraFolders
        && !kept.some((entry) => entry.toLowerCase() === 'clips for insert')
        && kept.some((entry) => /^clips for insert\//i.test(entry))) {
      kept.unshift('Clips for Insert');
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
        // Match "Cam-05" and suffixed names like "Cam-05 (Audio)" / "Cam-08 (MM Drone)".
        const match = /^Cam-(\d+)\b/i.exec(clean);
        const number = match ? Number(match[1]) : named.get(clean.toLowerCase());
        if (Number.isFinite(number)) occupied.add(number);
      }
    }
    return [...occupied].sort((a, b) => a - b);
  }

  // Existing on-disk clip count per camera number, read from a plan's
  // existing_cams report (folder name -> clips already filed). Both SSD backups
  // report the same folder, so keep the largest count per camera rather than
  // summing the identical copies across targets.
  function existingCamCounts(plan, camNames = {}) {
    const named = new Map(Object.entries(camNames).map(([number, name]) =>
      [String(name || '').trim().toLowerCase(), Number(number)]));
    const counts = {};
    for (const target of (plan && plan.targets) || []) {
      for (const [folder, count] of Object.entries(target.existing_cams || {})) {
        const n = Number(count);
        if (!Number.isFinite(n) || n <= 0) continue;
        const clean = String(folder || '').trim();
        // Match "Cam-05" and suffixed names like "Cam-05 (Audio)".
        const match = /^Cam-(\d+)\b/i.exec(clean);
        const number = match ? Number(match[1]) : named.get(clean.toLowerCase());
        if (!Number.isFinite(number)) continue;
        counts[number] = Math.max(counts[number] || 0, n);
      }
    }
    return counts;
  }

  // The short clips (under maxSeconds) that bookend a Formal session are usually
  // Pujyashree's entry and exit recordings. Ordered by shoot time — falling back
  // to modified time, then name — the earliest is the entry and the latest the
  // exit. With a single short clip the two are the same file (the operator picks
  // which label to apply); with none, both are null.
  function entryExitCeremonyClips(files, maxSeconds) {
    const shorts = (files || [])
      .filter((f) => typeof f.duration === 'number' && f.duration < maxSeconds)
      .slice()
      .sort((a, b) => String(a.shoot_iso || '').localeCompare(String(b.shoot_iso || ''))
        || (a.mtime || 0) - (b.mtime || 0)
        || String(a.name || '').localeCompare(String(b.name || '')));
    if (!shorts.length) return { entry: null, exit: null };
    return { entry: shorts[0], exit: shorts[shorts.length - 1] };
  }

  // Structure zips sometimes repeat a word ("Sydney Garba Garba and …") and
  // carry a long topic after "Satsang on Topic" that won't fit the naming
  // limits. Both are dropped by default; `keepRepeat` / `keepTopic` put them back.
  // The topic runs to the session tag (E., M., E2., M1.), the Dt- token, or the
  // end, and is dropped only when longer than `topicLimit` characters.
  function cleanSessionName(name, { keepRepeat = false, keepTopic = false } = {},
                            topicLimit = 20) {
    const original = String(name || '');
    let out = original;

    const repeatRe = /(?<![\p{L}\p{N}])([\p{L}\p{N}]+)((?:\s+\1)+)(?![\p{L}\p{N}])/giu;
    const repeats = [...original.matchAll(repeatRe)].map((m) => m[1]);
    if (repeats.length && !keepRepeat) out = out.replace(repeatRe, '$1');

    const topicRe = /(\bSatsang on Topic)\s+(.+?)(?=\s+[ME]\d*\.?(?=\s|$)|\s+Dt-|\s*$)/i;
    const found = topicRe.exec(out);
    const topic = found && found[2].trim().length > topicLimit ? found[2].trim() : null;
    if (topic && !keepTopic) out = out.replace(topicRe, '$1');

    out = out.replace(/\s{2,}/g, ' ').trim();
    return { name: out, repeat: repeats.length ? repeats : null, topic };
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

  // Session completeness (#23). Expected = the Cam-NN folders the structure
  // defines (a zip's tree, or a schedule row's, which already carries its
  // camPlan folders); expected day = the session date. Received = cameras with
  // at least one clip queued to copy, or already filed on disk. Root (0) is not
  // a camera. No camera folders in the structure -> null (no check).
  function sessionCompleteness(template, files, assignments, sessionDate = null,
                               onDisk = {}) {
    const numbers = new Set(Object.keys((template && template.cams) || {})
      .map(Number).filter((n) => n > 0));
    for (const entry of (template && template.tree) || []) {
      const match = /(?:^|\/)Cam-(\d+)(?:\/|$)/i.exec(String(entry).replace(/\\/g, '/'));
      if (match && Number(match[1]) > 0) numbers.add(Number(match[1]));
    }
    if (!numbers.size) return null;
    const clips = {};
    const otherDay = {};
    for (const file of files || []) {
      const cam = (assignments || {})[file.path];
      if (typeof cam !== 'number' || cam <= 0) continue;
      clips[cam] = (clips[cam] || 0) + 1;
      if (sessionDate && file.shoot_date && file.shoot_date !== sessionDate) {
        otherDay[cam] = (otherDay[cam] || 0) + 1;
      }
    }
    for (const [cam, count] of Object.entries(onDisk || {})) {
      if (Number(count) > 0 && !clips[cam]) clips[cam] = 0;
    }
    const expected = [...numbers].sort((a, b) => a - b);
    const received = Object.keys(clips).map(Number).sort((a, b) => a - b);
    return { expected, received, clips, otherDay,
             missing: expected.filter((n) => !(n in clips)),
             extra: received.filter((n) => !numbers.has(n)) };
  }

  return { pathKey, isJunkPath, cameraFiles, cameraFilenamePrefix, cameraGroupKey,
           cameraGroups, filterCameraFiles, camsForAssignments, removeCardImports,
           importedCamCount, informalSetupReady, normalizedTemplateDirs,
           cameraCountAfterDetection, occupiedCamNumbers, existingCamCounts,
           entryExitCeremonyClips, cleanSessionName,
           lowestAvailableCams, emptyCamNumbers, unexpectedPlanClips,
           sessionCompleteness };
});

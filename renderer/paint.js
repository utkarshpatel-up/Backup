'use strict';

/* Repaint only the parts of a page whose HTML changed, so a background redraw leaves
 * unchanged inputs (and what is typed in them), focus, scroll and open menus alone.
 * The page's regions are { name: html string, or an array of one html string per child }. */
(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.VIngestPaint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function childChanges(a, b, forced) {
    const changed = [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i] || forced.includes(i)) changed.push(i);
    if (b.length > a.length && !changed.length) return { append: b.slice(a.length) };
    if (a.length !== b.length || changed.length * 2 > b.length) return { all: b.join('') };
    return changed.length ? { rows: changed.map((i) => [i, b[i]]) } : null;
  }

  /** The changes from one paint to the next, or null when only a full paint will do. */
  function plan(last, next, structural = [], forced = []) {
    const names = Object.keys(next);
    if (names.length !== Object.keys(last).length || names.some((k) => !(k in last))) return null;
    const changes = [];
    for (const name of names) {
      const a = last[name], b = next[name];
      if (Array.isArray(a) !== Array.isArray(b)) return null;
      if (Array.isArray(b)) {
        const c = childChanges(a, b, forced);
        if (c) changes.push({ name, ...c });
      } else if (a !== b) {
        if (structural.includes(name)) return null;
        changes.push({ name, html: b });
      }
    }
    return changes;
  }

  /** Apply one change to its [data-region] element; returns the elements now new. */
  function apply(el, change) {
    if (change.append) {
      const before = el.children.length;
      el.insertAdjacentHTML('beforeend', change.append.join(''));
      return [...el.children].slice(before);
    }
    if (change.rows) {
      return change.rows.map(([i, html]) => { el.children[i].outerHTML = html; return el.children[i]; });
    }
    el.innerHTML = change.all ?? change.html;
    return [el];
  }

  /**
   * Paint `regions` into `host`. `key` identifies what is shown: a different key, a page
   * another renderer has replaced, or a changed `structural` region means a full paint:
   * `full()` html, then `wire()`. Otherwise only changed regions are touched and `rewire`
   * gets the new elements. `forced` lists row indexes to repaint even if their HTML is
   * the same (the DOM may hold something the HTML does not, as a just-typed value).
   */
  function paint(host, key, regions, { full, wire, rewire, structural, forced }) {
    const last = host.painted;
    const same = last && last.key === key && last.root && last.root === host.firstElementChild;
    const changes = same ? plan(last.regions, regions, structural, forced) : null;
    if (!changes) {
      host.innerHTML = full();
      host.painted = { key, regions, root: host.firstElementChild };
      wire();
      return 'full';
    }
    const fresh = [];
    for (const change of changes) {
      const el = host.querySelector(`[data-region="${change.name}"]`);
      if (el) fresh.push(...apply(el, change));
    }
    last.regions = regions;
    if (fresh.length && rewire) rewire(fresh);
    return fresh.length ? 'patch' : 'none';
  }

  /** Set an element's HTML unless it is already that; true when it changed. */
  function setHtml(el, html) {
    if (el.lastHtml === html) return false;
    el.innerHTML = html;
    el.lastHtml = html;
    return true;
  }

  return { plan, paint, setHtml };
});

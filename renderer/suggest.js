/* ------------------------------------------- suggestion list for text boxes */

// The event schedule's Topic, Place and City boxes, and the Report's, suggest
// from thousands of known values (7,000+ topics, plus every one in the report).
// The browser's own <datalist> popup is not made for that many: it was slow to
// open, hard to pick from, and on Windows could hang and keep the keyboard and
// mouse until the app was restarted. This draws its own short list instead:
// the best matches for what is typed, at most SUGGEST_LIMIT of them.
//
// A box opts in with data-suggest="<list id>"; the list's values come from
// suggestSetList (setDatalist calls it). One set of listeners on the document
// serves every box, so a grid that redraws its rows needs no re-wiring.
// ↑/↓ move, Enter or a click picks, Esc closes. Picking sets the box's value
// and sends it 'input', 'change' and 'suggest-pick'.

const SUGGEST_LIMIT = 50;
const SUGGEST = { lists: new Map(), lower: new Map(), box: null, input: null, items: [], at: -1 };

/** Set the values a list offers: strings, or [value, label] pairs. Most used first. */
function suggestSetList(id, options) {
  SUGGEST.lists.set(id, options || []);
  SUGGEST.lower.delete(id);
}

/** The list's values matching `query`, best first: starts with it, then a word starts with it, then anywhere. */
function suggestMatches(id, query, limit = SUGGEST_LIMIT) {
  const opts = SUGGEST.lists.get(id) || [];
  let lower = SUGGEST.lower.get(id);
  if (!lower) {
    lower = opts.map((o) => (Array.isArray(o) ? `${o[0]} ${o[1] || ''}` : String(o)).toLowerCase());
    SUGGEST.lower.set(id, lower);
  }
  const q = String(query || '').trim().toLowerCase();
  if (!q) return opts.slice(0, limit);
  const words = q.split(/\s+/);
  const hits = [];
  for (let i = 0; i < opts.length; i += 1) {
    const t = lower[i];
    if (!words.every((w) => t.includes(w))) continue;
    hits.push([t.startsWith(q) ? 0 : (` ${t}`).includes(` ${words[0]}`) ? 1 : 2, i]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return hits.slice(0, limit).map(([, i]) => opts[i]);
}

const suggestValue = (o) => (Array.isArray(o) ? o[0] : String(o));

function suggestClose() {
  if (SUGGEST.box) SUGGEST.box.hidden = true;
  SUGGEST.input = null; SUGGEST.items = []; SUGGEST.at = -1;
}

function suggestPaint() {
  const { box, input, items, at } = SUGGEST;
  if (!box || !input) return;
  if (!items.length || !input.isConnected) { box.hidden = true; return; }
  box.innerHTML = items.map((o, i) => `<div class="suggest-item ${i === at ? 'on' : ''}" data-i="${i}" role="option"
      aria-selected="${i === at}">${esc(suggestValue(o))}${Array.isArray(o) && o[1] ? ` <span>${esc(o[1])}</span>` : ''}</div>`).join('');
  const r = input.getBoundingClientRect();
  const width = Math.min(Math.max(r.width, 300), 560);
  box.style.width = `${width}px`;
  box.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - width - 4))}px`;
  box.hidden = false;
  // Below the box when it fits, else above it.
  const h = box.offsetHeight;
  box.style.top = `${r.bottom + 2 + h > window.innerHeight && r.top - h - 2 > 0 ? r.top - h - 2 : r.bottom + 2}px`;
  box.querySelector('.suggest-item.on')?.scrollIntoView({ block: 'nearest' });
}

function suggestOpen(input) {
  if (!SUGGEST.box) {
    SUGGEST.box = Object.assign(document.createElement('div'), { className: 'suggest-box', hidden: true });
    SUGGEST.box.setAttribute('role', 'listbox');
    // Keep the focus in the text box while a value is clicked.
    SUGGEST.box.addEventListener('mousedown', (e) => e.preventDefault());
    SUGGEST.box.addEventListener('click', (e) => {
      const item = e.target.closest('.suggest-item');
      if (item) suggestPick(Number(item.dataset.i));
    });
    document.body.appendChild(SUGGEST.box);
  }
  SUGGEST.input = input;
  SUGGEST.items = suggestMatches(input.dataset.suggest, input.value);
  // The box's own value, when it is a listed one, is not worth offering back.
  if (SUGGEST.items.length === 1 && suggestValue(SUGGEST.items[0]) === input.value) SUGGEST.items = [];
  SUGGEST.at = -1;
  suggestPaint();
}

function suggestPick(i) {
  const input = SUGGEST.input;
  const o = SUGGEST.items[i];
  suggestClose();
  if (!input || o == null) return;
  input.value = suggestValue(o);
  for (const type of ['input', 'change', 'suggest-pick']) input.dispatchEvent(new Event(type, { bubbles: true }));
}

if (typeof document !== 'undefined') {
  const boxOf = (t) => (t && t.matches && t.matches('input[data-suggest]') ? t : null);
  document.addEventListener('focusin', (e) => { const el = boxOf(e.target); if (el) suggestOpen(el); });
  document.addEventListener('mousedown', (e) => {
    const el = boxOf(e.target);
    if (el && document.activeElement === el && SUGGEST.input !== el) suggestOpen(el);
  });
  document.addEventListener('input', (e) => { const el = boxOf(e.target); if (el && e.isTrusted) suggestOpen(el); });
  document.addEventListener('focusout', (e) => { if (boxOf(e.target) && SUGGEST.input === e.target) suggestClose(); });
  // First, before the boxes' own keys: with the list open, ↑/↓/Enter/Esc are the list's.
  document.addEventListener('keydown', (e) => {
    if (!SUGGEST.input || e.target !== SUGGEST.input || !SUGGEST.items.length || SUGGEST.box.hidden) return;
    const n = SUGGEST.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      SUGGEST.at = e.key === 'ArrowDown' ? (SUGGEST.at + 1) % n : (SUGGEST.at <= 0 ? n - 1 : SUGGEST.at - 1);
      suggestPaint();
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      suggestClose();
    } else if (e.key === 'Enter' && SUGGEST.at >= 0) {
      // Picked: the box's own Enter (save, close) then runs with the picked value.
      suggestPick(SUGGEST.at);
    } else if (e.key === 'Tab') suggestClose();
  }, true);
  window.addEventListener('blur', suggestClose);
  window.addEventListener('resize', suggestClose);
  document.addEventListener('scroll', (e) => { if (SUGGEST.box && !SUGGEST.box.contains(e.target)) suggestClose(); }, true);
}

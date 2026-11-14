'use strict';
// Reads an event schedule picture (the WhatsApp poster, a phone photo, a PDF page)
// on this computer: Tesseract, offline and free, in English and Gujarati. (Adding Hindi
// made the Gujarati worse: "દર્શન" read as "દાન".)
//
// Reading the whole picture in one go loses rows: Tesseract drops cells on the
// shaded bands and jumbles the order of the three columns. So the table is cut up
// first — its ruled lines are found in the pixels — and every cell is read on its
// own. What comes back is rows of cell texts, in the order they appear, which the
// schedule parser (renderer/schedule-logic.js) turns into sessions. A picture
// with no ruled table falls back to a plain line-by-line read.
const fs = require('fs');
const path = require('path');

const LANGS = ['eng', 'guj'];
// Darker than this counts as ink. The pastel row shading (light blue, peach,
// yellow, pink) is lighter; the thin grey cell borders are darker.
const INK = 190;
// Darker than this is black: a ruled line or lettering, never a coloured fill.
// Between the two is a dark fill (navy, maroon) with light lettering on it.
const BLACK = 25;
// A ruled line is thin; a run of ink rows taller than this is a filled band.
const MAX_LINE = 8;

/**
 * The table's cells, as rows. `img` is {width, height, data, order} where data
 * holds 4 bytes per pixel in 'rgba' or 'bgra' order. Each row is an array of
 * {x0, y0, x1, y1} boxes left to right; a cell that spans several rows (a merged
 * place or title) is the same object in each of them. [] when no table is found.
 */
function findCells(img) {
  const { width: W, height: H } = img;
  const lum = luminance(img);
  const ink = new Uint8Array(W * H);
  const fill = new Uint8Array(W * H);   // dark fill: ink, but not black
  for (let i = 0; i < W * H; i++) {
    ink[i] = lum[i] < INK ? 1 : 0;
    fill[i] = lum[i] < INK && lum[i] >= BLACK ? 1 : 0;
  }

  // Line ink: every black pixel (borders, the black line between two navy
  // cells, the column dividers a line runs through), but a coloured pixel (a
  // grey border, a navy fill) only where its ink run down the pixel column is
  // no thicker than a border — the inside of a navy cell is a fill, not a line.
  const maxLine = Math.max(MAX_LINE, Math.round(W / 250));
  const line = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) line[i] = ink[i] && !fill[i] ? 1 : 0;
  for (let x = 0; x < W; x++) {
    let from = -1;
    for (let y = 0; y <= H; y++) {
      const isInk = y < H && ink[y * W + x];
      if (isInk && from < 0) from = y;
      if (!isInk && from >= 0) {
        if (y - from <= maxLine) for (let k = from; k < y; k++) line[k * W + x] = 1;
        from = -1;
      }
    }
  }
  const lineInk = (i) => line[i] === 1;

  // Ruled lines: rows of pixels holding an unbroken run of line ink at least
  // 12% of the width. A border that only crosses some columns (under a merged
  // cell) keeps just those segments. Lettering never makes runs that long.
  const minRun = W * 0.12;
  const lines = [];
  for (let y = 0; y < H; y++) {
    const segs = [];
    let start = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && lineInk(y * W + x);
      if (on && start < 0) start = x;
      if (!on && start >= 0) { if (x - start >= minRun) segs.push([start, x]); start = -1; }
    }
    if (!segs.length) continue;
    const last = lines[lines.length - 1];
    if (last && y - last.y1 <= 2) { last.y1 = y; last.segs.push(...segs); }   // a thick border
    else lines.push({ y0: y, y1: y, segs });
  }
  // A dark title band ("17 – 25 November 2026" in white on navy) is a run of
  // full-width ink rows: keep its top and bottom edges as lines, so the band
  // between them is read as a filled cell rather than lost as one fat border.
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.y1 - l.y0 <= maxLine) continue;
    lines.splice(i, 1, { y0: l.y0, y1: l.y0, segs: l.segs }, { y0: l.y1, y1: l.y1, segs: l.segs });
  }
  const crosses = (line, x0, x1) => {
    const m0 = x0 + (x1 - x0) * 0.3, m1 = x1 - (x1 - x0) * 0.3;
    return line.segs.some(([a, b]) => a <= m0 && b >= m1);
  };
  // Over a dark fill every row is ink, so a line only ends a filled cell where
  // it is black across the cell's middle; navy under a row line is the same cell.
  const splitsFill = (line, x0, x1) => {
    const m0 = Math.round(x0 + (x1 - x0) * 0.3), m1 = Math.round(x1 - (x1 - x0) * 0.3);
    for (let y = Math.max(0, line.y0 - 1); y <= Math.min(H - 1, line.y1 + 1); y++) {
      let black = 0;
      for (let x = m0; x <= m1; x++) black += lum[y * W + x] < BLACK ? 1 : 0;
      if (black >= (m1 - m0 + 1) * 0.5) return true;
    }
    return false;
  };

  // Between each pair of lines, the column dividers are the pixel columns that
  // are ink for (nearly) the band's full height.
  const bands = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const top = lines[i].y1 + 1, bot = lines[i + 1].y0 - 1, h = bot - top + 1;
    if (h < 12) continue;
    // Dark fills: columns mostly filled (not black) for the band's height. The
    // light lettering on them breaks a column here and there, so short gaps join.
    const fills = [];
    const solid = new Uint8Array(W);
    for (let x = 0; x < W; x++) {
      let n = 0, f = 0;
      for (let y = top; y <= bot; y++) { n += ink[y * W + x]; f += fill[y * W + x]; }
      solid[x] = n >= h * 0.9 ? 1 : 0;
      if (f < h * 0.6) continue;
      const d = fills[fills.length - 1];
      if (d && x - d[1] <= 6) d[1] = x; else fills.push([x, x]);
    }
    const darkRuns = fills.filter(([a, b]) => b - a > W * 0.04);
    const inDark = (x) => darkRuns.some(([a, b]) => x >= a - 2 && x <= b + 2);
    // Column dividers: the remaining pixel columns that are ink for (nearly)
    // the band's full height.
    const breaks = darkRuns.map(([a, b]) => [a, b, true]);
    for (let x = 0; x < W; x++) {
      if (!solid[x] || inDark(x)) continue;
      const d = breaks[breaks.length - 1];
      if (d && !d[2] && x - d[1] <= 2) d[1] = x; else breaks.push([x, x, false]);
    }
    breaks.sort((p, q) => p[0] - q[0]);
    const cells = [];
    let prev = 0;
    for (const [a, b, dark] of [...breaks, [W - 1, W - 1, false]]) {
      const x0 = prev + 1, x1 = a - 1;
      if (x1 - x0 > W * 0.04) cells.push({ x0, y0: top, x1, y1: bot });
      if (dark) cells.push({ x0: a, y0: top, x1: b, y1: bot, dark: true });
      prev = b;
    }
    if (cells.length) bands.push({ below: lines[i + 1], cells });
  }

  // A cell continues into the band below when the line between them does not
  // cross it: "21 - 25 Oct" and "28 Oct - 1 Nov" share one "Bhadran" cell. A
  // filled cell continues unless a black line divides it (the navy "19 Nov"
  // cell beside four time rows).
  const owner = new Map();
  for (let i = 0; i < bands.length; i++) {
    for (const cell of bands[i].cells) {
      if (owner.has(cell)) continue;
      let cur = cell;
      const ends = (line) => (cell.dark ? splitsFill(line, cur.x0, cur.x1) : crosses(line, cur.x0, cur.x1));
      for (let j = i; j + 1 < bands.length && !ends(bands[j].below); j++) {
        const next = bands[j + 1].cells.find((d) => !!d.dark === !!cell.dark
          && Math.abs(d.x0 - cur.x0) < 12 && Math.abs(d.x1 - cur.x1) < 12);
        if (!next) break;
        owner.set(next, cell);
        cell.y1 = next.y1;
        cur = next;
      }
    }
  }
  const rows = bands.map((b) => b.cells.map((c) => owner.get(c) || c));
  // A poster with no ruling at all, or only its outer frame, is not a table.
  return rows.some((r) => r.length >= 2) ? rows : [];
}

/** Brightness 0-255 of every pixel of `img` ({width, height, data, order}). */
function luminance(img) {
  const { width: W, height: H, data } = img;
  const bgr = img.order === 'bgra';
  const lum = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4 + (bgr ? 2 : 0)], g = data[i * 4 + 1], b = data[i * 4 + (bgr ? 0 : 2)];
    lum[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return lum;
}

/**
 * Whether a filled cell's background is dark (navy, maroon: light lettering, to
 * be turned over before reading) rather than a mid grey with dark lettering.
 */
function darkBackground(lum, W, box) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = box.top; y < box.top + box.height; y += 2) {
    for (let x = box.left; x < box.left + box.width; x += 2) { hist[lum[y * W + x]]++; n++; }
  }
  let seen = 0;
  for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen >= n / 2) return v < 110; }
  return false;
}

/**
 * One filled cell cut out as a greyscale BMP with its shades turned over, so its
 * light lettering on navy reads as dark lettering on white. `box` is the cell
 * inside its padding: {left, top, width, height}.
 */
function invertedCell(lum, W, box) {
  const { left, top, width: w, height: h } = box;
  const stride = (w + 3) & ~3;
  const size = 54 + 1024 + stride * h;
  const out = Buffer.alloc(size);
  out.write('BM', 0);
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(54 + 1024, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(8, 28);
  out.writeUInt32LE(stride * h, 34);
  out.writeUInt32LE(256, 46);
  for (let g = 0; g < 256; g++) out.writeUInt32LE(g * 0x010101, 54 + g * 4);
  for (let y = 0; y < h; y++) {
    const row = 54 + 1024 + (h - 1 - y) * stride;   // BMP rows run bottom-up
    for (let x = 0; x < w; x++) out[row + x] = 255 - lum[(top + y) * W + left + x];
  }
  return out;
}

/** Tesseract's line noise: blank runs and lines with no letters or digits. */
function clean(text) {
  return String(text || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.replace(/[^\p{L}\p{N}]/gu, '').length >= 2).join('\n');
}

class ScheduleOcr {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'ocr');
    this.worker = null;
    this.idleTimer = null;
  }

  // The language files ship inside the app; Tesseract wants them in one plain folder.
  _langFiles() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const l of LANGS) {
      const dest = path.join(this.dir, `${l}.traineddata.gz`);
      if (fs.existsSync(dest)) continue;
      const pkg = path.dirname(require.resolve(`@tesseract.js-data/${l}/package.json`));
      fs.writeFileSync(dest, fs.readFileSync(path.join(pkg, '4.0.0_best_int', `${l}.traineddata.gz`)));
    }
  }

  async _worker() {
    if (this.worker) return this.worker;
    this._langFiles();
    const { createWorker } = require('tesseract.js');
    this.worker = createWorker(LANGS.join('+'), 1,
      { langPath: this.dir, cachePath: this.dir, gzip: true, logger: () => {} });
    try { return await this.worker; } catch (e) { this.worker = null; throw e; }
  }

  /**
   * Rows of cell texts from one picture. `encoded` is the PNG/JPEG bytes and
   * `bitmap` its decoded pixels ({width, height, data, order}). Returns
   * {rows: [[text, ...], ...], table: bool}.
   */
  async read(encoded, bitmap) {
    clearTimeout(this.idleTimer);
    const w = await this._worker();
    try {
      const grid = findCells(bitmap);
      if (!grid.length) {
        // No ruled table: read it as lines; the parser finds dates and times inside each.
        await w.setParameters({ tessedit_pageseg_mode: '4' });
        const { data } = await w.recognize(encoded);
        return { table: false, rows: clean(data.text).split('\n').filter(Boolean).map((l) => [l]) };
      }
      // Each cell is one block of text.
      await w.setParameters({ tessedit_pageseg_mode: '6' });
      const texts = new Map();
      const rows = [];
      let lum = null;
      for (const row of grid) {
        const out = [];
        for (const c of row) {
          if (!texts.has(c)) {
            const pad = 4;
            const rectangle = { left: c.x0 + pad, top: c.y0 + pad,
              width: Math.max(1, c.x1 - c.x0 - 2 * pad), height: Math.max(1, c.y1 - c.y0 - 2 * pad) };
            let data;
            lum = lum || (c.dark ? luminance(bitmap) : null);
            if (c.dark && darkBackground(lum, bitmap.width, rectangle)) {
              ({ data } = await w.recognize(invertedCell(lum, bitmap.width, rectangle)));
            } else {
              ({ data } = await w.recognize(encoded, { rectangle }));
            }
            texts.set(c, clean(data.text));
          }
          out.push(texts.get(c));
        }
        if (out.some(Boolean)) rows.push(out);
      }
      return { table: true, rows };
    } finally {
      // Free the memory (about 100 MB) when no pictures have come for a while.
      this.idleTimer = setTimeout(() => this.close(), 5 * 60000);
    }
  }

  async close() {
    clearTimeout(this.idleTimer);
    const w = this.worker;
    this.worker = null;
    if (w) await (await w).terminate().catch(() => {});
  }
}

module.exports = { ScheduleOcr, findCells, clean };

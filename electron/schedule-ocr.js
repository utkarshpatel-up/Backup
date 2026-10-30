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

/**
 * The table's cells, as rows. `img` is {width, height, data, order} where data
 * holds 4 bytes per pixel in 'rgba' or 'bgra' order. Each row is an array of
 * {x0, y0, x1, y1} boxes left to right; a cell that spans several rows (a merged
 * place or title) is the same object in each of them. [] when no table is found.
 */
function findCells(img) {
  const { width: W, height: H, data } = img;
  const bgr = img.order === 'bgra';
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4 + (bgr ? 2 : 0)], g = data[i * 4 + 1], b = data[i * 4 + (bgr ? 0 : 2)];
    ink[i] = 0.299 * r + 0.587 * g + 0.114 * b < INK ? 1 : 0;
  }

  // Ruled lines: rows of pixels holding an unbroken ink run of at least 12% of
  // the width. A border that only crosses some columns (under a merged cell)
  // keeps just those segments. Lettering never makes runs that long.
  const minRun = W * 0.12;
  const lines = [];
  for (let y = 0; y < H; y++) {
    const segs = [];
    let start = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && ink[y * W + x];
      if (on && start < 0) start = x;
      if (!on && start >= 0) { if (x - start >= minRun) segs.push([start, x]); start = -1; }
    }
    if (!segs.length) continue;
    const last = lines[lines.length - 1];
    if (last && y - last.y1 <= 2) { last.y1 = y; last.segs.push(...segs); }   // a thick border
    else lines.push({ y0: y, y1: y, segs });
  }
  const crosses = (line, x0, x1) => {
    const m0 = x0 + (x1 - x0) * 0.3, m1 = x1 - (x1 - x0) * 0.3;
    return line.segs.some(([a, b]) => a <= m0 && b >= m1);
  };

  // Between each pair of lines, the column dividers are the pixel columns that
  // are ink for (nearly) the band's full height.
  const bands = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const top = lines[i].y1 + 1, bot = lines[i + 1].y0 - 1, h = bot - top + 1;
    if (h < 12) continue;
    const dividers = [];
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let y = top; y <= bot; y++) n += ink[y * W + x];
      if (n < h * 0.9) continue;
      const d = dividers[dividers.length - 1];
      if (d && x - d[1] <= 2) d[1] = x; else dividers.push([x, x]);
    }
    const edges = [0, ...dividers.flat(), W - 1];
    const cells = [];
    for (let k = 0; k + 1 < edges.length; k += 2) {
      const x0 = edges[k] + 1, x1 = edges[k + 1] - 1;
      if (x1 - x0 > W * 0.04) cells.push({ x0, y0: top, x1, y1: bot });
    }
    if (cells.length) bands.push({ below: lines[i + 1], cells });
  }

  // A cell continues into the band below when the line between them does not
  // cross it: "21 - 25 Oct" and "28 Oct - 1 Nov" share one "Bhadran" cell.
  const owner = new Map();
  for (let i = 0; i < bands.length; i++) {
    for (const cell of bands[i].cells) {
      if (owner.has(cell)) continue;
      let cur = cell;
      for (let j = i; j + 1 < bands.length && !crosses(bands[j].below, cur.x0, cur.x1); j++) {
        const next = bands[j + 1].cells.find((d) =>
          Math.abs(d.x0 - cur.x0) < 12 && Math.abs(d.x1 - cur.x1) < 12);
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
      for (const row of grid) {
        const out = [];
        for (const c of row) {
          if (!texts.has(c)) {
            const pad = 4;
            const rectangle = { left: c.x0 + pad, top: c.y0 + pad,
              width: Math.max(1, c.x1 - c.x0 - 2 * pad), height: Math.max(1, c.y1 - c.y0 - 2 * pad) };
            const { data } = await w.recognize(encoded, { rectangle });
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

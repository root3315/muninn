/**
 * fieldstore.js — the ready-made fields: what each visit of a preset field
 * is made from, kept beside the page so the field draws without the archive.
 *
 * Opening a field reads, for every visit, a header, a strip of detector rows
 * and the same rows of FLAGS out of a 70 MB file, a few round trips each over
 * the box's home line. For the presets that work is done ahead of time by
 * tools/bake-fields.mjs and kept here as the detector pixels themselves, not
 * as a picture: the rows and columns the field's widest grid samples, with
 * the pipeline's flagged pixels already blanked, plus the two FLAGS bits the
 * stamp still carries (OVERFLOW and GHOST). The page puts them on its grid
 * with the same code a live read goes through (stamp.js resampleSource), so
 * every mode and every measurement sees what it would have seen live.
 *
 * One file per visit:
 *   the pixels    rows × cols half-precision floats, (value − offset) / scale
 *   (padding to four bytes)
 *   the flags     a count, then that many pixel indices (uint32), then as
 *                 many codes (uint8: 1 OVERFLOW, 2 GHOST)
 * all little-endian. Its manifest entry carries the rest: where the pixels
 * sit on the detector, the header cards the WCS and the visit's facts come
 * from, the blanked pixels per row, and the WCS-WAVE table.
 *
 * Why half precision about an offset: a pixel is kept to 11 significant bits
 * of its distance from the visit's median sky, so near the sky the step is
 * under a thousandth of the noise, and a bright star's pixel is off by at most
 * one part in two thousand. The bake measures what that does to marks
 * (tools/bake-fields.mjs, tests/fieldstore.test.mjs).
 */

import { WCS, TangentGrid } from './wcs.js';
import { loadStamp, resampleSource, sourceBounds } from './stamp.js';

export const FIELD_FORMAT = 1;

/** The FLAGS bits a stamp reads (stamp.js OVERFLOW_BIT and GHOST_BIT), and their codes here. */
const KEPT_BITS = [[1, 1 << 1], [2, 1 << 22]];

/**
 * Detector pixels kept on every side past what the widest grid samples, so
 * a link that rounds the centre, or a screen a little different in shape,
 * still finds every pixel inside what was kept.
 */
export const KEEP_MARGIN = 3;

/** The header cards a stamp, its WCS and the visit's facts are made from: nothing else is kept. */
export const KEPT_CARD = /^(NAXIS\d*|BITPIX|BZERO|BSCALE|PCOUNT|GCOUNT|EXTNAME|CRPIX\d|CRVAL\d|CDELT\d|CD\d_\d|PC\d_\d|CTYPE\d|CUNIT\d|LONPOLE|LATPOLE|RADESYS|EQUINOX|(A|B|AP|BP)_(ORDER|\d+_\d+)|OBSID|DATE-OBS|MJD-OBS|DETECTOR|BUNIT|EXPTIME|EFFEXPTM)$/;

/*
 * The widest grid the page draws for a field (app.js fieldGrid at its widest
 * room, as tools/warm-frames.mjs mirrors it): any narrower screen's grid lies
 * inside it, and so inside what is kept.
 */
const DETECTOR_ARCSEC = 6.15;
const SAMPLES_PER_PIXEL = 2.5;
const GRID_MIN_W = 360;
const GRID_MAX_W = 1024;
const MAX_ASPECT = 2;

export function widestGrid(ra, dec, fov) {
  const h = Math.min(768, GRID_MAX_W, Math.max(GRID_MIN_W, Math.round(((fov * 3600) / DETECTOR_ARCSEC) * SAMPLES_PER_PIXEL)));
  const w = Math.min(GRID_MAX_W, Math.round(h * MAX_ASPECT));
  return new TangentGrid(ra, dec, (fov * w) / h, w, h);
}

/* ------------------------------------------------------------ half floats */

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** A float to IEEE half precision, rounded to nearest even; NaN stays NaN. */
export function toHalf(value) {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    const half = 1 << (shift - 1);
    let h = mant >>> shift;
    const rest = mant & ((1 << shift) - 1);
    if (rest > half || (rest === half && (h & 1))) h += 1;
    return sign | h;
  }
  let h = (e << 10) | (mant >>> 13);
  const rest = mant & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (h & 1))) h += 1;
  return sign | h;
}

let halfTable = null;

/** Every half-precision value as a float, built once. */
function halves() {
  if (halfTable) return halfTable;
  halfTable = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >>> 10) & 0x1f;
    const mant = h & 0x3ff;
    halfTable[h] = exp === 0 ? sign * mant * 2 ** -24
      : exp === 0x1f ? (mant ? NaN : sign * Infinity)
        : sign * (1 + mant / 1024) * 2 ** (exp - 15);
  }
  return halfTable;
}

/* ------------------------------------------------------------- the bake */

/**
 * The part of a live read (stamp.js readSource) a field keeps: the rows it
 * read, cut to the columns the grid's samples can reach plus the margin.
 */
export function cropSource(src, grid, margin = KEEP_MARGIN) {
  const box = sourceBounds(src.wcs, grid);
  const colFrom = Math.max(0, Math.floor(box.x0) - 2 - margin);
  const colTo = Math.min(src.nx - 1, Math.ceil(box.x1) + margin);
  const cols = colTo - colFrom + 1;
  const plane = new Float32Array(cols * src.rows);
  const flags = src.flags ? new Int32Array(cols * src.rows) : null;
  for (let r = 0; r < src.rows; r++) {
    const from = r * src.cols + (colFrom - src.colFrom);
    plane.set(src.plane.subarray(from, from + cols), r * cols);
    if (flags) flags.set(src.flags.subarray(from, from + cols), r * cols);
  }
  return { ...src, plane, flags, colFrom, cols };
}

/** The middle finite value: the offset the pixels are kept about. */
function median(values) {
  const finite = Float32Array.from(values.filter((v) => v === v)).sort();
  return finite.length ? finite[finite.length >> 1] : 0;
}

/**
 * A cropped source as one visit's file, and the numbers its manifest entry
 * needs to read it back.
 */
export function encodeVisit(crop) {
  const n = crop.rows * crop.cols;
  const offset = Math.fround(median(crop.plane));
  let reach = 0;
  for (let k = 0; k < n; k++) {
    const d = Math.abs(crop.plane[k] - offset);
    if (d === d && d > reach) reach = d;
  }
  // A power of two, so dividing by it loses nothing; 1 unless a pixel lies
  // further from the sky than half precision reaches.
  let scale = 1;
  while (reach / scale > 60000) scale *= 2;
  const marked = [];
  if (crop.flags) {
    for (let k = 0; k < n; k++) {
      let code = 0;
      for (const [c, bit] of KEPT_BITS) if (crop.flags[k] & bit) code |= c;
      if (code) marked.push([k, code]);
    }
  }
  const pixelBytes = n * 2;
  const flagsAt = (pixelBytes + 3) & ~3;
  const bytes = new Uint8Array(flagsAt + 4 + marked.length * 5);
  const view = new DataView(bytes.buffer);
  for (let k = 0; k < n; k++) view.setUint16(k * 2, toHalf((crop.plane[k] - offset) / scale), true);
  view.setUint32(flagsAt, marked.length, true);
  marked.forEach(([k, code], i) => {
    view.setUint32(flagsAt + 4 + i * 4, k, true);
    bytes[flagsAt + 4 + marked.length * 4 + i] = code;
  });
  return { bytes, offset, scale };
}

/* --------------------------------------------------------- the page's side */

/** A manifest entry's cards, as the Map the FITS reader gives. */
export const cardsOf = (entry) => new Map(entry.cards);

/**
 * A visit's file read back into what resampleSource takes: the same pixels
 * (within half precision), the same flags, where they sit on the detector.
 */
export function decodeVisit(entry, buffer) {
  const n = entry.rows * entry.cols;
  const view = new DataView(buffer);
  const table = halves();
  const plane = new Float32Array(n);
  const { offset, scale } = entry;
  for (let k = 0; k < n; k++) plane[k] = table[view.getUint16(k * 2, true)] * scale + offset;
  let flags = null;
  if (entry.flags) {
    flags = new Int32Array(n);
    const flagsAt = (n * 2 + 3) & ~3;
    const count = view.getUint32(flagsAt, true);
    const codes = new Uint8Array(buffer, flagsAt + 4 + count * 4, count);
    for (let i = 0; i < count; i++) {
      const k = view.getUint32(flagsAt + 4 + i * 4, true);
      for (const [c, bit] of KEPT_BITS) if (codes[i] & c) flags[k] |= bit;
    }
  }
  const cards = cardsOf(entry);
  return {
    cards, wcs: new WCS(cards), nx: entry.nx, ny: entry.ny,
    plane, flags, rowFrom: entry.rowFrom, rows: entry.rows, colFrom: entry.colFrom, cols: entry.cols,
    maskedPerRow: entry.maskedPerRow ?? null,
    // What this visit cost to bring: its own file, not the archive's bytes.
    bytesRead: buffer.byteLength,
  };
}

/**
 * A ready-made field's visit on the grid, marked `baked`; read from the
 * archive as any visit is when the grid reaches past what was kept (another
 * size of field) or the kept file did not come.
 */
export async function bakedOrLive(entry, url, grid, { signal, onHeader } = {}) {
  onHeader?.();
  try {
    const stamp = await bakedStamp(entry, grid, { signal });
    return stamp && Object.assign(stamp, { baked: true });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return loadStamp(url, grid, { signal });
  }
}

/**
 * One visit of a ready-made field on a grid, or null where the bake found
 * the frame off the field. Throws `uncovered` when the grid reaches past
 * what was kept (another size of field): the caller then reads the archive.
 */
export async function bakedStamp(entry, grid, { signal, minCoverage = 0.15 } = {}) {
  if (entry.none) return null;
  const res = await fetch(entry.href, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${entry.href}`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength !== entry.bytes) throw new Error(`cut short: ${buffer.byteLength} of ${entry.bytes} bytes on ${entry.href}`);
  return resampleSource(decodeVisit(entry, buffer), grid, { minCoverage });
}

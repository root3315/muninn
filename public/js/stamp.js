/**
 * stamp.js — pull one epoch's worth of sky out of a 70 MB file and put it on a
 * grid that every other epoch shares.
 *
 * The trick that makes this viable in a browser: SPHEREx Level-2 files live in the
 * public `nasa-irsa-spherex` S3 bucket, which answers HTTP Range requests with
 * `Access-Control-Allow-Origin: *`. So we read the header (64 KB), work out which
 * detector rows the target actually falls on, and fetch only those (~1 MB). The
 * other 69 MB — the PSF cube, the variance plane, the zodiacal model — stays on
 * the server.
 *
 * Each epoch arrives at a different roll angle, so the raw pixels never line up.
 * We resample onto a shared north-up tangent grid; only then does blinking mean
 * anything.
 */

import { scanHDUs, decodePixels, readHeader, dataLength, padded } from './fits.js';
import { WCS } from './wcs.js';
import { skySigma } from './depth.js';
import { deadline, FRAME_DEADLINE_MS } from './net.js';
import { parseWaveTable, wavelengthAt } from './spectrum.js';
import { riceDecode } from './rice.js';

/**
 * The first read of a file. SPHEREx's IMAGE data start at 25,920 or 28,800
 * bytes, so 36 KB holds both headers with room; a file that needs more is
 * read again at twice the size.
 */
const HEADER_PROBE = 36864;
const MAX_HEADER = 1 << 20;

async function fetchRange(url, start, end, signal) {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal: deadline(signal, FRAME_DEADLINE_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}`);
  if (res.status === 206) return res.arrayBuffer();
  // A server that ignores Range answers 200 with the whole file. From byte 0
  // those are still the right bytes, only more of them; from anywhere else
  // they would be decoded as the wrong detector rows, without an error.
  if (start === 0) return (await res.arrayBuffer()).slice(0, end + 1);
  throw new Error(`Range not honoured (HTTP ${res.status}) on ${url}`);
}

/**
 * A file read more than once in a session — its wavelength, then its pixels;
 * or the same field's spectrum for a second mark — has its header and its
 * wavelength table kept, so the second read costs nothing. A failed or
 * cancelled read is forgotten, so it can be asked again.
 */
const KEPT_FILES = 256;

function remembered(cache, key, read) {
  if (cache.has(key)) return cache.get(key);
  const promise = read();
  cache.set(key, promise);
  promise.catch(() => { if (cache.get(key) === promise) cache.delete(key); });
  while (cache.size > KEPT_FILES) cache.delete(cache.keys().next().value);
  return promise;
}

const headers = new Map();
const waveTables = new Map();

/** The IMAGE extension's header, read once per file. */
const readImageHDU = (url, signal) => remembered(headers, url, () => scanImageHDU(url, signal));

/** Read enough of the file to describe HDU 0 and the IMAGE extension. */
async function scanImageHDU(url, signal) {
  let want = HEADER_PROBE;
  for (;;) {
    const buf = await fetchRange(url, 0, want - 1, signal);
    const hdus = scanHDUs(buf, { limit: 3 });
    const img = hdus.find((h) => h.name === 'IMAGE' && h.cards.get('NAXIS') === 2);
    if (img) return img;
    if (want >= MAX_HEADER) throw new Error('No IMAGE extension in the first megabyte');
    want *= 2;
  }
}

/**
 * The pipeline's own verdict on a pixel, from the FLAGS extension that follows
 * the image. These bits mean the pixel did not see the sky in this exposure:
 * a cosmic-ray jump caught up the ramp (TRANSIENT), an onboard processing
 * error, a dead, hot or cold pixel, lost data, or charge persisting from an
 * earlier bright source. Bit numbers are the MP_* keys of the FLAGS header
 * in Quick Release files and the MSKN* keys from DR1 on; they did not change.
 *
 * Deliberately not masked: OVERFLOW (the cores of bright stars), OUTLIER (set
 * on real sources too) and SOURCE (a known source, i.e. the sky itself); nor
 * DR1's GHOST, CROSSTALK and HALO planes, which cover real sky around bright
 * stars and would cut holes in it.
 *
 * Without this the "flash" that opened the Atala field on 6 Jul 2025 was one
 * pixel at eleven times its neighbours: FLAGS 0x80005 in QR2 (TRANSIENT,
 * SUR_ERROR, OUTLIER) and 0x45 in DR1 (TRANSIENT, SUR_ERROR, NONFUNC). Every
 * one of Hunter X's standouts there was a flagged pixel as well.
 */
const MASK_BITS = {
  TRANSIENT: 0, SUR_ERROR: 2, NONFUNC: 6, MISSING_DATA: 9, HOT: 10, COLD: 11, PERSIST: 17,
  // DR1 adds artefact planes. A satellite streak and a "snowball" (a burst
  // of charge from a particle shower) are each a one-visit bright patch:
  // exactly what a mover hunt would otherwise report.
  STREAK: 25, SNOWBALL: 27,
};
const FLAG_MASK = Object.values(MASK_BITS).reduce((m, bit) => m | (1 << bit), 0);

/**
 * OVERFLOW is left in the picture but not forgotten: a pixel whose ramp ran
 * past the detector's well holds no brightness and no position worth
 * quoting. The measurement is told through a per-sample quality plane, cut
 * on the same grid as the pixels and taken from the nearest detector pixel
 * (a flag is a statement about one pixel; averaging it means nothing).
 */
const OVERFLOW_BIT = 1;
export const QUALITY = { OVERFLOW: 1, HOLE: 2 };
const FLAGS_HEADER_PROBE = 5 * 2880 * 4;
/**
 * A compressed FLAGS plane's row pointers, 8 bytes for each of the
 * detector's 2040 rows, read with its header: the header ends where they
 * begin, so one read in place of two, and a round trip off every frame.
 */
const FLAGS_POINTER_BYTES = 2048 * 8;

/**
 * Read the FLAGS plane for the same detector rows as the image.
 * Returns the raw rows and the bytes they cost, or null when the file has no
 * FLAGS extension right after the image (then nothing is masked and nothing
 * is claimed). It touches no pixels, so it runs beside the image read rather
 * than after it: two of a frame's four round trips at the same time.
 */
async function readFlags(url, img, rowFrom, rowTo, nx, signal) {
  const at = img.dataStart + padded(img.dataBytes ?? dataLength(img.cards));
  let head = await fetchRange(url, at, at + FLAGS_HEADER_PROBE + FLAGS_POINTER_BYTES - 1, signal);
  let hdr = readHeader(head, 0);
  if (!hdr) {
    head = await fetchRange(url, at, at + 4 * FLAGS_HEADER_PROBE - 1, signal);
    hdr = readHeader(head, 0);
  }
  if (!hdr || String(hdr.cards.get('EXTNAME') ?? '').trim() !== 'FLAGS') return null;
  const dataAt = at + hdr.headerBytes;
  if (hdr.cards.get('ZIMAGE') === true) {
    const tiles = await readRiceRows(url, hdr.cards, dataAt, rowFrom, rowTo, nx, signal, { buf: head, at });
    return tiles && { values: tiles.values, bytes: head.byteLength + tiles.bytes };
  }
  if (hdr.cards.get('BITPIX') !== 32 || hdr.cards.get('NAXIS1') !== nx) return null;

  const raw = await fetchRange(url, dataAt + (rowFrom - 1) * nx * 4, dataAt + rowTo * nx * 4 - 1, signal);
  const view = new DataView(raw);
  const values = new Int32Array(raw.byteLength / 4);
  for (let k = 0; k < values.length; k++) values[k] = view.getInt32(k * 4, false);
  return { values, bytes: head.byteLength + raw.byteLength };
}

/**
 * The same rows when FLAGS is a tile-compressed image (DR1 onward): one
 * RICE_1 tile per detector row. Two reads: the rows' heap pointers, then the
 * stretch of heap they point into. Any other layout returns null, so the
 * frame is shown unmasked and says so, rather than masked wrongly.
 */
async function readRiceRows(url, cards, dataAt, rowFrom, rowTo, nx, signal, have = null) {
  if (String(cards.get('ZCMPTYPE') ?? '').trim() !== 'RICE_1') return null;
  if (cards.get('ZBITPIX') !== 32 || cards.get('ZNAXIS1') !== nx) return null;
  if (cards.get('ZTILE1') !== nx || (cards.get('ZTILE2') ?? 1) !== 1) return null;
  if (cards.get('NAXIS1') !== 8 || !/^1?P/.test(String(cards.get('TFORM1') ?? ''))) return null;
  let block = 32;
  for (let k = 1; cards.has(`ZNAME${k}`); k++) {
    const name = String(cards.get(`ZNAME${k}`)).trim();
    if (name === 'BLOCKSIZE') block = cards.get(`ZVAL${k}`);
    if (name === 'BYTEPIX' && cards.get(`ZVAL${k}`) !== 4) return null;
  }

  // The pointers come with the header's read when it reached them.
  const ptrFrom = dataAt + (rowFrom - 1) * 8;
  const ptrTo = dataAt + rowTo * 8;
  const inHead = have && ptrTo - have.at <= have.buf.byteLength;
  const pointers = inHead
    ? new DataView(have.buf, ptrFrom - have.at, ptrTo - ptrFrom)
    : new DataView(await fetchRange(url, ptrFrom, ptrTo - 1, signal));
  const rows = rowTo - rowFrom + 1;
  const tiles = [];
  for (let r = 0; r < rows; r++) tiles.push([pointers.getInt32(r * 8, false), pointers.getInt32(r * 8 + 4, false)]);
  const from = Math.min(...tiles.map(([, off]) => off));
  const to = Math.max(...tiles.map(([len, off]) => off + len));
  const heapAt = dataAt + (cards.get('THEAP') ?? cards.get('NAXIS1') * cards.get('NAXIS2'));
  const heap = new Uint8Array(await fetchRange(url, heapAt + from, heapAt + to - 1, signal));

  const values = new Int32Array(rows * nx);
  tiles.forEach(([len, off], r) => {
    values.set(riceDecode(heap.subarray(off - from, off - from + len), nx, block), r * nx);
  });
  return { values, bytes: (inHead ? 0 : pointers.byteLength) + heap.byteLength };
}

/** Blank, in place, every pixel of the rows read that the pipeline flagged. */
function maskFlagged(plane, read) {
  const n = Math.min(plane.length, read.values.length);
  let masked = 0;
  for (let k = 0; k < n; k++) {
    if (read.values[k] & FLAG_MASK) { plane[k] = NaN; masked += 1; }
  }
  return { bytes: read.bytes, masked };
}

/**
 * Detector-pixel bounding box that covers the whole output grid.
 * Sampled around the grid border rather than at four corners, because SIP
 * distortion bows the edges outward near the detector rim.
 */
function sourceBounds(wcs, grid) {
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  let hits = 0;
  const w = grid.width - 1;
  const h = grid.height - 1;
  const steps = 16;
  for (let s = 0; s <= steps; s++) {
    const u = (s / steps) * w;
    const v = (s / steps) * h;
    for (const [i, j] of [[u, 0], [u, h], [0, v], [w, v], [w / 2, h / 2]]) {
      const [ra, dec] = grid.indexToWorld(i, j);
      const p = wcs.worldToPix(ra, dec);
      if (!p) continue;
      hits++;
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  }
  return hits ? { x0, x1, y0, y1 } : null;
}

/**
 * Fetch and resample one epoch.
 * Returns null when the frame does not actually overlap the requested field.
 */
export async function loadStamp(url, grid, { signal, minCoverage = 0.15, mask = true } = {}) {
  const hdu = await readImageHDU(url, signal);
  const cards = hdu.cards;
  const wcs = new WCS(cards);
  const nx = cards.get('NAXIS1');
  const ny = cards.get('NAXIS2');
  const bitpix = cards.get('BITPIX');
  const bytesPerPixel = Math.abs(bitpix) / 8;

  const box = sourceBounds(wcs, grid);
  if (!box) return null;

  // One pixel of margin on every side so bilinear sampling has its neighbours.
  const rowFrom = Math.max(1, Math.floor(box.y0) - 1);
  const rowTo = Math.min(ny, Math.ceil(box.y1) + 1);
  if (rowTo < rowFrom || box.x1 < 1 || box.x0 > nx) return null;

  const rows = rowTo - rowFrom + 1;
  const byteStart = hdu.dataStart + (rowFrom - 1) * nx * bytesPerPixel;
  const byteEnd = hdu.dataStart + rowTo * nx * bytesPerPixel - 1;
  // The same rows of the FLAGS plane, asked for at the same moment. A frame
  // whose flags cannot be read is still shown, and says so through
  // `flagged: null`; only a cancelled read stops the frame.
  const flagsRead = readFlags(url, hdu, rowFrom, rowTo, nx, signal).catch((err) => {
    if (err?.name === 'AbortError') throw err;
    return null;
  });
  // If the image read fails first, the flags promise must not be left to
  // reject with nobody listening.
  flagsRead.catch(() => {});
  const raw = await fetchRange(url, byteStart, byteEnd, signal);
  const plane = decodePixels(raw, 0, rows * nx, bitpix, {
    bzero: cards.get('BZERO') ?? 0,
    bscale: cards.get('BSCALE') ?? 1,
  });
  // A pixel the pipeline has already called bad is a hole here too — filled
  // from its good neighbours below — instead of a bright point waiting to be
  // "found".
  // `mask: false` is for the tools that calibrate against a flagged pixel.
  const read = await flagsRead;
  const flagged = read && mask ? maskFlagged(plane, read) : null;
  const flagRows = read?.values ?? null;

  // The sky noise of the detector's own pixels, over the columns the field
  // covers. The depth is a statement about detector pixels (6.15″, the pixel
  // solid angle it is converted through), and the resampled grid is smoother
  // than they are: bilinear interpolation averages neighbours and reads about
  // a third low, which made every quoted depth ~0.4 mag too deep.
  const colFrom = Math.max(0, Math.floor(box.x0) - 1);
  const colTo = Math.min(nx - 1, Math.ceil(box.x1) - 1);
  const patch = new Float32Array(Math.max(0, colTo - colFrom + 1) * rows);
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = colFrom; c <= colTo; c++) patch[n++] = plane[r * nx + c];
  }
  const detectorSigma = skySigma(patch.subarray(0, n));

  // Bilinear sample, falling back to the nearest valid neighbour around bad pixels.
  const gw = grid.width;
  const gh = grid.height;
  const out = new Float32Array(gw * gh).fill(NaN);
  const quality = new Uint8Array(gw * gh);
  let overflow = 0;
  let inside = 0;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const [ra, dec] = grid.indexToWorld(i, j);
      const p = wcs.worldToPix(ra, dec);
      if (!p) continue;
      const fx = p[0] - 1; // to 0-based array space
      const fy = p[1] - 1 - (rowFrom - 1);
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      if (ix < 0 || iy < 0 || ix + 1 >= nx || iy + 1 >= rows) continue;
      if (p[0] < 1 || p[0] > nx || p[1] < 1 || p[1] > ny) continue;

      const tx = fx - ix;
      const ty = fy - iy;
      const base = iy * nx + ix;
      const nearest = base + (tx >= 0.5 ? 1 : 0) + (ty >= 0.5 ? nx : 0);
      let q = plane[nearest] === plane[nearest] ? 0 : QUALITY.HOLE;
      if (flagRows && flagRows[nearest] & (1 << OVERFLOW_BIT)) { q |= QUALITY.OVERFLOW; overflow++; }
      quality[j * gw + i] = q;
      const a = plane[base];
      const b = plane[base + 1];
      const c = plane[base + nx];
      const d = plane[base + nx + 1];

      let value;
      if (a === a && b === b && c === c && d === d) {
        value = a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
      } else {
        const near = [[a, (1 - tx) * (1 - ty)], [b, tx * (1 - ty)], [c, (1 - tx) * ty], [d, tx * ty]]
          .filter((e) => e[0] === e[0])
          .sort((m, n2) => n2[1] - m[1]);
        if (!near.length) continue;
        value = near[0][0];
      }
      out[j * gw + i] = value;
      inside++;
    }
  }

  const coverage = inside / (gw * gh);
  if (coverage < minCoverage) return null;

  return {
    data: out,
    // Per sample: QUALITY.OVERFLOW where the nearest detector pixel saturated,
    // QUALITY.HOLE where it holds no value (masked, or blanked by the pipeline).
    quality,
    width: gw,
    height: gh,
    coverage,
    wcs,
    // The detector's own pixels under the field, kept for the one test that
    // must not be read through the resampling: whether a flash is a star's
    // shape or a single pixel (sharpness.js). A fraction of the visit's own
    // bytes: the grid is cut a few times finer than the detector.
    detector: { data: patch, width: colTo - colFrom + 1, height: rows, x0: colFrom + 1, y0: rowFrom, wcs },
    meta: {
      obsId: String(cards.get('OBSID') ?? '').trim(),
      dateObs: String(cards.get('DATE-OBS') ?? '').trim(),
      mjd: cards.get('MJD-OBS'),
      detector: cards.get('DETECTOR'),
      unit: String(cards.get('BUNIT') ?? '').trim(),
      exposure: cards.get('EXPTIME') ?? cards.get('EFFEXPTM') ?? null,
      rollDeg: wcs.rollDeg,
      pixelScale: wcs.scale * 3600,
      bytesRead: raw.byteLength + (flagged?.bytes ?? 0),
      flaggedPixels: flagged ? flagged.masked : null,
      // Grid samples on saturated detector pixels; null when FLAGS was not read.
      overflowSamples: flagRows ? overflow : null,
      detectorSigma,
    },
  };
}

/**
 * The WCS-WAVE table is the last extension of a Level-2 file: one header block
 * and one block of data, whatever the band. Asking for the file's last two
 * blocks reads it without knowing how long the file is.
 */
const WAVE_TAIL_BYTES = 2 * 2880;

async function fetchTail(url, bytes, signal) {
  const res = await fetch(url, {
    headers: { Range: `bytes=-${bytes}` },
    signal: deadline(signal, FRAME_DEADLINE_MS),
  });
  // Anything but a partial answer would be the whole 70 MB file.
  if (res.status !== 206) throw new Error(`Range not honoured (HTTP ${res.status}) on ${url}`);
  return res.arrayBuffer();
}

/**
 * The wavelength one exposure saw a sky position at: the detector pixel the
 * position falls on, looked up in the file's own WCS-WAVE table. About 70 KB
 * of the file. Returns null when the file has no such table at its end or the
 * position is off the detector — never a guess.
 */
export async function loadWavelength(url, ra, dec, { signal } = {}) {
  const [hdu, table] = await Promise.all([
    readImageHDU(url, signal),
    remembered(waveTables, url, async () => parseWaveTable(await fetchTail(url, WAVE_TAIL_BYTES, signal))),
  ]);
  const pix = new WCS(hdu.cards).worldToPix(ra, dec);
  return pix ? wavelengthAt(table, pix[0], pix[1]) : null;
}

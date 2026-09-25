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

import { scanHDUs, decodePixels } from './fits.js';
import { WCS } from './wcs.js';

const HEADER_PROBE = 65536;
const MAX_HEADER = 1 << 20;

async function fetchRange(url, start, end, signal) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}`);
  return res.arrayBuffer();
}

/** Read enough of the file to describe HDU 0 and the IMAGE extension. */
async function readImageHDU(url, signal) {
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
export async function loadStamp(url, grid, { signal, minCoverage = 0.15 } = {}) {
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
  const raw = await fetchRange(url, byteStart, byteEnd, signal);
  const plane = decodePixels(raw, 0, rows * nx, bitpix, {
    bzero: cards.get('BZERO') ?? 0,
    bscale: cards.get('BSCALE') ?? 1,
  });

  // Bilinear sample, falling back to the nearest valid neighbour around bad pixels.
  const gw = grid.width;
  const gh = grid.height;
  const out = new Float32Array(gw * gh).fill(NaN);
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
    width: gw,
    height: gh,
    coverage,
    wcs,
    meta: {
      obsId: String(cards.get('OBSID') ?? '').trim(),
      dateObs: String(cards.get('DATE-OBS') ?? '').trim(),
      mjd: cards.get('MJD-OBS'),
      detector: cards.get('DETECTOR'),
      unit: String(cards.get('BUNIT') ?? '').trim(),
      exposure: cards.get('EXPTIME') ?? cards.get('EFFEXPTM') ?? null,
      rollDeg: wcs.rollDeg,
      pixelScale: wcs.scale * 3600,
      bytesRead: raw.byteLength,
    },
  };
}

/**
 * wise.js — the AllWISE picture of the open field, on the same grid as the
 * SPHEREx visits, so the wipe can put one beside the other.
 *
 * The page's relay asks IRSA for a cutout of the AllWISE Atlas tile that
 * covers the field (`/api/wise`). Atlas images are SIN-projected with their
 * own scale (1.375″ a pixel against SPHEREx's 6.15″) and their own tile
 * centre, so the cutout is resampled here onto the field's north-up tangent
 * grid, exactly as each SPHEREx exposure is. AllWISE coadds observations from
 * 2010–2011: a star that moves shows where it was fifteen years earlier.
 */

import { readHeader, decodePixels } from './fits.js';
import { deadline } from './net.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** The two WISE bands the Atlas offers that SPHEREx also covers. */
export const WISE_BANDS = {
  1: { name: 'W1', micron: 3.4 },
  2: { name: 'W2', micron: 4.6 },
};
/** Atlas coadds span the cryogenic and post-cryo surveys, 2010 Jan to 2011 Feb. */
export const WISE_EPOCH = '2010';
const WISE_DEADLINE_MS = 90_000;

/**
 * World → pixel for a SIN or TAN header written with CDELT/CROTA2 or a CD
 * matrix: the two forms an Atlas cutout comes in. Returns 1-based FITS pixel
 * coordinates, or null for a point on the far side of the projection.
 */
export function simpleProjection(cards) {
  const ctype = String(cards.get('CTYPE1') ?? '');
  const sin = ctype.includes('-SIN');
  if (!sin && !ctype.includes('-TAN')) throw new Error(`unsupported projection ${ctype}`);
  const a0 = cards.get('CRVAL1') * D2R;
  const d0 = cards.get('CRVAL2') * D2R;
  const px0 = cards.get('CRPIX1');
  const py0 = cards.get('CRPIX2');
  let cd;
  if (cards.has('CD1_1')) {
    cd = [cards.get('CD1_1'), cards.get('CD1_2') ?? 0, cards.get('CD2_1') ?? 0, cards.get('CD2_2')];
  } else {
    const c1 = cards.get('CDELT1');
    const c2 = cards.get('CDELT2');
    const rot = (cards.get('CROTA2') ?? 0) * D2R;
    cd = [c1 * Math.cos(rot), -c2 * Math.sin(rot), c1 * Math.sin(rot), c2 * Math.cos(rot)];
  }
  const det = cd[0] * cd[3] - cd[1] * cd[2];
  if (!det) throw new Error('singular pixel scale');
  const inv = [cd[3] / det, -cd[1] / det, -cd[2] / det, cd[0] / det];

  return (ra, dec) => {
    const d = dec * D2R;
    const dA = ra * D2R - a0;
    const cosC = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(dA);
    if (cosC <= 0) return null;
    const k = sin ? 1 : 1 / cosC;
    const x = Math.cos(d) * Math.sin(dA) * k * R2D;
    const y = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(dA)) * k * R2D;
    return [px0 + inv[0] * x + inv[1] * y, py0 + inv[2] * x + inv[3] * y];
  };
}

/**
 * Sample an image onto a grid, bilinearly. `toPixel(ra, dec)` gives 1-based
 * pixel coordinates; a grid point outside the image, or next to a blank
 * pixel, stays NaN rather than borrowing from nowhere.
 */
export function resampleOnto(grid, image, nx, ny, toPixel) {
  const out = new Float32Array(grid.width * grid.height).fill(NaN);
  let inside = 0;
  for (let j = 0; j < grid.height; j++) {
    for (let i = 0; i < grid.width; i++) {
      const [ra, dec] = grid.indexToWorld(i, j);
      const p = toPixel(ra, dec);
      if (!p) continue;
      const x = p[0] - 1;
      const y = p[1] - 1;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= nx || y0 + 1 >= ny) continue;
      const fx = x - x0;
      const fy = y - y0;
      const k = y0 * nx + x0;
      const v = (1 - fy) * ((1 - fx) * image[k] + fx * image[k + 1])
        + fy * ((1 - fx) * image[k + nx] + fx * image[k + nx + 1]);
      if (Number.isFinite(v)) { out[j * grid.width + i] = v; inside += 1; }
    }
  }
  return { data: out, coverage: inside / out.length };
}

/** Read a whole single-image FITS file into its header cards and pixels. */
export function readFitsImage(buf) {
  const hdr = readHeader(buf, 0);
  if (!hdr) throw new Error('not a FITS file');
  const nx = hdr.cards.get('NAXIS1');
  const ny = hdr.cards.get('NAXIS2');
  const pixels = decodePixels(buf, hdr.headerBytes, nx * ny, hdr.cards.get('BITPIX'), {
    bzero: hdr.cards.get('BZERO') ?? 0,
    bscale: hdr.cards.get('BSCALE') ?? 1,
  });
  return { cards: hdr.cards, nx, ny, pixels };
}

/**
 * The AllWISE picture of the grid's field in one band, ready to be painted
 * like a visit: `{ stamp: { data, width, height }, band, epoch }`.
 */
export async function loadWise(grid, band, { signal } = {}) {
  // The field and a little margin: the resampler needs the pixels around
  // the edge, not a wider view.
  const size = Math.min(0.6, grid.spanDeg * 1.1 + 0.01);
  const q = new URLSearchParams({
    ra: grid.ra.toFixed(5), dec: grid.dec.toFixed(5), size: size.toFixed(3), band: String(band),
  });
  const res = await fetch(`api/wise?${q}`, { signal: deadline(signal, WISE_DEADLINE_MS) });
  if (!res.ok) throw new Error(`AllWISE ${res.status}`);
  const image = readFitsImage(await res.arrayBuffer());
  const { data, coverage } = resampleOnto(grid, image.pixels, image.nx, image.ny, simpleProjection(image.cards));
  if (coverage < 0.5) throw new Error('AllWISE cutout misses the field');
  return {
    stamp: { data, width: grid.width, height: grid.height },
    band: WISE_BANDS[band].name, micron: WISE_BANDS[band].micron, epoch: WISE_EPOCH,
  };
}

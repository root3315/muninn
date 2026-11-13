/**
 * sharpness.js — is a one-visit flash a star's shape, or one pixel?
 *
 * Light from the sky reaches the detector through the telescope, and the
 * telescope spreads every point of it over a few 6.15″ pixels: even centred
 * on a pixel, a real source leaves a good share of its light in the eight
 * around it. A cosmic ray strikes the silicon directly and a hot pixel is a
 * fault of the pixel itself; either puts nearly all of its signal in one.
 *
 * So the test is read on the detector's own pixels, before any resampling
 * (the shared grid is bilinear, and interpolation would smear a spike into a
 * shape that looks optical): the share of the 3 × 3 pixels' light that sits
 * in the brightest one. The pipeline's FLAGS plane already catches most hits
 * and those pixels are masked; this is for the ones it let through.
 */

import { WCS } from './wcs.js';

/**
 * The largest share of its 3 × 3 light any star put in one pixel, measured
 * on the detector pixels of the Atala field (DR1 and QR3, every visit): 0.87
 * in D1 over 415 stars, 0.86 in D2 over 517. Pipeline-flagged hits in the
 * same frames sit at 0.93 to 1.0 once their mask is lifted, the 6 Jul 2025
 * one at 1.00. A star cannot have less light around its peak than this
 * leaves, about 15 % of the peak, except by noise.
 */
export const STAR_MAX_SHARE = 0.87;

/**
 * How many noise widths below a star's least the neighbours must fall before
 * a flash is called a single pixel: the same three the rest of the tool asks
 * before it calls anything a detection.
 */
const K_SIGMA = 3;

/** Fewer good pixels than this in the 3 × 3 and the share is not quoted. */
const MIN_GOOD = 7;

const worldToPix = (wcs, ra, dec) => WCS.prototype.worldToPix.call(wcs, ra, dec);

/**
 * The flux share of the brightest detector pixel near (ra, dec).
 *
 * `detector` is the patch a visit was cut from: `{ data, width, height, x0,
 * y0, wcs }`, where (x0, y0) is the 1-based FITS pixel of `data[0]` and `wcs`
 * the frame's own (an instance or its plain fields, as a worker hands it on).
 * The brightest pixel within `search` pixels of the position is taken as the
 * centre, the background is the median of a ring three to five pixels out,
 * and the answer is
 *
 *   share  — the centre pixel's part of the background-subtracted 3 × 3 sum
 *   ratio  — the centre against the mean of its eight neighbours
 *
 * or null where the patch has no clear answer: off its edge, a masked centre,
 * or too few good pixels around it.
 */
export function sharpness(detector, ra, dec, { search = 1 } = {}) {
  if (!detector?.data || !detector.wcs) return null;
  const p = worldToPix(detector.wcs, ra, dec);
  if (!p) return null;
  return sharpnessAt(detector, Math.round(p[0]) - detector.x0, Math.round(p[1]) - detector.y0, { search });
}

/** The same, from a 0-based column and row of the patch. */
export function sharpnessAt({ data, width: W, height: H }, col, row, { search = 1 } = {}) {
  const RING = 5;
  const at = (i, j) => (i < 0 || j < 0 || i >= W || j >= H ? NaN : data[j * W + i]);

  let ci = -1;
  let cj = -1;
  let top = -Infinity;
  for (let j = row - search; j <= row + search; j++) {
    for (let i = col - search; i <= col + search; i++) {
      const v = at(i, j);
      if (v > top) { top = v; ci = i; cj = j; }
    }
  }
  if (ci < RING || cj < RING || ci + RING >= W || cj + RING >= H) return null;

  const ring = [];
  for (let j = cj - RING; j <= cj + RING; j++) {
    for (let i = ci - RING; i <= ci + RING; i++) {
      const d = Math.max(Math.abs(i - ci), Math.abs(j - cj));
      const v = at(i, j);
      if (d >= 3 && v === v) ring.push(v);
    }
  }
  if (ring.length < 20) return null;
  ring.sort((a, b) => a - b);
  const bg = ring[ring.length >> 1];

  const peak = top - bg;
  if (!(peak > 0)) return null;
  let sum = 0;
  let around = 0;
  let good = 0;
  for (let j = cj - 1; j <= cj + 1; j++) {
    for (let i = ci - 1; i <= ci + 1; i++) {
      const v = at(i, j);
      if (!(v === v)) continue;
      good += 1;
      sum += v - bg;
      if (i !== ci || j !== cj) around += v - bg;
    }
  }
  if (good < MIN_GOOD || !(sum > 0)) return null;
  const neighbours = good - 1;
  return {
    share: peak / sum,
    ratio: around > 0 ? peak / (around / neighbours) : Infinity,
    peak,
    pixel: [ci, cj],
  };
}

/**
 * Star or single pixel, with the noise taken into account.
 *
 * A star leaves at least (1/STAR_MAX_SHARE − 1) of its peak in the eight
 * pixels around it. Those eight carry noise, σ√8 together for a sky noise σ
 * per pixel, so a faint flash cannot be told apart: its neighbours could sit
 * at nothing by chance. The flash is called too sharp only when its
 * neighbours fall short of a star's least by three times that noise; the
 * share at which that happens is the `limit` reported beside the measured
 * share. Returns
 *
 *   { verdict: 'sharp' | 'star' | 'faint', share, ratio, limit }
 *
 * with `limit` null for a flash too faint to judge, or null for no reading.
 */
export function sharpVerdict(s, sigma) {
  if (!s || !(sigma > 0)) return null;
  const least = (1 / STAR_MAX_SHARE - 1) * s.peak;
  const room = least - K_SIGMA * sigma * Math.sqrt(8);
  const base = { share: s.share, ratio: s.ratio, snr: s.peak / sigma };
  if (!(room > 0)) return { ...base, verdict: 'faint', limit: null };
  const limit = s.peak / (s.peak + room);
  return { ...base, verdict: s.share > limit ? 'sharp' : 'star', limit };
}

/** The lowest peak, in sky-noise units, at which the test can say anything. */
export const MIN_JUDGED_SNR = (K_SIGMA * Math.sqrt(8)) / (1 / STAR_MAX_SHARE - 1);

/** A reading that says one pixel: a cosmic ray or a hot pixel, not a star. */
export const tooSharp = (v) => v?.verdict === 'sharp';

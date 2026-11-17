/**
 * fills.js — the two kinds of place where the DR1 cube has nothing, and what
 * the sky draws there instead.
 *
 * The deep fields: round each ecliptic pole the cube is blank at every
 * wavelength but a few, out to about 2° (measured on the colour view's three
 * Allsky images: blank to 1.75°, a quarter blank at 2°, sky by 2.25°). These
 * are SPHEREx's two deep fields, the most-visited sky of the mission, which the
 * all-sky cube leaves out; their frames are in the tool. Nothing is drawn
 * into them but a quiet hatched tone that says so.
 *
 * The cores of the brightest stars: past the detector's well the pixels are
 * closed, and at the centre of a star brighter than about V 2.5 all three of
 * the colour view's frames are blank, 0.5–2.4′ across (measured on the
 * order-5 tiles of the 70 brightest). Only those blank pixels, and only round
 * a catalogued star, are filled: a soft disc at the star's own place, as
 * bright as the display shows the light round it, tinted by its B−V.
 */

import { vecOf } from './healpix.js';
import { starColour } from '../starcolour.js';

/**
 * The two deep fields: where the cube is blank and how far round it, degrees,
 * and `field`, the ready-made field of the same key that opens their frames
 * (data/targets.json, data/fields/index.json).
 */
export const DEEP_GAPS = [
  { key: 'nep', ra: 270, dec: 66.5607, radius: 2.1, field: { ra: 269.7, dec: 66.56 } },
  { key: 'sep', ra: 90, dec: -66.5607, radius: 2.1, field: { ra: 90, dec: -66.56 } },
];

/** Stars brighter than this have their blank cores filled. */
export const CORE_VMAG = 3;
/** How many there are in the site's catalogue (data/sky/stars.json), for the credit line; a test keeps it true. */
export const CORE_STAR_COUNT = 170;
/** How far round a star its blank pixels count as its core: wider than any core measured. */
export const CORE_REACH_ARCMIN = 3;
/** The most cores the shader is given at once. */
export const CORES_MAX = 8;
/** Wider than this the cores are under a pixel, and none are given. */
export const CORE_FOV = 12;

/**
 * The catalogue's bright stars, made ready for the shader once: direction,
 * and the colour the core is drawn in — the star's own, mostly whitened, as
 * the stars round it come out of the cube's false colour nearly white — and
 * how bright, from its magnitude.
 */
export function coreStars(stars) {
  const n = stars?.mag ? stars.mag.findIndex((m) => !(m < CORE_VMAG)) : 0;
  const count = n < 0 ? stars.mag.length : n;
  const dir = new Float32Array(count * 3);
  const tint = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    dir.set(vecOf(stars.ra[i], stars.dec[i]), i * 3);
    const peak = Math.max(0.85, Math.min(1, 1 - 0.05 * stars.mag[i]));
    const c = starColour(Number.isFinite(stars.bv[i]) ? stars.bv[i] : 0.6);
    for (let k = 0; k < 3; k++) tint[i * 3 + k] = peak * (0.75 + 0.25 * (c[k] / 255));
  }
  return { count, dir, tint };
}

/**
 * The cores near the middle of a view, written into `out` (directions and
 * reach as vec4, tints as vec3, CORES_MAX of each): the nearest to the centre
 * first. Nothing is made: the arrays are the caller's, reused.
 */
export function pickCores(list, C, cosReach, out) {
  out.count = 0;
  if (!list) return out;
  const reach = (CORE_REACH_ARCMIN / 60) * (Math.PI / 180);
  for (let i = 0; i < list.count; i++) {
    const d = list.dir[i * 3] * C[0] + list.dir[i * 3 + 1] * C[1] + list.dir[i * 3 + 2] * C[2];
    if (d < cosReach) continue;
    // Kept in order of closeness to the centre, by insertion: eight at most.
    let at = out.count;
    while (at > 0 && out.near[at - 1] < d) at--;
    if (at >= CORES_MAX) continue;
    const last = Math.min(out.count, CORES_MAX - 1);
    for (let j = last; j > at; j--) {
      out.near[j] = out.near[j - 1];
      out.cores.copyWithin(j * 4, (j - 1) * 4, j * 4);
      out.tints.copyWithin(j * 3, (j - 1) * 3, j * 3);
    }
    out.near[at] = d;
    out.cores[at * 4] = list.dir[i * 3];
    out.cores[at * 4 + 1] = list.dir[i * 3 + 1];
    out.cores[at * 4 + 2] = list.dir[i * 3 + 2];
    out.cores[at * 4 + 3] = reach;
    out.tints[at * 3] = list.tint[i * 3];
    out.tints[at * 3 + 1] = list.tint[i * 3 + 1];
    out.tints[at * 3 + 2] = list.tint[i * 3 + 2];
    out.count = Math.min(CORES_MAX, out.count + 1);
  }
  return out;
}

/** Room for pickCores, made once per view. */
export const coreSlots = () => ({
  count: 0,
  near: new Float32Array(CORES_MAX),
  cores: new Float32Array(CORES_MAX * 4),
  tints: new Float32Array(CORES_MAX * 3),
});

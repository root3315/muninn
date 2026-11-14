/**
 * brightstars.js — the naked-eye stars bright enough to spoil SPHEREx's view.
 *
 * SPHEREx is built for faint sources. A star brighter than about V 3 runs
 * past the detector's well over arcminutes, the pipeline closes the pixels
 * round it, and its light comes back elsewhere as optical ghosts and stray
 * light that land somewhere new with each roll of the spacecraft. These are
 * the stars of the site's own catalogue (data/sky/stars.json, as gate.js
 * loadStars reads it) that do that, and how far from each that is to be
 * expected.
 */

import { separation } from './wcs.js';

/** Brighter than this, a star's ghosts and stray light are worth a word. */
export const GHOST_VMAG = 3;

/**
 * How far from a star of magnitude `v` its stray light and ghosts are to be
 * expected, in arcminutes: twelve for V 0, scaling with the square root of
 * its light, so three for V 3 and twenty-four for Sirius.
 */
export const ghostReachArcmin = (v) => 12 * 10 ** (-0.2 * v);

/** The catalogue's name for star `i`: its proper name, else its Bayer letter, else null. */
function nameOf(stars, i) {
  const n = stars.named?.find((s) => s.i === i);
  return n?.name || n?.bayer || null;
}

/**
 * The bright stars of the catalogue (brighter than `vmax`), as
 * { ra, dec, mag, name }. The catalogue is sorted by magnitude, so this is
 * its first few hundred entries.
 */
export function brightStars(stars, vmax = GHOST_VMAG) {
  const out = [];
  if (!stars?.mag) return out;
  for (let i = 0; i < stars.mag.length; i++) {
    if (!(stars.mag[i] < vmax)) continue;
    out.push({ ra: stars.ra[i], dec: stars.dec[i], mag: stars.mag[i], name: nameOf(stars, i) });
  }
  return out;
}

/**
 * The bright star whose light reaches (ra, dec), with how far it is in
 * arcminutes, or null: the one that reaches farthest past the spot when
 * there are several. `extraArcmin` widens every reach, for a field rather
 * than a point.
 */
export function brightStarNear(list, ra, dec, { extraArcmin = 0 } = {}) {
  let best = null;
  for (const s of list ?? []) {
    const d = separation(s.ra, s.dec, ra, dec) * 60;
    const room = ghostReachArcmin(s.mag) + extraArcmin - d;
    if (room >= 0 && (!best || room > best.room)) best = { ...s, distArcmin: d, room };
  }
  if (!best) return null;
  delete best.room;
  return best;
}

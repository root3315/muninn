/**
 * orbit.js — where the Earth was for each visit. Pure.
 *
 * SPHEREx looks at a patch of sky when the Sun is about 90° from it, which
 * happens twice a year, half an orbit apart: the visits come in two seasons
 * on opposite sides of the Earth's orbit. Laid out on a ring at the Earth's
 * own heliocentric longitude, the visits show that, and show the baseline
 * between the seasons, which is what lets a distant body be seen to shift.
 */

import { parallaxShiftArcmin } from './depth3d.js';

const D2R = Math.PI / 180;

/**
 * The Sun's apparent ecliptic longitude at a moment (MJD), in degrees: the
 * low-precision solar formula of the Astronomical Almanac, good to 0.01°.
 */
export function sunLongitude(mjd) {
  const n = mjd - 51544.5;
  const L = 280.46 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * D2R;
  const lambda = L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
  return ((lambda % 360) + 360) % 360;
}

/** The Earth's heliocentric longitude: opposite the Sun as seen from it. */
export const earthLongitude = (mjd) => (sunLongitude(mjd) + 180) % 360;

const wrap180 = (a) => ((a % 360) + 540) % 360 - 180;

/**
 * The visits (MJDs, ascending) on the ring.
 *
 *   angles   each visit's place, degrees, counter-clockwise from above, with
 *            the first season's middle at 0 (in front of the viewer)
 *   tiers    0 for the first year from the first visit, 1 for the second…
 *            (inside a season spaced at least `minSepDeg` apart)
 *   seasons  runs of visits closer than `gapDays`: [{ from, to }] indexes
 *   gaps     the stretches between seasons: { at (degrees, their middle), days, from, to }
 *   baseline the two seasons farthest apart (their mean Earth positions), the chord between
 *            them in AU, and how far that shifts a body at `bodyAU`
 */
export function ringLayout(mjds, { gapDays = 45, bodyAU = 500, minSepDeg = 0 } = {}) {
  const n = mjds.length;
  const out = { angles: [], tiers: [], seasons: [], gaps: [], baseline: null, front: 0 };
  if (!n) return out;
  const lon = mjds.map(earthLongitude);

  for (let i = 0; i < n; i++) {
    const last = out.seasons.at(-1);
    if (last && mjds[i] - mjds[i - 1] <= gapDays) last.to = i;
    else out.seasons.push({ from: i, to: i });
  }

  // The mean direction of a set of longitudes, as a unit vector.
  const meanOf = (from, to) => {
    let x = 0;
    let y = 0;
    for (let i = from; i <= to; i++) { x += Math.cos(lon[i] * D2R); y += Math.sin(lon[i] * D2R); }
    const len = Math.hypot(x, y) || 1;
    return [x / len, y / len];
  };
  const first = meanOf(out.seasons[0].from, out.seasons[0].to);
  out.front = (Math.atan2(first[1], first[0]) / D2R + 360) % 360;

  out.angles = lon.map((l) => wrap180(l - out.front));
  out.tiers = mjds.map((m) => Math.floor((m - mjds[0]) / 365.25));

  // Inside a season the Earth moves about a degree a day, less than a frame
  // is wide: the season's visits are spaced to `minSepDeg`, in order, about
  // the season's own middle, so each stays where the Earth was give or take
  // the spacing.
  for (const s of out.seasons) {
    const a = out.angles.slice(s.from, s.to + 1);
    const mid = a.reduce((sum, x) => sum + x, 0) / a.length;
    for (let i = 1; i < a.length; i++) a[i] = Math.max(a[i], a[i - 1] + minSepDeg);
    const shift = mid - a.reduce((sum, x) => sum + x, 0) / a.length;
    for (let i = 0; i < a.length; i++) out.angles[s.from + i] = wrap180(a[i] + shift);
  }

  for (let k = 1; k < out.seasons.length; k++) {
    const a = out.seasons[k - 1].to;
    const b = out.seasons[k].from;
    // Its middle along the way the Earth went, not the short way round.
    const sweep = ((out.angles[b] - out.angles[a]) % 360 + 360) % 360;
    out.gaps.push({ at: wrap180(out.angles[a] + sweep / 2), days: mjds[b] - mjds[a], from: a, to: b });
  }

  if (out.seasons.length >= 2) {
    // The two seasons farthest apart: a year's two visits to the same side
    // of the orbit are no baseline at all.
    const means = out.seasons.map((x) => meanOf(x.from, x.to));
    let best = [0, 1];
    let chordAU = -1;
    for (let i = 0; i < means.length; i++) {
      for (let j = i + 1; j < means.length; j++) {
        // The Earth's orbit is near enough a circle of 1 AU for a chord.
        const c = Math.hypot(means[i][0] - means[j][0], means[i][1] - means[j][1]);
        if (c > chordAU) { chordAU = c; best = [i, j]; }
      }
    }
    const [p1, p2] = best.map((k) => means[k]);
    out.baseline = {
      a: wrap180(Math.atan2(p1[1], p1[0]) / D2R - out.front),
      b: wrap180(Math.atan2(p2[1], p2[0]) / D2R - out.front),
      chordAU,
      bodyAU,
      shiftArcmin: parallaxShiftArcmin(chordAU, bodyAU),
    };
  }
  return out;
}

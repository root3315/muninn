/**
 * stack.js — adding up one season of visits.
 *
 * SPHEREx comes back to a patch of sky in seasons: a handful of visits over a
 * week or two, then nothing for half a year. Inside a season a star and a
 * distant body both sit still to within a pixel or two, so the visits of one
 * season in one band can simply be added — and the noise falls by √n.
 *
 * How still is "still" was measured rather than assumed. SPHEREx looks at the
 * sky about 90° from the Sun, where the Earth's own motion is mostly along the
 * line of sight, so the parallax of a far body builds slowly inside a season.
 * For the Atala field's December season (eleven days, elongation ~100°) the
 * Earth's reflex moves a body at 500 AU by at most 1.1 detector pixels and its
 * own orbital motion adds ~0.6; at 300 AU the two come to about three pixels.
 * Between seasons the same 500 AU body jumps 13.6′. So a season stack keeps
 * anything from ~500 AU outward sharp, deepens it, and a blink between two
 * season stacks is where it would jump. Nearer movers smear across the stack,
 * which is what they should do: they are not what it is for.
 *
 * Shifting each visit along a trial distance before adding — the classic
 * shift-and-stack — was measured too and is not done here: inside a season the
 * shift at Planet X distances is the same pixel or so as no shift at all.
 */

/** Visits within this many days of each other, in one band, are one season. */
export const SEASON_DAYS = 20;

/**
 * The indices of the visits in the same season as visit `i`: the same band,
 * and no more than SEASON_DAYS from it. `visits` carry `frame.mjd` and
 * `frame.band`.
 */
export function seasonOf(visits, i, { days = SEASON_DAYS } = {}) {
  const ref = visits[i]?.frame;
  if (!ref) return [];
  const out = [];
  visits.forEach((v, k) => {
    if (v.frame.band === ref.band && Math.abs(v.frame.mjd - ref.mjd) <= days) out.push(k);
  });
  return out;
}

/**
 * The first visit of the next season in direction `dir` (+1 later, −1
 * earlier), or `i` itself when there is none. Seasons are counted in the same
 * band, so "all bands" steps through the band of the visit on screen.
 */
export function seasonStep(visits, i, dir, { days = SEASON_DAYS } = {}) {
  const ref = visits[i]?.frame;
  if (!ref) return i;
  const order = visits
    .map((v, k) => ({ k, f: v.frame }))
    .filter(({ f }) => f.band === ref.band)
    .sort((a, b) => a.f.mjd - b.f.mjd);
  const next = dir > 0
    ? order.find(({ f }) => f.mjd - ref.mjd > days)
    : [...order].reverse().find(({ f }) => ref.mjd - f.mjd > days);
  if (!next) return i;
  // Land on the season's earliest visit, so stepping back and forth is stable.
  const start = order.find(({ f }) => Math.abs(f.mjd - next.f.mjd) <= days);
  return (start ?? next).k;
}

/**
 * Add planes of the same grid, pixel by pixel. With four or more values the
 * single brightest is dropped before averaging: that takes out a cosmic ray
 * the pipeline missed and an asteroid crossing in one visit, and costs the
 * noise almost nothing. Masked pixels (NaN) are left out of their pixel's sum.
 */
export function coadd(planes) {
  const len = planes[0]?.length ?? 0;
  const out = new Float32Array(len).fill(NaN);
  const n = planes.length;
  for (let p = 0; p < len; p++) {
    let m = 0;
    let sum = 0;
    let max = -Infinity;
    for (let k = 0; k < n; k++) {
      const v = planes[k][p];
      if (v === v) { m += 1; sum += v; if (v > max) max = v; }
    }
    if (!m) continue;
    out[p] = m >= 4 ? (sum - max) / (m - 1) : sum / m;
  }
  return out;
}

/** How many visits a stack of n actually averages, after the one dropped. */
export const averaged = (n) => (n >= 4 ? n - 1 : n);

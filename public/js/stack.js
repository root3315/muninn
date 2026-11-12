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
 *
 * Seasons are cut from every visit the archive lists in the band, not from the
 * few the viewer loaded for its blink: those are spread across the whole
 * baseline and usually leave one per season, which would stack to nothing.
 */

/** A gap longer than this, with no visit in the band, starts a new season. */
export const SEASON_GAP_DAYS = 30;
/**
 * And no season runs longer than this from its first visit. Fields near the
 * ecliptic poles are seen all year round; the cap keeps a "season" to the span
 * over which the stillness above was measured.
 */
export const SEASON_SPAN_DAYS = 20;
/** The most visits one stack adds, nearest in time to the one on screen. */
export const STACK_MAX = 6;
/** Exposures closer than this belong to one visit (the archive's own grouping). */
const SAME_VISIT_DAYS = 6 / 24;

/**
 * The seasons of one band's visits: arrays of frames in date order. `frames`
 * are visits of a single band, each with `mjd`.
 */
export function seasonChunks(frames, { gap = SEASON_GAP_DAYS, span = SEASON_SPAN_DAYS } = {}) {
  const sorted = [...frames].sort((a, b) => a.mjd - b.mjd);
  const chunks = [];
  let cur = null;
  let last = -Infinity;
  for (const f of sorted) {
    if (!cur || f.mjd - last > gap || f.mjd - cur[0].mjd > span) {
      cur = [];
      chunks.push(cur);
    }
    cur.push(f);
    last = f.mjd;
  }
  return chunks;
}

/** The index of the season a moment falls in, or −1. */
export function chunkAt(chunks, mjd) {
  return chunks.findIndex((c) => mjd >= c[0].mjd - SAME_VISIT_DAYS && mjd <= c[c.length - 1].mjd + SAME_VISIT_DAYS);
}

/**
 * What to stack for the visit on screen: the frame already shown stands for
 * its own visit, and the rest of the season is filled in nearest-first up to
 * `max`. Returned in date order.
 */
export function forStack(chunk, ref, max = STACK_MAX) {
  const others = chunk.filter((f) => Math.abs(f.mjd - ref.mjd) > SAME_VISIT_DAYS);
  const nearest = others.sort((a, b) => Math.abs(a.mjd - ref.mjd) - Math.abs(b.mjd - ref.mjd));
  return [ref, ...nearest.slice(0, Math.max(0, max - 1))].sort((a, b) => a.mjd - b.mjd);
}

/**
 * Add planes of the same grid, pixel by pixel, so that something present in
 * one visit only — a cosmic ray the pipeline missed, an asteroid crossing, a
 * scattered-light patch — does not survive into the sum:
 *   · four or more values: the single brightest is dropped, the rest averaged;
 *   · three: the middle one (a mean of three kept a one-visit artefact at a
 *     third of its brightness);
 *   · two or one: their mean, which is all two can give.
 * Masked pixels (NaN) are left out of their pixel's count.
 */
export function coadd(planes) {
  const len = planes[0]?.length ?? 0;
  const out = new Float32Array(len).fill(NaN);
  const n = planes.length;
  // The zodiacal background changes from visit to visit by more than the
  // noise. Left in, "drop the brightest" drops the visit with the brightest
  // sky at most pixels instead of the one with a cosmic ray, and the stack
  // gains less than it says. Each visit is put on the same sky level first.
  const levels = planes.map(planeMedian);
  // A plane with no valid pixel has no level; it must not pull the mean down.
  const known = levels.filter((v) => v != null);
  const level = known.reduce((s, v) => s + v, 0) / (known.length || 1);
  for (let p = 0; p < len; p++) {
    let m = 0;
    let sum = 0;
    let max = -Infinity;
    for (let k = 0; k < n; k++) {
      const v = planes[k][p] - levels[k];
      if (v === v) { m += 1; sum += v; if (v > max) max = v; }
    }
    if (!m) continue;
    if (m >= 4) out[p] = level + (sum - max) / (m - 1);
    else if (m === 3) out[p] = level + middleOfThree(planes, levels, p);
    else out[p] = level + sum / m;
  }
  return out;
}

/** The sky level of one visit: the median of its unmasked pixels. */
function planeMedian(plane) {
  const seen = plane.filter((v) => v === v);
  if (!seen.length) return null;
  seen.sort();
  return seen[seen.length >> 1];
}

/** The median of a pixel that has exactly three valid values. */
function middleOfThree(planes, levels, p) {
  const v = [];
  planes.forEach((plane, k) => { const x = plane[p] - levels[k]; if (x === x) v.push(x); });
  const [a, b, c] = v;
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/**
 * How many visits' worth of noise a stack of n beats down: n − 1 after the
 * dropped value; for three, the median, whose noise is about that of a mean
 * of two (its efficiency is 0.74 of three), counted conservatively as two.
 */
export const averaged = (n) => (n >= 4 ? n - 1 : n === 3 ? 2 : n);

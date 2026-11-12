/**
 * hunt.js — reading a distance out of how slowly something moves.
 *
 * This is the part of the tool that is actually about Planet X, and it rests on
 * one piece of geometry rather than on hope.
 *
 * Almost all of the apparent motion of a distant solar-system body is not the
 * body moving. It is the Earth moving, and the body sitting still while we swing
 * around the Sun — parallax. At opposition the body is d − 1 AU from us and
 * the Earth outruns it by its own orbital speed less the body's, 2π(1 − 1/√d)
 * AU a year, which comes to
 *
 *     rate ≈ 2π · 206265 / (d + √d)   arcseconds per year
 *
 * (d heliocentric, in AU). Far out the √d hardly matters; in the main belt it
 * is the difference between 34″ an hour and 55. It inverts to a distance, and
 * the numbers that fall out are the whole reason a survey like this can say
 * anything at all about where something lives:
 *
 *     main belt, 2.7 AU        ~34″ per hour
 *     Jupiter trojans, 5.2 AU  ~20″
 *     Neptune, 30 AU           ~4″
 *     Planet X, 400–800 AU     ~0.18–0.35″
 *
 * So speed sorts the solar system by depth, and "slow" is the signature worth
 * hunting. An asteroid streaks. A thing at six hundred astronomical units barely
 * crawls.
 *
 * Three honesties are built in.
 *
 * The relation holds at opposition. For a distant body that is where the
 * motion is fastest: anywhere else it appears slower, and slower reads as
 * farther, so the distance is an *upper bound* and the interface says "no
 * farther than". (An earlier version had it the other way round and called
 * (152) Atala, at 3 AU, "no nearer than 7 AU".)
 *
 * SPHEREx does not observe at opposition, though. It looks about 90° from the
 * Sun, where the Earth is moving along the line of sight and what is left is
 * the body's own orbital motion, 2π / d^1.5 radians a year. Inside 2.62 AU
 * that is the *faster* of the two, so the opposition formula alone put a body
 * at 2.2 AU "no farther than 1.9". The ceiling is therefore the larger of the
 * two distances the rate allows.
 *
 * A candidate a catalogue already knows is not a candidate — it is a known
 * asteroid, and the tool says which one.
 *
 * And a rate has to be distinguishable from zero before any distance is quoted
 * at all. Dividing by a measurement consistent with "not moving" produces
 * numbers like seventy thousand astronomical units, which is not a discovery
 * but a division by almost nothing. The test below is what stops it: the total
 * motion across the baseline must beat the scatter of the positions it was
 * fitted through.
 */

import { DETECTOR_ARCSEC } from './depth.js';

/** Earth's orbit, in arcseconds of parallax sweep per year, at 1 AU. */
const SWEEP_ARCSEC_PER_YEAR = 2 * Math.PI * 206265;
const HOURS_PER_YEAR = 365.25 * 24;

/**
 * The farthest an object could be and still move this fast: the larger of the
 * distance at which this would be the opposition rate and the distance at
 * which it would be the rate 90° from the Sun, where SPHEREx looks.
 *
 * Returns AU, or null for a rate too small to be meaningful — at some point the
 * measurement is consistent with "not moving at all", and inventing a distance
 * from that would be inventing a detection.
 */
export function distanceCeilingAU(arcsecPerHour) {
  if (!(arcsecPerHour > 0)) return null;
  const s = SWEEP_ARCSEC_PER_YEAR / (arcsecPerHour * HOURS_PER_YEAR);
  // At opposition: d + √d = s, solved for d.
  const root = (Math.sqrt(1 + 4 * s) - 1) / 2;
  const atOpposition = root * root;
  // At 90° from the Sun: d^1.5 = s.
  const atQuadrature = s ** (2 / 3);
  const au = Math.max(atOpposition, atQuadrature);
  return Number.isFinite(au) && au > 0 ? au : null;
}

/**
 * The inverse: the fastest a body at this distance moves in either geometry,
 * for stating what a given distance would look like.
 */
export const rateAtAU = (au) => SWEEP_ARCSEC_PER_YEAR
  / (Math.min(au + Math.sqrt(au), au ** 1.5) * HOURS_PER_YEAR);

/**
 * Did this thing actually move, or is the fitted slope inside its own noise?
 *
 * The straight-line fit always returns some slope. What makes it a measurement
 * is that the distance travelled across the whole baseline is larger than the
 * scatter of the positions the line was fitted through. Three times larger, here
 * — the same bar the rest of the tool uses before it calls anything a detection.
 */
export function rateIsMeasured(analysis, { k = 3, minPoints = 4 } = {}) {
  const spanHours = (analysis?.spanDays ?? 0) * 24;
  const rate = analysis?.ratePerHour ?? 0;
  const scatter = analysis?.rms ?? 0;
  if (!(spanHours > 0) || !(rate > 0)) return false;
  // Two points fit a straight line perfectly and three nearly so, which makes
  // the scatter zero and the significance test pass on nothing at all. A rate
  // needs enough detections that the line could have failed to fit.
  if ((analysis?.seen ?? 0) < minPoints) return false;
  // And the floor under the noise is the detector's own pixel, not the grid's.
  // Resampling finely does not create information: a body that crossed less
  // than one 6.15" pixel over the whole baseline has not been seen to move,
  // however small a slope the fit is willing to return.
  return rate * spanHours > k * Math.max(scatter, DETECTOR_ARCSEC);
}

/**
 * The slowest motion this baseline could have resolved, in arcsec per hour, and
 * therefore the furthest distance it can honestly speak about.
 */
export function reach(analysis, { k = 3 } = {}) {
  const spanHours = (analysis?.spanDays ?? 0) * 24;
  if (!(spanHours > 0)) return null;
  const slowest = (k * Math.max(analysis?.rms ?? 0, DETECTOR_ARCSEC)) / spanHours;
  return { slowestRate: slowest, furthestAU: distanceCeilingAU(slowest) };
}

/**
 * Where a rate puts something, in words a person can hold.
 *
 * The bands are the real neighbourhoods of the solar system, not decorative
 * tiers: the belt, the giants, the Kuiper belt, and the region beyond it where
 * the Planet X predictions live. The distance they are keyed on is a ceiling
 * (see distanceCeilingAU), so their words say "no farther than", and the
 * slowest band says what else a slow rate can be: a nearer body caught close
 * to a stationary point, where its motion on the sky turns round.
 */
export const NEIGHBOURHOODS = [
  { key: 'inner', maxAU: 6 },
  { key: 'giants', maxAU: 35 },
  { key: 'kuiper', maxAU: 120 },
  { key: 'far', maxAU: 2000 },
  { key: 'beyond', maxAU: Infinity },
];

export function neighbourhood(au) {
  if (au == null) return null;
  return NEIGHBOURHOODS.find((n) => au <= n.maxAU) ?? NEIGHBOURHOODS.at(-1);
}

/**
 * Rank what the field turned up as Planet X candidates.
 *
 * A candidate has to move — a fixed source is a star and a one-visit flash
 * cannot have a rate — and the ranking is by slowness, because that is the
 * quantity the search is actually about. Anything a catalogue recognises is
 * kept in the list but pushed below the unrecognised ones and labelled, since a
 * named asteroid is a good check that the machinery works and a bad candidate.
 */
export function rankCandidates(found, { maxArcsecPerHour = 60 } = {}) {
  return found
    .filter((c) => c.analysis?.kind === 'moving')
    // Not "did the fit return a slope" but "is that slope a measurement".
    .filter((c) => rateIsMeasured(c.analysis))
    .filter((c) => c.analysis.ratePerHour <= maxArcsecPerHour)
    .map((c) => {
      const au = distanceCeilingAU(c.analysis.ratePerHour);
      return { ...c, au, where: neighbourhood(au) };
    })
    .sort((a, b) => {
      // Unknown first, then slowest first: both halves of "worth a second look".
      if (Boolean(a.known) !== Boolean(b.known)) return a.known ? 1 : -1;
      return a.analysis.ratePerHour - b.analysis.ratePerHour;
    });
}

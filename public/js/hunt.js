/**
 * hunt.js — reading a distance out of how slowly something moves.
 *
 * This is the part of the tool that is actually about Planet X, and it rests on
 * one piece of geometry rather than on hope.
 *
 * Almost all of the apparent motion of a distant solar-system body is not the
 * body moving. It is the Earth moving, and the body sitting still while we swing
 * around the Sun — parallax. Near opposition the Earth's 1 AU orbit sweeps a
 * body at distance d across the sky at roughly
 *
 *     rate ≈ 2π · 206265 / d   arcseconds per year
 *
 * which inverts to a distance. The numbers that falls out are the whole reason
 * a survey like this can say anything at all about where something lives:
 *
 *     main belt, 2.7 AU     ~55″ per hour
 *     Jupiter trojans, 5 AU ~30″
 *     Neptune, 30 AU        ~5″
 *     Sedna near 500 AU     ~0.3″
 *     Planet X, 400–800 AU  ~0.2–0.4″
 *
 * So speed sorts the solar system by depth, and "slow" is the signature worth
 * hunting. An asteroid streaks. A thing at six hundred astronomical units barely
 * crawls.
 *
 * Three honesties are built in.
 *
 * The relation holds near opposition; away from it the same body appears slower,
 * so a measured rate gives a *lower bound* on distance and the interface says
 * "no nearer than".
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
 * The closest an object could be and still crawl this slowly.
 *
 * Returns AU, or null for a rate too small to be meaningful — at some point the
 * measurement is consistent with "not moving at all", and inventing a distance
 * from that would be inventing a detection.
 */
export function distanceFloorAU(arcsecPerHour) {
  if (!(arcsecPerHour > 0)) return null;
  const perYear = arcsecPerHour * HOURS_PER_YEAR;
  const au = SWEEP_ARCSEC_PER_YEAR / perYear;
  return Number.isFinite(au) && au > 0 ? au : null;
}

/** The inverse, for stating what a given distance would look like. */
export const rateAtAU = (au) => SWEEP_ARCSEC_PER_YEAR / (au * HOURS_PER_YEAR);

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
  return { slowestRate: slowest, furthestAU: distanceFloorAU(slowest) };
}

/**
 * Where a rate puts something, in words a person can hold.
 *
 * The bands are the real neighbourhoods of the solar system, not decorative
 * tiers: the belt, the giants, the Kuiper belt, and the region beyond it where
 * the Planet X predictions live.
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
      const au = distanceFloorAU(c.analysis.ratePerHour);
      return { ...c, au, where: neighbourhood(au) };
    })
    .sort((a, b) => {
      // Unknown first, then slowest first: both halves of "worth a second look".
      if (Boolean(a.known) !== Boolean(b.known)) return a.known ? 1 : -1;
      return a.analysis.ratePerHour - b.analysis.ratePerHour;
    });
}

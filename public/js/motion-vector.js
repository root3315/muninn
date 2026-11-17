/**
 * motion-vector.js — a catalogued proper motion, drawn magnified.
 *
 * WISE 0855−0714 moves 8.1″ a year and Barnard's Star 10.4″; a SPHEREx pixel
 * is 6.15″. Over the year the visits span, either moves about a pixel, and the
 * blink alone shows next to nothing. So the field gets a drawing of the
 * catalogue's motion, scaled up by a round factor and saying so: an arrow for
 * one year, and a tick on it for the date of each visit.
 *
 * It is the catalogue's motion, not a measurement made on these frames, and
 * it is drawn as a note (dashed, in the accent) rather than as data. Every
 * position is the target's own, carried by propagate(); only the distance
 * from the first visit's position is multiplied.
 *
 * Nothing here touches the page: positions go in, grid indices come out.
 */

import { epochOfMjd, propagate, properMotion } from './overlay.js';

/** Below this, in arcsec a year, a motion is not drawn: even ×1000 it is a few pixels. */
export const MIN_MOTION_ARCSEC = 0.1;

/** The factors an arrow may be magnified by, smallest first. */
export const FACTORS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/** Whether a target carries a motion worth drawing. */
export function hasMotion(target) {
  const pm = target ? properMotion(target) : null;
  return pm != null && pm >= MIN_MOTION_ARCSEC && Number.isFinite(target.ra) && Number.isFinite(target.dec);
}

/**
 * The largest round factor that keeps one year of motion within `wantPx` on
 * screen, so the arrow stays on the plate. A motion already longer is drawn
 * as it is, at ×1.
 */
export function pickFactor(pxPerYear, wantPx) {
  if (!(pxPerYear > 0) || !(wantPx > 0)) return null;
  return FACTORS.findLast((f) => pxPerYear * f <= wantPx) ?? 1;
}

/**
 * The drawing in grid indices: where the target was at the first visit
 * (`anchor`), the end of one year of motion magnified by `factor` (`head`),
 * and a tick per visit at its date, magnified the same way. `toIndex(ra, dec)`
 * is the plate's projection (TangentGrid.worldToIndex). Null when there is no
 * motion to draw, no visit, or the target is off the projection.
 *
 * The one-year step is measured on the plate itself, so the arrow points the
 * way the star moves across this picture whatever its orientation.
 */
export function motionVector(target, mjds, toIndex, factor) {
  if (!hasMotion(target) || !(factor > 0)) return null;
  const dates = mjds.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!dates.length) return null;
  const from = Number.isFinite(target.epoch) ? target.epoch : 2000;
  const at = (year) => {
    const p = propagate(target, year, from);
    return toIndex(p.ra, p.dec);
  };
  const first = epochOfMjd(dates[0]);
  const anchor = at(first);
  const year = at(first + 1);
  if (!anchor || !year) return null;
  const scaled = (p) => [anchor[0] + (p[0] - anchor[0]) * factor, anchor[1] + (p[1] - anchor[1]) * factor];
  const ticks = [];
  for (const mjd of dates) {
    const p = at(epochOfMjd(mjd));
    if (p) ticks.push({ mjd, at: scaled(p) });
  }
  return {
    anchor,
    head: scaled(year),
    ticks,
    factor,
    perYear: Math.hypot(year[0] - anchor[0], year[1] - anchor[1]),
    arcsecPerYear: properMotion(target),
  };
}

/**
 * motionVector at the factor that makes the arrow at most `wantPx` long, for a
 * plate drawn at `pxPerIndex` screen pixels to a grid sample.
 */
export function fitMotion(target, mjds, toIndex, pxPerIndex, wantPx) {
  const unit = motionVector(target, mjds, toIndex, 1);
  const factor = unit && pickFactor(unit.perYear * pxPerIndex, wantPx);
  return factor ? motionVector(target, mjds, toIndex, factor) : null;
}

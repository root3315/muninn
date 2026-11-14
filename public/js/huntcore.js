/**
 * huntcore.js — the search Hunter X runs over a field, without the page.
 *
 * The sector matrix has already said which cells stopped looking like
 * themselves. This takes the brightest pixel of each of those cells, asks the
 * same photometry the marks use what is at that sky position in every visit,
 * and keeps whatever turns out to be moving.
 *
 * It lives apart from the page so that the benchmark which injects movers into
 * real frames (tools/hunter-benchmark.mjs) runs the very code the page runs,
 * and not a copy of it.
 */

import { standouts, peakIndex, sectorBounds } from './sectors.js';
import { rankCandidates } from './hunt.js';
import { tooSharp } from './sharpness.js';
import { deltaRA } from './wcs.js';

/** How many of the matrix's standouts are followed up, strongest first. */
export const HUNT_STANDOUTS = 12;
/** The same peak found in two neighbouring cells closer than this is one object. */
export const SAME_PEAK_ARCSEC = 30;

/**
 * What stood out in one visit and is gone in the rest.
 *
 * The hunt ranks movers, and a mover needs positions in several visits to have
 * a rate. A main-belt asteroid never gives it that: at twenty arcsec an hour it
 * crosses the field in hours, and SPHEREx comes back days later. It shows up as
 * a bright spot in exactly one visit — which is what the Atala field is for —
 * and the hunt used to answer "nothing moved" over the top of it. These are
 * kept as a list of their own and checked against SkyBoT for that one visit.
 *
 * "One visit" allows a second, weaker detection, because a star or a noise
 * peak inside the measuring box in another visit is common; more than a fifth
 * of the visits and it is something that sits there and flickers, not a flash.
 */
export function flashesOf(seen) {
  return seen
    .filter((c) => {
      const a = c.analysis;
      if (a?.kind === 'transient') return true;
      return a?.kind === 'intermittent' && a.seen <= Math.max(2, Math.round(a.total * 0.2));
    })
    .map((c) => {
      // Where it was in the visit it stood out in, measured, not the peak cell.
      const at = c.analysis.track.find((p) => p.obsId === c.obsId) ?? { ra: c.ra, dec: c.dec };
      return { ...c, at };
    });
}

/**
 * Search one field.
 *
 *   sectors  — scoreSectors() over `visits`
 *   visits   — the visits the scores were taken over, in the same order
 *   grid     — the TangentGrid the stamps are cut on
 *   track    — (ra, dec) => the analysis SkyView.trackMark returns
 *   dec      — the field centre's declination, for the same-peak test
 *   pause    — optional; awaited after each candidate, and a `false` from it
 *              abandons the search (returns null)
 *
 * Returns `{ checked, all, list, flashes, used }`: every standout followed up,
 * the ranked movers, and the one-visit flashes.
 */
export async function searchField({ sectors, visits, grid, track, dec, pause }) {
  const hits = standouts(sectors, { minScore: 4, limit: HUNT_STANDOUTS });
  const seen = [];
  const cos = Math.cos((dec * Math.PI) / 180);

  for (const hit of hits) {
    const visit = visits[hit.visit];
    if (!visit) continue;
    const at = peakIndex(
      visit.stamp.data, visit.stamp.width, visit.stamp.height, sectorBounds(hit.sector),
    );
    if (!at) continue;
    const world = grid.indexToWorld(at[0], at[1]);
    if (!world) continue;
    const [ra, de] = world;
    if (seen.some((c) => Math.hypot(deltaRA(c.ra, ra) * cos, c.dec - de) * 3600 < SAME_PEAK_ARCSEC)) continue;

    const analysis = track(ra, de);
    // The detection that made it stand out: one pixel's worth of light there
    // is a particle hit or a hot pixel, and no candidate.
    const standout = analysis.track.find((p) => p.obsId === visit.frame.obsId);
    seen.push({
      ra, dec: de, sector: hit.sector, visit: hit.visit, obsId: visit.frame.obsId, analysis,
      tooSharp: tooSharp(standout?.sharp),
    });
    if (pause && (await pause()) === false) return null;
  }

  return {
    checked: hits.length, all: seen, list: rankCandidates(seen), flashes: flashesOf(seen), used: visits.length,
  };
}

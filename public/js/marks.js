/**
 * marks.js — what a mark is, worked out the same way wherever it is made: on
 * the site's plate or on the headset's screen. The season link's measurement
 * and a mark's one-word verdict, moved here from app.js unchanged so both
 * pages use one code.
 */

import { DETECTOR_ARCSEC, limitAB } from './depth.js';
import { tooSharp } from './sharpness.js';
import { linkSeasons, separationArcsec } from './seasons.js';
import { mostlySaturated } from './sky.js';
import { chunkAt, forStack } from './stack.js';

/**
 * Which seasons a mark is followed between: its own (A) and the one nearest
 * in time (B; SPHEREx comes back about half a year later), and the frames of
 * each to read, a stack's worth. `chunks` are the band's seasons
 * (stack.js seasonChunks), `ref` the frame the mark was made on, `visits`
 * those already read. Null when the band has one season only.
 */
export function planLink(chunks, ref, visits) {
  const a = chunkAt(chunks, ref.mjd);
  const others = chunks.map((c, k) => ({ c, k })).filter(({ k }) => k !== a);
  if (a < 0 || !others.length) return null;
  const mid = (c) => (c[0].mjd + c[c.length - 1].mjd) / 2;
  const b = others.sort((x, y) => Math.abs(mid(x.c) - ref.mjd) - Math.abs(mid(y.c) - ref.mjd))[0].k;
  const loadedB = visits.find((v) => v.frame.band === ref.band && chunkAt(chunks, v.frame.mjd) === b);
  return {
    loadedB,
    framesA: forStack(chunks[a], ref),
    framesB: forStack(chunks[b], loadedB?.frame ?? chunks[b][Math.floor(chunks[b].length / 2)]),
  };
}

/** The i18n key of each kind of mark (sky.js trackMark). */
export const CALL = {
  none: 'mark.callNone',
  transient: 'mark.callTransient',
  moving: 'mark.callMoving',
  fixed: 'mark.callFixed',
  saturated: 'mark.callSaturated',
  intermittent: 'mark.callIntermittent',
};

/** The shape reading of a mark's strongest detection, when it was seen at most twice. */
export function shapeOf(a) {
  if (!a?.track?.length || a.seen > 2) return null;
  const at = a.kind === 'transient' ? a.at : a.track.reduce((b, p) => ((p.snr ?? 0) > (b.snr ?? 0) ? p : b));
  return at?.sharp ?? null;
}

/** A mark's verdict in a word, in the page's language (`t` from i18n.js). */
export const markCall = (a, t) => (tooSharp(shapeOf(a)) ? t('sharp.call') : t(CALL[a?.kind ?? 'none'] ?? CALL.none));

/**
 * The measurement half of the season link: the mark anchored in season A,
 * the sources of season B, the static check, the decision (seasons.js
 * linkSeasons), on `sky`'s plate. `breathe` yields between visits.
 */
export async function measureLink(sky, m, visitsA, visitsB, { breathe = async () => {} } = {}) {
  // Where the mark is in season A, measured: the strongest detection of it.
  let anchorHit = null;
  const hitsA = [];
  for (const v of visitsA) {
    const hit = sky.measure(v, m.ra, m.dec);
    if (hit) hitsA.push(hit);
    if (hit && (!anchorHit || hit.snr > anchorHit.snr)) anchorHit = hit;
  }
  const refMjd = visitsA.find((v) => v.frame.obsId === m.obsId)?.frame.mjd ?? visitsA[0].frame.mjd;
  const anchor = anchorHit
    ? { ra: anchorHit.ra, dec: anchorHit.dec, mjd: anchorHit.mjd }
    : { ra: m.ra, dec: m.dec, mjd: refMjd };

  const sourcesOf = new Map();
  for (const v of visitsB) {
    sourcesOf.set(v.frame.obsId, sky.sources(v));
    await breathe();
  }
  // Inside the plate by the measuring box's own reach, so every point called
  // checkable could actually be measured.
  const perPixel = DETECTOR_ARCSEC / (sky.grid.scale * 3600);
  const margin = Math.ceil(5 * perPixel) + 1;
  const { width, height } = sky.grid;
  const inField = (ra, dec) => {
    const g = sky.grid.worldToIndex(ra, dec);
    return Boolean(g) && g[0] >= margin && g[1] >= margin && g[0] <= width - 1 - margin && g[1] <= height - 1 - margin;
  };
  // Something at the spot in season A, even at 3σ, makes it a fixed source.
  const occupied = (v, ra, dec) => {
    const hit = sky.measure(v.item, ra, dec, { minSnr: 3 });
    return Boolean(hit) && separationArcsec(hit, { ra, dec }) <= 1.5 * DETECTOR_ARCSEC;
  };
  const asVisit = (v) => ({ id: v.frame.obsId, mjd: v.frame.mjd, item: v });
  // The source at the mark, still at the same spot in a season-B visit.
  const anchorInB = (v) => {
    const hit = sky.measure(v.item, anchor.ra, anchor.dec);
    return Boolean(hit) && separationArcsec(hit, anchor) <= 1.5 * DETECTOR_ARCSEC;
  };
  const result = linkSeasons({
    anchor,
    aVisits: visitsA.map(asVisit),
    bVisits: visitsB.map(asVisit),
    sources: (v) => sourcesOf.get(v.id) ?? [],
    occupied,
    inField,
    anchorInB: anchorHit ? anchorInB : undefined,
    anchorSaturated: mostlySaturated(hitsA),
    pixelArcsec: DETECTOR_ARCSEC,
  });
  // A source at the mark that is still there in season B sits still: a star.
  const stillThere = result.star?.stillThere
    ?? (anchorHit ? visitsB.filter((v) => anchorInB(asVisit(v))).length : 0);
  const limits = visitsB.map((v) => limitAB(v.stamp.meta?.detectorSigma)).filter((x) => x != null).sort((x, y) => x - y);
  return {
    anchor,
    anchored: Boolean(anchorHit),
    stillThere,
    result,
    limit: limits.length ? limits[limits.length >> 1] : null,
    datesA: [visitsA[0].frame, visitsA[visitsA.length - 1].frame],
    visitsB: visitsB.map((v) => v.frame),
  };
}

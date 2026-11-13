/**
 * seasons.js — following a still-looking source from one season to the next.
 *
 * Inside one season (about eleven days) a body at 400–800 AU drifts less than
 * the three-pixel floor Hunter X needs, so it reads as fixed. Half a year later
 * it has jumped 8–17′, almost all of it the Earth's parallax: the Earth has
 * crossed to the other side of the Sun, up to 2 AU from where it was, and a body
 * d AU away appears displaced by about 2/d radians. Where it lands depends on d
 * alone, so a position in one season and a trial distance predict a position in
 * the next — the "parallax arc", one point per distance.
 *
 * Geometry. The line of sight at the season-A moment is taken from the Earth
 * (ephemeris.js, the Earth–Moon barycentre). SPHEREx is in a low orbit about
 * 7000 km from the Earth's centre; seen from 30 AU that baseline is 0.3″ and
 * from farther less, a twentieth of a 6.15″ detector pixel, so the Earth will do.
 * The body is put on that line at heliocentric distance d and looked at again
 * from where the Earth is at each season-B visit.
 *
 * The body's own orbit is not neglected, because it cannot be. On a circular
 * orbit it moves 2π/√d AU a year; over half a year that is π/d^1.5 radians as
 * seen from the Sun: 58″ (9.4 detector pixels) at 500 AU, 125″ at 300, 3940″
 * at 30. Keeping that under one pixel would mean d ≳ 2230 AU, which is past the
 * whole range worth searching. Against the parallax jump itself it is a fixed
 * fraction, π/(2√d): 29% at 30 AU, 16% at 100, 9% at 300, 7% at 500, 3.5% at
 * 2000. Its direction is unknown, so it is carried as what it is: a disc of that
 * radius around each arc point, inside which the body may land. A match is
 * anything in the disc (plus a pixel for the astrometry), and the distance
 * quoted is the range of trial distances whose disc holds the detection. That
 * is why a link reads "d ≈ 300 AU (280–330)" and never "d = 300". A body on an
 * eccentric orbit near perihelion could move up to √2 faster than circular;
 * the Planet X hypotheses put it near aphelion, where it moves slower.
 *
 * Nothing here touches pixels. The page hands in what it measured — sources in
 * the season-B visits, and whether a spot is occupied in season A — so the
 * whole decision can be tested against a made-up sky.
 */

import { heliocentric } from './ephemeris.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const ARCSEC = 1 / 206264.806;
const OBLIQUITY = 23.43928 * D2R;
const DAYS_PER_YEAR = 365.25;

/** The trial distances, AU, and how finely the search walks between them. */
export const NEAR_AU = 30;
export const FAR_AU = 2000;
/** Round distances the arc is labelled at. */
export const ARC_TICKS_AU = [50, 100, 200, 500, 1000];

/** A log-spaced list of distances from near to far, both included. */
export function distanceGrid({ near = NEAR_AU, far = FAR_AU, steps = 60 } = {}) {
  const k = Math.log(far / near) / (steps - 1);
  return Array.from({ length: steps }, (_, i) => near * Math.exp(k * i));
}

/**
 * The Earth's heliocentric position, J2000 ecliptic, AU, at an MJD. A search
 * asks for the same few moments thousands of times, so the last few are kept.
 */
const earthCache = new Map();
export function earthAt(mjd) {
  let e = earthCache.get(mjd);
  if (!e) {
    e = heliocentric('earth', (mjd - 51544.5) / 36525);
    if (earthCache.size > 64) earthCache.clear();
    earthCache.set(mjd, e);
  }
  return e;
}

/** RA/Dec (degrees) as a unit vector in the ecliptic frame. */
function eclipticUnit(ra, dec) {
  const a = ra * D2R;
  const d = dec * D2R;
  const x = Math.cos(d) * Math.cos(a);
  const y = Math.cos(d) * Math.sin(a);
  const z = Math.sin(d);
  return [x, y * Math.cos(OBLIQUITY) + z * Math.sin(OBLIQUITY), -y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY)];
}

/** An ecliptic vector as RA/Dec in degrees, and its length. */
function toRaDec([x, y, z]) {
  const ye = y * Math.cos(OBLIQUITY) - z * Math.sin(OBLIQUITY);
  const ze = y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY);
  const r = Math.hypot(x, ye, ze);
  return { ra: ((Math.atan2(ye, x) * R2D) % 360 + 360) % 360, dec: Math.asin(ze / r) * R2D, rho: r };
}

/**
 * Where a body is if it was seen at (ra, dec) at mjdA and lies d AU from the
 * Sun: heliocentric ecliptic xyz, AU, and its distance from the Earth then.
 * Null when d is inside the Earth's own distance along that line.
 */
export function placeBody(ra, dec, mjdA, d) {
  const e = earthAt(mjdA);
  const n = eclipticUnit(ra, dec);
  const en = e[0] * n[0] + e[1] * n[1] + e[2] * n[2];
  const disc = en * en - (e[0] ** 2 + e[1] ** 2 + e[2] ** 2) + d * d;
  if (!(disc >= 0)) return null;
  const rho = -en + Math.sqrt(disc);
  if (!(rho > 0)) return null;
  return { xyz: [e[0] + rho * n[0], e[1] + rho * n[1], e[2] + rho * n[2]], rho };
}

/** A heliocentric point seen from the Earth at an MJD. */
export function seenFrom(xyz, mjd) {
  const e = earthAt(mjd);
  return toRaDec([xyz[0] - e[0], xyz[1] - e[1], xyz[2] - e[2]]);
}

/**
 * The radius, arcsec, inside which a body's own orbit can have carried it in
 * `days`: circular speed 2π/√d AU a year, seen from rho AU.
 */
export function ownMotionArcsec(d, days, rho = d) {
  const au = (2 * Math.PI / Math.sqrt(d)) * (Math.abs(days) / DAYS_PER_YEAR);
  return (au / rho) / ARCSEC;
}

/** Separation of two sky positions, arcsec. */
export function separationArcsec(a, b) {
  const da = (b.ra - a.ra) * D2R;
  const s = Math.sin((b.dec - a.dec) * D2R / 2) ** 2
    + Math.cos(a.dec * D2R) * Math.cos(b.dec * D2R) * Math.sin(da / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / ARCSEC;
}

/**
 * One point of the arc: where a body seen at (ra, dec) at mjdA, d AU from the
 * Sun, appears at mjdB if it had stood still — and how far its own orbit could
 * have moved it from there (`wobble`, arcsec).
 */
export function arcPoint(ra, dec, mjdA, mjdB, d) {
  const body = placeBody(ra, dec, mjdA, d);
  if (!body) return null;
  const seen = seenFrom(body.xyz, mjdB);
  return { d, ra: seen.ra, dec: seen.dec, rho: seen.rho, wobble: ownMotionArcsec(d, mjdB - mjdA, seen.rho) };
}

/** The arc through a list of distances. */
export function parallaxArc(ra, dec, mjdA, mjdB, distances = distanceGrid()) {
  return distances.map((d) => arcPoint(ra, dec, mjdA, mjdB, d)).filter(Boolean);
}

/**
 * The search walks the arc evenly in 1/d, which is evenly along the sky: the
 * parallax goes as 1/d. Two thousand steps from 30 to 2000 AU put neighbours a
 * few arcseconds apart even at the near end, where they are farthest apart.
 */
const DENSE_STEPS = 2000;
function denseDistances(near, far, steps = DENSE_STEPS) {
  const u0 = 1 / far;
  const u1 = 1 / near;
  return Array.from({ length: steps }, (_, i) => 1 / (u0 + ((u1 - u0) * i) / (steps - 1)));
}

/**
 * Link a position seen in season A to season B.
 *
 *   anchor     { ra, dec, mjd } — where it was, and when, in season A
 *   aVisits    [{ id, mjd }] — season A's visits, for the static check
 *   bVisits    [{ id, mjd }] — season B's visits, measured
 *   sources    (bVisit) → [{ ra, dec, snr, mag }] — what stands ≥ 5σ in it
 *   occupied   (aVisit, ra, dec) → boolean — is something there in season A
 *   inField    (ra, dec) → boolean — can this position be measured at all
 *   anchorInB  (bVisit) → boolean — is the season-A source still at the anchor
 *   anchorSaturated  the season-A source saturated the detector
 *
 * First, the anchor itself. A source still at the same spot in at least half
 * of season B's visits sits still: at 2000 AU the parallax over half a year
 * is still a hundred arcseconds, so nothing that stays inside a pixel and a
 * half is a body in the outer solar system. Nor is a source that saturates
 * the detector: nothing out there is that bright. Either way the answer is a
 * star, and no detection on the arc is offered as its next position.
 *
 * A detection on the arc counts only if the same spot is empty in every
 * season-A visit: a star there in both seasons is a star. With two or more
 * season-B visits, a link needs the same trial distance to fit detections in
 * at least two of them, and those detections to have moved between the two
 * visits as the arc says, within a pixel and the body's own motion.
 */
export function linkSeasons({
  anchor, aVisits, bVisits, sources, occupied, inField,
  anchorInB = () => false, anchorSaturated = false,
  near = NEAR_AU, far = FAR_AU, pixelArcsec = 6.15,
}) {
  const ds = denseDistances(near, far);
  const need = Math.min(2, bVisits.length);
  const stillThere = bVisits.filter((v) => anchorInB(v)).length;
  if (anchorSaturated || (stillThere > 0 && 2 * stillThere >= bVisits.length)) {
    return {
      need, covered: null, checked: bVisits.length, staticCount: 0, link: null,
      star: { stillThere, saturated: Boolean(anchorSaturated) },
    };
  }

  // Each season-B visit's own arc, and which of its points the field holds.
  const arcs = bVisits.map((visit) => {
    const points = ds.map((d) => arcPoint(anchor.ra, anchor.dec, anchor.mjd, visit.mjd, d));
    const inside = points.map((p) => Boolean(p) && inField(p.ra, p.dec));
    return { visit, points, inside };
  });

  // The distances that can be checked: those whose arc point is on the field
  // in enough season-B visits to make a link.
  const checkable = ds.map((_, k) => arcs.filter((a) => a.inside[k]).length >= need);
  const covered = rangeOf(ds, checkable);

  let staticCount = 0;
  const hits = [];
  arcs.forEach((arc, b) => {
    if (!arc.inside.some(Boolean)) return;
    for (const s of sources(arc.visit)) {
      // Which trial distances put this detection inside their disc.
      let best = -1;
      let bestSep = Infinity;
      const fits = arc.points.map((p, k) => {
        if (!p || !arc.inside[k]) return false;
        const sep = separationArcsec(p, s);
        if (sep < bestSep) { bestSep = sep; best = k; }
        return sep <= p.wobble + pixelArcsec;
      });
      if (best < 0 || !fits.some(Boolean)) continue;
      if (aVisits.some((v) => occupied(v, s.ra, s.dec))) { staticCount += 1; continue; }
      hits.push({ b, source: s, fits, best, sep: bestSep });
    }
  });

  // Group detections that one body at one distance explains.
  const links = [];
  for (const h of hits) {
    const group = [h];
    for (const o of hits) {
      if (o.b === h.b || group.some((g) => g.b === o.b)) continue;
      const common = h.fits.map((f, k) => f && o.fits[k]);
      if (!common.some(Boolean) || !sameBody(h, o, common, arcs, ds, pixelArcsec)) continue;
      group.push(o);
    }
    if (group.length < need) continue;
    const common = ds.map((_, k) => group.every((g) => g.fits[k]));
    if (!common.some(Boolean)) continue;
    links.push(summarise(group, common, arcs, ds));
  }
  links.sort((x, y) => (y.visits.length - x.visits.length) || (y.snr - x.snr));

  return {
    need,
    covered,
    checked: bVisits.length,
    staticCount,
    link: links[0] ?? null,
    star: null,
  };
}

/**
 * Two detections, in two season-B visits, of one body at some common trial
 * distance: the step between them is the arc's step between those two moments,
 * give or take a pixel and what its own orbit does in between.
 */
function sameBody(h, o, common, arcs, ds, pixelArcsec) {
  const tH = arcs[h.b].visit.mjd;
  const tO = arcs[o.b].visit.mjd;
  for (let k = 0; k < ds.length; k++) {
    if (!common[k]) continue;
    const pH = arcs[h.b].points[k];
    const pO = arcs[o.b].points[k];
    const cos = Math.cos(pH.dec * D2R);
    const want = [((pO.ra - pH.ra + 540) % 360 - 180) * cos * 3600, (pO.dec - pH.dec) * 3600];
    const got = [((o.source.ra - h.source.ra + 540) % 360 - 180) * cos * 3600, (o.source.dec - h.source.dec) * 3600];
    const off = Math.hypot(got[0] - want[0], got[1] - want[1]);
    if (off <= pixelArcsec + ownMotionArcsec(ds[k], tO - tH, pH.rho)) return true;
  }
  return false;
}

/** A link as the page reports it: the distance, its range, and the detections. */
function summarise(group, common, arcs, ds) {
  // The distance that sits closest to every detection at once.
  let best = -1;
  let bestCost = Infinity;
  ds.forEach((d, k) => {
    if (!common[k]) return;
    const cost = group.reduce((s, g) => s + separationArcsec(arcs[g.b].points[k], g.source), 0);
    if (cost < bestCost) { bestCost = cost; best = k; }
  });
  const range = rangeOf(ds, common);
  const mags = group.map((g) => g.source.mag).filter((m) => m != null);
  return {
    d: ds[best],
    near: range.near,
    far: range.far,
    mag: mags.length ? mags.reduce((s, m) => s + m, 0) / mags.length : null,
    snr: group.reduce((s, g) => s + (g.source.snr ?? 0), 0),
    visits: group
      .map((g) => ({ ...arcs[g.b].visit, at: g.source, arc: arcs[g.b].points[best] }))
      .sort((x, y) => x.mjd - y.mjd),
  };
}

/** The nearest and farthest distance a mask allows. */
function rangeOf(ds, mask) {
  let lo = Infinity;
  let hi = -Infinity;
  ds.forEach((d, k) => { if (mask[k]) { lo = Math.min(lo, d); hi = Math.max(hi, d); } });
  return lo <= hi ? { near: lo, far: hi } : null;
}

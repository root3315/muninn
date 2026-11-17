/**
 * orbits.js — what goes round what, for the flight: other stars' planets on
 * their measured ellipses, the habitable zone round a star, which Hipparcos
 * star each planet host is, and a star's own drift across the sky.
 *
 * Pure functions of their arguments, no page: the tests ask them directly.
 */

const D2R = Math.PI / 180;
const T_SUN = 5772;
/** Milliarcseconds to radians. */
const MAS = D2R / 3.6e6;

/* ---- an orbit round another star -------------------------------------- */

/**
 * Kepler's equation, M = E − e sin E, solved by Newton for the eccentric
 * anomaly; radians.
 */
export function eccentricAnomaly(M, e) {
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 30; k++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

const trueFromEccentric = (E, e) => 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
const eccentricFromTrue = (f, e) => 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(f / 2), Math.sqrt(1 + e) * Math.cos(f / 2));

/**
 * A planet's orbit as the Archive gives it, with what it lacks said:
 * { a (AU), e, w (rad), i (rad), eKnown, wKnown, iKnown }. No eccentricity
 * is a circle; no inclination is edge-on to the Sun, as a transit has it and
 * a radial-velocity orbit may or may not; no argument of periastron with an
 * eccentricity puts the periastron on the far side, a guess the card names.
 */
export function orbitOf(pl) {
  const eKnown = Number.isFinite(pl.e);
  const e = eKnown ? Math.min(Math.max(pl.e, 0), 0.97) : 0;
  const wKnown = Number.isFinite(pl.w);
  const iKnown = Number.isFinite(pl.i);
  return {
    a: pl.a,
    e,
    w: (wKnown ? pl.w : 90) * D2R,
    i: (iKnown ? pl.i : 90) * D2R,
    eKnown, wKnown, iKnown,
  };
}

/**
 * The offset from its star of a planet at true anomaly f, in the star's sky
 * frame: `node` and `up` across the sky, `toSun` along the line of sight
 * towards the Sun (the observer). Winn (2010)'s convention: the orbit's line
 * of nodes along `node` (where it really lies on the sky is not measured, so
 * one direction is taken for all), and the planet nearest the Sun, at
 * conjunction, where ω + f = 90°. Into `out`, AU.
 */
export function offsetAt(orbit, f, { node, up, toSun }, out = [0, 0, 0]) {
  const { a, e, w, i } = orbit;
  const r = (a * (1 - e * e)) / (1 + e * Math.cos(f));
  const u = w + f;
  const x = r * Math.cos(u);
  const y = r * Math.sin(u) * Math.cos(i);
  const z = r * Math.sin(u) * Math.sin(i);
  for (let k = 0; k < 3; k++) out[k] = node[k] * x + up[k] * y + toSun[k] * z;
  return out;
}

/**
 * The true anomaly at Julian date `jd` of a planet that was at conjunction
 * (transit, or the time of conjunction of a radial-velocity orbit) at `tc`,
 * with period `p` days; null with no such time.
 */
export function anomalyAt(orbit, tc, p, jd) {
  if (!Number.isFinite(tc) || !(p > 0)) return null;
  const { e, w } = orbit;
  const fc = Math.PI / 2 - w;
  const Ec = eccentricFromTrue(fc, e);
  const Mc = Ec - e * Math.sin(Ec);
  const turns = (jd - tc) / p;
  const M = Mc + 2 * Math.PI * (turns - Math.floor(turns));
  return trueFromEccentric(eccentricAnomaly(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), e), e);
}

/**
 * The whole ellipse as segment ends, `steps` to a turn, parsecs: `centre`
 * plus each offset times `scale` (AU to parsecs). Even steps in eccentric
 * anomaly, so a long ellipse keeps its points where it bends.
 */
export function ellipseEnds(orbit, frame, centre, scale, steps = 128, into = new Float64Array(steps * 6)) {
  const p = [0, 0, 0];
  let o = 0;
  const { e } = orbit;
  for (let k = 0; k < steps; k++) {
    for (const s of [k, k + 1]) {
      offsetAt(orbit, trueFromEccentric((s / steps) * 2 * Math.PI, e), frame, p);
      into[o++] = centre[0] + p[0] * scale;
      into[o++] = centre[1] + p[1] * scale;
      into[o++] = centre[2] + p[2] * scale;
    }
  }
  return into;
}

/**
 * The frame of a star's sky, seen from the Sun: `toSun` from the star to the
 * Sun, `node` across the sky as near east as can be, `up` the third, as near
 * celestial north. `c` is the star's place, parsecs.
 */
export function skyFrame(c) {
  const d = Math.hypot(c[0], c[1], c[2]) || 1;
  const toSun = [-c[0] / d, -c[1] / d, -c[2] / d];
  let node = [toSun[1], -toSun[0], 0];
  if (Math.hypot(node[0], node[1]) < 1e-9) node = [0, toSun[2], -toSun[1]];
  const l = Math.hypot(node[0], node[1], node[2]);
  node = node.map((x) => x / l);
  const up = [
    node[1] * toSun[2] - node[2] * toSun[1],
    node[2] * toSun[0] - node[0] * toSun[2],
    node[0] * toSun[1] - node[1] * toSun[0],
  ];
  return { toSun, node, up };
}

/* ---- the habitable zone ------------------------------------------------ */

/**
 * Kopparapu et al. (2013), "Habitable Zones around Main-sequence Stars: New
 * Estimates", ApJ 765, 131, with its erratum (ApJ 770, 82, Table 3, the
 * coefficients as corrected): the flux at each limit is
 * S = S☉ + a·T + b·T² + c·T³ + d·T⁴, T = Teff − 5780 K, fitted for
 * 2600 ≤ Teff ≤ 7200 K. Conservative: runaway greenhouse inside, maximum
 * greenhouse outside. Optimistic: recent Venus inside, early Mars outside.
 */
export const HZ_LIMITS = {
  recentVenus: [1.7763, 1.4335e-4, 3.3954e-9, -7.6364e-12, -1.1950e-15],
  runaway: [1.0385, 1.2456e-4, 1.4612e-8, -7.6345e-12, -1.7511e-15],
  maxGreenhouse: [0.3507, 5.9578e-5, 1.6707e-9, -3.0058e-12, -5.1925e-16],
  earlyMars: [0.3207, 5.4471e-5, 1.5275e-9, -2.1709e-12, -3.8282e-16],
};
export const HZ_TEFF = [2600, 7200];

/**
 * A star's habitable zone, AU: { inner, outer } conservative, { optInner,
 * optOuter } optimistic, L (L☉) from its radius and temperature, and
 * whether its temperature lay outside the fit and was taken at the fit's
 * edge, as ExoVision does (TRAPPIST-1 at 2566 K is taken at 2600 K; its
 * luminosity is still its own).
 */
export function habitableZone(rSun, teff) {
  if (!(rSun > 0) || !(teff > 0)) return null;
  const L = rSun ** 2 * (teff / T_SUN) ** 4;
  const fit = Math.min(HZ_TEFF[1], Math.max(HZ_TEFF[0], teff));
  const T = fit - 5780;
  const flux = ([s, a, b, c, d]) => s + a * T + b * T ** 2 + c * T ** 3 + d * T ** 4;
  const at = (limit) => Math.sqrt(L / flux(HZ_LIMITS[limit]));
  return {
    inner: at('runaway'), outer: at('maxGreenhouse'),
    optInner: at('recentVenus'), optOuter: at('earlyMars'),
    L, clamped: fit !== teff,
  };
}

/** Where a planet at `a` AU is against a zone: 'hot', 'opt' (only the optimistic zone), 'in', 'cold'. */
export function zoneOf(hz, a) {
  if (!hz || !(a > 0)) return null;
  if (a < hz.optInner || a > hz.optOuter) return a < hz.optInner ? 'hot' : 'cold';
  return a >= hz.inner && a <= hz.outer ? 'in' : 'opt';
}

/* ---- which star a host is --------------------------------------------- */

/**
 * The catalogue star each system's host is, -1 for none. By Hipparcos
 * number first, where the Archive gives one: a star that moves fast (Barnard's,
 * Kapteyn's) is far from its 1991 place in the Archive's coordinates, and two
 * stars of one pair sit within the same arcminutes. A pair's second star
 * (HIP 73674 B) is not the Hipparcos entry, which is the pair's light and
 * place, taken by its A. The rest by place: within three arcminutes and a
 * fifth in distance, of the stars no other host has taken. Every catalogue
 * star is one host at most.
 *
 * `systems` [{ hip, part, ra, dec, pc, pos }], `hipIndex` Map HIP → index,
 * `near(sys)` the catalogue indices worth testing by place, `posOf(i)`.
 */
export function matchHosts(systems, hipIndex, near, posOf) {
  const out = new Int32Array(systems.length).fill(-1);
  const taken = new Set();
  systems.forEach((sys, k) => {
    if (!sys.hip || (sys.part && sys.part !== 'A')) return;
    const i = hipIndex.get(sys.hip);
    if (i == null || taken.has(i)) return;
    out[k] = i;
    taken.add(i);
  });
  const cosMax = Math.cos((3 / 60) * D2R);
  systems.forEach((sys, k) => {
    // A pair's second star is never the pair's Hipparcos entry, by place either.
    if (out[k] >= 0 || (sys.part && sys.part !== 'A')) return;
    const d0 = Math.hypot(...sys.pos);
    const u = sys.pos.map((c) => c / d0);
    let best = -1;
    let bestCos = cosMax;
    for (const i of near(sys)) {
      if (taken.has(i)) continue;
      const p = posOf(i);
      const d = Math.hypot(p[0], p[1], p[2]);
      if (!(d > 0) || Math.abs(d - sys.pc) > 0.2 * sys.pc) continue;
      const c = (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / d;
      if (c > bestCos) { bestCos = c; best = i; }
    }
    if (best >= 0) {
      out[k] = best;
      taken.add(best);
    }
  });
  return out;
}

/* ---- a star's drift ----------------------------------------------------- */

/**
 * A star's motion across the sky as a velocity in space, parsecs a year:
 * µα·cos δ and µδ (mas/yr) at distance `pc`, along the sky's east and north
 * at its place. Its motion along the line of sight is not in it.
 */
export function skyVelocity(pos, pmRA, pmDE) {
  const d = Math.hypot(pos[0], pos[1], pos[2]);
  if (!(d > 0)) return [0, 0, 0];
  const ra = Math.atan2(pos[1], pos[0]);
  const dec = Math.asin(pos[2] / d);
  const east = [-Math.sin(ra), Math.cos(ra), 0];
  const north = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
  const k = d * MAS;
  return [0, 1, 2].map((j) => k * (pmRA * east[j] + pmDE * north[j]));
}

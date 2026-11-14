/**
 * depth3d.js — the field in depth: where each object goes. Pure numbers.
 *
 * A SPHEREx field is a few tenths of a degree across, and everything in it is
 * at a different distance: an asteroid a few astronomical units away, a star
 * a few hundred parsecs, a galaxy tens of megaparsecs. Behind the viewer the
 * same field is laid out along its own line of sight, every object along its
 * own direction (the field's offsets widened so they can be told apart) and as
 * far as its distance on one logarithmic scale, from a tenth of an AU to the
 * edge of the observed universe. What has no measured distance is not given
 * one: it waits on a far shell labelled as such.
 */

import { LAYOUT } from './layout.js';
import { propagate, GAIA_EPOCH } from '../overlay.js';
import { PLANET_NINE_V, PLANET_NINE_NOMINAL_V, PLANET_NINE_AU, PLANET_NINE_MAX_BETA } from '../depth.js';

const D2R = Math.PI / 180;

/** Astronomical units in a parsec (IAU 2015: 648000/π). */
export const AU_PER_PC = 648000 / Math.PI;

/** Light speed in km/s, for a redshift's recession velocity. */
const C_KMS = 299792.458;

/** The scale the corridor is drawn on (see LAYOUT.depth). */
export const DEPTH_SCALE = LAYOUT.depth;

/** Where a measured distance stands along its ray, in metres from the eye. */
export function depthMetres(au, { nearM, farM, minAU, maxPc } = DEPTH_SCALE) {
  const lo = Math.log10(minAU);
  const hi = Math.log10(maxPc * AU_PER_PC);
  const k = (Math.log10(au) - lo) / (hi - lo);
  return nearM + (farM - nearM) * Math.max(0, Math.min(1, k));
}

/** The shell for what has no measured distance, just past the far end of the scale. */
export const unknownShell = ({ unknownM } = DEPTH_SCALE) => unknownM;

/**
 * Objects `{ id, dir: [x, y, z], au, label }` (au null or missing when there
 * is no measured distance) to `{ id, pos, scale, label, known }`: each along
 * its own direction, at its distance on the log scale, or on the far shell.
 * `scale` is the distance in metres, for sizing a label to stay legible.
 */
export function placeByDistance(objects, opts = DEPTH_SCALE) {
  const scale = { ...DEPTH_SCALE, ...opts };
  return objects.map((o) => {
    const known = Number.isFinite(o.au) && o.au > 0;
    const r = known ? depthMetres(o.au, scale) : unknownShell(scale);
    const [x, y, z] = o.dir;
    const len = Math.hypot(x, y, z) || 1;
    return {
      id: o.id,
      pos: [(x / len) * r, (y / len) * r, (z / len) * r],
      scale: r,
      label: known ? o.label : (o.label ?? null),
      known,
    };
  });
}

/**
 * Gaia DR3's parallax zero-point, in mas: the catalogue's parallaxes read
 * about this much too small on average (Lindegren et al. 2021).
 */
export const GAIA_ZERO_POINT_MAS = -0.017;

/**
 * Parsecs from a Gaia parallax in milliarcseconds, with the ±1σ range, only
 * when it is measured to 1 part in `minSnr` (5: an error of 20 % or less).
 * Returns `{ pc, lo, hi }` or null.
 */
export function parallaxDistancePc(plxMas, plxErrMas, minSnr = 5, zeroPoint = GAIA_ZERO_POINT_MAS) {
  if (!(plxMas > 0) || !(plxErrMas > 0) || plxMas / plxErrMas < minSnr) return null;
  const p = plxMas - zeroPoint;
  return { pc: 1000 / p, lo: 1000 / (p + plxErrMas), hi: 1000 / Math.max(1e-9, p - plxErrMas) };
}

/**
 * Comoving distance in megaparsecs for a redshift, in a flat ΛCDM universe
 * with the Planck 2018 values (H0 = 67.7 km/s/Mpc, Ωm = 0.31): the integral
 * of c/H(z), by Simpson's rule. A model distance, and the view says so
 * wherever it shows one.
 */
export function redshiftDistanceMpc(z, { h0 = 67.7, omegaM = 0.31 } = {}) {
  if (!(z > 0)) return null;
  const e = (x) => Math.sqrt(omegaM * (1 + x) ** 3 + (1 - omegaM));
  const n = 64;
  const step = z / n;
  let sum = 1 / e(0) + 1 / e(z);
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) / e(i * step);
  return (C_KMS / h0) * (step / 3) * sum;
}

/**
 * Below this redshift a galaxy's own motion (a few hundred km/s) is a large
 * part of its recession: no distance from z.
 */
export const MIN_REDSHIFT = 0.01;

/**
 * How much a body `au` away shifts against the stars between two places of
 * the Earth `baselineAU` apart, in arcminutes.
 */
export const parallaxShiftArcmin = (baselineAU, au) => (Math.atan(baselineAU / au) * 180 / Math.PI) * 60;

/** The milestones along the scale, each named, from an AU to a hundred megaparsecs. */
export const DEPTH_TICKS = [
  { au: 1, key: 'au1' },
  { au: 30, key: 'neptune' },
  // The Oort cloud is a range, and is drawn as one: its two ends.
  { au: 2e3, to: 1e5, key: 'oort' },
  { au: AU_PER_PC, key: 'pc1' },
  { au: 10 * AU_PER_PC, key: 'pc10' },
  { au: 100 * AU_PER_PC, key: 'pc100' },
  // The distance to Sagittarius A*, GRAVITY Collaboration 2019: 8.18 kpc.
  { au: 8.2e3 * AU_PER_PC, key: 'gc' },
  { au: 1e6 * AU_PER_PC, key: 'mpc1' },
  { au: 1e8 * AU_PER_PC, key: 'mpc100' },
  { au: 1e10 * AU_PER_PC, key: 'gpc10' },
];

/** Light-travel (lookback) time to a redshift, in billions of years, in the same flat ΛCDM. */
export function lookbackGyr(z, { h0 = 67.7, omegaM = 0.31 } = {}) {
  if (!(z > 0)) return null;
  const e = (x) => Math.sqrt(omegaM * (1 + x) ** 3 + (1 - omegaM));
  const f = (x) => 1 / ((1 + x) * e(x));
  const n = 64;
  const step = z / n;
  let sum = f(0) + f(z);
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * f(i * step);
  // 1/H0 in Gyr: 977.8 / H0[km/s/Mpc].
  return (977.8 / h0) * (step / 3) * sum;
}

/** Where Planet X is predicted to be, in AU: the site's own range (depth.js). */
export const PLANET_X_AU = PLANET_NINE_AU;

/**
 * Its predicted brightness, V, as the site gives it (depth.js): 22.6–24.3 near
 * aphelion for 5 to 50 Earth masses, and 21.7 for the nominal 10 Earth
 * masses at 700 AU (Linder & Mordasini 2016, A&A 589, A134).
 */
export const PLANET_X_V = { ...PLANET_NINE_V, nominal: PLANET_NINE_NOMINAL_V };

/** How far from the ecliptic Planet X is expected, degrees (depth.js). */
export const PLANET_X_MAX_BETA = PLANET_NINE_MAX_BETA;

/** Ecliptic latitude of an equatorial position (J2000), degrees. */
export function eclipticLatitude(raDeg, decDeg) {
  const e = 23.4393 * D2R;
  const a = raDeg * D2R;
  const d = decDeg * D2R;
  return Math.asin(Math.sin(d) * Math.cos(e) - Math.cos(d) * Math.sin(e) * Math.sin(a)) / D2R;
}

/** Every power of ten across the scale, for a ring each. */
export function decadeRings(scale = DEPTH_SCALE) {
  const out = [];
  const lo = Math.ceil(Math.log10(scale.minAU));
  const hi = Math.floor(Math.log10(scale.maxPc * AU_PER_PC));
  for (let k = lo; k <= hi; k++) out.push(10 ** k);
  return out;
}

/**
 * An orthonormal frame for looking along `axis` with the world's up as up:
 * `right` and `up` as the viewer facing that way sees them.
 */
export function viewFrame(axis) {
  const [ax, ay, az] = axis;
  const len = Math.hypot(ax, ay, az) || 1;
  const f = [ax / len, ay / len, az / len];
  // right = f × up(0,1,0)
  let r = [-f[2], 0, f[0]];
  const rl = Math.hypot(r[0], r[2]) || 1;
  r = [r[0] / rl, 0, r[2] / rl];
  // up = right × f
  const u = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ];
  return { f, r, u };
}

/**
 * A position in the field to a direction in the corridor. The field's offsets
 * from its centre (east and north, in degrees) are widened by `spread` so a
 * fifth of a degree becomes tens; east is to the viewer's left, north up, as
 * on the sky.
 */
export function fieldDirection(dEastDeg, dNorthDeg, frame, spread) {
  const a = Math.tan(Math.max(-80, Math.min(80, dEastDeg * spread)) * D2R);
  const b = Math.tan(Math.max(-80, Math.min(80, dNorthDeg * spread)) * D2R);
  const { f, r, u } = frame;
  return [
    f[0] - a * r[0] + b * u[0],
    f[1] - a * r[1] + b * u[1],
    f[2] - a * r[2] + b * u[2],
  ];
}

/**
 * The Gaia row that is the field's own target, or null. By its Gaia DR3
 * source id when the target names one (`ref: 'Gaia DR3 <id>'`); otherwise
 * only a source within `maxArcsec` of the target once both are carried to
 * `epoch`, and moving within `pmTol` of the target's own motion. A
 * neighbour half an arcminute away is not the target, whatever its distance.
 */
export function matchTarget(target, rows, epoch, { maxArcsec = 3, pmTol = 0.2 } = {}) {
  const id = /^Gaia DR3\s+(\d+)$/.exec(String(target.ref ?? '').trim())?.[1];
  if (id) return rows.find((r) => String(r.id) === id) ?? null;
  const t = propagate(target, epoch, target.epoch ?? GAIA_EPOCH);
  const pmT = Math.hypot(target.pmRA ?? NaN, target.pmDE ?? NaN);
  const cos = Math.cos(t.dec * D2R);
  for (const r of rows) {
    const at = propagate(r, epoch, GAIA_EPOCH);
    const dra = ((((at.ra - t.ra) % 360) + 540) % 360 - 180) * cos;
    if (Math.hypot(dra, at.dec - t.dec) * 3600 > maxArcsec) continue;
    const pmR = Math.hypot(r.pmRA ?? NaN, r.pmDE ?? NaN);
    if (Number.isFinite(pmT) && pmT > 0 && !(Number.isFinite(pmR) && Math.abs(pmR - pmT) <= pmTol * pmT)) continue;
    return r;
  }
  return null;
}

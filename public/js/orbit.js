/**
 * orbit.js — what an asteroid or comet goes round, and how: JPL's
 * Small-Body Database answer read into the numbers a mark's card quotes, and
 * the plain two-body sums that turn its orbital elements into a top-down
 * sketch and today's place on it.
 *
 * Shared by the relay (server.js), which reads JPL's answer, and the page,
 * which draws it; pure, so it is tested in Node.
 */

const SBDB_API = 'https://ssd-api.jpl.nasa.gov/sbdb.api';

/** Full precision: the default answer rounds the mean anomaly to three figures, a few degrees of the orbit. */
export const sbdbOrbitUrl = (des) => `${SBDB_API}?sstr=${encodeURIComponent(des)}&full-prec=true`;

/** The Gaussian gravitational constant in degrees a day: a body at 1 AU goes round in a year. */
const GAUSS_DEG_PER_DAY = 0.9856076686;
const DAYS_PER_YEAR = 365.25;
const MS_PER_DAY = 86_400_000;
const UNIX_EPOCH_JD = 2440587.5;
const RAD = Math.PI / 180;

/** A Julian date for a JavaScript time. */
export const julianDay = (ms) => ms / MS_PER_DAY + UNIX_EPOCH_JD;

const num = (v) => (v == null || v === '' ? NaN : Number(v));

/**
 * The orbit SBDB gives for one body, or null when the answer names no single
 * body. Angles in degrees, distances in AU, the period in years; NaN where
 * JPL gave nothing (a comet on an open orbit has no a and no period).
 */
export function readOrbit(body) {
  const o = body?.object;
  const orbit = body?.orbit;
  if (!o || !orbit || !Array.isArray(orbit.elements)) return null;
  const el = Object.fromEntries(orbit.elements.map((x) => [x.name, num(x.value)]));
  const e = el.e;
  const q = el.q;
  const a = Number.isFinite(el.a) ? el.a : (e < 1 ? q / (1 - e) : NaN);
  const periodDays = Number.isFinite(el.per) ? el.per : (a > 0 ? 360 / (GAUSS_DEG_PER_DAY / a ** 1.5) : NaN);
  return {
    des: String(o.des ?? ''),
    name: String(o.shortname ?? o.fullname ?? o.des ?? ''),
    comet: /^c/.test(o.kind ?? ''),
    cls: o.orbit_class ? { code: String(o.orbit_class.code ?? ''), name: String(o.orbit_class.name ?? '') } : null,
    neo: o.neo === true,
    pha: o.pha === true,
    a, e, q,
    Q: Number.isFinite(el.ad) ? el.ad : (e < 1 ? a * (1 + e) : NaN),
    i: el.i, om: el.om, w: el.w,
    ma: el.ma,
    tp: el.tp,
    n: Number.isFinite(el.n) ? el.n : (a > 0 ? GAUSS_DEG_PER_DAY / a ** 1.5 : NaN),
    epoch: num(orbit.epoch),
    years: periodDays / DAYS_PER_YEAR,
  };
}

/** Whether an orbit is closed and complete enough to draw. */
export const drawable = (k) => k && k.e >= 0 && k.e < 1 && k.a > 0
  && [k.i, k.om, k.w].every(Number.isFinite);

/** The mean anomaly at Julian date `jd`, degrees: from the epoch's, else from the perihelion date. */
function meanAnomaly(k, jd) {
  if (Number.isFinite(k.ma) && Number.isFinite(k.epoch)) return k.ma + k.n * (jd - k.epoch);
  if (Number.isFinite(k.tp)) return k.n * (jd - k.tp);
  return NaN;
}

/** Kepler's equation, by Newton's method: the eccentric anomaly (radians) for a mean anomaly (radians). */
function eccentricAnomaly(M, e) {
  const m = Math.atan2(Math.sin(M), Math.cos(M));
  let E = e < 0.8 ? m : Math.PI * Math.sign(m || 1);
  for (let k = 0; k < 30; k++) {
    const step = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E));
    E -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return E;
}

/** A point of the orbit at eccentric anomaly E, in the ecliptic frame (x to the March equinox), AU. */
function pointAt(k, E) {
  const xp = k.a * (Math.cos(E) - k.e);
  const yp = k.a * Math.sqrt(1 - k.e * k.e) * Math.sin(E);
  const [cO, sO] = [Math.cos(k.om * RAD), Math.sin(k.om * RAD)];
  const [cw, sw] = [Math.cos(k.w * RAD), Math.sin(k.w * RAD)];
  const [ci, si] = [Math.cos(k.i * RAD), Math.sin(k.i * RAD)];
  return {
    x: (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp,
    y: (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp,
    z: sw * si * xp + cw * si * yp,
  };
}

/** The whole orbit as `steps` points, each { x, y, z } in AU. */
export function orbitPath(k, steps = 120) {
  if (!drawable(k)) return [];
  return Array.from({ length: steps }, (_, s) => pointAt(k, (2 * Math.PI * s) / steps));
}

/** Where the body is on its orbit at Julian date `jd` (two-body motion, no planets' pulls), or null. */
export function positionAt(k, jd) {
  if (!drawable(k)) return null;
  const M = meanAnomaly(k, jd);
  if (!Number.isFinite(M)) return null;
  return pointAt(k, eccentricAnomaly(M * RAD, k.e));
}

/**
 * The Earth's place round the Sun at Julian date `jd`, ecliptic x, y in AU:
 * the Sun's low-precision longitude (good to about 0.01°) turned round, and
 * taken back from the equinox of the date to J2000's, the frame JPL's
 * elements are in: the equinox drifts 1.4° a century.
 */
export function earthAt(jd) {
  const d = jd - 2451545.0;
  const g = (357.528 + 0.9856003 * d) * RAD;
  const precession = 1.39697 * (d / 36525);
  const lambda = (280.460 + 0.9856474 * d - precession) * RAD + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD + Math.PI;
  const r = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  return { x: r * Math.cos(lambda), y: r * Math.sin(lambda) };
}

/** Planets drawn for scale, as circles of their mean distance. */
export const REFERENCE_ORBITS = [
  { key: 'earth', a: 1.0 },
  { key: 'jupiter', a: 5.203 },
  { key: 'neptune', a: 30.07 },
];

/**
 * The planets a sketch carries for scale: the Earth always, Jupiter once the
 * body goes past the inner planets, Neptune once it goes past Saturn.
 */
export function referencesFor(k) {
  const far = Number.isFinite(k?.Q) ? k.Q : k?.a;
  return REFERENCE_ORBITS.filter((p) => p.key === 'earth' || (p.key === 'jupiter' && far > 1.8) || (p.key === 'neptune' && far > 8));
}

/** How far out a sketch must reach, AU: the body's farthest point or the outermost planet drawn. */
export function sketchReach(k) {
  const refs = referencesFor(k);
  return Math.max(Number.isFinite(k?.Q) ? k.Q : 0, ...refs.map((p) => p.a));
}

/* ------------------------------------------- who else goes round the same way */

const SBDB_QUERY_API = 'https://ssd-api.jpl.nasa.gov/sbdb_query.api';

/**
 * How near an orbit must be to count as "nearly the same": the semi-major
 * axis within 2 %, the eccentricity within 0.03, the inclination within
 * 1.5°. A box in a, e and i, the three elements the planets change slowest;
 * the node and the perihelion turn round in thousands of years and are left
 * to the D-criterion below.
 */
export const NEAR_BOX = { a: 0.02, e: 0.03, i: 1.5 };
/** Rows JPL is asked for at most: the closest are picked from these. */
export const NEAR_ROWS = 200;

/**
 * The a, e, i ranges round an orbit, `scale` times NEAR_BOX: rounded so the
 * same body always asks the same question, and kept to what an orbit can be.
 */
export function nearBox({ a, e, i }, scale = 1) {
  const round = (x, places) => Number(x.toFixed(places));
  return {
    a: [round(a * (1 - NEAR_BOX.a * scale), 4), round(a * (1 + NEAR_BOX.a * scale), 4)],
    e: [round(Math.max(0, e - NEAR_BOX.e * scale), 4), round(Math.min(0.9999, e + NEAR_BOX.e * scale), 4)],
    i: [round(Math.max(0, i - NEAR_BOX.i * scale), 2), round(Math.min(180, i + NEAR_BOX.i * scale), 2)],
  };
}

/**
 * The SBDB Query API's question for every body in a box: their names, the
 * elements the D-criterion and the sketch need, and their class. Only
 * numbers go into the constraint, all of them from nearBox.
 */
export function nearQueryUrl(box, limit = NEAR_ROWS) {
  const range = (field, [lo, hi]) => `${field}|RG|${lo}|${hi}`;
  const url = new URL(SBDB_QUERY_API);
  url.search = new URLSearchParams({
    fields: 'full_name,pdes,a,e,q,i,om,w,class',
    'sb-cdata': JSON.stringify({ AND: [range('a', box.a), range('e', box.e), range('i', box.i)] }),
    limit: String(limit),
  }).toString();
  return url.href;
}

/**
 * JPL's answer read: how many bodies the box holds in all, and the rows it
 * sent, each { des, name, a, e, q, i, om, w, cls }. Rows without the
 * elements an orbit needs are dropped.
 */
export function readNear(body) {
  const fields = Array.isArray(body?.fields) ? body.fields : [];
  const at = Object.fromEntries(fields.map((f, n) => [f, n]));
  const rows = (Array.isArray(body?.data) ? body.data : []).map((r) => ({
    des: String(r[at.pdes] ?? '').trim(),
    name: String(r[at.full_name] ?? '').trim(),
    a: num(r[at.a]), e: num(r[at.e]), q: num(r[at.q]),
    i: num(r[at.i]), om: num(r[at.om]), w: num(r[at.w]),
    cls: String(r[at.class] ?? ''),
  })).filter((b) => b.des && [b.a, b.e, b.q, b.i, b.om, b.w].every(Number.isFinite));
  return { count: Number.isFinite(Number(body?.count)) ? Number(body.count) : rows.length, rows };
}

/**
 * Southworth and Hawkins' D-criterion (1963), how far apart two orbits are:
 * the differences in e and q, the angle between the two orbit planes, and
 * the difference in where the perihelia point, weighted by the mean
 * eccentricity. 0 is the same orbit; asteroid pairs and meteor streams are
 * usually taken as related below about 0.1–0.2.
 */
export function dSH(k1, k2) {
  const halfSin = (deg) => 2 * Math.sin((deg * RAD) / 2);
  const dOm = k2.om - k1.om;
  // The angle between the planes, I21, as 2 sin(I21 / 2).
  const planes = Math.sqrt(halfSin(k2.i - k1.i) ** 2 + Math.sin(k1.i * RAD) * Math.sin(k2.i * RAD) * halfSin(dOm) ** 2);
  const halfI21 = Math.asin(Math.min(1, planes / 2));
  // The perihelia measured from the planes' common node; the term changes
  // sign when the nodes are more than half a turn apart.
  const turn = Math.abs(dOm) > 180 ? -1 : 1;
  const nodeTerm = Math.cos(halfI21) > 1e-12
    ? Math.asin(Math.max(-1, Math.min(1, Math.cos(((k2.i + k1.i) / 2) * RAD) * Math.sin((dOm / 2) * RAD) / Math.cos(halfI21))))
    : 0;
  const pi21 = (k2.w - k1.w) * RAD + 2 * turn * nodeTerm;
  const perihelia = ((k1.e + k2.e) / 2) * 2 * Math.sin(pi21 / 2);
  return Math.sqrt((k2.e - k1.e) ** 2 + (k2.q - k1.q) ** 2 + planes ** 2 + perihelia ** 2);
}

/** The bodies of a box nearest a body's orbit by D_SH, the body itself left out: [{ ...row, d }]. */
export function closestOrbits(k, rows, n = 5) {
  const own = String(k.des ?? '').trim().toLowerCase();
  return rows
    .filter((r) => r.des.toLowerCase() !== own)
    .map((r) => ({ ...r, d: dSH(k, r) }))
    .filter((r) => Number.isFinite(r.d))
    .sort((x, y) => x.d - y.d)
    .slice(0, n);
}

/** The Earth's distance from the Sun runs between these, AU. */
const EARTH_PERIHELION = 0.9833;
const EARTH_APHELION = 1.0167;

/** Whether the orbit's span of distances from the Sun overlaps the Earth's: it crosses the Earth's orbit (seen from above). */
export const crossesEarth = (k) => k.q < EARTH_APHELION && k.Q > EARTH_PERIHELION;

/**
 * Which of Jupiter's Lagrange points a Trojan goes round: 'L4', 60° ahead
 * of Jupiter, or 'L5', 60° behind; null when it is near neither. Jupiter's
 * mean longitude from Standish's mean elements (J2000 ecliptic, good to a
 * fraction of a degree for these centuries), the body's from its own.
 */
export function trojanPoint(k, jd) {
  const M = meanAnomaly(k, jd);
  if (![k.om, k.w, M].every(Number.isFinite)) return null;
  const jupiter = 34.39644051 + 3034.74612775 * ((jd - 2451545.0) / 36525);
  const ahead = ((((k.om + k.w + M - jupiter) % 360) + 540) % 360) - 180;
  if (ahead > 20 && ahead < 120) return 'L4';
  if (ahead < -20 && ahead > -120) return 'L5';
  return null;
}

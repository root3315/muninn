/**
 * ephemeris.js — where the planets are, right now, without asking anyone.
 *
 * The entry screen marks things you can open, and the most interesting things
 * in this tool's own subject — the outer solar system — are the ones that move.
 * A planet has no fixed place on the sky, so it cannot be a row in a catalogue;
 * it has to be computed for the moment you are looking.
 *
 * This is JPL's own low-precision method: Keplerian elements for each planet at
 * J2000 with linear rates per century, from "Approximate Positions of the
 * Planets" (Standish, JPL Solar System Dynamics), valid 1800–2050. Accuracy
 * over that span is a few arcminutes for the inner planets and under about a
 * tenth of a degree for the outer ones — far finer than a marker on an all-sky
 * map needs, and finer than the 18-arcminute field it opens.
 *
 * It is approximate and the interface says so. Where an exact position matters
 * — deciding whether a moving dot in a frame is a known body — the tool asks
 * IMCCE's SkyBoT instead, which integrates the real orbit.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
/** Obliquity of the ecliptic at J2000. */
const OBLIQUITY = 23.43928 * D2R;

/**
 * a (au), e, I (deg), L (deg), longitude of perihelion (deg), longitude of the
 * ascending node (deg) — each with its rate per Julian century.
 *
 * Earth's row is the Earth–Moon barycentre, which is what the table gives and
 * what the geocentric subtraction wants at this precision.
 */
const ELEMENTS = {
  mercury: {
    a: [0.38709927, 0.00000037], e: [0.20563593, 0.00001906],
    I: [7.00497902, -0.00594749], L: [252.25032350, 149472.67411175],
    peri: [77.45779628, 0.16047689], node: [48.33076593, -0.12534081],
  },
  venus: {
    a: [0.72333566, 0.00000390], e: [0.00677672, -0.00004107],
    I: [3.39467605, -0.00078890], L: [181.97909950, 58517.81538729],
    peri: [131.60246718, 0.00268329], node: [76.67984255, -0.27769418],
  },
  earth: {
    a: [1.00000261, 0.00000562], e: [0.01671123, -0.00004392],
    I: [-0.00001531, -0.01294668], L: [100.46457166, 35999.37244981],
    peri: [102.93768193, 0.32327364], node: [0.0, 0.0],
  },
  mars: {
    a: [1.52371034, 0.00001847], e: [0.09339410, 0.00007882],
    I: [1.84969142, -0.00813131], L: [-4.55343205, 19140.30268499],
    peri: [-23.94362959, 0.44441088], node: [49.55953891, -0.29257343],
  },
  jupiter: {
    a: [5.20288700, -0.00011607], e: [0.04838624, -0.00013253],
    I: [1.30439695, -0.00183714], L: [34.39644051, 3034.74612775],
    peri: [14.72847983, 0.21252668], node: [100.47390909, 0.20469106],
  },
  saturn: {
    a: [9.53667594, -0.00125060], e: [0.05386179, -0.00050991],
    I: [2.48599187, 0.00193609], L: [49.95424423, 1222.49362201],
    peri: [92.59887831, -0.41897216], node: [113.66242448, -0.28867794],
  },
  uranus: {
    a: [19.18916464, -0.00196176], e: [0.04725744, -0.00004397],
    I: [0.77263783, -0.00242939], L: [313.23810451, 428.48202785],
    peri: [170.95427630, 0.40805281], node: [74.01692503, 0.04240589],
  },
  neptune: {
    a: [30.06992276, 0.00026291], e: [0.00859048, 0.00005105],
    I: [1.77004347, 0.00035372], L: [-55.12002969, 218.45945325],
    peri: [44.96476227, -0.32241464], node: [131.78422574, -0.00508664],
  },
};

export const PLANETS = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

/** Julian date from a JavaScript Date, on the UTC scale. */
export const julian = (date) => date.getTime() / 86400000 + 2440587.5;

const wrap180 = (deg) => ((deg % 360) + 540) % 360 - 180;

/**
 * Kepler's equation, solved by Newton on the eccentric anomaly.
 *
 * Written the way JPL writes it, in degrees with e* = 180/π · e, so the whole
 * method can be checked line by line against the published note.
 */
function eccentricAnomaly(Mdeg, e) {
  const eStar = R2D * e;
  let E = Mdeg + eStar * Math.sin(Mdeg * D2R);
  for (let i = 0; i < 12; i++) {
    const dM = Mdeg - (E - eStar * Math.sin(E * D2R));
    const dE = dM / (1 - e * Math.cos(E * D2R));
    E += dE;
    if (Math.abs(dE) < 1e-9) break;
  }
  return E;
}

/** Heliocentric position in the J2000 ecliptic frame, in au. */
export function heliocentric(name, T) {
  const el = ELEMENTS[name];
  const a = el.a[0] + el.a[1] * T;
  const e = el.e[0] + el.e[1] * T;
  const I = (el.I[0] + el.I[1] * T) * D2R;
  const L = el.L[0] + el.L[1] * T;
  const peri = el.peri[0] + el.peri[1] * T;
  const node = (el.node[0] + el.node[1] * T) * D2R;

  const omega = (peri - node * R2D) * D2R;
  const M = wrap180(L - peri);
  const E = eccentricAnomaly(M, e) * D2R;

  // In the orbital plane, perihelion along +x.
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

  const cw = Math.cos(omega);
  const sw = Math.sin(omega);
  const cO = Math.cos(node);
  const sO = Math.sin(node);
  const cI = Math.cos(I);
  const sI = Math.sin(I);

  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    (sw * sI) * xp + (cw * sI) * yp,
  ];
}

/**
 * Geocentric right ascension and declination of a planet, J2000, in degrees.
 *
 * Returns the distance from Earth as well, in au, because "how far away is it"
 * is half of what makes a planet worth opening.
 */
export function planetPosition(name, date = new Date()) {
  const T = (julian(date) - 2451545.0) / 36525;
  const p = heliocentric(name, T);
  const earth = heliocentric('earth', T);
  const x = p[0] - earth[0];
  const y = p[1] - earth[1];
  const z = p[2] - earth[2];

  // Ecliptic to equatorial.
  const xe = x;
  const ye = y * Math.cos(OBLIQUITY) - z * Math.sin(OBLIQUITY);
  const ze = y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY);

  const r = Math.hypot(xe, ye, ze);
  const ra = ((Math.atan2(ye, xe) * R2D) % 360 + 360) % 360;
  const dec = Math.asin(ze / r) * R2D;
  return { ra, dec, distanceAU: r, sunAU: Math.hypot(...p) };
}

/** Every planet at once, in the order they orbit. */
export function planetsNow(date = new Date()) {
  return PLANETS.map((key) => ({ key, ...planetPosition(key, date) }));
}

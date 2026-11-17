/**
 * solar.js — the Sun's planets and the Moon, where they are today, at their
 * real sizes, for the flight.
 *
 * Planets: JPL's Keplerian elements (ephemeris.js, "Approximate Positions of
 * the Planets", a few arcminutes to a tenth of a degree). Earth's row is the
 * Earth–Moon barycentre; at these scales that is the Earth. The Moon: the
 * leading terms of Meeus's lunar series (ELP-2000/82, chapter 47 of his
 * "Astronomical Algorithms"), within 0.02° and 20 km of JPL's ephemeris.
 *
 * Positions come out in parsecs on ICRS axes with the Sun at the origin, the
 * frame of the stars. Radii are the IAU's mean radii. Brightness is
 * approximate (a typical magnitude at a typical distance), and colours are
 * each body's average colour; nothing here is a picture of the surface.
 */

import { heliocentric, julian } from '../ephemeris.js';

const D2R = Math.PI / 180;
const OBLIQUITY = 23.43928 * D2R;
export const AU_PC = 1 / 206264.806;
const KM_PC = 1 / 3.0856775814913673e13;
const R_SUN_KM = 695700;

/**
 * key, names, mean radius (km), a typical magnitude seen at a typical
 * distance (AU) for the point drawn from afar, and an average colour.
 */
export const BODIES = [
  { key: 'mercury', en: 'Mercury', ru: 'Меркурий', km: 2439.7, m: 0.0, at: 1.0, col: [0.62, 0.6, 0.57] },
  { key: 'venus', en: 'Venus', ru: 'Венера', km: 6051.8, m: -4.4, at: 0.7, col: [0.95, 0.88, 0.72] },
  { key: 'earth', en: 'Earth', ru: 'Земля', km: 6371.0, m: -3.8, at: 0.5, col: [0.38, 0.55, 0.9] },
  { key: 'moon', en: 'Moon', ru: 'Луна', km: 1737.4, m: -12.7, at: 0.00257, col: [0.72, 0.71, 0.68] },
  { key: 'mars', en: 'Mars', ru: 'Марс', km: 3389.5, m: -1.0, at: 1.0, col: [0.86, 0.47, 0.3] },
  { key: 'jupiter', en: 'Jupiter', ru: 'Юпитер', km: 69911, m: -2.5, at: 4.2, col: [0.87, 0.78, 0.63] },
  { key: 'saturn', en: 'Saturn', ru: 'Сатурн', km: 58232, m: 0.5, at: 8.5, col: [0.9, 0.83, 0.62] },
  { key: 'uranus', en: 'Uranus', ru: 'Уран', km: 25362, m: 5.7, at: 19, col: [0.62, 0.86, 0.9] },
  { key: 'neptune', en: 'Neptune', ru: 'Нептун', km: 24622, m: 7.8, at: 29, col: [0.38, 0.52, 0.95] },
];

/** J2000 ecliptic to ICRS (equatorial) axes. */
const toEquatorial = ([x, y, z]) => [x, y * Math.cos(OBLIQUITY) - z * Math.sin(OBLIQUITY), y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY)];

/*
 * The Moon's periodic terms, Meeus, "Astronomical Algorithms" (2nd ed.,
 * 1998), chapter 47, from the ELP-2000/82 theory: every term of tables 47.A
 * and 47.B down to about 0.002° in longitude and latitude and 8 km in
 * distance. Each row: the multiples of D, M, M′ and F, then the longitude
 * term (10⁻⁶ degrees) and the distance term (metres) of table A, or the
 * latitude term (10⁻⁶ degrees) of table B. Against JPL Horizons the Moon
 * comes out within 0.02° and 20 km of distance (tests/moon.test.mjs).
 */
const MOON_LR = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884],
];
const MOON_B = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
];

/**
 * The Moon from the Earth, in AU, on the ecliptic and equinox of J2000 (the
 * frame of the planets' elements). Meeus's series gives it on the equinox of
 * the date; the equinox drifts 1.397° a century, taken off the longitude.
 */
export function moonGeocentric(date) {
  const T = (julian(date) - 2451545.0) / 36525;
  const Lp = 218.3164477 + 481267.88123421 * T;
  const D = (297.8501921 + 445267.1114034 * T) * D2R;
  const M = (357.5291092 + 35999.0502909 * T) * D2R;
  const Mp = (134.9633964 + 477198.8675055 * T) * D2R;
  const F = (93.272095 + 483202.0175233 * T) * D2R;
  // The Earth's orbit grows rounder: terms in the Sun's anomaly shrink with it.
  const E = 1 - 0.002516 * T;
  const A1 = (119.75 + 131.849 * T) * D2R;
  const A2 = (53.09 + 479264.29 * T) * D2R;
  const A3 = (313.45 + 481266.484 * T) * D2R;
  let l = 3958 * Math.sin(A1) + 1962 * Math.sin(Lp * D2R - F) + 318 * Math.sin(A2);
  let r = 0;
  for (const [d, m, mp, f, sl, sr] of MOON_LR) {
    const arg = d * D + m * M + mp * Mp + f * F;
    const e = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    l += sl * e * Math.sin(arg);
    r += sr * e * Math.cos(arg);
  }
  let b = -2235 * Math.sin(Lp * D2R) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) + 175 * Math.sin(A1 + F)
    + 127 * Math.sin(Lp * D2R - Mp) - 115 * Math.sin(Lp * D2R + Mp);
  for (const [d, m, mp, f, sb] of MOON_B) {
    const e = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    b += sb * e * Math.sin(d * D + m * M + mp * Mp + f * F);
  }
  const lon = (Lp + l / 1e6 - 1.396971 * T) * D2R;
  const lat = (b / 1e6) * D2R;
  const au = (385000.56 + r / 1000) / 149597870.7;
  return [au * Math.cos(lat) * Math.cos(lon), au * Math.cos(lat) * Math.sin(lon), au * Math.sin(lat)];
}

/** The Moon's mass over the Earth's (IAU 2015): the barycentre lies 1/82.3 of the way to the Moon. */
const MOON_EARTH_MASS = 0.0123000371;

/**
 * Every body for a date: { key, en, ru, pos (pc, ICRS), radius (R☉), absMag
 * (the magnitude that gives its typical brightness at its typical distance),
 * col }.
 */
export function solarSystem(date = new Date()) {
  const T = (julian(date) - 2451545.0) / 36525;
  // JPL's "earth" row is the Earth–Moon barycentre: the Earth is 4,670 km
  // from it, on the side away from the Moon, and the Moon the rest of the way.
  const bary = heliocentric('earth', T);
  const g = moonGeocentric(date);
  const k = MOON_EARTH_MASS / (1 + MOON_EARTH_MASS);
  const earth = [bary[0] - g[0] * k, bary[1] - g[1] * k, bary[2] - g[2] * k];
  return BODIES.map((b) => {
    let au;
    if (b.key === 'moon') {
      au = [earth[0] + g[0], earth[1] + g[1], earth[2] + g[2]];
    } else if (b.key === 'earth') {
      au = earth;
    } else {
      au = heliocentric(b.key, T);
    }
    return {
      ...b,
      pos: toEquatorial(au).map((c) => c * AU_PC),
      radius: b.km / R_SUN_KM,
      absMag: b.m - 5 * Math.log10((b.at * AU_PC) / 10),
      kmPc: b.km * KM_PC,
    };
  });
}

/**
 * Each body's spin (IAU WGCCRE 2015, Archinal et al. 2018): its north pole's
 * RA and Dec, degrees, and its prime meridian W = W0 + rate·d, d days from
 * J2000. The slow drift of the poles and the Moon's libration are left out:
 * a fraction of a degree. Jupiter's is System III, its magnetic field's turn.
 */
const SPIN = {
  mercury: [281.0103, 61.4155, 329.5988, 6.1385108],
  venus: [272.76, 67.16, 160.20, -1.4813688],
  earth: [0, 90, 190.147, 360.9856235],
  moon: [269.9949, 66.5392, 38.3213, 13.17635815],
  mars: [317.269202, 54.432516, 176.049863, 350.891982443297],
  jupiter: [268.056595, 64.495303, 284.95, 870.536],
  saturn: [40.589, 83.537, 38.90, 810.7939024],
  uranus: [257.311, -15.175, 203.81, -501.1600928],
  neptune: [299.36, 43.46, 249.978, 541.1397757],
};

/**
 * A body's axes on ICRS for a date: x towards its prime meridian on its
 * equator, z its north pole, y = z × x (east longitude grows from x to y).
 */
export function bodyAxes(key, date = new Date()) {
  const spin = SPIN[key];
  if (!spin) return null;
  const [ra, dec, w0, rate] = spin;
  const a = ra * D2R;
  const d = dec * D2R;
  const z = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  // The equator's ascending node on the ICRS equator, at RA + 90°.
  const node = [-Math.sin(a), Math.cos(a), 0];
  const across = [z[1] * node[2] - z[2] * node[1], z[2] * node[0] - z[0] * node[2], z[0] * node[1] - z[1] * node[0]];
  const W = ((w0 + rate * (julian(date) - 2451545.0)) % 360) * D2R;
  const x = node.map((c, k) => c * Math.cos(W) + across[k] * Math.sin(W));
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { x, y, z };
}

/** Orbital periods, years (sidereal): for tracing each orbit once. */
const PERIOD_YEARS = { mercury: 0.2408, venus: 0.6152, earth: 1.0000, mars: 1.8808, jupiter: 11.862, saturn: 29.457, uranus: 84.011, neptune: 164.79 };

/**
 * Each planet's orbit as points, parsecs from the Sun on ICRS axes, traced
 * through one period from the same elements that place the planet; and the
 * Moon's round the Earth, through one sidereal month, relative to the Earth.
 */
export function orbits(date = new Date(), steps = 180) {
  const T0 = (julian(date) - 2451545.0) / 36525;
  const out = {};
  for (const [key, years] of Object.entries(PERIOD_YEARS)) {
    const pts = [];
    for (let k = 0; k <= steps; k++) {
      const T = T0 + (years / 100) * (k / steps);
      pts.push(toEquatorial(heliocentric(key, T)).map((c) => c * AU_PC));
    }
    out[key] = pts;
  }
  out.moon = moonOrbit(date, steps);
  return out;
}

/**
 * The Moon's orbit round the Earth from a date through one sidereal month,
 * parsecs, relative to the Earth: from the same series that places it, so it
 * carries the orbit's tilt of about 5.1° to the ecliptic and its eccentricity.
 */
export function moonOrbit(date = new Date(), steps = 180) {
  const moon = [];
  for (let k = 0; k <= steps; k++) {
    const d = new Date(date.getTime() + (27.3217 * 86400000 * k) / steps);
    moon.push(toEquatorial(moonGeocentric(d)).map((c) => c * AU_PC));
  }
  return moon;
}

/**
 * What is known of each planet, for its card and the Sun's: a (AU), year
 * (days), moons known (JPL Solar System Dynamics' list of planetary
 * satellites and the IAU Minor Planet Center's announcements, as of
 * MOONS_AS_OF: Saturn's 274 since March 2025, Uranus's 29th, S/2025 U1,
 * found by JWST and announced in August 2025).
 */
export const FACTS = {
  mercury: { a: 0.387, year: 87.97, day: 58.65, moons: 0, g: 3.7, t: '−173…427 °C' },
  venus: { a: 0.723, year: 224.70, day: -243.02, moons: 0, g: 8.87, t: '464 °C' },
  earth: { a: 1.000, year: 365.26, day: 0.9973, moons: 1, g: 9.81, t: '−89…57 °C' },
  moon: { a: 0.00257, year: 27.32, day: 27.32, moons: 0, g: 1.62, t: '−173…127 °C' },
  mars: { a: 1.524, year: 686.98, day: 1.026, moons: 2, g: 3.71, t: '−140…20 °C' },
  jupiter: { a: 5.203, year: 4332.6, day: 0.4135, moons: 97, g: 24.79, t: '−145 °C' },
  saturn: { a: 9.537, year: 10759, day: 0.444, moons: 274, g: 10.44, t: '−178 °C' },
  uranus: { a: 19.19, year: 30687, day: -0.718, moons: 29, g: 8.87, t: '−224 °C' },
  neptune: { a: 30.07, year: 60190, day: 0.671, moons: 16, g: 11.15, t: '−214 °C' },
};

/** The day the moon counts in FACTS were last checked against JPL's list. */
export const MOONS_AS_OF = '2025-08-19';

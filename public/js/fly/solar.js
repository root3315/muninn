/**
 * solar.js — the Sun's planets and the Moon, where they are today, at their
 * real sizes, for the flight.
 *
 * Planets: JPL's Keplerian elements (ephemeris.js, "Approximate Positions of
 * the Planets", a few arcminutes to a tenth of a degree). Earth's row is the
 * Earth–Moon barycentre; at these scales that is the Earth. The Moon: the
 * low-precision series of the Astronomical Almanac (about 0.3° and 500 km),
 * plenty for a body a few pixels across until the camera is beside it.
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

/** The Moon from the Earth, ecliptic, in AU (Astronomical Almanac low-precision formulae). */
export function moonGeocentric(date) {
  const d = julian(date) - 2451545.0;
  const L = (218.316 + 13.176396 * d) * D2R;
  const M = (134.963 + 13.064993 * d) * D2R;
  const F = (93.272 + 13.22935 * d) * D2R;
  const lon = L + 6.289 * D2R * Math.sin(M);
  const lat = 5.128 * D2R * Math.sin(F);
  const km = 385001 - 20905 * Math.cos(M);
  const au = km / 149597870.7;
  return [au * Math.cos(lat) * Math.cos(lon), au * Math.cos(lat) * Math.sin(lon), au * Math.sin(lat)];
}

/**
 * Every body for a date: { key, en, ru, pos (pc, ICRS), radius (R☉), absMag
 * (the magnitude that gives its typical brightness at its typical distance),
 * col }.
 */
export function solarSystem(date = new Date()) {
  const T = (julian(date) - 2451545.0) / 36525;
  const earth = heliocentric('earth', T);
  return BODIES.map((b) => {
    let au;
    if (b.key === 'moon') {
      const g = moonGeocentric(date);
      au = [earth[0] + g[0], earth[1] + g[1], earth[2] + g[2]];
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

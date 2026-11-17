/**
 * maps.js — the whole sky on one flat page: galactic coordinates and the
 * Mollweide projection.
 *
 * The map is drawn the way all-sky surveys are shown (COBE, WMAP, Planck,
 * WISE): galactic longitude 0 — the centre of the Milky Way — in the middle,
 * longitude rising to the left, the Galaxy's plane along the equator. The
 * Mollweide projection keeps areas true, so a patch of sky looks as big as it
 * is wherever it lies on the map.
 */

import { vecOf, radecOf } from './healpix.js';

/**
 * ICRS → galactic rotation (Hipparcos and Tycho Catalogues, vol. 1, §1.5.3;
 * the matrix astropy uses). Rows are the galactic axes in ICRS.
 */
export const GALACTIC = [
  [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
  [0.4941094278755837, -0.4448296299600112, 0.7469822444972189],
  [-0.8676661490190047, -0.1980763734312015, 0.4559837761750669],
];

const SQRT2 = Math.SQRT2;
const DEG = Math.PI / 180;

export const toGalactic = (v) => GALACTIC.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
export const fromGalactic = (g) => [0, 1, 2].map((i) => GALACTIC[0][i] * g[0] + GALACTIC[1][i] * g[1] + GALACTIC[2][i] * g[2]);

/** Galactic longitude and latitude, degrees, of an ICRS position. */
export function galacticOf(ra, dec) {
  const { ra: l, dec: b } = radecOf(toGalactic(vecOf(ra, dec)));
  return { l, b };
}

/** The ICRS position of a galactic one. */
export const equatorialOf = (l, b) => radecOf(fromGalactic(vecOf(l, b)));

/**
 * Mollweide map coordinates of a galactic position: x in [−2√2, 2√2] with
 * longitude rising to the left, y in [−√2, √2] with north up.
 */
export function mollweide(l, b) {
  const L = ((((l + 180) % 360) + 360) % 360 - 180) * DEG;
  const target = Math.PI * Math.sin(b * DEG);
  // 2θ + sin 2θ = π sin b, by Newton's method from θ = b; it converges in a
  // few steps everywhere except at the poles, where θ = b exactly.
  let theta = b * DEG;
  if (Math.abs(b) < 90) {
    for (let i = 0; i < 30; i++) {
      const f = 2 * theta + Math.sin(2 * theta) - target;
      const d = 2 + 2 * Math.cos(2 * theta);
      if (Math.abs(d) < 1e-12) break;
      const step = f / d;
      theta -= step;
      if (Math.abs(step) < 1e-12) break;
    }
  }
  return { x: (-2 * SQRT2 / Math.PI) * L * Math.cos(theta), y: SQRT2 * Math.sin(theta) };
}

/** The galactic position at map coordinates, or null off the map. */
export function mollweideInverse(x, y) {
  if ((x * x) / 8 + (y * y) / 2 > 1) return null;
  const theta = Math.asin(Math.max(-1, Math.min(1, y / SQRT2)));
  const b = Math.asin(Math.max(-1, Math.min(1, (2 * theta + Math.sin(2 * theta)) / Math.PI)));
  const c = Math.cos(theta);
  const L = c < 1e-12 ? 0 : (-Math.PI * x) / (2 * SQRT2 * c);
  if (Math.abs(L) > Math.PI + 1e-9) return null;
  return { l: ((L / DEG) % 360 + 360) % 360, b: b / DEG };
}

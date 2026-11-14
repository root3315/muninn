/**
 * skydata.js — the sky as numbers the headset can draw, and nothing else.
 *
 * No three.js here and no DOM: positions, sizes and colours computed from the
 * catalogue with the same mapping the opening sky of the site uses (gate.js),
 * so the stars in the headset are the stars on the page.
 *
 * The frame is equatorial, J2000, with the observer at the centre of the
 * celestial sphere: +y is the north celestial pole, +x is RA 0 on the equator,
 * and RA grows toward −z. Seen from inside, looking south with north up, RA
 * then increases to the left, as it does on the real sky.
 */

import { starTint, starRadius, starAlpha, glowRadius, glowAlpha, paintBand } from '../gate.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** RA and Dec in degrees to a unit vector in the headset's frame. */
export function radecToVec(raDeg, decDeg) {
  const ra = raDeg * D2R;
  const dec = decDeg * D2R;
  const cd = Math.cos(dec);
  return [cd * Math.cos(ra), Math.sin(dec), -cd * Math.sin(ra)];
}

/** A direction in the headset's frame back to RA (0–360) and Dec, in degrees. */
export function vecToRadec([x, y, z]) {
  const len = Math.hypot(x, y, z) || 1;
  const dec = Math.asin(Math.max(-1, Math.min(1, y / len))) * R2D;
  const ra = ((Math.atan2(-z, x) * R2D) % 360 + 360) % 360;
  return [ra, dec];
}

/** The faintest star that gets a glow drawn under it: the site's richest tier. */
export const GLOW_TO = 5.0;

/**
 * The catalogue as buffers for one draw call.
 *
 *   positions  unit vectors, three per star, in catalogue order
 *   sizes      the core's radius in CSS pixels (gate.js starRadius)
 *   glows      the spread's radius in CSS pixels, 0 for a star too faint to have one
 *   colors     the tint (gate.js starTint), 0–1, three per star
 *   alphas     the core's opacity (starAlpha) and the glow's (glowAlpha), two per star
 */
export function starBuffers(stars) {
  const n = stars.count;
  const positions = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const glows = new Float32Array(n);
  const colors = new Float32Array(n * 3);
  const alphas = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = radecToVec(stars.ra[i], stars.dec[i]);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    const m = stars.mag[i];
    sizes[i] = starRadius(m);
    glows[i] = m <= GLOW_TO ? glowRadius(m) : 0;
    const [r, g, b] = starTint(stars.bv[i]);
    colors[i * 3] = r / 255;
    colors[i * 3 + 1] = g / 255;
    colors[i * 3 + 2] = b / 255;
    alphas[i * 2] = starAlpha(m);
    alphas[i * 2 + 1] = m <= GLOW_TO ? glowAlpha(m) : 0;
  }
  return { count: n, positions, sizes, glows, colors, alphas };
}

/**
 * The Milky Way model of gate.js as an equirectangular RGBA picture, `width`
 * across and half that high: RA 0 at the left edge growing to the right, Dec
 * +90 on the top row. Computed once.
 */
export function milkyWayPixels(width) {
  const W = Math.max(8, Math.round(width));
  const H = Math.round(W / 2);
  const data = new Uint8ClampedArray(W * H * 4);
  paintBand(data, W, H);
  return { width: W, height: H, data };
}

/** The angle between two unit vectors, in degrees. */
export function angleBetween(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, dot))) * R2D;
}

/**
 * The marker nearest a pointing direction, if it is within `maxDeg` of it.
 * Markers are `{ v: [x, y, z] }` unit vectors; returns the marker or null.
 */
export function nearestMarker(dir, markers, maxDeg) {
  let best = null;
  let bestAngle = maxDeg;
  for (const m of markers) {
    const a = angleBetween(dir, m.v);
    if (a <= bestAngle) { best = m; bestAngle = a; }
  }
  return best;
}

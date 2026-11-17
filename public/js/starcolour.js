/**
 * starcolour.js — a star's colour from its colour index, on its own so the
 * front page's sky, the flight and the survey renderer read it from one place.
 */

/**
 * Star colour from colour index.
 *
 * B−V to effective temperature by Ballesteros (2012), then temperature to a
 * screen colour by the usual blackbody approximation. A B star comes out blue
 * and Betelgeuse comes out orange because that is what they are.
 */
export function starColour(bv) {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const k = Math.max(1000, Math.min(40000, t)) / 100;
  let r;
  let g;
  let b;
  if (k <= 66) {
    r = 255;
    g = 99.47 * Math.log(k) - 161.12;
    b = k <= 19 ? 0 : 138.52 * Math.log(k - 10) - 305.04;
  } else {
    r = 329.7 * (k - 60) ** -0.1332;
    g = 288.12 * (k - 60) ** -0.0755;
    b = 255;
  }
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)];
}

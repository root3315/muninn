/**
 * render.js — turning surface brightness into something an eye can read.
 *
 * SPHEREx pixels are in MJy/sr and span a huge dynamic range: a bright star can
 * sit four orders of magnitude above the zodiacal background in the same frame.
 * A linear ramp would show a handful of white dots on black. So: clip at robust
 * percentiles, then bend the ramp.
 *
 * Colour ramps are declared as CSS custom properties and resolved through a 1×1
 * canvas, so the palette stays in the token layer instead of being hard-coded
 * here in RGB.
 */

const CLAMP01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

export const STRETCHES = {
  linear: (t) => t,
  sqrt: (t) => Math.sqrt(t),
  asinh: (t, a = 12) => Math.asinh(t * a) / Math.asinh(a),
  log: (t, a = 220) => Math.log1p(t * a) / Math.log1p(a),
};

/**
 * Robust low/high cut from the valid pixels.
 *
 * The black point is the choice that decides whether a frame reads as a star
 * field or as grey porridge. A flat low percentile leaves the whole sky
 * background sitting above black, and asinh then lifts that noise into visible
 * mottling. So the cut is placed relative to the noise itself: the sky's own
 * median plus `floorSigma` standard deviations, which puts the bulk of the
 * background under black and leaves real sources on a clean ground.
 *
 * Sigma comes from the lower half of the distribution (median minus the 15.87th
 * percentile), which stars cannot contaminate — they only ever push the upper
 * tail. `loPercent` stays as a hard floor so a frame that is nearly all source
 * still shows something.
 *
 * `hiPercent` is the user-facing knob — 99.5 keeps faint structure, 99.99 keeps
 * only the brightest cores from blowing out.
 */
export function limits(data, opts = {}) {
  return limitsFromSorted(sortedFinite(data), opts);
}

/**
 * The finite values of a frame, sorted. The expensive half of a cut, and it
 * does not depend on the clip at all — so a visit sorts once and the white
 * point slider only reads percentiles off it. Re-sorting ten frames on every
 * step of the slider was about a second of frozen page per step.
 *
 * Typed and sorted natively, for the reason skySigma gives: a plain Array of
 * two hundred thousand boxed numbers through a JS comparator took a quarter of
 * a second per frame.
 */
export function sortedFinite(data) {
  const Buf = ArrayBuffer.isView(data) ? data.constructor : Float64Array;
  const all = new Buf(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === v && v > -Infinity && v < Infinity) all[n++] = v;
  }
  const valid = all.subarray(0, n);
  valid.sort();
  return valid;
}

/** The cut, read off values already sorted by sortedFinite. */
export function limitsFromSorted(valid, { loPercent = 5, hiPercent = 99.5, floorSigma = 1 } = {}) {
  if (valid.length < 8) return { lo: 0, hi: 1, valid: valid.length };
  const at = (p) => valid[Math.min(valid.length - 1, Math.max(0, Math.round((p / 100) * (valid.length - 1))))];
  const median = at(50);
  const sigma = Math.max(median - at(15.87), 0);
  let lo = median + floorSigma * sigma;
  const floor = at(loPercent);
  if (!(lo > floor)) lo = floor;
  let hi = Math.max(at(hiPercent), lo + 4 * sigma);
  if (!(hi > lo)) hi = lo + 1e-6;
  return { lo, hi, sigma, valid: valid.length, median };
}

/**
 * Resolve any CSS colour — including `oklch(...)` — to an sRGB triple.
 * Painting it and reading the pixel back is the only way to get the browser's own
 * conversion, which keeps the ramps in the token layer instead of hard-coded here.
 */
let probeCtx = null;
export function resolveColor(css) {
  if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('color', css)) {
    throw new Error(`Not a colour the browser understands: ${css}`);
  }
  if (!probeCtx) {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    probeCtx = c.getContext('2d', { willReadFrequently: true });
  }
  probeCtx.clearRect(0, 0, 1, 1);
  probeCtx.fillStyle = css;
  probeCtx.fillRect(0, 0, 1, 1);
  const d = probeCtx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

/** Build a 256-entry lookup table from evenly spaced sRGB stops. */
export function ramp(stops) {
  const lut = new Uint8ClampedArray(256 * 3);
  const last = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * last;
    const k = Math.min(last - 1, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) {
      lut[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f;
    }
  }
  return lut;
}

/** Read a ramp declared as `--cmap-x: <colour>, <colour>, …` on an element. */
export function rampFromToken(el, token) {
  const raw = getComputedStyle(el).getPropertyValue(token).trim();
  if (!raw) throw new Error(`Colour ramp token ${token} is not defined`);
  const parts = raw.match(/(?:oklch|rgb|hsl|lab|lch|color)\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+/gi) ?? [];
  if (parts.length < 2) throw new Error(`Colour ramp token ${token} needs at least two stops`);
  return ramp(parts.map((p) => resolveColor(p)));
}

/**
 * Paint one frame into an ImageData.
 * `blank` is the colour used where the detector had no data (NaN) — the frame
 * edges after reprojection, and masked pixels.
 */
export function paint(target, data, lut, {
  lo, hi, stretch = 'asinh', softening, blank = [0, 0, 0], blankAlpha = 0,
} = {}) {
  const fn = STRETCHES[stretch] ?? STRETCHES.asinh;
  const span = hi - lo || 1e-6;
  const px = target.data;
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const v = data[i];
    if (!(v === v)) {
      px[p] = blank[0]; px[p + 1] = blank[1]; px[p + 2] = blank[2]; px[p + 3] = blankAlpha;
      continue;
    }
    const t = CLAMP01(fn(CLAMP01((v - lo) / span), softening));
    const k = (t * 255) | 0;
    px[p] = lut[k * 3];
    px[p + 1] = lut[k * 3 + 1];
    px[p + 2] = lut[k * 3 + 2];
    px[p + 3] = 255;
  }
  return target;
}

/**
 * Paint the difference between two aligned frames with a diverging ramp:
 * one end for "brighter now", the other for "brighter before", neutral in between.
 * Scaled by the noise of the difference itself so the zero point stays readable.
 */
export function paintDifference(target, a, b, lut, { sigmaSpan = 10, gamma = 1.9, blankAlpha = 0 } = {}) {
  const diff = new Float32Array(a.length).fill(NaN);
  // Typed and sorted natively: a boxed Array through a comparator made every
  // new A/B pair a second of frozen page.
  const all = new Float32Array(a.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === a[i] && b[i] === b[i]) {
      diff[i] = a[i] - b[i];
      all[m++] = Math.abs(diff[i]);
    }
  }
  if (!m) return { image: target, scale: 0 };
  const sample = all.subarray(0, m);
  sample.sort();
  // Median absolute deviation → a noise estimate that bright sources don't drag around.
  const mad = sample[Math.floor(m * 0.5)] || 1e-9;
  const scale = Math.max(mad * 1.4826 * sigmaSpan, 1e-9);

  const px = target.data;
  for (let i = 0, p = 0; i < diff.length; i++, p += 4) {
    const v = diff[i];
    if (!(v === v)) {
      px[p] = 0; px[p + 1] = 0; px[p + 2] = 0; px[p + 3] = blankAlpha;
      continue;
    }
    // Gamma on the signed ratio keeps noise sitting near the neutral middle of
    // the ramp, so only a real change reads as a colour.
    const u = Math.max(-1, Math.min(1, v / scale));
    const shaped = Math.sign(u) * Math.abs(u) ** gamma;
    const k = (CLAMP01((shaped + 1) / 2) * 255) | 0;
    px[p] = lut[k * 3];
    px[p + 1] = lut[k * 3 + 1];
    px[p + 2] = lut[k * 3 + 2];
    px[p + 3] = 255;
  }
  return { image: target, scale };
}

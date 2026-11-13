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

/** The value at percentile `p` of values already sorted. */
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];

/** The cut, read off values already sorted by sortedFinite. */
export function limitsFromSorted(valid, opts = {}) {
  return limitsFrom((p) => percentile(valid, p), valid.length, opts);
}

/** The cut, read off a quantileTable. */
export function limitsFromTable(table, opts = {}) {
  return limitsFrom((p) => table.at(p), table.n, opts);
}

/**
 * The few percentiles a cut is ever read from, kept in place of the sorted
 * pixels: the median and the noise points exactly, the white-point slider's
 * range (95 to 100) every 0.005, the rest every 0.1. Sixteen kilobytes a
 * visit, where the sorted copy was megabytes and so was thrown away — and
 * every step of the slider then sorted every visit again.
 */
const FINE_FROM = 95;
const FINE_STEP = 0.005;
const EXACT = [5, 15.87, 50];

export function quantileTable(sorted) {
  const n = sorted.length;
  const pick = (p) => (n ? percentile(sorted, p) : NaN);
  const coarse = Float64Array.from({ length: 1001 }, (_, i) => pick(i / 10));
  const fine = Float64Array.from({ length: Math.round((100 - FINE_FROM) / FINE_STEP) + 1 }, (_, i) => pick(FINE_FROM + i * FINE_STEP));
  const exact = new Map(EXACT.map((p) => [p, pick(p)]));
  return {
    n,
    at(p) {
      if (exact.has(p)) return exact.get(p);
      if (p >= FINE_FROM) return fine[Math.min(fine.length - 1, Math.round((p - FINE_FROM) / FINE_STEP))];
      return coarse[Math.max(0, Math.round(p * 10))];
    },
  };
}

function limitsFrom(at, n, { loPercent = 5, hiPercent = 99.5, floorSigma = 1 } = {}) {
  if (n < 8) return { lo: 0, hi: 1, valid: n };
  const median = at(50);
  const sigma = Math.max(median - at(15.87), 0);
  let lo = median + floorSigma * sigma;
  const floor = at(loPercent);
  if (!(lo > floor)) lo = floor;
  let hi = Math.max(at(hiPercent), lo + 4 * sigma);
  if (!(hi > lo)) hi = lo + 1e-6;
  return { lo, hi, sigma, valid: n, median };
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
 * For the eye only: the hole the pipeline leaves in a saturated star's core,
 * filled from its rim. A bright star came out as a white disc with a black
 * square in it, which reads as a broken picture. A blank region is filled
 * when at least half its rim is at or above the top of the stretch and it
 * does not reach the frame's edge, so the blank beyond the detector, which
 * meets sky, stays blank; the measured data are not touched.
 *
 * One pass over each region, where a pixel-at-a-time spread had taken up to
 * sixty-four passes over the whole frame on every repaint, and had crept out
 * along the frame's edge into the blank beyond it.
 */
export function fillCores(data, width, ceiling) {
  if (!(ceiling === ceiling)) return data;
  const n = data.length;
  const height = Math.floor(n / width);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let out = null;

  for (let s = 0; s < n; s++) {
    if (seen[s] || data[s] === data[s]) continue;
    let head = 0;
    let tail = 0;
    let rim = 0;
    let bright = 0;
    let top = -Infinity;
    let edge = false;
    seen[s] = 1;
    queue[tail++] = s;
    while (head < tail) {
      const k = queue[head++];
      const x = k % width;
      const y = (k - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true;
      for (let d = 0; d < 4; d++) {
        let j;
        if (d === 0) { if (x === 0) continue; j = k - 1; }
        else if (d === 1) { if (x === width - 1) continue; j = k + 1; }
        else if (d === 2) { if (y === 0) continue; j = k - width; }
        else { if (y === height - 1) continue; j = k + width; }
        const v = data[j];
        if (v === v) {
          rim++;
          if (v >= ceiling) { bright++; if (v > top) top = v; }
        } else if (!seen[j]) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    if (edge || bright * 2 < rim) continue;
    out ??= Float32Array.from(data);
    for (let i = 0; i < tail; i++) out[queue[i]] = top;
  }
  return fillWalled(out ?? data, width, height, ceiling);
}

/**
 * The seams between a whitened overflow and a filled hole: pixels the
 * pipeline left low but did not flag, dark threads through a white core.
 * Anything the top of the stretch walls in completely, so that it cannot be
 * reached from the frame's edge without crossing it, is part of the core.
 */
function fillWalled(cur, width, height, ceiling) {
  const n = cur.length;
  const open = new Uint8Array(n);
  const queue = new Int32Array(n);
  let tail = 0;
  const seed = (k) => {
    if (!open[k] && !(cur[k] >= ceiling)) { open[k] = 1; queue[tail++] = k; }
  };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  for (let head = 0; head < tail; head++) {
    const k = queue[head];
    const x = k % width;
    if (x > 0) seed(k - 1);
    if (x < width - 1) seed(k + 1);
    if (k >= width) seed(k - width);
    if (k + width < n) seed(k + width);
  }
  let walled = null;
  for (let k = 0; k < n; k++) {
    if (open[k] || cur[k] >= ceiling) continue;
    walled ??= Float32Array.from(cur);
    walled[k] = ceiling;
  }
  return walled ?? cur;
}

/**
 * For the eye only, like fillCores: a pixel the detector flagged OVERFLOW ran
 * past its well, so whatever value the ramp left in it (often low, sometimes
 * nonsense) is not the sky. Shown at least at the top of the stretch, the
 * core of a bright star is white instead of a black dot in a white disc, and
 * the blanked pixels it walls in are filled from it. `quality` is the stamp's
 * plane (bit 1, OVERFLOW); every other pixel is left as it is, and the
 * measured data are not touched.
 */
export function whitenOverflow(data, quality, ceiling) {
  if (!quality || !(ceiling === ceiling)) return data;
  let out = null;
  for (let i = 0; i < data.length; i++) {
    if (!(quality[i] & 1) || data[i] >= ceiling) continue;
    out ??= Float32Array.from(data);
    out[i] = ceiling;
  }
  return out ?? data;
}

/**
 * Paint one frame into an ImageData.
 * `blank` is the colour used where the detector had no data (NaN) — the frame
 * edges after reprojection, and masked pixels.
 */
export function paint(target, data, lut, {
  lo, hi, stretch = 'asinh', softening, blank = [0, 0, 0], blankAlpha = 0, quality = null,
} = {}) {
  data = fillCores(whitenOverflow(data, quality, hi), target.width, hi);
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

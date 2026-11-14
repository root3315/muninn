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

/** A stretch as a table from 0–1 (in 65,536 steps) to a colour index 0–255, kept per curve. */
const STRETCH_STEPS = 65536;
const stretchTables = new Map();
function stretchTable(fn, softening) {
  const key = `${Object.keys(STRETCHES).find((k) => STRETCHES[k] === fn) ?? 'custom'}|${softening ?? ''}`;
  let table = stretchTables.get(key);
  if (!table) {
    table = new Uint8Array(STRETCH_STEPS);
    for (let k = 0; k < STRETCH_STEPS; k++) table[k] = (CLAMP01(fn(k / (STRETCH_STEPS - 1), softening)) * 255) | 0;
    if (key.startsWith('custom')) return table;
    stretchTables.set(key, table);
  }
  return table;
}

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
  return limitsFrom((p) => quantileAt(table, p), table.n, opts);
}

/**
 * The few percentiles a cut is ever read from, kept in place of the sorted
 * pixels: the median and the noise points exactly, the white-point slider's
 * range (95 to 100) every 0.005, the rest every 0.1. Sixteen kilobytes a
 * visit, where the sorted copy was megabytes and so was thrown away — and
 * every step of the slider then sorted every visit again. Plain arrays, so a
 * worker can hand one over with the visit it read.
 */
const FINE_FROM = 95;
const FINE_STEP = 0.005;
const EXACT = [5, 15.87, 50];

export function quantileTable(sorted) {
  const n = sorted.length;
  const pick = (p) => (n ? percentile(sorted, p) : NaN);
  const coarse = Float64Array.from({ length: 1001 }, (_, i) => pick(i / 10));
  const fine = Float64Array.from({ length: Math.round((100 - FINE_FROM) / FINE_STEP) + 1 }, (_, i) => pick(FINE_FROM + i * FINE_STEP));
  const exact = Float64Array.from(EXACT, pick);
  return { n, coarse, fine, exact };
}

/** The value at percentile `p`, read off a quantileTable. */
export function quantileAt(table, p) {
  const k = EXACT.indexOf(p);
  if (k >= 0) return table.exact[k];
  if (p >= FINE_FROM) return table.fine[Math.min(table.fine.length - 1, Math.round((p - FINE_FROM) / FINE_STEP))];
  return table.coarse[Math.max(0, Math.round(p * 10))];
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
 * square in it, which reads as a broken picture. A blank region that does
 * not reach the frame's edge is filled white when at least half its rim is
 * at or above the top of the stretch, and smoothly from its rim when only
 * part of it is (a masked block beside the core, its other sides in the
 * star's glow), as is a pinhole of a few pixels walled in by bright glow,
 * and a hole of any size with half its rim or more clear above the sky:
 * a star the pipeline masked short of saturation, which had come out as a
 * black blob in a grey disc. A blank whose rim is mostly sky stays blank, as
 * does the blank beyond the detector; the measured data are not touched.
 *
 * One pass over each region, where a pixel-at-a-time spread had taken up to
 * sixty-four passes over the whole frame on every repaint, and had crept out
 * along the frame's edge into the blank beyond it.
 *
 * Only a star's core is filled: a region of more than `cap` samples (see
 * coreCap) is left blank. Around a very bright star the pipeline closes
 * arcminutes of sky, and filling that from its rim made a white disc that
 * was never measured.
 */
export function fillCores(data, width, ceiling, cap = Infinity) {
  if (!(ceiling === ceiling)) return data;
  const n = data.length;
  const height = Math.floor(n / width);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let out = null;
  let glow = Infinity;

  for (let s = 0; s < n; s++) {
    if (seen[s] || data[s] === data[s]) continue;
    if (glow === Infinity) {
      const sky = skyOf(data);
      glow = sky.level + GLOW_SIGMA * sky.sigma;
    }
    let head = 0;
    let tail = 0;
    let rim = 0;
    let bright = 0;
    let dim = 0;
    let lit = 0;
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
          if (v > glow) lit++;
          if (v >= ceiling) { bright++; if (v > top) top = v; }
          if (v < ceiling / 2) dim++;
        } else if (!seen[j]) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    // A pinhole of a few pixels deep in a star's glow is filled too.
    const pinhole = tail <= 9 && !dim;
    // And a hole of any size that lies, half its rim or more, in a source's light.
    const inLight = rim > 0 && lit * 2 >= rim;
    if (edge || tail > cap || !(bright || pinhole || inLight)) continue;
    out ??= Float32Array.from(data);
    if (bright * 2 >= rim) {
      for (let i = 0; i < tail; i++) out[queue[i]] = top;
    } else {
      // A masked block against the core on one side and the star's glow on
      // the others: filled from its rim inwards, so it takes the glow's
      // values where it meets the glow and the core's where it meets the core.
      fillFromRim(out, width, height, queue.subarray(0, tail));
    }
  }
  return fillWalled(out ?? data, width, height, ceiling, cap);
}

/** How far above the sky, in its own noise, a pixel of a hole's rim must stand to count as lying in a source's light. */
const GLOW_SIGMA = 5;

/**
 * The widest saturated core the display still paints as a star, in detector
 * pixels across: a dozen, a few widths of SPHEREx's point-spread function.
 * A star of V 5 or 6 saturates a handful of pixels; Arcturus (V −0.05)
 * saturates a disc four arcminutes across, forty pixels, and the pipeline
 * closes most of the sky round it.
 */
export const CORE_CAP_PX = 12;

/** CORE_CAP_PX as an area in grid samples, for a grid cut `samplesPerPixel` samples to a detector pixel. */
export const coreCap = (samplesPerPixel) => Math.round(Math.PI * (CORE_CAP_PX / 2) ** 2 * samplesPerPixel ** 2);

/**
 * The saturated regions of a frame too large to be a star's core: each
 * eight-connected run of OVERFLOW samples (QUALITY.OVERFLOW, bit 1) of more
 * than `cap` samples, with the samples it walls in. Each comes back with its
 * samples, its centre and its reach (the farthest sample from the centre),
 * for the display to draw it as what it is: pixels nobody measured.
 */
export function saturatedPatches(quality, width, height, cap) {
  if (!quality || !(cap < Infinity)) return [];
  const n = width * height;
  const label = new Int32Array(n);
  const queue = new Int32Array(n);
  const patches = [];
  for (let s = 0; s < n; s++) {
    if (label[s] || !(quality[s] & 1)) continue;
    const id = patches.length + 1;
    let tail = 0;
    label[s] = id;
    queue[tail++] = s;
    for (let head = 0; head < tail; head++) {
      const k = queue[head];
      const x = k % width;
      const y = (k - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const j = yy * width + xx;
          if (!label[j] && quality[j] & 1) { label[j] = id; queue[tail++] = j; }
        }
      }
    }
    patches.push(tail > cap ? Array.from(queue.subarray(0, tail)) : null);
  }
  const big = patches.map((p, i) => (p ? i + 1 : 0)).filter(Boolean);
  if (!big.length) return [];
  const keep = new Set(big);
  for (let k = 0; k < n; k++) if (label[k] && !keep.has(label[k])) label[k] = 0;
  addWalledIn(label, patches, width, height);
  return big.map((id) => describePatch(patches[id - 1], width));
}

/**
 * The samples a large patch walls in — sky that cannot be reached from the
 * frame's edge without crossing it — are given to the patch they touch.
 */
function addWalledIn(label, patches, width, height) {
  const n = label.length;
  const open = new Uint8Array(n);
  const queue = new Int32Array(n);
  let tail = 0;
  const seed = (k) => { if (!open[k] && !label[k]) { open[k] = 1; queue[tail++] = k; } };
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
  for (let k = 0; k < n; k++) {
    if (open[k] || label[k]) continue;
    // An enclosed pocket: flood it, and hand it to a patch on its rim.
    let head = 0;
    tail = 0;
    let owner = 0;
    open[k] = 1;
    queue[tail++] = k;
    while (head < tail) {
      const c = queue[head++];
      const x = c % width;
      for (const j of [x > 0 ? c - 1 : -1, x < width - 1 ? c + 1 : -1, c - width, c + width]) {
        if (j < 0 || j >= n) continue;
        if (label[j]) owner ||= label[j];
        else if (!open[j]) { open[j] = 1; queue[tail++] = j; }
      }
    }
    if (!owner) continue;
    for (let i = 0; i < tail; i++) { label[queue[i]] = owner; patches[owner - 1].push(queue[i]); }
  }
}

function describePatch(cells, width) {
  let sx = 0;
  let sy = 0;
  for (const k of cells) { sx += k % width; sy += Math.floor(k / width); }
  const ci = sx / cells.length;
  const cj = sy / cells.length;
  let reach = 0;
  for (const k of cells) reach = Math.max(reach, Math.hypot((k % width) - ci, Math.floor(k / width) - cj));
  return { cells: Int32Array.from(cells), area: cells.length, ci, cj, reach };
}

/**
 * For the eye only: every sample of a large saturated patch set to the sky's
 * own level, a flat neutral tone that says "nothing measured here" where a
 * white disc had said "a very bright star, this size".
 */
export function flattenPatches(data, patches) {
  if (!patches?.length) return data;
  const out = Float32Array.from(data);
  const level = skyOf(data).level;
  for (const p of patches) for (const k of p.cells) out[k] = level;
  return out;
}

/**
 * The sky's level and spread, from a sparse sample of the frame: the median
 * of its finite pixels, and a sigma from the half below it, which the stars
 * do not reach (a Gaussian's lower quartile is 0.674 sigma under its median).
 */
export function skyOf(data) {
  const step = Math.max(1, Math.floor(data.length / 8192));
  const sample = [];
  for (let i = 0; i < data.length; i += step) if (data[i] === data[i]) sample.push(data[i]);
  if (!sample.length) return { level: Infinity, sigma: 0 };
  sample.sort((a, b) => a - b);
  const level = sample[sample.length >> 1];
  return { level, sigma: (level - sample[sample.length >> 2]) / 0.6745 };
}

/**
 * Fill a blank region layer by layer from its rim: each pass gives every
 * blank pixel that touches a filled one the mean of its filled neighbours,
 * until none is left. `cells` lists the region's pixel indices.
 */
function fillFromRim(out, width, height, cells) {
  let left = cells.length;
  const value = new Float64Array(cells.length);
  const ready = new Uint8Array(cells.length);
  while (left > 0) {
    let filled = 0;
    for (let i = 0; i < cells.length; i++) {
      const k = cells[i];
      if (out[k] === out[k]) continue;
      const x = k % width;
      const y = (k - x) / width;
      let sum = 0;
      let n = 0;
      if (x > 0 && out[k - 1] === out[k - 1]) { sum += out[k - 1]; n++; }
      if (x < width - 1 && out[k + 1] === out[k + 1]) { sum += out[k + 1]; n++; }
      if (y > 0 && out[k - width] === out[k - width]) { sum += out[k - width]; n++; }
      if (y < height - 1 && out[k + width] === out[k + width]) { sum += out[k + width]; n++; }
      if (n) { value[i] = sum / n; ready[i] = 1; filled++; }
    }
    if (!filled) return;
    // Written after the pass, so one layer does not feed itself.
    for (let i = 0; i < cells.length; i++) {
      if (ready[i]) { out[cells[i]] = value[i]; ready[i] = 0; left--; }
    }
  }
}

/**
 * The seams between a whitened overflow and a filled hole: pixels the
 * pipeline left low but did not flag, dark threads through a white core.
 * Anything the top of the stretch walls in completely, so that it cannot be
 * reached from the frame's edge without crossing it, is part of the core.
 */
function fillWalled(cur, width, height, ceiling, cap = Infinity) {
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
  // What is walled in is a core only up to the cap: a larger pocket is a
  // patch the pipeline closed (or one shown flat, see flattenPatches).
  let walled = null;
  for (let s = 0; s < n; s++) {
    if (open[s] || cur[s] >= ceiling) continue;
    let head = 0;
    tail = 0;
    open[s] = 1;
    queue[tail++] = s;
    while (head < tail) {
      const k = queue[head++];
      const x = k % width;
      for (const j of [x > 0 ? k - 1 : -1, x < width - 1 ? k + 1 : -1, k - width, k + width]) {
        if (j >= 0 && j < n && !open[j] && !(cur[j] >= ceiling)) { open[j] = 1; queue[tail++] = j; }
      }
    }
    if (tail > cap) continue;
    walled ??= Float32Array.from(cur);
    for (let i = 0; i < tail; i++) walled[queue[i]] = ceiling;
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
 *
 * `cap` is the largest hole, in samples, that is filled as a star's core
 * (coreCap); `patches` the saturated regions larger than that
 * (saturatedPatches), painted flat at the sky's level instead of white.
 */
export function paint(target, data, lut, {
  lo, hi, stretch = 'asinh', softening, blank = [0, 0, 0], blankAlpha = 0, quality = null,
  cap = Infinity, patches = null,
} = {}) {
  data = fillCores(flattenPatches(whitenOverflow(data, quality, hi), patches), target.width, hi, cap);
  const fn = STRETCHES[stretch] ?? STRETCHES.asinh;
  const span = hi - lo || 1e-6;
  const px = target.data;
  // The stretch is a curve from 0–1 to a colour index: worked out once over a
  // fine table, not once per pixel. A frame is seven hundred thousand pixels,
  // and an asinh for each was most of the time a phone spent on a new frame.
  const table = stretchTable(fn, softening);
  const last = table.length - 1;
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const v = data[i];
    if (!(v === v)) {
      px[p] = blank[0]; px[p + 1] = blank[1]; px[p + 2] = blank[2]; px[p + 3] = blankAlpha;
      continue;
    }
    const u = (v - lo) / span;
    const k = table[u <= 0 ? 0 : u >= 1 ? last : (u * last + 0.5) | 0];
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

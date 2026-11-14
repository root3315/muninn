// Planting a point source into a stamp that was cut from a real frame.
//
// The source is put where a real one would be: on the detector pixels first,
// as a Gaussian of the frame's PSF width sampled at each pixel's centre, and
// then carried onto the resampled grid by the same bilinear interpolation
// stamp.js uses, so the grid sees it smoothed exactly the way it sees a star.
// The detector patch the stamp keeps (for the single-pixel test in
// sharpness.js) gets the same pixels, so that test reads the planted source too.
//
// Amplitude is the Gaussian's peak, in the frame's own units (MJy/sr). A
// source centred on a pixel puts exactly that much into it.

const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.log(2));

/** The Gaussian's value at FITS pixel (x, y) for a source at FITS (px, py). */
export function gaussianAt(x, y, px, py, amplitude, fwhmPx) {
  const s = fwhmPx / FWHM_PER_SIGMA;
  return amplitude * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * s * s));
}

/**
 * The value stamp.js's resampler would produce at FITS position (fx, fy) from
 * detector pixels holding nothing but this source: the bilinear blend of the
 * four pixel centres around it.
 */
export function resampledAt(fx, fy, px, py, amplitude, fwhmPx) {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const g = (x, y) => gaussianAt(x, y, px, py, amplitude, fwhmPx);
  return g(x0, y0) * (1 - tx) * (1 - ty) + g(x0 + 1, y0) * tx * (1 - ty)
    + g(x0, y0 + 1) * (1 - tx) * ty + g(x0 + 1, y0 + 1) * tx * ty;
}

/**
 * Add a source at (ra, dec) to one visit's stamp, in place.
 *
 * `stamp` is what loadStamp returns (data, width, height, wcs, detector);
 * `grid` the TangentGrid it was cut on. Returns an undo function that puts
 * every touched value back exactly as it was. Masked samples (NaN) stay masked.
 */
export function injectSource(stamp, grid, ra, dec, { amplitude, fwhmPx }) {
  const saved = [];
  const p = stamp.wcs.worldToPix(ra, dec);
  if (!p) return () => {};
  const reachPx = Math.ceil(4 * (fwhmPx / FWHM_PER_SIGMA)) + 2;

  // The grid: every sample within reach of the source.
  const g = grid.worldToIndex(ra, dec);
  if (g) {
    const perPixel = stamp.wcs.scale / grid.scale;
    const reach = Math.ceil(reachPx * perPixel);
    const ci = Math.round(g[0]);
    const cj = Math.round(g[1]);
    const { data, width: W, height: H } = stamp;
    for (let j = Math.max(0, cj - reach); j <= Math.min(H - 1, cj + reach); j++) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(W - 1, ci + reach); i++) {
        const k = j * W + i;
        const v = data[k];
        if (!(v === v)) continue;
        const world = grid.indexToWorld(i, j);
        const q = world && stamp.wcs.worldToPix(world[0], world[1]);
        if (!q) continue;
        const add = resampledAt(q[0], q[1], p[0], p[1], amplitude, fwhmPx);
        if (!(add > 0)) continue;
        saved.push([data, k, v]);
        data[k] = v + add;
      }
    }
  }

  // The detector patch: (x0 + i, y0 + j) is the FITS pixel of data[j * width + i].
  const det = stamp.detector;
  if (det?.data) {
    const ci = Math.round(p[0]) - det.x0;
    const cj = Math.round(p[1]) - det.y0;
    for (let j = Math.max(0, cj - reachPx); j <= Math.min(det.height - 1, cj + reachPx); j++) {
      for (let i = Math.max(0, ci - reachPx); i <= Math.min(det.width - 1, ci + reachPx); i++) {
        const k = j * det.width + i;
        const v = det.data[k];
        if (!(v === v)) continue;
        saved.push([det.data, k, v]);
        det.data[k] = v + gaussianAt(det.x0 + i, det.y0 + j, p[0], p[1], amplitude, fwhmPx);
      }
    }
  }

  return () => {
    for (let n = saved.length - 1; n >= 0; n--) {
      const [arr, k, v] = saved[n];
      arr[k] = v;
    }
  };
}

/**
 * Where a linear mover is at each visit: `mid` is its position (grid samples)
 * halfway through the run in time, `dir` a unit vector, `lengthSamples` the
 * whole run's displacement. Returns grid positions in visit order.
 */
export function linearTrack(mjds, mid, dir, lengthSamples) {
  const t0 = mjds[0];
  const span = mjds[mjds.length - 1] - t0;
  return mjds.map((t) => {
    const f = span > 0 ? (t - t0) / span - 0.5 : 0;
    return [mid[0] + f * lengthSamples * dir[0], mid[1] + f * lengthSamples * dir[1]];
  });
}

/** A small seeded generator (mulberry32), so a run can be repeated exactly. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

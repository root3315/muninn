/**
 * depth.js — how faint a thing this field could have shown you.
 *
 * A search that finds nothing has found something, but only if you can say how
 * deep you looked. This turns the pixels already on screen into that statement:
 * the robust noise of blank sky, the flux it corresponds to through the pixel's
 * solid angle, and the 5σ point-source limit that follows.
 *
 * The same functions back `tools/sensitivity.mjs`, so the number printed in the
 * interface and the number in the write-up cannot drift apart.
 *
 * Measured, not quoted: `tools/sensitivity.mjs` over real D1–D6 frames gives
 * 17.61 AB for a single visit, from the detector's own pixels. On a D2 frame
 * of the Atala field the pipeline's own VARIANCE plane (about 0.0005 (MJy/sr)²
 * per blank pixel) says 0.022 MJy/sr against the 0.025 measured here — about
 * 0.1 mag apart, the robust estimate on the cautious side.
 */

/** SPHEREx delivers 6.15″ pixels. */
export const DETECTOR_ARCSEC = 6.15;
const RAD_PER_ARCSEC = Math.PI / (180 * 3600);
export const PIXEL_SR = (DETECTOR_ARCSEC * RAD_PER_ARCSEC) ** 2;

/**
 * A point source is spread over the PSF; a 3×3 box holds most of it and is what
 * the mark photometry already sums, so the noise it fights is the same.
 */
export const APERTURE_PX = 9;

/** 3631 Jy is AB magnitude zero, by definition. */
const AB_ZERO_JY = 3631;

const median = (sorted) => sorted[sorted.length >> 1];

/**
 * Robust noise of blank sky, in MJy/sr.
 *
 * Taken from the lower half of the distribution: for a Gaussian the median minus
 * the 15.87th percentile is exactly one sigma, and sources can only ever push
 * the upper tail, so they cannot touch this estimate at all.
 *
 * Trimming the bright tail and taking a median absolute deviation was the
 * obvious alternative, and it reads 8% low — truncating one side of a Gaussian
 * biases the deviations that remain. Eight per cent is 0.09 magnitudes, which is
 * small but would be wrong in a number this project quotes.
 */
export function skySigma(data) {
  // A typed array sorted natively, not a plain Array sorted through a
  // comparator. The values are already numbers in a typed buffer; boxing a
  // third of a million of them and calling a JS comparator log n times per
  // element turned this into tens of seconds of one unbroken task, which is
  // long enough for the browser to stop answering the page at all.
  const Buf = ArrayBuffer.isView(data) ? data.constructor : Float64Array;
  const valid = new Buf(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    // NaN fails the first test; the infinities fail the second. Written out
    // rather than through Number.isFinite because this runs once per pixel.
    if (v === v && v > -Infinity && v < Infinity) valid[n++] = v;
  }
  const kept = valid.subarray(0, n);
  kept.sort();
  return skySigmaFromSorted(kept);
}

/** The same, from the finite pixels already sorted. */
export function skySigmaFromSorted(kept) {
  const n = kept.length;
  if (n < 200) return null;
  const at = (p) => kept[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const sigma = at(0.5) - at(0.1587);
  return sigma > 0 ? sigma : null;
}

/**
 * A flux summed over detector pixels, in MJy/sr · pixel, as an AB magnitude.
 * The same conversion the depth limit goes through, so a measured source and
 * the limit it is compared with are on one scale.
 */
export function magAB(sumMJySrPixels) {
  if (!(sumMJySrPixels > 0)) return null;
  return -2.5 * Math.log10((sumMJySrPixels * 1e6 * PIXEL_SR) / AB_ZERO_JY);
}

/** The 5σ point-source limit for one frame of that noise, as an AB magnitude. */
export function limitAB(sigmaMJySr, { sigma = 5, aperturePx = APERTURE_PX } = {}) {
  if (!(sigmaMJySr > 0)) return null;
  const jyPerPixel = sigmaMJySr * 1e6 * PIXEL_SR;
  const apertureNoiseJy = jyPerPixel * Math.sqrt(aperturePx);
  return -2.5 * Math.log10((sigma * apertureNoiseJy) / AB_ZERO_JY);
}

/**
 * What the whole stack of visits reaches.
 *
 * Coadding n frames of equal depth beats the noise down by √n, which is 2.5·log₁₀√n
 * magnitudes. Visits of different bands are not coadded — they are different
 * measurements. The band chosen is the one whose single visit goes deepest,
 * because a single visit is what the search works at; choosing by the stack let
 * eight shallow D1 visits outvote two deeper D2 ones and understate the depth.
 */
export function stackDepth(perVisit) {
  const byBand = new Map();
  for (const { band, sigma } of perVisit) {
    if (!(sigma > 0)) continue;
    if (!byBand.has(band)) byBand.set(band, []);
    byBand.get(band).push(sigma);
  }
  let best = null;
  for (const [band, sigmas] of byBand) {
    sigmas.sort((a, b) => a - b);
    const single = limitAB(median(sigmas));
    if (single == null) continue;
    const stacked = single + 2.5 * Math.log10(Math.sqrt(sigmas.length));
    if (!best || single > best.single) best = { band, n: sigmas.length, single, stacked };
  }
  return best;
}

/**
 * Predicted brightness of Planet Nine near aphelion, in reflected light:
 * Linder & Mordasini 2016 (A&A 589, A134) give V = 24.3 to 22.6 for 5 to 50
 * Earth masses. Their nominal 10-Earth-mass planet at 700 AU is brighter, 21.7. Quoted in V; SPHEREx works at 0.75–5 µm, where a cold body
 * reflects less, so treating an AB limit as directly comparable is generous to
 * us rather than to the prediction.
 */
export const PLANET_NINE_V = { bright: 22.6, faint: 24.3 };

/** How far short of the prediction a given depth falls. */
export function shortfall(stackedAB) {
  if (stackedAB == null) return null;
  const gap = PLANET_NINE_V.bright - stackedAB;
  return { magnitudes: gap, fluxFactor: 10 ** (0.4 * gap) };
}

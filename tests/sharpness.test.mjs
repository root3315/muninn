/**
 * Star's shape or single pixel. A synthetic star blurred as SPHEREx blurs
 * one, against a single-pixel spike; then the real detector pixels the
 * threshold was set on: the 6 Jul 2025 cosmic ray of the Atala field with its
 * FLAGS mask lifted, and (152) Atala itself on 25 Dec 2025.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sharpness, sharpnessAt, sharpVerdict, tooSharp, STAR_MAX_SHARE, MIN_JUDGED_SNR } from '../public/js/sharpness.js';
import { WCS } from '../public/js/wcs.js';

const SIZE = 21;
const BG = 0.4;

/** A patch of flat sky with an optional point source, integrated over each pixel. */
function patch({ x = 10, y = 10, flux = 0, fwhm = 1.1, spike = 0 } = {}) {
  const data = new Float32Array(SIZE * SIZE).fill(BG);
  const s = fwhm / 2.3548;
  const cdf = (u) => 0.5 * (1 + erf(u / (s * Math.SQRT2)));
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const fx = cdf(i + 0.5 - x) - cdf(i - 0.5 - x);
      const fy = cdf(j + 0.5 - y) - cdf(j - 0.5 - y);
      data[j * SIZE + i] += flux * fx * fy;
    }
  }
  data[10 * SIZE + 10] += spike;
  return { data, width: SIZE, height: SIZE };
}

// Abramowitz & Stegun 7.1.26, good to 1.5e-7: enough for a test fixture.
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496735) * t + 0.254829592) * t * Math.exp(-x * x);
  return Math.sign(x) * y;
}

const SIGMA = 0.02;

test('a star spread by the optics reads as a star, wherever it falls in its pixel', () => {
  for (const [x, y] of [[10, 10], [10.3, 9.8], [10.5, 10.5]]) {
    const s = sharpnessAt(patch({ x, y, flux: 20 }), 10, 10);
    assert.ok(s.share < STAR_MAX_SHARE, `share ${s.share} at ${x},${y}`);
    const v = sharpVerdict(s, SIGMA);
    assert.equal(v.verdict, 'star');
    assert.ok(!tooSharp(v));
  }
});

test('a single-pixel spike reads as too sharp, with its share and the bar', () => {
  const s = sharpnessAt(patch({ spike: 4 }), 10, 10);
  assert.ok(Math.abs(s.share - 1) < 1e-6);
  assert.equal(s.ratio, Infinity);
  const v = sharpVerdict(s, SIGMA);
  assert.equal(v.verdict, 'sharp');
  assert.ok(tooSharp(v));
  assert.ok(v.limit > STAR_MAX_SHARE && v.limit < 1);
});

test('a faint flash is not judged: its neighbours could be at nothing by chance', () => {
  const sigma = 1;
  const s = sharpnessAt(patch({ spike: 20 }), 10, 10);
  const v = sharpVerdict(s, sigma);
  assert.ok(20 < MIN_JUDGED_SNR);
  assert.equal(v.verdict, 'faint');
  assert.equal(v.limit, null);
  assert.ok(!tooSharp(v));
});

test('no answer off the patch or on a masked centre', () => {
  const p = patch({ spike: 4 });
  assert.equal(sharpnessAt(p, 1, 1), null);
  p.data[10 * SIZE + 10] = NaN;
  for (const k of [9, 11]) p.data[10 * SIZE + k] = NaN;
  // The search moves to the brightest good pixel near the position.
  const s = sharpnessAt(p, 10, 10, { search: 0 });
  assert.equal(s, null);
});

/*
 * The real thing. Detector pixels (MJy/sr, 11 × 11 about the brightest one)
 * from DR1 D2 frames of the Atala field, read by tools/sharpness-calibrate.mjs:
 *   level2_2025W27_2A_0674_1D2_spx_l2b-v27-2026-215.fits, 6 Jul 2025, the pixel
 *     the pipeline flagged 0x45 (TRANSIENT, SUR_ERROR, NONFUNC), mask lifted;
 *   level2_2025W52_2A_0043_1D2_spx_l2b-v27-2026-211.fits, 25 Dec 2025,
 *     (152) Atala, V 13.8.
 */
const real = JSON.parse(readFileSync(new URL('./sharpness-atala.json', import.meta.url), 'utf8'));

const asPatch = (box) => ({ data: Float32Array.from(box.flat()), width: box[0].length, height: box.length });

test('the 6 Jul 2025 cosmic ray, unmasked, is too sharp for a star', () => {
  const c = real.cosmicRay;
  const s = sharpnessAt(asPatch(c.box), 5, 5, { search: 0 });
  assert.ok(s.share > 0.97, `share ${s.share}`);
  const v = sharpVerdict(s, c.detectorSigma);
  assert.equal(v.verdict, 'sharp');
  assert.ok(v.snr > 100);
});

test('(152) Atala on 25 Dec 2025 is spread like a star, not a cosmic ray', () => {
  const a = real.atala;
  const s = sharpnessAt(asPatch(a.box), 5, 5, { search: 0 });
  assert.ok(s.share < 0.5, `share ${s.share}`);
  const v = sharpVerdict(s, a.detectorSigma);
  assert.equal(v.verdict, 'star');
  assert.ok(v.share < v.limit);
});

test('the position is found through the frame\'s own WCS, as a worker hands it on', () => {
  const a = real.atala;
  // The fixture keeps the WCS as plain fields, the shape it crosses from the
  // worker in: no prototype, no methods.
  const det = { ...asPatch(a.box), x0: a.pixel[0] - 5, y0: a.pixel[1] - 5, wcs: a.wcs };
  const [ra, dec] = WCS.prototype.pixToWorld.call(a.wcs, a.pixel[0], a.pixel[1]);
  const s = sharpness(det, ra, dec);
  assert.deepEqual(s.pixel, [5, 5]);
  assert.equal(s.share, sharpnessAt(det, 5, 5, { search: 0 }).share);
});

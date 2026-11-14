/**
 * The source the Hunter X benchmark plants: where it lands, how bright it is
 * on the detector and on the grid, and that taking it out leaves the stamp as
 * it was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WCS, TangentGrid } from '../public/js/wcs.js';
import { gaussianAt, resampledAt, injectSource, linearTrack, seeded } from '../tools/hunter-inject.mjs';

const PIXEL_DEG = 6.15 / 3600;
const RA = 50;
const DEC = 10;

/** A detector 64 pixels square, north up, centred on (RA, DEC), and a grid 2.5 times finer over it. */
function setup() {
  const wcs = new WCS(new Map(Object.entries({
    CRPIX1: 32.5, CRPIX2: 32.5, CRVAL1: RA, CRVAL2: DEC, NAXIS1: 64, NAXIS2: 64,
    CD1_1: -PIXEL_DEG, CD1_2: 0, CD2_1: 0, CD2_2: PIXEL_DEG,
  })));
  const size = 101;
  const grid = new TangentGrid(RA, DEC, (size * PIXEL_DEG) / 2.5, size, size);
  const stamp = {
    data: new Float32Array(size * size).fill(1),
    width: size,
    height: size,
    wcs,
    detector: { data: new Float32Array(64 * 64).fill(1), width: 64, height: 64, x0: 1, y0: 1, wcs },
  };
  stamp.data[0] = NaN;
  return { wcs, grid, stamp };
}

test('the Gaussian peaks at its amplitude and halves at half the FWHM', () => {
  assert.equal(gaussianAt(10, 10, 10, 10, 5, 2), 5);
  assert.ok(Math.abs(gaussianAt(11, 10, 10, 10, 5, 2) - 2.5) < 1e-12);
  // On a pixel centre the resampled value is the pixel's own.
  assert.ok(Math.abs(resampledAt(10, 10, 10, 10, 5, 2) - 5) < 1e-12);
});

test('a planted source sits where it was put, at its amplitude, on both planes', () => {
  const { wcs, grid, stamp } = setup();
  const [ra, dec] = wcs.pixToWorld(30, 34); // on a detector pixel centre
  const undo = injectSource(stamp, grid, ra, dec, { amplitude: 4, fwhmPx: 1.3 });

  // Detector: the pixel at FITS (30, 34) holds the whole peak.
  const det = stamp.detector;
  assert.ok(Math.abs(det.data[(34 - 1) * 64 + (30 - 1)] - 5) < 1e-5);

  // Grid: the brightest sample is at the source, within half a sample.
  let best = -Infinity;
  let at = null;
  for (let k = 0; k < stamp.data.length; k++) if (stamp.data[k] > best) { best = stamp.data[k]; at = k; }
  const g = grid.worldToIndex(ra, dec);
  assert.ok(Math.hypot((at % 101) - g[0], Math.floor(at / 101) - g[1]) <= 0.75);
  // Above a sky of 1. A sample a fifth of a pixel off the centre, blended
  // bilinearly, keeps most of the peak and never more than all of it.
  assert.ok(best - 1 > 3 && best - 1 <= 4 + 1e-5, `grid peak ${best - 1}`);
  assert.ok(Number.isNaN(stamp.data[0]), 'a masked sample stays masked');

  undo();
  assert.ok(stamp.data.every((v, k) => (k === 0 ? Number.isNaN(v) : v === 1)));
  assert.ok(det.data.every((v) => v === 1));
});

test('a linear track is centred on the run\'s midpoint in time and spans the asked length', () => {
  const track = linearTrack([0, 1, 10, 20], [50, 50], [1, 0], 10);
  assert.deepEqual(track[0], [45, 50]);
  assert.deepEqual(track[3], [55, 50]);
  assert.deepEqual(track[2], [50, 50]);
  assert.ok(Math.abs(track[1][0] - 45.5) < 1e-12);
});

test('the seeded generator repeats itself', () => {
  const a = seeded(7);
  const b = seeded(7);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

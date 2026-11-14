/**
 * Saturated stars: the stamp's quality plane carries the detector's OVERFLOW
 * flag and its blanked pixels, and the measurement says "saturated" instead
 * of a position, a brightness or a verdict it cannot support.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SkyView, coreQuality, mostlySaturated } from '../public/js/sky.js';
import { TangentGrid } from '../public/js/wcs.js';
import { QUALITY } from '../public/js/stamp.js';

const SIZE = 81;
const MID = 40;
const PER_PIXEL = 2.5; // grid samples to a 6.15″ detector pixel
const grid = new TangentGrid(10, 0, (SIZE * 6.15) / PER_PIXEL / 3600, SIZE, SIZE);

/**
 * A star at the centre. Saturated, its core is blanked by the pipeline out
 * to `hole` samples, with OVERFLOW on the middle `overflow` samples, as a
 * J ≈ 5 star looks in a SPHEREx Level-2 frame.
 */
function visit({ mjd = 1, saturated = false, hole = 6, overflow = 2, quality = true } = {}) {
  const data = new Float32Array(SIZE * SIZE).fill(0.4);
  const q = new Uint8Array(SIZE * SIZE);
  const s = 0.6 * PER_PIXEL;
  const peak = saturated ? 4000 : 6;
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const k = j * SIZE + i;
      data[k] += peak * Math.exp(-((i - MID) ** 2 + (j - MID) ** 2) / (2 * s * s)) + ((k * 7919) % 13 - 6) * 1e-4;
      if (!saturated) continue;
      const d = Math.max(Math.abs(i - MID), Math.abs(j - MID));
      if (d <= hole) { data[k] = NaN; q[k] |= QUALITY.HOLE; }
      if (d <= overflow) q[k] |= QUALITY.OVERFLOW;
    }
  }
  return {
    stamp: { data, width: SIZE, height: SIZE, ...(quality ? { quality: q } : {}), meta: { detectorSigma: 0.02 } },
    frame: { mjd, obsId: `v${mjd}`, band: 'D2' },
  };
}

const measureAt = (v, i, j) => SkyView.prototype.measure.call({ grid }, v, ...grid.indexToWorld(i, j));
const measure = (v) => measureAt(v, MID, MID);
const track = (visits) => SkyView.prototype.trackMark.call(
  { grid, visits, measure: SkyView.prototype.measure, covers: SkyView.prototype.covers }, ...grid.indexToWorld(MID, MID),
);

test('the quality plane is read for overflow and holes around a point', () => {
  const v = visit({ saturated: true });
  const box = coreQuality(v.stamp.quality, SIZE, SIZE, MID, MID, 5);
  assert.equal(box.overflow, 25);
  assert.equal(box.holeShare, 1);
  assert.deepEqual(box.centre, [MID, MID]);
  assert.equal(coreQuality(v.stamp.quality, SIZE, SIZE, 10, 10, 3).overflow, 0);
});

test('a saturated core is reported as saturated, with no brightness', () => {
  const hit = measure(visit({ saturated: true }));
  assert.ok(hit, 'a blanked core is still something there');
  assert.equal(hit.saturated, true);
  assert.equal(hit.flux, null);
  assert.equal(hit.mag, null);
  assert.equal(hit.snr, null);
  // Where the saturated pixels are, to within a sample.
  const g = grid.worldToIndex(hit.ra, hit.dec);
  assert.ok(Math.hypot(g[0] - MID, g[1] - MID) < 1);
});

test('a click on the blanked rim, clear of the overflow, still finds it saturated', () => {
  // Overflow only within a sample of the centre: the search box around a
  // point eight samples off holds holes and no overflow, the wider reach does.
  const v = visit({ saturated: true, overflow: 1, hole: 10 });
  const hit = measureAt(v, MID + 8, MID);
  assert.equal(hit?.saturated, true);
  const g = grid.worldToIndex(hit.ra, hit.dec);
  assert.ok(Math.hypot(g[0] - MID, g[1] - MID) < 1, 'placed on the saturated pixels, not on the click');
});

test('without a quality plane nothing is claimed, and an ordinary star is not saturated', () => {
  assert.equal(measure(visit({ saturated: true, quality: false }))?.saturated, undefined);
  const plain = measure(visit());
  assert.ok(plain && plain.mag != null);
  assert.equal(plain.saturated, undefined);
});

test('an aperture that touches a bright neighbour\'s overflow quotes no brightness', () => {
  const v = visit();
  // One saturated sample inside the aperture but outside the search box.
  // The click is three samples west, so the box it searches stops short of
  // it; the aperture, centred on the star found, reaches it.
  v.stamp.quality[MID * SIZE + MID + 4] = QUALITY.OVERFLOW;
  const hit = measureAt(v, MID - 3, MID);
  assert.equal(hit.saturated, true);
  assert.equal(hit.mag, null);
  assert.ok(hit.snr > 5, 'the detection stands');
});

test('saturated in most visits: the verdict is saturated, not fixed and not comes-and-goes', () => {
  // One visit with the hole wide enough that the old peak search found nothing
  // and the ring had too little sky: the "9 of 10 visits" a verdict was built on.
  const visits = Array.from({ length: 10 }, (_, k) => visit({ mjd: 1 + 30 * k, saturated: true, hole: k === 4 ? 14 : 6 }));
  const a = track(visits);
  assert.equal(a.kind, 'saturated');
  assert.equal(a.seen, 10);
  assert.equal(a.saturated, 10);
  assert.equal(a.rms, undefined, 'no scatter is quoted');
  assert.equal(a.spanDays, 270);
});

test('a star saturated in a minority of visits keeps the ordinary verdict', () => {
  const visits = Array.from({ length: 5 }, (_, k) => visit({ mjd: 1 + k, saturated: k === 0 }));
  assert.equal(track(visits).kind, 'fixed');
  assert.equal(mostlySaturated([{ saturated: true }, {}, {}]), false);
  assert.equal(mostlySaturated([{ saturated: true }, { saturated: true }, {}]), true);
  assert.equal(mostlySaturated([]), false);
});

test('the display whitens overflow pixels and fills the core they wall in; nothing else changes', async () => {
  const { paint, ramp } = await import('../public/js/render.js');
  const W = 7;
  // A white rim, an overflow core with a garbage low value, a blank in its
  // middle, and a masked pixel out in the sky that has no bright wall.
  const data = new Float32Array(W * W).fill(1);
  const quality = new Uint8Array(W * W);
  for (let j = 1; j <= 5; j++) for (let i = 1; i <= 5; i++) data[j * W + i] = 100;
  for (let j = 2; j <= 4; j++) {
    for (let i = 2; i <= 4; i++) { data[j * W + i] = 0.2; quality[j * W + i] = QUALITY.OVERFLOW; }
  }
  data[3 * W + 3] = NaN;
  data[0] = NaN;
  const before = Float32Array.from(data);
  const lut = ramp([[0, 0, 0], [255, 255, 255]]);
  const img = { data: new Uint8ClampedArray(W * W * 4), width: W, height: W };
  paint(img, data, lut, { lo: 0, hi: 100, stretch: 'linear', quality });
  const grey = (i, j) => img.data[(j * W + i) * 4];
  assert.equal(grey(2, 2), 255, 'an overflow pixel is shown white');
  assert.equal(grey(3, 3), 255, 'the blank it walls in is filled');
  assert.equal(img.data[3], 0, 'a blank out in the sky stays blank');
  assert.equal(grey(6, 6), grey(6, 5), 'the sky is the sky');
  assert.deepEqual(data, before, 'the measured data are not touched');
});

test('a visit that never saw the spot is not counted against a steady star', () => {
  const steady = [1, 2, 3, 4, 5].map((k) => visit({ mjd: 60000 + k }));
  const blank = visit({ mjd: 60010 });
  blank.stamp.data.fill(NaN);
  const a = track([...steady, blank]);
  assert.equal(a.kind, 'fixed');
  assert.equal(a.total, 5);
  assert.equal(a.loaded, 6);
});

test('a spot on an optical ghost is not counted in that visit, either way', () => {
  const steady = [1, 2, 3, 4, 5].map((k) => visit({ mjd: 60000 + k }));
  const ghosted = visit({ mjd: 60010 });
  ghosted.stamp.quality[MID * SIZE + MID] |= QUALITY.GHOST;
  const a = track([...steady, ghosted]);
  assert.equal(a.kind, 'fixed');
  assert.equal(a.total, 5);
  assert.equal(coreQuality(ghosted.stamp.quality, SIZE, SIZE, MID, MID, 2).ghost, 1);
});

test('a ghost in one visit over empty sky does not become a flash', () => {
  const empty = () => {
    const v = visit({ mjd: 0 });
    v.stamp.data.fill(0.4);
    for (let k = 0; k < v.stamp.data.length; k++) v.stamp.data[k] += ((k * 7919) % 13 - 6) * 1e-4;
    return v;
  };
  const quiet = [1, 2, 3, 4].map((k) => Object.assign(empty(), { frame: { mjd: 60000 + k, obsId: `q${k}`, band: 'D2' } }));
  const ghost = visit({ mjd: 60010 });
  ghost.stamp.quality[MID * SIZE + MID] |= QUALITY.GHOST;
  assert.equal(track([...quiet, ghost]).kind, 'none');
  // Without the flag the same light is a one-visit detection: the test bites.
  assert.equal(track([...quiet, visit({ mjd: 60010 })]).kind, 'transient');
});

test('a masked block on a saturated star\'s side is filled from its rim, not left black', async () => {
  const { fillCores } = await import('../public/js/render.js');
  // A 9 × 7 frame of sky at 1 with a bright core column (100) at x = 2, and a
  // 2 × 3 masked block beside it whose other sides are the star's glow (40):
  // only one side of its rim reaches the top of the stretch.
  const W = 9; const H = 7;
  const data = new Float32Array(W * H).fill(1);
  for (let y = 1; y < 6; y++) { data[y * W + 2] = 100; for (let x = 3; x < 7; x++) data[y * W + x] = 40; }
  for (let y = 2; y < 5; y++) for (let x = 3; x < 5; x++) data[y * W + x] = NaN;
  const out = fillCores(data, W, 100);
  for (let y = 2; y < 5; y++) {
    for (let x = 3; x < 5; x++) {
      const v = out[y * W + x];
      assert.ok(v === v, `filled at ${x},${y}`);
      assert.ok(v >= 40 && v <= 100, 'between its rim values');
    }
  }
  // A hole out in plain sky still stays a hole.
  const sky = new Float32Array(W * H).fill(1);
  sky[3 * W + 4] = NaN;
  assert.ok(Number.isNaN(fillCores(sky, W, 100)[3 * W + 4]));
});

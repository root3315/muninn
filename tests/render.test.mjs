import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillCores, skyOf, sortedFinite, limitsFromSorted, limitsFromTable, quantileTable } from '../public/js/render.js';

test('a bright star on the frame edge does not paint the blank beyond it', () => {
  const W = 200;
  const H = 200;
  const data = new Float32Array(W * H).fill(1);
  for (let y = 0; y < H; y++) for (let x = 0; x < 50; x++) data[y * W + x] = NaN;
  for (let y = 95; y < 105; y++) for (let x = 50; x < 56; x++) data[y * W + x] = 5000;
  const out = fillCores(data, W, 1000);
  let painted = 0;
  for (let i = 0; i < data.length; i++) if (Number.isNaN(data[i]) && !Number.isNaN(out[i])) painted++;
  assert.equal(painted, 0);
});

test('a masked core rimmed mostly by saturation is filled, one rimmed by sky is not', () => {
  const W = 40;
  const H = 20;
  const data = new Float32Array(W * H).fill(1);
  const disc = (cx, cy, rim) => {
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
      const r = Math.hypot(x, y);
      if (r < 2) data[(cy + y) * W + cx + x] = NaN;
      else if (r < 4) data[(cy + y) * W + cx + x] = rim;
    }
  };
  disc(10, 10, 5000);
  disc(30, 10, 1);
  const out = fillCores(data, W, 1000);
  assert.ok(out[10 * W + 10] >= 1000, 'the saturated core is white');
  assert.ok(Number.isNaN(out[10 * W + 30]), 'a hole in plain sky stays a hole');
});

test('a masked star short of saturation is filled from its glow, a hole touching sky is not', () => {
  const W = 60;
  const H = 30;
  // Sky with a little noise, so the sky has a spread to be measured against.
  const data = Float32Array.from({ length: W * H }, (_, i) => 0.3 + 0.02 * Math.sin(i * 12.9898));
  const star = (cx, cy, peak, holeR) => {
    for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) {
      const r = Math.hypot(x, y);
      const k = (cy + y) * W + cx + x;
      if (r <= holeR) data[k] = NaN;
      else if (r < 6) data[k] += peak * Math.exp(-(r * r) / 8);
    }
  };
  // Well under the top of the stretch (100): the old rules left both black.
  star(15, 15, 5, 2.5);
  // A hole wider than the star's light: its rim is partly sky.
  star(45, 15, 5, 5.5);
  const out = fillCores(data, W, 100);
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
    if (Math.hypot(x, y) > 2.5) continue;
    const v = out[(15 + y) * W + 15 + x];
    assert.ok(v === v && v > 0.5, `the star's core is filled from its glow at ${x},${y}`);
  }
  assert.ok(Number.isNaN(out[15 * W + 45]), 'a hole reaching sky stays a hole');
  assert.ok(Number.isNaN(data[15 * W + 15]), 'the data themselves are untouched');
});

test('the sky level and spread come from the frame, not its stars', () => {
  const data = Float32Array.from({ length: 10_000 }, (_, i) => 1 + 0.1 * Math.sin(i * 12.9898) + (i % 50 === 0 ? 400 : 0));
  const sky = skyOf(data);
  assert.ok(Math.abs(sky.level - 1) < 0.02, `level ${sky.level}`);
  assert.ok(sky.sigma > 0.02 && sky.sigma < 0.2, `sigma ${sky.sigma}`);
});

test('a cut from the percentile table matches the cut from the sorted pixels', () => {
  const data = Float32Array.from({ length: 50_000 }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1 + (i % 997 === 0 ? 400 : 0));
  const sorted = sortedFinite(data);
  const table = quantileTable(sorted);
  for (const hiPercent of [95, 97.31, 99, 99.5, 99.9, 99.99]) {
    assert.deepEqual(limitsFromTable(table, { hiPercent }), limitsFromSorted(sorted, { hiPercent }), `clip ${hiPercent}`);
  }
});

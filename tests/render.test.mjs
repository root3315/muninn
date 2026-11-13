import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillCores, sortedFinite, limitsFromSorted, limitsFromTable, quantileTable } from '../public/js/render.js';

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

test('a cut from the percentile table matches the cut from the sorted pixels', () => {
  const data = Float32Array.from({ length: 50_000 }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1 + (i % 997 === 0 ? 400 : 0));
  const sorted = sortedFinite(data);
  const table = quantileTable(sorted);
  for (const hiPercent of [95, 97.31, 99, 99.5, 99.9, 99.99]) {
    assert.deepEqual(limitsFromTable(table, { hiPercent }), limitsFromSorted(sorted, { hiPercent }), `clip ${hiPercent}`);
  }
});

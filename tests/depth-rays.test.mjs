/**
 * The depth view's rays leave the photo from each object's own pixel, and
 * when there are too many the ones worth seeing are kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TangentGrid } from '../public/js/wcs.js';
import { plateUV, platePoint, capRays } from '../public/js/vr/depth3d.js';

const grid = new TangentGrid(13.4194, 3.8459, 0.3, 300, 200);
const corners = [[-1, -0.5, -1], [1, -0.5, -1], [1, 0.5, -1], [-1, 0.5, -1]];

test('the field centre is the middle of the picture and of the plate', () => {
  const uv = plateUV(grid, 13.4194, 3.8459);
  assert.ok(Math.abs(uv.u - 0.5) < 1e-9 && Math.abs(uv.v - 0.5) < 1e-9);
  assert.deepEqual(platePoint(corners, uv.u, uv.v).map((x) => Number(x.toFixed(9)) + 0), [0, 0, -1]);
});

test('north is up and east is to the left, as on the plate', () => {
  const north = plateUV(grid, 13.4194, 3.8459 + 0.05);
  const east = plateUV(grid, 13.4194 + 0.05, 3.8459);
  assert.ok(north.v > 0.5 && Math.abs(north.u - 0.5) < 1e-3);
  assert.ok(east.u < 0.5 && Math.abs(east.v - 0.5) < 1e-3);
});

test('a pixel lands where the picture puts it, corner pixel by corner pixel', () => {
  const [ra, dec] = grid.indexToWorld(0, 0);
  const uv = plateUV(grid, ra, dec);
  assert.ok(Math.abs(uv.u - 0.5 / 300) < 1e-6 && Math.abs(uv.v - (1 - 0.5 / 200)) < 1e-6);
  const p = platePoint(corners, uv.u, uv.v);
  assert.ok(p[0] < -0.99 && p[1] > 0.49);
});

test('off the picture is no pixel', () => {
  assert.equal(plateUV(grid, 13.4194 + 1, 3.8459), null);
  assert.equal(plateUV(null, 0, 0), null);
});

test('past the cap, the highest score is kept, ties in order', () => {
  const rays = [{ id: 'a', score: 1 }, { id: 'b', score: 5 }, { id: 'c', score: 5 }, { id: 'd', score: 3 }];
  const { drawn, total } = capRays(rays, 3);
  assert.equal(total, 4);
  assert.deepEqual(drawn.map((r) => r.id), ['b', 'c', 'd']);
  assert.equal(capRays(rays, 10).drawn.length, 4);
});

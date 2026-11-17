/**
 * The depth view's rays leave the photo from each object's own pixel, and
 * when there are too many the ones worth seeing are kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TangentGrid } from '../public/js/wcs.js';
import {
  plateUV, platePoint, capRays, plateCornersFor, rayStart, viewFrame, fieldDirection,
} from '../public/js/vr/depth3d.js';

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

/*
 * The ray's start against the page's own overlay: the field view puts a mark
 * at grid index (i, j), drawn over sample i's centre, i + ½ across the
 * picture. The plate carries the same picture, so the ray must leave from the
 * same fraction of the plate's width and height, wherever the star is.
 */
const FRAME = viewFrame([0, 0, -1]);
const toPlate = (corners, p) => {
  const [bl, br, , tl] = corners;
  const ex = br.map((x, k) => x - bl[k]);
  const ey = tl.map((x, k) => x - bl[k]);
  const d = p.map((x, k) => x - bl[k]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return { u: dot(d, ex) / dot(ex, ex), v: dot(d, ey) / dot(ey, ey) };
};

for (const [name, grid] of [
  ['a wide field', new TangentGrid(133.7595, -7.2422, 0.3 * (477 / 293), 477, 293)],
  ['a tall field, as on a phone', new TangentGrid(13.4194, 3.8459, 0.3 * (240 / 420), 240, 420)],
]) {
  test(`every ray leaves its star's own pixel, off the centre too: ${name}`, () => {
    const spread = 18 / Math.hypot(grid.fovDeg, grid.fovHeightDeg);
    const corners = plateCornersFor(grid, FRAME, spread, 1);
    for (const [i, j] of [[3, 5], [grid.width - 4, 7], [11, grid.height - 9], [grid.width * 0.8, grid.height * 0.3]]) {
      const [ra, dec] = grid.indexToWorld(i, j);
      const at = toPlate(corners, rayStart(grid, corners, ra, dec));
      // Within a tenth of a pixel of the overlay's mark.
      assert.ok(Math.abs(at.u * grid.width - (i + 0.5)) < 0.1, `u ${at.u * grid.width} vs ${i + 0.5}`);
      assert.ok(Math.abs((1 - at.v) * grid.height - (j + 0.5)) < 0.1, `v ${(1 - at.v) * grid.height} vs ${j + 0.5}`);
    }
  });
}

test('east of the centre leaves from the left of the plate, north from its top, as the photo shows', () => {
  const grid = new TangentGrid(133.7595, -7.2422, 0.48, 480, 300);
  const corners = plateCornersFor(grid, FRAME, 30, 1);
  const east = rayStart(grid, corners, 133.7595 + 0.1, -7.2422);
  const north = rayStart(grid, corners, 133.7595, -7.2422 + 0.05);
  // The corridor's frame: x to the viewer's right, y up.
  assert.ok(east[0] < -0.01 && Math.abs(east[1]) < 1e-3);
  assert.ok(north[1] > 0.01 && Math.abs(north[0]) < 1e-3);
  // And the star itself is placed the same way round, so its ray does not cross the corridor.
  const dir = fieldDirection(0.1 * Math.cos(-7.2422 * Math.PI / 180), 0, FRAME, 30);
  assert.ok(dir[0] < 0);
});

test('the plate has the shape of the picture', () => {
  const grid = new TangentGrid(133.7595, -7.2422, 0.488, 488, 300);
  const [bl, br, , tl] = plateCornersFor(grid, FRAME, 1, 1);
  const w = Math.hypot(...br.map((x, k) => x - bl[k]));
  const h = Math.hypot(...tl.map((x, k) => x - bl[k]));
  assert.ok(Math.abs(w / h - 488 / 300) < 1e-3, `${w / h}`);
});

test('a star beside the picture, inside the circle the catalogues are asked over, has no ray start', () => {
  const grid = new TangentGrid(133.7595, -7.2422, 0.488, 488, 300);
  const corners = plateCornersFor(grid, FRAME, 30, 1);
  // Half the height plus a little, straight north: inside the half-diagonal, outside the picture.
  assert.equal(rayStart(grid, corners, 133.7595, -7.2422 + 0.16), null);
  assert.equal(rayStart(grid, null, 133.7595, -7.2422), null);
});

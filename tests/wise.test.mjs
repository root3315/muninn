/**
 * The AllWISE picture: its SIN projection, and resampling it onto the field's
 * north-up grid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { simpleProjection, resampleOnto } from '../public/js/wise.js';
import { TangentGrid } from '../public/js/wcs.js';

const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

/** The header of an AllWISE Atlas cutout near Barnard's Star, as IRSA cut it. */
const atlas = (extra = {}) => new Map(Object.entries({
  CTYPE1: 'RA---SIN', CTYPE2: 'DEC--SIN',
  CRVAL1: 268.86057, CRVAL2: 4.543333,
  CRPIX1: 1806, CRPIX2: -130,
  CDELT1: -0.0003819444391411, CDELT2: 0.0003819444391411, CROTA2: 0,
  ...extra,
}));

test('the reference point lands on the reference pixel', () => {
  const [x, y] = simpleProjection(atlas())(268.86057, 4.543333);
  close(x, 1806, 1e-9, 'x');
  close(y, -130, 1e-9, 'y');
});

test('north is +y and east is −x, at 1.375″ a pixel', () => {
  const to = simpleProjection(atlas());
  const [x0, y0] = to(268.86057, 4.543333);
  const [, yN] = to(268.86057, 4.543333 + 0.1);
  const [xE] = to(268.86057 + 0.1 / Math.cos(4.543333 * Math.PI / 180), 4.543333);
  close(yN - y0, 0.1 / 0.0003819444391411, 0.05, 'north');
  close(x0 - xE, 0.1 / 0.0003819444391411, 0.05, 'east');
});

test('SIN and TAN part only slowly away from the centre', () => {
  const sin = simpleProjection(atlas());
  const tan = simpleProjection(atlas({ CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN' }));
  const near = [sin(268.9, 4.6), tan(268.9, 4.6)];
  close(near[0][0], near[1][0], 0.01, 'near x');
  // 0.75° out — the corner of an Atlas tile — they differ by under a pixel.
  const far = [sin(269.6, 4.6), tan(269.6, 4.6)];
  assert.ok(Math.abs(far[0][0] - far[1][0]) < 1, 'far x within a pixel');
});

test('a CD matrix and CDELT with CROTA2 describe the same pixels', () => {
  const rot = 30 * Math.PI / 180;
  const c = 0.0003819444391411;
  const viaRot = simpleProjection(atlas({ CROTA2: 30 }));
  const viaCd = simpleProjection(atlas({
    CROTA2: undefined, CDELT1: undefined, CDELT2: undefined,
    CD1_1: -c * Math.cos(rot), CD1_2: -c * Math.sin(rot), CD2_1: -c * Math.sin(rot), CD2_2: c * Math.cos(rot),
  }));
  const [a, b] = [viaRot(269.1, 4.7), viaCd(269.1, 4.7)];
  close(a[0], b[0], 1e-6, 'x');
  close(a[1], b[1], 1e-6, 'y');
});

test('an unknown projection is refused rather than guessed', () => {
  assert.throws(() => simpleProjection(atlas({ CTYPE1: 'RA---ZEA' })), /unsupported/);
});

test('resampling puts a source where the sky says and leaves the outside blank', () => {
  const nx = 200;
  const ny = 200;
  const cards = atlas({ CRVAL1: 100, CRVAL2: 20, CRPIX1: 100.5, CRPIX2: 100.5 });
  const to = simpleProjection(cards);
  const image = new Float32Array(nx * ny);
  // A bright patch 30″ north of the centre, wider than a grid pixel so the
  // coarser grid cannot step over it.
  const [sx, sy] = to(100, 20 + 30 / 3600).map(Math.round);
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) image[(sy - 1 + dy) * nx + (sx - 1 + dx)] = 1000;

  // The cutout is 0.076° across; the field, 0.12°, so its corners fall outside.
  const grid = new TangentGrid(100, 20, 0.12, 60, 60);
  const { data, coverage } = resampleOnto(grid, image, nx, ny, to);
  assert.ok(coverage > 0.3 && coverage < 0.5, `coverage ${coverage}`);
  let best = 0;
  for (let k = 1; k < data.length; k++) if ((data[k] || 0) > (data[best] || 0)) best = k;
  const [ra, dec] = grid.indexToWorld(best % 60, Math.floor(best / 60));
  close(ra, 100, 0.003, 'ra of the peak');
  close(dec, 20 + 30 / 3600, 0.004, 'dec of the peak');
  assert.ok(Number.isNaN(data[0]), 'a corner outside the cutout stays blank');
});

/**
 * The Gaia model: a catalogue drawn onto the visits' grid. Stars must land on
 * the grid pixels their positions say, carried by proper motion to the date
 * asked for, and brighter magnitudes must draw brighter stars.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TangentGrid } from '../public/js/wcs.js';
import { drawGaiaSky, fluxOfG, psfFor, PSF_FWHM_DEFAULT } from '../public/js/gaiasky.js';
import { epochOfMjd } from '../public/js/overlay.js';

const grid = new TangentGrid(269.452, 4.693, 0.15, 120, 90);

/** The brightest sample of the drawn sky within `r` samples of (i, j). */
function peakNear(sky, i, j, r = 4) {
  let best = { v: -Infinity, i: -1, j: -1 };
  for (let y = j - r; y <= j + r; y++) {
    for (let x = i - r; x <= i + r; x++) {
      const v = sky.data[y * sky.width + x];
      if (v > best.v) best = { v, i: x, j: y };
    }
  }
  return best;
}

test('a star lands on the grid sample its position names', () => {
  const spots = [[20, 30], [60, 45], [100, 70]];
  const sources = spots.map(([i, j], k) => {
    const [ra, dec] = grid.indexToWorld(i, j);
    return { ra, dec, mag: 14 + k };
  });
  const sky = drawGaiaSky(grid, sources, { fwhmArcsec: 7 });
  assert.equal(sky.width, grid.width);
  assert.equal(sky.height, grid.height);
  assert.equal(sky.drawn, 3);
  for (const [i, j] of spots) {
    const p = peakNear(sky, i, j);
    assert.deepEqual([p.i, p.j], [i, j]);
  }
  // Nothing is drawn where the catalogue has nothing: the model's sky is empty.
  assert.equal(sky.data[5 * grid.width + 5], 0);
});

test('smaller magnitudes draw brighter stars, by the magnitude scale', () => {
  const at = (i, j, mag) => { const [ra, dec] = grid.indexToWorld(i, j); return { ra, dec, mag }; };
  const sky = drawGaiaSky(grid, [at(25, 45, 12), at(60, 45, 14.5), at(95, 45, 17)], { fwhmArcsec: 7 });
  const v = [25, 60, 95].map((i) => sky.data[45 * grid.width + i]);
  assert.ok(v[0] > v[1] && v[1] > v[2]);
  // Same width, so the peaks keep the flux ratio: 2.5 magnitudes is ten times.
  assert.ok(Math.abs(v[0] / v[1] - 10) < 1e-3);
  assert.ok(Math.abs(fluxOfG(15) - 1) < 1e-12);
});

test('a source without a G magnitude is not drawn, one far off the grid is skipped', () => {
  const [ra, dec] = grid.indexToWorld(60, 45);
  const sky = drawGaiaSky(grid, [{ ra, dec, mag: null }, { ra: ra + 5, dec, mag: 10 }]);
  assert.equal(sky.drawn, 0);
});

test('proper motion carries a star to the date asked for', () => {
  // A star at the grid centre at J2016.0, moving 10″ a year due north.
  const [ra, dec] = grid.indexToWorld(60, 45);
  const star = { ra, dec, mag: 12, pmRA: 0, pmDE: 10_000 };
  const scaleArcsec = grid.scale * 3600;
  const mjd2026 = 51544.5 + (2026 - 2000) * 365.25;
  assert.ok(Math.abs(epochOfMjd(mjd2026) - 2026) < 1e-9);
  const sky = drawGaiaSky(grid, [star], { mjd: mjd2026, fwhmArcsec: 7 });
  // Ten years at 10″ a year is 100″ north: up the grid (j falls).
  const expect = 45 - 100 / scaleArcsec;
  const p = peakNear(sky, 60, Math.round(expect), 3);
  assert.equal(p.i, 60);
  assert.equal(p.j, Math.round(expect));
});

test('the width follows the band, and the paint limits sit on a star', () => {
  assert.equal(psfFor('all'), PSF_FWHM_DEFAULT);
  assert.ok(psfFor('D6') > psfFor('D1'));
  const [ra, dec] = grid.indexToWorld(60, 45);
  const narrow = drawGaiaSky(grid, [{ ra, dec, mag: 13 }], { fwhmArcsec: psfFor('D1') });
  const wide = drawGaiaSky(grid, [{ ra, dec, mag: 13 }], { fwhmArcsec: psfFor('D6') });
  const centre = 45 * grid.width + 60;
  assert.ok(narrow.data[centre] > wide.data[centre]);
  assert.equal(narrow.limits.lo, 0);
  assert.ok(narrow.limits.hi > 0);
});

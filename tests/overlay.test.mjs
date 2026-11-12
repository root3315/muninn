/**
 * The catalogue overlay's arithmetic: carrying a Gaia position to the date of
 * a visit, choosing how faint to go, building the queries and reading the rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GAIA_EPOCH, ROW_CAP, epochOfMjd, propagate, magLimit, wiseLimit, searchRadius,
  gaiaQuery, wiseQuery, parseGaiaRow, parseWiseRow, cutToCap, markRadius, properMotion,
} from '../public/js/overlay.js';
import { TangentGrid } from '../public/js/wcs.js';

/* Barnard's Star as Gaia DR3 has it (source 4472832130942575872), epoch J2016.0. */
const BARNARD = {
  ra: 269.44850252543836, dec: 4.739420051112412,
  pmRA: -801.5509783684709, pmDE: 10362.394206546573,
};
const ARCSEC = 1 / 3600;

test('a Modified Julian Date becomes a Julian year', () => {
  assert.equal(epochOfMjd(51544.5), 2000);
  assert.equal(epochOfMjd(57388.5), GAIA_EPOCH);
  // 15 Aug 2025, a SPHEREx visit to the Barnard field.
  assert.ok(Math.abs(epochOfMjd(60902.864715) - 2025.6218) < 1e-4);
});

test("Barnard's Star is carried 98″ north and 7.6″ west by mid-2025", () => {
  const at = propagate(BARNARD, 2025.5);
  assert.equal(at.moved, true);
  // 9.5 yr × 10362.394 mas/yr = 98.44″ in declination.
  assert.ok(Math.abs((at.dec - BARNARD.dec) / ARCSEC - 98.443) < 0.005);
  // 9.5 yr × −801.551 mas/yr = −7.61″ on the sky; divided by cos δ in right ascension.
  const onSky = (at.ra - BARNARD.ra) * Math.cos(at.dec * Math.PI / 180) / ARCSEC;
  assert.ok(Math.abs(onSky + 7.615) < 0.005);
  assert.ok(Math.abs(at.ra - 269.446380) < 1e-6);
  assert.ok(Math.abs(at.dec - 4.766765) < 1e-6);
});

test("Barnard's Star moves 10.39″ a year, and a year apart is more than a pixel", () => {
  assert.ok(Math.abs(properMotion(BARNARD) - 10.3933) < 1e-4);
  const a = propagate(BARNARD, 2025.0);
  const b = propagate(BARNARD, 2026.0);
  const step = Math.hypot((b.dec - a.dec), (b.ra - a.ra) * Math.cos(a.dec * Math.PI / 180)) / ARCSEC;
  assert.ok(Math.abs(step - 10.393) < 0.01);
  assert.ok(step > 6.15, 'more than one SPHEREx pixel');
});

test('on an 18′ plate the propagated circle lands 16 pixels from the 2016 position', () => {
  // The plate the Barnard preset opens: centred on where the star is now.
  const grid = new TangentGrid(269.4463, 4.7680, 0.3, 176, 176);
  const pixelArcsec = grid.scale * 3600;
  const then = grid.worldToIndex(BARNARD.ra, BARNARD.dec);
  const at = propagate(BARNARD, 2025.5);
  const now = grid.worldToIndex(at.ra, at.dec);
  const shift = Math.hypot(now[0] - then[0], now[1] - then[1]) * pixelArcsec;
  assert.ok(Math.abs(shift - 98.74) < 0.1, `shift ${shift}`);
  // North is up: the star has gone up the plate, and slightly west (right).
  assert.ok(now[1] < then[1] && now[0] > then[0]);
});

test('the epoch a position is already at leaves it alone', () => {
  const at = propagate(BARNARD, GAIA_EPOCH);
  assert.equal(at.ra, BARNARD.ra);
  assert.equal(at.dec, BARNARD.dec);
});

test('a source without a proper motion stays put and says so', () => {
  for (const pm of [{ pmRA: null, pmDE: null }, { pmRA: 3.1, pmDE: null }, {}]) {
    const at = propagate({ ra: 10, dec: -20, ...pm }, 2025.5);
    assert.deepEqual(at, { ra: 10, dec: -20, moved: false });
  }
});

test('right ascension wraps at 0 h and widens toward the pole', () => {
  const east = propagate({ ra: 359.9999, dec: 0, pmRA: 1000, pmDE: 0 }, 2017);
  assert.ok(east.ra < 0.001 && east.ra >= 0);
  // The same motion on the sky is twice the change in right ascension at 60°.
  const equator = propagate({ ra: 100, dec: 0, pmRA: 1000, pmDE: 0 }, 2026);
  const high = propagate({ ra: 100, dec: 60, pmRA: 1000, pmDE: 0 }, 2026);
  assert.ok(Math.abs((high.ra - 100) / (equator.ra - 100) - 2) < 1e-9);
});

test('the magnitude limit follows the field: wider is shallower', () => {
  assert.equal(magLimit(0.15), 18.5);
  assert.equal(magLimit(0.3), 17);
  assert.equal(magLimit(0.6), 15.5);
  const sizes = [0.1, 0.15, 0.2, 0.3, 0.45, 0.6];
  const limits = sizes.map(magLimit);
  assert.deepEqual(limits, [...limits].sort((a, b) => b - a));
  assert.ok(limits.every((m) => m >= 13 && m <= 20));
  assert.equal(wiseLimit(0.3), 14.5);
});

test('the search circle covers the corners of the plate, with room for drift', () => {
  const r = searchRadius(0.48, 0.3);
  assert.ok(r > Math.hypot(0.48, 0.3) / 2);
  // Barnard's Star has come 104″ since 2016: the margin has to hold that.
  assert.ok(r - Math.hypot(0.48, 0.3) / 2 >= 104 / 3600);
});

test('the queries are built from formatted numbers and nothing else', () => {
  const field = { ra: 269.4463, dec: 4.768, radiusDeg: 0.31641, limit: 17 };
  const gaia = gaiaQuery(field);
  assert.match(gaia, /SELECT TOP 301 Source, RA_ICRS, DE_ICRS, Gmag, pmRA, pmDE, Plx, e_Plx/);
  assert.match(gaia, /FROM "I\/355\/gaiadr3"/);
  assert.match(gaia, /CIRCLE\('ICRS', 269\.446300, 4\.768000, 0\.31641\)\) = 1 AND Gmag <= 17\.00/);
  assert.match(gaia, /ORDER BY Gmag$/);
  const wise = wiseQuery({ ...field, limit: 14.5, cap: 50 });
  assert.match(wise, /SELECT TOP 51 AllWISE, RAJ2000, DEJ2000, W1mag, W2mag/);
  assert.match(wise, /FROM "II\/328\/allwise"/);
  assert.match(wise, /W1mag <= 14\.50\s+ORDER BY W1mag$/);
});

test('a query refuses anything that is not a finite number', () => {
  const field = { ra: 10, dec: 20, radiusDeg: 0.2, limit: 17 };
  for (const bad of ['10', "10'; DROP TABLE x --", NaN, Infinity, null, undefined]) {
    assert.throws(() => gaiaQuery({ ...field, ra: bad }), TypeError);
    assert.throws(() => wiseQuery({ ...field, limit: bad }), TypeError);
    assert.throws(() => gaiaQuery({ ...field, radiusDeg: bad }), TypeError);
  }
});

test('a Gaia row keeps its 64-bit id as text and its gaps as null', () => {
  const full = parseGaiaRow({
    Source: '4472832130942575872', RA_ICRS: '269.44850252544', DE_ICRS: '4.73942005111',
    Gmag: '8.193974', pmRA: '-801.551', pmDE: '10362.394', Plx: '546.9759', e_Plx: '0.0401',
  });
  assert.deepEqual(full, {
    id: '4472832130942575872', ra: 269.44850252544, dec: 4.73942005111, mag: 8.193974,
    pmRA: -801.551, pmDE: 10362.394, plx: 546.9759, plxErr: 0.0401,
  });
  // A two-parameter solution: a position and a brightness, no motion, no parallax.
  const bare = parseGaiaRow({ Source: '1', RA_ICRS: '10.5', DE_ICRS: '-3.25', Gmag: '19.1', pmRA: '', pmDE: '', Plx: '', e_Plx: '' });
  assert.equal(bare.pmRA, null);
  assert.equal(bare.pmDE, null);
  assert.equal(bare.plx, null);
  assert.equal(propagate(bare, 2025.5).moved, false);
});

test('a row with no position or no magnitude is dropped', () => {
  assert.equal(parseGaiaRow({ Source: '1', RA_ICRS: '', DE_ICRS: '4', Gmag: '12' }), null);
  assert.equal(parseGaiaRow({ Source: '1', RA_ICRS: '3', DE_ICRS: '4', Gmag: '' }), null);
  assert.equal(parseWiseRow({ AllWISE: 'J1', RAJ2000: 'x', DEJ2000: '4', W1mag: '12' }), null);
});

test('an AllWISE row carries W1 and W2', () => {
  assert.deepEqual(
    parseWiseRow({ AllWISE: 'J175747.94+044323.8', RAJ2000: '269.4497620', DEJ2000: '4.7232970', W1mag: '4.386', W2mag: '' }),
    { id: 'J175747.94+044323.8', ra: 269.449762, dec: 4.723297, mag: 4.386, w2: null },
  );
});

test('a list longer than the cap is cut, and reports how deep it really goes', () => {
  const rows = Array.from({ length: ROW_CAP + 1 }, (_, k) => ({ mag: 10 + k * 0.01 }));
  const cut = cutToCap(rows, 17);
  assert.equal(cut.cut, true);
  assert.equal(cut.rows.length, ROW_CAP);
  assert.ok(Math.abs(cut.reached - (10 + (ROW_CAP - 1) * 0.01)) < 1e-9);

  const whole = cutToCap(rows.slice(0, ROW_CAP), 17);
  assert.equal(whole.cut, false);
  assert.equal(whole.rows.length, ROW_CAP);
  assert.equal(whole.reached, 17);
});

test('a brighter source gets a larger mark, within bounds', () => {
  assert.equal(markRadius(17, 17), 2.5);
  assert.equal(markRadius(19, 17), 2.5);
  assert.equal(markRadius(8.2, 17), 7);
  assert.ok(markRadius(14, 17) > markRadius(16, 17));
});

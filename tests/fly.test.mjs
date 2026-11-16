import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temperatureOf, bolometricCorrection, luminosityOf, radiusOf } from '../public/js/fly/stars.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('the Sun comes out as the Sun', () => {
  assert.ok(near(temperatureOf(0.65), 5772, 30));
  assert.ok(near(bolometricCorrection(5772), -0.07, 0.03));
  assert.ok(near(luminosityOf(4.83, 0.65), 1, 0.03));
  assert.ok(near(radiusOf(4.83, 0.65), 1, 0.03));
});

test('estimated radii land near measured ones for ordinary stars', () => {
  // Sirius A 1.71 R☉, Arcturus 25.4, Rigel 79: within a fifth.
  for (const [m, bv, r] of [[1.43, 0.0, 1.71], [-0.30, 1.23, 25.4], [-7.0, -0.03, 79]]) {
    assert.ok(Math.abs(radiusOf(m, bv) / r - 1) < 0.2, `${m} ${bv}: ${radiusOf(m, bv)} vs ${r}`);
  }
});

test('hotter is bluer, and the correction is never positive by much', () => {
  assert.ok(temperatureOf(-0.2) > temperatureOf(0.5) && temperatureOf(0.5) > temperatureOf(1.5));
  for (const t of [3000, 4000, 5000, 6000, 8000, 12000, 25000]) assert.ok(bolometricCorrection(t) < 0.1, String(t));
});

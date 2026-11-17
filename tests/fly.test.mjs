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

import { reachPc, stackedLimit, shells, WISE0855_PC, D6_ONE_VISIT_AB, planetNineShortfall } from '../public/js/fly/reach.js';

test('the reach of a WISE 0855-like body follows its own measured brightness', () => {
  // At its own brightness, it is seen exactly where it is.
  assert.ok(near(reachPc(17.2), WISE0855_PC, 1e-9));
  // One D6 visit on its field (16.6 AB) is over half a magnitude short: it would have to be nearer.
  const [one, stack] = shells();
  assert.ok(one.pc < WISE0855_PC && near(one.pc, 1.71, 0.02), String(one.pc));
  // Seventeen visits stacked go 1.54 mag deeper and take it in.
  assert.ok(near(stackedLimit(17) - D6_ONE_VISIT_AB, 1.538, 0.002));
  assert.ok(stack.pc > WISE0855_PC && near(stack.pc, 3.48, 0.03), String(stack.pc));
});

test('Planet Nine in reflected light is a hundred times too faint for one visit', () => {
  assert.ok(near(planetNineShortfall(17.6), 10 ** (0.4 * 5), 1e-6));
});

import { vMinusW2 } from '../public/js/fly/stars.js';

test('V − W2 as a blackbody: zero for Vega, redder stars brighter at 4.6 µm', () => {
  assert.ok(near(vMinusW2(9602), 0, 1e-9));
  // The Sun's measured V − W2 is about 1.5; a blackbody gives a little less.
  assert.ok(vMinusW2(5772) > 1 && vMinusW2(5772) < 1.8, String(vMinusW2(5772)));
  assert.ok(vMinusW2(3600) > vMinusW2(5772) && vMinusW2(20000) < 0);
});

test('the flight quotes the WISE 0855 field\'s own D6 depth, one visit and the stack, as its field page does', async () => {
  const { readFileSync } = await import('node:fs');
  const { stackDepth } = await import('../public/js/depth.js');
  const { D6_ONE_VISIT_AB, WISE0855_VISITS, stackedLimit } = await import('../public/js/fly/reach.js');
  const manifest = JSON.parse(readFileSync(new URL('../public/data/fields/wise0855/D6/manifest.json', import.meta.url), 'utf8'));
  const field = stackDepth(manifest.visits.filter((v) => !v.none).map((v) => ({ band: v.band, sigma: v.check.detectorSigma.kept })));
  assert.equal(D6_ONE_VISIT_AB.toFixed(1), field.single.toFixed(1));
  assert.equal(stackedLimit(WISE0855_VISITS).toFixed(1), field.stacked.toFixed(1));
});

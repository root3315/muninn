/**
 * The magnified proper-motion arrow: which targets get one, how much it is
 * magnified, and that the points it is drawn through are the target's own
 * positions with only their distance from the first visit multiplied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasMotion, pickFactor, motionVector, fitMotion, FACTORS } from '../public/js/motion-vector.js';
import { propagate, epochOfMjd } from '../public/js/overlay.js';
import { TangentGrid } from '../public/js/wcs.js';

/* WISE 0855−0714 as targets.json has it (Kirkpatrick et al. 2021), epoch J2000. */
const WISE0855 = { ra: 133.81890825, dec: -7.247048, epoch: 2000, pmRA: -8123.7, pmDE: 673.2 };

/* The field as the preset opens it: 0.3° across, about 6″ a sample. */
const grid = new TangentGrid(133.7595, -7.2422, 0.3, 176, 176);
const toIndex = (ra, dec) => grid.worldToIndex(ra, dec);

/* A year of visits, 2025-05 to 2026-05. */
const MJDS = [60800, 60900, 61000, 61100, 61170];

test('only a target with a catalogued motion of at least 0.1″ a year gets an arrow', () => {
  assert.equal(hasMotion(WISE0855), true);
  assert.equal(hasMotion({ ra: 10, dec: 10 }), false);
  assert.equal(hasMotion({ ra: 10, dec: 10, pmRA: 4.9, pmDE: -3 }), false);
  assert.equal(hasMotion(null), false);
  assert.equal(motionVector({ ra: 10, dec: 10 }, MJDS, toIndex, 20), null);
});

test('the factor is the largest round one that keeps the arrow within the length wanted', () => {
  assert.equal(pickFactor(6.75, 120), 10);
  assert.equal(pickFactor(4.4, 120), 20);
  assert.equal(pickFactor(200, 120), 1);
  assert.equal(pickFactor(0.001, 120), FACTORS[FACTORS.length - 1]);
  assert.equal(pickFactor(0, 120), null);
});

test('the arrow starts on the target at the first visit and points the way it moves', () => {
  const mv = motionVector(WISE0855, MJDS, toIndex, 20);
  const start = propagate(WISE0855, epochOfMjd(MJDS[0]), 2000);
  const [i0, j0] = toIndex(start.ra, start.dec);
  assert.ok(Math.abs(mv.anchor[0] - i0) < 1e-9 && Math.abs(mv.anchor[1] - j0) < 1e-9);
  // It moves west (pmRA < 0): with east to the left, the index grows.
  assert.ok(mv.head[0] > mv.anchor[0]);
  // 8.15″ a year on a plate of about 6.1″ a sample, times twenty.
  const len = Math.hypot(mv.head[0] - mv.anchor[0], mv.head[1] - mv.anchor[1]);
  const arcsecPerSample = (0.3 * 3600) / 176;
  assert.ok(Math.abs(len - (20 * 8.151) / arcsecPerSample) < 0.3, `length ${len}`);
  assert.ok(Math.abs(mv.arcsecPerYear - 8.151) < 0.01);
});

test('each visit gets a tick at its date, magnified by the same factor, in date order', () => {
  const shuffled = [MJDS[3], MJDS[0], NaN, MJDS[4], MJDS[1], MJDS[2]];
  const mv = motionVector(WISE0855, shuffled, toIndex, 20);
  assert.deepEqual(mv.ticks.map((t) => t.mjd), MJDS);
  assert.deepEqual(mv.ticks[0].at, mv.anchor);
  for (const tk of mv.ticks) {
    const p = propagate(WISE0855, epochOfMjd(tk.mjd), 2000);
    const [i, j] = toIndex(p.ra, p.dec);
    const want = [mv.anchor[0] + (i - mv.anchor[0]) * 20, mv.anchor[1] + (j - mv.anchor[1]) * 20];
    assert.ok(Math.hypot(tk.at[0] - want[0], tk.at[1] - want[1]) < 1e-9);
  }
  // The last visit is about a year on: its tick lies near the head.
  const last = mv.ticks[mv.ticks.length - 1].at;
  const len = Math.hypot(mv.head[0] - mv.anchor[0], mv.head[1] - mv.anchor[1]);
  assert.ok(Math.hypot(last[0] - mv.head[0], last[1] - mv.head[1]) < len * 0.05);
});

test('no visit, or a target off the projection, draws nothing', () => {
  assert.equal(motionVector(WISE0855, [], toIndex, 20), null);
  assert.equal(motionVector(WISE0855, MJDS, () => null, 20), null);
});

test('fitMotion picks the factor from the plate scale on screen', () => {
  // 5 screen pixels a sample: 8.15″/yr is about 6.7 px a year, so ×20 for 140 px.
  const mv = fitMotion(WISE0855, MJDS, toIndex, 5, 140);
  assert.equal(mv.factor, 20);
  assert.equal(fitMotion({ ra: 1, dec: 1 }, MJDS, toIndex, 5, 120), null);
});

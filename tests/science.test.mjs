/**
 * The arithmetic the write-up quotes: coordinates, parallax, depth, sectors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TangentGrid, deltaRA, separation } from '../public/js/wcs.js';
import { distanceCeilingAU, rateAtAU, rateIsMeasured } from '../public/js/hunt.js';
import { limitAB, skySigma, stackDepth } from '../public/js/depth.js';
import { scoreSectors, standouts, sectorBounds } from '../public/js/sectors.js';
import { groupVisits } from '../public/js/catalog.js';
import { limits, limitsFromSorted, sortedFinite } from '../public/js/render.js';

const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('TangentGrid: north up, east left, exact round trip', () => {
  const g = new TangentGrid(13.4194, 3.8459, 0.3, 600, 300);
  const [raR] = g.indexToWorld(g.cx + 100, g.cy);
  const [, decU] = g.indexToWorld(g.cx, g.cy - 100);
  assert.ok(deltaRA(raR, 13.4194) < 0, 'right is west');
  assert.ok(decU > 3.8459, 'up is north');
  for (const [i, j] of [[0, 0], [599, 299], [123.4, 56.7]]) {
    const [i2, j2] = g.worldToIndex(...g.indexToWorld(i, j));
    close(i2, i, 1e-7, 'i'); close(j2, j, 1e-7, 'j');
  }
});

test('deltaRA takes the short way round the 0h meridian', () => {
  close(deltaRA(359.9999, 0.0001), -0.0002, 1e-9, '359.9999 − 0.0001');
  close(deltaRA(0.0001, 359.9999), 0.0002, 1e-9, '0.0001 − 359.9999');
  close(deltaRA(10, 350), 20, 1e-9, '10 − 350');
  close(separation(359.999, 0, 0.001, 0), 0.002, 1e-9, 'separation across 0h');
});

test('groupVisits prefers the exposure nearer the target across 0h', () => {
  const frames = [
    { mjd: 61000.0, ra: 359.46, dec: 0, band: 'D1' }, // 0.54° away
    { mjd: 61000.01, ra: 0.08, dec: 0, band: 'D1' }, // 0.08° away, same visit
  ];
  const [visit] = groupVisits(frames, { ra: 0, dec: 0, band: 'D1' });
  assert.equal(visit.ra, 0.08);
});

test('parallax: opposition rates and the distance they bound', () => {
  close(rateAtAU(2.7), 34.0, 0.2, 'main belt ″/h');
  close(rateAtAU(30), 4.17, 0.02, 'Neptune ″/h');
  close(rateAtAU(400), 0.352, 0.002, '400 AU ″/h');
  for (const d of [2.7, 5.2, 30, 500]) close(distanceCeilingAU(rateAtAU(d)), d, 1e-9, `round trip ${d}`);
  // (152) Atala, 3.02 AU from the Sun, measured at 21.1″/h away from opposition:
  // the bound has to be above its true distance, not below it.
  assert.ok(distanceCeilingAU(21.1) > 3.02);
  assert.equal(distanceCeilingAU(0), null);
});

test('a rate needs four points and must beat a detector pixel', () => {
  const base = { spanDays: 30, rms: 0.5, ratePerHour: 1 };
  assert.equal(rateIsMeasured({ ...base, seen: 3 }), false);
  assert.equal(rateIsMeasured({ ...base, seen: 4 }), true);
  assert.equal(rateIsMeasured({ ...base, seen: 6, ratePerHour: 0.02 }), false, '14″ over 30 d is < 3 pixels');
});

test('depth: robust sigma reads the noise, not the sources, and √N stacks', () => {
  let s = 7;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  const data = new Float32Array(100000);
  for (let k = 0; k < data.length; k++) {
    data[k] = 1 + 0.05 * Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
    if (k % 97 === 0) data[k] += 20; // sources, only ever in the upper tail
  }
  close(skySigma(data), 0.05, 0.004, 'sigma');
  assert.ok(limitAB(0.01) > limitAB(0.02), 'less noise is deeper');
  const d = stackDepth([{ band: 'D2', sigma: 0.02 }, { band: 'D2', sigma: 0.02 }, { band: 'D2', sigma: 0.02 }, { band: 'D2', sigma: 0.02 }]);
  close(d.stacked - d.single, 2.5 * Math.log10(2), 1e-9, 'four visits buy 0.75 mag');
});

test('sectors: a steady star scores zero, a one-visit transient stands out', () => {
  const W = 50; const H = 40;
  const visits = [];
  for (let v = 0; v < 6; v++) {
    const data = new Float32Array(W * H).fill(1);
    for (let k = 0; k < data.length; k++) data[k] += ((k * 7919 + v * 104729) % 1000) / 1e5;
    data[5 * W + 5] = 30; // the same star in sector 1, every visit
    if (v === 3) data[30 * W + 45] = 30; // a transient in sector 20, visit 4 only
    visits.push({ stamp: { data, width: W, height: H } });
  }
  const scored = scoreSectors(visits, { sigmas: visits.map(() => 0.01) });
  const hits = standouts(scored, { limit: Infinity });
  assert.equal(hits.length, 1, 'one standout');
  assert.deepEqual([hits[0].sector, hits[0].visit], [20, 3]);
  for (const z of scored.cells[0]) close(z, 0, 1e-6, 'steady star');
  assert.deepEqual(sectorBounds(20), { x0: 0.8, x1: 1, y0: 0.75, y1: 1 });
});

test('a cut read off cached sorted pixels equals a fresh one', () => {
  const data = Float32Array.from({ length: 5000 }, (_, k) => Math.sin(k) * 3 + (k % 101 === 0 ? 50 : 0));
  const sorted = sortedFinite(data);
  for (const hiPercent of [95, 99.5, 99.99]) {
    assert.deepEqual(limitsFromSorted(sorted, { hiPercent }), limits(data, { hiPercent }));
  }
});

test('season stack: seasons by band and date, steps land on a season start', async () => {
  const { seasonOf, seasonStep, coadd, averaged } = await import('../public/js/stack.js');
  const v = (mjd, band = 'D2') => ({ frame: { mjd, band } });
  const visits = [v(100), v(101), v(103, 'D3'), v(110), v(290), v(292), v(470)];
  assert.deepEqual(seasonOf(visits, 1), [0, 1, 3], 'same band within 20 days');
  assert.deepEqual(seasonOf(visits, 5), [4, 5]);
  assert.equal(seasonStep(visits, 1, 1), 4, 'next season, first visit');
  assert.equal(seasonStep(visits, 5, 1), 6);
  assert.equal(seasonStep(visits, 6, 1), 6, 'nothing later');
  assert.equal(seasonStep(visits, 4, -1), 0, 'previous season, first visit');

  // Four planes: the brightest value of each pixel is dropped, NaN is skipped.
  const planes = [[1, NaN], [2, 4], [3, 6], [100, 8]].map((p) => Float32Array.from(p));
  const out = coadd([planes[0].subarray(0, 1), planes[1].subarray(0, 1), planes[2].subarray(0, 1), planes[3].subarray(0, 1)]);
  close(out[0], 2, 1e-9, 'cosmic ray dropped: mean of 1, 2, 3');
  const two = coadd([Float32Array.of(NaN, 1), Float32Array.of(4, 3)]);
  assert.deepEqual([...two], [4, 2], 'fewer than four: plain mean, NaN left out');
  assert.equal(averaged(6), 5);
  assert.equal(averaged(3), 2);
  const three = coadd([Float32Array.of(1), Float32Array.of(50), Float32Array.of(3)]);
  assert.equal(three[0], 3, 'three: the middle value, the one-visit spike gone');
});

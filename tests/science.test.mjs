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
  // SPHEREx looks 90° from the Sun, where a body at 2.2 AU moves at its own
  // orbital rate, faster than the opposition formula allows for that distance.
  const quadrature22 = (2 * Math.PI * 206265) / (2.2 ** 1.5 * 365.25 * 24);
  assert.ok(distanceCeilingAU(quadrature22) >= 2.2 - 1e-9, 'the ceiling holds at quadrature too');
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
  // Eight shallow D1 visits must not outvote two deeper D2 ones.
  const mixed = stackDepth([
    ...Array.from({ length: 8 }, () => ({ band: 'D1', sigma: 0.03 })),
    { band: 'D2', sigma: 0.02 }, { band: 'D2', sigma: 0.02 },
  ]);
  assert.equal(mixed.band, 'D2');
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

test('season stack: seasons are a partition, the stack takes the nearest of one', async () => {
  const { seasonChunks, chunkAt, forStack, coadd, averaged, STACK_MAX } = await import('../public/js/stack.js');
  const f = (mjd) => ({ mjd, url: `u${mjd}` });
  const days = (chunks) => chunks.map((c) => c.map((x) => x.mjd));

  // Six months apart: two seasons, whatever order the visits came in.
  assert.deepEqual(days(seasonChunks([f(290), f(100), f(110), f(292), f(101)])), [[100, 101, 110], [290, 292]]);
  // 0, 15, 30: one partition however it is entered, never a season that
  // depends on which visit is looked at (the old ±20-day window did).
  const chain = seasonChunks([f(0), f(15), f(30)]);
  assert.deepEqual(days(chain), [[0, 15], [30]], 'no season runs past 20 days');
  assert.equal(chunkAt(chain, 15), 0);
  assert.equal(chunkAt(chain, 30.1), 1, 'another exposure of the same visit belongs to it');
  assert.equal(chunkAt(chain, 200), -1);
  // A polar field seen every day: capped, and the stack takes the nearest.
  const daily = seasonChunks(Array.from({ length: 60 }, (_, d) => f(d)));
  assert.ok(daily.every((c) => c[c.length - 1].mjd - c[0].mjd <= 20));
  const pick = forStack(daily[0], daily[0][10]);
  assert.equal(pick.length, STACK_MAX);
  assert.ok(pick.includes(daily[0][10]), 'the visit on screen is in its own stack');
  assert.ok(pick.every((x) => Math.abs(x.mjd - 10) <= 3), 'nearest in time first');
  // The shown frame stands for its visit: another exposure of it is not added twice.
  const withTwin = forStack([f(10), f(10.01), f(12)], f(10));
  assert.deepEqual(withTwin.map((x) => x.mjd), [10, 12]);

  // Each visit is a flat sky (pixels 2-6) at its own level, with a steady
  // star of +5 at pixel 1. Pixel 0 is blank sky, hit once by a cosmic ray.
  const visit = (level, ray = 0) => Float32Array.of(level + ray, level + 5, level, level, level, level, level);
  const four = coadd([visit(10), visit(11), visit(12), visit(13, 90)]);
  close(four[0], 11.5, 1e-6, 'cosmic ray dropped; the sky is the mean level of the four');
  close(four[1], 16.5, 1e-6, 'the star stands 5 above it, whatever each sky was');
  // Without levelling, the visit with the brightest sky was the one dropped.
  const noRay = coadd([visit(10), visit(11), visit(12), visit(13)]);
  close(noRay[2], 11.5, 1e-6, 'sky differences alone drop nothing');
  const two = coadd([Float32Array.of(NaN, 1, 1, 1), Float32Array.of(4, 3, 3, 3)]);
  close(two[0], 3, 1e-6, 'fewer than four: the mean; a masked pixel is left out');
  close(two[1], 2, 1e-6);
  assert.equal(averaged(6), 5);
  assert.equal(averaged(3), 2);
  const three = coadd([visit(1), visit(1, 50), visit(1)]);
  close(three[0], 1, 1e-6, 'three: the middle value, the one-visit spike gone');
});

test('a marked star: the aperture holds its light wherever it falls on a pixel', async () => {
  const { SkyView } = await import('../public/js/sky.js');
  const { TangentGrid } = await import('../public/js/wcs.js');
  const { magAB } = await import('../public/js/depth.js');
  // 2.5 grid samples to a 6.15″ detector pixel, as the tool cuts its grid.
  // And again at one sample an arcsecond, the 6′ field: the box and the ring
  // are sized in detector pixels, so the star is the same star there.
  for (const perPixel of [2.5, 6.15]) await sameStar(perPixel);

  async function sameStar(perPixel) {
  const size = perPixel > 3 ? 161 : 81;
  const mid = (size - 1) / 2;
  const grid = new TangentGrid(10, 0, (size * 6.15) / perPixel / 3600, size, size);
  const total = 40; // MJy/sr · detector pixel
  const star = (dx, dy) => {
    const data = new Float32Array(size * size).fill(0.4);
    // A detector-pixel-wide blur: sigma of 0.6 detector pixel.
    const s = 0.6 * perPixel;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const r2 = (i - mid - dx) ** 2 + (j - mid - dy) ** 2;
        data[j * size + i] += (total * perPixel ** 2 / (2 * Math.PI * s * s)) * Math.exp(-r2 / (2 * s * s));
      }
    }
    // A little structure in the sky so the annulus has a spread to report.
    for (let k = 0; k < data.length; k++) data[k] += ((k * 7919) % 13 - 6) * 1e-4;
    return { stamp: { data, width: size, height: size, meta: { detectorSigma: 0.02 } }, frame: { mjd: 1, obsId: 'x' } };
  };
  const view = { grid };
  const centred = SkyView.prototype.measure.call(view, star(0, 0), 10, 0);
  const offset = SkyView.prototype.measure.call(view, star(0.48 * perPixel, 0.36 * perPixel), 10, 0);
  assert.ok(centred && offset, 'both are detections');
  // Three pixels square holds nearly all of a sigma-0.6-pixel star.
  close(centred.flux, total, total * 0.06, 'the aperture sum is the star');
  assert.ok(Math.abs(centred.mag - offset.mag) < 0.05, 'the same star, the same magnitude');
  close(centred.mag, magAB(total), 0.07, 'on the AB scale of the depth limit');

  // A masked core is a hole in the aperture: no brightness is quoted through it.
  const holed = star(0, 0);
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) holed.stamp.data[(Math.round(mid) + 2 + j) * size + Math.round(mid) + 2 + i] = NaN;
  const through = SkyView.prototype.measure.call(view, holed, 10, 0);
  if (perPixel < 3) assert.equal(through?.mag ?? null, null, 'a quarter of the aperture masked: no magnitude');
  }
});

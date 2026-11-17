/**
 * The arithmetic behind the brown-dwarf proper-motion check
 * (tools/measure-bd-motion.mjs): carrying a position with its motion and
 * parallax, finding and centroiding a star on a grid, and the comparison
 * that turns two offsets into a verdict. No network: every image here is
 * made in the test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  offsetArcsec, applyOffset, positionAngle, angleBetween, earthPosition, parallaxOffset, expectedOffset, carry,
  median, annulusMedian, apertureSum, findPeak, windowedCentroid, centroidSigma, compareMotion, fitMotion,
  seasons, stackMean, parseTsv, headline, spectralType, fieldStarOffsets, isolatedStars, ALLWISE_MJD, RESIDUAL_FLOOR_ARCSEC,
} from '../tools/measure-bd-motion.mjs';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

/* --------------------------------------------------------------- geometry */

test('offsets on the tangent plane go out and come back', () => {
  for (const [ra, dec] of [[133.79, -7.24], [0.01, 60], [359.99, -85], [210, 0]]) {
    const there = applyOffset(ra, dec, -129.1, 10.7);
    const back = offsetArcsec(ra, dec, there.ra, there.dec);
    close(back.east, -129.1, 1e-6, 'east');
    close(back.north, 10.7, 1e-6, 'north');
  }
});

test('east is towards increasing right ascension, at any declination', () => {
  const o = offsetArcsec(100, 60, 100 + 0.01, 60);
  assert.ok(o.east > 0);
  // 0.01° of RA at 60° is half as long on the sky.
  close(o.east, 36 * Math.cos(60 * Math.PI / 180), 0.01);
});

test('position angles run east of north', () => {
  close(positionAngle(0, 1), 0, 1e-9, 'north');
  close(positionAngle(1, 0), 90, 1e-9, 'east');
  close(positionAngle(0, -1), 180, 1e-9, 'south');
  close(positionAngle(-1, 0), 270, 1e-9, 'west');
  close(angleBetween(359, 1), 2, 1e-9);
  close(angleBetween(90, 270), 180, 1e-9);
});

test('carrying a catalogue position moves it by motion times time', () => {
  // WISE 0855−0714: −8.12″/yr in RA, +0.67″/yr in Dec.
  const star = { ra: 133.7847613, dec: -7.2442498, pmRA: -8123.7, pmDE: 673.2 };
  const later = carry(star, 2015.4, 2025.4);
  const o = offsetArcsec(star.ra, star.dec, later.ra, later.dec);
  close(o.east, -81.237, 1e-3);
  close(o.north, 6.732, 1e-3);
});

/* --------------------------------------------------------------- parallax */

test('the Earth is about 1 AU from the Sun and opposite it at the solstices', () => {
  for (const mjd of [60676, 60800, 60900, 61000]) {
    close(Math.hypot(...earthPosition(mjd)), 1, 0.02, 'distance');
  }
  // June solstice 2025 (MJD 60847): the Sun is north, so the Earth is south.
  const [, , z] = earthPosition(60847);
  close(z, -Math.sin(23.44 * Math.PI / 180), 0.01);
});

test('parallax traces an ellipse whose size is the parallax', () => {
  // A star at the north ecliptic pole sees a circle of radius ϖ.
  const plx = 500;
  let maxR = 0; let minR = Infinity;
  for (let d = 0; d < 365; d += 5) {
    const o = parallaxOffset(270, 66.56, plx, 60676 + d);
    const r = Math.hypot(o.east, o.north);
    maxR = Math.max(maxR, r);
    minR = Math.min(minR, r);
  }
  close(maxR, 0.5, 0.02, 'pole max');
  close(minR, 0.5, 0.02, 'pole min');
  // A star on the ecliptic swings ±ϖ along it and not at all across it.
  let maxNorth = 0;
  for (let d = 0; d < 365; d += 5) maxNorth = Math.max(maxNorth, Math.abs(parallaxOffset(90, 23.44, plx, 60676 + d).north));
  assert.ok(maxNorth < 0.03, `ecliptic star moved ${maxNorth}″ across the ecliptic`);
});

test('parallax pushes a star away from where the Earth stands', () => {
  // About 21 March the Sun is at RA 0°, so the Earth is at RA 180° (x = −1).
  // Seen from there, a star at RA 90° on the equator is shifted towards +x,
  // which at RA 90° is towards smaller right ascension: west, by ϖ.
  const o = parallaxOffset(90, 0, 1000, 60755);
  close(o.east, -1, 0.03);
  close(o.north, 0, 0.03);
});

test('no parallax, no displacement', () => {
  assert.deepEqual(parallaxOffset(10, 10, null, 60800), { east: 0, north: 0 });
  assert.deepEqual(parallaxOffset(10, 10, -5, 60800), { east: 0, north: 0 });
});

test('the expected offset is motion over the years since AllWISE plus parallax on the day', () => {
  const star = { ra: 63.84, dec: -9.58, pmRA: 2214.2, pmDE: 536.1, plx: 0 };
  const mjd = ALLWISE_MJD + 15 * 365.25;
  const o = expectedOffset(star, mjd);
  close(o.east, 2.2142 * 15, 1e-9);
  close(o.north, 0.5361 * 15, 1e-9);
  const withPlx = expectedOffset({ ...star, plx: 175.2 }, mjd);
  const p = parallaxOffset(star.ra, star.dec, 175.2, mjd);
  close(withPlx.east - o.east, p.east, 1e-12);
  close(withPlx.north - o.north, p.north, 1e-12);
});

/* -------------------------------------------------------------- centroids */

/** A Gaussian star on a flat sky, optionally with a fixed pseudo-random noise. */
function image(width, height, { x, y, sigma = 2.1, peak = 100, sky = 5, noise = 0, seed = 1 }) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const out = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      out[j * width + i] = sky + peak * Math.exp(-((i - x) ** 2 + (j - y) ** 2) / (2 * sigma * sigma)) + noise * gauss();
    }
  }
  return out;
}

test('the windowed centroid lands on a Gaussian star to a hundredth of a sample', () => {
  const w = 60; const h = 50;
  for (const [x, y] of [[30.3, 20.7], [12.5, 33.25], [41.9, 25.05]]) {
    const im = image(w, h, { x, y });
    const c = windowedCentroid(im, w, h, Math.round(x), Math.round(y), 2.1, 5);
    assert.ok(c.converged);
    close(c.x, x, 0.01, 'x');
    close(c.y, y, 0.01, 'y');
  }
});

test('with noise the centroid error is of the size centroidSigma says', () => {
  const w = 60; const h = 60;
  const errs = [];
  for (let seed = 1; seed <= 40; seed++) {
    const im = image(w, h, { x: 30.4, y: 29.6, peak: 20, noise: 2, seed });
    const c = windowedCentroid(im, w, h, 30, 30, 2.1, 5);
    errs.push(c.x - 30.4);
  }
  const rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
  assert.ok(rms < 0.6, `rms ${rms} samples`);
  // Larger SNR, smaller error; infinite error with no signal.
  assert.ok(centroidSigma(50) < centroidSigma(10));
  assert.equal(centroidSigma(0), Infinity);
});

test('a centroid that runs off with no source says it did not converge', () => {
  const w = 40; const h = 40;
  const flat = new Float32Array(w * h).fill(3);
  const c = windowedCentroid(flat, w, h, 20, 20, 2, 3);
  assert.equal(c.converged, false);
});

test('the matched filter picks the star, not a single hot sample', () => {
  const w = 60; const h = 60;
  const im = image(w, h, { x: 35, y: 30, peak: 30 });
  im[30 * w + 25] = 200; // one hot sample, brighter than the star's peak
  const p = findPeak(im, w, h, 30, 30, 12, 2.1, 5);
  assert.deepEqual([p.x, p.y], [35, 30]);
});

test('the peak search stays inside its radius', () => {
  const w = 80; const h = 80;
  const im = image(w, h, { x: 60, y: 60, peak: 500 });
  const p = findPeak(im, w, h, 20, 20, 6, 2.1, 5);
  assert.ok(Math.hypot(p.x - 20, p.y - 20) <= 6);
});

test('sky and aperture sums', () => {
  const w = 50; const h = 50;
  const im = image(w, h, { x: 25, y: 25, peak: 0, sky: 7 });
  close(annulusMedian(im, w, h, 25, 25, 10, 15), 7, 1e-6);
  const star = image(w, h, { x: 25, y: 25, sigma: 2, peak: 10, sky: 7 });
  const ap = apertureSum(star, w, h, 25, 25, 12, 7);
  // The whole Gaussian: 2π σ² × peak.
  close(ap.sum, 2 * Math.PI * 4 * 10, 0.5);
  const holed = star.slice();
  holed[25 * w + 25] = NaN;
  assert.equal(apertureSum(holed, w, h, 25, 25, 12, 7).holes, 1);
  assert.ok(Number.isNaN(median([NaN])));
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('stacking averages sample by sample and skips holes', () => {
  const a = new Float32Array([1, 2, NaN, 4]);
  const b = new Float32Array([3, NaN, NaN, 8]);
  const s = stackMean([a, b]);
  assert.deepEqual([...s.slice(0, 2)], [2, 2]);
  assert.ok(Number.isNaN(s[2]));
  assert.equal(s[3], 6);
});

test('frames split into seasons at gaps of three weeks', () => {
  const f = [60800, 60801.5, 60803, 60990, 60995, 61170].map((mjd) => ({ mjd }));
  assert.deepEqual(seasons(f.reverse()).map((g) => g.length), [3, 2, 1]);
});

/* ------------------------------------------------------------- comparison */

test('a source where the motion says, far from AllWISE, is recovered', () => {
  const r = compareMotion({ east: -128.9, north: 10.9 }, { east: -129.1, north: 10.7 }, 0.4);
  assert.equal(r.verdict, 'recovered');
  assert.equal(r.withinErrors, true);
  close(r.expectedShift, Math.hypot(129.1, 10.7), 1e-9);
  close(r.residual, Math.hypot(0.2, 0.2), 1e-9);
  close(r.expectedPA, positionAngle(-129.1, 10.7), 1e-9);
});

test('a source still at its AllWISE position is not a recovery', () => {
  const r = compareMotion({ east: 0.1, north: -0.2 }, { east: -30, north: 5 }, 0.4);
  assert.equal(r.verdict, 'disagrees');
});

test('a motion under five sigma is too small to tell', () => {
  const r = compareMotion({ east: 1.0, north: 0.5 }, { east: 0.9, north: 0.6 }, 0.4);
  assert.equal(r.verdict, 'too small to tell');
});

test('outside the stated errors but within half a pixel is a recovery, flagged', () => {
  const r = compareMotion({ east: -127.5, north: 10.7 }, { east: -129.1, north: 10.7 }, 0.3);
  assert.equal(r.verdict, 'recovered');
  assert.equal(r.withinErrors, false);
  assert.ok(RESIDUAL_FLOOR_ARCSEC > 3 && RESIDUAL_FLOOR_ARCSEC < 3.1);
  const far = compareMotion({ east: -120, north: 10.7 }, { east: -129.1, north: 10.7 }, 0.3);
  assert.equal(far.verdict, 'disagrees');
});

test('the SPHEREx-only fit returns the motion of points on a line', () => {
  const pts = [2025.3, 2025.8, 2026.3].map((t) => ({ t, east: -8 * (t - 2025), north: 0.7 * (t - 2025), sigma: 0.4 }));
  const fit = fitMotion(pts);
  close(fit.pmEast, -8, 1e-9);
  close(fit.pmNorth, 0.7, 1e-9);
  close(fit.pa, positionAngle(-8, 0.7), 1e-9);
  assert.ok(fit.sigma > 0);
  // Points off the line by more than their errors widen the stated error.
  const four = [...pts, { t: 2026.8, east: -8 * 1.8, north: 0.7 * 1.8, sigma: 0.4 }];
  const noisy = four.map((p, i) => ({ ...p, east: p.east + (i % 2 ? 1 : -1) }));
  assert.ok(fitMotion(noisy).sigma > fitMotion(four).sigma * 1.5);
  assert.ok(fitMotion(noisy).reducedChi2 > 1);
  assert.equal(fitMotion(pts.slice(0, 1)), null);
  assert.equal(fitMotion([pts[0], { ...pts[0] }]), null);
});

test('the majority of detected seasons decides, and the odd one out is counted', () => {
  const st = (verdict, snr) => ({ verdict, snr });
  const five = [st('recovered', 17), st('recovered', 15), st('recovered', 18), st('recovered', 9), st('disagrees', 32), st('too faint', 2)];
  const h = headline(five);
  assert.equal(h.best.snr, 18);
  assert.equal(h.outliers, 1);
  // Mostly disagreeing: the brightest detected stack decides, no outliers set aside.
  const bad = headline([st('disagrees', 22), st('disagrees', 24), st('recovered', 7)]);
  assert.equal(bad.best.verdict, 'disagrees');
  assert.equal(bad.outliers, 0);
  // Nothing detected: the brightest stack, still too faint.
  assert.equal(headline([st('too faint', 3), st('too faint', 4)]).best.snr, 4);
  assert.equal(headline([]).best, null);
});

/* ------------------------------------------------------------ field stars */

test('field-star offsets give the median shift of the image and its scatter', () => {
  const stars = [[10, 10], [10.01, 10], [10, 10.01], [10.01, 10.01], [10.02, 10]].map(([ra, dec]) => ({ ra, dec, pmRA: 0, pmDE: 0, mag: 14 }));
  // An image whose WCS puts every star 0.3″ east and 0.1″ south of Gaia.
  const measure = (at) => ({ ...applyOffset(at.ra, at.dec, 0.3, -0.1), snr: 50, converged: true });
  const r = fieldStarOffsets(measure, stars, 2016.0);
  assert.equal(r.n, 5);
  close(r.east, 0.3, 1e-6);
  close(r.north, -0.1, 1e-6);
  close(r.scatter, 0, 1e-6);
  // Faint, lost or avoided stars are left out.
  assert.equal(fieldStarOffsets((at) => ({ ...at, snr: 5, converged: true }), stars, 2016).n, 0);
  assert.equal(fieldStarOffsets((at) => ({ ...applyOffset(at.ra, at.dec, 5, 0), snr: 50, converged: true }), stars, 2016).n, 0);
  assert.equal(fieldStarOffsets(measure, stars, 2016, { avoid: [{ ra: 10.01, dec: 10.005 }], avoidArcsec: 3600 }).n, 0);
});

test('only stars without a bright close neighbour are used', () => {
  const stars = [
    { ra: 10, dec: 10, mag: 14 },
    { ra: 10 + 5 / 3600, dec: 10, mag: 15 }, // 5″ away, within 2.5 mag: both go
    { ra: 10.1, dec: 10, mag: 13 },
    { ra: 10.1 + 8 / 3600, dec: 10, mag: 18 }, // faint neighbour: the bright one stays
  ];
  assert.deepEqual(isolatedStars(stars).map((s) => s.mag), [13]);
});

/* ---------------------------------------------------------------- parsing */

test('VizieR TSV: header, units and dashes are skipped; blanks are empty', () => {
  const text = [
    '#', '#Column\tName', 'Name\tpmRA\tplx', ' \tmas/yr\tmas', '----\t----\t---',
    'WISE 0855-0714  \t -8123.70\t 439.0', 'Gl 845BC\t3967.03\t', '',
  ].join('\n');
  const rows = parseTsv(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Name, 'WISE 0855-0714');
  assert.equal(rows[0].pmRA, '-8123.70');
  assert.equal(rows[1].plx, '');
});

test('spectral type codes: L0 = 0, T0 = 10, Y0 = 20', () => {
  assert.equal(spectralType(24), 'Y4');
  assert.equal(spectralType(17.5), 'T7.5');
  assert.equal(spectralType(7.5), 'L7.5');
  assert.equal(spectralType(NaN), null);
});

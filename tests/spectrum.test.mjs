/**
 * The spectrum of a mark: which exposures are read, what wavelength the file
 * gives at a pixel, and what an aperture sum is in millijansky.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMIT_SIGMA, parseWaveTable, wavelengthAt, placeInBand,
  apertureMJy, fluxPoint, dateSpan, fluxAxis, fluxDigits,
} from '../public/js/spectrum.js';
import { magAB, limitAB } from '../public/js/depth.js';
import { header } from './fixtures.mjs';

const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

/** A WCS-WAVE extension as SPHEREx writes it: X, Y and a (2, nx, ny) VALUES array. */
function waveTable({ x, y, wave, width, name = 'WCS-WAVE' }) {
  const nx = x.length;
  const ny = y.length;
  const head = header([
    ['XTENSION', 'BINTABLE'], ['BITPIX', 8], ['NAXIS', 2],
    ['NAXIS1', 4 * (nx + ny + 2 * nx * ny)], ['NAXIS2', 1], ['PCOUNT', 0], ['GCOUNT', 1],
    ['TFIELDS', 3], ['EXTNAME', name],
    ['TTYPE1', 'X'], ['TFORM1', `${nx}J`], ['TDIM1', `(${nx})`],
    ['TTYPE2', 'Y'], ['TFORM2', `${ny}J`], ['TDIM2', `(${ny})`],
    ['TTYPE3', 'VALUES'], ['TFORM3', `${2 * nx * ny}E`], ['TDIM3', `(2,${nx},${ny})`],
    ['END'],
  ]);
  const buf = new ArrayBuffer(head.length + 2880);
  new Uint8Array(buf).set(head);
  const view = new DataView(buf, head.length);
  x.forEach((v, i) => view.setInt32(i * 4, v, false));
  y.forEach((v, j) => view.setInt32((nx + j) * 4, v, false));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const at = (nx + ny) * 4 + 4 * 2 * (i + nx * j);
      view.setFloat32(at, wave(x[i], y[j]), false);
      view.setFloat32(at + 4, width(x[i], y[j]), false);
    }
  }
  return buf;
}

test('parseWaveTable + wavelengthAt: the grid the file has, bilinear between samples', () => {
  // Wavelength falls along Y and bows a little along X, as on the real detectors.
  const wave = (px, py) => 1.65 - 0.00027 * (py - 1) + 0.00001 * (px - 1);
  const width = (px, py) => wave(px, py) / 41;
  const x = [1, 256, 511, 766, 1021, 1275, 1530, 1785, 2040];
  // An uneven Y, with two samples one pixel apart: D3 and D4 are written so.
  const y = [1, 36, 71, 105, 140, 141, 379, 617, 855, 1091, 1326, 1564, 1802, 2040];
  const table = parseWaveTable(waveTable({ x, y, wave, width }));
  assert.equal(table.nx, 9);
  assert.equal(table.ny, 14);
  assert.deepEqual(table.x, x);
  assert.deepEqual(table.y, y);

  // A plane is reproduced exactly by bilinear interpolation, at and between samples.
  for (const [px, py] of [[1, 1], [2040, 2040], [511, 140], [900.25, 140.5], [1700.5, 1234.75], [3, 2039]]) {
    const got = wavelengthAt(table, px, py);
    close(got.um, wave(px, py), 2e-6, `wavelength at ${px},${py}`);
    close(got.width, width(px, py), 2e-6, `bandwidth at ${px},${py}`);
  }
  assert.equal(wavelengthAt(table, 2100, 500), null, 'off the detector');
  assert.equal(wavelengthAt(table, NaN, 500), null);
  assert.equal(wavelengthAt(null, 10, 10), null, 'no table, no wavelength');
});

test('parseWaveTable refuses anything that is not the table', () => {
  const args = { x: [1, 2040], y: [1, 2040], wave: () => 1, width: () => 0.03 };
  assert.equal(parseWaveTable(waveTable({ ...args, name: 'PSF' })), null, 'another extension');
  assert.equal(parseWaveTable(new ArrayBuffer(5760)), null, 'no header at all');
  assert.equal(parseWaveTable(waveTable(args).slice(0, 2880 + 16)), null, 'data cut short');
  assert.ok(parseWaveTable(waveTable(args)));
});

test('a table of zeros is not a wavelength', () => {
  const table = parseWaveTable(waveTable({ x: [1, 2040], y: [1, 2040], wave: () => 0, width: () => 0 }));
  assert.equal(wavelengthAt(table, 100, 100), null);
});

test('placeInBand: a read wavelength where it is, an unread one as the whole band', () => {
  const d2 = { band: 'D2', emMin: 1.10, emMax: 1.65 };
  const read = placeInBand(d2, { um: 1.48, width: 0.036 });
  assert.equal(read.measured, true);
  close(read.um, 1.48, 1e-12, 'um');
  close(read.from, 1.462, 1e-12, 'from');
  close(read.to, 1.498, 1e-12, 'to');

  for (const wave of [null, undefined, { um: 3.2, width: 0.05 }]) {
    const unread = placeInBand(d2, wave);
    assert.equal(unread.measured, false, 'never a band centre passed off as measured');
    close(unread.um, 1.375, 1e-12, 'centre');
    assert.deepEqual([unread.from, unread.to], [1.10, 1.65]);
  }
});

test('apertureMJy is the flux magAB turns into a magnitude', () => {
  // 3631 Jy is AB 0, so mJy and AB must agree for any sum.
  for (const sum of [0.01, 1, 37.5, 4000]) {
    const mJy = apertureMJy(sum);
    close(-2.5 * Math.log10(mJy / 3631e3), magAB(sum), 1e-9, `sum ${sum}`);
  }
  // One MJy/sr over one 6.15″ pixel.
  close(apertureMJy(1), 0.8890, 5e-4, '1 MJy/sr · pixel');
});

test('fluxPoint: detections with errors, non-detections as 5σ limits', () => {
  const noise = 0.025;
  const seen = fluxPoint({ flux: 20, noise, snr: 400 });
  assert.equal(seen.kind, 'detection');
  close(seen.mJy, apertureMJy(20), 1e-12, 'flux');
  close(seen.err, apertureMJy(noise * 3), 1e-12, 'nine pixels of noise');

  const limit = fluxPoint({ limit: true, noise });
  assert.equal(limit.kind, 'limit');
  assert.equal(LIMIT_SIGMA, 5);
  close(limit.mJy, 5 * apertureMJy(noise * 3), 1e-12, '5σ over the aperture');
  // The same number the depth panel quotes for this noise.
  close(-2.5 * Math.log10(limit.mJy / 3631e3), limitAB(noise), 1e-9, 'agrees with limitAB');

  assert.equal(fluxPoint({ flux: -0.4, noise }).kind, 'limit', 'a peak whose aperture sums to nothing');
  assert.equal(fluxPoint({ flux: 0, noise }).kind, 'limit', 'never a zero');
  assert.equal(fluxPoint({ flux: null, noise }), null, 'a holed aperture is no measurement');
  assert.equal(fluxPoint(null), null, 'no pixels there');
  assert.equal(fluxPoint({ flux: 3, noise: 0 }), null, 'no noise estimate, no point');
});

test('dateSpan: first and last exposure, in days', () => {
  const span = dateSpan([{ mjd: 61034.69 }, { mjd: 61040.26 }, { mjd: 61034.08 }, { mjd: undefined }]);
  close(span.from, 61034.08, 1e-9, 'from');
  close(span.to, 61040.26, 1e-9, 'to');
  close(span.days, 6.18, 1e-9, 'days');
  assert.equal(dateSpan([]), null);
});

test('fluxAxis: holds every point, limit and error bar, with a few round ticks', () => {
  const points = [
    { kind: 'detection', mJy: 21.2, err: 0.06 },
    { kind: 'detection', mJy: 4.45, err: 0.11 },
    { kind: 'limit', mJy: 0.21, err: 0.04 },
    { kind: 'limit', mJy: 0.76, err: 0.15 },
  ];
  const axis = fluxAxis(points);
  assert.ok(axis.lo < 0.21 && axis.hi > 21.26);
  assert.deepEqual(axis.ticks, [0.1, 1, 10]);
  // The lowest point is a limit, so there is room under it for its arrow.
  assert.ok(axis.lo <= 0.21 / 2.5 + 1e-12);

  // A flat spectrum still gets half a decade and at least one label.
  const flat = fluxAxis([{ kind: 'detection', mJy: 3, err: 0.01 }, { kind: 'detection', mJy: 3.1, err: 0.01 }]);
  assert.ok(Math.log10(flat.hi / flat.lo) >= 0.5 - 1e-9);
  assert.ok(flat.ticks.length >= 1 && flat.ticks.length <= 4);
  for (const tick of flat.ticks) assert.ok(tick >= flat.lo && tick <= flat.hi);

  // An error bar larger than the value does not drag the axis to zero.
  const noisy = fluxAxis([{ kind: 'detection', mJy: 0.5, err: 0.9 }]);
  assert.ok(noisy.lo > 0 && Number.isFinite(noisy.lo));
  assert.equal(fluxAxis([]), null);
});

test('fluxDigits: about three significant figures', () => {
  assert.equal(fluxDigits(21.17), 1);
  assert.equal(fluxDigits(4.448), 2);
  assert.equal(fluxDigits(0.332), 3);
  assert.equal(fluxDigits(1234), 0);
  assert.equal(fluxDigits(0.00002), 4);
});

test('measure with orLimit: blank sky gives its noise, not null; a source gives flux and noise', async () => {
  const { SkyView } = await import('../public/js/sky.js');
  const { TangentGrid } = await import('../public/js/wcs.js');
  const grid = new TangentGrid(13.4, 3.8, 0.1, 200, 200);
  // Flat sky with a deterministic ripple standing in for noise.
  const data = Float32Array.from({ length: 200 * 200 }, (_, k) => 0.3 + 0.01 * Math.sin(k * 12.9898));
  const visit = { frame: { mjd: 61034.69, obsId: 'A' }, stamp: { data, width: 200, height: 200, meta: { detectorSigma: 0.02 } } };
  const measure = (ra, dec, opts) => SkyView.prototype.measure.call({ grid }, visit, ra, dec, opts);
  const [ra, dec] = grid.indexToWorld(100, 100);

  assert.equal(measure(ra, dec), null, 'unchanged for every other caller');
  const blank = measure(ra, dec, { orLimit: true });
  assert.equal(blank.limit, true);
  assert.equal(blank.noise, 0.02, 'the detector floor measure detects against');
  assert.equal(fluxPoint(blank).kind, 'limit');

  for (let j = 98; j <= 102; j++) for (let i = 98; i <= 102; i++) data[j * 200 + i] += 2 * Math.exp(-((i - 100) ** 2 + (j - 100) ** 2) / 4);
  const seen = measure(ra, dec, { orLimit: true });
  assert.ok(!seen.limit && seen.flux > 0 && seen.noise === 0.02);
  assert.equal(fluxPoint(seen).kind, 'detection');
});

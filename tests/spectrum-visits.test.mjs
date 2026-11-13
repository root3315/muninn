/**
 * The spectrum from every exposure: which exposures are read, which share a
 * wavelength, the shape under the scatter, and what a change in brightness
 * at one wavelength amounts to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESOLVING_POWER, MAX_POOL, SAME_RUN_DAYS,
  spreadPick, motionOf, visitPool, resolutionWidth, wavelengthWindows, chooseMeasured,
  medianLine, magOfMJy, magErrOf, variability, visitPoint, placeInBand, nearSaturation, strayDetections,
} from '../public/js/spectrum.js';

const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

const frame = (band, mjd, n = 0) => ({ band, mjd, url: `${band}/${mjd}/${n}`, obsId: `${mjd}_${n}` });

test('spreadPick: first and last always, evenly between', () => {
  const list = Array.from({ length: 11 }, (_, i) => i);
  assert.deepEqual(spreadPick(list, 3), [0, 5, 10]);
  assert.deepEqual(spreadPick(list, 2), [0, 10]);
  assert.deepEqual(spreadPick(list, 1), [5]);
  assert.deepEqual(spreadPick(list, 0), []);
  assert.deepEqual(spreadPick([1, 2], 5), [1, 2], 'never more than there are');
});

test('visitPool: the plate first, the rest shared evenly between the bands', () => {
  const frames = [];
  for (let d = 0; d < 40; d++) frames.push(frame('D1', 100 + d));
  for (let d = 0; d < 3; d++) frames.push(frame('D2', 100 + d));
  for (let d = 0; d < 40; d++) frames.push(frame('D3', 100 + d));
  frames.push(frame('D3', 100)); // the same file listed twice
  frames.push({ ...frame('D4', NaN) });
  const loaded = new Set([frames[5].url, frames[6].url]);
  const pool = visitPool(frames, { loaded, limit: 20 });
  assert.equal(pool.length, 20);
  assert.ok(pool.includes(frames[5]) && pool.includes(frames[6]), 'every visit on the plate');
  const count = (band) => pool.filter((f) => f.band === band).length;
  assert.equal(count('D2'), 3, 'a band with few gives all it has');
  // 18 left after the plate: D2 takes its 3, D1 and D3 share the other 15 within one.
  assert.ok(Math.abs(count('D1') - 2 - count('D3')) <= 1, `${count('D1')} vs ${count('D3')}`);
  assert.equal(new Set(pool.map((f) => f.url)).size, pool.length, 'one entry per file');
  assert.ok(pool.every((f, i) => i === 0 || pool[i - 1].mjd <= f.mjd), 'in time order');
  const d3 = pool.filter((f) => f.band === 'D3').map((f) => f.mjd);
  assert.equal(Math.min(...d3), 100, 'spread from the first date');
  assert.equal(Math.max(...d3), 139, '…to the last');

  const window = visitPool(frames, { from: 110, to: 112 });
  assert.ok(window.every((f) => f.mjd >= 110 && f.mjd <= 112), 'only the dates the motion allows');
  assert.equal(visitPool(frames).length, Math.min(MAX_POOL, 83));
});

test('motionOf: still, along a fitted track, or the one run', () => {
  const still = motionOf({ ra: 10, dec: 5, analysis: { kind: 'fixed' }, track: [
    { ra: 10.0001, dec: 5.0001, mjd: 1 }, { ra: 9.9999, dec: 4.9999, mjd: 2 }, { ra: 10.0002, dec: 5, mjd: 3 },
  ] });
  assert.equal(still.kind, 'still');
  assert.equal(still.from, -Infinity);
  close(still.at(500).ra, 10.0001, 1e-9, 'median ra');
  close(still.at(500).dec, 5, 1e-9, 'median dec');
  assert.deepEqual(motionOf({ ra: 3, dec: 4, analysis: null, track: [] }).at(1), { ra: 3, dec: 4 }, 'nothing measured: the click');

  // 0.01° a day east across RA 0, steady in dec.
  const cosd = Math.cos((20 * Math.PI) / 180);
  const track = [0, 1, 2].map((d) => ({ mjd: 100 + d, ra: (359.99 + (0.01 * d) / cosd) % 360, dec: 20 }));
  const moving = motionOf({ ra: 0, dec: 20, analysis: { kind: 'moving' }, track });
  assert.equal(moving.kind, 'moving');
  close(moving.at(101.5).ra, (359.99 + 0.015 / cosd) % 360, 1e-7, 'interpolated across RA 0');
  close(moving.at(101.5).dec, 20, 1e-9, 'dec');
  const pad = 6.15 / 3600 / 0.01;
  close(moving.from, 100 - pad, 1e-6, 'from: a pixel’s crossing before the first');
  close(moving.to, 102 + pad, 1e-6, 'to');

  const once = motionOf({ ra: 1, dec: 2, analysis: { kind: 'transient' }, track: [{ mjd: 50, ra: 1.001, dec: 2.001 }] });
  assert.equal(once.kind, 'run');
  close(once.to - once.from, 2 * SAME_RUN_DAYS, 1e-12, 'ten minutes either side');
  assert.deepEqual(once.at(50.001), { ra: 1.001, dec: 2.001 });
});

test('resolutionWidth: the file’s bandwidth, else λ/R', () => {
  assert.equal(resolutionWidth({ band: 'D2', um: 1.4, width: 0.034 }), 0.034);
  close(resolutionWidth({ band: 'D6', um: 4.8, width: null }), 4.8 / RESOLVING_POWER.D6, 1e-12, 'D6');
  assert.equal(resolutionWidth({ band: 'X', um: 1 }), null);
  assert.deepEqual(Object.keys(RESOLVING_POWER), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
  for (const R of Object.values(RESOLVING_POWER)) assert.ok(R >= 35 && R <= 130);
});

test('wavelengthWindows: one resolution element wide, one band, most populated first, never overlapping', () => {
  const p = (band, um, extra = {}) => ({ band, um, width: um / RESOLVING_POWER[band], measured: true, ...extra });
  const points = [
    // Five at 1.654 µm (D3, Δλ ≈ 0.040), two of them nearly on the edge.
    p('D3', 1.654), p('D3', 1.650), p('D3', 1.660), p('D3', 1.636), p('D3', 1.672),
    // Just outside that window: 1.70 is 0.046 away.
    p('D3', 1.700),
    // Three at 2.20 µm.
    p('D3', 2.20), p('D3', 2.21), p('D3', 2.19),
    // Two at 4.5 µm: under the minimum.
    p('D6', 4.50), p('D6', 4.51),
    // A wavelength not read never joins a window.
    p('D3', 1.654, { measured: false }),
  ];
  const windows = wavelengthWindows(points);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].band, 'D3');
  assert.equal(windows[0].members.length, 5);
  close(windows[0].um, 1.654, 1e-12, 'centred on the median');
  close(windows[0].half, 1.654 / 41 / 2, 1e-12, 'half a resolution element');
  assert.ok(!windows[0].members.some((m) => m.um === 1.7));
  assert.equal(windows[1].members.length, 3);
  close(windows[1].um, 2.2, 1e-12, 'second window');
  for (const w of windows) assert.ok(w.members.every((m) => m.band === w.band && Math.abs(m.um - w.um) <= w.half + 1e-12));
  // No two windows overlap, though every point is a candidate centre.
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      assert.ok(windows[i].band !== windows[j].band
        || Math.abs(windows[i].um - windows[j].um) >= windows[i].half + windows[j].half);
    }
  }
  assert.equal(wavelengthWindows(points, { minCount: 2 }).length, 3, 'D6 counts at two');
  assert.equal(wavelengthWindows(points, { max: 1 }).length, 1);
  // A D3 point at the same wavelength as a D4 one is a different window: other detector.
  const mixed = wavelengthWindows([p('D3', 2.41), p('D3', 2.41), p('D4', 2.41), p('D4', 2.41)], { minCount: 2 });
  assert.deepEqual(mixed.map((w) => w.members.length), [2, 2]);
});

test('chooseMeasured: the plate, the best wavelength in full, the rest spread over the bands', () => {
  const item = (band, mjd, um, loaded = false) => ({
    frame: frame(band, mjd), place: { um, width: um / RESOLVING_POWER[band], measured: true }, loaded,
  });
  const pool = [];
  // Thirty exposures that saw 1.80 µm, and sixty scattered over D1 and D4.
  for (let k = 0; k < 30; k++) pool.push(item('D3', 200 + k, 1.80 + (k % 5) * 0.002));
  for (let k = 0; k < 30; k++) pool.push(item('D1', 300 + k, 0.76 + k * 0.011));
  for (let k = 0; k < 30; k++) pool.push(item('D4', 400 + k, 2.45 + k * 0.045));
  pool.push(item('D4', 500, 3.0, true));
  pool.push({ frame: frame('D2', 600), place: null, loaded: false });

  const chosen = chooseMeasured(pool, 40);
  assert.equal(chosen.length, 40);
  assert.ok(chosen.some((i) => i.loaded), 'the visit on the plate');
  assert.ok(!chosen.some((i) => !i.place), 'nothing without a wavelength');
  const at180 = chosen.filter((i) => i.frame.band === 'D3').length;
  assert.ok(at180 >= Math.ceil(40 * 0.4), 'the best-populated wavelength takes at least its share');
  assert.ok(chosen.filter((i) => i.frame.band === 'D1').length >= 5, 'the rest still reach D1');
  assert.ok(chosen.filter((i) => i.frame.band === 'D4').length >= 5, '…and D4');
  const d3 = chosen.filter((i) => i.frame.band === 'D3').map((i) => i.frame.mjd);
  assert.equal(Math.min(...d3), 200);
  assert.equal(Math.max(...d3), 229, 'spread over its whole time span');
  assert.equal(chooseMeasured(pool.slice(0, 5), 40).length, 5, 'a small pool is read whole');
});

test('medianLine: the median detection in R/4 bins, limits and saturated left out', () => {
  const d = (band, um, mJy, kind = 'detection') => ({ band, um, mJy, err: 0.1, kind, measured: true });
  const points = [
    d('D2', 1.400, 10), d('D2', 1.401, 12), d('D2', 1.402, 50),
    d('D2', 1.403, 0.5, 'limit'), { band: 'D2', um: 1.401, kind: 'saturated', measured: true },
    d('D2', 1.60, 7), // alone in its bin: no median of one
    d('D5', 4.20, 2), d('D5', 4.205, 4),
  ];
  const line = medianLine(points);
  assert.equal(line.length, 2);
  assert.deepEqual(line.map((b) => b.band), ['D2', 'D5']);
  assert.equal(line[0].mJy, 12, 'the median, not the mean');
  assert.equal(line[0].n, 3);
  assert.equal(line[1].mJy, 3, 'an even count takes the middle two');
  // D5 is cut ~3x finer than D2: 4.2 and 4.4 are two bins there, 1.40 and 1.46 one in D2.
  assert.equal(medianLine([d('D5', 4.2, 1), d('D5', 4.4, 1)]).length, 0);
  assert.equal(medianLine([d('D2', 1.40, 1), d('D2', 1.46, 1)]).length, 1);
});

test('magnitudes from millijansky: AB zero point and the error of a ratio', () => {
  close(magOfMJy(3631e3), 0, 1e-12, '3631 Jy is AB 0');
  close(magOfMJy(1), 16.4, 0.001, '1 mJy');
  close(magErrOf(10, 0.1), 0.010857, 1e-6, '1% is 0.0109 mag');
});

test('variability: a change, a steady source, a limit that widens it, saturation, too few', () => {
  const det = (mJy, err, mjd) => ({ kind: 'detection', mJy, err, mjd });
  // A Mira-like change: 100 → 25 mJy is 1.505 mag.
  const mira = variability([det(100, 1, 1), det(60, 1, 50), det(25, 0.5, 120)]);
  assert.equal(mira.state, 'varies');
  close(mira.amp, 2.5 * Math.log10(4), 1e-9, 'peak to peak');
  close(mira.ampErr, Math.hypot(magErrOf(100, 1), magErrOf(25, 0.5)), 1e-12, 'errors in quadrature');
  assert.equal(mira.lowerBound, false);

  // 1% scatter with 1% errors: steady, and "within" is half of 3σ of the difference.
  const steady = variability([det(50, 0.5, 1), det(50.5, 0.5, 2), det(49.6, 0.5, 3)]);
  assert.equal(steady.state, 'steady');
  const err = Math.hypot(magErrOf(50.5, 0.5), magErrOf(49.6, 0.5));
  close(steady.within, (3 * err) / 2, 1e-12, 'what these visits could have missed');

  // Seen at 20 mJy, then not at all with a 5σ limit of 2 mJy: at least 2.5 mag.
  const gone = variability([det(20, 0.4, 1), det(19, 0.4, 2), { kind: 'limit', mJy: 2, err: 0.4, mjd: 3 }]);
  assert.equal(gone.state, 'varies');
  assert.equal(gone.lowerBound, true);
  close(gone.amp, 2.5, 1e-9, 'at least to the limit');
  // A faint source a little over 5σ, missed once: the limit sits just under
  // the detections and is no evidence of a change.
  const marginal = variability([det(1.7, 0.1, 1), det(1.5, 0.1, 2), { kind: 'limit', mJy: 1.15, err: 0.23, mjd: 3 }]);
  assert.notEqual(marginal.state, 'varies');
  assert.ok(!marginal.lowerBound);
  // A limit above the faint detection says nothing more.
  const shallow = variability([det(20, 0.4, 1), det(19.8, 0.4, 2), { kind: 'limit', mJy: 40, err: 8, mjd: 3 }]);
  assert.equal(shallow.state, 'steady');
  assert.equal(shallow.limits, 1);

  const sat = variability([{ kind: 'saturated' }, { kind: 'saturated' }, det(10, 0.1, 3)]);
  assert.equal(sat.state, 'saturated');
  assert.equal(sat.saturated, 2);
  assert.equal(sat.amp, undefined, 'no number from saturated pixels');
  // Saturated in a minority: those are left out, the rest compared.
  assert.equal(variability([{ kind: 'saturated' }, det(10, 0.1, 2), det(10.05, 0.1, 3)]).state, 'steady');

  const few = variability([det(10, 0.1, 1), { kind: 'limit', mJy: 30, err: 6, mjd: 2 }, { kind: 'limit', mJy: 30, err: 6, mjd: 3 }]);
  assert.equal(few.state, 'few');
  assert.equal(few.detections, 1);
  assert.equal(few.limits, 2);
  assert.equal(variability([]).state, 'few');
});

test('visitPoint: saturation is its own kind of point, with no flux', () => {
  assert.deepEqual(visitPoint({ saturated: true, flux: null, noise: null }), { kind: 'saturated' });
  assert.deepEqual(visitPoint({ saturated: true, flux: 3, noise: 0.02 }), { kind: 'saturated' }, 'an aperture on a saturated pixel');
  assert.equal(visitPoint({ flux: 20, noise: 0.025 }).kind, 'detection');
  assert.equal(visitPoint({ limit: true, noise: 0.025 }).kind, 'limit');
  assert.equal(visitPoint(null), null);
});

test('nearSaturation: the bands saturated in most exposures', () => {
  const p = (band, kind) => ({ band, kind });
  const bands = nearSaturation([
    p('D1', 'saturated'), p('D1', 'saturated'), p('D1', 'detection'),
    p('D2', 'saturated'), p('D2', 'detection'),
    p('D3', 'detection'), p('D3', 'limit'),
  ]);
  assert.deepEqual([...bands], ['D1'], 'half is not most');
  assert.equal(nearSaturation([]).size, 0);
});

test('strayDetections: a detection centred on the neighbour is another source', () => {
  const at = { ra: 248.25, dec: 66.70 };
  const cosd = Math.cos((66.70 * Math.PI) / 180);
  // Offsets in arcseconds from where each was looked for.
  const det = (key, dx, dy, kind = 'detection') => ({
    key, kind, at, ra: at.ra + dx / 3600 / cosd, dec: at.dec + dy / 3600,
  });
  const points = [
    det('a', 1, 0.5), det('b', 0.4, -0.8), det('c', -0.6, 0.2), det('d', 0.9, 1.1),
    det('e', 17, -12), // the neighbour, 21″ off
    det('f', 3, 3), // 3″ off: the same source, within a pixel
    { key: 'g', kind: 'limit', at },
  ];
  assert.deepEqual([...strayDetections(points)], ['e']);
  assert.equal(strayDetections(points.slice(0, 2)).size, 0, 'two cannot outvote each other');
  // Across RA 0 the offsets still come out in arcseconds.
  const wrap = { ra: 0.0005, dec: 0 };
  const near = (key, ra) => ({ key, kind: 'detection', at: wrap, ra, dec: 0 });
  assert.deepEqual([...strayDetections([near('x', 359.9999), near('y', 0.0001), near('z', 0.0004), near('w', 0.01)])], ['w']);
});

test('placeInBand keeps the bandwidth for the resolution element', () => {
  const d2 = { band: 'D2', emMin: 1.10, emMax: 1.65 };
  assert.equal(placeInBand(d2, { um: 1.48, width: 0.036 }).width, 0.036);
  assert.equal(placeInBand(d2, null).width, null);
});

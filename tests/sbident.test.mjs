/**
 * JPL's Small-Body Identification service: the question written for it, its
 * answer read into SkyBoT's shape, and the two services' lists made one.
 * The answer is a recorded one; nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  raSexagesimal, decSexagesimal, sbIdentUrl, splitName, parseSbIdent, mergeBodies,
} from '../public/js/sbident.js';
import { arcsecBetween } from '../public/js/catalog.js';

/* Recorded from ssd-api.jpl.nasa.gov on 13 Nov 2026: 22h −12°, 15 Aug 2025 12:00 UTC, ±0.3°, V ≤ 20, two passes. */
const RECORDED = {
  signature: { source: 'NASA/JPL Small-Body Identification API', version: '1.1' },
  fields_second: [
    'Object name', 'Astrometric RA (hh:mm:ss)', 'Astrometric Dec (dd mm\'ss")', 'Dist. from center RA (")',
    'Dist. from center Dec (")', 'Dist. from center Norm (")', 'Visual magnitude (V)', 'RA rate ("/h)', 'Dec rate ("/h)',
  ],
  n_second_pass: 3,
  data_second_pass: [
    ['103377 (2000 AG119)', '21:59:27.70', '-11 52\'18.3"', '-474.', '462.', '661.7', '19.8', '-2.852E+01', '-1.606E+01'],
    ['325362 (2008 OZ21)', '22:00:06.78', '-11 48\'20.2"', '99.4', '700.', '706.8', '18.4', '-3.523E+01', '5.232E+00'],
    ['(2016 BH147)', '21:59:53.17', '-12 02\'38.6"', '-100.', '-159.', '187.6', '21.3', '-6.055E+01', '2.424E+01'],
  ],
};

test('the centre is written the way JPL reads it, carries and south included', () => {
  assert.equal(raSexagesimal(330), '22-00-00.00');
  assert.equal(raSexagesimal(269.452), '17-57-48.48');
  // 59.999 s rounds up into the next minute, not to "60.00".
  assert.equal(raSexagesimal(15 * (1 + 59.9999 / 3600)), '01-01-00.00');
  assert.equal(raSexagesimal(359.99999999), '00-00-00.00');
  assert.equal(decSexagesimal(4.693), '04-41-34.8');
  assert.equal(decSexagesimal(-12), 'M12-00-00.0');
  assert.equal(decSexagesimal(-0.5), 'M00-30-00.0');
});

test('the URL asks a geocentric two-pass question and keeps only the second pass', () => {
  const url = new URL(sbIdentUrl({ ra: 330, dec: -12, halfWidthDeg: 0.3, iso: '2025-08-15T12:00:00.000', magLimit: 20 }));
  assert.equal(url.origin + url.pathname, 'https://ssd-api.jpl.nasa.gov/sb_ident.api');
  const p = Object.fromEntries(url.searchParams);
  assert.deepEqual(p, {
    'mpc-code': '500', 'obs-time': '2025-08-15_12:00:00',
    'fov-ra-center': '22-00-00.00', 'fov-dec-center': 'M12-00-00.0',
    'fov-ra-hwidth': '0.3000', 'fov-dec-hwidth': '0.3000',
    'two-pass': 'true', 'suppress-first-pass': 'true', 'vmag-lim': '20.0',
  });
});

test('JPL names split the way SkyBoT names them', () => {
  assert.deepEqual(splitName('152 Atala (A875 TA)'), { num: '152', name: 'Atala' });
  assert.deepEqual(splitName('103377 (2000 AG119)'), { num: '103377', name: '2000 AG119' });
  assert.deepEqual(splitName('(2006 DK213)'), { num: null, name: '2006 DK213' });
  assert.deepEqual(splitName('C/2023 A3 (Tsuchinshan-ATLAS)'), { num: null, name: 'C/2023 A3' });
  assert.deepEqual(splitName('29P/Schwassmann-Wachmann 1'), { num: null, name: '29P/Schwassmann-Wachmann 1' });
});

test('the recorded answer reads into the shape SkyBoT answers in', () => {
  const [first, second, third] = parseSbIdent(RECORDED);
  assert.equal(first.num, '103377');
  assert.equal(first.name, '2000 AG119');
  // SkyBoT put (103377) at 329.865428, −11.871757 for the same instant: within 0.1″.
  assert.ok(arcsecBetween(first.ra, first.dec, 329.86542805, -11.87175690) < 0.1);
  assert.equal(first.mag, 19.8);
  assert.equal(first.dRA, -28.52);
  assert.equal(first.dDec, -16.06);
  assert.equal(first.cls, null);
  assert.equal(first.source, 'JPL');
  assert.match(first.link, /sbdb_lookup\.html#\/\?sstr=103377$/);
  assert.ok(Math.abs(second.dec - (-(11 + 48 / 60 + 20.2 / 3600))) < 1e-9);
  assert.equal(third.num, null);
  assert.equal(third.name, '2016 BH147');
});

test('an answer without the second-pass table is no objects, not a crash', () => {
  assert.deepEqual(parseSbIdent({ signature: {}, n_second_pass: 0 }), []);
  assert.deepEqual(parseSbIdent(null), []);
});

test('both services merged: each object once, SkyBoT kept where both have it', () => {
  const skybot = [
    { num: '103377', name: '2000 AG119', mag: 19.94, cls: 'MB>Middle', source: 'SkyBoT' },
    { num: null, name: '2006 DK213', mag: 22.1, cls: 'MB>Inner', source: 'SkyBoT' },
  ];
  const jpl = parseSbIdent(RECORDED);
  const merged = mergeBodies(skybot, jpl);
  assert.deepEqual(merged.map((o) => o.num ?? o.name), ['325362', '103377', '2016 BH147', '2006 DK213']);
  assert.equal(merged.find((o) => o.num === '103377').source, 'SkyBoT');
  assert.equal(merged.find((o) => o.num === '325362').source, 'JPL');
  // SkyBoT down: JPL alone is the answer.
  assert.equal(mergeBodies([], jpl).length, 3);
});

test('the angular distance is right at the arcsecond scale and across 0h', () => {
  assert.ok(Math.abs(arcsecBetween(10, 0, 10, 1 / 3600) - 1) < 1e-6);
  assert.ok(Math.abs(arcsecBetween(10, 60, 10 + 2 / 3600, 60) - 1) < 1e-4);
  assert.ok(Math.abs(arcsecBetween(359.9995, 0, 0.0005, 0) - 3.6) < 1e-4);
});

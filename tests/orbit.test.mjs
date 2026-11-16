/**
 * The orbit a card draws: JPL's answer read right, and the two-body sums put
 * the body and the Earth where JPL's own ephemeris has them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sbdbOrbitUrl, readOrbit, drawable, positionAt, orbitPath, earthAt,
  referencesFor, sketchReach, julianDay,
} from '../public/js/orbit.js';

/** SBDB's answer for (152) Atala, full precision, as it came on 2026-11-16. */
const ATALA = {
  object: {
    neo: false, pha: false, des: '152', fullname: '152 Atala (A875 VB)', kind: 'an',
    orbit_class: { code: 'MBA', name: 'Main-belt Asteroid' }, shortname: '152 Atala',
  },
  orbit: {
    epoch: '2461200.5',
    elements: [
      ['e', '.08281166584529963'], ['a', '3.136344274999039'], ['q', '2.876618380922'],
      ['i', '12.1246869840799'], ['om', '39.86237303338741'], ['w', '59.25273256878273'],
      ['ma', '331.1330291158661'], ['tp', '2461363.179464321147'], ['per', '2028.775633947858'],
      ['n', '.1774469261046205'], ['ad', '3.396070169076078'],
    ].map(([name, value]) => ({ name, value })),
  },
};

/** JPL Horizons, heliocentric ecliptic J2000, 2026-09-17 0h TDB, AU. */
const HORIZONS_ATALA = { x: 0.2328857845, y: 2.8396665058, z: 0.4361892496 };
const HORIZONS_EARTH = { x: 0.9993145539, y: -0.1091754989 };
const JD = 2461300.5;

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, (p.z ?? 0) - (q.z ?? 0));

test('asks SBDB for full precision', () => {
  const url = new URL(sbdbOrbitUrl('2015 BZ509'));
  assert.equal(url.searchParams.get('sstr'), '2015 BZ509');
  assert.equal(url.searchParams.get('full-prec'), 'true');
});

test('reads the body and its elements', () => {
  const k = readOrbit(ATALA);
  assert.equal(k.des, '152');
  assert.equal(k.name, '152 Atala');
  assert.equal(k.comet, false);
  assert.deepEqual(k.cls, { code: 'MBA', name: 'Main-belt Asteroid' });
  assert.ok(Math.abs(k.a - 3.1363) < 1e-4);
  assert.ok(Math.abs(k.Q - 3.3961) < 1e-4);
  assert.ok(Math.abs(k.years - 5.555) < 1e-3);
  assert.equal(k.epoch, 2461200.5);
  assert.ok(drawable(k));
});

test('no single body is no orbit', () => {
  assert.equal(readOrbit({ list: [{ pdes: '1', name: 'Ceres' }], code: '300' }), null);
  assert.equal(readOrbit(null), null);
});

test('an open orbit is read but not drawn', () => {
  const k = readOrbit({
    object: { des: 'C/2019 Q4', kind: 'cu', orbit_class: { code: 'HYP', name: 'Hyperbolic Comet' } },
    orbit: { epoch: '2458800.5', elements: [['e', '3.356'], ['q', '2.006'], ['i', '44.05'], ['om', '308.1'], ['w', '209.1'], ['tp', '2458826.05']].map(([name, value]) => ({ name, value })) },
  });
  assert.equal(k.comet, true);
  assert.ok(Number.isNaN(k.a));
  assert.equal(drawable(k), false);
  assert.equal(positionAt(k, JD), null);
  assert.deepEqual(orbitPath(k), []);
});

test('the body is where Horizons has it, within a hundredth of an AU', () => {
  const p = positionAt(readOrbit(ATALA), JD);
  assert.ok(dist(p, HORIZONS_ATALA) < 0.01, `off by ${dist(p, HORIZONS_ATALA).toFixed(4)} AU`);
});

test('the same place from the perihelion date alone', () => {
  const k = { ...readOrbit(ATALA), ma: NaN };
  assert.ok(dist(positionAt(k, JD), HORIZONS_ATALA) < 0.01);
});

test('the path lies between perihelion and aphelion', () => {
  const k = readOrbit(ATALA);
  const path = orbitPath(k, 90);
  assert.equal(path.length, 90);
  for (const p of path) {
    const r = Math.hypot(p.x, p.y, p.z);
    assert.ok(r >= k.q - 1e-9 && r <= k.Q + 1e-9);
  }
});

test('Kepler holds for a very eccentric orbit', () => {
  const k = { a: 17.8, e: 0.967, i: 162.3, om: 58.4, w: 111.3, ma: 0.5, n: 0.9856076686 / 17.8 ** 1.5, epoch: JD };
  const p = positionAt(k, JD);
  assert.ok(Number.isFinite(p.x) && Math.hypot(p.x, p.y, p.z) < 1);
});

test('the Earth is where Horizons has it', () => {
  assert.ok(dist(earthAt(JD), HORIZONS_EARTH) < 0.002);
});

test('the sketch carries the planets the orbit reaches past', () => {
  const keys = (k) => referencesFor(k).map((p) => p.key);
  assert.deepEqual(keys({ Q: 1.3 }), ['earth']);
  assert.deepEqual(keys(readOrbit(ATALA)), ['earth', 'jupiter']);
  assert.deepEqual(keys({ Q: 45 }), ['earth', 'jupiter', 'neptune']);
  assert.equal(sketchReach({ Q: 1.3 }), 1.3);
  assert.equal(sketchReach(readOrbit(ATALA)), 5.203);
});

test('Julian dates', () => {
  assert.equal(julianDay(Date.UTC(2000, 0, 1, 12)), 2451545);
});

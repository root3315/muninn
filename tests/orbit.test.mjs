/**
 * The orbit a card draws: JPL's answer read right, and the two-body sums put
 * the body and the Earth where JPL's own ephemeris has them; the bodies on
 * nearly the same orbit asked for, read and put in order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import {
  sbdbOrbitUrl, readOrbit, drawable, positionAt, orbitPath, earthAt,
  referencesFor, sketchReach, julianDay,
  nearBox, nearQueryUrl, readNear, dSH, closestOrbits, crossesEarth, trojanPoint, NEAR_ROWS,
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

/**
 * SBDB Query's answer for the box round (152) Atala, as the relay asks it
 * after one narrowing, saved on 2026-11-16 (the wide box held 15 406).
 */
const NEAR_ATALA = JSON.parse(readFileSync(new URL('./fixtures/sbdb-near-atala.json', import.meta.url), 'utf8'));
/** The narrowing the relay came to for Atala that day. */
const ATALA_SCALE = 0.19977093077829608;

test('the box round an orbit', () => {
  const k = readOrbit(ATALA);
  assert.deepEqual(nearBox(k), { a: [3.0736, 3.1991], e: [0.0528, 0.1128], i: [10.62, 13.62] });
  assert.deepEqual(nearBox(k, ATALA_SCALE), NEAR_ATALA.box);
  // Kept to what an orbit can be.
  assert.deepEqual(nearBox({ a: 1, e: 0.01, i: 0.5 }), { a: [0.98, 1.02], e: [0, 0.04], i: [0, 2] });
  assert.equal(nearBox({ a: 1, e: 0.99, i: 179.5 }).e[1], 0.9999);
  assert.equal(nearBox({ a: 1, e: 0.99, i: 179.5 }).i[1], 180);
});

test('the question to JPL holds only the box', () => {
  const url = new URL(nearQueryUrl(NEAR_ATALA.box));
  assert.equal(url.origin + url.pathname, 'https://ssd-api.jpl.nasa.gov/sbdb_query.api');
  assert.deepEqual(JSON.parse(url.searchParams.get('sb-cdata')), { AND: ['a|RG|3.1238|3.1489', 'e|RG|0.0768|0.0888', 'i|RG|11.83|12.42'] });
  assert.equal(url.searchParams.get('limit'), String(NEAR_ROWS));
  assert.equal(url.searchParams.get('fields'), 'full_name,pdes,a,e,q,i,om,w,class');
});

test('reads the rows JPL sent', () => {
  const { count, rows } = readNear(NEAR_ATALA.answer);
  assert.equal(count, 137);
  assert.equal(rows.length, 137);
  const atala = rows.find((r) => r.des === '152');
  assert.equal(atala.name, '152 Atala (A875 VB)');
  assert.equal(atala.cls, 'MBA');
  assert.ok(Math.abs(atala.a - 3.136) < 1e-3 && Math.abs(atala.om - 39.86) < 0.01);
  for (const r of rows) {
    assert.ok(r.a >= 3.1238 - 1e-3 && r.a <= 3.1489 + 1e-3, r.des);
    assert.ok(r.i >= 11.83 - 0.01 && r.i <= 12.42 + 0.01, r.des);
  }
  assert.deepEqual(readNear({ count: 0 }), { count: 0, rows: [] });
  assert.deepEqual(readNear(null), { count: 0, rows: [] });
});

/**
 * D_SH from vectors, apart from the spherical trigonometry in orbit.js: the
 * planes' angle from their normals, and the perihelia measured from the
 * line where the two planes meet, each in its own plane.
 */
function dShByVectors(k1, k2) {
  const R = Math.PI / 180;
  const frame = (k) => {
    const [cO, sO, ci, si] = [Math.cos(k.om * R), Math.sin(k.om * R), Math.cos(k.i * R), Math.sin(k.i * R)];
    const node = [cO, sO, 0];
    const normal = [sO * si, -cO * si, ci];
    const inPlane = [-sO * ci, cO * ci, si];
    const peri = node.map((x, n) => x * Math.cos(k.w * R) + inPlane[n] * Math.sin(k.w * R));
    return { normal, peri };
  };
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const [f1, f2] = [frame(k1), frame(k2)];
  const planes = Math.hypot(...f1.normal.map((x, n) => x - f2.normal[n]));
  const m = cross(f1.normal, f2.normal);
  const len = Math.hypot(...m);
  const mutual = len > 1e-12 ? m.map((x) => x / len) : frame({ ...k1, w: 0 }).peri;
  const angle = (f) => Math.atan2(dot(cross(mutual, f.peri), f.normal), dot(mutual, f.peri));
  const pi21 = angle(f2) - angle(f1);
  const perihelia = ((k1.e + k2.e) / 2) * 2 * Math.sin(pi21 / 2);
  return Math.sqrt((k2.e - k1.e) ** 2 + (k2.q - k1.q) ** 2 + planes ** 2 + perihelia ** 2);
}

test('D_SH: nothing between an orbit and itself, and each term alone', () => {
  const k = readOrbit(ATALA);
  assert.equal(dSH(k, k), 0);
  assert.ok(Math.abs(dSH(k, { ...k, e: k.e + 0.01 }) - 0.01) < 1e-12);
  assert.ok(Math.abs(dSH(k, { ...k, q: k.q + 0.05 }) - 0.05) < 1e-12);
  // Same node, the planes 2° apart: 2 sin(1°).
  assert.ok(Math.abs(dSH(k, { ...k, i: k.i + 2 }) - 2 * Math.sin(Math.PI / 180)) < 1e-12);
  // Same plane, the perihelion turned 10°: the mean e times 2 sin(5°).
  assert.ok(Math.abs(dSH(k, { ...k, w: k.w + 10 }) - k.e * 2 * Math.sin((5 * Math.PI) / 180)) < 1e-12);
});

test('D_SH agrees with the same distance worked out from vectors', () => {
  const { rows } = readNear(NEAR_ATALA.answer);
  const k = readOrbit(ATALA);
  for (const r of rows) assert.ok(Math.abs(dSH(k, r) - dShByVectors(k, r)) < 1e-9, r.des);
  // Orbits far apart, nodes either side of a half turn, a retrograde one.
  const phaethon = { e: 0.8898, q: 0.1399, i: 22.32, om: 265.2, w: 322.2 };
  const ud = { e: 0.8726, q: 0.1631, i: 28.67, om: 19.71, w: 207.6 };
  const halley = { e: 0.9679, q: 0.5747, i: 162.19, om: 59.10, w: 112.24 };
  for (const [x, y] of [[phaethon, ud], [ud, phaethon], [phaethon, halley], [halley, ud], [k, halley]]) {
    assert.ok(Math.abs(dSH(x, y) - dShByVectors(x, y)) < 1e-9);
    assert.ok(Math.abs(dSH(x, y) - dSH(y, x)) < 1e-9);
  }
});

test('the closest orbits, the body itself left out', () => {
  const k = readOrbit(ATALA);
  const closest = closestOrbits(k, readNear(NEAR_ATALA.answer).rows, 5);
  assert.equal(closest.length, 5);
  assert.ok(closest.every((r) => r.des !== '152'));
  for (let n = 1; n < closest.length; n++) assert.ok(closest[n].d >= closest[n - 1].d);
  assert.ok(closest[0].d < 0.1, `closest D ${closest[0].d}`);
});

test('crossing the Earth’s orbit', () => {
  assert.equal(crossesEarth(readOrbit(ATALA)), false);
  assert.equal(crossesEarth({ q: 0.14, Q: 2.4 }), true);   // an Apollo: Phaethon
  assert.equal(crossesEarth({ q: 0.75, Q: 0.99 }), true);  // an Aten reaching past the Earth's perihelion
  assert.equal(crossesEarth({ q: 0.3, Q: 0.9 }), false);   // an Atira, inside it
  assert.equal(crossesEarth({ q: 1.1, Q: 2.0 }), false);   // an Amor, outside it
});

test('a Trojan ahead of Jupiter or behind it', () => {
  const jd = 2461300.5;
  const jupiter = 34.39644051 + 3034.74612775 * ((jd - 2451545.0) / 36525);
  const at = (lead) => ({ om: 0, w: 0, ma: jupiter + lead, n: 0.083, epoch: jd });
  assert.equal(trojanPoint(at(60), jd), 'L4');
  assert.equal(trojanPoint(at(-60), jd), 'L5');
  assert.equal(trojanPoint(at(-300), jd), 'L4');
  assert.equal(trojanPoint(at(180), jd), null);
  assert.equal(trojanPoint({ om: 0, w: 0, ma: NaN }, jd), null);
});

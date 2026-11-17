import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eccentricAnomaly, orbitOf, offsetAt, anomalyAt, ellipseEnds, skyFrame,
  habitableZone, zoneOf, matchHosts, skyVelocity, HZ_LIMITS,
} from '../public/js/fly/orbits.js';
import { orbits, moonOrbit } from '../public/js/fly/solar.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const D2R = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(...a);

test('Kepler’s equation is solved, even for a long ellipse', () => {
  for (const e of [0, 0.1, 0.5, 0.9, 0.97]) {
    for (const M of [0.01, 1, 2.5, 3.1, 5]) {
      const E = eccentricAnomaly(M, e);
      assert.ok(near(E - e * Math.sin(E), M, 1e-10), `${e} ${M}`);
    }
  }
});

const frame = skyFrame([3, -4, 2]);

test('the sky frame is three right angles, one of them pointing at the Sun', () => {
  const { toSun, node, up } = frame;
  for (const v of [toSun, node, up]) assert.ok(near(len(v), 1, 1e-12));
  assert.ok(near(dot(toSun, node), 0, 1e-12) && near(dot(toSun, up), 0, 1e-12) && near(dot(node, up), 0, 1e-12));
  assert.ok(near(dot(toSun, [3, -4, 2].map((c) => -c / Math.hypot(3, 4, 2))), 1, 1e-12));
  // Up is as near celestial north as the sky there allows.
  assert.ok(up[2] > 0);
});

test('an ellipse keeps its star at a focus, between periastron and apastron', () => {
  const orbit = orbitOf({ a: 2, e: 0.6, w: 40, i: 30 });
  const ends = ellipseEnds(orbit, frame, [0, 0, 0], 1, 256);
  let lo = Infinity;
  let hi = 0;
  for (let k = 0; k < ends.length; k += 3) {
    const r = Math.hypot(ends[k], ends[k + 1], ends[k + 2]);
    lo = Math.min(lo, r);
    hi = Math.max(hi, r);
  }
  assert.ok(near(lo, 2 * 0.4, 1e-9), String(lo));
  assert.ok(near(hi, 2 * 1.6, 1e-3), String(hi));
  // Closed: the last end is the first.
  assert.ok(near(ends[0], ends[ends.length - 3], 1e-12) && near(ends[2], ends[ends.length - 1], 1e-12));
  // Flat: every point in one plane, tilted 30° from the sky (its normal 30° from the line of sight).
  const p0 = offsetAt(orbit, 0, frame);
  const p1 = offsetAt(orbit, 1.3, frame);
  const n = cross(p0, p1);
  for (const f of [2, 3, 4.5, 6]) assert.ok(near(dot(offsetAt(orbit, f, frame), n) / len(n), 0, 1e-9));
  assert.ok(near(Math.acos(Math.abs(dot(n, frame.toSun)) / len(n)) / D2R, 30, 1e-6));
});

test('at its transit or conjunction time a planet is between its star and the Sun', () => {
  for (const pl of [{ a: 0.05, e: 0, tc: 2460000, p: 3 }, { a: 1, e: 0.4, w: -90, tc: 2459000, p: 300 }, { a: 1, e: 0.3, w: 200, i: 88, tc: 2459500, p: 50 }]) {
    const orbit = orbitOf(pl);
    for (const turns of [0, 1, -7]) {
      const f = anomalyAt(orbit, pl.tc, pl.p, pl.tc + turns * pl.p);
      const pos = offsetAt(orbit, f, frame);
      const r = len(pos);
      // Nearest the Sun along the line of sight; at 90° tilt exactly on it.
      assert.ok(dot(pos, frame.toSun) / r > Math.sin(orbitOf(pl).i) - 1e-9, JSON.stringify(pl));
    }
  }
  // Half a period on, a circular orbit is on the far side.
  const circle = orbitOf({ a: 1, tc: 0, p: 10 });
  assert.ok(near(dot(offsetAt(circle, anomalyAt(circle, 0, 10, 5), frame), frame.toSun), -1, 1e-9));
  // No time, no place.
  assert.equal(anomalyAt(circle, null, 10, 5), null);
});

test('what an orbit lacks is filled in openly: circle, edge-on', () => {
  const o = orbitOf({ a: 1 });
  assert.deepEqual([o.e, o.eKnown, o.iKnown, o.wKnown], [0, false, false, false]);
  assert.ok(near(o.i, Math.PI / 2, 1e-12));
});

test('a planet’s orbit round the Sun carries its own tilt and eccentricity', () => {
  const paths = orbits(new Date('2026-01-01T00:00:00Z'));
  const ecl = [0, -Math.sin(23.43928 * D2R), Math.cos(23.43928 * D2R)];
  const tilt = (pts) => {
    const n = cross(pts[0], pts[Math.floor(pts.length / 4)]);
    return Math.acos(Math.abs(dot(n, ecl)) / len(n)) / D2R;
  };
  // Mars 1.85°, Mercury 7.0° to the ecliptic (JPL's elements).
  assert.ok(near(tilt(paths.mars), 1.85, 0.05), String(tilt(paths.mars)));
  assert.ok(near(tilt(paths.mercury), 7.0, 0.05), String(tilt(paths.mercury)));
  const r = paths.mercury.map((p) => len(p) * 206264.806);
  assert.ok(near(Math.min(...r), 0.3075, 0.002) && near(Math.max(...r), 0.4667, 0.002));
  // The Moon's, round the Earth, about 5.1° to the ecliptic.
  const moon = moonOrbit(new Date('2026-01-01T00:00:00Z'));
  assert.ok(near(tilt(moon), 5.13, 0.3), String(tilt(moon)));
});

test('the habitable zone is Kopparapu et al. (2013) as corrected', () => {
  // The erratum's Table 3, as printed.
  assert.deepEqual(HZ_LIMITS.runaway, [1.0385, 1.2456e-4, 1.4612e-8, -7.6345e-12, -1.7511e-15]);
  assert.deepEqual(HZ_LIMITS.earlyMars, [0.3207, 5.4471e-5, 1.5275e-9, -2.1709e-12, -3.8282e-16]);
  // A Sun at 5780 K and one solar luminosity: the fluxes are S☉ themselves.
  const sun = habitableZone((5772 / 5780) ** 2, 5780);
  assert.ok(near(sun.L, 1, 1e-12));
  assert.ok(near(sun.inner, 1 / Math.sqrt(1.0385), 1e-9) && near(sun.outer, 1 / Math.sqrt(0.3507), 1e-9));
  assert.ok(near(sun.optInner, 1 / Math.sqrt(1.7763), 1e-9) && near(sun.optOuter, 1 / Math.sqrt(0.3207), 1e-9));
  assert.equal(sun.clamped, false);
  assert.equal(zoneOf(sun, 1), 'in');
  assert.equal(zoneOf(sun, 0.723), 'hot');
  assert.equal(zoneOf(sun, 1.524), 'in');
  assert.equal(zoneOf(sun, 1.72), 'opt');
  assert.equal(zoneOf(sun, 5.2), 'cold');
});

test('TRAPPIST-1 is taken at 2600 K, as ExoVision does, and keeps e in its zone', () => {
  const hz = habitableZone(0.1192, 2566);
  assert.equal(hz.clamped, true);
  const at2600 = habitableZone(0.1192, 2600);
  // The fluxes are 2600 K's; the luminosity is the star's own.
  assert.ok(near(hz.inner / at2600.inner, Math.sqrt(hz.L / at2600.L), 1e-12));
  assert.equal(zoneOf(hz, 0.02925), 'in');
  assert.equal(zoneOf(hz, 0.0158), 'hot');
  assert.equal(habitableZone(0, 3000), null);
});

test('hosts are matched by Hipparcos number first, one host to a star', () => {
  const dir = (ra, dec, d) => [d * Math.cos(dec * D2R) * Math.cos(ra * D2R), d * Math.cos(dec * D2R) * Math.sin(ra * D2R), d * Math.sin(dec * D2R)];
  // The catalogue: Barnard's Star where Hipparcos saw it in 1991; 55 Cnc A; HIP 73674 (a pair's light).
  const cat = [dir(269.454, 4.668, 1.83), dir(133.149, 28.330, 12.6), dir(225.899, -27.843, 51.4)];
  const hipIndex = new Map([[87937, 0], [43587, 1], [73674, 2]]);
  const sys = (host, ra, dec, pc, hip, part) => ({ host, ra, dec, pc, pos: dir(ra, dec, pc), hip, part });
  const systems = [
    // Barnard's Star has moved 5′ since: by place alone it would match nothing.
    sys('Barnard', 269.449, 4.738, 1.827, 87937),
    sys('55 Cnc', 133.147, 28.330, 12.586, 43587),
    sys('55 Cnc B', 133.168, 28.315, 12.477),
    sys('HD 133131 A', 225.898, -27.843, 51.47, 73674, 'A'),
    sys('HD 133131 B', 225.900, -27.842, 51.30, 73674, 'B'),
  ];
  const all = () => [0, 1, 2];
  const got = matchHosts(systems, hipIndex, all, (i) => cat[i]);
  assert.deepEqual([...got], [0, 1, -1, 2, -1]);
  // Without the number, a host is found by place, but never on a star already taken.
  const byPlace = matchHosts([sys('55 Cnc', 133.147, 28.330, 12.586)], new Map(), all, (i) => cat[i]);
  assert.deepEqual([...byPlace], [1]);
});

test('a star’s drift across the sky is its proper motion at its distance, square to the line of sight', () => {
  // Barnard's Star: 10.36″ a year at 1.83 pc is 89.9 km/s across the sky.
  const pos = [-0.0175, -1.8202, 0.1509];
  const v = skyVelocity(pos, -798.6, 10328.1);
  assert.ok(near(dot(v, pos), 0, 1e-15));
  const kmPerS = len(v) * 3.0856775814913673e13 / (365.25 * 86400);
  assert.ok(near(kmPerS, 4.74047 * 10.359 * len(pos), 0.2), String(kmPerS));
  // Northward motion raises the declination.
  assert.ok(v[2] > 0);
});

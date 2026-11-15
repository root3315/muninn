/**
 * A star's "Show path" in the depth view (vr/depth3d.js motionPath): the
 * path of its proper motion, mapped the way the star's own place is, must be
 * smooth, go one way along the motion, stay on the star's shell and stop at
 * the corridor's edge without a kink.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionPath, fieldDirection, viewFrame } from '../public/js/vr/depth3d.js';
import { propagate, GAIA_EPOCH } from '../public/js/overlay.js';
import { deltaRA } from '../public/js/wcs.js';

const D2R = Math.PI / 180;
const unit = (d) => { const l = Math.hypot(...d); return d.map((x) => x / l); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((x, k) => x - b[k]);
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));

/** The depth view's mapping for a field at (ra0, dec0), spread as it spreads it. */
function viewOf(ra0, dec0, { coneDeg = 9, radiusDeg = 0.15 } = {}) {
  const frame = viewFrame([0, 0, -1]);
  const spread = coneDeg / radiusDeg;
  const cos = Math.cos(dec0 * D2R);
  const dirOf = (ra, dec) => fieldDirection(deltaRA(ra, ra0) * cos, dec - dec0, frame, spread);
  return { frame, dirOf, coneRad: coneDeg * D2R };
}

function pathFor(star, years) {
  const v = viewOf(star.ra, star.dec);
  const m = motionPath((f) => propagate(star, 2026 + f * years, GAIA_EPOCH), { dirOf: v.dirOf, axis: v.frame.f, coneRad: v.coneRad });
  return { ...m, v };
}

// Barnard's star: 10.4″ a year, almost due north.
const barnard = { ra: 269.4521, dec: 4.6934, pmRA: -801.551, pmDE: 10362.394 };
// An ordinary slow star: 20 mas a year to the south-east.
const slow = { ra: 269.4, dec: 4.8, pmRA: 14, pmDE: -14 };

for (const [name, star] of [['Barnard', barnard], ['a slow star', slow]]) {
  test(`${name}: the path turns by no more than a few degrees between samples`, () => {
    const { dirs } = pathFor(star, 10000);
    assert.ok(dirs.length >= 3);
    for (let i = 2; i < dirs.length; i++) {
      const turn = angle(sub(dirs[i - 1], dirs[i - 2]), sub(dirs[i], dirs[i - 1]));
      assert.ok(turn < 3 * D2R, `turn of ${(turn / D2R).toFixed(1)}° at sample ${i}`);
    }
  });

  test(`${name}: the path goes one way, along the proper motion`, () => {
    const { dirs, v } = pathFor(star, 10000);
    // The motion's heading in the view: from the star now to where it is a little later.
    const now = unit(v.dirOf(star.ra, star.dec));
    const later = propagate(star, 2027, 2026);
    const heading = unit(sub(unit(v.dirOf(later.ra, later.dec)), now));
    const along = dirs.map((d) => dot(d, heading));
    for (let i = 1; i < along.length; i++) assert.ok(along[i] > along[i - 1], `back-step at sample ${i}`);
  });

  test(`${name}: every sample lies inside the corridor, on the unit shell`, () => {
    const { dirs, v } = pathFor(star, 10000);
    for (const d of dirs) {
      assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-9);
      assert.ok(angle(d, v.frame.f) <= v.coneRad + 1e-9);
    }
  });
}

test('Barnard over ±10 000 years leaves the corridor: it is shortened, held at the edge', () => {
  const { shortened, keys, dirs } = pathFor(barnard, 10000);
  assert.equal(shortened, true);
  assert.deepEqual(keys[0], dirs[0]);
  assert.deepEqual(keys[4], dirs.at(-1));
});

test('a slow star keeps its whole path', () => {
  assert.equal(pathFor(slow, 10000).shortened, false);
});

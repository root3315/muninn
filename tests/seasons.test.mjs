/**
 * The season link: the parallax geometry it rests on, and the decision it makes
 * on a made-up two-season sky.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  earthAt, placeBody, seenFrom, arcPoint, parallaxArc, distanceGrid,
  ownMotionArcsec, separationArcsec, linkSeasons,
} from '../public/js/seasons.js';

const MJD_A = 61000; // 2025 Aug 30
const HALF_YEAR = 365.25 / 2;

/** The direction 90° from the Sun in the ecliptic, as seen from the Earth at mjd. */
function quadrature(mjd, side = 1) {
  const e = earthAt(mjd);
  const r = Math.hypot(e[0], e[1]);
  const dir = [-side * e[1] / r, side * e[0] / r, 0];
  return seenFrom([e[0] + dir[0] * 10, e[1] + dir[1] * 10, e[2]], mjd);
}

/** The direction straight away from the Sun, as seen from the Earth at mjd. */
function opposition(mjd) {
  const e = earthAt(mjd);
  return seenFrom([e[0] * 2, e[1] * 2, e[2] * 2], mjd);
}

test('a body put on the line of sight is seen where it was put, at the distance asked', () => {
  const at = opposition(MJD_A);
  const body = placeBody(at.ra, at.dec, MJD_A, 2);
  const r = Math.hypot(...body.xyz);
  assert.ok(Math.abs(r - 2) < 1e-9, `heliocentric ${r}`);
  // At opposition a body 2 AU from the Sun is 2 − |Earth| from the Earth.
  const earth = Math.hypot(...earthAt(MJD_A));
  assert.ok(Math.abs(body.rho - (2 - earth)) < 1e-9);
  const back = seenFrom(body.xyz, MJD_A);
  assert.ok(separationArcsec(back, at) < 1e-6);
  // Inside the Earth's own distance along that line there is no such body.
  assert.equal(placeBody(at.ra, at.dec, MJD_A, 0.5), null);
});

test('half a year apart at quadrature, a body at 500 AU jumps 2 AU / d', () => {
  for (const side of [1, -1]) {
    const at = quadrature(MJD_A, side);
    const p = arcPoint(at.ra, at.dec, MJD_A, MJD_A + HALF_YEAR, 500);
    const jump = separationArcsec(at, p);
    const expected = (2 / 500) * 206264.806;
    assert.ok(Math.abs(jump / expected - 1) < 0.04, `jump ${jump.toFixed(1)}″ vs ${expected.toFixed(1)}″`);
  }
});

test('the arc closes in on the anchor as the trial distance grows', () => {
  const at = quadrature(MJD_A);
  const arc = parallaxArc(at.ra, at.dec, MJD_A, MJD_A + 180, distanceGrid());
  assert.equal(arc.length, 60);
  const seps = arc.map((p) => separationArcsec(at, p));
  for (let k = 1; k < seps.length; k++) assert.ok(seps[k] < seps[k - 1], `step ${k}`);
  // And the body's own motion is a shrinking fraction of the parallax.
  const frac = arc.map((p, k) => p.wobble / seps[k]);
  assert.ok(frac[0] > frac.at(-1));
  assert.ok(Math.abs(ownMotionArcsec(500, HALF_YEAR) - 58.0) < 0.2);
});

/** A sky with one body at 300 AU, one star on the arc, and one noise peak. */
function syntheticSky({ bodyAU = 300, nudge = 40 } = {}) {
  const anchor = { ...quadrature(MJD_A), mjd: MJD_A };
  const aVisits = [{ id: 'a1', mjd: MJD_A - 2 }, { id: 'a0', mjd: MJD_A }, { id: 'a2', mjd: MJD_A + 3 }];
  const bVisits = [{ id: 'b1', mjd: MJD_A + 180 }, { id: 'b2', mjd: MJD_A + 181.5 }, { id: 'b3', mjd: MJD_A + 184 }];
  const star = arcPoint(anchor.ra, anchor.dec, MJD_A, bVisits[0].mjd, 250);
  const noise = arcPoint(anchor.ra, anchor.dec, MJD_A, bVisits[1].mjd, 600);
  const body = (v) => {
    const p = arcPoint(anchor.ra, anchor.dec, MJD_A, v.mjd, bodyAU);
    // Its own orbit has carried it off the arc a little: the same way in each
    // visit, since a few days of it is well under a pixel.
    return { ra: p.ra, dec: p.dec + nudge / 3600, snr: 9, mag: 16.8 };
  };
  const sources = (v) => [
    ...(bodyAU ? [body(v)] : []),
    { ra: star.ra, dec: star.dec, snr: 30, mag: 14 },
    ...(v.id === 'b2' ? [{ ra: noise.ra, dec: noise.dec, snr: 5.2, mag: 17.6 }] : []),
  ];
  const occupied = (v, ra, dec) => separationArcsec({ ra, dec }, star) < 6 // the star, in every visit
    || (v.id === 'a0' && separationArcsec({ ra, dec }, anchor) < 6);
  const inField = (ra, dec) => separationArcsec({ ra, dec }, anchor) < 0.6 * 3600;
  return { anchor, aVisits, bVisits, sources, occupied, inField };
}

test('a body placed at 300 AU is linked at 300 AU, and a star on the arc is not', () => {
  const sky = syntheticSky();
  const out = linkSeasons(sky);
  assert.ok(out.link, 'linked');
  assert.equal(out.link.visits.length, 3);
  assert.ok(out.link.near <= 300 && out.link.far >= 300, `range ${out.link.near}–${out.link.far}`);
  assert.ok(Math.abs(out.link.d - 300) / 300 < 0.15, `d ${out.link.d}`);
  // The star lies on the arc in every season-B visit and is turned away each time.
  assert.equal(out.staticCount, 3);
  assert.ok(out.covered.near < 300 && out.covered.far === 2000);
});

test('a lone peak on the arc in one visit is not a link, and nothing gives nothing', () => {
  const out = linkSeasons(syntheticSky({ bodyAU: 0 }));
  assert.equal(out.link, null);
  assert.equal(out.staticCount, 3);
  assert.equal(out.need, 2);
});

test('a body that moved too far off the arc for any distance is not linked', () => {
  // Five arcminutes sideways is more than its own orbit allows anywhere it would land.
  const out = linkSeasons(syntheticSky({ nudge: 300 }));
  assert.ok(!out.link || Math.abs(out.link.d - 300) / 300 > 0.15);
});

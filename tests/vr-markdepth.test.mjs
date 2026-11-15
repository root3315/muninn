/**
 * A mark's place in the VR depth view (vr/markdepth.js): a marker only where a
 * catalogue gives a distance, a range or a ceiling where the measurement
 * allows one, and otherwise a beam to the far shell that says why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markDepth, markWords, distanceUnit } from '../public/js/vr/markdepth.js';
import { AU_PER_PC } from '../public/js/vr/depth3d.js';

const at = { ra: 150.1, dec: 2.2 };
const mark = (extra) => ({ ...at, track: [], known: null, ...extra });
const fixed = { kind: 'fixed', track: [], total: 8 };
const moving = { kind: 'moving', ratePerHour: 2, track: [{ ra: 150.1, dec: 2.2 }, { ra: 150.11, dec: 2.2 }] };
const done = (result) => ({ state: 'done', result: { failed: [], pending: [], ...result } });

test('a SkyBoT body stands at its JPL distance; without one, the beam says so', () => {
  const d = markDepth(mark({ analysis: moving, catalog: { state: 'match', name: '(64163) 2001 TB49', object: { dGeo: 1.82 } } }), 1);
  assert.equal(d.show, 'at');
  assert.equal(d.au, 1.82);
  assert.equal(d.src, 'body');
  assert.equal(d.track.length, 2, 'a mover keeps its path');
  const none = markDepth(mark({ analysis: moving, catalog: { state: 'match', name: 'X', object: {} } }), 1);
  assert.equal(none.state, 'noDistance');
  assert.equal(none.show, 'far');
});

test('a Gaia star: Bailer-Jones first, else 1/ϖ', () => {
  const who = done({ gaia: { id: '42', plx: 10, plxErr: 0.1 } });
  const bj = new Map([['42', { r: 95 }]]);
  const geo = markDepth(mark({ analysis: fixed, who }), 2, { bj });
  assert.equal(geo.src, 'bj');
  assert.ok(Math.abs(geo.au / AU_PER_PC - 95) < 1e-9);
  const plx = markDepth(mark({ analysis: fixed, who }), 2);
  assert.equal(plx.src, 'plx');
  assert.ok(Math.abs(plx.au / AU_PER_PC - 100) < 1);
});

test('a galaxy takes the depth view’s redshift, matched by name or place', () => {
  const who = done({ simbad: { name: 'NGC 3115', family: 'galaxy', otype: 'G' } });
  const d = markDepth(mark({ analysis: fixed, who }), 3, { galaxies: [{ name: 'NGC 3115', ra: 151, dec: -7, z: 0.0022 }] });
  assert.equal(d.show, 'far', 'z below the depth view’s floor gives no distance');
  const far = markDepth(mark({ analysis: fixed, who }), 3, { galaxies: [{ name: 'other', ...at, z: 0.05 }] });
  assert.equal(far.show, 'at');
  assert.equal(far.src, 'z');
});

test('identified with no distance: the name, and "no distance in the catalogue"', () => {
  const d = markDepth(mark({ analysis: fixed, who: done({ simbad: { name: 'V* XX Hya', family: 'star', otype: '*' } }) }), 4);
  assert.equal(d.state, 'noDistance');
  assert.equal(d.name, 'XX Hya');
  assert.equal(d.show, 'far');
});

test('an unidentified mover: from the Sun to its ceiling, or the season link instead', () => {
  const d = markDepth(mark({ analysis: moving, catalog: { state: 'none' } }), 5, { ceiling: () => 37 });
  assert.equal(d.show, 'ceiling');
  assert.equal(d.nearAU, 1);
  assert.equal(d.farAU, 37);
  const link = { state: 'done', result: { link: { d: 300, near: 250, far: 380, visits: [] } } };
  const l = markDepth(mark({ analysis: moving, catalog: { state: 'none' }, link }), 5, { ceiling: () => 37 });
  assert.equal(l.show, 'range');
  assert.deepEqual([l.nearAU, l.farAU], [250, 380]);
  const slow = markDepth(mark({ analysis: moving, catalog: { state: 'none' } }), 5, { ceiling: () => null });
  assert.equal(slow.state, 'unknown');
});

test('unidentified, still or below the noise: a faint beam, no marker', () => {
  for (const analysis of [fixed, { kind: 'none', track: [], total: 8 }, { kind: 'saturated', track: [] }]) {
    const d = markDepth(mark({ analysis, who: done({}) }), 6);
    assert.equal(d.state, 'unknown');
    assert.equal(d.show, 'far');
    assert.equal(d.faint, true);
  }
});

test('a saturated star named by the catalogues takes their distance', () => {
  const d = markDepth(mark({ analysis: { kind: 'saturated', track: [] }, who: done({ gaia: { id: '7', plx: 50, plxErr: 0.1 } }) }), 7);
  assert.equal(d.show, 'at');
});

test('asking while the catalogues are out; failed with a retry when they did not answer', () => {
  assert.equal(markDepth(mark({ analysis: fixed, who: { state: 'asking' } }), 8).state, 'asking');
  assert.equal(markDepth(mark({ analysis: moving, catalog: { state: 'waiting' } }), 8).state, 'asking');
  assert.equal(markDepth(mark({ analysis: { kind: 'intermittent', track: [] }, catalog: { state: 'waiting' } }), 8).state, 'asking');
  assert.equal(markDepth(mark({ analysis: fixed, who: { state: 'failed' } }), 8).state, 'failed');
  assert.equal(markDepth(mark({ analysis: fixed, who: { state: 'timeout' } }), 8).state, 'failed');
});

test('the words carry the number and the honest reason', () => {
  const tv = (k, p = {}) => `${k}${JSON.stringify(p)}`;
  assert.match(markWords({ state: 'ceiling', n: 2, farAU: 37.4 }, tv)[0], /markCeiling.*"n":2.*"au":"37"/);
  assert.match(markWords({ state: 'unknown', n: 3 }, tv)[0], /markUnknown/);
  assert.deepEqual(distanceUnit(1.5), ['vr.au', '1.50']);
  assert.equal(distanceUnit(95 * AU_PER_PC)[0], 'vr.pc');
  assert.equal(distanceUnit(5e7 * AU_PER_PC)[0], 'vr.Mpc');
});

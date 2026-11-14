/**
 * The headset's numbers: the sky's frame, the stars' buffers, where the
 * screens stand and how the field is laid out in depth. Nothing here needs a
 * headset, a GPU or the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { radecToVec, vecToRadec, starBuffers, milkyWayPixels, nearestMarker, angleBetween } from '../public/js/vr/skydata.js';
import { SCREENS, screenPose, textDeg, minTextPx, yawOf, MIN_TEXT_DEG, TEXT_DEG, typeFor } from '../public/js/vr/layout.js';
import { sunLongitude, ringLayout } from '../public/js/vr/orbit.js';
import {
  placeByDistance, depthMetres, unknownShell, parallaxDistancePc, redshiftDistanceMpc, AU_PER_PC,
  DEPTH_SCALE, viewFrame, fieldDirection, PLANET_X_AU, decadeRings, parallaxShiftArcmin,
} from '../public/js/vr/depth3d.js';
import { markerPosition } from '../public/js/vr/markers.js';
import { starRadius, starTint } from '../public/js/gate.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('the north celestial pole is straight up, and RA turns the right way round', () => {
  const [x, y, z] = radecToVec(0, 90);
  assert.ok(close(x, 0, 1e-12) && close(y, 1) && close(z, 0, 1e-12));
  assert.ok(close(dot(radecToVec(0, 0), radecToVec(90, 0)), 0, 1e-12));
  // Looking at RA 0 on the equator with north up, RA 90 is on the left:
  // the viewer's right is +z there, and RA 90 sits at −z.
  assert.ok(radecToVec(90, 0)[2] < -0.99);
  // Either side of RA 0 is next door, not across the sky.
  assert.ok(angleBetween(radecToVec(359.9, 10), radecToVec(0.1, 10)) < 0.21);
  for (const [ra, dec] of [[0, 0], [123.4, -56.7], [359.99, 89.5], [269.4463, 4.768]]) {
    const [r, d] = vecToRadec(radecToVec(ra, dec));
    assert.ok(close(r, ra, 1e-6) && close(d, dec, 1e-6), `${ra} ${dec}`);
  }
});

test('the stars keep their count and order, with the same sizes and tints as the opening sky', () => {
  const stars = { count: 3, ra: [10, 200, 300], dec: [5, -20, 60], mag: [-1.46, 3, 6.5], bv: [0, 1.5, 0.6] };
  const b = starBuffers(stars);
  assert.equal(b.positions.length, 9);
  assert.equal(b.sizes.length, 3);
  const [x, y, z] = radecToVec(200, -20);
  assert.ok(close(b.positions[3], x, 1e-6) && close(b.positions[4], y, 1e-6) && close(b.positions[5], z, 1e-6));
  assert.ok(b.sizes[0] > b.sizes[1] && b.sizes[1] > b.sizes[2], 'brighter is larger');
  assert.ok(close(b.sizes[1], starRadius(3), 1e-6));
  assert.ok(close(b.colors[3], starTint(1.5)[0] / 255, 1e-6));
  assert.ok(b.glows[0] > 0 && b.glows[2] === 0, 'only stars bright enough get a glow');
});

test('the Milky Way picture is the model, equirectangular, brightest toward the galactic centre', () => {
  const { width, height, data } = milkyWayPixels(180);
  assert.equal(width, 180);
  assert.equal(height, 90);
  const at = (ra, dec) => {
    const px = Math.min(width - 1, Math.floor((ra / 360) * width));
    const py = Math.min(height - 1, Math.floor(((90 - dec) / 180) * height));
    return data[(py * width + px) * 4 + 1];
  };
  // Sagittarius against the north galactic pole.
  assert.ok(at(266.4, -29) > 3 * at(192.9, 27.1));
});

test('a marker stands at its target\'s direction times the radius', () => {
  const r = 300;
  const p = markerPosition({ ra: 269.4463, dec: 4.768 }, r);
  const v = radecToVec(269.4463, 4.768);
  for (let k = 0; k < 3; k++) assert.ok(close(p[k], v[k] * r, 1e-9));
  const markers = [{ key: 'a', v: radecToVec(10, 10) }, { key: 'b', v: radecToVec(12, 10) }];
  assert.equal(nearestMarker(radecToVec(11.8, 10.1), markers, 3).key, 'b');
  assert.equal(nearestMarker(radecToVec(40, 10), markers, 3), null);
});

test('the screens stand where they are meant to, facing the eye, with type big enough to read', () => {
  const head = [0, 1.6, 0];
  const main = screenPose(SCREENS.main, head, 0);
  assert.ok(main.position[2] < -1.9 && close(main.position[0], 0, 1e-12));
  // The card is to the left, the findings to the right, both at reading distance.
  const card = screenPose(SCREENS.card, head, 0);
  const side = screenPose(SCREENS.side, head, 0);
  assert.ok(card.position[0] < -1 && side.position[0] > 1);
  // A turned base turns everything with it.
  const turned = screenPose(SCREENS.main, head, 90);
  assert.ok(turned.position[0] < -1.9 && close(turned.position[2], 0, 1e-9));
  assert.ok(close(yawOf([-1, 0, 0]), 90, 1e-9));
  for (const [name, s] of Object.entries(SCREENS)) {
    const dist = Math.hypot(s.dist, s.dy);
    assert.ok(dist >= 1.5 && dist <= 2.5, `${name} at ${dist} m`);
    // Everything that is pressed or read often sits between 25° below and 15° above the eye.
    const pitch = Math.atan2(s.dy, s.dist) * 180 / Math.PI;
    assert.ok(pitch >= -25 && pitch <= 15, `${name} at ${pitch}°`);
    if (s.pxPerM) {
      const type = typeFor(s);
      assert.ok(textDeg(type.body, s.pxPerM, dist) >= TEXT_DEG.body - 1e-9, name);
      assert.ok(textDeg(type.heading, s.pxPerM, dist) >= TEXT_DEG.heading - 1e-9, name);
      assert.ok(minTextPx(s.pxPerM, dist) === type.body, name);
    }
  }
  // The side screens at ±35°, the buttons just under the field.
  assert.ok(Math.abs(SCREENS.card.yawDeg) >= 34 && Math.abs(SCREENS.card.yawDeg) <= 40);
  const barPitch = Math.atan2(SCREENS.bar.dy, SCREENS.bar.dist) * 180 / Math.PI;
  // Its centre; the first row, which is all that shows unless "More" is open, is about a degree higher.
  assert.ok(barPitch <= -16 && barPitch >= -21);
  assert.ok(MIN_TEXT_DEG >= 1.5);
});

test('the field in depth: farther is farther along the same ray; no distance waits on the far shell', () => {
  const dir = [0.2, 0.1, 1];
  const [near, far, unknown] = placeByDistance([
    { id: 'asteroid', dir, au: 2.5 },
    { id: 'star', dir, au: 1.83 * AU_PER_PC },
    { id: 'faint', dir, au: null },
  ]);
  const len = (p) => Math.hypot(...p);
  assert.ok(len(far.pos) > len(near.pos));
  // Same direction, whatever the distance.
  const unit = (p) => p.map((c) => c / len(p));
  assert.ok(angleBetween(unit(near.pos), unit(far.pos)) < 1e-4);
  assert.ok(angleBetween(unit(near.pos), unit(unknown.pos)) < 1e-4);
  assert.equal(unknown.known, false);
  assert.ok(close(len(unknown.pos), unknownShell(), 1e-9));
  // AU and parsecs on one monotone scale, clamped at its ends.
  const ladder = [0.01, 0.1, 1, 40, 1000, AU_PER_PC, 1e3 * AU_PER_PC, 1e6 * AU_PER_PC, 1e9 * AU_PER_PC, 1e12 * AU_PER_PC]
    .map((au) => depthMetres(au));
  for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i] >= ladder[i - 1]);
  assert.equal(ladder[0], DEPTH_SCALE.nearM);
  assert.equal(ladder.at(-1), DEPTH_SCALE.farM);
  assert.ok(unknownShell() > DEPTH_SCALE.farM);
  // Planet X's shell sits between Neptune and the nearest star.
  const [x0, x1] = PLANET_X_AU.map((au) => depthMetres(au));
  assert.ok(depthMetres(30) < x0 && x1 < depthMetres(AU_PER_PC));
  // A ring for every power of ten.
  const rings = decadeRings();
  assert.ok(rings.includes(1) && rings.includes(1e5));
  for (let i = 1; i < rings.length; i++) assert.ok(close(rings[i] / rings[i - 1], 10, 1e-9));
});

test('parallax and redshift become distances only when they are measured', () => {
  // Barnard's Star: 546.98 mas, corrected by the zero-point, with its ±1σ around it.
  const b = parallaxDistancePc(546.98, 0.04);
  assert.ok(close(b.pc, 1000 / (546.98 + 0.017), 1e-9));
  assert.ok(b.lo < b.pc && b.pc < b.hi);
  // An error over 20 % is no distance.
  assert.equal(parallaxDistancePc(1.0, 0.3), null);
  assert.equal(parallaxDistancePc(-0.5, 0.1), null);
  assert.equal(parallaxDistancePc(2, null), null);
  // Low redshift is the Hubble law at Planck's H0; z = 1 is about 3.4 Gpc comoving.
  assert.ok(close(redshiftDistanceMpc(0.001), 299792.458 * 0.001 / 67.7, 0.01));
  assert.ok(Math.abs(redshiftDistanceMpc(1) - 3400) < 80);
  assert.equal(redshiftDistanceMpc(0), null);
  // Two seasons an AU apart either side of the Sun: 2 AU shifts a body at 500 AU by 13.75′.
  assert.ok(close(parallaxShiftArcmin(2, 500), 13.75, 0.01));
});

test('the corridor keeps east on the left and north up, as on the sky', () => {
  const frame = viewFrame([0, 0, 1]);
  const east = fieldDirection(0.1, 0, frame, 100);
  const north = fieldDirection(0, 0.1, frame, 100);
  // Facing +z, the viewer's left is +x.
  assert.ok(east[0] > 0);
  assert.ok(north[1] > 0);
  const centre = fieldDirection(0, 0, frame, 100);
  assert.deepEqual(centre.map((c) => Math.round(c * 1e9) / 1e9), [0, 0, 1]);
});

test('the ring is the orbit of the Earth: the longitude of the Sun, two seasons on opposite sides', () => {
  // Near the March equinox the Sun is at 0°, at the June solstice 90°.
  const mjd = (iso) => Date.parse(iso) / 86400000 + 40587;
  assert.ok(Math.abs(((sunLongitude(mjd('2025-03-20T09:01:00Z')) + 180) % 360) - 180) < 0.3);
  assert.ok(Math.abs(sunLongitude(mjd('2025-06-21T02:42:00Z')) - 90) < 0.3);
  // A season in July, a season in January, a third the next July.
  const days = ['2025-07-06', '2025-07-09', '2025-07-19', '2026-01-01', '2026-01-04', '2026-07-03', '2026-07-10'].map((d) => mjd(`${d}T00:00:00Z`));
  const r = ringLayout(days, { gapDays: 45 });
  assert.equal(r.seasons.length, 3);
  assert.deepEqual(r.tiers, [0, 0, 0, 0, 0, 0, 1]);
  // The first season is in front, the second across the ring.
  assert.ok(Math.abs(r.angles[1]) < 10);
  assert.ok(Math.abs(Math.abs(r.angles[3]) - 180) < 15);
  // The gaps are counted in days, and the baseline is about two AU.
  assert.ok(r.gaps[0].days > 150);
  assert.ok(r.baseline.chordAU > 1.9 && r.baseline.chordAU <= 2);
  assert.ok(r.baseline.shiftArcmin > 13 && r.baseline.shiftArcmin < 14);
  // Time runs counter-clockwise from above, as the Earth goes.
  assert.ok(r.angles[2] > r.angles[0]);
});

test('the VR strings exist in both languages', async () => {
  const { VR_KEYS } = await import('../public/js/vr/strings.js');
  assert.deepEqual([...VR_KEYS.en].sort(), [...VR_KEYS.ru].sort());
});

test('on the arc the seasons stand either side of the front, a return a year later a row below', async () => {
  const { arcLayout } = await import('../public/js/vr/orbit.js');
  const mjd = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000 + 40587;
  const days = ['2025-07-06', '2025-07-09', '2025-07-19', '2026-01-01', '2026-01-04', '2026-07-03', '2026-07-10'].map(mjd);
  const r = arcLayout(days, { minSepDeg: 8, gapDeg: 9, arcDeg: 130 });
  // Compact, in front: the two places a fixed gap apart, whatever the months between them.
  const span = Math.max(...r.angles) - Math.min(...r.angles);
  assert.ok(span <= 2 * 8 + 8 + (9 + 8) + 1e-9, `span ${span}`);
  // Time runs left to right (positive yaw is left): July before January.
  assert.ok(r.angles[0] > r.angles[3]);
  assert.deepEqual(r.tiers, [0, 0, 0, 0, 0, 1, 1]);
  // In order inside a season, and the frames 8° apart.
  assert.ok(close(r.angles[0] - r.angles[1], 8, 1e-9));
  // The gap is labelled by its days, and the baseline keeps its true length between the two places.
  assert.ok(r.gaps[0].days > 150);
  assert.ok(r.baseline.chordAU > 1.9 && r.baseline.a !== r.baseline.b);
});

test('the target is matched to Gaia by its id, or only nearby with its own motion', async () => {
  const { matchTarget, eclipticLatitude } = await import('../public/js/vr/depth3d.js');
  const rows = [
    { id: '4472832130942575872', ra: 269.44850253, dec: 4.73942005, pmRA: -801.551, pmDE: 10362.394 },
    { id: '1', ra: 133.81, dec: -7.247, pmRA: -3, pmDE: 2 },
  ];
  assert.equal(matchTarget({ ref: 'Gaia DR3 4472832130942575872', ra: 269.45, dec: 4.74 }, rows, 2026).id, '4472832130942575872');
  // WISE 0855 is not in Gaia: a neighbour 30″ away with no motion to speak of is not it.
  const wise = { ra: 133.81890825, dec: -7.247048, epoch: 2000, pmRA: -8123.7, pmDE: 673.2, ref: 'Kirkpatrick et al. 2021, ApJS 253, 7' };
  assert.equal(matchTarget(wise, rows, 2026), null);
  // Planet X's predicted orbits keep within about 21° of the ecliptic: Barnard's Star is at +28°.
  assert.ok(Math.abs(eclipticLatitude(269.4463, 4.768) - 28.2) < 0.3);
  assert.ok(Math.abs(eclipticLatitude(270, 66.56) - 90) < 0.1);
});

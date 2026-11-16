import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  vecOf, radecOf, xyfOf, vecOfXyf, nestOf, cellOf, tileAt, tileMesh, tileCentre, tileRadius,
} from '../public/js/allsky/healpix.js';
import {
  WAVELENGTHS, FRAMES, BLANK_FRAMES, COLOUR_FRAMES, frameOf, bandOf, channelOf, bandFrame,
  tileUrl, allskyUrl, allskySlot, orderFor, MAX_ORDER,
} from '../public/js/allsky/hips.js';

/** The angle between two directions in degrees, exact at small angles where acos is not. */
const angle = (a, b) => {
  const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  return Math.atan2(cross, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180 / Math.PI;
};

test('face coordinates go to the sky and back on every face', () => {
  for (let face = 0; face < 12; face++) {
    for (const [x, y] of [[0.1, 0.2], [0.5, 0.5], [0.93, 0.07], [0.31, 0.88]]) {
      const v = vecOfXyf(x, y, face);
      const { ra, dec } = radecOf(v);
      const back = xyfOf(ra, dec);
      assert.equal(back.face, face, `face ${face} at ${x},${y}`);
      assert.ok(Math.abs(back.x - x) < 1e-9 && Math.abs(back.y - y) < 1e-9, `face ${face} at ${x},${y}`);
    }
  }
});

test('the base faces sit where HEALPix puts them', () => {
  // Face 4 is centred on RA 0, Dec 0; face 0 on RA 45 at the northern cap; face 8 its southern twin.
  assert.ok(angle(vecOfXyf(0.5, 0.5, 4), vecOf(0, 0)) < 1e-9);
  assert.ok(angle(vecOfXyf(0.5, 0.5, 0), vecOf(45, 41.8103149)) < 1e-6);
  assert.ok(angle(vecOfXyf(0.5, 0.5, 8), vecOf(45, -41.8103149)) < 1e-6);
  assert.ok(angle(vecOfXyf(1, 1, 0), [0, 0, 1]) < 1e-9);
});

test('a nested index and its cell are one and the same', () => {
  for (const order of [0, 3, 5, 7]) {
    const n = 2 ** order;
    for (const [face, ix, iy] of [[0, 0, 0], [5, n - 1, 0], [11, n - 1, n - 1], [7, Math.floor(n / 3), Math.floor(n / 2)]]) {
      const npix = nestOf(order, face, ix, iy);
      assert.ok(npix >= 0 && npix < 12 * 4 ** order);
      assert.deepEqual(cellOf(order, npix), { face, ix, iy });
    }
  }
  // Interleaving: ix on the even bits, iy on the odd.
  assert.equal(nestOf(1, 0, 1, 0), 1);
  assert.equal(nestOf(1, 0, 0, 1), 2);
  assert.equal(nestOf(1, 2, 1, 1), 2 * 4 + 3);
});

test('a point lies inside the tile it is said to be in', () => {
  for (const [ra, dec] of [[88.7929, 7.4071], [279.2347, 38.7837], [247.3519, -26.432], [37.95, 89.26], [10, -88]]) {
    for (const order of [3, 5]) {
      const { npix, a, b } = tileAt(order, ra, dec);
      assert.ok(a >= 0 && a < 1 && b >= 0 && b < 1);
      const centre = tileCentre(order, npix);
      assert.ok(angle(centre, vecOf(ra, dec)) <= tileRadius(order, npix) + 1e-9, `${ra},${dec} at order ${order}`);
    }
  }
});

test('a tile mesh puts the pixel rows along ix and the columns along iy', () => {
  // The orientation measured on the IRSA cube: every bright star landed on its
  // disc only when the PNG's row runs with a (ix) and its column with b (iy).
  const { positions, uv } = tileMesh(3, nestOf(3, 4, 2, 5), 4);
  assert.equal(positions.length, 25 * 3);
  // Vertex (i=1, j=3): a = 0.25, b = 0.75 → u = b, v = a.
  const k = 1 * 5 + 3;
  assert.equal(uv[k * 2], 0.75);
  assert.equal(uv[k * 2 + 1], 0.25);
  const v = Array.from(positions.slice(k * 3, k * 3 + 3));
  assert.ok(angle(v, vecOfXyf((2 + 0.25) / 8, (5 + 0.75) / 8, 4)) < 1e-3); // Float32: a few arcseconds
});

test('the cube has 102 frames in rising wavelength, two of them blank', () => {
  assert.equal(WAVELENGTHS.length, 102);
  for (let i = 1; i < WAVELENGTHS.length; i++) assert.ok(WAVELENGTHS[i] > WAVELENGTHS[i - 1]);
  assert.equal(FRAMES.length, 100);
  assert.ok(!FRAMES.includes(50) && !FRAMES.includes(51));
  assert.deepEqual([...BLANK_FRAMES], [frameOf(3, 17), frameOf(4, 1)]);
  assert.equal(bandOf(frameOf(6, 17)), 6);
  assert.equal(channelOf(frameOf(2, 5)), 5);
  assert.equal(frameOf(6, 17), 101);
  // Each band's opening frame lies inside the band's range.
  const RANGES = [[0.75, 1.09], [1.10, 1.62], [1.63, 2.42], [2.42, 3.82], [3.83, 4.41], [4.42, 5.00]];
  for (let band = 1; band <= 6; band++) {
    const w = WAVELENGTHS[bandFrame(band)];
    assert.ok(w >= RANGES[band - 1][0] && w <= RANGES[band - 1][1], `D${band} at ${w}`);
  }
  // Red is the longest wavelength, blue the shortest.
  assert.ok(WAVELENGTHS[COLOUR_FRAMES[0]] > WAVELENGTHS[COLOUR_FRAMES[1]]);
  assert.ok(WAVELENGTHS[COLOUR_FRAMES[1]] > WAVELENGTHS[COLOUR_FRAMES[2]]);
});

test('tile addresses follow the HiPS layout IRSA serves', () => {
  const base = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
  assert.equal(tileUrl(3, 300, 0), `${base}/Norder3/Dir0/Npix300.png`);
  assert.equal(tileUrl(5, 12345, 20), `${base}/Norder5/Dir10000/Npix12345_20.png`);
  assert.equal(allskyUrl(101), `${base}/Norder3/Allsky_101.png`);
  // The frames the page opens with come averaged, from the site itself.
  for (const f of [...COLOUR_FRAMES, ...[1, 2, 3, 4, 5, 6].map(bandFrame)]) assert.equal(allskyUrl(f), `data/allsky/Allsky_${f}.png`);
  assert.deepEqual(allskySlot(0), { x: 0, y: 0 });
  assert.deepEqual(allskySlot(28), { x: 64, y: 64 });
});

test('the sharper the screen, the deeper the order, never past the cube', () => {
  assert.equal(orderFor(0.2), null);
  assert.equal(orderFor(0.02), 3);
  assert.equal(orderFor(0.005), 4);
  assert.equal(orderFor(0.0005), MAX_ORDER);
  let last = -1;
  for (let dpp = 0.2; dpp > 0.0001; dpp /= 1.3) {
    const o = orderFor(dpp) ?? 0;
    assert.ok(o >= last);
    last = o;
  }
});

import { galacticOf, equatorialOf, mollweide, mollweideInverse } from '../public/js/allsky/maps.js';

test('galactic coordinates land where the galaxy is', () => {
  // Sgr A* sits at l 359.944, b −0.046; the north galactic pole at RA 192.859, Dec 27.128.
  const sgr = galacticOf(266.41683, -29.00781);
  assert.ok(Math.abs(((sgr.l + 180) % 360) - 180 - -0.056) < 0.01 && Math.abs(sgr.b - -0.046) < 0.01, JSON.stringify(sgr));
  assert.ok(galacticOf(192.85948, 27.12825).b > 89.999);
  for (const [ra, dec] of [[10, 20], [200, -60], [300, 80]]) {
    const { l, b } = galacticOf(ra, dec);
    const back = equatorialOf(l, b);
    assert.ok(Math.abs(back.ra - ra) < 1e-9 && Math.abs(back.dec - dec) < 1e-9);
  }
});

test('the Mollweide map is true both ways, centre in the middle and longitude to the left', () => {
  assert.deepEqual(mollweide(0, 0), { x: -0, y: 0 });
  const left = mollweide(90, 0);
  assert.ok(left.x < 0 && Math.abs(left.x - -Math.SQRT2) < 1e-12);
  assert.ok(Math.abs(mollweide(0, 90).y - Math.SQRT2) < 1e-12);
  for (const [l, b] of [[10, 5], [123, -45], [250, 60], [359, -89], [180.5, 0.3]]) {
    const { x, y } = mollweide(l, b);
    const back = mollweideInverse(x, y);
    const dl = Math.abs(((back.l - l + 540) % 360) - 180);
    assert.ok(dl < 1e-6 && Math.abs(back.b - b) < 1e-6, `${l},${b} → ${back.l},${back.b}`);
  }
  assert.equal(mollweideInverse(2.9, 0), null);
  assert.equal(mollweideInverse(0, 1.5), null);
});

/**
 * A very bright star: a saturated core of a few pixels is still painted as a
 * star, a patch arcminutes across is not filled white but shown flat and
 * named, and a spot that comes and goes beside such a star says why it may.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { documentElement: {} };
const { fillCores, coreCap, CORE_CAP_PX, saturatedPatches, paint, ramp } = await import('../public/js/render.js');
const { brightStars, brightStarNear, ghostReachArcmin } = await import('../public/js/brightstars.js');
const { setLanguage } = await import('../public/js/i18n.js');
const { brightNeighbourWords } = await import('../public/js/marks.js');

const OVERFLOW = 1;

/** A W × W frame of sky at 1 with a disc of radius `r` at its centre: `inside` set by the caller. */
function frame(W, r, inside) {
  const data = new Float32Array(W * W).fill(1);
  const quality = new Uint8Array(W * W);
  const c = (W - 1) / 2;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d < r) inside(data, quality, y * W + x);
      else if (d < r + 3) data[y * W + x] = 5000;
    }
  }
  return { data, quality, centre: Math.round(c) * W + Math.round(c) };
}

test('the core cap is a dozen detector pixels across, in grid samples', () => {
  assert.equal(CORE_CAP_PX, 12);
  assert.equal(coreCap(1), Math.round(Math.PI * 36));
  assert.equal(coreCap(2.5), Math.round(Math.PI * 36 * 6.25));
});

test('a small masked core is filled under the cap, a large one is left blank', () => {
  const blank = (data, _q, k) => { data[k] = NaN; };
  const small = frame(41, 4, blank);
  const large = frame(121, 40, blank);
  const cap = coreCap(1);
  assert.ok(small.data.filter((v) => v !== v).length <= cap);
  assert.ok(large.data.filter((v) => v !== v).length > cap);
  assert.ok(fillCores(small.data, 41, 1000, cap)[small.centre] >= 1000, 'a star\'s core is still white');
  assert.ok(Number.isNaN(fillCores(large.data, 121, 1000, cap)[large.centre]), 'the patch is not painted white');
  // Without a cap the old behaviour stands, for callers that pass none.
  assert.ok(fillCores(large.data, 121, 1000)[large.centre] >= 1000);
});

test('only saturated runs larger than the cap are patches, with what they wall in', () => {
  const W = 121;
  const big = frame(W, 30, (data, q, k) => { q[k] = OVERFLOW; data[k] = 0.2; });
  // A pocket inside the patch the pipeline left low and unflagged.
  const c = 60 * W + 60;
  big.quality[c] = 0;
  // A small saturated star elsewhere, under the cap.
  for (let y = 5; y < 8; y++) for (let x = 5; x < 8; x++) big.quality[y * W + x] = OVERFLOW;
  const patches = saturatedPatches(big.quality, W, W, coreCap(1));
  assert.equal(patches.length, 1);
  const [p] = patches;
  assert.ok(Math.abs(p.ci - 60) < 0.5 && Math.abs(p.cj - 60) < 0.5);
  assert.ok(p.reach > 28 && p.reach < 31);
  assert.ok(p.cells.includes(c), 'the pocket it walls in belongs to it');
  assert.ok(!p.cells.includes(6 * W + 6), 'the small star is not part of it');
  assert.deepEqual(saturatedPatches(big.quality, W, W, Infinity), [], 'no cap, no patches');
});

test('a large saturated patch is painted flat at the sky, a small core still white', () => {
  const W = 121;
  const lut = ramp([[0, 0, 0], [255, 255, 255]]);
  const paintOf = (f) => {
    const cap = coreCap(1);
    const patches = saturatedPatches(f.quality, W, W, cap);
    const img = { data: new Uint8ClampedArray(W * W * 4), width: W, height: W };
    paint(img, f.data, lut, { lo: 0, hi: 1000, stretch: 'linear', quality: f.quality, cap, patches });
    return img.data;
  };
  const sat = (data, q, k) => { q[k] = OVERFLOW; data[k] = 0.2; };
  const large = frame(W, 30, sat);
  const before = Float32Array.from(large.data);
  const px = paintOf(large);
  const sky = px[0];
  assert.equal(px[large.centre * 4], sky, 'flat at the sky level');
  assert.equal(px[large.centre * 4 + 3], 255, 'and opaque, not a hole');
  assert.deepEqual(large.data, before, 'the measured data are not touched');
  const small = frame(W, 3, sat);
  assert.equal(paintOf(small)[small.centre * 4], 255, 'a small saturated core is still white');
});

const stars = {
  ra: [213.92, 101.29, 10.0, 213.6],
  dec: [19.18, -16.72, 10.0, 19.0],
  mag: [-0.04, -1.46, 5.5, 2.9],
  named: [{ i: 0, bayer: 'α Boo', name: 'Arcturus' }, { i: 1, bayer: 'α CMa', name: 'Sirius' }],
};

test('a bright star reaches farther the brighter it is', () => {
  assert.ok(ghostReachArcmin(0) >= 10 && ghostReachArcmin(0) <= 15);
  assert.ok(ghostReachArcmin(-1.46) > ghostReachArcmin(0));
  assert.ok(ghostReachArcmin(3) < 5);
  const list = brightStars(stars);
  assert.equal(list.length, 3, 'fainter than V 3 is left out');
  const near = brightStarNear(list, 213.9576, 19.2833);
  assert.equal(near.name, 'Arcturus');
  assert.ok(Math.abs(near.distArcmin - 6.5) < 0.5);
  assert.equal(brightStarNear(list, 213.92, 19.6), null, '25′ away is out of its reach');
});

test('a spot that comes and goes beside a bright star gets a line saying why; the verdict is left alone', () => {
  setLanguage('ru');
  const list = brightStars(stars);
  const mark = (kind, ra = 213.9576, dec = 19.2833) => ({ ra, dec, analysis: { kind, seen: 4, total: 46 } });
  const line = brightNeighbourWords(mark('intermittent'), list);
  assert.match(line, /Рядом очень яркая звезда \(Arcturus, [67]′, V −0,04\)/);
  assert.match(line, /блик/);
  assert.equal(brightNeighbourWords(mark('fixed'), list), null, 'a steady star needs no such line');
  assert.equal(brightNeighbourWords(mark('intermittent', 213.92, 19.18), list), null, 'a mark on the star itself');
  assert.equal(brightNeighbourWords(mark('intermittent', 13.42, 3.85), list), null, 'nowhere near one');
  setLanguage('en');
  assert.match(brightNeighbourWords(mark('transient'), list), /A very bright star is near \(Arcturus/);
});

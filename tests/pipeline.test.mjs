/**
 * The reading pipeline end to end, offline: header, WCS, the byte range of the
 * rows, the FLAGS mask, the resample onto the shared grid, the detector noise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadStamp } from '../public/js/stamp.js';
import { TangentGrid } from '../public/js/wcs.js';
import { syntheticFrame, serve } from './fixtures.mjs';

const frame = syntheticFrame();
const grid = () => new TangentGrid(frame.ra, frame.dec, 0.09, 90, 90);

async function withFetch(fetchImpl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

function brightest(stamp) {
  let best = -Infinity; let at = -1;
  stamp.data.forEach((v, k) => { if (v > best) { best = v; at = k; } });
  return { value: best, i: at % stamp.width, j: Math.floor(at / stamp.width) };
}

test('a pipeline-flagged cosmic ray is masked, a real source is kept', async () => {
  const stamp = await withFetch(serve(frame.file), () => loadStamp('mem://frame.fits', grid()));
  assert.ok(stamp, 'the frame covers the grid');
  assert.equal(stamp.meta.flaggedPixels, 1, 'exactly the one TRANSIENT pixel is masked');
  const top = brightest(stamp);
  // The hit was 50; with it masked the brightest thing left is the source (~5).
  assert.ok(top.value < 6 && top.value > 3, `brightest left is the source, got ${top.value}`);
});

test('east is on the left of the grid, as the compass says', async () => {
  const g = grid();
  const stamp = await withFetch(serve(frame.file), () => loadStamp('mem://frame.fits', g));
  const top = brightest(stamp);
  // The source sits at detector x = 20 of 64 with CD1_1 < 0, i.e. east of the
  // centre. On an east-left grid it must land left of the middle.
  assert.ok(top.i < g.cx, `source at i=${top.i} should be left of centre ${g.cx}`);
  const [ra] = g.indexToWorld(top.i, top.j);
  assert.ok(ra > frame.ra, 'and its RA is larger than the centre\'s');
});

test('the depth noise comes from detector pixels, not the smoothed grid', async () => {
  const stamp = await withFetch(serve(frame.file), () => loadStamp('mem://frame.fits', grid()));
  const s = stamp.meta.detectorSigma;
  assert.ok(Math.abs(s - frame.noise) / frame.noise < 0.15, `detector sigma ${s} vs injected ${frame.noise}`);
});

test('a server that ignores Range is refused, not decoded as the wrong rows', async () => {
  await assert.rejects(
    withFetch(serve(frame.file, { honourRange: false }), () => loadStamp('mem://frame.fits', grid())),
    /Range not honoured/,
  );
});

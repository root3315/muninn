/**
 * How the headset reads a field's visits (vr/stamps.js), against the fake S3
 * of fixtures.mjs: the first visit is read first and alone, lands before the
 * rest, and every visit lands. On the live site the first picture once
 * waited on six reads sharing the line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readStamp, readInOrder } from '../public/js/vr/stamps.js';
import { TangentGrid } from '../public/js/wcs.js';
import { syntheticFrame, serve } from './fixtures.mjs';

const frame = syntheticFrame();
const grid = new TangentGrid(frame.ra, frame.dec, 0.09, 126, 90);

/** The fake bucket, each answer a little late, as a real line is. */
function slowBucket(ms) {
  const answer = serve(frame.file);
  return async (url, init) => {
    await new Promise((r) => { setTimeout(r, ms); });
    return answer(url, init);
  };
}

async function withFetch(fetchImpl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('a VR field reads its first visit against the fake S3', async () => {
  const stamp = await withFetch(serve(frame.file), () => readStamp('https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/a.fits', grid));
  assert.ok(stamp, 'the visit is read');
  assert.equal(stamp.width, 126);
  assert.ok(stamp.data.some((v) => v > 1.5), 'with its source in it');
});

test('the lead visit lands first, alone, and every visit lands', async () => {
  const entries = Array.from({ length: 6 }, (_, i) => ({ i, url: `https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/v${i}.fits` }));
  const lead = entries[3];
  const landed = [];
  let inFlight = 0;
  let leadAlone = true;
  await withFetch(slowBucket(5), () => readInOrder(entries, lead, async (e) => {
    inFlight += 1;
    if (e !== lead && landed.length === 0) leadAlone = false;
    const stamp = await readStamp(e.url, grid);
    inFlight -= 1;
    if (stamp) landed.push(e.i);
  }, { readers: 3, aloneMs: 10_000 }));
  assert.equal(landed[0], 3, 'the lead first');
  assert.ok(leadAlone, 'nothing else started before it landed');
  assert.deepEqual([...landed].sort(), [0, 1, 2, 3, 4, 5], 'every visit');
  assert.equal(inFlight, 0);
});

test('a lead that is slow lets the rest start after its moment alone', async () => {
  const entries = [{ i: 0 }, { i: 1 }, { i: 2 }];
  const order = [];
  await readInOrder(entries, entries[0], async (e) => {
    order.push(`start ${e.i}`);
    await new Promise((r) => { setTimeout(r, e.i === 0 ? 120 : 5); });
    order.push(`end ${e.i}`);
  }, { readers: 3, aloneMs: 30 });
  assert.equal(order[0], 'start 0');
  assert.ok(order.indexOf('start 1') < order.indexOf('end 0'), 'the others did not wait for the slow lead to end');
});

test('a failed lead does not stop the rest', async () => {
  const entries = [{ i: 0 }, { i: 1 }];
  const done = [];
  await assert.rejects(readInOrder(entries, entries[0], async (e) => {
    if (e.i === 0) throw new Error('cut short');
    done.push(e.i);
  }, { readers: 2, aloneMs: 1000 }));
  assert.deepEqual(done, [1]);
});

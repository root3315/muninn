/**
 * RICE_1 decoding: a real FLAGS row from a SPHEREx DR1 file, and round trips
 * through a small encoder that exercises every kind of block.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { riceDecode } from '../public/js/rice.js';

const row = JSON.parse(readFileSync(new URL('./rice-row.json', import.meta.url), 'utf8'));

test('a real DR1 FLAGS row decodes to what the file says', () => {
  const v = riceDecode(new Uint8Array(Buffer.from(row.b64, 'base64')), row.n, row.block);
  assert.equal(v.length, row.n);
  assert.deepEqual(Array.from(v.slice(0, row.first.length)), row.first);
  let sum = 0n;
  for (const x of v) sum += BigInt(x);
  assert.equal(String(sum), row.sum);
  for (const [bit, count] of Object.entries(row.bits)) {
    assert.equal(v.filter((x) => x & (1 << Number(bit))).length, count, `bit ${bit}`);
  }
});

/**
 * The encoder side of the convention, written plainly. `fsFor` picks the
 * code per block, so a test can force the zero, the plain and the whole-
 * difference blocks.
 */
function riceEncode(values, block, fsFor) {
  const bits = [];
  const put = (value, n) => { for (let k = n - 1; k >= 0; k--) bits.push((value >>> k) & 1); };
  put(values[0], 32);
  let last = values[0];
  for (let i = 0; i < values.length; i += block) {
    const diffs = [];
    for (let k = i; k < Math.min(i + block, values.length); k++) {
      const d = (values[k] - last) | 0;
      last = values[k];
      diffs.push(d < 0 ? ((~d) << 1 | 1) >>> 0 : (d << 1) >>> 0);
    }
    const fs = fsFor(diffs);
    if (fs === 'zero') { put(0, 5); continue; }
    if (fs === 'whole') { put(26, 5); for (const d of diffs) put(d, 32); continue; }
    put(fs + 1, 5);
    for (const d of diffs) {
      for (let z = d >>> fs; z > 0; z--) bits.push(0);
      bits.push(1);
      put(d & ((1 << fs) - 1), fs);
    }
  }
  while (bits.length % 8) bits.push(0);
  const out = new Uint8Array(bits.length / 8 + 4);
  for (let k = 0; k < bits.length; k++) out[k >> 3] |= bits[k] << (7 - (k & 7));
  return out;
}

test('constant blocks, small differences and whole differences all round-trip', () => {
  const values = new Int32Array(200);
  for (let i = 0; i < 64; i++) values[i] = 7;
  for (let i = 64; i < 128; i++) values[i] = 7 + (i % 5) - 2;
  for (let i = 128; i < 200; i++) values[i] = (i * 2654435761) | 0;
  const fsFor = (d) => (d.every((x) => x === 0) ? 'zero' : d.some((x) => x > 1e6) ? 'whole' : 2);
  assert.deepEqual(Array.from(riceDecode(riceEncode(values, 32, fsFor), values.length, 32)), Array.from(values));
});

test('every plain code width decodes', () => {
  const values = Int32Array.from({ length: 96 }, (_, i) => ((i * 37) % 23) - 11);
  for (let fs = 0; fs <= 12; fs++) {
    assert.deepEqual(Array.from(riceDecode(riceEncode(values, 16, () => fs), values.length, 16)),
      Array.from(values), `fs ${fs}`);
  }
});

test('a tile that ends early is an error, not a row of zeros', () => {
  const values = Int32Array.from({ length: 64 }, (_, i) => i * 1000);
  const full = riceEncode(values, 32, () => 10);
  assert.throws(() => riceDecode(full.subarray(0, 12), values.length, 32), /ended early/);
});

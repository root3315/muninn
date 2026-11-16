#!/usr/bin/env node
/**
 * build-allsky.mjs — an averaged Allsky image for the whole-sky page.
 *
 * The cube's own Allsky images are made by taking one pixel of every 8 × 8
 * block of the order-3 tiles, so each keeps a single pixel's noise, and over
 * a wide field the sky shows as grain. This makes the same mosaic — 768 cells
 * of 64 pixels, 27 to a row, the HiPS Allsky layout — from the mean of each
 * block instead. Blank pixels (the blanked cores of saturated stars) are left
 * out of each mean; a block of nothing but blanks stays blank. The values are
 * the tiles' own: IRSA's stretch, averaged, nothing else.
 *
 *   node tools/build-allsky.mjs            # the frames the page opens with
 *   node tools/build-allsky.mjs 8 42 93    # these frames only
 *
 * Writes public/data/allsky/Allsky_<frame>.png. Resumable: tiles already
 * fetched are kept in .cache/allsky-build/.
 */

import { inflateSync, deflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tileUrl, bandFrame, COLOUR_FRAMES, ALLSKY_COLUMNS, ALLSKY_TILE } from '../public/js/allsky/hips.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data', 'allsky');
const KEEP = join(ROOT, '.cache', 'allsky-build');
const CELLS = 768;
const TILE = 512;
const BLOCK = TILE / ALLSKY_TILE;
const AT_ONCE = 6;

const frames = process.argv.slice(2).map(Number).filter(Number.isInteger);
const wanted = frames.length ? frames : [...new Set([...COLOUR_FRAMES, ...[1, 2, 3, 4, 5, 6].map(bandFrame)])].sort((a, b) => a - b);

/** Grey value and whether there is data, per pixel, of an 8-bit PNG tile. */
function decodePng(buf) {
  let at = 8;
  let w;
  let h;
  let type;
  let depth;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const kind = buf.toString('ascii', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; }
    if (kind === 'PLTE') palette = data;
    if (kind === 'tRNS') trns = data;
    if (kind === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels) throw new Error(`unsupported PNG: type ${type}, depth ${depth}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const value = new Uint8Array(w * h);
  const has = new Uint8Array(w * h);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (line[i] + p) & 255;
    }
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const s = cur[x * channels];
      if (type === 3) {
        value[k] = palette[s * 3];
        has[k] = trns && s < trns.length ? (trns[s] > 0 ? 1 : 0) : 1;
      } else {
        value[k] = s;
        has[k] = type === 4 ? (cur[x * channels + 1] > 0 ? 1 : 0) : type === 6 ? (cur[x * 4 + 3] > 0 ? 1 : 0) : 1;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, value, has };
}

/**
 * An 8-bit grey PNG. Blank is 0, as in IRSA's own tiles, so no alpha channel
 * is carried. Each row takes whichever of the PNG filters leaves the least to
 * compress, as encoders do; the sky's smooth light compresses far better as
 * differences than as values.
 */
function encodePng(w, h, grey) {
  const raw = Buffer.alloc(h * (1 + w));
  const row = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const cur = grey.subarray(y * w, (y + 1) * w);
    const up = y ? grey.subarray((y - 1) * w, y * w) : new Uint8Array(w);
    let best = null;
    let bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      let cost = 0;
      for (let x = 0; x < w; x++) {
        const a = x ? cur[x - 1] : 0;
        const b = up[x];
        const c = x ? up[x - 1] : 0;
        let p = 0;
        if (f === 1) p = a;
        else if (f === 2) p = b;
        else if (f === 3) p = (a + b) >> 1;
        else if (f === 4) {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        row[x] = (cur[x] - p) & 255;
        cost += row[x] < 128 ? row[x] : 256 - row[x];
      }
      if (cost < bestCost) { bestCost = cost; best = [f, Uint8Array.from(row)]; }
    }
    raw[y * (1 + w)] = best[0];
    raw.set(best[1], y * (1 + w) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(kind, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function tile(n, frame) {
  const file = join(KEEP, `${frame}_${n}.png`);
  try { return await readFile(file); } catch { /* not yet */ }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(tileUrl(3, n, frame), { signal: AbortSignal.timeout(120_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      await writeFile(file, body);
      return body;
    } catch (err) {
      if (attempt >= 8) throw new Error(`tile ${n} of frame ${frame}: ${err.message}`);
      await new Promise((done) => setTimeout(done, 1500 * attempt));
    }
  }
}

async function build(frame) {
  const W = ALLSKY_COLUMNS * ALLSKY_TILE;
  const H = Math.ceil(CELLS / ALLSKY_COLUMNS) * ALLSKY_TILE;
  const grey = new Uint8Array(W * H);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < CELLS) {
      const n = next++;
      const body = await tile(n, frame);
      if (body) {
        const t = decodePng(body);
        const ox = (n % ALLSKY_COLUMNS) * ALLSKY_TILE;
        const oy = Math.floor(n / ALLSKY_COLUMNS) * ALLSKY_TILE;
        for (let by = 0; by < ALLSKY_TILE; by++) {
          for (let bx = 0; bx < ALLSKY_TILE; bx++) {
            let sum = 0;
            let count = 0;
            for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) {
              for (let x = bx * BLOCK; x < (bx + 1) * BLOCK; x++) {
                const k = y * t.w + x;
                if (t.has[k]) { sum += t.value[k]; count++; }
              }
            }
            const o = (oy + by) * W + ox + bx;
            // A block with light in it never rounds to 0, which means blank.
            if (count) grey[o] = Math.max(1, Math.round(sum / count));
          }
        }
      }
      done++;
      if (done % 64 === 0) process.stdout.write(`  frame ${frame}: ${done}/${CELLS}\n`);
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  const file = join(OUT, `Allsky_${frame}.png`);
  await writeFile(file, encodePng(W, H, grey));
  console.log(`wrote ${file}`);
}

await mkdir(OUT, { recursive: true });
await mkdir(KEEP, { recursive: true });
for (const frame of wanted) await build(frame);

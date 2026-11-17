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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './hips-png.mjs';
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

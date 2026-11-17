#!/usr/bin/env node
/**
 * build-gate-sky.mjs — the front page's Milky Way, from SPHEREx itself.
 *
 * The opening sky drew its band from a model of the galactic disc. This makes
 * the same kind of picture — equirectangular, right ascension 0 to 360 across,
 * declination +90 at the top row to −90 at the bottom, the layout gate.js
 * samples — from the survey: the site's averaged all-sky images at 4.70, 2.00
 * and 0.91 µm as red, green and blue, the colour view of allsky.html.
 *
 * Levels are the whole-sky page's: each wavelength from just above its median
 * sky to its brightest five ten-thousandths, eased toward white above 0.7.
 * Blank pixels (saturated cores) are left out of each sample's mean.
 *
 *   node tools/build-gate-sky.mjs      # after tools/build-allsky.mjs
 *
 * Writes public/data/sky/milkyway.png.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './hips-png.mjs';
import { xyfOf, nestOf } from '../public/js/allsky/healpix.js';
import { COLOUR_FRAMES, ALLSKY_ORDER, ALLSKY_TILE, allskySlot } from '../public/js/allsky/hips.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = 1024;
const H = 512;
/** Samples per output pixel, per side. */
const SUB = 3;
/** The front page adds the band onto its dark ground: kept a little under full so its stars stay on top. */
const GAIN = 0.75;

function levels(img) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (const v of img.value) {
    if (!v) continue;
    hist[v]++;
    n++;
  }
  const pct = (q) => {
    let s = 0;
    for (let v = 0; v < 256; v++) {
      s += hist[v];
      if (s >= q * n) return v;
    }
    return 255;
  };
  const sigma = pct(0.5) - pct(0.16);
  return { lo: pct(0.5) + 0.8 * sigma, hi: Math.max(pct(0.9995), pct(0.5) + 13) };
}

const shoulder = (x) => (x > 0.7 ? 0.7 + 0.3 * (1 - Math.exp(-(x - 0.7) / 0.3)) : x);

const sky = await Promise.all(COLOUR_FRAMES.map(async (f) => decodePng(await readFile(join(ROOT, 'public', 'data', 'allsky', `Allsky_${f}.png`)))));
const lv = sky.map(levels);
const n = 2 ** ALLSKY_ORDER;

/** One frame's value at a point of the sky, from its mosaic; 0 where blank. */
function valueAt(img, ra, dec) {
  const { face, x, y } = xyfOf(ra, dec);
  const ix = Math.min(n - 1, Math.floor(x * n));
  const iy = Math.min(n - 1, Math.floor(y * n));
  const slot = allskySlot(nestOf(ALLSKY_ORDER, face, ix, iy));
  // Rows of a cell run along ix, columns along iy (see healpix.js tileMesh).
  const row = slot.y + Math.min(ALLSKY_TILE - 1, Math.floor((x * n - ix) * ALLSKY_TILE));
  const col = slot.x + Math.min(ALLSKY_TILE - 1, Math.floor((y * n - iy) * ALLSKY_TILE));
  return img.value[row * img.w + col];
}

const out = new Uint8Array(W * H * 3);
for (let py = 0; py < H; py++) {
  for (let px = 0; px < W; px++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      let count = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const dec = 90 - ((py + (sy + 0.5) / SUB) * 180) / H;
          const ra = ((px + (sx + 0.5) / SUB) * 360) / W;
          const v = valueAt(sky[c], ra, dec);
          if (v) { sum += v; count++; }
        }
      }
      const v = count ? sum / count : 0;
      const x = Math.max(0, (v - lv[c].lo) / (lv[c].hi - lv[c].lo));
      out[(py * W + px) * 3 + c] = Math.round(255 * GAIN * Math.min(1, shoulder(x)));
    }
  }
}

const file = join(ROOT, 'public', 'data', 'sky', 'milkyway.png');
await writeFile(file, encodePng(W, H, out, 3));
console.log(`wrote ${file}`);

// End-to-end check: SIA search → S3 range read → reprojection → stretched PNG.
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseVOTable } from '../public/js/votable.js';
import { TangentGrid } from '../public/js/wcs.js';
import { loadStamp } from '../public/js/stamp.js';
import { limits, STRETCHES, ramp } from '../public/js/render.js';
import { encodePNG } from './png.mjs';

const RA = Number(process.argv[2] ?? 148.145);
const DEC = Number(process.argv[3] ?? 1.003);
const FOV = Number(process.argv[4] ?? 0.12);
const SIZE = 256;
const OUT = new URL('../.probe/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(OUT, { recursive: true });

const S3 = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';
const toS3 = (u) => u.replace(/^https:\/\/irsa\.ipac\.caltech\.edu\/ibe\/data\/spherex\//, S3);

const sia = `https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr2&POS=circle+${RA}+${DEC}+0.02`;
const t0 = Date.now();
const { rows } = parseVOTable(await (await fetch(sia)).text());
console.log(`SIA: ${rows.length} frames in ${Date.now() - t0} ms`);

// One frame per visit, preferring the detector with the most coverage in the set.
const byVisit = new Map();
for (const r of rows) {
  if (r.dataproduct_subtype !== 'science') continue;
  const mjd = Number(r.t_min);
  const key = `${Math.floor(mjd)}|${r.energy_bandpassname}`;
  if (!byVisit.has(key)) byVisit.set(key, r);
}
const picks = [...byVisit.values()]
  .filter((r) => r.energy_bandpassname === 'SPHEREx-D2')
  .sort((a, b) => Number(a.t_min) - Number(b.t_min));
console.log(`picked ${picks.length} D2 visits:`, picks.map((p) => p.obs_id).join(' '));

const grid = new TangentGrid(RA, DEC, FOV, SIZE);
const lut = ramp([[8, 10, 18], [36, 42, 60], [110, 118, 145], [196, 202, 220], [246, 247, 252]]);

let n = 0;
for (const p of picks) {
  const url = toS3(p.access_url);
  const t = Date.now();
  let stamp;
  try {
    stamp = await loadStamp(url, grid);
  } catch (e) {
    console.log(`  ✗ ${p.obs_id}: ${e.message}`);
    continue;
  }
  if (!stamp) { console.log(`  · ${p.obs_id}: no overlap`); continue; }
  const lim = limits(stamp.data, { loPercent: 5, hiPercent: 99.5 });
  const rgb = new Uint8Array(SIZE * SIZE * 3);
  const span = lim.hi - lim.lo || 1e-6;
  for (let i = 0; i < stamp.data.length; i++) {
    const v = stamp.data[i];
    let k = 0;
    if (v === v) {
      const tt = Math.max(0, Math.min(1, (v - lim.lo) / span));
      k = Math.round(STRETCHES.asinh(tt) * 255);
    }
    rgb[i * 3] = lut[k * 3]; rgb[i * 3 + 1] = lut[k * 3 + 1]; rgb[i * 3 + 2] = lut[k * 3 + 2];
  }
  const file = `${OUT}${String(n).padStart(2, '0')}_${p.obs_id}.png`;
  writeFileSync(file, encodePNG(rgb, SIZE, SIZE));
  console.log(`  ✓ ${stamp.meta.dateObs}  roll ${stamp.meta.rollDeg.toFixed(1)}°  cover ${(stamp.coverage * 100).toFixed(0)}%  ` +
    `${(stamp.meta.bytesRead / 1024).toFixed(0)} KB  ${Date.now() - t} ms  lo/hi ${lim.lo.toFixed(2)}/${lim.hi.toFixed(2)}  → ${file.split(/[\/]/).pop()}`);
  n++;
}
console.log(`\n${n} frames written to ${OUT}`);

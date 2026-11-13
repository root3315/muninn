/**
 * sensitivity.mjs — how faint a point source can this survey actually show?
 *
 * The whole Planet X framing stands or falls on one number: the limiting
 * magnitude of a SPHEREx visit. Everything else — how many visits you need to
 * coadd, whether a predicted body is reachable at all, what a null result is
 * worth — follows from it. So it is measured from the delivered pixels rather
 * than quoted from a mission page.
 *
 * The noise is taken from the detector's own pixels over the field's columns
 * (`stamp.meta.detectorSigma`, after the pipeline's FLAGS are applied), not
 * from the resampled grid: bilinear resampling smooths the noise and made the
 * first version of this table about 0.4 mag too deep.
 *
 * Method lives in `public/js/depth.js`, shared with the page so the number on
 * screen and the number in the write-up cannot drift: robust sky noise from the
 * half of the distribution sources cannot reach, converted to flux through the
 * pixel solid angle, summed over a realistic aperture, stated as the 5σ
 * point-source limit in AB magnitudes.
 *
 *   node tools/sensitivity.mjs [ra] [dec]
 */

import { frameFromRow, groupVisits, toS3 } from '../public/js/catalog.js';
import { TangentGrid } from '../public/js/wcs.js';
import { loadStamp } from '../public/js/stamp.js';
import { limitAB } from '../public/js/depth.js';
import { siaRows } from './sia.mjs';

const RA = Number(process.argv[2] ?? 13.4194);
const DEC = Number(process.argv[3] ?? 3.8459);
const SIZE = 192;
const FOV = 0.2;

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

const rows = await siaRows(RA, DEC);
const frames = rows.filter((r) => r.dataproduct_subtype === 'science').map(frameFromRow).filter(Boolean);

console.log(`field ${RA} ${DEC} — ${frames.length} frames in the index\n`);
console.log('band   visit date              sky sigma    5σ limit');
console.log('-------------------------------------------------------');

const grid = new TangentGrid(RA, DEC, FOV, SIZE);
const byBand = new Map();

for (const band of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']) {
  const visits = groupVisits(frames, { ra: RA, dec: DEC, band }).slice(0, 3);
  for (const v of visits) {
    let stamp;
    try {
      stamp = await loadStamp(toS3(v.url), grid, { minCoverage: 0.6 });
    } catch (err) {
      console.log(`${band.padEnd(6)} ${v.iso.slice(0, 19)}  read failed: ${err.message}`);
      continue;
    }
    if (!stamp) continue;
    const sigma = stamp.meta.detectorSigma;
    if (!sigma) continue;
    const mag = limitAB(sigma);
    if (!byBand.has(band)) byBand.set(band, []);
    byBand.get(band).push(mag);
    console.log(
      `${band.padEnd(6)} ${v.iso.slice(0, 19)}  ${sigma.toFixed(5).padStart(9)}  `
      + `${mag.toFixed(2).padStart(8)} AB`,
    );
  }
}

console.log('\n— per band, one visit —');
const all = [];
for (const [band, mags] of byBand) {
  const m = median(mags);
  all.push(m);
  console.log(`  ${band}  ${m.toFixed(2)} AB`);
}
const single = median(all);
console.log(`\nsingle visit, 5σ point source:  ${single.toFixed(2)} AB`);

console.log('\n— what coadding buys (√N) —');
for (const n of [10, 50, 100, 200]) {
  console.log(`  ${String(n).padStart(3)} visits:  ${(single + 2.5 * Math.log10(Math.sqrt(n))).toFixed(2)} AB`);
}

/* Planet Nine predictions, Brown & Batygin and the searches that followed. */
console.log('\n— against the prediction —');
const deep = single + 2.5 * Math.log10(Math.sqrt(200));
for (const [label, mag] of [['bright end of the prediction', 22], ['mid', 23.5], ['faint end', 25]]) {
  const gap = mag - deep;
  console.log(`  V≈${mag}  ${label.padEnd(30)} short by ${gap.toFixed(1)} mag `
    + `(a factor of ${Math.round(10 ** (0.4 * gap))} in flux)`);
}

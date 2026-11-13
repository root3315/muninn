/**
 * sharpness-calibrate.mjs — how much of its light does a star put in one
 * detector pixel, and how much does a cosmic ray?
 *
 * Reads every visit of a field in one band twice: as the page does, with the
 * FLAGS mask, and with the mask lifted. Every local maximum above 15σ on the
 * detector pixels is measured (public/js/sharpness.js): those the pipeline
 * flagged are its cosmic rays and bad pixels, the rest are stars and whatever
 * it missed. Also the median second-moment FWHM of unsaturated stars, the
 * width the Gaia model draws with (public/js/gaiasky.js).
 *
 * With --fixture, writes tests/sharpness-atala.json: the 6 Jul 2025 cosmic
 * ray and (152) Atala on 25 Dec 2025, the two the tests hold the threshold to.
 *
 *   node tools/sharpness-calibrate.mjs [ra] [dec] [band] [--fixture]
 */

import { writeFileSync } from 'node:fs';
import { frameFromRow, groupVisits, toS3 } from '../public/js/catalog.js';
import { TangentGrid, WCS } from '../public/js/wcs.js';
import { loadStamp } from '../public/js/stamp.js';
import { sharpness, sharpnessAt, STAR_MAX_SHARE } from '../public/js/sharpness.js';
import { siaRows } from './sia.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const RA = Number(args[0] ?? 13.4194);
const DEC = Number(args[1] ?? 3.8459);
const BAND = args[2] ?? 'D2';
const FIXTURE = process.argv.includes('--fixture');

const rows = await siaRows(RA, DEC);
const frames = rows.filter((r) => r.dataproduct_subtype === 'science').map(frameFromRow).filter(Boolean);
const visits = groupVisits(frames, { ra: RA, dec: DEC, band: BAND });
const grid = new TangentGrid(RA, DEC, 0.15, 192);

const stars = [];
const flagged = [];
const widths = [];
const fixture = {};
const finite = (v) => v === v;

/** Flux-weighted second moments over 7 × 7 pixels, the pixel's own width taken out. */
function momentFwhm(data, w, i, j, bg) {
  let m = 0; let mx = 0; let my = 0; let mxx = 0; let myy = 0;
  for (let dj = -3; dj <= 3; dj++) {
    for (let di = -3; di <= 3; di++) {
      const z = data[(j + dj) * w + i + di] - bg;
      if (!finite(z)) return null;
      m += z; mx += z * di; my += z * dj; mxx += z * di * di; myy += z * dj * dj;
    }
  }
  if (!(m > 0)) return null;
  const v = (mxx / m - (mx / m) ** 2 + myy / m - (my / m) ** 2) / 2 - 1 / 12;
  return 2.3548 * Math.sqrt(Math.max(0, v));
}

/** 11 × 11 detector pixels about one, for the fixture. */
const box = (det, [ci, cj]) => Array.from({ length: 11 }, (_, r) => Array.from({ length: 11 },
  (_, c) => Number(det.data[(cj - 5 + r) * det.width + ci - 5 + c].toFixed(4))));

for (const v of visits) {
  let masked; let open;
  try {
    [masked, open] = await Promise.all([loadStamp(toS3(v.url), grid), loadStamp(toS3(v.url), grid, { mask: false })]);
  } catch (err) {
    console.log(`${v.iso.slice(0, 10)}  not read: ${err.message}`);
    continue;
  }
  if (!masked || !open) continue;
  const det = open.detector;
  const sigma = masked.meta.detectorSigma;
  const { data, width: w, height: h } = det;

  for (let j = 6; j < h - 6; j++) {
    for (let i = 6; i < w - 6; i++) {
      const x = data[j * w + i];
      if (!finite(x)) continue;
      let top = true;
      for (let dj = -1; dj <= 1 && top; dj++) {
        for (let di = -1; di <= 1; di++) if ((di || dj) && data[(j + dj) * w + i + di] >= x) { top = false; break; }
      }
      if (!top) continue;
      const s = sharpnessAt(det, i, j, { search: 0 });
      if (!s || s.peak < 15 * sigma) continue;
      const hit = !finite(masked.detector.data[j * w + i]);
      (hit ? flagged : stars).push({ share: s.share, snr: s.peak / sigma });
      if (!hit && s.share < STAR_MAX_SHARE && s.peak > 50 * sigma && s.peak < 3000 * sigma) {
        const f = momentFwhm(data, w, i, j, x - s.peak);
        if (f != null) widths.push(f);
      }
    }
  }

  const centre = sharpness(det, RA, DEC, { search: 2 });
  const day = v.iso.slice(0, 10);
  if (centre) {
    console.log(`${day}  centre: share ${centre.share.toFixed(3)}, ${(centre.peak / sigma).toFixed(0)}σ`);
    const entry = {
      file: v.url.split('/').pop(), iso: v.iso, detectorSigma: Number(sigma.toFixed(5)),
      pixel: [centre.pixel[0] + det.x0, centre.pixel[1] + det.y0], box: box(det, centre.pixel),
      wcs: { ...det.wcs },
    };
    if (day === '2025-07-06') fixture.cosmicRay = entry;
    if (day === '2025-12-25') fixture.atala = entry;
  }
}

const at = (list, q) => list[Math.min(list.length - 1, Math.floor(q * list.length))];
const report = (name, list, lo) => {
  const shares = list.filter((p) => p.snr > lo).map((p) => p.share).sort((a, b) => a - b);
  if (!shares.length) return;
  console.log(`${name} above ${lo}σ: ${shares.length}, share min ${shares[0].toFixed(3)} · median ${at(shares, 0.5).toFixed(3)} · max ${shares.at(-1).toFixed(3)}`);
};
console.log(`\n${BAND}, ${visits.length} visits`);
for (const lo of [15, 50, 100]) { report('  unflagged maxima', stars, lo); report('  flagged maxima  ', flagged, lo); }
widths.sort((a, b) => a - b);
if (widths.length) {
  const px = at(widths, 0.5);
  console.log(`  PSF: median second-moment FWHM ${px.toFixed(2)} px = ${(px * 6.15).toFixed(1)}″ over ${widths.length} stars`);
}

if (FIXTURE) {
  // Typed arrays in the SIP tables go to JSON as plain lists.
  const plain = (k, val) => (ArrayBuffer.isView(val) ? Array.from(val) : val);
  writeFileSync(new URL('../tests/sharpness-atala.json', import.meta.url), `${JSON.stringify(fixture, plain)}\n`);
  console.log('wrote tests/sharpness-atala.json');
}

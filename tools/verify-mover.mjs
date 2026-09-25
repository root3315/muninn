/**
 * verify-mover.mjs — does a catalogued asteroid actually show up in the pixels?
 *
 * Centres a grid on a solar-system object's ephemeris position at one exposure,
 * then measures the flux at that exact sky position in every visit. If the object
 * is real and bright enough, one visit stands well above the others and the rest
 * sit at the background. That is the whole premise of the tool, checked rather
 * than asserted.
 *
 *   node tools/verify-mover.mjs <ra> <dec> [fov]
 */

import { parseVOTable } from '../public/js/votable.js';
import { frameFromRow, groupVisits, toS3 } from '../public/js/catalog.js';
import { TangentGrid } from '../public/js/wcs.js';
import { loadStamp } from '../public/js/stamp.js';

const RA = Number(process.argv[2] ?? 13.4194);
const DEC = Number(process.argv[3] ?? 3.8459);
const FOV = Number(process.argv[4] ?? 0.15);
const SIZE = 192;

const sia = `https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr2&POS=${encodeURIComponent(`circle ${RA} ${DEC} 0.006`)}&MAXREC=500`;
const { rows } = parseVOTable(await (await fetch(sia)).text());
const frames = rows.filter((r) => r.dataproduct_subtype === 'science').map(frameFromRow).filter(Boolean);
const visits = groupVisits(frames, { ra: RA, dec: DEC, band: 'D2' });

const grid = new TangentGrid(RA, DEC, FOV, SIZE);
const centre = Math.floor(SIZE / 2);

/** Peak minus local background, in units of the local noise. */
function centralSNR(data) {
  const ring = [];
  for (let j = centre - 12; j <= centre + 12; j++) {
    for (let i = centre - 12; i <= centre + 12; i++) {
      const d = Math.max(Math.abs(i - centre), Math.abs(j - centre));
      if (d <= 6 || d > 12) continue;
      const v = data[j * SIZE + i];
      if (v === v) ring.push(v);
    }
  }
  if (ring.length < 20) return null;
  ring.sort((a, b) => a - b);
  const bg = ring[Math.floor(ring.length / 2)];
  const noise = Math.max(ring[Math.floor(ring.length * 0.84)] - bg, 1e-9);
  let peak = -Infinity;
  for (let j = centre - 4; j <= centre + 4; j++) {
    for (let i = centre - 4; i <= centre + 4; i++) {
      const v = data[j * SIZE + i];
      if (v === v && v > peak) peak = v;
    }
  }
  return { snr: (peak - bg) / noise, excess: peak - bg, bg, noise };
}

console.log(`Field ${RA}, ${DEC} · ${(FOV * 60).toFixed(1)}′ · ${visits.length} D2 visits\n`);
console.log('date                 SNR at centre   excess (MJy/sr)   noise');

const results = [];
for (const v of visits) {
  let stamp;
  try {
    stamp = await loadStamp(toS3(v.url), grid);
  } catch { continue; }
  if (!stamp) continue;
  const s = centralSNR(stamp.data);
  if (!s) continue;
  results.push({ iso: v.iso, ...s });
  const bar = '█'.repeat(Math.max(0, Math.min(40, Math.round(s.snr))));
  console.log(`${v.iso.slice(0, 19)}  ${s.snr.toFixed(1).padStart(6)}  ${s.excess.toFixed(3).padStart(14)}   ${s.noise.toFixed(3)}  ${bar}`);
}

if (results.length > 2) {
  const sorted = [...results].sort((a, b) => b.snr - a.snr);
  const best = sorted[0];
  const rest = sorted.slice(1);
  const median = rest[Math.floor(rest.length / 2)].snr;
  console.log(`\nbrightest visit: ${best.iso.slice(0, 19)} at SNR ${best.snr.toFixed(1)}`);
  console.log(`median of the others: SNR ${median.toFixed(1)}`);
  console.log(best.snr > median * 2.5 && best.snr > 5
    ? '→ a source is present in one visit and absent in the rest. That is a mover.'
    : '→ no single visit stands out; this position does not carry a visible mover.');
}

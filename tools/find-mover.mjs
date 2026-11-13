/**
 * find-mover.mjs — look for a field where a genuinely bright catalogued object
 * stood inside a SPHEREx exposure.
 *
 * The earlier ecliptic sweep only found V≈18–20 asteroids, which SPHEREx will not
 * show convincingly in a single 110-second exposure. This goes the other way
 * round: take real SPHEREx frames near the ecliptic, ask SkyBoT what was inside
 * each frame's footprint at the moment it was taken, and keep the bright ones.
 *
 * An object only has to be present in ONE visit to be worth showing — that is the
 * classic signature, a dot that is there once and gone the next time.
 */

import { parseVOTable } from '../public/js/votable.js';
import { frameFromRow } from '../public/js/catalog.js';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const MAG_LIMIT = Number(process.argv[2] ?? 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function eclipticToEquatorial(lonDeg) {
  const e = 23.4392911 * Math.PI / 180;
  const l = lonDeg * Math.PI / 180;
  const ra = Math.atan2(Math.sin(l) * Math.cos(e), Math.cos(l)) * 180 / Math.PI;
  return { ra: (ra + 360) % 360, dec: Math.asin(Math.sin(e) * Math.sin(l)) * 180 / Math.PI };
}

async function siaFrames(ra, dec, radius) {
  const url = `${SIA}?COLLECTION=spherex_dr1&POS=${encodeURIComponent(`circle ${ra} ${dec} ${radius}`)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const { status, rows } = parseVOTable(await (await fetch(url, { signal: ctrl.signal })).text());
    if (status !== 'OK') return [];
    return rows.filter((r) => r.dataproduct_subtype === 'science').map(frameFromRow).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function skybot(ra, dec, radiusDeg, iso) {
  const url = 'https://ssp.imcce.fr/webservices/skybot/api/conesearch.php'
    + `?RA=${ra.toFixed(5)}&DEC=${dec.toFixed(5)}&SR=${radiusDeg.toFixed(4)}`
    + `&EPOCH=${encodeURIComponent(iso.slice(0, 19))}&mime=text&output=basic&loc=500&filter=0`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40_000);
  try {
    const { status, rows } = parseVOTable(await (await fetch(url, { signal: ctrl.signal })).text());
    if (status !== 'OK') return [];
    return rows.map((r) => ({
      num: r.Num !== '-' ? r.Num : null,
      name: r.Name,
      ra: Number(r._RAJ2000),
      dec: Number(r._DECJ2000),
      mag: Number(r.Mv),
      cls: r.Class,
      rate: Math.hypot(Number(r.dRAcosDec), Number(r.dDEC)),
    })).filter((o) => Number.isFinite(o.mag) && Number.isFinite(o.ra));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const hits = [];
console.log(`Hunting for catalogued objects brighter than V=${MAG_LIMIT} inside real SPHEREx frames.\n`);

for (let lon = 0; lon < 360; lon += 15) {
  const { ra, dec } = eclipticToEquatorial(lon);
  const frames = await siaFrames(ra, dec, 0.05);
  if (!frames.length) { console.log(`  λ=${String(lon).padStart(3)}°  no SPHEREx frames`); continue; }

  // One frame per distinct day is plenty — the footprint is ~3.5° across.
  const perDay = new Map();
  for (const f of frames) perDay.set(Math.floor(f.mjd), f);
  const probes = [...perDay.values()].slice(0, 8);

  let best = null;
  for (const f of probes) {
    const objects = await skybot(f.ra, f.dec, 1.6, f.iso);
    for (const o of objects) {
      if (o.mag > MAG_LIMIT) continue;
      if (!best || o.mag < best.mag) best = { ...o, frame: f };
    }
    await sleep(200);
  }

  console.log(`  λ=${String(lon).padStart(3)}°  RA ${ra.toFixed(2)} Dec ${dec.toFixed(2)}  frames ${String(frames.length).padStart(4)}`
    + `  days ${String(perDay.size).padStart(3)}`
    + (best ? `  →  V=${best.mag.toFixed(1)} ${best.num ? `(${best.num}) ` : ''}${best.name} ${best.cls} at ${best.frame.iso.slice(0, 10)}` : '  —'));
  if (best) hits.push(best);
  await sleep(300);
}

hits.sort((a, b) => a.mag - b.mag);
console.log('\nBrightest candidates:\n');
for (const h of hits.slice(0, 8)) {
  console.log(`  V=${h.mag.toFixed(1)}  ${h.num ? `(${h.num}) ` : ''}${h.name.padEnd(22)} ${h.cls.padEnd(12)}`
    + ` rate ${h.rate.toFixed(1)}"/h  at RA ${h.ra.toFixed(5)} Dec ${h.dec.toFixed(5)}  ${h.frame.iso}`
    + `  band ${h.frame.band}  obs ${h.frame.obsId}`);
}
if (!hits.length) console.log('  nothing brighter than the limit in the sampled frames.');

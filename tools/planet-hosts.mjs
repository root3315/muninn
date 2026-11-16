// Stars known to have planets, from the NASA Exoplanet Archive, for the card
// on the sky: a star with planets offers a link to its system in ExoVision.
//
//   node tools/planet-hosts.mjs
//
// Writes public/data/planet-hosts.json: one row per host star, [ra, dec,
// planets, name, letters, stars], ra and dec in degrees (J2000, as the archive
// gives them), letters the planets' own letters in order ("bcdefgh"), so that
// "TRAPPIST-1 e" is known for TRAPPIST-1's without a full name per planet,
// and stars the stars in the system (sy_snum): 2 or more when the host has
// companions going round with it.
// Run again when the archive grows; nothing on the page asks it at run time.

import { writeFile } from 'node:fs/promises';

const QUERY = 'select hostname, ra, dec, sy_pnum, sy_snum, pl_letter from pscomppars';
const URL_TAP = `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=${encodeURIComponent(QUERY)}&format=json`;
const OUT = new URL('../public/data/planet-hosts.json', import.meta.url);

const res = await fetch(URL_TAP, { signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`Exoplanet Archive answered ${res.status}`);
const rows = await res.json();

// pscomppars has a row per planet; a host is kept once, with every letter.
const hosts = new Map();
for (const r of rows) {
  if (!r.hostname || !Number.isFinite(r.ra) || !Number.isFinite(r.dec)) continue;
  if (!hosts.has(r.hostname)) hosts.set(r.hostname, [+r.ra.toFixed(5), +r.dec.toFixed(5), r.sy_pnum ?? 1, r.hostname, '', r.sy_snum ?? 1]);
  const letter = String(r.pl_letter ?? '').trim();
  const host = hosts.get(r.hostname);
  if (/^[a-z]$/.test(letter) && !host[4].includes(letter)) host[4] = [...host[4], letter].sort().join('');
}
// The count is this star's planets, its letters: sy_pnum counts the whole
// system's, a companion star's planets included (55 Cnc has 5, not 7).
for (const host of hosts.values()) if (host[4]) host[2] = host[4].length;
const list = [...hosts.values()].sort((a, b) => a[0] - b[0]);
await writeFile(OUT, `${JSON.stringify({
  source: 'NASA Exoplanet Archive, Planetary Systems Composite Parameters (pscomppars)',
  fetched: new Date().toISOString().slice(0, 10),
  hosts: list,
})}\n`);
console.log(`${list.length} host stars from ${rows.length} planets`);

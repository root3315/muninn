#!/usr/bin/env node
/**
 * build-fly-planets.mjs — every confirmed exoplanet system, for the flight.
 *
 * From the NASA Exoplanet Archive's Planetary Systems Composite Parameters
 * (pscomppars), each planet with a distance to its star: where the system is
 * (ICRS, parsecs from the Sun), its star (radius, temperature) and each planet
 * (semi-major axis, radius, period, eccentricity, equilibrium temperature,
 * a transit time when one was measured, how and when it was found).
 *
 * A planet's place on its orbit is known only where a transit time is: there
 * it is worked out for the moment shown. Elsewhere the orbit is drawn without
 * a planet on it, rather than with one put at a guessed place.
 *
 *   node tools/build-fly-planets.mjs   →   public/data/fly/exoplanets.json
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COLUMNS = 'pl_name,hostname,ra,dec,sy_dist,pl_orbsmax,pl_rade,pl_orbper,pl_eqt,pl_orbeccen,pl_tranmid,st_rad,st_teff,disc_year,discoverymethod,sy_pnum';
const TAP = `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=${encodeURIComponent(`select ${COLUMNS} from pscomppars where sy_dist is not null`)}&format=json`;
const DEG = Math.PI / 180;

const res = await fetch(TAP, { signal: AbortSignal.timeout(300_000) });
if (!res.ok) throw new Error(`Exoplanet Archive: HTTP ${res.status}`);
const rows = await res.json();

const num = (v, digits) => (v == null || !Number.isFinite(Number(v)) ? null : +Number(v).toFixed(digits));
const systems = new Map();
for (const r of rows) {
  let sys = systems.get(r.hostname);
  if (!sys) {
    const d = Number(r.sy_dist);
    const ra = Number(r.ra) * DEG;
    const dec = Number(r.dec) * DEG;
    sys = {
      host: r.hostname,
      ra: num(r.ra, 5),
      dec: num(r.dec, 5),
      pc: num(d, 3),
      pos: [d * Math.cos(dec) * Math.cos(ra), d * Math.cos(dec) * Math.sin(ra), d * Math.sin(dec)].map((c) => +c.toFixed(9)),
      starR: num(r.st_rad, 3),
      teff: num(r.st_teff, 0),
      planets: [],
    };
    systems.set(r.hostname, sys);
  }
  sys.planets.push({
    name: r.pl_name,
    a: num(r.pl_orbsmax, 5),
    r: num(r.pl_rade, 3),
    p: num(r.pl_orbper, 5),
    e: num(r.pl_orbeccen, 3),
    t: num(r.pl_eqt, 0),
    tc: num(r.pl_tranmid, 5),
    year: r.disc_year,
    method: r.discoverymethod,
  });
}

const out = [...systems.values()].sort((x, y) => x.pc - y.pc);
await mkdir(join(ROOT, 'public', 'data', 'fly'), { recursive: true });
await writeFile(join(ROOT, 'public', 'data', 'fly', 'exoplanets.json'), `${JSON.stringify({
  source: 'NASA Exoplanet Archive, Planetary Systems Composite Parameters (pscomppars)',
  fetched: new Date().toISOString().slice(0, 10),
  systems: out,
})}\n`);
console.log(`${out.length} systems, ${rows.length} planets`);

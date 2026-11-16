#!/usr/bin/env node
/**
 * build-fly-planets.mjs — every confirmed exoplanet system, for the flight.
 *
 * From the NASA Exoplanet Archive's Planetary Systems Composite Parameters
 * (pscomppars), each planet with a distance to its star: where the system is
 * (ICRS, parsecs from the Sun), which Hipparcos star it is when the Archive
 * says, how many stars the system has, its star (radius, temperature) and
 * each planet (semi-major axis, radius, period, eccentricity, argument of
 * periastron, inclination, equilibrium temperature, a transit or conjunction
 * time when one was measured, how and when it was found).
 *
 * The composite table takes each column from whichever paper it likes best,
 * so a star's radius and temperature can come from two papers that did not
 * agree. The star's pair is taken instead from one row of the Planetary
 * Systems table (ps): the Archive's default row for the star when it gives
 * both, else the row of the paper the composite's temperature came from,
 * else any one row that gives both. Which paper it was is kept.
 *
 * A planet's place on its orbit is known only where a transit or conjunction
 * time is: there it is worked out for the moment shown. Elsewhere the orbit is
 * drawn without a planet on it, rather than with one put at a guessed place.
 * A radius the Archive worked out from the mass (a mass–radius relation, its
 * "Calculated Value") is marked as such.
 *
 *   node tools/build-fly-planets.mjs   →   public/data/fly/exoplanets.json
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COLUMNS = 'pl_name,pl_letter,hostname,hip_name,sy_snum,ra,dec,sy_dist,pl_orbsmax,pl_rade,pl_rade_reflink,pl_orbper,pl_eqt,pl_orbeccen,pl_orblper,pl_orbincl,pl_tranmid,st_rad,st_teff,st_teff_reflink,disc_year,discoverymethod,sy_pnum';
const tap = (query) => `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=${encodeURIComponent(query)}&format=json`;
const DEG = Math.PI / 180;

async function ask(query) {
  const res = await fetch(tap(query), { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Exoplanet Archive: HTTP ${res.status}`);
  return res.json();
}

const rows = await ask(`select ${COLUMNS} from pscomppars where sy_dist is not null`);
// Every paper's figures for every star; filtered here, not in the query.
const starRows = await ask('select hostname,st_refname,st_teff,st_rad,default_flag from ps');
const rowsByHost = new Map();
for (const r of starRows) {
  if (!rowsByHost.has(r.hostname)) rowsByHost.set(r.hostname, []);
  rowsByHost.get(r.hostname).push(r);
}

const num = (v, digits) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : +Number(v).toFixed(digits));
/** The paper's key in an Archive reference link: refstr=…. */
const refKey = (link) => /refstr=([^\s>]+)/.exec(link ?? '')?.[1] ?? null;
/** Accented letters as the Archive writes them, &aacute; and the like, as letters. */
const MARKS = { acute: '́', grave: '̀', circ: '̂', tilde: '̃', uml: '̈', ring: '̊', cedil: '̧', caron: '̌' };
const unescape = (text) => text
  .replace(/&([A-Za-z])(acute|grave|circ|tilde|uml|ring|cedil|caron);/g, (_, c, mark) => c + MARKS[mark])
  .replace(/&amp;/g, '&').normalize('NFC');
/** The paper's name as the link shows it. */
const refName = (link) => unescape((link ?? '').replace(/<[^>]*>/g, '').trim()) || null;
/** A planet without the columns the Archive leaves empty: the file is a fifth smaller. */
const known = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/** HIP 73674 A → { hip: 73674, part: 'A' }; null where the Archive names no Hipparcos star. */
function hipOf(name) {
  const m = /^HIP\s+(\d+)\s*([A-Z])?/.exec(name ?? '');
  return m ? { hip: Number(m[1]), part: m[2] ?? null } : null;
}

/** For each host, one paper's radius and temperature together. */
const starOf = new Map();
function pickStarRow(host, composite) {
  const both = (rowsByHost.get(host) ?? []).filter((r) => num(r.st_teff, 0) > 0 && num(r.st_rad, 3) > 0);
  if (!both.length) return null;
  const want = refKey(composite.st_teff_reflink);
  return both.find((r) => Number(r.default_flag) === 1)
    ?? both.find((r) => refKey(r.st_refname) === want)
    ?? both[0];
}

const systems = new Map();
for (const r of rows) {
  let sys = systems.get(r.hostname);
  if (!sys) {
    const d = Number(r.sy_dist);
    const ra = Number(r.ra) * DEG;
    const dec = Number(r.dec) * DEG;
    if (!starOf.has(r.hostname)) starOf.set(r.hostname, pickStarRow(r.hostname, r));
    const star = starOf.get(r.hostname);
    const hip = hipOf(r.hip_name);
    sys = {
      host: r.hostname,
      ...(hip ? { hip: hip.hip, ...(hip.part ? { part: hip.part } : {}) } : {}),
      stars: Number(r.sy_snum) || 1,
      ra: num(r.ra, 5),
      dec: num(r.dec, 5),
      pc: num(d, 3),
      pos: [d * Math.cos(dec) * Math.cos(ra), d * Math.cos(dec) * Math.sin(ra), d * Math.sin(dec)].map((c) => +c.toFixed(9)),
      // One paper's pair where there is one; the composite's otherwise, said so.
      starR: star ? num(star.st_rad, 3) : num(r.st_rad, 3),
      teff: star ? num(star.st_teff, 0) : num(r.st_teff, 0),
      ...(star ? { starRef: refName(star.st_refname) } : {}),
      planets: [],
    };
    systems.set(r.hostname, sys);
  }
  sys.planets.push(known({
    name: r.pl_name,
    letter: r.pl_letter ?? null,
    a: num(r.pl_orbsmax, 5),
    r: num(r.pl_rade, 3),
    ...(refKey(r.pl_rade_reflink) === 'CALCULATED_VALUE' ? { rEst: true } : {}),
    p: num(r.pl_orbper, 5),
    e: num(r.pl_orbeccen, 3),
    w: num(r.pl_orblper, 2),
    i: num(r.pl_orbincl, 2),
    t: num(r.pl_eqt, 0),
    tc: num(r.pl_tranmid, 5),
    year: r.disc_year,
    method: r.discoverymethod,
  }));
}

const out = [...systems.values()].sort((x, y) => x.pc - y.pc);
await mkdir(join(ROOT, 'public', 'data', 'fly'), { recursive: true });
await writeFile(join(ROOT, 'public', 'data', 'fly', 'exoplanets.json'), `${JSON.stringify({
  source: 'NASA Exoplanet Archive, Planetary Systems Composite Parameters (pscomppars); stars\' radius and temperature from one row of Planetary Systems (ps)',
  fetched: new Date().toISOString().slice(0, 10),
  systems: out,
})}\n`);
const paired = out.filter((s) => s.starRef).length;
console.log(`${out.length} systems, ${rows.length} planets; ${out.filter((s) => s.hip).length} named Hipparcos stars; ${paired} stars from one paper`);

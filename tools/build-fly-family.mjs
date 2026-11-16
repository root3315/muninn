#!/usr/bin/env node
/**
 * build-fly-family.mjs — how many known small bodies go round the Sun.
 *
 * Counted once by JPL's Small-Body Database Query API (ssd-api.jpl.nasa.gov/
 * sbdb_query.api), class by class, and kept with the day they were counted:
 * the numbers grow every week, and the flight says on which day they were
 * true. Comets and asteroids on open (parabolic or hyperbolic) paths are
 * left out: they pass the Sun once and do not go round it.
 *
 *   node tools/build-fly-family.mjs   →   public/data/fly/family.json
 */

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=spkid&limit=1&';

/** Each group the card names, and the SBDB filter that counts it. */
const GROUPS = [
  ['neo', 'sb-group=neo'],
  ['main', 'sb-class=IMB,MBA,OMB'],
  ['trojan', 'sb-class=TJN'],
  ['centaur', 'sb-class=CEN'],
  ['tno', 'sb-class=TNO'],
  ['comet', 'sb-class=JFc,JFC,ETc,CTc,HTC,COM'],
  ['asteroids', 'sb-kind=a'],
  ['open', 'sb-class=HYA,HYP,PAR,PAA'],
];

const counts = {};
for (const [key, filter] of GROUPS) {
  const res = await fetch(API + filter, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`SBDB ${key}: HTTP ${res.status}`);
  const body = await res.json();
  if (!Number.isFinite(body.count)) throw new Error(`SBDB ${key}: no count`);
  counts[key] = body.count;
}
// Every asteroid on a closed orbit: the open ones are asteroids too in SBDB's kinds.
counts.asteroids -= (await (await fetch(`${API}sb-class=HYA,PAA`)).json()).count;

await writeFile(join(ROOT, 'public', 'data', 'fly', 'family.json'), `${JSON.stringify({
  source: 'JPL Small-Body Database Query API',
  counted: new Date().toISOString().slice(0, 10),
  counts,
}, null, 1)}\n`);
console.log(counts);

#!/usr/bin/env node
/**
 * build-fly-motion.mjs — how each star of the flight moves across the sky.
 *
 * The Hipparcos new reduction's proper motions (van Leeuwen 2007, VizieR
 * I/311), for every star of stars.bin, in its order: Int16 µα·cos δ, then
 * Int16 µδ, milliarcseconds a year (the fastest, Barnard's Star, is 10 358).
 * Hipparcos measured no radial velocities: a star's motion along the line of
 * sight is not known here, and the flight says so where it draws the path.
 *
 *   node tools/build-fly-motion.mjs   →   public/data/fly/motion.bin
 *
 * Asks the VizieR mirror at the CfA, as build-fly-stars.mjs does; it now
 * answers an unlimited request with nothing, so the limit is set past the
 * catalogue's 117 955 rows.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data', 'fly');
const ASU = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=I/311/hip2'
  + '&-out=HIP&-out=pmRA&-out=pmDE&-out.max=200000&Plx=%3E0';
/** Bytes a star in stars.bin: float x, y, z; int16 magnitude, colour; int32 Hipparcos number. */
const STAR_BYTES = 20;

const bin = await readFile(join(OUT, 'stars.bin'));
const count = bin.byteLength / STAR_BYTES;
const hips = new Int32Array(bin.buffer.slice(bin.byteOffset + count * 16, bin.byteOffset + count * 20));

const res = await fetch(ASU, { signal: AbortSignal.timeout(600_000) });
if (!res.ok) throw new Error(`VizieR: HTTP ${res.status}`);
const motion = new Map();
for (const line of (await res.text()).split('\n')) {
  const [hip, pmra, pmde] = line.split('\t').map((x) => x.trim());
  if (!/^\d+$/.test(hip ?? '')) continue;
  const a = Number(pmra);
  const d = Number(pmde);
  if (Number.isFinite(a) && Number.isFinite(d)) motion.set(Number(hip), [a, d]);
}

const out = new Int16Array(count * 2);
let found = 0;
const clamp = (v) => Math.max(-32767, Math.min(32767, Math.round(v)));
for (let i = 0; i < count; i++) {
  const m = motion.get(hips[i]);
  if (!m) continue;
  out[i * 2] = clamp(m[0]);
  out[i * 2 + 1] = clamp(m[1]);
  found++;
}
await writeFile(join(OUT, 'motion.bin'), Buffer.from(out.buffer));
console.log(`${found} of ${count} stars with a proper motion`);

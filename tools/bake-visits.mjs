/**
 * bake-visits.mjs — the frame lists of the preset fields and challenge targets,
 * baked into public/data/fields/<key>.json so they open whole with IRSA down.
 *
 * The lists ship with the page rather than being seeded into the server's
 * cache: the browser reads them before it asks the relay at all, so they work
 * on a static host and with the relay down too, and the server answers the
 * same files for /api/search (findBaked). One copy, two readers.
 *
 * Every field in public/data/targets.json is asked at the default cone
 * (0.006°) across all the collections the page reads, so the page shows any
 * band from it. A field is written only when every collection answered: a
 * half list baked in would hide visits for good. A field that does not come
 * whole keeps the file it had. IRSA's gateway failing (502, 503, 504) or a
 * question timing out is asked again, and fields still missing at the end of
 * a round are asked again after a pause, for up to `--minutes` (default 10).
 *
 *   node tools/bake-visits.mjs                every field
 *   node tools/bake-visits.mjs nep wise0855   only those
 *   node tools/bake-visits.mjs --minutes 20
 */

import { readFile, writeFile } from 'node:fs/promises';
import { parseVOTable } from '../public/js/votable.js';
import { frameFromRow } from '../public/js/catalog.js';
import { COLLECTIONS } from '../public/js/release.js';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';
/** The live relay's cone and cap, so a baked list is the list the relay would give. */
const RADIUS = 0.006;
const MAXREC = 500;
const ASK_TIMEOUT_MS = 120_000;
const RETRY_WAITS_MS = [1000, 3000];
const ROUND_PAUSE_MS = 60_000;
const DATA = new URL('../public/data/', import.meta.url);

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

async function askOnce(collection, ra, dec) {
  const pos = encodeURIComponent(`circle ${ra} ${dec} ${RADIUS}`);
  const res = await fetch(`${SIA}?COLLECTION=${collection}&POS=${pos}&MAXREC=${MAXREC}`, {
    signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    headers: { 'user-agent': 'Muninn/1.0 (NASA Space Apps 2026)' },
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const { status, message, rows } = parseVOTable(await res.text());
  if (status === 'ERROR') throw Object.assign(new Error(message), { status: 200 });
  return { rows, truncated: status === 'OVERFLOW' };
}

const worthRetry = (err) => err.status === undefined || [502, 503, 504].includes(err.status);

async function ask(collection, ra, dec) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await askOnce(collection, ra, dec);
    } catch (err) {
      if (!worthRetry(err) || attempt >= RETRY_WAITS_MS.length) throw err;
      await sleep(RETRY_WAITS_MS[attempt]);
    }
  }
}

/** Six decimals of a degree is 4 milliarcseconds: far below a 6″ pixel. */
const round = (value, places) => (Number.isFinite(value) ? Number(value.toFixed(places)) : value);

/** A frame as the page reads it, its numbers no longer than they mean anything. */
const compact = (f) => ({
  ...f, mjd: round(f.mjd, 6), ra: round(f.ra, 6), dec: round(f.dec, 6), emMin: round(f.emMin, 4), emMax: round(f.emMax, 4),
});

/** Every frame at the field, or the collections that did not answer. */
async function frameList({ ra, dec }) {
  const settled = await Promise.allSettled(COLLECTIONS.map((c) => ask(c, ra, dec)));
  const failed = settled.flatMap((s, i) => (s.status === 'rejected' ? [`${COLLECTIONS[i]}: ${s.reason.message}`] : []));
  if (failed.length) return { failed };

  const seen = new Set();
  const frames = [];
  let truncated = false;
  for (const { value } of settled) {
    truncated ||= value.truncated;
    for (const row of value.rows) {
      if (row.dataproduct_subtype !== 'science' || Number(row.calib_level) < 2) continue;
      const frame = frameFromRow(row);
      if (!frame?.url || seen.has(frame.url)) continue;
      seen.add(frame.url);
      frames.push(compact(frame));
    }
  }
  frames.sort((a, b) => a.mjd - b.mjd);
  return { frames, truncated };
}

const args = process.argv.slice(2);
const minutesAt = args.indexOf('--minutes');
const minutes = minutesAt >= 0 ? Number(args.splice(minutesAt, 2)[1]) : 10;
const { targets } = JSON.parse(await readFile(new URL('targets.json', DATA), 'utf8'));
const unknown = args.filter((k) => !targets.some((t) => t.key === k));
if (unknown.length) throw new Error(`No such field: ${unknown.join(', ')}`);

let waiting = targets.filter((t) => !args.length || args.includes(t.key));
const until = Date.now() + minutes * 60_000;
const written = [];

for (let round = 1; waiting.length; round += 1) {
  console.log(`Round ${round}: ${waiting.map((t) => t.key).join(', ')}`);
  const left = [];
  for (const target of waiting) {
    const started = Date.now();
    const { frames, truncated, failed } = await frameList(target);
    const took = ((Date.now() - started) / 1000).toFixed(1);
    if (failed) {
      console.log(`  ${target.key.padEnd(9)} not whole after ${took} s: ${failed.join('; ')}`);
      left.push(target);
      continue;
    }
    if (!frames.length) {
      console.log(`  ${target.key.padEnd(9)} no frames here; the file is left as it was`);
      continue;
    }
    const body = `${JSON.stringify({ ra: target.ra, dec: target.dec, radius: RADIUS, truncated, frames })}\n`;
    await writeFile(new URL(`fields/${target.key}.json`, DATA), body, 'utf8');
    written.push(target.key);
    console.log(`  ${target.key.padEnd(9)} ${String(frames.length).padStart(5)} frames, `
      + `${(Buffer.byteLength(body) / 1024).toFixed(0).padStart(4)} KB, ${took} s${truncated ? ', capped at MAXREC' : ''}`);
  }
  waiting = left;
  if (!waiting.length || Date.now() + ROUND_PAUSE_MS > until) break;
  await sleep(ROUND_PAUSE_MS);
}

// The page finds a baked field through the index; every target with a file is in it.
const index = [];
for (const t of targets) {
  try {
    await readFile(new URL(`fields/${t.key}.json`, DATA));
    index.push({ key: t.key, ra: t.ra, dec: t.dec });
  } catch { /* no list for this one */ }
}
await writeFile(new URL('fields/index.json', DATA), `${JSON.stringify(index)}\n`, 'utf8');

console.log(`\n${written.length} written${waiting.length ? `; not whole, still to bake: ${waiting.map((t) => t.key).join(', ')}` : ''}`);
process.exitCode = waiting.length ? 1 : 0;

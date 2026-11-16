#!/usr/bin/env node
/**
 * warm-frames.mjs — read the ready-made fields through a running server's
 * frame relay, so that it has them on its disk before the first visitor does.
 *
 *   node tools/warm-frames.mjs --server http://127.0.0.1:8082 \
 *        [--targets public/data/targets.json] [--bands D2,D6] [--at-once 3]
 *
 * For each field in targets.json the server is asked for its frame list, as
 * the page asks, and every visit in each band is read the way the page reads
 * it: the page's own code (stamp.js) plans and makes the reads, pointed at
 * the relay alone (ranges.js useFrameRelay, with no fallback to the bucket).
 * Its wavelength table at the field's centre is read too. Bands default to
 * the field's own; --bands reads those instead, for every field.
 *
 * Only the grid is not the page's: its width follows the visitor's screen.
 * The widest the page draws (GRID_MAX_W, MAX_ASPECT and the sampling in
 * app.js, mirrored below) is read, so whatever screen opens the field, the
 * rows it reads lie inside the rows kept: the relay keeps whole blocks, and
 * a narrower grid's ranges fall inside a wider one's.
 *
 * Safe to stop and run again: what the relay already holds comes back from
 * its disk ("kept" below) without a trip to AWS, and the run goes on from
 * there. A few visits at a time, and under the relay's per-minute limit.
 */
import { readFile } from 'node:fs/promises';
import { groupVisits, toS3 } from '../public/js/catalog.js';
import { loadStamp, loadWavelength } from '../public/js/stamp.js';
import { useFrameRelay } from '../public/js/ranges.js';
import { TangentGrid } from '../public/js/wcs.js';

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const SERVER = option('server', 'http://127.0.0.1:8082').replace(/\/+$/, '');
const TARGETS = option('targets', new URL('../public/data/targets.json', import.meta.url));
const BANDS = option('bands', '').split(',').map((b) => b.trim().toUpperCase()).filter(Boolean);
const AT_ONCE = Math.max(1, Math.min(8, Number(option('at-once', 3)) || 3));

/* The page's grid, as app.js cuts it (fieldGrid and gridWidthFor): mirrored, since app.js needs a browser. */
const DETECTOR_ARCSEC = 6.15;
const SAMPLES_PER_PIXEL = 2.5;
const GRID_MIN_W = 360;
const GRID_MAX_W = 1024;
const MAX_ASPECT = 2;

function widestGrid(ra, dec, fov) {
  const h = Math.min(768, Math.min(GRID_MAX_W, Math.max(GRID_MIN_W, Math.round(((fov * 3600) / DETECTOR_ARCSEC) * SAMPLES_PER_PIXEL))));
  const w = Math.min(GRID_MAX_W, Math.round(h * MAX_ASPECT));
  return new TangentGrid(ra, dec, (fov * w) / h, w, h);
}

/* ---------------------------------------------------------------- the count */

const count = { requests: 0, kept: 0, fetched: 0, bytes: 0, refused: 0 };
/** The relay allows 1200 reads a minute from one address; this keeps under a thousand. */
const SPACING_MS = 60;
let nextStart = 0;
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

const plainFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const wait = nextStart - Date.now();
  nextStart = Math.max(Date.now(), nextStart) + SPACING_MS;
  if (wait > 0) await sleep(wait);
  const res = await plainFetch(url, init);
  if (String(url).startsWith(`${SERVER}/api/frame`)) {
    count.requests += 1;
    const said = res.headers.get('x-muninn-frame');
    if (said === 'hit') count.kept += 1;
    else if (said === 'miss') count.fetched += 1;
    else count.refused += 1;
    count.bytes += Number(res.headers.get('content-length')) || 0;
  }
  return res;
};

/* ----------------------------------------------------------------- the work */

async function frameList(target) {
  const res = await plainFetch(`${SERVER}/api/search?ra=${target.ra.toFixed(6)}&dec=${target.dec.toFixed(6)}&radius=0.006`);
  const body = await res.json().catch(() => null);
  if (!body?.ok || !Array.isArray(body.frames)) throw new Error(`no frame list (HTTP ${res.status})`);
  return body.frames;
}

/** One visit as the page reads it; a refusal for the per-minute limit is waited out and asked again. */
async function warmVisit(visit, target, grid) {
  for (let tries = 0; ; tries += 1) {
    try {
      const url = toS3(visit.url);
      await loadStamp(url, grid);
      await loadWavelength(url, target.ra, target.dec).catch(() => null);
      return true;
    } catch (err) {
      if (err?.status === 429 && tries < 3) { await sleep(60_000); continue; }
      console.log(`    ${visit.obsId} ${visit.band}: ${err.message}`);
      return false;
    }
  }
}

async function main() {
  useFrameRelay(`${SERVER}/api/frame`, { fallback: false });
  const { targets } = JSON.parse(await readFile(TARGETS, 'utf8'));
  const started = Date.now();
  let visits = 0;
  let failed = 0;
  for (const target of targets) {
    if (!Number.isFinite(target.ra) || !Number.isFinite(target.dec)) continue;
    let frames;
    try {
      frames = await frameList(target);
    } catch (err) {
      console.log(`${target.key}: ${err.message}`);
      continue;
    }
    const grid = widestGrid(target.ra, target.dec, target.fov ?? 0.3);
    for (const band of BANDS.length ? BANDS : [target.band ?? 'D2']) {
      const list = groupVisits(frames, { ra: target.ra, dec: target.dec, band });
      const before = { ...count };
      const queue = list.slice();
      let bad = 0;
      await Promise.all(Array.from({ length: AT_ONCE }, async () => {
        for (let visit = queue.shift(); visit; visit = queue.shift()) {
          if (!(await warmVisit(visit, target, grid))) bad += 1;
        }
      }));
      visits += list.length;
      failed += bad;
      const mb = ((count.bytes - before.bytes) / 2 ** 20).toFixed(1);
      console.log(`${target.key} ${band}: ${list.length} visits, ${count.requests - before.requests} reads `
        + `(${count.kept - before.kept} kept, ${count.fetched - before.fetched} from AWS), ${mb} MB${bad ? `, ${bad} failed` : ''}`);
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n${visits} visits in ${seconds} s: ${count.requests} reads, ${count.kept} already kept, `
    + `${count.fetched} from AWS, ${count.refused} refused, ${(count.bytes / 2 ** 20).toFixed(1)} MB served${failed ? `; ${failed} visits failed` : ''}`);
  if (failed) process.exitCode = 1;
}

await main();

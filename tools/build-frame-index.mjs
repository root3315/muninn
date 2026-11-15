/**
 * build-frame-index.mjs — Muninn's own index of every SPHEREx level-2 frame,
 * so that /api/search can list the visits of any position with IRSA down.
 *
 * IRSA's ObsCore table (spherex.obscore, over TAP) is read a week of exposure
 * time at a time: obs_id, collection, band, wavelength range, start time,
 * exposure, centre and footprint polygon. The FITS file's address is not in
 * that table (its access_url is a DataLink page), so the processing version
 * that names the file is read from the public S3 mirror, one listing per week
 * folder. Each frame is then filed under the 2° sky cell of its centre as
 * gzipped JSON, and the relay reads only the cells near a position.
 *
 *   <dir>/chunks/<mjd>.json.gz   one week as fetched (kept: the build resumes from them)
 *   <dir>/versions.json          week folder → processing version, from the S3 mirror
 *   <dir>/tiles/<band>/<band>-<cell>.json.gz   the index the relay reads
 *   <dir>/meta.json              when it was built, of what, how big
 *
 * The directory is MUNINN_INDEX_DIR, or .index/ in the repository (not in git).
 *
 *   node tools/build-frame-index.mjs --estimate     one week, and what the whole would weigh
 *   node tools/build-frame-index.mjs                fetch what is missing, then pack
 *   node tools/build-frame-index.mjs --pack         pack the weeks already fetched
 *   node tools/build-frame-index.mjs --verify       compare the row count with IRSA's
 *   options: --dir <path> --from <mjd> --to <mjd> --days 7 --pause 3 --parallel 3
 *            --source sia   read IRSA's SIA by time instead of TAP, when TAP is down (use --days 2)
 *
 * Run again to refresh: weeks fetched whole are kept, and only new weeks, and
 * weeks fetched before they were over, are asked for. A new release: add its
 * collection to public/js/release.js and run it again; the weeks keep every
 * collection IRSA lists, so the old ones need no new fetch.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../public/js/csv.js';
import { COLLECTIONS } from '../public/js/release.js';
import {
  ROW, TILE_DEG, tileOf, indexRowFromObscore, footprintReach, folderOf, folderVersions, versionIn, s3List,
} from '../public/js/frameindex.js';

const TAP_ASYNC = 'https://irsa.ipac.caltech.edu/TAP/async';
const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const USER_AGENT = 'Muninn/1.0 (frame index)';
/** The first SPHEREx survey exposure in DR1 starts on MJD 60789.75. */
const FIRST_MJD = 60789;
/** The index is not packed past this size on disk; it is reported instead. */
const MAX_BYTES = 1.5 * 1024 ** 3;
const TAP_TIMEOUT_MS = 30 * 60 * 1000;
/** IRSA's bursts of 502 last minutes to an hour: a week is asked again for about two hours before the build stops. */
const RETRY_WAITS_MS = [10_000, 30_000, 90_000, 180_000, 300_000, ...Array(10).fill(600_000)];
const COLUMNS = 'obs_id,obs_collection,energy_bandpassname,em_min,em_max,t_min,t_exptime,s_ra,s_dec,s_region';
/** Cells are packed this many Dec bands at a time, so the build never holds the whole sky. */
const BANDS_PER_PASS = 15;

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function options(argv) {
  const opts = { dir: process.env.MUNINN_INDEX_DIR || join(ROOT, '.index'), days: 7, pause: 3, parallel: 3, source: 'tap' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--estimate') opts.estimate = true;
    else if (arg === '--pack') opts.packOnly = true;
    else if (arg === '--source') opts.source = next() === 'sia' ? 'sia' : 'tap';
    else if (arg === '--verify') opts.verify = true;
    else if (arg === '--dir') opts.dir = next();
    else if (arg === '--from') opts.from = Number(next());
    else if (arg === '--to') opts.to = Number(next());
    else if (arg === '--days') opts.days = Number(next());
    else if (arg === '--pause') opts.pause = Number(next());
    else if (arg === '--parallel') opts.parallel = Math.max(1, Math.min(4, Number(next()) || 1));
    else throw new Error(`unknown option ${arg}`);
  }
  opts.from = Number.isFinite(opts.from) ? opts.from : FIRST_MJD;
  opts.to = Number.isFinite(opts.to) ? opts.to : Math.ceil(mjdNow());
  return opts;
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });
const log = (...words) => console.log(new Date().toISOString().slice(11, 19), ...words);

/* ------------------------------------------------------------------ IRSA */

/**
 * A question to IRSA's TAP as an asynchronous job: submitted, its phase
 * asked every few seconds, its table read once it is done. A loaded TAP can
 * take longer than an HTTP client waits for the first byte of a synchronous
 * answer; a job has no such limit, and is deleted once read.
 */
async function tapOnce(query) {
  const submitted = await fetch(TAP_ASYNC, {
    method: 'POST',
    headers: { 'user-agent': USER_AGENT },
    body: new URLSearchParams({ LANG: 'ADQL', FORMAT: 'csv', MAXREC: '5000000', PHASE: 'RUN', QUERY: query }),
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  });
  const job = submitted.headers.get('location');
  if (!job) throw Object.assign(new Error(`TAP job not accepted: HTTP ${submitted.status}`), { status: submitted.status >= 300 ? submitted.status : 503 });
  const until = Date.now() + TAP_TIMEOUT_MS;
  try {
    for (;;) {
      // A phase that cannot be read (the gateway's 502) is asked again; the job runs on.
      const phase = await fetch(`${job}/phase`, { signal: AbortSignal.timeout(60_000) })
        .then(async (res) => (res.ok ? (await res.text()).trim() : 'UNKNOWN'), () => 'UNKNOWN');
      if (phase === 'COMPLETED') break;
      if (phase === 'ERROR') {
        const detail = await fetch(`${job}/error`, { signal: AbortSignal.timeout(60_000) }).then((r) => r.text(), () => '');
        throw Object.assign(new Error(`TAP job ERROR: ${detail.replace(/<[^>]+>/g, ' ').trim().slice(0, 200)}`), { status: 200 });
      }
      // Stopped by the service (its time limit for a job, under load): asked again later.
      if (phase === 'ABORTED' || phase === 'CANCELLED') throw new Error(`TAP job ${phase} by the service`);
      if (Date.now() > until) throw new Error(`TAP job still ${phase} after ${TAP_TIMEOUT_MS / 60000} minutes`);
      await sleep(5000);
    }
    const res = await fetch(`${job}/results/result`, { signal: AbortSignal.timeout(300_000) });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`TAP result HTTP ${res.status}`), { status: res.status });
    if (text.trimStart().startsWith('<')) throw Object.assign(new Error('TAP result is not a table'), { status: 200 });
    return parseCsv(text);
  } finally {
    fetch(job, { method: 'DELETE', signal: AbortSignal.timeout(30_000) }).catch(() => {});
  }
}

const worthRetry = (err) => err.status === undefined || [429, 500, 502, 503, 504].includes(err.status);

/** A TAP question, asked again with longer and longer pauses while IRSA's gateway fails. */
const tap = (query) => patiently(() => tapOnce(query));

/** IRSA's SIA, the same frames by exposure time, one collection at a time, for when TAP is down. */
/**
 * A GET that waits as long as it is told to. fetch() gives up when the
 * first byte takes more than five minutes, and a loaded SIA can take longer
 * to start a day's list.
 */
function getSlowly(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { 'user-agent': USER_AGENT } }, (res) => {
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs / 60000} minutes`)));
    req.on('error', reject);
  });
}

async function siaOnce(collection, t0, t1) {
  const url = `${SIA}?COLLECTION=${collection}&TIME=${t0}+${t1}&MAXREC=1000000&RESPONSEFORMAT=csv`;
  const { status, text } = await getSlowly(url, TAP_TIMEOUT_MS);
  if (status !== 200) throw Object.assign(new Error(`SIA HTTP ${status}`), { status });
  // A VOTable instead of the CSV asked for is the SIA saying it failed (a timeout under load): asked again.
  if (text.trimStart().startsWith('<')) {
    const said = /QUERY_STATUS"\s+value="ERROR"\s*>([^<]*)/.exec(text)?.[1]?.trim() || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`SIA answer is not a table: ${said}`);
  }
  return parseCsv(text).filter((r) => r.dataproduct_subtype === 'science' && Number(r.calib_level) >= 2);
}

async function patiently(ask) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await ask();
    } catch (err) {
      const wait = RETRY_WAITS_MS[attempt];
      if (!worthRetry(err) || wait === undefined) throw err;
      log(`  ${err.message}; again in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}

/** How many frames IRSA lists per collection. A full scan of the table: minutes. */
async function irsaCounts() {
  const rows = await tap('SELECT obs_collection, COUNT(*) AS n FROM spherex.obscore GROUP BY obs_collection');
  return Object.fromEntries(rows.map((r) => [r.obs_collection.trim(), Number(r.n)]));
}

/** The S3 mirror's listing, asked again a few times if it falters. */
async function s3ListPatiently(prefix, opts) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await s3List(prefix, opts);
    } catch (err) {
      if (!worthRetry(err) || attempt >= 4) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
}

/* --------------------------------------------------------------- fetching */

const chunkPath = (dir, t0) => join(dir, 'chunks', `${t0}.json.gz`);

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

/**
 * One window of exposure start times, [t0, t1), every collection IRSA lists:
 * a week keeps its collection by name, and the pack takes the ones
 * release.js names, so a release added later needs no new fetch of old weeks.
 */
async function fetchChunk(t0, t1, source = 'tap') {
  let rows;
  if (source === 'sia') {
    // The SIA lists a frame whose exposure overlaps the window; kept by its start, as TAP's are.
    rows = [];
    for (const collection of COLLECTIONS) {
      const listed = await patiently(() => siaOnce(collection, t0, t1));
      rows.push(...listed.filter((r) => Number(r.t_min) >= t0 && Number(r.t_min) < t1));
    }
  } else {
    rows = await tap(`SELECT ${COLUMNS} FROM spherex.obscore WHERE t_min >= ${t0} AND t_min < ${t1}`);
  }
  const kept = [];
  let dropped = 0;
  for (const row of rows) {
    const name = String(row.obs_collection ?? '').trim();
    const stored = indexRowFromObscore(row, [name], -1);
    if (stored) { stored[ROW.coll] = name; kept.push(stored); } else dropped += 1;
  }
  return { t0, t1, source, fetchedAt: new Date().toISOString(), listed: rows.length, dropped, rows: kept };
}

const mjdNow = () => Date.now() / 86400000 + 40587;

/**
 * Whether a fetched week is whole: cut short by an earlier --to, or fetched
 * before its last day was over (IRSA adds frames as they are processed, so a
 * week fetched within a few days of its end is asked for again).
 */
async function chunkIsWhole(path, t0, days) {
  try {
    const chunk = await readChunk(path);
    const fetchedMjd = Date.parse(chunk.fetchedAt) / 86400000 + 40587;
    return chunk.t1 >= t0 + days && fetchedMjd > chunk.t1 + 3;
  } catch {
    return false;
  }
}

async function readChunk(path) {
  return JSON.parse(gunzipSync(await readFile(path)).toString('utf8'));
}

async function writeAtomically(path, bytes) {
  await writeFile(`${path}.part`, bytes);
  await rename(`${path}.part`, path);
}

function chunkStarts({ from, to, days }) {
  const starts = [];
  for (let t = from; t < to; t += days) starts.push(t);
  return starts;
}

async function fetchMissing(opts) {
  await mkdir(join(opts.dir, 'chunks'), { recursive: true });
  const starts = chunkStarts(opts);
  const todo = [];
  for (const t0 of starts) {
    if (!(await chunkIsWhole(chunkPath(opts.dir, t0), t0, opts.days))) todo.push(t0);
  }
  log(`${starts.length - todo.length} of ${starts.length} weeks fetched already; ${todo.length} to ask for, ${opts.parallel} at a time`);
  let done = 0;
  // A few questions at once: each costs IRSA a scan of the table, so no more.
  const worker = async () => {
    while (todo.length) {
      const t0 = todo.shift();
      const t1 = Math.min(t0 + opts.days, opts.to);
      const began = Date.now();
      const chunk = await fetchChunk(t0, t1, opts.source);
      await writeAtomically(chunkPath(opts.dir, t0), gzipSync(JSON.stringify(chunk)));
      done += 1;
      log(`MJD ${t0}–${t1}: ${chunk.rows.length} frames in ${((Date.now() - began) / 1000).toFixed(0)} s (${done} done)`);
      await sleep(opts.pause * 1000);
    }
  };
  await Promise.all(Array.from({ length: opts.parallel }, worker));
}

/* ---------------------------------------------------------------- versions */

/**
 * The processing version of every week folder the frames name, read from the
 * S3 mirror and kept in versions.json, so a second pack reads only new weeks.
 */
async function resolveVersions(dir, folders) {
  const path = join(dir, 'versions.json');
  const known = (await exists(path)) ? JSON.parse(await readFile(path, 'utf8')) : {};
  const todo = [...folders].filter((f) => !(f in known));
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const folder = todo.pop();
      known[folder] = await folderVersions(folder, s3ListPatiently);
      done += 1;
      if (done % 25 === 0) log(`  versions: ${done} folders read`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  await writeFile(path, JSON.stringify(known));
  return known;
}

/* ----------------------------------------------------------------- packing */

async function chunkFiles(dir) {
  const names = (await readdir(join(dir, 'chunks'))).filter((n) => n.endsWith('.json.gz'));
  return names.sort((a, b) => parseFloat(a) - parseFloat(b)).map((n) => join(dir, 'chunks', n));
}

async function dirBytes(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? await dirBytes(full) : (await stat(full)).size;
  }
  return total;
}

/**
 * The fetched weeks filed into sky cells. Built beside the live index and
 * swapped in whole, so a relay reading it never sees half a build.
 */
async function pack(opts) {
  const files = await chunkFiles(opts.dir);
  if (!files.length) throw new Error(`nothing fetched under ${opts.dir}`);

  const folders = new Set();
  let last = 0;
  for (const file of files) {
    const chunk = await readChunk(file);
    last = Math.max(last, chunk.t1);
    for (const row of chunk.rows) {
      if (COLLECTIONS.includes(row[ROW.coll])) folders.add(folderOf(row[ROW.coll], row[ROW.obsId]));
    }
  }
  log(`${files.length} weeks fetched; reading the processing versions of ${folders.size} week folders`);
  const known = await resolveVersions(opts.dir, folders);

  const versions = [];
  const versionIndex = new Map();
  const counts = Object.fromEntries(COLLECTIONS.map((c) => [c, 0]));
  let reach = 0;
  let rows = 0;
  let unresolved = 0;
  let tiles = 0;
  let lastMjd = 0;

  const staging = join(opts.dir, 'tiles.new');
  await rm(staging, { recursive: true, force: true });
  const bands = 180 / TILE_DEG;
  for (let lo = 0; lo < bands; lo += BANDS_PER_PASS) {
    const hi = lo + BANDS_PER_PASS;
    const cells = new Map();
    // Weeks fetched on different grids (TAP's weeks, the SIA's days) may overlap: each frame once.
    const seen = new Set();
    for (const file of files) {
      for (const row of (await readChunk(file)).rows) {
        const tile = tileOf(row[ROW.ra], row[ROW.dec]);
        const band = Number(tile.split('-')[0]);
        if (band < lo || band >= hi) continue;
        const collection = row[ROW.coll];
        if (!COLLECTIONS.includes(collection)) continue;
        const key = `${collection} ${row[ROW.obsId]} ${row[ROW.det]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        row[ROW.coll] = COLLECTIONS.indexOf(collection);
        const version = versionIn(known[folderOf(collection, row[ROW.obsId])], row[ROW.obsId], row[ROW.det]);
        if (!version) { unresolved += 1; continue; }
        if (!versionIndex.has(version)) { versionIndex.set(version, versions.length); versions.push(version); }
        row[ROW.ver] = versionIndex.get(version);
        reach = Math.max(reach, footprintReach(row[ROW.corners], row[ROW.ra], row[ROW.dec]));
        counts[collection] += 1;
        rows += 1;
        lastMjd = Math.max(lastMjd, row[ROW.mjd]);
        if (!cells.has(tile)) cells.set(tile, []);
        cells.get(tile).push(row);
      }
    }
    for (const [tile, list] of cells) {
      const band = tile.split('-')[0];
      await mkdir(join(staging, band), { recursive: true });
      list.sort((a, b) => a[ROW.mjd] - b[ROW.mjd]);
      await writeFile(join(staging, band, `${tile}.json.gz`), gzipSync(JSON.stringify(list), { level: 9 }));
      tiles += 1;
    }
    log(`  bands ${lo}–${hi - 1}: ${cells.size} cells`);
  }

  const bytes = await dirBytes(staging);
  if (bytes > MAX_BYTES) {
    throw new Error(`the packed index is ${(bytes / 1024 ** 3).toFixed(2)} GB, over the 1.5 GB limit; left in ${staging}`);
  }
  const meta = {
    format: 1,
    builtAt: new Date().toISOString(),
    // The newest exposure the index holds: what "the index of <date>" means.
    lastExposure: new Date((lastMjd - 40587) * 86400000).toISOString(),
    fetchedThroughMjd: last,
    tileDeg: TILE_DEG,
    reachDeg: Number((reach + 0.01).toFixed(3)),
    collections: COLLECTIONS,
    versions,
    counts,
    rows,
    unresolved,
    tiles,
    bytes,
  };
  await rm(join(opts.dir, 'tiles.old'), { recursive: true, force: true });
  if (await exists(join(opts.dir, 'tiles'))) await rename(join(opts.dir, 'tiles'), join(opts.dir, 'tiles.old'));
  await rename(staging, join(opts.dir, 'tiles'));
  await writeFile(join(opts.dir, 'meta.json'), JSON.stringify(meta, null, 1));
  await rm(join(opts.dir, 'tiles.old'), { recursive: true, force: true });
  log(`index: ${rows} frames in ${tiles} cells, ${(bytes / 1024 ** 2).toFixed(1)} MB; ${unresolved} frames with no file on the mirror left out`);
  return meta;
}

/* -------------------------------------------------------------- estimating */

async function estimate(opts) {
  const t0 = opts.from;
  log(`one week, MJD ${t0}–${t0 + opts.days}`);
  const began = Date.now();
  const chunk = await fetchChunk(t0, t0 + opts.days, opts.source);
  const seconds = (Date.now() - began) / 1000;
  const packed = gzipSync(JSON.stringify(chunk.rows), { level: 9 }).length;
  const perRow = packed / Math.max(1, chunk.rows.length);
  log(`${chunk.rows.length} frames in ${seconds.toFixed(0)} s, ${packed} bytes packed: ${perRow.toFixed(1)} bytes a frame`);
  log('counting the whole table at IRSA (a full scan: a few minutes)');
  const counts = await irsaCounts();
  const total = COLLECTIONS.reduce((sum, c) => sum + (counts[c] ?? 0), 0);
  const weeks = chunkStarts(opts).length;
  // Each cell file also costs a disk block: about 10 000 cells of 4 KB.
  const onDisk = total * perRow + 10_000 * 4096;
  console.log(JSON.stringify({
    counts, total, bytesPerFrame: Number(perRow.toFixed(1)),
    estimatedIndexMB: Number((onDisk / 1024 ** 2).toFixed(0)),
    weeks, estimatedHours: Number(((weeks * (seconds + opts.pause)) / 3600).toFixed(1)),
    underLimit: onDisk < MAX_BYTES,
  }, null, 1));
}

async function verify(opts) {
  const counts = await irsaCounts();
  const meta = JSON.parse(await readFile(join(opts.dir, 'meta.json'), 'utf8'));
  for (const c of COLLECTIONS) console.log(`${c}: IRSA ${counts[c] ?? 0}, index ${meta.counts[c] ?? 0}`);
}

/* -------------------------------------------------------------------- run */

const opts = options(process.argv.slice(2));
try {
  if (opts.estimate) await estimate(opts);
  else if (opts.verify) await verify(opts);
  else {
    if (!opts.packOnly) await fetchMissing(opts);
    await pack(opts);
  }
} catch (err) {
  console.error(`stopped: ${err.message}`);
  process.exitCode = 1;
}

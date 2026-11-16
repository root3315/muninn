/**
 * server.js — static host plus the one proxy the browser cannot do without.
 *
 * Image data never passes through here. SPHEREx frames come from the public
 * `nasa-irsa-spherex` S3 mirror, which answers Range requests with
 * `Access-Control-Allow-Origin: *`, so the browser reads them directly.
 *
 * What the browser cannot reach is IRSA's Simple Image Access service — the index
 * that says which frames cover a position. IRSA sends no CORS headers at all, so
 * that call is relayed here, parsed into plain JSON, and cached on disk.
 *
 * Two more NASA services send no CORS headers either, and are relayed the same
 * way: IRSA's TAP service, for the Gaia, AllWISE, CatWISE2020 and 2MASS
 * catalogues (/api/tap), and JPL's Small-Body Identification service, for the
 * known asteroids and comets in a field at a moment (/api/sbident). Neither
 * takes a query from the page: the relay writes it from a fixed template and
 * checked numbers. The search box's asteroid and comet names go to JPL's
 * Small-Body Database and Horizons the same way (/api/smallbody): the relay
 * reads a designation out of the text and asks only for that. A marked
 * body's orbit comes from the same database (/api/sbdb), asked by the
 * designation SkyBoT or JPL gave it, and the bodies on nearly the same orbit
 * from its query service (/api/sbdb-near), asked by three checked numbers.
 *
 * No dependencies. `node server.js` and open the address it prints.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { brotliCompress, gzip, gunzip, constants as zlib } from 'node:zlib';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, stat, readdir, unlink } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVOTable } from './public/js/votable.js';
import { frameFromRow } from './public/js/catalog.js';
import { COLLECTIONS } from './public/js/release.js';
import { parseCsv } from './public/js/csv.js';
import { CATALOGUES, ROW_CAP, coneQuery, renameRow, mastGaiaRows, columnsTag } from './public/js/overlay.js';
import { sbIdentUrl, parseSbIdent } from './public/js/sbident.js';
import { smallBodyQuery, SBDB_TEXT, sbdbUrl, readSbdb, horizonsUrl, readHorizons } from './public/js/smallbody.js';
import { sbdbOrbitUrl, readOrbit, nearBox, nearQueryUrl, readNear, NEAR_ROWS } from './public/js/orbit.js';
import { archivesQuery, neossatQuery, neossatFilesQuery, readNeossat, ARCHIVE_RADIUS } from './public/js/archives.js';
import {
  ROW, searchIndex, footprintMeetsCone, frameFromIndexRow, indexRowFromObscore, capLikeIrsa,
  s3List, folderOf, folderVersions, versionIn,
} from './public/js/frameindex.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const CACHE = process.env.MUNINN_CACHE_DIR || join(ROOT, '.cache');
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';
/** Where the frame search asks. Only a test points it anywhere else. */
const FRAME_SIA = process.env.MUNINN_SIA_URL || SIA;
const IRSA_TAP = 'https://irsa.ipac.caltech.edu/TAP/sync';
/** Where the frame search's second route, IRSA's ObsCore table over TAP, asks; "off" for none. */
const FRAME_TAP = process.env.MUNINN_TAP_URL || IRSA_TAP;
/** The public S3 mirror, read for the processing version that names a frame's file. */
const S3_MIRROR = process.env.MUNINN_S3_URL || 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';
/** Muninn's own frame index (tools/build-frame-index.mjs), kept outside the app's folder in production. */
const INDEX_DIR = process.env.MUNINN_INDEX_DIR || join(ROOT, '.index');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** A duration from the environment, for the tests; the default otherwise. */
function envMs(name, fallback) {
  const value = Number(process.env[name]);
  return process.env[name] && Number.isFinite(value) && value >= 0 ? value : fallback;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A frame list changes when IRSA publishes data, not by the hour, so a list
 * is taken as current for three days. Past that it is still served at once
 * and asked about again behind the visitor's back.
 */
const SEARCH_FRESH_MS = envMs('MUNINN_SEARCH_FRESH_MS', 3 * DAY_MS);
/** And kept for a month, so that IRSA being down for a day costs nobody a list. */
const SEARCH_KEEP_MS = 30 * DAY_MS;
/** The waits before the second and third ask when IRSA's gateway says 502, 503 or 504, or a question times out. */
const SEARCH_RETRY_WAITS_MS = (process.env.MUNINN_RETRY_MS || '1000,3000').split(',').map(Number).filter(Number.isFinite);
/** The longest one ask may take, so that a timed-out first ask leaves room for another. */
const SEARCH_ATTEMPT_MS = envMs('MUNINN_ATTEMPT_MS', 100_000);
/**
 * How long the SIA may keep a visitor waiting before the own index answers in
 * its place (the SIA keeps going behind, and its list is kept for the next
 * ask), and, with no own index, before IRSA's TAP is asked as well.
 */
const INDEX_AFTER_MS = envMs('MUNINN_INDEX_AFTER_MS', 15_000);
const TAP_AFTER_MS = envMs('MUNINN_TAP_AFTER_MS', 40_000);
/** IRSA's ObsCore cone takes 35–50 s; past this it is not coming in time for the page. */
const TAP_SEARCH_MS = envMs('MUNINN_TAP_SEARCH_MS', 100_000);
/** A retry is not started with less than this left of the deadline. */
const SEARCH_MIN_LEFT_MS = 5_000;
/** Background refreshes at once (two fields of four collections), and the pause after one failed before the same list is asked about again. */
const REFRESH_MAX = 8;
const REFRESH_PAUSE_MS = envMs('MUNINN_REFRESH_PAUSE_MS', 5 * 60 * 1000);
/** When a collection that failed with nothing kept is asked again in the background, and for how many positions at once. */
const RETRY_LATER_MS = (process.env.MUNINN_RETRY_LATER_MS || '15000,60000,180000').split(',').map(Number).filter(Number.isFinite);
const RETRY_LATER_MAX = 64;
/** The most the answer cache may hold on disk. */
const CACHE_MAX_BYTES = 300 * 1024 * 1024;
/** IRSA's TAP answers a cone in 7–30 s; well past that, it is not coming. */
const TAP_TIMEOUT_MS = 75_000;
/** JPL's second pass takes 20–70 s on a crowded ecliptic field. */
const SBIDENT_TIMEOUT_MS = 120_000;
/**
 * A position the archive has not seen before routinely takes 70 s or more. The
 * answer keeps its connection alive while it waits (see answerSlowly), so
 * waiting longer costs nothing but the wait.
 */
const UPSTREAM_TIMEOUT_MS = 150_000;

/**
 * Without a cap, a cone on the deep fields returns 25 000 rows and 54 MB, and
 * takes four minutes. MAXREC keeps it near ten seconds; the truncation is
 * reported back to the page rather than hidden.
 */
const MAXREC = 500;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.webm': 'video/webm',
};

/**
 * The security headers, read from the same file Cloudflare Pages reads, so the
 * policy is written once: the block under "/*" in public/_headers.
 */
function readSecurityHeaders() {
  const out = {};
  let inAll = false;
  let text = '';
  try { text = readFileSync(join(PUBLIC, '_headers'), 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { inAll = line.trim() === '/*'; continue; }
    const at = line.indexOf(':');
    if (inAll && at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

const SECURITY_HEADERS = readSecurityHeaders();

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'cache-control': 'no-cache', ...SECURITY_HEADERS, ...headers });
  res.end(body);
};

const json = (res, code, value, headers = {}) =>
  send(res, code, JSON.stringify(value), { 'content-type': TYPES['.json'], ...headers });

/**
 * A frame list that is whole — from the bake, or from the cache, where only
 * whole answers are kept — may be kept by the browser (and by an edge told to)
 * for an hour: the archive adds frames with a data release, not by the hour.
 * Reopening a field, or a second visitor through a cache, then costs no trip
 * to the relay. An answer still being worked out, or one that failed, is not
 * kept.
 */
const KEEP_FRAME_LIST = { 'cache-control': 'public, max-age=3600' };

/** A whole answer from the server's own cache: the browser may keep it for five minutes. Errors never get it. */
const KEEP_PRIVATE = { 'cache-control': 'private, max-age=300' };

/**
 * A fetch whose deadline covers the body as well as the headers: an archive
 * that sends headers and then stalls would otherwise hold its slot until the
 * process restarted.
 */
function withTimeout(url, ms) {
  return fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'Muninn/1.0 (NASA Space Apps 2026)' } });
}

/* ------------------------------------------------------------------- caching */

const memory = new Map();
/** Answers kept in memory; the disk keeps the rest. Oldest out first. */
const MEMORY_MAX = 256;
/**
 * And no more than this many bytes of them (as JSON text): a deep field's
 * frame list is near half a megabyte, and 256 of those would be most of a
 * small box's memory.
 */
const MEMORY_MAX_BYTES = envMs('MUNINN_MEMORY_MAX_BYTES', 48 * 1024 * 1024);
let memoryBytes = 0;

const safeKey = (text) => text.replace(/[^\w.-]/g, '_');
/** One collection's frame list at one position. */
const framesKey = (collection, ra, dec, radius) =>
  safeKey(`frames_${collection}_${ra.toFixed(4)}_${dec.toFixed(4)}_${radius.toFixed(4)}`);

/**
 * The kept answer under `key` and when it was kept, or null when there is none
 * younger than `keepMs`.
 */
async function readEntry(key, keepMs) {
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < keepMs) return hit;
  try {
    const file = join(CACHE, `${key}.json`);
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > keepMs) return null;
    const text = await readFile(file, 'utf8');
    const entry = { at: info.mtimeMs, value: JSON.parse(text), bytes: text.length };
    remember(key, entry);
    return entry;
  } catch {
    return null;
  }
}

async function readCache(key) {
  return (await readEntry(key, CACHE_TTL_MS))?.value ?? null;
}

function forget(key) {
  const gone = memory.get(key);
  if (!gone) return;
  memoryBytes -= gone.bytes ?? 0;
  memory.delete(key);
}

function remember(key, entry) {
  forget(key);
  memory.set(key, entry);
  memoryBytes += entry.bytes ?? 0;
  while (memory.size > MEMORY_MAX || (memoryBytes > MEMORY_MAX_BYTES && memory.size > 1)) forget(memory.keys().next().value);
}

async function writeCache(key, value) {
  const text = JSON.stringify(value);
  remember(key, { at: Date.now(), value, bytes: text.length });
  try {
    await mkdir(CACHE, { recursive: true });
    await writeFile(join(CACHE, `${key}.json`), text, 'utf8');
  } catch {
    /* a cold cache is slower, not broken */
  }
}

/* --------------------------------------------------------------- baked fields */

/**
 * Frame indexes for the opening fields, resolved ahead of time by
 * tools/bake-targets.mjs. A visitor's first field opens without waiting on a
 * cone search, and the demo survives IRSA being slow or unreachable.
 */
const baked = [];

async function loadBakedFields() {
  const dir = join(PUBLIC, 'data', 'fields');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const field = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (Number.isFinite(field.ra) && Array.isArray(field.frames)) {
        baked.push({ key: name.replace(/\.json$/, ''), ...field });
      }
    } catch (err) {
      console.warn(`  skipped public/data/fields/${name}: ${err.message}`);
    }
  }
}

/** Angular match, so a link that rounds the coordinates still hits the index. */
function findBaked(ra, dec) {
  const cos = Math.cos((dec * Math.PI) / 180);
  return baked.find((f) => Math.hypot((f.ra - ra) * cos, f.dec - dec) < 0.01);
}

/* -------------------------------------------------------------------- search */

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

async function queryCollectionOnce(collection, ra, dec, radius, ms) {
  const pos = encodeURIComponent(`circle ${ra} ${dec} ${radius}`);
  const res = await withTimeout(`${FRAME_SIA}?COLLECTION=${collection}&POS=${pos}&MAXREC=${MAXREC}`, ms);
  if (!res.ok) throw Object.assign(new Error(`IRSA ${collection}: HTTP ${res.status}`), { status: res.status });
  const text = await res.text();
  // A maintenance page sent as 200, or a table cut off part-way, reads as a
  // table with no rows: kept, that would be "no frames here" for days. It is
  // a failed question instead, asked again like a dropped connection.
  if (!/<\/(?:\w+:)?VOTABLE>\s*$/i.test(text)) throw new Error(`IRSA ${collection}: not a whole VOTable`);
  const { status, message, rows } = parseVOTable(text);
  if (status === 'ERROR') throw Object.assign(new Error(`IRSA ${collection}: ${message}`), { status: 200 });
  return { rows, truncated: status === 'OVERFLOW' };
}

/**
 * Worth asking again: IRSA's gateway in front of a busy service (502, 503,
 * 504), a question that timed out, or a connection dropped part-way. An
 * answer that says no (another HTTP error, a VOTable error) is final.
 */
const worthRetry = (err) => err.status === undefined || [502, 503, 504].includes(err.status);

/**
 * One collection asked, up to twice more on a failure worth retrying, with a
 * growing wait between asks. Every ask gets what is left of one deadline, so
 * the whole lot ends before the page stops waiting.
 */
async function queryCollection(collection, ra, dec, radius) {
  const until = Date.now() + UPSTREAM_TIMEOUT_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await queryCollectionOnce(collection, ra, dec, radius, Math.min(SEARCH_ATTEMPT_MS, until - Date.now()));
    } catch (err) {
      const wait = SEARCH_RETRY_WAITS_MS[attempt];
      if (!worthRetry(err) || wait === undefined || until - Date.now() - wait < SEARCH_MIN_LEFT_MS) throw err;
      await sleep(wait);
    }
  }
}

/** The frames the page can use out of IRSA's rows: calibrated science images. */
function framesFromRows(rows) {
  const frames = [];
  for (const row of rows) {
    if (row.dataproduct_subtype !== 'science') continue;
    if (Number(row.calib_level) < 2) continue;
    const frame = frameFromRow(row);
    if (frame?.url) frames.push(frame);
  }
  return frames;
}

/** Collection questions out at IRSA, by cache key: a second asker joins the first. */
const upstream = new Map();

/** Ask IRSA for one collection's list, and keep the answer. */
function fetchCollection(collection, ra, dec, radius) {
  const key = framesKey(collection, ra, dec, radius);
  let pending = upstream.get(key);
  if (!pending) {
    pending = queryCollection(collection, ra, dec, radius)
      .then(async ({ rows, truncated }) => {
        const value = { frames: framesFromRows(rows), truncated };
        await writeCache(key, value);
        return { at: Date.now(), value };
      })
      .finally(() => upstream.delete(key));
    upstream.set(key, pending);
  }
  return pending;
}

let refreshing = 0;
const refreshFailed = new Map();

/**
 * A kept list past its three days is asked about again in the background,
 * never while a visitor waits. A failed refresh leaves the kept list as it
 * was and is not tried again for a few minutes, so an IRSA outage is not
 * asked about by every page that opens.
 */
function refreshInBackground(collection, ra, dec, radius) {
  const key = framesKey(collection, ra, dec, radius);
  if (upstream.has(key) || refreshing >= REFRESH_MAX) return;
  if (Date.now() - (refreshFailed.get(key) ?? 0) < REFRESH_PAUSE_MS) return;
  refreshing += 1;
  fetchCollection(collection, ra, dec, radius)
    .then(() => refreshFailed.delete(key), () => {
      refreshFailed.set(key, Date.now());
      if (refreshFailed.size > 1000) refreshFailed.delete(refreshFailed.keys().next().value);
    })
    .finally(() => { refreshing -= 1; });
}

/* --------------------------------------------------------- own frame index */

/**
 * Every SPHEREx frame's centre, footprint, time and band, fetched from IRSA
 * ahead of time by tools/build-frame-index.mjs and filed by 2° sky cell. When
 * IRSA does not answer, a cone search is answered from it, with IRSA's own
 * rule: a frame is listed when its footprint meets the circle.
 */
let ownIndex = null;
const indexCells = new Map();
/**
 * Cells read are kept in memory up to a byte ceiling, as the answer cache
 * is: a deep-field cell holds tens of thousands of frames, and the relay
 * runs on a small box.
 */
const INDEX_CELLS_MAX_BYTES = envMs('MUNINN_INDEX_CACHE_BYTES', 64 * 1024 * 1024);
let indexCellBytes = 0;
const gunzipCell = promisify(gunzip);

/** What a usable meta.json holds; anything less is no index at all. */
function indexMetaProblem(meta) {
  if (meta?.format !== 1) return 'not format 1';
  if (!Array.isArray(meta.collections) || !Array.isArray(meta.versions)) return 'no collections or versions';
  if (!Number.isFinite(meta.reachDeg) || meta.reachDeg <= 0 || meta.reachDeg > 10) return 'no frame reach';
  if (typeof meta.builtAt !== 'string' || Number.isNaN(Date.parse(meta.builtAt))) return 'no build date';
  if (!meta.counts || typeof meta.counts !== 'object') return 'no counts';
  return null;
}

let indexComplaint = '';

/** Said once per distinct problem, not every ten minutes. */
function complainAboutIndex(text) {
  if (text === indexComplaint) return;
  indexComplaint = text;
  console.warn(`  own frame index: ${text}`);
}

/**
 * The index's meta.json, read at start and every ten minutes. A missing
 * folder is no index; an unreadable or incomplete one (a copy cut short) is
 * no index and said in the log; the search then has IRSA's routes only.
 */
async function loadOwnIndex() {
  let meta;
  try {
    meta = JSON.parse(await readFile(join(INDEX_DIR, 'meta.json'), 'utf8'));
    await stat(join(INDEX_DIR, 'tiles'));
  } catch (err) {
    if (ownIndex) indexCells.clear();
    ownIndex = null;
    if (err.code !== 'ENOENT' || existsSync(INDEX_DIR)) complainAboutIndex(`not usable in ${INDEX_DIR} (${err.code ?? err.message})`);
    return;
  }
  const problem = indexMetaProblem(meta);
  if (problem) {
    ownIndex = null;
    complainAboutIndex(`meta.json in ${INDEX_DIR}: ${problem}`);
    return;
  }
  indexComplaint = '';
  // A rebuilt index replaces the cells read from the one before.
  if (ownIndex?.meta.builtAt !== meta.builtAt) { indexCells.clear(); indexCellBytes = 0; }
  ownIndex = { meta };
}

/**
 * One sky cell's rows, from memory or from disk. A cell with no file has no
 * frames (the build writes no empty cells). A file that cannot be read (cut
 * short, not gzip, not JSON) fails the own-index route for this question,
 * logged, and is not kept: the search goes on to IRSA's TAP.
 */
const cellsReading = new Map();

/** A cell asked for by four collections at once is read once. */
function readCell(id) {
  let pending = cellsReading.get(id);
  if (!pending) {
    pending = readCellOnce(id).finally(() => cellsReading.delete(id));
    cellsReading.set(id, pending);
  }
  return pending;
}

async function readCellOnce(id) {
  let cell = indexCells.get(id);
  if (cell) {
    indexCells.delete(id);
  } else {
    let text = '[]';
    let rows;
    try {
      text = String(await gunzipCell(await readFile(join(INDEX_DIR, 'tiles', id.split('-')[0], `${id}.json.gz`))));
      rows = JSON.parse(text);
      if (!Array.isArray(rows) || rows.some((r) => !Array.isArray(r) || !Array.isArray(r[ROW.corners]))) throw new Error('not a list of frames');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`  own frame index: cell ${id} unreadable (${err.code ?? err.message})`);
        throw new Error(`cell ${id} unreadable`);
      }
      rows = [];
    }
    // Parsed rows take a few times their JSON's length.
    cell = { rows, bytes: text.length * 3 };
    indexCellBytes += cell.bytes;
  }
  indexCells.set(id, cell);
  while (indexCellBytes > INDEX_CELLS_MAX_BYTES && indexCells.size > 1) {
    const oldest = indexCells.keys().next().value;
    indexCellBytes -= indexCells.get(oldest).bytes;
    indexCells.delete(oldest);
  }
  return cell.rows;
}

const indexHolds = (collection) => (ownIndex?.meta.counts?.[collection] ?? 0) > 0;

/** One collection's frames at a position, from the own index, capped as IRSA caps them. */
async function indexAnswer(collection, ra, dec, radius) {
  const frames = await searchIndex(readCell, ownIndex.meta, collection, ra, dec, radius);
  const capped = capLikeIrsa(frames, MAXREC);
  return { frames: capped, truncated: capped.length < frames.length };
}

/* ------------------------------------------------- IRSA's TAP, second route */

/** Week folder → its processing version on the S3 mirror, read once each. */
const folderVersionsKnown = new Map();

function versionsOf(folder) {
  let pending = folderVersionsKnown.get(folder);
  if (!pending) {
    pending = folderVersions(folder, (prefix, opts) => s3List(prefix, { ...opts, base: S3_MIRROR, timeoutMs: 15_000 }));
    pending.catch(() => folderVersionsKnown.delete(folder));
    folderVersionsKnown.set(folder, pending);
  }
  return pending;
}

const OBSCORE_COLUMNS = 'obs_id,obs_collection,energy_bandpassname,em_min,em_max,t_min,t_exptime,s_ra,s_dec,s_region';
/** The farthest a frame's corner lies from its centre (3.5° square frames), with a margin. */
const FRAME_REACH_DEG = 2.6;

/**
 * One collection's frames from IRSA's ObsCore table: every frame centred
 * within reach, then IRSA's footprint rule applied here. The table names a
 * DataLink page, not the file, so the file's processing version is read from
 * the S3 mirror's week folder.
 */
async function tapCollection(collection, ra, dec, radius) {
  const reach = (ownIndex?.meta.reachDeg ?? FRAME_REACH_DEG) + radius;
  const query = `SELECT ${OBSCORE_COLUMNS} FROM spherex.obscore WHERE obs_collection = '${collection}' `
    + `AND CONTAINS(POINT('ICRS', s_ra, s_dec), CIRCLE('ICRS', ${ra}, ${dec}, ${reach.toFixed(4)})) = 1`;
  const res = await fetch(FRAME_TAP, {
    method: 'POST',
    headers: { 'user-agent': 'Muninn/1.0 (NASA Space Apps 2026)' },
    body: new URLSearchParams({ LANG: 'ADQL', FORMAT: 'csv', QUERY: query }),
    signal: AbortSignal.timeout(TAP_SEARCH_MS),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  if (text.trimStart().startsWith('<')) throw new Error(/QUERY_STATUS" value="ERROR">([^<]*)/.exec(text)?.[1]?.trim() || 'not a table');

  const meta = { collections: COLLECTIONS };
  const rows = parseCsv(text)
    .map((row) => indexRowFromObscore(row, COLLECTIONS, -1))
    .filter((row) => row && footprintMeetsCone(row[ROW.corners], ra, dec, radius));
  const frames = [];
  for (const row of rows) {
    const version = versionIn(await versionsOf(folderOf(collection, row[ROW.obsId])), row[ROW.obsId], row[ROW.det]);
    if (version) frames.push(frameFromIndexRow(row, meta, version));
  }
  const capped = capLikeIrsa(frames, MAXREC);
  const value = { frames: capped, truncated: capped.length < frames.length };
  await writeCache(framesKey(collection, ra, dec, radius), value);
  return value;
}

/* --------------------------------------------------------- the answer */

/**
 * The first of several routes to answer. A route is started when the one
 * before it fails, or has kept the page waiting its `patience`; a route
 * started never stops the ones before it, so the slower of two can still
 * win. Fails, with every route's reason, only when all have failed.
 */
function firstAnswer(routes) {
  return new Promise((resolve, reject) => {
    const reasons = [];
    let next = 0;
    let running = 0;
    let done = false;
    let timer = null;
    const startNext = () => {
      clearTimeout(timer);
      if (done) return;
      if (next >= routes.length) {
        if (!running) { done = true; reject(new Error(reasons.join('; '))); }
        return;
      }
      const route = routes[next];
      next += 1;
      running += 1;
      route.ask().then((value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ source: route.name, value });
      }, (err) => {
        running -= 1;
        reasons.push(route.name === 'irsa' ? err.message : `${route.name}: ${err.message}`);
        startNext();
      });
      if (next < routes.length && Number.isFinite(route.patience)) timer = setTimeout(startNext, route.patience);
    };
    startNext();
  });
}

/**
 * One collection's part of the answer: the kept list if there is one, however
 * old (refreshed behind the scenes once it is past its days); else the first
 * to answer of IRSA's SIA, the own index (when SIA fails or is slow) and
 * IRSA's TAP (when there is no own index for the collection); else the
 * reasons there is none.
 */
async function collectionAnswer(collection, ra, dec, radius) {
  const kept = await readEntry(framesKey(collection, ra, dec, radius), SEARCH_KEEP_MS);
  if (kept) {
    const age = Date.now() - kept.at;
    const stale = age >= SEARCH_FRESH_MS;
    if (stale) refreshInBackground(collection, ra, dec, radius);
    return { collection, ...kept.value, cached: true, staleMs: stale ? age : 0, source: 'irsa' };
  }
  const sia = fetchCollection(collection, ra, dec, radius).then(({ value }) => value);
  // Whoever answers the page, a SIA that fails is asked again behind it.
  sia.catch(() => retryInBackground(collection, ra, dec, radius));

  const routes = [];
  if (indexHolds(collection)) {
    routes.push({ name: 'irsa', ask: () => sia, patience: INDEX_AFTER_MS });
    routes.push({ name: 'own-index', ask: () => indexAnswer(collection, ra, dec, radius) });
  } else {
    routes.push({ name: 'irsa', ask: () => sia, patience: TAP_AFTER_MS });
  }
  if (FRAME_TAP !== 'off') routes.push({ name: 'irsa-tap', ask: () => tapCollection(collection, ra, dec, radius) });
  try {
    const { source, value } = await firstAnswer(routes);
    return { collection, ...value, cached: false, staleMs: 0, source };
  } catch (err) {
    return { collection, error: err.message };
  }
}

const retrying = new Set();

/**
 * A collection that failed with nothing kept is asked again in the
 * background, a few times further apart, so that the page's own second ask
 * for the missing part finds it kept, or joins a question already out.
 */
function retryInBackground(collection, ra, dec, radius, step = 0) {
  const key = framesKey(collection, ra, dec, radius);
  if (step === 0 && (retrying.has(key) || retrying.size >= RETRY_LATER_MAX)) return;
  const wait = RETRY_LATER_MS[step];
  if (wait === undefined) { retrying.delete(key); return; }
  retrying.add(key);
  setTimeout(() => {
    fetchCollection(collection, ra, dec, radius)
      .then(() => retrying.delete(key), () => retryInBackground(collection, ra, dec, radius, step + 1));
  }, wait).unref();
}

/** Whether every collection asked about has a kept list, so the answer needs no wait. */
async function allKept(collections, ra, dec, radius) {
  const kept = await Promise.all(collections.map((c) => readEntry(framesKey(c, ra, dec, radius), SEARCH_KEEP_MS)));
  return kept.every(Boolean);
}

/**
 * Which frames cover a position, collection by collection. Each collection is
 * kept on its own, so one that did not answer is asked again alone: the
 * answer names it in `missing`, and `?collections=` asks for just those.
 */
async function lookup(ra, dec, radius, collections) {
  const parts = await Promise.all(collections.map((c) => collectionAnswer(c, ra, dec, radius)));
  const answered = parts.filter((p) => !p.error);
  const missing = parts.filter((p) => p.error).map((p) => p.collection);
  const warnings = parts.filter((p) => p.error).map((p) => `${p.collection}: ${p.error}`);

  const seen = new Set();
  const frames = [];
  for (const frame of answered.flatMap((p) => p.frames)) {
    if (seen.has(frame.url)) continue;
    seen.add(frame.url);
    frames.push(frame);
  }
  frames.sort((a, b) => a.mjd - b.mjd);

  const queried = { ra, dec, radius, collections };
  // Nothing found while part of the archive did not answer is not "nothing
  // here": it is a question that did not get asked. Said as a failure.
  if (!answered.length || (!frames.length && missing.length)) {
    return { ok: false, error: warnings.join('; '), partial: answered.length > 0, missing, queried };
  }
  const staleMs = Math.max(0, ...answered.map((p) => p.staleMs));
  // Said when any part did not come from IRSA's SIA: the own index (with the
  // day it was built), or IRSA's TAP.
  const sources = new Set(answered.map((p) => p.source));
  const source = ['own-index', 'irsa-tap'].find((s) => sources.has(s)) ?? 'irsa';
  return {
    ok: true,
    source,
    ...(source === 'own-index' ? {
      indexDate: ownIndex.meta.builtAt,
      fromIndex: answered.filter((p) => p.source === 'own-index').map((p) => p.collection),
    } : {}),
    cached: answered.every((p) => p.cached),
    frames,
    truncated: answered.some((p) => p.truncated),
    partial: missing.length > 0,
    missing,
    warnings,
    stale: staleMs > 0,
    staleAgeS: Math.round(staleMs / 1000),
    queried,
  };
}

/** Whether an address an archive's answer named is IRSA's own, over https. */
function isIrsaUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'irsa.ipac.caltech.edu';
  } catch {
    return false;
  }
}

/** Searches in flight, by cache key: asking again for the same field joins the first ask. */
const inflight = new Map();

/**
 * Stay audibly alive while the archive thinks. Through a tunnel or a proxy an
 * origin that sends nothing is cut off — Cloudflare gives up at 100 s — and a
 * position IRSA has not seen before can take longer than that. The cut came
 * back as the proxy's own HTML page, which the viewer took for "no relay
 * here". So the answer starts at once: status and headers now, then a space
 * every few seconds (JSON allows any amount of leading whitespace), then the
 * body. A failure is said in the body, as ok: false.
 */
async function answerSlowly(res, pending) {
  res.writeHead(200, { 'cache-control': 'no-cache', ...SECURITY_HEADERS, 'content-type': TYPES['.json'] });
  res.write(' ');
  const beat = setInterval(() => res.write(' '), 10_000);
  res.on('close', () => clearInterval(beat));
  let body;
  try {
    body = await pending;
  } catch (err) {
    body = { ok: false, error: err.message };
  } finally {
    clearInterval(beat);
  }
  res.end(JSON.stringify(body));
}

/**
 * Questions out at once, per kind of question. One pool for all of them let
 * a single page's ephemeris questions (one per visit, each up to a minute at
 * JPL) fill every slot, and then the frame search answered "busy" to
 * everyone. Each kind now waits only behind its own.
 */
const POOL_MAX = { search: 6, catalog: 8, jpl: 3, wise: 3, names: 3 };
const pools = Object.fromEntries(Object.keys(POOL_MAX).map((k) => [k, new Set()]));

/**
 * A question for an archive, answered from the cache, by joining the same
 * question already out, or by asking. `ask` caches its own answer, since only
 * it knows whether the answer is whole.
 */
async function relay(res, key, ask, pool = 'catalog', keep = KEEP_PRIVATE) {
  const cached = await readCache(key);
  if (cached) return json(res, 200, { ok: true, cached: true, ...cached }, keep);

  let pending = inflight.get(key);
  if (!pending && pools[pool].size >= POOL_MAX[pool]) {
    return json(res, 503, { ok: false, error: 'The archive relay is busy with other questions; try again in a moment.' });
  }
  if (!pending) {
    pools[pool].add(key);
    pending = ask().finally(() => { inflight.delete(key); pools[pool].delete(key); });
    inflight.set(key, pending);
  }
  return answerSlowly(res, pending);
}

/**
 * A number from the query string. Number(null) and Number('') are both 0: an
 * absent coordinate would otherwise be a query at the vernal equinox.
 */
const PLAIN_DECIMAL = /^[+-]?\d+(\.\d+)?$/;

function param(url, name) {
  const raw = url.searchParams.get(name)?.trim();
  return raw && PLAIN_DECIMAL.test(raw) ? Number(raw) : NaN;
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** The position asked about, or null when it is not one on the sky. */
function position(url) {
  const ra = param(url, 'ra');
  const dec = param(url, 'dec');
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 360 || Math.abs(dec) > 90) return null;
  return { ra, dec };
}

const BAD_POSITION = { ok: false, error: 'ra must be 0–360 and dec −90–90' };

async function handleSearch(url, res) {
  const at = position(url);
  if (!at) return json(res, 400, BAD_POSITION);
  const { ra, dec } = at;
  // A SPHEREx frame is about 3.5° across, so a near-point cone already finds every
  // frame that can cover the field — and a wider cone costs the archive dearly.
  const radius = Math.min(0.03, Math.max(0.002, Number(url.searchParams.get('radius')) || 0.006));

  const collections = askedCollections(url);
  if (!collections) return json(res, 400, BAD_COLLECTIONS);

  const prebaked = findBaked(ra, dec);
  if (prebaked) {
    return json(res, 200, {
      ok: true, cached: 'baked',
      frames: prebaked.frames.filter((f) => collections.includes(f.collection)),
      truncated: Boolean(prebaked.truncated), partial: false, missing: [], warnings: [],
      stale: false, staleAgeS: 0, queried: { ra, dec, radius, collections },
    }, KEEP_FRAME_LIST);
  }

  // Every part kept, however old: answered at once, never behind IRSA.
  if (await allKept(collections, ra, dec, radius)) {
    const body = await lookup(ra, dec, radius, collections);
    return json(res, 200, body, searchHeaders(body));
  }

  const key = `search_${collections.join(',')}_${framesKey('', ra, dec, radius)}`;
  let pending = inflight.get(key);
  if (!pending && pools.search.size >= POOL_MAX.search) {
    // Said as busy, with when to come back, so a page can ask again by itself
    // rather than call the archive down.
    return json(res, 503, {
      ok: false, busy: true, retryAfterS: 5, missing: collections,
      error: 'The archive relay is busy with other questions; try again in a moment.',
    }, { 'retry-after': '5' });
  }
  if (!pending) {
    pools.search.add(key);
    pending = lookup(ra, dec, radius, collections).finally(() => { inflight.delete(key); pools.search.delete(key); });
    inflight.set(key, pending);
  }
  return answerSlowly(res, pending);
}

/**
 * The collections a search asks about: all of them, or the ones named in
 * `?collections=` (comma-separated), which is how a page asks again for only
 * the parts an earlier answer listed as missing. Null for an unknown name.
 */
function askedCollections(url) {
  const raw = url.searchParams.get('collections');
  if (raw === null || raw.trim() === '') return COLLECTIONS;
  const names = [...new Set(raw.split(',').map((n) => n.trim()))];
  return names.every((n) => COLLECTIONS.includes(n)) ? COLLECTIONS.filter((c) => names.includes(c)) : null;
}

const BAD_COLLECTIONS = { ok: false, error: `collections must be among ${COLLECTIONS.join(', ')}` };

/**
 * A whole, current list may be kept by the browser for an hour. A stale one is
 * served with its age (also in the body) and not kept, since a fresher one is
 * on its way; a partial one is not kept either.
 */
function searchHeaders(body) {
  if (!body.ok) return {};
  if (body.stale) return { 'x-muninn-stale-age': String(body.staleAgeS) };
  // IRSA's own list is on its way behind an answer from the own index.
  if (body.source === 'own-index') return {};
  return body.partial ? {} : KEEP_FRAME_LIST;
}

/* ------------------------------------------------------- catalogues at IRSA */

/**
 * Sources of one catalogue in a circle, from IRSA's TAP service.
 *
 *   cat   gaia | wise | catwise | twomass — the name of a template, nothing more
 *   r     radius in degrees, 1″ to 1° (a plate's overlay needs about 0.6°)
 *   top   the most rows, 1 to ROW_CAP + 1
 *   mag   optional: nothing fainter than this in the catalogue's own band
 *
 * Rows come back under the shared column names (see CATALOGUES in overlay.js),
 * every value as text, so the page parses IRSA's answer and VizieR's alike.
 */
async function handleTap(url, res) {
  const cat = url.searchParams.get('cat');
  const archive = Object.hasOwn(CATALOGUES, cat ?? '') ? CATALOGUES[cat].irsa : null;
  if (!archive) return json(res, 400, { ok: false, error: `cat must be one of ${Object.keys(CATALOGUES).join(', ')}` });
  const at = position(url);
  if (!at) return json(res, 400, BAD_POSITION);
  const radiusDeg = param(url, 'r');
  if (!Number.isFinite(radiusDeg)) return json(res, 400, { ok: false, error: 'r (degrees) is required' });

  const field = {
    ...at,
    radiusDeg: clamp(radiusDeg, 1 / 3600, 1),
    top: clamp(Math.trunc(param(url, 'top')) || 9, 1, ROW_CAP + 1),
    limit: Number.isFinite(param(url, 'mag')) ? clamp(param(url, 'mag'), -2, 30) : null,
  };
  // Rounded before they become a key: a float that differs in the sixth
  // decimal is the same question, not a new file and a new archive query.
  if (field.limit !== null) field.limit = Math.round(field.limit * 2) / 2;
  field.radiusDeg = Math.max(1 / 3600, Number(field.radiusDeg.toPrecision(2)));
  // The columns asked for are part of the question: a list cached before a
  // column was added (AllWISE's cc_flags) is not an answer to the new one.
  const key = safeKey(`tap_${cat}${columnsTag(archive)}_${field.ra.toFixed(4)}_${field.dec.toFixed(4)}_${field.radiusDeg}_${field.top}_${field.limit ?? 'all'}`);
  // A star's own lookup is a few arcseconds: MAST usually answers in one or
  // two, and IRSA is asked as well only once MAST is late or has failed —
  // either can take twenty seconds on a bad day, rarely both, and asking IRSA
  // every time would double the queue the mark's other catalogues wait in.
  // A field's worth is megabytes at MAST, so the overlays stay with IRSA.
  const viaMast = cat === 'gaia' && field.radiusDeg <= MAST_MAX_DEG;
  return relay(res, key, () => (viaMast
    ? hedged(() => askMastGaia(field, key), () => askIrsaTap(archive, field, key), MAST_HEDGE_MS)
    : askIrsaTap(archive, field, key)));
}

/**
 * The first answer of two: `first` asked now, `second` once `first` has
 * failed or taken `ms` without answering. The first failure if neither answers.
 */
function hedged(first, second, ms) {
  return new Promise((resolve, reject) => {
    const errors = [];
    let started = 1;
    let timer = null;
    const fail = (err) => {
      errors.push(err);
      if (errors.length === started) {
        if (started === 1) startSecond();
        else reject(errors[0]);
      }
    };
    const startSecond = () => {
      if (started === 2) return;
      clearTimeout(timer);
      started = 2;
      second().then(resolve, fail);
    };
    first().then((value) => { clearTimeout(timer); resolve(value); }, fail);
    timer = setTimeout(startSecond, ms);
  });
}

/* --------------------------------------------- the headset's depth catalogues */

/**
 * What the headset's depth view needs besides Gaia, through the box, so it is
 * kept for days and still answered when the archives are down:
 *
 *   kind=bj        Bailer-Jones geometric distances (VizieR I/352), asked at
 *                  the CfA's VizieR mirror and at CDS's TAP at once
 *   kind=galaxies  SIMBAD's galaxies with a spectroscopic redshift, asked at
 *                  the CDS and CfA SIMBADs at once
 *
 * Only these, only at these hosts, only for a position and a radius: nothing
 * in the request names a host or a query. An answer is fresh for three days;
 * past that it is asked again, and if the archives fail the kept one is sent,
 * marked stale, for up to a month.
 */
const DEPTH_UPSTREAM = {
  vizierCfa: process.env.MUNINN_VIZIER_CFA_URL || 'https://vizier.cfa.harvard.edu/viz-bin/votable',
  vizierTap: process.env.MUNINN_VIZIER_TAP_URL || 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync',
  simbadCds: process.env.MUNINN_SIMBAD_CDS_URL || 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync',
  simbadCfa: process.env.MUNINN_SIMBAD_CFA_URL || 'https://simbad.cfa.harvard.edu/simbad/sim-tap/sync',
};
const DEPTH_FRESH_MS = 3 * 24 * 3600 * 1000;
const DEPTH_KEEP_MS = 30 * 24 * 3600 * 1000;
const DEPTH_TIMEOUT_MS = Number(process.env.MUNINN_DEPTH_TIMEOUT_MS) || 40_000;
const DEPTH_KINDS = new Set(['bj', 'galaxies']);
const depthInflight = new Map();

async function handleDepth(url, res) {
  const kind = url.searchParams.get('kind') ?? '';
  if (!DEPTH_KINDS.has(kind)) return json(res, 400, { ok: false, error: 'kind must be bj or galaxies' });
  const at = position(url);
  if (!at) return json(res, 400, BAD_POSITION);
  const radius = param(url, 'r');
  if (!Number.isFinite(radius)) return json(res, 400, { ok: false, error: 'r (degrees) is required' });
  const field = { ...at, radiusDeg: Number(clamp(radius, 0.005, 1).toPrecision(2)) };
  const key = safeKey(`depth_${kind}_${field.ra.toFixed(4)}_${field.dec.toFixed(4)}_${field.radiusDeg}`);
  const kept = await readEntry(key, DEPTH_KEEP_MS);
  if (kept && Date.now() - kept.at < DEPTH_FRESH_MS) return json(res, 200, { ok: true, cached: true, ...kept.value });
  let pending = depthInflight.get(key);
  if (!pending) {
    pending = (kind === 'bj' ? askDistances(field) : askGalaxies(field)).finally(() => depthInflight.delete(key));
    depthInflight.set(key, pending);
  }
  try {
    const value = await pending;
    await writeCache(key, value);
    return json(res, 200, { ok: true, cached: false, ...value });
  } catch (err) {
    // The archives down: what was kept, however old, rather than nothing.
    if (kept) return json(res, 200, { ok: true, cached: true, stale: true, staleAgeS: Math.round((Date.now() - kept.at) / 1000), ...kept.value });
    return json(res, 502, { ok: false, error: String(err.message ?? err) });
  }
}

/** The first of several answers; the first failure if none comes. */
async function firstOf(asks) {
  try {
    return await Promise.any(asks);
  } catch (err) {
    throw err.errors?.[0] ?? err;
  }
}

/** Bailer-Jones distances in a cone, nearest the centre first: rows [source_id, r, lo, hi] in parsecs. */
function askDistances({ ra, dec, radiusDeg }) {
  const read = (rows) => rows
    .filter((row) => Number(row.rgeo) > 0)
    .slice(0, 2000)
    .map((row) => [String(row.Source).trim(), Number(row.rgeo), Number(row.b_rgeo) || Number(row.rgeo), Number(row.B_rgeo) || Number(row.rgeo)]);
  const cone = new URLSearchParams({
    '-source': 'I/352/gedr3dis', '-c': `${ra.toFixed(6)} ${dec >= 0 ? '+' : ''}${dec.toFixed(6)}`,
    '-c.rd': radiusDeg.toFixed(4), '-out': 'Source,rgeo,b_rgeo,B_rgeo', '-out.max': '2000', '-out.add': '_r', '-sort': '_r',
  });
  const cfa = withTimeout(`${DEPTH_UPSTREAM.vizierCfa}?${cone}`, DEPTH_TIMEOUT_MS)
    .then(async (r2) => {
      if (!r2.ok) throw new Error(`VizieR (CfA) ${r2.status}`);
      const { status, message, rows } = parseVOTable(await r2.text());
      if (status === 'ERROR') throw new Error(`VizieR (CfA): ${message}`);
      return { bj: read(rows), via: 'VizieR CfA' };
    });
  const adql = `SELECT TOP 2000 Source, rgeo, b_rgeo, B_rgeo,
    DISTANCE(POINT('ICRS', RA_ICRS, DE_ICRS), POINT('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)})) AS d
    FROM "I/352/gedr3dis"
    WHERE CONTAINS(POINT('ICRS', RA_ICRS, DE_ICRS), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radiusDeg.toFixed(5)})) = 1
    ORDER BY d`;
  const cds = withTimeout(`${DEPTH_UPSTREAM.vizierTap}?${new URLSearchParams({ request: 'doQuery', lang: 'adql', format: 'csv', query: adql })}`, DEPTH_TIMEOUT_MS)
    .then(async (r2) => {
      const text = await r2.text();
      if (!r2.ok || text.trimStart().startsWith('<')) throw new Error(`VizieR TAP (CDS) ${r2.status}`);
      return { bj: read(parseCsv(text)), via: 'VizieR CDS' };
    });
  return firstOf([cfa, cds]);
}

/** SIMBAD's galaxies with a spectroscopic redshift in a cone: rows [name, otype, ra, dec, z]. */
function askGalaxies({ ra, dec, radiusDeg }) {
  const adql = `SELECT TOP 80 main_id, otype, ra, dec, rvz_redshift FROM basic
    WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radiusDeg.toFixed(5)})) = 1
    AND rvz_redshift > 0 AND rvz_qual IN ('A', 'B', 'C') ORDER BY nbref DESC`;
  const query = new URLSearchParams({ request: 'doQuery', lang: 'adql', format: 'json', query: adql });
  const ask = (base, via) => withTimeout(`${base}?${query}`, DEPTH_TIMEOUT_MS).then(async (r2) => {
    if (!r2.ok) throw new Error(`${via} ${r2.status}`);
    const body = await r2.json();
    if (!Array.isArray(body?.data)) throw new Error(`${via}: no data`);
    return { rows: body.data, via };
  });
  return firstOf([ask(DEPTH_UPSTREAM.simbadCds, 'SIMBAD CDS'), ask(DEPTH_UPSTREAM.simbadCfa, 'SIMBAD CfA')]);
}

/* ------------------------------------------------------- Gaia DR3 at MAST */

/** The Gaia DR3 the challenge's resources point to: MAST, at STScI. */
const MAST_INVOKE = 'https://mast.stsci.edu/api/v0/invoke';
const MAST_MAX_DEG = 0.04;
const MAST_TIMEOUT_MS = 40_000;
/** How long MAST has before IRSA is asked too. */
const MAST_HEDGE_MS = 3_000;

/**
 * A small Gaia DR3 cone from MAST, under the shared (VizieR) column names.
 * MAST's JSON carries the 64-bit source_id as a bare number, which a
 * JavaScript parser rounds; the designation keeps it exact.
 */
async function askMastGaia(field, key) {
  const request = {
    service: 'Mast.Catalogs.GaiaDR3.Cone', format: 'json', pagesize: 500, page: 1,
    params: { ra: field.ra, dec: field.dec, radius: field.radiusDeg },
  };
  const res = await fetch(MAST_INVOKE, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Muninn/1.0 (NASA Space Apps 2026)' },
    body: new URLSearchParams({ request: JSON.stringify(request) }),
    signal: AbortSignal.timeout(MAST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status !== 'COMPLETE' || !Array.isArray(body.data)) {
    throw new Error(`MAST: ${body?.msg || `HTTP ${res.status}`}`);
  }
  const rows = mastGaiaRows(body.data, field);
  const payload = { rows, via: 'MAST', table: 'gaiadr3' };
  await writeCache(key, payload);
  return { ok: true, cached: false, ...payload };
}

async function askIrsaTap(archive, field, key) {
  const query = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: coneQuery(archive, field) });
  // IRSA's gateway says 502 in bursts: asked once more after a short wait.
  const res = await retryOnGateway(() => withTimeout(`${IRSA_TAP}?${query}`, TAP_TIMEOUT_MS));
  const text = await res.text();
  // A refusal comes back as a VOTable whatever format was asked for.
  if (!res.ok || text.trimStart().startsWith('<')) {
    const said = text.trimStart().startsWith('<') ? parseVOTable(text).message : '';
    throw new Error(`IRSA TAP: ${said || `HTTP ${res.status}`}`);
  }
  const rows = parseCsv(text).map((row) => renameRow(row, archive.columns));
  const payload = { rows, via: 'IRSA', table: archive.table };
  await writeCache(key, payload);
  return { ok: true, cached: false, ...payload };
}

/* ------------------------------------------------- an AllWISE picture */

/** The AllWISE Atlas tiles, one per 1.56° of sky, listed by IRSA's SIA. */
const WISE_COLLECTION = 'wise_allwise';
const WISE_DEADLINE_MS = 85_000;
/** Biggest cutout asked for: the widest field the page opens, with a margin. */
const WISE_MAX_DEG = 0.6;
const wiseInflight = new Map();
const gunzipped = promisify(gunzip);

/**
 * The AllWISE image of a field, as a FITS file. IRSA cuts it from the Atlas
 * tile that covers the position (the archive does the cut, so a few hundred
 * kilobytes travel instead of a 64 MB tile) and sends it gzipped and without
 * CORS headers; this relays it unzipped and keeps it on disk.
 */
async function handleWise(url, res) {
  const at = position(url);
  if (!at) return json(res, 400, BAD_POSITION);
  const band = url.searchParams.get('band') === '2' ? 2 : 1;
  // In steps of 0.05°, rounded up: a handful of sizes per position, not 581.
  const size = Math.ceil(clamp(param(url, 'size') || 0.2, 0.02, WISE_MAX_DEG) / 0.05) * 0.05;
  const key = safeKey(`wise_w${band}_${at.ra.toFixed(4)}_${at.dec.toFixed(4)}_${size.toFixed(3)}`);
  const file = join(CACHE, `${key}.fits`);
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs < CACHE_TTL_MS) return sendFits(res, await readFile(file));
  } catch { /* not cut yet */ }

  let pending = wiseInflight.get(key);
  if (!pending && pools.wise.size >= POOL_MAX.wise) {
    return json(res, 503, { ok: false, error: 'The archive relay is busy; try again in a moment.' });
  }
  if (!pending) {
    pools.wise.add(key);
    pending = cutWise(at, band, size, file).finally(() => { wiseInflight.delete(key); pools.wise.delete(key); });
    wiseInflight.set(key, pending);
  }
  try {
    return sendFits(res, await pending);
  } catch (err) {
    return json(res, 502, { ok: false, error: err.message });
  }
}

/** One more try, after a short wait, when the archive's gateway answers 502, 503 or 504. */
async function retryOnGateway(fetchOnce, waitMs = 700) {
  const first = await fetchOnce();
  if (![502, 503, 504].includes(first.status)) return first;
  await new Promise((done) => setTimeout(done, waitMs));
  return fetchOnce();
}

async function cutWise({ ra, dec }, band, size, file) {
  // Both steps under one deadline, short of the tunnel's 100 s cut-off, so a
  // slow cut fails as JSON the page can read rather than as the proxy's page.
  const until = Date.now() + WISE_DEADLINE_MS;
  const left = () => Math.max(1000, until - Date.now());
  const pos = encodeURIComponent(`circle ${ra} ${dec} 0.002`);
  const listed = await retryOnGateway(() => withTimeout(`${SIA}?COLLECTION=${WISE_COLLECTION}&POS=${pos}&MAXREC=40`, left()));
  if (!listed.ok) throw new Error(`IRSA ${WISE_COLLECTION}: HTTP ${listed.status}`);
  const { rows } = parseVOTable(await listed.text());
  const want = `-w${band}-int-3.fits`;
  // A position near a tile edge is in two tiles; the one whose centre is
  // nearest leaves the most room around the field.
  const tiles = rows.filter((r) => String(r.access_url ?? '').endsWith(want))
    .map((r) => ({ url: r.access_url, d: Math.hypot((Number(r.s_ra) - ra) * Math.cos(dec * Math.PI / 180), Number(r.s_dec) - dec) }))
    .sort((a, b) => a.d - b.d);
  if (!tiles.length) throw new Error('AllWISE has no tile here');
  // The cutout's address comes from IRSA's answer: fetched only if it is IRSA's.
  if (!isIrsaUrl(tiles[0].url)) throw new Error('AllWISE: the cutout address is not at IRSA');
  const cut = await retryOnGateway(() => withTimeout(`${tiles[0].url}?center=${ra.toFixed(5)},${dec.toFixed(5)}&size=${size.toFixed(3)}deg`, left()));
  if (!cut.ok) throw new Error(`IRSA cutout: HTTP ${cut.status}`);
  let body = Buffer.from(await cut.arrayBuffer());
  if (body[0] === 0x1f && body[1] === 0x8b) body = await gunzipped(body, { maxOutputLength: 64 << 20 });
  if (!body.subarray(0, 6).toString('latin1').startsWith('SIMPLE')) throw new Error('IRSA cutout: not a FITS file');
  body = binFits(body, WISE_MAX_SIDE);
  try {
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, body);
  } catch { /* served all the same */ }
  return body;
}

/** Longest side of the picture sent on: more than the plate ever shows. */
const WISE_MAX_SIDE = 640;

/* ------------------------------------------------------- the whole-sky cube */

/**
 * The SPHEREx DR1 all-sky cube's HiPS tiles and Allsky images, passed on from
 * IRSA and kept on disk. IRSA's tile server has slow spells — an Allsky image
 * that usually comes in a second can take minutes — and the cube does not
 * change, so a tile once fetched is served from here for weeks after.
 * Only the cube's own file names are passed on: nothing else at IRSA can be
 * asked for through this.
 */
const HIPS_ORIGIN = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/';
const HIPS_PATH = /^Norder([0-5])\/(?:Dir(\d{1,6})\/Npix(\d{1,6})|Allsky)(?:_(\d{1,3}))?\.png$/;
const HIPS_FRAMES = 102;
const HIPS_TIMEOUT_MS = 90_000;
/** A tile of a released cube does not change: the browser and Cloudflare may keep it a week. */
const HIPS_KEEP = { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800', 'x-muninn-hips': '1' };
/** Said on every answer of the relay, so the page can tell its 404 from a host that has no relay. */
const HIPS_SAYS = { 'x-muninn-hips': '1' };
/** At most this many asked of IRSA at once; past it, the page asks IRSA itself. */
const HIPS_UPSTREAM_MAX = 12;
/** Bytes of tiles on disk: counted by the sweep and added to on every write, so the ceiling holds between sweeps. */
let hipsOnDisk = 0;
/** Its own ceiling on the disk, apart from the answers', so a sweep through the spectrum cannot push out frame lists. */
const HIPS_MAX_BYTES = 200 * 1024 * 1024;
const HIPS_PER_MINUTE = 1500;
const hipsAsked = new Map();
const hipsPending = new Map();

/** Whether a path names a file the cube has: the order, directory and index agree, the frame exists. */
function hipsPathOk(path) {
  const m = HIPS_PATH.exec(path);
  if (!m) return false;
  const order = Number(m[1]);
  if (m[3] !== undefined) {
    const npix = Number(m[3]);
    if (npix >= 12 * 4 ** order) return false;
    if (Number(m[2]) !== Math.floor(npix / 10000) * 10000) return false;
  } else if (order !== 3) {
    return false;
  }
  return m[4] === undefined || (Number(m[4]) >= 1 && Number(m[4]) < HIPS_FRAMES);
}

async function handleHips(url, res) {
  const path = url.pathname.slice('/api/hips/'.length);
  if (!hipsPathOk(path)) return send(res, 404, 'Not a file of the SPHEREx all-sky cube', HIPS_SAYS);
  const file = join(CACHE, `hips_${path.replace(/[^\w]/g, '_')}`);
  try {
    return send(res, 200, await readFile(file), HIPS_KEEP);
  } catch { /* not kept yet */ }
  let pending = hipsPending.get(path);
  if (!pending && hipsPending.size >= HIPS_UPSTREAM_MAX) {
    return send(res, 503, 'Busy: ask IRSA directly', { ...HIPS_SAYS, 'retry-after': '5' });
  }
  if (!pending) {
    pending = (async () => {
      const answer = await retryOnGateway(() => withTimeout(HIPS_ORIGIN + path, HIPS_TIMEOUT_MS));
      if (answer.status === 404) return null;
      if (!answer.ok) throw new Error(`IRSA HiPS: HTTP ${answer.status}`);
      const body = Buffer.from(await answer.arrayBuffer());
      if (body.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error('IRSA HiPS: not a PNG');
      // Past the ceiling a tile is passed on but not kept, until a sweep makes room.
      if (hipsOnDisk + body.length <= HIPS_MAX_BYTES) {
        try {
          await mkdir(CACHE, { recursive: true });
          await writeFile(file, body);
          hipsOnDisk += body.length;
        } catch { /* served all the same */ }
      }
      return body;
    })().finally(() => hipsPending.delete(path));
    hipsPending.set(path, pending);
  }
  try {
    const body = await pending;
    return body ? send(res, 200, body, HIPS_KEEP) : send(res, 404, 'No such tile', HIPS_SAYS);
  } catch (err) {
    return send(res, 502, err.message, HIPS_SAYS);
  }
}

/**
 * Average a float FITS image down by a whole factor until its longer side
 * fits `maxSide`, and rewrite the scale cards to match. An Atlas pixel is
 * 1.375″ and the plate's grid is coarser than that, so a 0.6° cutout (10 MB)
 * travels as about 1 MB with nothing visible lost. Blank pixels are left out
 * of each average; a block of nothing but blanks stays blank.
 */
function binFits(buf, maxSide) {
  const cards = [];
  let at = 0;
  for (;;) {
    const card = buf.subarray(at, at + 80).toString('latin1');
    cards.push(card);
    at += 80;
    if (card.startsWith('END ') || card.trimEnd() === 'END') break;
    if (at >= buf.length) throw new Error('FITS header has no END');
  }
  const dataAt = Math.ceil(at / 2880) * 2880;
  const value = (key) => {
    const card = cards.find((c) => c.startsWith(key.padEnd(8)));
    return card ? Number(card.slice(10, 80).split('/')[0]) : NaN;
  };
  const nx = value('NAXIS1');
  const ny = value('NAXIS2');
  const factor = Math.ceil(Math.max(nx, ny) / maxSide);
  if (value('BITPIX') !== -32 || !(factor > 1)) return buf;
  const mx = Math.floor(nx / factor);
  const my = Math.floor(ny / factor);
  const out = Buffer.alloc(Math.ceil((mx * my * 4) / 2880) * 2880);
  for (let j = 0; j < my; j++) {
    for (let i = 0; i < mx; i++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const v = buf.readFloatBE(dataAt + (((j * factor + dy) * nx) + i * factor + dx) * 4);
          if (Number.isFinite(v)) { sum += v; n += 1; }
        }
      }
      out.writeFloatBE(n ? sum / n : NaN, (j * mx + i) * 4);
    }
  }
  // Pixel centre k of the binned image sits at (k - 0.5) * factor + 0.5 of the old.
  const set = (key, v) => {
    const k = cards.findIndex((c) => c.startsWith(key.padEnd(8)));
    if (k >= 0) cards[k] = `${key.padEnd(8)}= ${String(v).padStart(20)}`.padEnd(80);
  };
  set('NAXIS1', mx);
  set('NAXIS2', my);
  for (const axis of [1, 2]) set(`CRPIX${axis}`, (value(`CRPIX${axis}`) - 0.5) / factor + 0.5);
  for (const key of ['CDELT1', 'CDELT2', 'CD1_1', 'CD1_2', 'CD2_1', 'CD2_2']) {
    if (Number.isFinite(value(key))) set(key, value(key) * factor);
  }
  let head = Buffer.from(cards.join(''), 'latin1');
  head = Buffer.concat([head, Buffer.alloc(Math.ceil(head.length / 2880) * 2880 - head.length, ' ')]);
  return Buffer.concat([head, out]);
}

const sendFits = (res, body) => send(res, 200, body, { 'content-type': 'application/fits' });

/* ------------------------------------------------ other archives, at CADC */

/** CADC's TAP over its common observation index (CAOM), Argus. */
const CADC_TAP = 'https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync';
const CADC_TIMEOUT_MS = 60_000;

/** How many science observations each archive CADC indexes holds of a circle. */
async function handleArchives(url, res) {
  const at = position(url);
  if (!at) return json(res, 400, BAD_POSITION);
  const radiusDeg = clamp(param(url, 'r') || 0.1, ARCHIVE_RADIUS.min, ARCHIVE_RADIUS.max);
  const key = safeKey(`cadc_${at.ra.toFixed(4)}_${at.dec.toFixed(4)}_${radiusDeg.toFixed(4)}`);
  return relay(res, key, () => askCadc({ ...at, radiusDeg }, key));
}

async function askCadc(field, key) {
  const query = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: archivesQuery(field) });
  // A sync query is answered by a redirect to its result; fetch follows it.
  const res = await withTimeout(`${CADC_TAP}?${query}`, CADC_TIMEOUT_MS);
  const text = await res.text();
  if (!res.ok || !text.startsWith('collection,')) throw new Error(`CADC: HTTP ${res.status}`);
  const rows = parseCsv(text);
  // NEOSSat in the list: one more question, for its newest frame here.
  const neo = rows.find((r) => r.collection === 'NEOSSAT');
  const neossat = neo && Number.isFinite(Number(neo.last)) ? await askNeossat({ ...field, last: neo.last }) : null;
  const payload = { rows, neossat, via: 'CADC' };
  await writeCache(key, payload);
  return { ok: true, cached: false, ...payload };
}

async function askNeossat(field) {
  const ask = async (adql) => {
    const query = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: adql });
    const res = await withTimeout(`${CADC_TAP}?${query}`, CADC_TIMEOUT_MS);
    if (!res.ok) throw new Error(`CADC: HTTP ${res.status}`);
    return parseCsv(await res.text());
  };
  try {
    const [obs] = await ask(neossatQuery(field));
    if (!obs) return null;
    return readNeossat(obs, await ask(neossatFilesQuery(obs.planeID)));
  } catch {
    // The count stands without the picture.
    return null;
  }
}

/* ---------------------------------------------------- small bodies at JPL */

/** "2025-08-15T20:45:12" and nothing looser: it becomes part of a URL to JPL. */
const ISO_SECOND = /^(19|20)\d\d-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d/;

/**
 * Known asteroids and comets in a square field at a moment, from JPL.
 *
 *   ra, dec   the centre; r   half the side, degrees, 0.01° to 2°
 *   time      UTC, ISO 8601 to the second;  mag   faintest V, 10 to 25
 */
async function handleSbIdent(url, res) {
  const at = position(url);
  if (!at) return json(res, 400, BAD_POSITION);
  const time = url.searchParams.get('time') ?? '';
  if (!ISO_SECOND.test(time) || Number.isNaN(Date.parse(`${time.slice(0, 19)}Z`))) {
    return json(res, 400, { ok: false, error: 'time must be UTC as YYYY-MM-DDThh:mm:ss' });
  }
  const field = {
    ...at,
    halfWidthDeg: clamp(param(url, 'r') || 0.1, 0.01, 2),
    iso: time.slice(0, 19),
    magLimit: Math.round(clamp(param(url, 'mag') || 20, 10, 25)),
  };
  const key = safeKey(`sbid_${field.ra.toFixed(4)}_${field.dec.toFixed(4)}_${field.halfWidthDeg.toFixed(4)}_${field.iso}_${field.magLimit}`);
  return relay(res, key, () => askJpl(field, key), 'jpl');
}

async function askJpl(field, key) {
  const res = await withTimeout(sbIdentUrl(field), SBIDENT_TIMEOUT_MS);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.signature) throw new Error(`JPL sb_ident: ${body?.message ?? `HTTP ${res.status}`}`);
  const payload = { bodies: parseSbIdent(body), via: 'JPL' };
  await writeCache(key, payload);
  return { ok: true, cached: false, ...payload };
}

/* ------------------------------------------- asteroids and comets by name */

/** SBDB and Horizons each answer a name in a second or two. */
const SMALL_BODY_TIMEOUT_MS = 30_000;
/** Names per visitor per minute: the box asks once a pause in typing, not per key. */
const NAMES_PER_MINUTE = 30;
const namesAsked = new Map();

/**
 * An asteroid or comet the search box was given, and where it stands today.
 *
 *   name   what was typed: "Ceres", "433 Eros", "(152) Atala", "1P/Halley",
 *          "2024 YR4". The relay reads a designation out of it, and only
 *          that designation goes to JPL.
 *
 * Answers { bodies: [{ des, name, comet, ra, dec }], day }, empty when JPL
 * knows no such body. Kept for the day, since a body moves.
 */
async function handleSmallBody(url, req, res) {
  const asked = smallBodyQuery(url.searchParams.get('name') ?? '');
  if (!asked || !SBDB_TEXT.test(asked.sstr)) {
    return json(res, 400, { ok: false, error: 'name must be an asteroid or comet name or designation' });
  }
  if (overLimit(req, namesAsked, NAMES_PER_MINUTE)) {
    return json(res, 429, { ok: false, error: 'Too many names from here; wait a minute.' });
  }
  const day = new Date().toISOString().slice(0, 10);
  const key = `sb_${day}_${createHash('sha1').update(asked.sstr.toLowerCase()).digest('hex').slice(0, 20)}`;
  return relay(res, key, () => askSmallBody(asked.sstr, day, key), 'names');
}

async function askSmallBody(sstr, day, key) {
  const found = readSbdb(await jplJson(sbdbUrl(sstr), 'SBDB'), sstr);
  const bodies = [];
  for (const body of found) {
    const at = readHorizons(await jplJson(horizonsUrl(body, day), 'Horizons'), body);
    if (at) bodies.push({ ...body, ...at });
  }
  const payload = { bodies, day, via: 'JPL' };
  await writeCache(key, payload);
  return { ok: true, cached: false, ...payload };
}

/* ------------------------------------------------- a marked body's orbit */

/**
 * The orbit JPL's Small-Body Database has for one asteroid or comet, for the
 * card of a mark it was matched to: its class, a, e, i, period and the
 * elements the page draws the orbit from (orbit.js readOrbit).
 *
 *   des   the designation SkyBoT or JPL named the body by: "152",
 *         "2000 AG119", "C/2020 F3", "67P". Checked, and only it goes to JPL.
 *
 * Answers { orbit }, null when JPL has no single body by that designation.
 */
async function handleSbdb(url, req, res) {
  const des = (url.searchParams.get('des') ?? '').replace(/\s+/g, ' ').trim();
  if (!SBDB_TEXT.test(des)) {
    return json(res, 400, { ok: false, error: 'des must be an asteroid or comet designation' });
  }
  if (overLimit(req, namesAsked, NAMES_PER_MINUTE)) {
    return json(res, 429, { ok: false, error: 'Too many names from here; wait a minute.' });
  }
  const key = `sbdb_${createHash('sha1').update(des.toLowerCase()).digest('hex').slice(0, 20)}`;
  return relay(res, key, () => askOrbit(des, key), 'names');
}

async function askOrbit(des, key) {
  const payload = { orbit: readOrbit(await jplJson(sbdbOrbitUrl(des), 'SBDB')), via: 'JPL' };
  await writeCache(key, payload);
  return { ok: true, cached: false, ...payload };
}

/* ------------------------------------------- bodies on nearly the same orbit */

/** Tries at a smaller box before the rows JPL sent are taken as they are. */
const NEAR_NARROWINGS = 3;

/**
 * Every asteroid and comet JPL's Small-Body Database has on nearly the orbit
 * of a marked body, for its card (orbit.js NEAR_BOX: a within 2 %, e within
 * 0.03, i within 1.5°).
 *
 *   a, e, i   the marked body's semi-major axis (AU), eccentricity and
 *             inclination (°). Checked as plain numbers; the question to
 *             JPL is written from them alone.
 *
 * Answers { count, rows, scale }: how many bodies the box holds, and the
 * rows of a box shrunk by `scale` until it holds no more than JPL is asked
 * to send, so that the closest are among them. A main-belt box holds
 * thousands; it takes two or three questions.
 */
async function handleSbdbNear(url, req, res) {
  const k = { a: param(url, 'a'), e: param(url, 'e'), i: param(url, 'i') };
  if (!(k.a > 0.1 && k.a < 1000) || !(k.e >= 0 && k.e < 1) || !(k.i >= 0 && k.i <= 180)) {
    return json(res, 400, { ok: false, error: 'a (AU), e (0 to 1) and i (degrees) must be numbers of a closed orbit' });
  }
  if (overLimit(req, namesAsked, NAMES_PER_MINUTE)) {
    return json(res, 429, { ok: false, error: 'Too many names from here; wait a minute.' });
  }
  const box = nearBox(k);
  const key = `sbnear_${createHash('sha1').update(JSON.stringify(box)).digest('hex').slice(0, 20)}`;
  return relay(res, key, () => askNear(k, key), 'names');
}

async function askNear(k, key) {
  const wide = readNear(await jplJson(nearQueryUrl(nearBox(k)), 'SBDB query'));
  let found = wide;
  let scale = 1;
  for (let n = 0; n < NEAR_NARROWINGS && found.count > NEAR_ROWS; n++) {
    // The box's volume goes as the cube of its scale: aim a little under the rows wanted.
    scale *= 0.85 * Math.cbrt(NEAR_ROWS / found.count);
    found = readNear(await jplJson(nearQueryUrl(nearBox(k, scale)), 'SBDB query'));
  }
  const payload = { count: wide.count, rows: found.rows, scale: Number(scale.toFixed(4)), via: 'JPL' };
  await writeCache(key, payload);
  return { ok: true, cached: false, ...payload };
}

/** A JPL API's JSON. A busy JPL answers with an HTML page instead: that is an error, not "not found". */
async function jplJson(target, what) {
  const res = await withTimeout(target, SMALL_BODY_TIMEOUT_MS);
  const body = await res.json().catch(() => null);
  if (!body || (!body.signature && res.status >= 400)) throw new Error(`JPL ${what}: HTTP ${res.status}`);
  return body;
}

/* -------------------------------------------------------------------- static */

async function serveStatic(pathname, req, res, asked = null) {
  // A malformed escape is the request's fault, not the server's.
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  if (rel.split(/[\\/]/).includes('..')) return send(res, 403, 'Forbidden');

  const target = join(PUBLIC, rel === '' ? 'index.html' : rel);
  if (!target.startsWith(PUBLIC + sep) && target !== join(PUBLIC, 'index.html')) {
    return send(res, 403, 'Forbidden');
  }
  let file;
  try {
    file = await loadStatic(target);
  } catch {
    return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
  }
  const ext = extname(target);
  const headers = {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': await keptForGood(rel, asked, file) ? IMMUTABLE : cachePolicy(rel),
    etag: file.etag,
    vary: 'accept-encoding',
  };
  // A proxy may hand the tag back weakened (W/"…"); it is still the same file.
  const known = String(req.headers['if-none-match'] ?? '').replace(/^W\//, '');
  if (known === file.etag) return send(res, 304, null, headers);

  const accepts = String(req.headers['accept-encoding'] ?? '');
  if (file.br && /\bbr\b/.test(accepts)) return send(res, 200, file.br, { ...headers, 'content-encoding': 'br' });
  if (file.gzip && /\bgzip\b/.test(accepts)) return send(res, 200, file.gzip, { ...headers, 'content-encoding': 'gzip' });
  return send(res, 200, file.raw, headers);
}

/**
 * Text is sent compressed. The page's own code is 700 KB as written and about
 * a quarter of that on the wire, and a baked frame index goes from 390 KB to
 * 40. Each file is compressed once and kept until it changes on disk.
 *
 * Compressed off the event loop, in zlib's own threads. Done in line, a new
 * deploy's first page load spent seconds of the box's one thread squeezing
 * some ninety files at the highest settings, and every question that came in
 * meanwhile, a cached answer included, waited behind it: seven seconds for
 * the other-archives list that was already on disk.
 */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.webmanifest']);
const staticCache = new Map();
const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

async function loadStatic(target) {
  const info = await stat(target);
  if (!info.isFile()) throw new Error('not a file');
  const kept = staticCache.get(target);
  if (kept && kept.mtimeMs === info.mtimeMs && (!kept.version || kept.version === await codeVersion())) return kept;

  // Only what carries the tag inside it (the page and the code's imports)
  // changes with it; a picture or a data file keeps its ETag across deploys.
  const version = carriesTag(target) ? await codeVersion() : null;
  const raw = versioned(target, await readFile(target), version);
  const stamp = `${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}`;
  const file = {
    mtimeMs: info.mtimeMs,
    raw,
    version,
    etag: `"${version ? `${stamp}-${version}` : stamp}"`,
  };
  if (COMPRESSIBLE.has(extname(target))) {
    [file.br, file.gzip] = await Promise.all([
      brotli(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9 } }),
      gzipped(raw, { level: 9 }),
    ]);
  }
  staticCache.set(target, file);
  return file;
}

/**
 * The page's code, served under a tag for the deploy it belongs to.
 *
 * Through the tunnel each request to the box is one to three seconds, and the
 * code was sent `no-cache`, so Cloudflare asked the box about every one of
 * the page's thirty-odd files on every visit: seven seconds to a first paint.
 * Now the page names each file as `js/app.js?v=<tag>`, every import inside
 * the code carries the same tag, and a file asked for under the current tag
 * is marked immutable: Cloudflare keeps it and the box is not asked again.
 * A new deploy is a new tag, so a visitor never gets one deploy's page with
 * another's code. A file asked for under an old tag is served as it is now,
 * `no-cache`, so the edge never keeps new code under an old name.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';
let versionTag = null;

/** A short hash of the code as deployed: every file's path, size and date. */
let versionCheckedAt = 0;
const VERSION_RECHECK_MS = 30_000;

async function codeVersion({ fresh = false } = {}) {
  // Re-read now and then for the tag written into pages, so code copied in
  // without a restart shows up; read afresh before anything is marked
  // immutable (see keptForGood).
  if (fresh) return freshVersion();
  if (versionTag && Date.now() - versionCheckedAt < VERSION_RECHECK_MS) return versionTag;
  return readVersion();
}

/**
 * A read of the tag that began after the caller asked. A page load asks for
 * some forty tagged files at once; they share reads instead of each listing
 * both folders: a request that arrives while a read is running waits for the
 * next one, which starts when that one ends and serves everyone who queued.
 */
let freshRun = null;
let freshNext = null;
function freshVersion() {
  if (!freshRun) {
    freshRun = readVersion().finally(() => { freshRun = null; });
    return freshRun;
  }
  freshNext ??= freshRun.then(() => { freshNext = null; return freshVersion(); }, () => { freshNext = null; return freshVersion(); });
  return freshNext;
}

/**
 * List js/ and css/, with the folders inside them (the headset's code and the
 * library it is drawn with live in js/vr/ and js/vendor/), and hash what is
 * there. A new tag drops what was built under the old.
 */
async function readVersion() {
  versionCheckedAt = Date.now();
  const before = versionTag;
  const hash = createHash('sha1');
  const walk = async (dir) => {
    for (const name of (await readdir(join(PUBLIC, dir))).sort()) {
      const info = await stat(join(PUBLIC, dir, name));
      if (info.isFile()) hash.update(`${dir}/${name}:${info.size}:${Math.round(info.mtimeMs)}\n`);
      else if (info.isDirectory()) await walk(`${dir}/${name}`);
    }
  };
  for (const dir of ['js', 'css']) await walk(dir);
  versionTag = hash.digest('hex').slice(0, 10);
  if (before && before !== versionTag) {
    for (const [path, file] of staticCache) if (file.version) staticCache.delete(path);
  }
  return versionTag;
}

const CODE_PATH = /^(?:js|css)\//;

/** The files whose bytes have the tag written into them: the pages and the code under js/. */
const carriesTag = (target) => extname(target) === '.html'
  || (extname(target) === '.js' && target.startsWith(join(PUBLIC, 'js') + sep));

/**
 * Whether a response may be kept by the edge for a year: only the code, only
 * under the tag of the code on disk right now (read afresh, not from the
 * throttled copy, so a file changed a second ago is never kept under the tag
 * from before it), and only the bytes built under that tag.
 */
async function keptForGood(rel, asked, file) {
  if (!asked || !CODE_PATH.test(rel.replace(/\\/g, '/'))) return false;
  const now = await codeVersion({ fresh: true });
  return asked === now && (!file.version || file.version === now);
}

const PAGE_CODE = /((?:src|href)=")((?:js|css)\/[^"?#]+\.(?:js|css))"/g;
const IMPORTS = /(\bfrom\s*|\bimport\s*\(?\s*|new URL\(\s*)(['"])(\.{1,2}\/[^'"?#]+\.js)\2/g;

/** The page's references to its own code, and the code's to itself, tagged. */
function versioned(target, raw, version) {
  const ext = extname(target);
  if (ext === '.html') {
    return Buffer.from(raw.toString('utf8').replace(PAGE_CODE, `$1$2?v=${version}"`));
  }
  if (ext === '.js' && target.startsWith(join(PUBLIC, 'js') + sep)) {
    return Buffer.from(raw.toString('utf8').replace(IMPORTS, `$1$2$3?v=${version}$2`));
  }
  return raw;
}

/**
 * The page and its code change with every deploy, so they are always checked
 * (and answered with a 304 when nothing moved). Data and pictures change with
 * a data release. The same policy public/_headers gives Cloudflare Pages.
 */
function cachePolicy(rel) {
  const path = rel.replace(/\\/g, '/');
  if (path.startsWith('data/')) return 'public, max-age=600, stale-while-revalidate=86400';
  if (path.startsWith('img/')) return 'public, max-age=86400';
  if (path.startsWith('fonts/')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

/* ----------------------------------------------------------------------- run */

/**
 * Questions to the archives per visitor per minute. A page opening a field
 * asks a few dozen; a script looping over the sky asks thousands, each one a
 * query at someone else's archive on our behalf.
 */
const PER_MINUTE = 180;
const askedApi = new Map();

function overLimit(req, book = askedApi, limit = PER_MINUTE) {
  // Behind the tunnel every request comes from 127.0.0.1; Cloudflare says who.
  const who = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '');
  const now = Date.now();
  let entry = book.get(who);
  if (!entry || now - entry.from > 60_000) {
    entry = { from: now, n: 0 };
    book.set(who, entry);
    if (book.size > 5000) for (const [k, v] of book) if (now - v.from > 60_000) book.delete(k);
  }
  entry.n += 1;
  return entry.n > limit;
}

const server = createServer(async (req, res) => {
  // A request line that is not a URL ("//", a host with a space) is the
  // client's mistake. Parsed outside a try it was an unhandled rejection, and
  // one such request stopped the process.
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'Bad request');
  }
  // Everything here is read-only.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
  }
  // The sky's tiles come by the hundred as the view moves: they have a limit of their own.
  const tiles = url.pathname.startsWith('/api/hips/');
  if (url.pathname.startsWith('/api/') && (tiles ? overLimit(req, hipsAsked, HIPS_PER_MINUTE) : overLimit(req))) {
    return json(res, 429, { ok: false, error: 'Too many questions from here; wait a minute.' });
  }
  try {
    if (tiles) return await handleHips(url, res);
    if (url.pathname === '/api/search') return await handleSearch(url, res);
    if (url.pathname === '/api/tap') return await handleTap(url, res);
    if (url.pathname === '/api/depth') return await handleDepth(url, res);
    if (url.pathname === '/api/sbident') return await handleSbIdent(url, res);
    if (url.pathname === '/api/smallbody') return await handleSmallBody(url, req, res);
    if (url.pathname === '/api/sbdb') return await handleSbdb(url, req, res);
    if (url.pathname === '/api/sbdb-near') return await handleSbdbNear(url, req, res);
    if (url.pathname === '/api/wise') return await handleWise(url, res);
    if (url.pathname === '/api/archives') return await handleArchives(url, res);
    if (url.pathname === '/api/targets') {
      const body = await readFile(join(PUBLIC, 'data', 'targets.json'));
      return send(res, 200, body, { 'content-type': TYPES['.json'] });
    }
    return await serveStatic(url.pathname, req, res, url.searchParams.get('v'));
  } catch (err) {
    console.error(`${req.method} ${req.url} → ${err.message}`);
    if (res.headersSent) return res.end();
    return json(res, 500, { ok: false, error: err.message });
  }
});

await loadBakedFields();
await loadOwnIndex();
// A refreshed index is copied in beside a running relay: looked for again every ten minutes.
setInterval(loadOwnIndex, 10 * 60 * 1000).unref();

/**
 * Drop answers older than they are kept for. Every relay question is a
 * file in .cache, and on a small always-on box the disk is the limit that
 * would be reached first. Swept at start and every ten minutes after.
 */
async function sweepCache() {
  let names;
  try { names = await readdir(CACHE); } catch { return; }
  const now = Date.now();
  const kept = [];
  const keptTiles = [];
  for (const name of names) {
    const file = join(CACHE, name);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      // A frame list, and the depth view's catalogues, are kept for weeks, as
      // the answer to fall back on while the archives are down; everything
      // else for as long as it is trusted.
      // The cube's tiles, for as long as the frame lists: a release does not change.
      const keep = name.startsWith('frames_') || name.startsWith('hips_') ? SEARCH_KEEP_MS : name.startsWith('depth_') ? DEPTH_KEEP_MS : CACHE_TTL_MS;
      if (now - info.mtimeMs > keep) await unlink(file);
      else (name.startsWith('hips_') ? keptTiles : kept).push({ file, at: info.mtimeMs, size: info.size });
    } catch { /* gone already, or busy: the next sweep has it */ }
  }
  // And a ceiling on what is kept, oldest out first: one for the answers, one for the tiles.
  for (const [list, ceiling] of [[kept, CACHE_MAX_BYTES], [keptTiles, HIPS_MAX_BYTES]]) {
    let total = list.reduce((sum, f) => sum + f.size, 0);
    for (const f of list.sort((a, b) => a.at - b.at)) {
      if (total <= ceiling) break;
      try { await unlink(f.file); total -= f.size; } catch { /* next sweep */ }
    }
    if (list === keptTiles) hipsOnDisk = total;
  }
}
sweepCache();
setInterval(sweepCache, 10 * 60 * 1000).unref();

/**
 * The last line of defence. Every relay catches what an archive can send it,
 * but a fault nobody foresaw, in a timer or a stream callback, would otherwise
 * stop the process and every visitor's page with it. It is written down and
 * the server goes on answering. A port that cannot be had is the exception:
 * that is a server that never started, and it says so and stops.
 */
process.on('uncaughtException', (err) => {
  console.error(`uncaught: ${err?.stack ?? err}`);
});
process.on('unhandledRejection', (err) => {
  console.error(`unhandled rejection: ${err?.stack ?? err}`);
});
server.on('error', (err) => {
  if (server.listening) { console.error(`server: ${err.message}`); return; }
  console.error(`  could not listen on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});
// A connection that sends nonsense, or drops mid-request, is closed alone.
server.on('clientError', (err, socket) => {
  if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Muninn — SPHEREx time-domain viewer`);
  console.log(`  http://${HOST}:${PORT}\n`);
  console.log(`  Image data is read straight from the AWS mirror by the browser.`);
  console.log(`  This process relays the IRSA frame index and catalogues, and JPL's`);
  console.log(`  small-body identification, and caches the answers in .cache/`);
  console.log(baked.length
    ? `  ${baked.length} pre-resolved fields loaded: ${baked.map((b) => b.key).join(', ')}\n`
    : `  No pre-resolved fields — run "npm run bake" to make the presets open instantly.\n`);
  console.log(ownIndex
    ? `  Own frame index of ${ownIndex.meta.builtAt.slice(0, 10)}: ${ownIndex.meta.rows} frames, in ${INDEX_DIR}\n`
    : `  No own frame index in ${INDEX_DIR}: with IRSA down, only kept lists are served.\n`);
});

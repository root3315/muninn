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
 * checked numbers.
 *
 * No dependencies. `node server.js` and open the address it prints.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync, gunzipSync, constants as zlib } from 'node:zlib';
import { readFile, writeFile, mkdir, stat, readdir, unlink } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVOTable } from './public/js/votable.js';
import { frameFromRow } from './public/js/catalog.js';
import { COLLECTIONS } from './public/js/release.js';
import { parseCsv } from './public/js/csv.js';
import { CATALOGUES, ROW_CAP, coneQuery, renameRow, mastGaiaRows } from './public/js/overlay.js';
import { sbIdentUrl, parseSbIdent } from './public/js/sbident.js';
import { archivesQuery, neossatQuery, neossatFilesQuery, readNeossat, ARCHIVE_RADIUS } from './public/js/archives.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const CACHE = join(ROOT, '.cache');
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const IRSA_TAP = 'https://irsa.ipac.caltech.edu/TAP/sync';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
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

const json = (res, code, value) =>
  send(res, code, JSON.stringify(value), { 'content-type': TYPES['.json'] });

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

const safeKey = (text) => text.replace(/[^\w.-]/g, '_');
const cacheKey = (ra, dec, radius) => safeKey(`sia_${ra.toFixed(4)}_${dec.toFixed(4)}_${radius.toFixed(4)}`);

async function readCache(key) {
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const file = join(CACHE, `${key}.json`);
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > CACHE_TTL_MS) return null;
    const value = JSON.parse(await readFile(file, 'utf8'));
    remember(key, { at: info.mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

function remember(key, entry) {
  memory.delete(key);
  memory.set(key, entry);
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
}

async function writeCache(key, value) {
  remember(key, { at: Date.now(), value });
  try {
    await mkdir(CACHE, { recursive: true });
    await writeFile(join(CACHE, `${key}.json`), JSON.stringify(value), 'utf8');
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

async function queryCollectionOnce(collection, ra, dec, radius, ms = UPSTREAM_TIMEOUT_MS) {
  const pos = encodeURIComponent(`circle ${ra} ${dec} ${radius}`);
  const res = await withTimeout(`${SIA}?COLLECTION=${collection}&POS=${pos}&MAXREC=${MAXREC}`, ms);
  if (!res.ok) throw Object.assign(new Error(`IRSA ${collection}: HTTP ${res.status}`), { answered: true });
  const { status, message, rows } = parseVOTable(await res.text());
  if (status === 'ERROR') throw Object.assign(new Error(`IRSA ${collection}: ${message}`), { answered: true });
  return { rows, truncated: status === 'OVERFLOW' };
}

/**
 * One more try when the connection itself dropped. IRSA sometimes closes a
 * slow response part-way ("terminated", "fetch failed"); asked again, it
 * usually answers. An answer that says no — an HTTP error or a VOTable error —
 * is not asked twice.
 */
async function queryCollection(collection, ra, dec, radius) {
  const started = Date.now();
  try {
    return await queryCollectionOnce(collection, ra, dec, radius);
  } catch (err) {
    // Only a quick drop is worth a second ask: after a long silence, asking
    // again would double a wait that was already too long.
    if (err.answered || Date.now() - started > 30_000) throw err;
    await new Promise((r) => { setTimeout(r, 800); });
    // The second ask gets what is left of the first one's time, so the two
    // together end before the page stops waiting.
    return queryCollectionOnce(collection, ra, dec, radius, UPSTREAM_TIMEOUT_MS - (Date.now() - started));
  }
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
const POOL_MAX = { search: 6, catalog: 8, jpl: 3, wise: 3 };
const pools = Object.fromEntries(Object.keys(POOL_MAX).map((k) => [k, new Set()]));

/**
 * A question for an archive, answered from the cache, by joining the same
 * question already out, or by asking. `ask` caches its own answer, since only
 * it knows whether the answer is whole.
 */
async function relay(res, key, ask, pool = 'catalog') {
  const cached = await readCache(key);
  if (cached) return json(res, 200, { ok: true, cached: true, ...cached });

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
function param(url, name) {
  const raw = url.searchParams.get(name)?.trim();
  return raw ? Number(raw) : NaN;
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

  const prebaked = findBaked(ra, dec);
  if (prebaked) {
    return json(res, 200, {
      ok: true, cached: 'baked', frames: prebaked.frames,
      truncated: Boolean(prebaked.truncated), warnings: [],
    });
  }

  const key = cacheKey(ra, dec, radius);
  return relay(res, key, () => lookup(ra, dec, radius, key), 'search');
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
  const key = safeKey(`tap_${cat}_${field.ra.toFixed(4)}_${field.dec.toFixed(4)}_${field.radiusDeg}_${field.top}_${field.limit ?? 'all'}`);
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
  const res = await withTimeout(`${IRSA_TAP}?${query}`, TAP_TIMEOUT_MS);
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

async function cutWise({ ra, dec }, band, size, file) {
  // Both steps under one deadline, short of the tunnel's 100 s cut-off, so a
  // slow cut fails as JSON the page can read rather than as the proxy's page.
  const until = Date.now() + WISE_DEADLINE_MS;
  const left = () => Math.max(1000, until - Date.now());
  const pos = encodeURIComponent(`circle ${ra} ${dec} 0.002`);
  const listed = await withTimeout(`${SIA}?COLLECTION=${WISE_COLLECTION}&POS=${pos}&MAXREC=40`, left());
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
  const cut = await withTimeout(`${tiles[0].url}?center=${ra.toFixed(5)},${dec.toFixed(5)}&size=${size.toFixed(3)}deg`, left());
  if (!cut.ok) throw new Error(`IRSA cutout: HTTP ${cut.status}`);
  let body = Buffer.from(await cut.arrayBuffer());
  if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body, { maxOutputLength: 64 << 20 });
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

/** Ask the archive which frames cover a position, and cache a complete answer. */
async function lookup(ra, dec, radius, key) {
  const settled = await Promise.allSettled(
    COLLECTIONS.map((c) => queryCollection(c, ra, dec, radius)),
  );

  const rows = [];
  const problems = [];
  let truncated = false;
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      rows.push(...r.value.rows);
      truncated = truncated || r.value.truncated;
    } else {
      problems.push(`${COLLECTIONS[i]}: ${r.reason.message}`);
    }
  });

  if (!rows.length && problems.length === COLLECTIONS.length) {
    return { ok: false, error: problems.join('; ') };
  }

  const seen = new Set();
  const frames = [];
  for (const row of rows) {
    if (row.dataproduct_subtype !== 'science') continue;
    if (Number(row.calib_level) < 2) continue;
    const frame = frameFromRow(row);
    if (!frame || !frame.url || seen.has(frame.url)) continue;
    seen.add(frame.url);
    frames.push(frame);
  }
  frames.sort((a, b) => a.mjd - b.mjd);
  // Nothing found while part of the archive did not answer is not "nothing
  // here" — it is a question that did not get asked. Said as a failure.
  if (!frames.length && problems.length) {
    return { ok: false, error: problems.join('; ') };
  }

  const payload = { frames, truncated, warnings: problems, queried: { ra, dec, radius } };
  // A collection that did not answer is a gap, not a finding. Cached, it turned
  // one dropped connection into twelve hours of "SPHEREx has never been here".
  if (!problems.length) await writeCache(key, payload);
  return { ok: true, cached: false, ...payload };
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
    return send(res, 404, 'Not found');
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
 */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.webmanifest']);
const staticCache = new Map();

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
    file.br = brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9 } });
    file.gzip = gzipSync(raw, { level: 9 });
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

/** List js/ and css/ and hash what is there. A new tag drops what was built under the old. */
async function readVersion() {
  versionCheckedAt = Date.now();
  const before = versionTag;
  const hash = createHash('sha1');
  for (const dir of ['js', 'css']) {
    for (const name of (await readdir(join(PUBLIC, dir))).sort()) {
      const info = await stat(join(PUBLIC, dir, name));
      if (info.isFile()) hash.update(`${dir}/${name}:${info.size}:${Math.round(info.mtimeMs)}\n`);
    }
  }
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
const asked = new Map();

function overLimit(req) {
  // Behind the tunnel every request comes from 127.0.0.1; Cloudflare says who.
  const who = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '');
  const now = Date.now();
  let entry = asked.get(who);
  if (!entry || now - entry.from > 60_000) {
    entry = { from: now, n: 0 };
    asked.set(who, entry);
    if (asked.size > 5000) for (const [k, v] of asked) if (now - v.from > 60_000) asked.delete(k);
  }
  entry.n += 1;
  return entry.n > PER_MINUTE;
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
  if (url.pathname.startsWith('/api/') && overLimit(req)) {
    return json(res, 429, { ok: false, error: 'Too many questions from here; wait a minute.' });
  }
  try {
    if (url.pathname === '/api/search') return await handleSearch(url, res);
    if (url.pathname === '/api/tap') return await handleTap(url, res);
    if (url.pathname === '/api/sbident') return await handleSbIdent(url, res);
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

/**
 * Drop answers older than they are trusted for. Every relay question is a
 * file in .cache, and on a small always-on box the disk is the limit that
 * would be reached first; an expired answer is never served, so it is only
 * taking room. Swept at start and every ten minutes after.
 */
async function sweepCache() {
  let names;
  try { names = await readdir(CACHE); } catch { return; }
  const now = Date.now();
  const kept = [];
  for (const name of names) {
    const file = join(CACHE, name);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs > CACHE_TTL_MS) await unlink(file);
      else kept.push({ file, at: info.mtimeMs, size: info.size });
    } catch { /* gone already, or busy: the next sweep has it */ }
  }
  // And a ceiling on what is kept, oldest out first.
  let total = kept.reduce((sum, f) => sum + f.size, 0);
  for (const f of kept.sort((a, b) => a.at - b.at)) {
    if (total <= CACHE_MAX_BYTES) break;
    try { await unlink(f.file); total -= f.size; } catch { /* next sweep */ }
  }
}
sweepCache();
setInterval(sweepCache, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`\n  Muninn — SPHEREx time-domain viewer`);
  console.log(`  http://${HOST}:${PORT}\n`);
  console.log(`  Image data is read straight from the AWS mirror by the browser.`);
  console.log(`  This process relays the IRSA frame index and catalogues, and JPL's`);
  console.log(`  small-body identification, and caches the answers in .cache/`);
  console.log(baked.length
    ? `  ${baked.length} pre-resolved fields loaded: ${baked.map((b) => b.key).join(', ')}\n`
    : `  No pre-resolved fields — run "npm run bake" to make the presets open instantly.\n`);
});

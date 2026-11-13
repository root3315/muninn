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
import { readFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVOTable } from './public/js/votable.js';
import { frameFromRow } from './public/js/catalog.js';
import { COLLECTIONS } from './public/js/release.js';
import { parseCsv } from './public/js/csv.js';
import { CATALOGUES, ROW_CAP, coneQuery, renameRow } from './public/js/overlay.js';
import { sbIdentUrl, parseSbIdent } from './public/js/sbident.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const CACHE = join(ROOT, '.cache');
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const IRSA_TAP = 'https://irsa.ipac.caltech.edu/TAP/sync';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
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

async function withTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Muninn/1.0 (NASA Space Apps 2026)' } });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- caching */

const memory = new Map();
/** Answers kept in memory; the disk keeps the rest. Oldest out first. */
const MEMORY_MAX = 256;
/**
 * Distinct questions out to the archives at once. Behind a public tunnel a
 * crawler could otherwise open as many slow archive queries as it liked. One
 * field asks for its frames, two overlays, four catalogues for a marked source
 * and two ephemeris answers at a time; this leaves room for that, not for more.
 */
const INFLIGHT_MAX = 12;

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

async function queryCollectionOnce(collection, ra, dec, radius) {
  const pos = encodeURIComponent(`circle ${ra} ${dec} ${radius}`);
  const res = await withTimeout(`${SIA}?COLLECTION=${collection}&POS=${pos}&MAXREC=${MAXREC}`, UPSTREAM_TIMEOUT_MS);
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
    return queryCollectionOnce(collection, ra, dec, radius);
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
 * A question for an archive, answered from the cache, by joining the same
 * question already out, or by asking. `ask` caches its own answer, since only
 * it knows whether the answer is whole.
 */
async function relay(res, key, ask) {
  const cached = await readCache(key);
  if (cached) return json(res, 200, { ok: true, cached: true, ...cached });

  let pending = inflight.get(key);
  if (!pending && inflight.size >= INFLIGHT_MAX) {
    return json(res, 503, { ok: false, error: 'The archive relay is busy with other questions; try again in a moment.' });
  }
  if (!pending) {
    pending = ask().finally(() => inflight.delete(key));
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
  return relay(res, key, () => lookup(ra, dec, radius, key));
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
  const key = safeKey(`tap_${cat}_${field.ra.toFixed(5)}_${field.dec.toFixed(5)}_${field.radiusDeg.toFixed(5)}_${field.top}_${field.limit ?? 'all'}`);
  return relay(res, key, () => askIrsaTap(archive, field, key));
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
    magLimit: clamp(param(url, 'mag') || 20, 10, 25),
  };
  const key = safeKey(`sbid_${field.ra.toFixed(4)}_${field.dec.toFixed(4)}_${field.halfWidthDeg.toFixed(4)}_${field.iso}_${field.magLimit}`);
  return relay(res, key, () => askJpl(field, key));
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

async function serveStatic(pathname, req, res) {
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
    'cache-control': cachePolicy(rel),
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
  if (kept && kept.mtimeMs === info.mtimeMs) return kept;

  const raw = await readFile(target);
  const file = {
    mtimeMs: info.mtimeMs,
    raw,
    etag: `"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`,
  };
  if (COMPRESSIBLE.has(extname(target))) {
    file.br = brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9 } });
    file.gzip = gzipSync(raw, { level: 9 });
  }
  staticCache.set(target, file);
  return file;
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
  return 'no-cache';
}

/* ----------------------------------------------------------------------- run */

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
  try {
    if (url.pathname === '/api/search') return await handleSearch(url, res);
    if (url.pathname === '/api/tap') return await handleTap(url, res);
    if (url.pathname === '/api/sbident') return await handleSbIdent(url, res);
    if (url.pathname === '/api/targets') {
      const body = await readFile(join(PUBLIC, 'data', 'targets.json'));
      return send(res, 200, body, { 'content-type': TYPES['.json'] });
    }
    return await serveStatic(url.pathname, req, res);
  } catch (err) {
    console.error(`${req.method} ${req.url} → ${err.message}`);
    if (res.headersSent) return res.end();
    return json(res, 500, { ok: false, error: err.message });
  }
});

await loadBakedFields();

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

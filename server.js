/**
 * server.js — static host plus the one proxy the browser cannot do without.
 *
 * Image data never passes through here. SPHEREx frames come from the public
 * `nasa-irsa-spherex` S3 mirror, which answers Range requests with
 * `Access-Control-Allow-Origin: *`, so the browser reads them directly.
 *
 * What the browser cannot reach is IRSA's Simple Image Access service — the index
 * that says which frames cover a position. IRSA sends no CORS headers at all, so
 * that one call is relayed here, parsed into plain JSON, and cached on disk.
 *
 * No dependencies. `node server.js` and open the address it prints.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVOTable } from './public/js/votable.js';
import { frameFromRow } from './public/js/catalog.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const CACHE = join(ROOT, '.cache');
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const COLLECTIONS = ['spherex_qr2', 'spherex_qr2_deep'];
const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
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

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'cache-control': 'no-cache', ...headers });
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
 * Distinct positions being asked of IRSA at once. Behind a public tunnel a
 * crawler could otherwise open as many slow archive queries as it liked.
 */
const INFLIGHT_MAX = 6;

const cacheKey = (ra, dec, radius) =>
  `sia_${ra.toFixed(4)}_${dec.toFixed(4)}_${radius.toFixed(4)}`.replace(/[^\w.-]/g, '_');

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
  res.writeHead(200, { 'cache-control': 'no-cache', 'content-type': TYPES['.json'] });
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

async function handleSearch(url, res) {
  // Number(null) and Number('') are both 0: an absent coordinate would
  // otherwise be a query at the vernal equinox.
  const coord = (name) => {
    const raw = url.searchParams.get(name)?.trim();
    return raw ? Number(raw) : NaN;
  };
  const ra = coord('ra');
  // A SPHEREx frame is about 3.5° across, so a near-point cone already finds every
  // frame that can cover the field — and a wider cone costs the archive dearly.
  const dec = coord('dec');
  const radius = Math.min(0.03, Math.max(0.002, Number(url.searchParams.get('radius')) || 0.006));

  if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 360 || Math.abs(dec) > 90) {
    return json(res, 400, { ok: false, error: 'ra must be 0–360 and dec −90–90' });
  }

  const prebaked = findBaked(ra, dec);
  if (prebaked) {
    return json(res, 200, {
      ok: true, cached: 'baked', frames: prebaked.frames,
      truncated: Boolean(prebaked.truncated), warnings: [],
    });
  }

  const key = cacheKey(ra, dec, radius);
  const cached = await readCache(key);
  if (cached) return json(res, 200, { ok: true, cached: true, ...cached });

  let pending = inflight.get(key);
  if (!pending && inflight.size >= INFLIGHT_MAX) {
    return json(res, 503, { ok: false, error: 'The archive relay is busy with other positions; try again in a moment.' });
  }
  if (!pending) {
    pending = lookup(ra, dec, radius, key).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return answerSlowly(res, pending);
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

/* ------------------------------------------------- fallback byte-range relay */

/**
 * Only used when a browser cannot reach the S3 mirror directly — a corporate
 * proxy, an offline lab. Streams the same byte range with CORS attached.
 */
const FITS_RANGE_MAX = 32 * 1024 * 1024;

async function handleFits(url, req, res) {
  // Checked after parsing, not as a string prefix: "…/spherex/../../robots.txt"
  // passed a startsWith test and relayed the rest of IRSA with CORS attached.
  let target;
  try {
    target = new URL(url.searchParams.get('url') ?? '');
  } catch {
    return json(res, 400, { ok: false, error: 'Only SPHEREx archive URLs are relayed' });
  }
  const allowed = target.protocol === 'https:' && !target.username && !target.password && !target.port
    && (target.hostname === 'nasa-irsa-spherex.s3.us-east-1.amazonaws.com'
      || (target.hostname === 'irsa.ipac.caltech.edu' && target.pathname.startsWith('/ibe/data/spherex/')));
  if (!allowed) return json(res, 400, { ok: false, error: 'Only SPHEREx archive URLs are relayed' });

  // Only what the viewer itself asks for: one bounded byte range. A request
  // without one would pull a whole 70 MB file into memory here.
  const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
  if (!m || Number(m[2]) < Number(m[1]) || Number(m[2]) - Number(m[1]) >= FITS_RANGE_MAX) {
    return json(res, 400, { ok: false, error: 'A bounded byte range is required' });
  }
  const range = m[0];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  let upstream;
  let body;
  try {
    upstream = await fetch(target, { headers: { range }, redirect: 'error', signal: ctrl.signal });
    body = Buffer.from(await upstream.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
  send(res, upstream.status, body, {
    'content-type': 'application/fits',
    'access-control-allow-origin': '*',
    'accept-ranges': 'bytes',
    ...(upstream.headers.get('content-range') ? { 'content-range': upstream.headers.get('content-range') } : {}),
  });
}

/* -------------------------------------------------------------------- static */

async function serveStatic(pathname, res) {
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
  try {
    const body = await readFile(target);
    return send(res, 200, body, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
    });
  } catch {
    return send(res, 404, 'Not found');
  }
}

/* ----------------------------------------------------------------------- run */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/search') return await handleSearch(url, res);
    if (url.pathname === '/api/fits') return await handleFits(url, req, res);
    if (url.pathname === '/api/targets') {
      const body = await readFile(join(PUBLIC, 'data', 'targets.json'));
      return send(res, 200, body, { 'content-type': TYPES['.json'] });
    }
    return await serveStatic(url.pathname, res);
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
  console.log(`  This process relays the IRSA frame index and caches it in .cache/`);
  console.log(baked.length
    ? `  ${baked.length} pre-resolved fields loaded: ${baked.map((b) => b.key).join(', ')}\n`
    : `  No pre-resolved fields — run "npm run bake" to make the presets open instantly.\n`);
});

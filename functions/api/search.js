/**
 * functions/api/search.js — the one call the browser cannot make for itself,
 * as a Cloudflare Pages Function.
 *
 * Image data never passes through here, on Cloudflare or anywhere else. SPHEREx
 * frames come from the public `nasa-irsa-spherex` S3 mirror, which answers Range
 * requests with `Access-Control-Allow-Origin: *`, so the browser reads pixels
 * straight from the archive. What it cannot reach is IRSA's Simple Image Access
 * service — the index that says which frames cover a position — because IRSA
 * sends no CORS headers at all.
 *
 * This is the same relay as `server.js` uses locally, ported to the Workers
 * runtime: `fetch` and the Cache API instead of Node's http and a disk cache.
 * Both import the same parser, so there is one implementation of the format.
 *
 * The five verified fields never reach this function — their frame indexes ship
 * with the page and `catalog.js` checks them first — so a throttled or failing
 * edge function degrades to "the presets work, arbitrary coordinates do not"
 * rather than to a dead page.
 */

import { parseVOTable } from '../../public/js/votable.js';
import { frameFromRow } from '../../public/js/catalog.js';
import { COLLECTIONS } from '../../public/js/release.js';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';

/**
 * Without a cap, a cone on the deep fields returns 25 000 rows and 54 MB. The
 * edge budget is tighter than a laptop's, so this sits below the local 500; the
 * truncation is reported back to the page rather than hidden.
 */
const MAXREC = 400;
const UPSTREAM_TIMEOUT_MS = 20_000;
/** Frame indexes change when a data release does, which is not often. */
const EDGE_TTL_S = 12 * 60 * 60;

const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': status === 200 ? `public, max-age=${EDGE_TTL_S}` : 'no-store',
    ...extra,
  },
});

async function withTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Muninn/1.0 (NASA Space Apps 2026)' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function queryCollectionOnce(collection, ra, dec, radius) {
  const pos = encodeURIComponent(`circle ${ra} ${dec} ${radius}`);
  const res = await withTimeout(
    `${SIA}?COLLECTION=${collection}&POS=${pos}&MAXREC=${MAXREC}`,
    UPSTREAM_TIMEOUT_MS,
  );
  if (!res.ok) throw Object.assign(new Error(`IRSA ${collection}: HTTP ${res.status}`), { answered: true });
  const { status, message, rows } = parseVOTable(await res.text());
  if (status === 'ERROR') throw Object.assign(new Error(`IRSA ${collection}: ${message}`), { answered: true });
  return { rows, truncated: status === 'OVERFLOW' };
}

/** One more try when the connection dropped; an answer that says no is final. */
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

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  // Number(null) and Number('') are both 0; absent is not the vernal equinox.
  const coord = (name) => {
    const raw = url.searchParams.get(name)?.trim();
    return raw ? Number(raw) : NaN;
  };
  const ra = coord('ra');
  const dec = coord('dec');
  // A SPHEREx frame is about 3.5° across, so a near-point cone already finds
  // every frame that can cover the field — and a wider cone costs the archive
  // dearly for no extra frames.
  const radius = Math.min(0.03, Math.max(0.002, Number(url.searchParams.get('radius')) || 0.006));

  if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 360 || Math.abs(dec) > 90) {
    return json({ ok: false, error: 'ra must be 0–360 and dec −90–90' }, 400);
  }

  // Rounding the key is what makes the cache useful: two people opening the same
  // object round the coordinates differently and would otherwise both pay.
  const key = new Request(
    `${url.origin}/api/search?ra=${ra.toFixed(4)}&dec=${dec.toFixed(4)}&radius=${radius.toFixed(4)}`,
    { method: 'GET' },
  );
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;

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

  // Every collection failing is an outage worth reporting; one failing is a
  // partial answer worth returning with the warning attached.
  if (!rows.length && problems.length === COLLECTIONS.length) {
    return json({ ok: false, error: problems.join('; ') }, 502);
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
    return json({ ok: false, error: problems.join('; ') }, 502);
  }

  // A partial answer must not sit in the browser's cache either, or asking
  // again reads the same short list back for twelve hours.
  const res = json({
    ok: true, cached: false, frames, truncated,
    warnings: problems, queried: { ra, dec, radius },
  }, 200, problems.length ? { 'cache-control': 'no-store' } : {});
  // A partial answer is returned but not kept: a collection that timed out
  // once must not read as "no frames here" for everyone until the TTL runs out.
  if (!problems.length) waitUntil(cache.put(key, res.clone()));
  return res;
}

/**
 * What the page does when a read fails: how long it waits before asking
 * again, what it asks again for, where else it asks, how it knows an answer
 * came back short, and when a failed code load may reload the page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backoffMs, worthRetry, withRetry, pause } from '../public/js/net.js';
import { onHost, rangeProblem, S3_HOSTS } from '../public/js/ranges.js';
import { mayReload, isCodeLoadError, isOwnCode, reloadForCode, RELOAD_WINDOW_MS } from '../public/js/safety.js';
import { loadStamp } from '../public/js/stamp.js';
import { TangentGrid } from '../public/js/wcs.js';
import { syntheticFrame, serve } from './fixtures.mjs';

const fault = (props) => Object.assign(new Error('x'), props);

test('backoff grows, is capped, and is spread either way by the jitter', () => {
  const still = { random: () => 0.5 };
  assert.deepEqual([0, 1, 2, 3].map((n) => backoffMs(n, still)), [600, 1800, 5400, 8000]);
  assert.equal(backoffMs(0, { random: () => 0 }), 450);
  assert.equal(backoffMs(0, { random: () => 1 }), 750);
  assert.equal(backoffMs(-1, still), 600, 'a negative attempt is the first');
  assert.equal(backoffMs(2, { ...still, base: 100, factor: 2, cap: 300 }), 300);
});

test('worth asking again: dropped, timed out, busy, cut short; not refused or cancelled', () => {
  assert.equal(worthRetry(new TypeError('Failed to fetch')), true);
  assert.equal(worthRetry(fault({ name: 'TimeoutError' })), true);
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(worthRetry(fault({ status })), true, String(status));
  for (const status of [400, 403, 404, 416]) assert.equal(worthRetry(fault({ status })), false, String(status));
  assert.equal(worthRetry(fault({ name: 'AbortError' })), false);
  assert.equal(worthRetry(fault({ retry: true, status: 404 })), true, 'an explicit verdict wins');
  assert.equal(worthRetry(fault({ retry: false, name: 'TypeError' })), false);
  assert.equal(worthRetry(null), false);
  assert.equal(worthRetry(new Error('plain')), false);
});

test('withRetry asks until it works, keeps the answer, and waits between asks', async () => {
  const waits = [];
  let asked = 0;
  const value = await withRetry(async (attempt) => {
    asked += 1;
    if (attempt < 2) throw fault({ status: 503 });
    return 'bytes';
  }, { tries: 4, wait: (n) => n * 10, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(value, 'bytes');
  assert.equal(asked, 3);
  assert.deepEqual(waits, [0, 10]);
});

test('withRetry gives up after its tries, on a final failure, and on a cancel', async () => {
  const sleep = async () => {};
  let asked = 0;
  await assert.rejects(withRetry(async () => { asked += 1; throw fault({ status: 502 }); }, { tries: 3, sleep }), { status: 502 });
  assert.equal(asked, 3);
  asked = 0;
  await assert.rejects(withRetry(async () => { asked += 1; throw fault({ status: 404 }); }, { tries: 3, sleep }), { status: 404 });
  assert.equal(asked, 1);
  const ctrl = new AbortController();
  asked = 0;
  await assert.rejects(withRetry(async () => { asked += 1; ctrl.abort(); throw fault({ status: 502 }); }, { tries: 3, sleep, signal: ctrl.signal }));
  assert.equal(asked, 1);
});

test('a pause ends early when its signal fires', async () => {
  const ctrl = new AbortController();
  const waiting = pause(10_000, ctrl.signal);
  ctrl.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  await pause(1);
});

test('every second attempt asks the bucket under its other name; any other address as it is', () => {
  const path = '/dr1/level2/x.fits';
  const regional = `https://${S3_HOSTS[0]}${path}`;
  const global = `https://${S3_HOSTS[1]}${path}`;
  assert.equal(onHost(regional, 0), regional);
  assert.equal(onHost(regional, 1), global);
  assert.equal(onHost(regional, 2), regional);
  assert.equal(onHost(global, 1), regional);
  assert.equal(onHost('mem://frame.fits', 1), 'mem://frame.fits');
  assert.equal(onHost('https://example.org/x.fits', 1), 'https://example.org/x.fits');
});

test('a range answer must be the bytes asked for', () => {
  assert.equal(rangeProblem({ start: 100, end: 199, length: 100 }), null);
  assert.equal(rangeProblem({ start: 100, end: 199, length: 100, contentLength: '100', contentRange: 'bytes 100-199/5000' }), null);
  assert.match(rangeProblem({ start: 100, end: 199, length: 0 }), /empty/);
  assert.match(rangeProblem({ start: 100, end: 199, length: 60 }), /60 bytes for a range of 100/);
  assert.match(rangeProblem({ start: 100, end: 199, length: 60, contentLength: '100' }), /cut short: 60 of 100/);
  assert.match(rangeProblem({ start: 100, end: 199, length: 100, contentRange: 'bytes 0-99/5000' }), /wrong range/);
  // Short because the file ends there, and the server said so.
  assert.equal(rangeProblem({ start: 100, end: 199, length: 50, contentRange: 'bytes 100-149/150' }), null);
  // The last N bytes of the file.
  assert.equal(rangeProblem({ start: null, end: 5760, length: 5760 }), null);
  assert.match(rangeProblem({ start: null, end: 5760, length: 2000 }), /2000 bytes/);
});

test('a failed code load reloads once per window, and never without a guard', () => {
  assert.equal(mayReload(null, 1000), true);
  assert.equal(mayReload('', 1000), true);
  assert.equal(mayReload('1000', 1000 + RELOAD_WINDOW_MS - 1), false);
  assert.equal(mayReload('1000', 1000 + RELOAD_WINDOW_MS + 1), true);
  assert.equal(mayReload('5000', 1000), true, 'a clock set back is not a loop');
  assert.equal(mayReload('garbage', 1000), true);

  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const went = [];
  const loc = { href: 'https://muninn.example/?lang=ru#13.4,3.8', replace: (href) => went.push(href) };
  assert.equal(reloadForCode({ storage, loc, now: 10_000 }), true);
  assert.equal(went.length, 1);
  const url = new URL(went[0]);
  assert.equal(url.searchParams.get('lang'), 'ru');
  assert.ok(url.searchParams.get('fresh'), 'a cache-busting flag');
  assert.equal(url.hash, '#13.4,3.8', 'the field the link held is kept');
  assert.equal(reloadForCode({ storage, loc, now: 20_000 }), false, 'not twice in a row');
  assert.equal(went.length, 1);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => {} };
  assert.equal(reloadForCode({ storage: broken, loc, now: 10_000 }), false);
});

test('only the page\'s own code not arriving counts as a code load failure', () => {
  assert.equal(isCodeLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/js/vr/main.js?v=1')), true);
  assert.equal(isCodeLoadError(new TypeError('error loading dynamically imported module')), true);
  assert.equal(isCodeLoadError(new TypeError('Importing a module script failed.')), true);
  assert.equal(isCodeLoadError(new TypeError('Failed to fetch')), false);
  assert.equal(isCodeLoadError(undefined), false);
});

test('a script someone else put in the page failing is never a reason to reload', () => {
  const site = 'https://muninn.mydevbox.xyz';
  assert.equal(isOwnCode({ type: 'module', src: `${site}/js/app.js?v=1` }, site), true);
  assert.equal(isOwnCode({ type: 'module', src: 'js/app.js?v=1' }, site), true);
  // Cloudflare's analytics beacon, which the page's CSP refuses.
  assert.equal(isOwnCode({ type: 'module', src: 'https://static.cloudflareinsights.com/beacon.min.js/v1' }, site), false);
  assert.equal(isOwnCode({ type: '', src: 'https://static.cloudflareinsights.com/beacon.min.js/v1' }, site), false);
  assert.equal(isOwnCode({ type: '', src: `${site}/js/theme-boot.js` }, site), false);
});

/* ------------------------------------------- reads that fail, end to end */

const frame = syntheticFrame();
const grid = () => new TangentGrid(frame.ra, frame.dec, 0.09, 90, 90);

async function withFetch(fetchImpl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('a frame whose reads fail now and then, or come back short, is read whole', async () => {
  const good = serve(frame.file);
  let n = 0;
  const flaky = async (url, init) => {
    n += 1;
    // Every third read: a dropped connection, a gateway error, or half the bytes.
    if (n % 3 === 1) throw new TypeError('Failed to fetch');
    if (n % 3 === 2) return new Response('busy', { status: 503 });
    const res = await good(url, init);
    if (res.status !== 206) return res;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return new Response(bytes.slice(0, Math.max(1, bytes.length >> 1)), { status: 206, headers: { 'content-length': String(bytes.length) } });
  };
  // A reader that is flaky only on its first ask of each range: the retry must recover.
  const seen = new Set();
  const once = async (url, init) => {
    const key = init.headers.Range;
    if (!seen.has(key)) { seen.add(key); return flaky(url, init); }
    return good(url, init);
  };
  const stamp = await withFetch(once, () => loadStamp('mem://frame.fits', grid()));
  assert.ok(stamp, 'the frame is read');
  assert.equal(stamp.meta.flaggedPixels, 1);
});

test('a frame that keeps coming back short fails as not read, and never decodes the wrong bytes', async () => {
  const good = serve(frame.file);
  const short = async (url, init) => {
    const res = await good(url, init);
    if (res.status !== 206) return res;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return new Response(bytes.slice(0, bytes.length - 8), { status: 206 });
  };
  await assert.rejects(withFetch(short, () => loadStamp('mem://frame.fits', grid())), /bytes for a range of/);
});

test('bytes that are not a FITS file are refused before they reach the decoder', async () => {
  const junk = async (url, init) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    return new Response(new Uint8Array(Number(m[2]) - Number(m[1]) + 1).fill(0x3c), { status: 206 });
  };
  await assert.rejects(withFetch(junk, () => loadStamp('mem://junk.fits', grid())), /not a FITS file/);
});

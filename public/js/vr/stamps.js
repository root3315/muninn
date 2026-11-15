/**
 * stamps.js — reading a visit's pixels off the thread that draws.
 *
 * In the headset a frame that takes too long is not a stutter but a lurch, so
 * the resampling the site does in workers (stamp-worker.js, the same file) is
 * never done here on the drawing thread unless workers cannot start at all.
 * A few workers: each also waits on the network for its frame. The headset's
 * frames are cut five times wider than the site's opening view, so six at
 * once split the line six ways and the first picture waited on all of them;
 * four keep it busy without starving the first.
 */

import { loadStamp } from '../stamp.js';

const MODEST = (globalThis.navigator?.hardwareConcurrency || 4) <= 4 || (globalThis.navigator?.deviceMemory ?? 8) <= 4;
/** Frames read at once: three on a modest device (a headset), four otherwise. */
export const WORKERS = MODEST ? 3 : 4;
/** How long the first visit has the line to itself before the rest start beside it. */
export const LEAD_ALONE_MS = 6000;
const pool = { idle: [], waiting: [], count: 0, broken: false, seq: 0, crashes: 0 };
/** A worker that crashes is replaced; after this many crashes the drawing thread reads instead. */
const MAX_CRASHES = 3;
/** A read that has not answered in this long is a hung worker: it is replaced and the read fails. */
const READ_MS = 90_000;

function take() {
  if (pool.idle.length) return Promise.resolve(pool.idle.pop());
  if (pool.broken) return Promise.resolve(null);
  if (pool.count < WORKERS) {
    try {
      const w = new Worker(new URL('../stamp-worker.js', import.meta.url), { type: 'module' });
      pool.count++;
      return Promise.resolve(w);
    } catch {
      pool.broken = true;
      return Promise.resolve(null);
    }
  }
  return new Promise((resolve) => { pool.waiting.push(resolve); });
}

/** A worker gone: one waiting for it is given a new one (or the drawing thread, if they keep crashing). */
function refill() {
  const next = pool.waiting.shift();
  if (!next) return;
  take().then((w) => next(w));
}

function give(w) {
  const next = pool.waiting.shift();
  if (next) next(w);
  else pool.idle.push(w);
}

/** One visit's stamp on `grid`, or null when the frame misses the field. */
export async function readStamp(url, grid, { signal } = {}) {
  const worker = await take();
  if (signal?.aborted) { if (worker) give(worker); throw new DOMException('cancelled', 'AbortError'); }
  if (!worker) return loadStamp(url, grid, { signal });
  const id = ++pool.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settle();
      worker.terminate();
      pool.count--;
      refill();
      reject(new Error('the frame read took too long'));
    }, READ_MS);
    const settle = () => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      settle();
      give(worker);
      if (data.error) {
        const err = new Error(data.error);
        if (data.error === 'AbortError') err.name = 'AbortError';
        reject(err);
      } else {
        resolve(data.stamp);
      }
    };
    // A crash: the worker is replaced (a few times at most) and this read asked again.
    const onError = (e) => {
      e.preventDefault?.();
      settle();
      worker.terminate();
      pool.count--;
      pool.crashes += 1;
      if (pool.crashes >= MAX_CRASHES) pool.broken = true;
      refill();
      readStamp(url, grid, { signal }).then(resolve, reject);
    };
    const onAbort = () => worker.postMessage({ type: 'abort', id });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.postMessage({
      id, url,
      grid: { ra: grid.ra, dec: grid.dec, fovDeg: grid.fovDeg, width: grid.width, height: grid.height },
    });
  });
}

/**
 * Read `list` with `readOne(entry)`: `lead` first and alone, so the first
 * picture is not one of several sharing the line, until it is in, has failed
 * or has had `aloneMs`; then the rest, `readers` at a time with it.
 */
export async function readInOrder(list, lead, readOne, { readers = WORKERS, aloneMs = LEAD_ALONE_MS } = {}) {
  if (!lead || !list.includes(lead)) {
    await inPool(list, readers, (entry) => readOne(entry));
    return;
  }
  const first = Promise.resolve().then(() => readOne(lead));
  let timer = 0;
  await Promise.race([first.catch(() => {}), new Promise((r) => { timer = setTimeout(r, aloneMs); })]);
  clearTimeout(timer);
  await Promise.all([first, inPool(list.filter((e) => e !== lead), Math.max(1, readers - 1), (entry) => readOne(entry))]);
}

/** `worker(item, i)` over `items`, at most `limit` at once. */
export async function inPool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/**
 * stamps.js — reading a visit's pixels off the thread that draws.
 *
 * In the headset a frame that takes too long is not a stutter but a lurch, so
 * the resampling the site does in workers (stamp-worker.js, the same file) is
 * never done here on the drawing thread unless workers cannot start at all.
 * Two workers: the headset draws on the same processor, and the frames come
 * over the network faster than two can resample them only on a fast line.
 */

import { loadStamp } from '../stamp.js';

const WORKERS = 2;
const pool = { idle: [], waiting: [], count: 0, broken: false, seq: 0 };

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
    const settle = () => {
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
    const onError = (e) => {
      e.preventDefault?.();
      settle();
      worker.terminate();
      pool.count--;
      pool.broken = true;
      loadStamp(url, grid, { signal }).then(resolve, reject);
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

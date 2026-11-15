/**
 * A deadline for every request the page makes.
 *
 * `fetch` has no timeout of its own: a connection that stalls without closing
 * holds its place in the queue for good, the field never finishes loading and
 * nothing offers to try again. This joins the caller's own abort signal (a new
 * field was opened) with a clock.
 */
export function deadline(signal, ms) {
  const clock = AbortSignal.timeout(ms);
  if (!signal) return clock;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, clock]);
  // Before AbortSignal.any: join the two by hand.
  const ctrl = new AbortController();
  const stop = (from) => () => ctrl.abort(from.reason);
  if (signal.aborted) ctrl.abort(signal.reason);
  signal.addEventListener('abort', stop(signal), { once: true });
  clock.addEventListener('abort', stop(clock), { once: true });
  return ctrl.signal;
}

/** One byte range of a frame: a megabyte or two from S3. */
export const FRAME_DEADLINE_MS = 45_000;
/** A catalogue answer (Sesame, SkyBoT, VizieR) or one of the page's own files. */
export const CATALOG_DEADLINE_MS = 30_000;
/** The relay asking IRSA's TAP for a catalogue: the server itself waits 75 s. */
export const RELAY_DEADLINE_MS = 90_000;
/** The relay asking IRSA about a new position (the server waits 150 s), or JPL (120 s). */
export const SEARCH_DEADLINE_MS = 170_000;

/* ------------------------------------------------------------- asking again */

/**
 * The wait before ask number `attempt + 2` (0 is the wait after the first
 * failure): growing by `factor`, capped, and spread by up to `jitter` either
 * way, so that ten visits that failed together do not all come back together.
 */
export function backoffMs(attempt, { base = 600, factor = 3, cap = 8000, jitter = 0.25, random = Math.random } = {}) {
  const plain = Math.min(cap, base * factor ** Math.max(0, attempt));
  return Math.max(0, Math.round(plain * (1 + jitter * (2 * random() - 1))));
}

/**
 * Whether a failure is worth asking again for: a dropped connection, a
 * timeout, a busy or broken gateway, or an answer that arrived short. A
 * refusal (403, 404, 416) and a cancelled read are final.
 */
export function worthRetry(err) {
  if (!err || err.name === 'AbortError') return false;
  if (err.retry === false) return false;
  if (err.retry === true) return true;
  if (Number.isInteger(err.status)) return err.status === 408 || err.status === 429 || err.status >= 500;
  // fetch's own network failure is a TypeError; a deadline is a TimeoutError.
  return err.name === 'TypeError' || err.name === 'TimeoutError';
}

const aborted = (signal) => signal.reason ?? new DOMException('Aborted', 'AbortError');

/** A wait that ends early, rejecting with the signal's reason, when the signal fires. */
export function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted(signal)); return; }
    const stop = () => { clearTimeout(timer); reject(aborted(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * `task(attempt)` asked up to `tries` times, waiting `backoffMs` between, for
 * as long as the failure is worth another ask and the caller has not
 * cancelled. The last failure is thrown; a caller's cancel is never retried.
 */
export async function withRetry(task, { tries = 3, signal, worth = worthRetry, wait = backoffMs, sleep = pause } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task(attempt);
    } catch (err) {
      if (signal?.aborted || attempt + 1 >= tries || !worth(err)) throw err;
      await sleep(wait(attempt), signal);
    }
  }
}

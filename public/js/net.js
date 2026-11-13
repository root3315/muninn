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

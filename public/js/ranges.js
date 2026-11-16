/**
 * ranges.js — what a byte-range read of a frame may come back as, and where
 * else to ask for it.
 *
 * The bucket answers under two names, its regional one and the global one.
 * They are the same objects behind different front doors, so a read that
 * failed at one is asked at the other the next time round.
 *
 * A read that arrives short is the dangerous case: decoded as it is, the
 * missing bytes would be other detector rows or no rows at all. The answer's
 * length is checked against what was asked for and against what the answer
 * itself says it carries; Content-Range is not exposed to the page by the
 * bucket's CORS rules, Content-Length is.
 *
 * Where the page is served by its own server, a frame is read through it
 * (server.js, /api/frame), which keeps every range it has read on disk: a
 * field opened before opens from there, without the trip to AWS. Any failure
 * of that read is a read of the bucket instead, at once, so the server is a
 * shortcut and never a new way to fail; and a static host, which has no such
 * route, costs one unanswered question per page and nothing after.
 */

export const S3_HOSTS = ['nasa-irsa-spherex.s3.us-east-1.amazonaws.com', 'nasa-irsa-spherex.s3.amazonaws.com'];

/** The same address at the bucket's other name on every second attempt; any other address as it is. */
export function onHost(url, attempt) {
  let u;
  try { u = new URL(url); } catch { return url; }
  const at = S3_HOSTS.indexOf(u.hostname);
  if (at < 0 || attempt % 2 === 0) return url;
  u.hostname = S3_HOSTS[(at + 1) % S3_HOSTS.length];
  return u.href;
}

/**
 * What is wrong with a 206 answer to `bytes=start-end` (or, with `start`
 * null, to the last `end` bytes), or null when it is the bytes asked for.
 * Every read Muninn makes lies inside the file, so the answer must be
 * exactly as long as the range.
 */
export function rangeProblem({ start, end, length, contentLength = null, contentRange = null }) {
  const want = start === null ? end : end - start + 1;
  if (!(length > 0)) return 'empty answer';
  if (contentLength !== null && contentLength !== '' && Number(contentLength) !== length) {
    return `cut short: ${length} of ${contentLength} bytes`;
  }
  const said = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(contentRange ?? '').trim());
  if (said) {
    const [from, to, total] = [Number(said[1]), Number(said[2]), Number(said[3])];
    if (start !== null && from !== start) return `wrong range: ${from}-${to} for ${start}-${end}`;
    if (to - from + 1 !== length) return `cut short: ${length} of ${to - from + 1} bytes`;
    // Short only because the file ends there: the server said so.
    if (length < want && to === total - 1) return null;
  }
  if (length !== want) return `${length} bytes for a range of ${want}`;
  return null;
}

/**
 * The page's own frame relay: beside the site's js/ folder, so the same
 * address works from the page, its workers and the headset page. None when
 * the code is not served over HTTP (the tools in Node read the bucket).
 */
function ownRelay() {
  try {
    const at = new URL('../api/frame', import.meta.url);
    return at.protocol === 'http:' || at.protocol === 'https:' ? at.href : null;
  } catch {
    return null;
  }
}

let relay = ownRelay();
let relayOnly = false;

/**
 * Read frames through the relay at `address` (null: straight from the
 * bucket). With `fallback: false` a failed read is a failure, not a read of
 * the bucket: for the warm-up, which is there to fill the relay's disk.
 */
export function useFrameRelay(address, { fallback = true } = {}) {
  relay = address;
  relayOnly = Boolean(address) && !fallback;
}

/** The relay's address for a frame on the bucket, or null for any other address, or when there is no relay. */
export function relayedUrl(url) {
  if (!relay) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!S3_HOSTS.includes(u.hostname) || u.search || u.hash) return null;
  return `${relay}?path=${encodeURIComponent(decodeURIComponent(u.pathname.slice(1)))}`;
}

/**
 * One range read of a frame, `init` as for fetch. The first attempt goes
 * through the relay when there is one; whatever goes wrong there (no
 * answer, a refusal, a busy relay, the bucket not answering it) is asked of
 * the bucket in the same attempt. Every later attempt is the bucket's (see
 * onHost). An answer without the relay's mark is a host that has none, and
 * the relay is not asked again in this page.
 */
export async function fetchFrame(url, init = {}, attempt = 0, fetcher = (...args) => fetch(...args)) {
  const via = attempt === 0 || relayOnly ? relayedUrl(url) : null;
  if (!via) return fetcher(url, init);
  if (relayOnly) return fetcher(via, init);
  try {
    const res = await fetcher(via, init);
    if (res.status === 206) return res;
    if (!res.headers.get('x-muninn-frame')) relay = null;
    res.body?.cancel?.().catch?.(() => {});
  } catch (err) {
    if (init.signal?.aborted) throw err;
  }
  return fetcher(url, init);
}

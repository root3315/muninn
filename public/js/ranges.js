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

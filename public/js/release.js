/**
 * release.js — which SPHEREx data release this tool reads.
 *
 * IRSA publishes each SPHEREx release as its own SIA collection, and the
 * pixels behind every collection sit on the same public S3 mirror. So moving
 * to a new release is this one list: the server relay, the edge function and
 * the bake script all read it, and nothing else names a release.
 *
 * After changing it: `npm run bake` refreshes the frame indexes that ship
 * with the page, `npm test` checks the pipeline, and a deploy publishes both.
 */
export const COLLECTIONS = ['spherex_dr1', 'spherex_dr1_deep', 'spherex_qr3', 'spherex_qr3_deep'];

/** The size of one Level-2 spectral image file at the archive, in megabytes. */
export const FRAME_FILE_MB = 65.4;

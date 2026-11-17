/**
 * datafiles.js — the site's own data files, asked for under names the edge keeps.
 *
 * A data file is asked for under its hashed name (datanames.js, written by
 * tools/name-data.mjs), which Cloudflare keeps at its edge for good, so a
 * visit does not wait on the tunnel to the box for it. Where that name is not
 * answered (a static host without the server's aliases, a copy of the site
 * whose data moved on since the names were written), the plain name is asked
 * instead: the hash is a shortcut, never the only way to the file.
 */
import { DATA_NAMES, FIELD_LIST, BAKED_FIELDS } from './datanames.js';

export { FIELD_LIST, BAKED_FIELDS };

/** The name to ask for a data file under: its hashed one where it has one. */
export const dataUrl = (path) => DATA_NAMES[path] ?? path;

/**
 * fetch() for a data file under its hashed name, falling back to the plain
 * one. A static host may answer an unknown name with its own page and a 200,
 * so only an answer that is not HTML counts.
 */
export async function fetchData(path, init) {
  const named = DATA_NAMES[path];
  if (named) {
    try {
      const res = await fetch(named, init);
      if (res.ok && !(res.headers.get('content-type') ?? '').includes('html')) return res;
    } catch (err) {
      if (init?.signal?.aborted) throw err;
    }
  }
  return fetch(path, init);
}

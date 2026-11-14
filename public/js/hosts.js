/**
 * The stars known to have planets, for the search box: "TRAPPIST" offers
 * TRAPPIST-1 and its seven planets, and "TRAPPIST-1 e" is the same star.
 *
 * The list is public/data/planet-hosts.json, rows of [ra, dec, planets, name,
 * letters] from the NASA Exoplanet Archive (tools/planet-hosts.mjs). It is
 * indexed once, sorted by a folded key, so that a keystroke is a binary
 * search and a walk over the names that start with what was typed, never a
 * pass over all of them.
 */

import { fold } from './suggest.js';

/** The key a name is found by: folded, with spaces, hyphens, dots and quotes gone. */
export const hostKey = (text) => fold(text).replace(/[\s·.'’()_-]+/g, '');

/** Shorter keys than this would match a large part of the list, and say nothing. */
const MIN_KEY = 2;

/**
 * @param {Array} rows  planet-hosts.json's `hosts`
 * @returns {{keys: string[], hosts: object[], byKey: Map<string, object>}}
 */
export function indexHosts(rows = []) {
  const hosts = [];
  for (const [ra, dec, planets, name, letters = ''] of rows) {
    if (!name || !Number.isFinite(ra) || !Number.isFinite(dec)) continue;
    hosts.push({ key: hostKey(name), name, ra, dec, planets: planets || letters.length || 1, letters });
  }
  hosts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { keys: hosts.map((h) => h.key), hosts, byKey: new Map(hosts.map((h) => [h.key, h])) };
}

/** The first place in the sorted keys at or after `q`. */
function lowerBound(keys, q) {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < q) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * A planet's name read as its star and letter: "TRAPPIST-1 e", "Kepler-22b",
 * "kepler 22 b". Null unless the star is on the list and has that planet.
 */
export function planetOf(text, index) {
  const m = /^(.*?)[\s-]*([b-z])$/.exec(fold(text));
  if (!m || !m[1]) return null;
  const host = index.byKey.get(hostKey(m[1]));
  return host && host.letters.includes(m[2]) ? { host, letter: m[2] } : null;
}

/**
 * The rows for what has been typed: a planet first when the text names one,
 * then the stars whose names start with it, the exact name first and then
 * the shortest names (TRAPPIST-1 before TRAPPIST-1 b's neighbours in the
 * list). Rows are `{kind: 'host', label, planets, ra, dec, ref}`.
 */
export function hostRows(text, index, max = 8) {
  if (!index || max <= 0) return [];
  const out = [];
  const planet = planetOf(text, index);
  if (planet) {
    const { host, letter } = planet;
    out.push({
      kind: 'host', label: `${host.name} ${letter}`, host: host.name,
      planets: host.planets, ra: host.ra, dec: host.dec, ref: host,
    });
  }
  const q = hostKey(text);
  if (q.length < MIN_KEY) return out.slice(0, max);
  const start = lowerBound(index.keys, q);
  // Every key from `start` on that starts with `q`: a run in the sorted list.
  const run = [];
  for (let i = start; i < index.keys.length && index.keys[i].startsWith(q); i++) run.push(index.hosts[i]);
  run.sort((a, b) => a.key.length - b.key.length || (a.key < b.key ? -1 : 1));
  for (const host of run) {
    if (out.length >= max) break;
    out.push({ kind: 'host', label: host.name, planets: host.planets, ra: host.ra, dec: host.dec, ref: host });
  }
  return out;
}

let loading = null;

/** The index, fetched and built once per page. An empty one if the file is missing. */
export function loadHostIndex(fetcher = fetch) {
  loading ??= fetcher('data/planet-hosts.json')
    .then((r) => (r.ok ? r.json() : { hosts: [] }))
    .then((body) => indexHosts(body.hosts ?? []))
    .catch(() => { loading = null; return indexHosts([]); });
  return loading;
}

/**
 * The own frame index against IRSA itself: for a handful of positions, the
 * frames the index lists must be the frames IRSA's SIA lists, file for file.
 *
 * Needs a built index and the network, so it runs only when asked:
 *
 *   MUNINN_COMPARE_IRSA=1 node --test tests/frame-index-irsa.test.mjs
 *
 * with the index in MUNINN_INDEX_DIR or .index/. A collection IRSA does not
 * answer for is skipped, not failed. Frames IRSA lists past the index's last
 * exposure (published after it was built) are left out of the comparison.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchIndex } from '../public/js/frameindex.js';
import { parseCsv } from '../public/js/csv.js';
import { COLLECTIONS } from '../public/js/release.js';

const DIR = process.env.MUNINN_INDEX_DIR || fileURLToPath(new URL('../.index', import.meta.url));
const RUN = process.env.MUNINN_COMPARE_IRSA === '1';

let meta = null;
try { meta = JSON.parse(await readFile(join(DIR, 'meta.json'), 'utf8')); } catch { /* not built */ }
const skip = !RUN ? 'set MUNINN_COMPARE_IRSA=1 to compare with IRSA' : !meta ? `no index in ${DIR}` : false;

const readCell = async (id) => {
  try {
    return JSON.parse(gunzipSync(await readFile(join(DIR, 'tiles', id.split('-')[0], `${id}.json.gz`))).toString('utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
};

/** IRSA's whole list for one collection, as the relay reads it: calibrated science frames. */
async function irsaFiles(collection, ra, dec, radius) {
  const pos = encodeURIComponent(`circle ${ra} ${dec} ${radius}`);
  const url = `https://irsa.ipac.caltech.edu/SIA?COLLECTION=${collection}&POS=${pos}&MAXREC=100000&RESPONSEFORMAT=csv`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (res.ok) {
        return parseCsv(await res.text())
          .filter((r) => r.dataproduct_subtype === 'science' && Number(r.calib_level) >= 2)
          .map((r) => ({ url: r.access_url, mjd: Number(r.t_min) }));
      }
    } catch { /* asked again */ }
    await new Promise((r) => { setTimeout(r, 3000 * (attempt + 1)); });
  }
  return null;
}

const POSITIONS = [
  ['Atala', 13.4194, 3.8459, 0.006],
  ["Barnard's star", 269.452, 4.6933, 0.006],
  ['north celestial pole', 45, 89.99, 0.006],
  ['south ecliptic pole', 90, -66.5607, 0.006],
  ['RA 0', 0.0004, -20.5, 0.006],
  ['RA 360', 359.9996, -20.5, 0.006],
  ['high Dec, a wide cone', 150, 78.3, 0.03],
];

for (const [name, ra, dec, radius] of POSITIONS) {
  test(`own index lists what IRSA lists: ${name}`, { skip, timeout: 15 * 60_000 }, async (t) => {
    const lastMjd = Date.parse(meta.lastExposure) / 86400000 + 40587;
    for (const collection of COLLECTIONS) {
      const irsa = await irsaFiles(collection, ra, dec, radius);
      if (!irsa) { t.diagnostic(`${collection}: IRSA did not answer`); continue; }
      const theirs = irsa.filter((f) => f.mjd <= lastMjd).map((f) => f.url).sort();
      const ours = (await searchIndex(readCell, meta, collection, ra, dec, radius)).map((f) => f.url).sort();
      t.diagnostic(`${collection}: IRSA ${theirs.length}, index ${ours.length}`);
      assert.deepEqual(ours, theirs, `${name}, ${collection}`);
    }
  });
}

// One real SPHEREx frame for each deep-sky object marked on the sky map and
// for each star the map names, so its card can show it as SPHEREx saw it. A
// bright star saturates the detector: its core comes out masked, and that is
// what the picture shows.
//
//   node tools/bake-sky-thumbs.mjs          every object in data/sky/deepsky.json
//   node tools/bake-sky-thumbs.mjs M31 M42  only these
//
// For each object the archive is asked which frames cover it; the first D2
// visit that covers the whole picture and is not mostly masked is kept. An
// object SPHEREx has not reached, or whose frames are all masked, gets no
// picture: its card then shows what is known and no image. Run again after a
// data release with --all; otherwise objects already done are skipped unless
// named.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseVOTable } from '../public/js/votable.js';
import { frameFromRow, groupVisits, toS3 } from '../public/js/catalog.js';
import { COLLECTIONS } from '../public/js/release.js';
import { loadStamp } from '../public/js/stamp.js';
import { TangentGrid } from '../public/js/wcs.js';
import { SIZE, seenFraction, toPNG } from './thumb.mjs';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const RADIUS = 0.006;
const BAND = 'D2';
/** Six arcminutes: a globular or a galaxy's core, with sky around it. */
const FOV_DEG = 0.1;
const AT_ONCE = 3;

const root = new URL('../public/', import.meta.url);
const { objects } = JSON.parse(await readFile(new URL('data/sky/deepsky.json', root), 'utf8'));
const indexUrl = new URL('data/sky/thumbs.json', root);
const index = await readFile(indexUrl, 'utf8').then(JSON.parse, () => ({}));
await mkdir(new URL('img/sky/', root), { recursive: true });
const all = process.argv.includes('--all');
const only = process.argv.slice(2).filter((a) => a !== '--all');

// The named stars have no catalogue id of their own here; their place on the
// sky, to a hundredth of a degree, is the key the page looks them up by.
const stars = JSON.parse(await readFile(new URL('data/sky/stars.json', root), 'utf8'));
const named = stars.named.map(({ i }) => ({
  id: `s${stars.ra[i].toFixed(2)}_${stars.dec[i].toFixed(2)}`, ra: stars.ra[i], dec: stars.dec[i],
}));

async function framesAt(ra, dec) {
  const pos = encodeURIComponent(`circle ${ra} ${dec} ${RADIUS}`);
  const frames = [];
  for (const collection of COLLECTIONS) {
    const res = await fetch(`${SIA}?COLLECTION=${collection}&POS=${pos}&MAXREC=300`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`IRSA answered ${res.status}`);
    const { status, message, rows } = parseVOTable(await res.text());
    if (status === 'ERROR') throw new Error(message);
    for (const row of rows) {
      if (row.dataproduct_subtype !== 'science' || Number(row.calib_level) < 2) continue;
      const frame = frameFromRow(row);
      if (frame?.url) frames.push(frame);
    }
  }
  return frames;
}

async function bake(object) {
  const frames = await framesAt(object.ra, object.dec);
  const visits = groupVisits(frames, { ra: object.ra, dec: object.dec, band: BAND });
  const grid = new TangentGrid(object.ra, object.dec, FOV_DEG, SIZE, SIZE);
  for (const visit of visits.slice(0, 5)) {
    const stamp = await loadStamp(toS3(visit.url), grid, { minCoverage: 0.97 }).catch(() => null);
    if (!stamp || seenFraction(stamp) < 0.9) continue;
    await writeFile(new URL(`img/sky/${object.id}.png`, root), toPNG(stamp));
    return { iso: visit.iso.slice(0, 19), band: BAND, fovArcmin: FOV_DEG * 60, visits: visits.length };
  }
  return null;
}

const queue = [...objects, ...named].filter((o) => (only.length ? only.includes(o.id) : all || !index[o.id]));
let done = 0;
async function worker() {
  for (let object = queue.shift(); object; object = queue.shift()) {
    try {
      const made = await bake(object);
      if (made) index[object.id] = made;
      console.log(`${object.id}: ${made ? `${made.iso.slice(0, 10)}, ${made.visits} visits` : 'no usable frame'}`);
    } catch (err) {
      console.warn(`${object.id}: ${err.message}`);
    }
    // Written as it goes: a run cut short keeps what it has.
    if (++done % 5 === 0) await writeFile(indexUrl, `${JSON.stringify(index, null, 1)}\n`);
  }
}
await Promise.all(Array.from({ length: AT_ONCE }, worker));
await writeFile(indexUrl, `${JSON.stringify(index, null, 1)}\n`);

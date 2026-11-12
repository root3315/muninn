// One real SPHEREx frame per ready field, as a small PNG for the card the sky
// map shows before a field is opened.
//
//   node tools/bake-thumbs.mjs            all fields in public/data/targets.json
//   node tools/bake-thumbs.mjs atala m51  only these
//
// Each picture is read the way the page reads a frame: byte ranges from the
// public S3 mirror, reprojected north-up, the pipeline's flags masked. Which
// exposure it is goes into public/data/thumbs.json, so the card can say so.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadStamp } from '../public/js/stamp.js';
import { TangentGrid } from '../public/js/wcs.js';
import { toS3, groupVisits } from '../public/js/catalog.js';
import { SIZE, seenFraction, toPNG } from './thumb.mjs';

/** A fifth of the field the target opens at: the object fills the picture. */
const ZOOM = 5;
/** A field where one visit is the story is shown on that visit. */
const PREFER = { atala: '2025-12-25' };
/** And a second visit to blink it against: the same place, a week on. */
const BLINK = { atala: '2026-01-01' };


const root = new URL('../public/', import.meta.url);
const { targets } = JSON.parse(await readFile(new URL('data/targets.json', root), 'utf8'));
const only = process.argv.slice(2);
const indexUrl = new URL('data/thumbs.json', root);
const index = await readFile(indexUrl, 'utf8').then(JSON.parse, () => ({}));
await mkdir(new URL('img/fields/', root), { recursive: true });

/** The preferred visit first, then from the middle of the run outward. */
function inOrder(visits, prefer) {
  const mid = Math.floor(visits.length / 2);
  const rest = visits.map((v, i) => [Math.abs(i - mid), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const first = prefer ? visits.filter((v) => v.iso.startsWith(prefer)) : [];
  return [...first, ...rest.filter((v) => !first.includes(v))];
}

for (const target of targets) {
  if (only.length && !only.includes(target.key)) continue;
  const field = JSON.parse(await readFile(new URL(`data/fields/${target.key}.json`, root), 'utf8'));
  const band = target.band === 'all' ? 'D2' : target.band;
  const fovDeg = target.fov / ZOOM;
  const grid = new TangentGrid(target.ra, target.dec, fovDeg, SIZE, SIZE);
  const visits = groupVisits(field.frames, { ra: target.ra, dec: target.dec, band });

  let done = false;
  for (const visit of inOrder(visits, PREFER[target.key]).slice(0, 12)) {
    try {
      const stamp = await loadStamp(toS3(visit.url), grid, { minCoverage: 0.97 });
      if (!stamp) continue;
      // A frame mostly masked by its own flags (a saturating star) is no picture.
      if (seenFraction(stamp) < 0.9) continue;
      const png = toPNG(stamp);
      await writeFile(new URL(`img/fields/${target.key}.png`, root), png);
      index[target.key] = { iso: visit.iso.slice(0, 19), band, fovArcmin: Math.round(fovDeg * 600) / 10 };
      console.log(`${target.key}: ${visit.iso.slice(0, 10)} ${band}, ${(png.length / 1024).toFixed(0)} KB`);
      done = true;
      break;
    } catch (err) {
      console.warn(`${target.key}: ${visit.iso.slice(0, 10)} not read (${err.message})`);
    }
  }
  if (!done) console.warn(`${target.key}: no visit covers the field; no picture written`);

  const other = done && BLINK[target.key] ? visits.find((v) => v.iso.startsWith(BLINK[target.key])) : null;
  if (other) {
    const stamp = await loadStamp(toS3(other.url), grid, { minCoverage: 0.97 });
    if (stamp) {
      await writeFile(new URL(`img/fields/${target.key}-2.png`, root), toPNG(stamp));
      index[target.key].blink = other.iso.slice(0, 19);
      console.log(`${target.key}: blink against ${other.iso.slice(0, 10)}`);
    }
  }
}

await writeFile(indexUrl, `${JSON.stringify(index, null, 1)}\n`);

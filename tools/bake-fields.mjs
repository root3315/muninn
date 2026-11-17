#!/usr/bin/env node
/**
 * bake-fields.mjs — keep the ready-made fields' pixels beside the page, so a
 * preset draws at once instead of reading ten 70 MB files by byte ranges.
 *
 *   node tools/bake-fields.mjs [--server http://127.0.0.1:5208] [--only atala,wise0855]
 *        [--bands D2,D6 | --bands own] [--max 20] [--at-once 2]
 *
 * For each field in targets.json, and each band asked for (its own band by
 * default), the visits are taken from the field's bundled frame list
 * (data/fields/<key>.json) in the order the page reads them: the opening ten
 * spread over the baseline with the card's own night, then the widest gap
 * first (visits.js). The first --max of them are read as the page reads them
 * (stamp.js readSource, through the server's frame relay when one is named,
 * else from the bucket) for the widest grid the page draws, and each is kept
 * as data/fields/<key>/<band>/<obsId>_<hash>.bin with an entry in that
 * folder's manifest.json; see fieldstore.js for the format.
 *
 * Every visit is checked as it is kept: put on the grid from the kept file
 * and from the read itself, and the two compared pixel by pixel, in their
 * detector noise, and in what a mark measures on the brightest sources in
 * the field (SkyView.measure: centroid, flux, magnitude, SNR). The numbers
 * go into the manifest; tests/fieldstore.test.mjs measures the kept files
 * again and holds them to the live numbers recorded here.
 *
 * Safe to stop and run again: a visit whose file is already there under the
 * same frame is kept as it is. A frame list that has moved on (a new visit,
 * a new version of a file) is picked up by running it again.
 */
import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { groupVisits, findHeldVisit, toS3 } from '../public/js/catalog.js';
import { readSource, resampleSource, loadWaveTable } from '../public/js/stamp.js';
import { useFrameRelay } from '../public/js/ranges.js';
import { spread, nextVisits, VISITS_PER_BATCH } from '../public/js/visits.js';
import { cropSource, encodeVisit, decodeVisit, widestGrid, KEEP_MARGIN, KEPT_CARD, FIELD_FORMAT } from '../public/js/fieldstore.js';
import { SkyView } from '../public/js/sky.js';
import { dataLength } from '../public/js/fits.js';

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const ROOT = new URL('../public/', import.meta.url);
const SERVER = option('server', '').replace(/\/+$/, '');
const ONLY = option('only', '').split(',').map((k) => k.trim()).filter(Boolean);
const BANDS = option('bands', 'own').split(',').map((b) => b.trim()).filter(Boolean);
const MAX = Math.max(1, Number(option('max', 20)) || 20);
const AT_ONCE = Math.max(1, Math.min(4, Number(option('at-once', 2)) || 2));

/** The visits in the order the page reads them, opening batch first. */
function pageOrder(visits, lead) {
  const chosen = spread(visits, VISITS_PER_BATCH);
  if (visits[lead] && !chosen.includes(visits[lead])) chosen.push(visits[lead]);
  const order = chosen.slice().sort((a, b) => a.mjd - b.mjd);
  for (;;) {
    const [next] = nextVisits(visits, order, 1);
    if (!next) return order;
    order.push(next);
  }
}

/* ----------------------------------------------------------------- checks */

/**
 * Sources to measure, as sky positions: the brightest separate, unsaturated
 * peaks (where half precision loses most, in absolute terms) and as many
 * faint ones, 8 to 30 times the noise (where a mark's verdict is decided).
 */
function sourcesToCheck(stamp, grid, count = 5) {
  const { data, quality, width: W, height: H } = stamp;
  const sigma = stamp.meta.detectorSigma;
  const edge = 24;
  const peaks = [];
  for (let j = edge; j < H - edge; j++) {
    for (let i = edge; i < W - edge; i++) {
      const v = data[j * W + i];
      if (!(v === v) || quality[j * W + i]) continue;
      if (v < data[j * W + i - 1] || v < data[j * W + i + 1] || v < data[(j - 1) * W + i] || v < data[(j + 1) * W + i]) continue;
      peaks.push([v, i, j]);
    }
  }
  peaks.sort((a, b) => b[0] - a[0]);
  const sky = peaks.length ? peaks[peaks.length >> 1][0] : 0;
  const kept = [];
  const take = (list) => {
    let n = 0;
    for (const [, i, j] of list) {
      if (kept.some(([a, b]) => Math.hypot(a - i, b - j) < 20)) continue;
      kept.push([i, j]);
      if (++n === count) return;
    }
  };
  take(peaks);
  take(peaks.filter(([v]) => v - sky > 8 * sigma && v - sky < 30 * sigma));
  return kept.map(([i, j]) => grid.indexToWorld(i, j));
}

const view = (grid) => ({ grid });
const measured = (grid, stamp, frame, [ra, dec]) => {
  const m = SkyView.prototype.measure.call(view(grid), { stamp, frame }, ra, dec);
  return m && { ra: m.ra, dec: m.dec, flux: m.flux, mag: m.mag, snr: m.snr, noise: m.noise, saturated: Boolean(m.saturated) };
};

/** Live against kept, on the same grid: pixels in noise, the noise itself, and marks. */
function compare(live, kept, grid, frame) {
  const sigma = live.meta.detectorSigma;
  let worst = 0;
  let sum = 0;
  let n = 0;
  let holes = 0;
  for (let k = 0; k < live.data.length; k++) {
    const a = live.data[k];
    const b = kept.data[k];
    if ((a === a) !== (b === b)) { holes += 1; continue; }
    if (!(a === a)) continue;
    const d = Math.abs(a - b) / sigma;
    if (d > worst) worst = d;
    sum += d * d;
    n += 1;
  }
  const quality = live.quality.every((q, k) => q === kept.quality[k]);
  return {
    pixelRmsSigma: Math.sqrt(sum / Math.max(1, n)),
    pixelMaxSigma: worst,
    holesDiffer: holes,
    qualitySame: quality,
    detectorSigma: { live: sigma, kept: kept.meta.detectorSigma },
    flaggedPixels: { live: live.meta.flaggedPixels, kept: kept.meta.flaggedPixels },
    marks: sourcesToCheck(live, grid).map((at) => ({ at, live: measured(grid, live, frame, at), kept: measured(grid, kept, frame, at) })),
  };
}

/* ------------------------------------------------------------------- work */

const plainCards = (cards) => [...cards].filter(([k]) => KEPT_CARD.test(k));

async function bakeVisit(frame, grid, dir) {
  const url = toS3(frame.url);
  const src = await readSource(url, grid, { margin: 1 + KEEP_MARGIN });
  // Only a frame that misses the widest grid altogether misses every grid
  // inside it; one that covers too little of it is kept all the same, and
  // the page's own grid decides, as it would live.
  const live = src && resampleSource(src, grid, { minCoverage: 0 });
  if (!live) return { url: frame.url, obsId: frame.obsId, band: frame.band, mjd: frame.mjd, none: true };
  const crop = cropSource(src, grid);
  const { bytes, offset, scale } = encodeVisit(crop);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const file = `${frame.obsId}_${frame.band}_${hash.slice(0, 10)}.bin`;
  await writeFile(new URL(file, dir), bytes);
  const waveTable = await loadWaveTable(url).catch(() => null);
  const entry = {
    url: frame.url, obsId: frame.obsId, band: frame.band, mjd: frame.mjd,
    file, bytes: bytes.byteLength, sha256: hash,
    nx: src.nx, ny: src.ny, rowFrom: crop.rowFrom, rows: crop.rows, colFrom: crop.colFrom, cols: crop.cols,
    offset, scale, flags: Boolean(crop.flags),
    maskedPerRow: crop.maskedPerRow ? Array.from(crop.maskedPerRow) : null,
    dataStart: src.dataStart, dataBytes: src.dataBytes ?? dataLength(src.cards),
    cards: plainCards(src.cards),
    waveTable: waveTable && { x: waveTable.x, y: waveTable.y, nx: waveTable.nx, ny: waveTable.ny, values: Array.from(waveTable.values) },
    archiveBytes: src.bytesRead,
  };
  const kept = resampleSource(decodeVisit(entry, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), grid, { minCoverage: 0 });
  entry.coverage = live.coverage;
  entry.check = compare(live, kept, grid, frame);
  return entry;
}

const exists = (url) => stat(url).then(() => true, () => false);

async function bakeField(target, band, thumbs) {
  const index = JSON.parse(await readFile(new URL(`data/fields/${target.key}.json`, ROOT), 'utf8'));
  const visits = groupVisits(index.frames, { ra: target.ra, dec: target.dec, band });
  const thumb = thumbs[target.key];
  const leadMjd = thumb?.iso ? Date.parse(`${thumb.iso}Z`) / 86400000 + 40587 : NaN;
  const lead = Number.isFinite(leadMjd) ? findHeldVisit(visits, { mjd: leadMjd, band: thumb.band }) : -1;
  const wanted = pageOrder(visits, lead).slice(0, MAX);
  const fov = target.fov ?? 0.3;
  const grid = widestGrid(target.ra, target.dec, fov);

  const dir = new URL(`data/fields/${target.key}/${band}/`, ROOT);
  await mkdir(dir, { recursive: true });
  const manifestAt = new URL('manifest.json', dir);
  const before = await readFile(manifestAt, 'utf8').then(JSON.parse, () => null);
  const kept = new Map();
  for (const e of before?.format === FIELD_FORMAT ? before.visits : []) {
    if (e.none || await exists(new URL(e.file, dir))) kept.set(e.url, e);
  }

  const entries = new Map();
  const queue = wanted.filter((v) => {
    if (kept.has(v.url)) { entries.set(v.url, kept.get(v.url)); return false; }
    return true;
  });
  let failed = 0;
  const save = async () => {
    const visitsOut = wanted.map((v) => entries.get(v.url)).filter(Boolean);
    const manifest = {
      format: FIELD_FORMAT,
      key: target.key, band, ra: target.ra, dec: target.dec, fov,
      baked: new Date().toISOString().slice(0, 10),
      from: 'IRSA SPHEREx Level 2 (nasa-irsa-spherex on AWS)',
      grid: { ra: grid.ra, dec: grid.dec, fovDeg: grid.fovDeg, width: grid.width, height: grid.height },
      visitsInList: visits.length,
      visits: visitsOut,
    };
    await writeFile(manifestAt, `${JSON.stringify(manifest)}\n`);
    return manifest;
  };
  await Promise.all(Array.from({ length: AT_ONCE }, async () => {
    for (let v = queue.shift(); v; v = queue.shift()) {
      try {
        const entry = await bakeVisit(v, grid, dir);
        entries.set(v.url, entry);
        const c = entry.check;
        console.log(`  ${v.obsId} ${v.band}: ${entry.none ? 'off the field'
          : `${(entry.bytes / 1024).toFixed(0)} KB, pixels ${c.pixelRmsSigma.toExponential(1)}σ rms / ${c.pixelMaxSigma.toExponential(1)}σ max`}`);
        await save();
      } catch (err) {
        failed += 1;
        console.log(`  ${v.obsId} ${v.band}: ${err.message}`);
      }
    }
  }));
  const manifest = await save();
  // Files of visits no longer kept (a frame replaced by a newer version) go.
  const named = new Set(manifest.visits.map((e) => e.file).filter(Boolean));
  for (const name of await readdir(dir)) {
    if (name.endsWith('.bin') && !named.has(name)) await unlink(new URL(name, dir));
  }
  const bytes = manifest.visits.reduce((s, e) => s + (e.bytes ?? 0), 0);
  const manifestBytes = (await stat(manifestAt)).size;
  console.log(`${target.key} ${band}: ${manifest.visits.length} of ${visits.length} visits, `
    + `${((bytes + manifestBytes) / 2 ** 20).toFixed(1)} MB${failed ? `, ${failed} failed` : ''}`);
  return { visits: manifest.visits.length, bytes: bytes + manifestBytes, date: manifest.baked, failed };
}

/** The list the page asks first: which fields and bands have kept pixels, where, and of when. */
async function writeIndex() {
  const out = {};
  const root = new URL('data/fields/', ROOT);
  const folders = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const key of folders) {
    const dir = new URL(`${key}/`, root);
    for (const band of (await readdir(dir)).sort()) {
      const manifest = await readFile(new URL(`${band}/manifest.json`, dir), 'utf8').then(JSON.parse, () => null);
      if (!manifest?.visits?.length) continue;
      out[key] ??= { ra: manifest.ra, dec: manifest.dec, bands: {} };
      out[key].bands[band] = { baked: manifest.baked, visits: manifest.visits.length };
    }
  }
  await writeFile(new URL('baked.json', root), `${JSON.stringify(out, null, 1)}\n`);
}

async function main() {
  if (SERVER) useFrameRelay(`${SERVER}/api/frame`, { fallback: true });
  const { targets } = JSON.parse(await readFile(new URL('data/targets.json', ROOT), 'utf8'));
  const thumbs = JSON.parse(await readFile(new URL('data/thumbs.json', ROOT), 'utf8'));
  let total = 0;
  let failed = 0;
  for (const target of targets) {
    if (ONLY.length && !ONLY.includes(target.key)) continue;
    const bands = BANDS.includes('own') ? [target.band ?? 'all'] : BANDS;
    for (const band of bands) {
      const done = await bakeField(target, band, thumbs);
      total += done.bytes;
      failed += done.failed;
    }
  }
  await writeIndex();
  console.log(`\n${(total / 2 ** 20).toFixed(1)} MB in the fields baked this run${failed ? `; ${failed} visits failed` : ''}`);
  if (failed) process.exitCode = 1;
}

await main();

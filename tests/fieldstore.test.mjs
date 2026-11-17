/**
 * The ready-made fields (fieldstore.js, tools/bake-fields.mjs): the kept
 * pixels must give the stamp a live read gives, and what a mark measures on
 * them must be what it measures live, within what half precision costs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  toHalf, cropSource, encodeVisit, decodeVisit, cardsOf, widestGrid,
} from '../public/js/fieldstore.js';
import { resampleSource } from '../public/js/stamp.js';
import { WCS, TangentGrid } from '../public/js/wcs.js';
import { SkyView } from '../public/js/sky.js';

const FIELDS = new URL('../public/data/fields/', import.meta.url);
const manifestOf = async (key, band) => JSON.parse(await readFile(new URL(`${key}/${band}/manifest.json`, FIELDS), 'utf8'));
const fileOf = async (key, band, entry) => {
  const buf = await readFile(new URL(`${key}/${band}/${entry.file}`, FIELDS));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};
const asBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

test('half precision: rounded to nearest, NaN kept, tiny values subnormal', () => {
  assert.equal(toHalf(0), 0);
  assert.equal(toHalf(1), 0x3c00);
  assert.equal(toHalf(-2), 0xc000);
  assert.equal(toHalf(65504), 0x7bff);
  assert.equal(toHalf(1e6), 0x7c00);
  assert.equal(toHalf(0.1), 0x2e66);
  assert.equal(toHalf(2 ** -24), 1);
  assert.equal(toHalf(NaN) & 0x7c00, 0x7c00);
  assert.notEqual(toHalf(NaN) & 0x3ff, 0);
  // Halfway between two halves goes to the even one.
  assert.equal(toHalf(1 + 2 ** -11), 0x3c00);
  assert.equal(toHalf(1 + 3 * 2 ** -11), 0x3c02);
});

/**
 * A live read's source for a real visit's WCS, with made-up pixels: the
 * whole width of the rows, flags on a few of them.
 */
function syntheticSource(entry, grid) {
  const cards = cardsOf(entry);
  const wcs = new WCS(cards);
  const nx = entry.nx;
  const rows = entry.rows;
  const plane = new Float32Array(nx * rows);
  const flags = new Int32Array(nx * rows);
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < plane.length; k++) {
    plane[k] = 0.4 + 0.03 * (random() + random() + random() - 1.5) + (random() < 0.002 ? 300 * random() : 0);
    if (random() < 0.01) plane[k] = NaN;
    if (random() < 0.003) flags[k] = 1 << 1;
    if (random() < 0.003) flags[k] |= 1 << 22;
  }
  const maskedPerRow = new Uint32Array(rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < nx; c++) if (plane[r * nx + c] !== plane[r * nx + c]) maskedPerRow[r] += 1;
  return {
    cards, wcs, nx, ny: entry.ny, plane, flags, rowFrom: entry.rowFrom, rows, colFrom: 0, cols: nx,
    maskedPerRow, bytesRead: 0, grid,
  };
}

test('a cropped source puts the very same stamp on the grid, and on a narrower grid inside it', async () => {
  const manifest = await manifestOf('atala', 'D2');
  const entry = manifest.visits.find((e) => !e.none);
  const grid = widestGrid(manifest.ra, manifest.dec, manifest.fov);
  const src = syntheticSource(entry, grid);
  const crop = cropSource(src, grid);
  assert.ok(crop.cols < src.cols / 2, 'only the columns the field needs are kept');
  const narrow = new TangentGrid(manifest.ra, manifest.dec, (manifest.fov * 702) / grid.height, 702, grid.height);
  for (const g of [grid, narrow]) {
    const whole = resampleSource(src, g);
    const cut = resampleSource(crop, g);
    assert.deepEqual(cut.data, whole.data);
    assert.deepEqual(cut.quality, whole.quality);
    assert.deepEqual(cut.detector.data, whole.detector.data);
    assert.equal(cut.meta.detectorSigma, whole.meta.detectorSigma);
    assert.equal(cut.meta.flaggedPixels, whole.meta.flaggedPixels);
    assert.equal(cut.meta.overflowSamples, whole.meta.overflowSamples);
  }
  // A grid reaching past what was kept is refused, to be read live.
  const wide = new TangentGrid(manifest.ra, manifest.dec, manifest.fov * 3, grid.width, grid.height);
  assert.throws(() => resampleSource(crop, wide), (err) => err.uncovered === true);
});

test('encoded and read back, the pixels move by a sliver of the noise and the flags not at all', async () => {
  const manifest = await manifestOf('atala', 'D2');
  const entry = manifest.visits.find((e) => !e.none);
  const grid = widestGrid(manifest.ra, manifest.dec, manifest.fov);
  const crop = cropSource(syntheticSource(entry, grid), grid);
  const { bytes, offset, scale } = encodeVisit(crop);
  const back = decodeVisit({ ...entry, rowFrom: crop.rowFrom, rows: crop.rows, colFrom: crop.colFrom, cols: crop.cols, offset, scale, flags: true }, asBuffer(bytes));
  let worst = 0;
  for (let k = 0; k < crop.plane.length; k++) {
    const a = crop.plane[k];
    const b = back.plane[k];
    assert.equal(a === a, b === b);
    if (a === a) worst = Math.max(worst, Math.abs(a - b) / Math.max(Math.abs(a - offset), 0.03));
    assert.equal(back.flags[k], crop.flags[k] & ((1 << 1) | (1 << 22)));
  }
  // Within half precision's step: one part in two thousand of the distance from the sky.
  assert.ok(worst <= 2 ** -11, `worst ${worst}`);
});

/**
 * The kept files against the live read, for visits of two fields: the
 * live numbers were recorded by the bake from the archive's own file; the
 * kept ones are measured here, afresh, from what ships with the page.
 */
for (const [key, band] of [['atala', 'D2'], ['wise0855', 'D6']]) {
  test(`${key} ${band}: marks on the kept pixels measure what they measure live`, async () => {
    const manifest = await manifestOf(key, band);
    const grid = widestGrid(manifest.ra, manifest.dec, manifest.fov);
    let compared = 0;
    // Six visits a field keep the suite quick; tools/bake-fields.mjs checked every one as it kept it.
    for (const entry of manifest.visits.filter((e) => !e.none).slice(0, 6)) {
      const kept = resampleSource(decodeVisit(entry, await fileOf(key, band, entry)), grid, { minCoverage: 0 });
      const { check } = entry;
      const live = check.detectorSigma.live;
      assert.ok(Math.abs(kept.meta.detectorSigma / live - 1) < 1e-3, `${entry.obsId}: detector noise`);
      assert.equal(kept.meta.flaggedPixels, check.flaggedPixels.live, `${entry.obsId}: flagged pixels`);
      assert.equal(check.holesDiffer, 0, `${entry.obsId}: no hole opened or closed`);
      assert.ok(check.qualitySame, `${entry.obsId}: quality plane`);
      assert.ok(check.pixelRmsSigma < 0.1, `${entry.obsId}: pixels ${check.pixelRmsSigma}σ rms`);
      for (const { at, live: m } of check.marks) {
        const here = SkyView.prototype.measure.call({ grid }, { stamp: kept, frame: entry }, at[0], at[1]);
        if (!m) continue;
        assert.ok(here, `${entry.obsId}: a source measured live is measured here`);
        assert.equal(Boolean(here.saturated), m.saturated);
        if (m.saturated) continue;
        const moved = Math.hypot((here.ra - m.ra) * Math.cos((m.dec * Math.PI) / 180), here.dec - m.dec) * 3600;
        assert.ok(moved < 0.01, `${entry.obsId}: centroid moved ${moved}″`);
        assert.ok(Math.abs(here.snr / m.snr - 1) < 1e-3, `${entry.obsId}: SNR ${here.snr} against ${m.snr}`);
        if (m.mag != null) assert.ok(Math.abs(here.mag - m.mag) < 1e-3, `${entry.obsId}: ${here.mag} against ${m.mag} AB`);
        compared += 1;
      }
    }
    assert.ok(compared >= 20, `${compared} sources compared`);
  });
}

test('every kept field covers a page grid narrower than the widest', async () => {
  const index = JSON.parse(await readFile(new URL('baked.json', FIELDS), 'utf8'));
  for (const [key, field] of Object.entries(index)) {
    for (const band of Object.keys(field.bands)) {
      const manifest = await manifestOf(key, band);
      const widest = widestGrid(manifest.ra, manifest.dec, manifest.fov);
      // A 16:10 screen, and a link that rounds the centre to four decimals.
      const w = Math.round(widest.height * 1.6);
      const grid = new TangentGrid(Number(manifest.ra.toFixed(4)), Number(manifest.dec.toFixed(4)), (manifest.fov * w) / widest.height, w, widest.height);
      for (const entry of manifest.visits.filter((e) => !e.none).slice(0, 3)) {
        const src = decodeVisit(entry, await fileOf(key, band, entry));
        assert.doesNotThrow(() => resampleSource(src, grid, { minCoverage: 0 }), `${key} ${band} ${entry.obsId}`);
      }
    }
  }
});

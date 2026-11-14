// How often Hunter X finds a moving source it was not told about.
//
//   node tools/hunter-benchmark.mjs                  the full run (tens of minutes the first time)
//   node tools/hunter-benchmark.mjs --quick          a few objects per cell, to see it works
//   node tools/hunter-benchmark.mjs --per-cell 30 --cache <dir> --out <file.json>
//   node tools/hunter-benchmark.mjs --from <file.json>   tables and chart again from a saved run
//
// Other options: --snrs 5,10,20  --shifts 1,3,5,10  --bn-snrs 10,20  --seed N  --chart <file.svg>
//
// Real SPHEREx DR1 frames are cut onto the same 0.3° north-up grid the page
// uses (2.5 samples per detector pixel), a Gaussian point source of the
// frame's own PSF_FWHM is planted in every visit on a straight track, and the
// visits go through the page's own search: sector scores (sectors.js), the
// standouts and their brightest pixels, SkyView.trackMark at each, the
// single-pixel test and rankCandidates (huntcore.js, hunt.js). Nothing is told
// where the source was put; the answer is compared with it afterwards.
//
// Cut stamps are kept in the cache directory, so only the first run reads
// the archive. The numbers and the chart go to --out and docs/img/.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStamp } from '../public/js/stamp.js';
import { TangentGrid, WCS } from '../public/js/wcs.js';
import { toS3, groupVisits } from '../public/js/catalog.js';
import { spread } from '../public/js/visits.js';
import { scoreSectors } from '../public/js/sectors.js';
import { skySigma, DETECTOR_ARCSEC } from '../public/js/depth.js';
import { SkyView } from '../public/js/sky.js';
import { searchField } from '../public/js/huntcore.js';
import { rateIsMeasured } from '../public/js/hunt.js';
import { QUALITY } from '../public/js/stamp.js';
import { injectSource, linearTrack, seeded } from './hunter-inject.mjs';

/* ------------------------------------------------------------- settings */

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const QUICK = flag('--quick');
const PER_CELL = Number(option('--per-cell', QUICK ? 3 : 24));
const CACHE = option('--cache', join(tmpdir(), 'muninn-hunter-bench'));
const OUT = option('--out', join(CACHE, 'results.json'));
// A quick run is a smoke test: its chart stays out of docs/.
const CHART = option('--chart', QUICK ? join(CACHE, 'hunter-recovery.svg') : new URL('../docs/img/hunter-recovery.svg', import.meta.url));
const SEED = Number(option('--seed', 20261114));

/** The field the page opens at, and the grid it cuts: 0.3°, square here. */
const FOV_DEG = 0.3;
const GRID = 439; // round(0.3° / 6.15″ × 2.5), as gridWidthFor gives
const VISITS_READ = 10; // the page's first batch, spread over the baseline
/** A track counts as found within this many detector pixels. */
const MATCH_PX = 1.5;
/** Used only where a frame's header has no PSF_FWHM. */
const FALLBACK_FWHM_PX = 2;

const FIELDS = {
  // Galactic latitude −59°: a high-latitude field with few stars.
  sparse: { key: 'atala', band: 'D2' },
  // Galactic latitude −6°, in Taurus: a crowded star field.
  crowded: { key: 'rwaur', band: 'D2' },
};

const SNRS = option('--snrs', '5,10,20,50,100,300,1000').split(',').map(Number);
const SHIFTS = option('--shifts', '1,3,5,10,30,100').split(',').map(Number);
const VISIT_COUNTS = QUICK ? [6, 10] : [4, 6, 10];

/** The bright-neighbour grid: one field, six visits, a steady star beside the track. */
const BN = {
  field: 'sparse', visits: 6, snrs: option('--bn-snrs', '10,20,1000').split(',').map(Number), shifts: [5, 10],
  separations: [1.5, 3, 5, 8], ratios: [3, 10, 30, 100],
};

/* ------------------------------------------------------- reading frames */

/** PSF_FWHM from the frame's header, in arcsec, or null. */
async function psfFwhm(url) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-115199' } });
    const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
    const m = /PSF_FWHM=\s*([0-9.Ee+-]+)/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const plain = (wcs) => JSON.parse(JSON.stringify(wcs, (k, v) => (v instanceof Float64Array ? Array.from(v) : v)));

function revive(fields) {
  const wcs = Object.assign(Object.create(WCS.prototype), fields);
  for (const k of ['A', 'B', 'AP', 'BP']) if (wcs[k]) wcs[k].coef = Float64Array.from(wcs[k].coef);
  return wcs;
}

async function cachedStamp(dir, frame, grid) {
  const base = join(dir, frame.obsId);
  try {
    const meta = JSON.parse(await readFile(`${base}.json`, 'utf8'));
    if (meta.empty) return null;
    const buf = async (ext, T) => { const b = await readFile(`${base}.${ext}`); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT); };
    const data = Float32Array.from(await buf('f32', Float32Array));
    const quality = Uint8Array.from(await buf('q8', Uint8Array));
    const detData = Float32Array.from(await buf('det.f32', Float32Array));
    const wcs = revive(meta.wcs);
    return {
      data, quality, width: meta.width, height: meta.height, coverage: meta.coverage, wcs,
      detector: { ...meta.detector, data: detData, wcs },
      meta: meta.meta, psfArcsec: meta.psfArcsec,
    };
  } catch { /* not cached yet */ }

  const url = toS3(frame.url);
  const stamp = await loadStamp(url, grid, { minCoverage: 0.9 });
  if (!stamp) {
    await writeFile(`${base}.json`, JSON.stringify({ empty: true }));
    return null;
  }
  stamp.psfArcsec = await psfFwhm(url);
  const { data: detData, wcs: _w, ...detector } = stamp.detector;
  await writeFile(`${base}.f32`, Buffer.from(stamp.data.buffer));
  await writeFile(`${base}.q8`, Buffer.from(stamp.quality.buffer));
  await writeFile(`${base}.det.f32`, Buffer.from(detData.buffer, detData.byteOffset, detData.byteLength));
  await writeFile(`${base}.json`, JSON.stringify({
    width: stamp.width, height: stamp.height, coverage: stamp.coverage, wcs: plain(stamp.wcs),
    detector, meta: stamp.meta, psfArcsec: stamp.psfArcsec,
  }));
  return stamp;
}

async function loadField(kind) {
  const { key, band } = FIELDS[kind];
  const index = JSON.parse(await readFile(new URL(`../public/data/fields/${key}.json`, import.meta.url), 'utf8'));
  const { ra, dec } = index;
  const grid = new TangentGrid(ra, dec, FOV_DEG, GRID, GRID);
  const dir = join(CACHE, `${key}-${band}`);
  await mkdir(dir, { recursive: true });
  const all = groupVisits(index.frames, { ra, dec, band });

  // The page's first ten, spread over the baseline; a frame that does not
  // cover the field is replaced by the nearest one in time that does.
  const visits = [];
  const tried = new Set();
  for (const want of spread(all, VISITS_READ)) {
    const order = all.slice().sort((a, b) => Math.abs(a.mjd - want.mjd) - Math.abs(b.mjd - want.mjd));
    for (const frame of order) {
      if (tried.has(frame.obsId)) continue;
      tried.add(frame.obsId);
      const stamp = await cachedStamp(dir, frame, grid);
      if (!stamp) continue;
      visits.push({ stamp, frame: { mjd: frame.mjd, obsId: frame.obsId, band: frame.band, iso: frame.iso } });
      break;
    }
  }
  visits.sort((a, b) => a.frame.mjd - b.frame.mjd);
  for (const v of visits) {
    v.sigma = skySigma(v.stamp.data);
    v.fwhmPx = v.stamp.psfArcsec ? v.stamp.psfArcsec / DETECTOR_ARCSEC : FALLBACK_FWHM_PX;
  }
  console.log(`${kind}: ${key} ${band}, ${visits.length} visits, ${visits[0].frame.iso.slice(0, 10)} … ${visits.at(-1).frame.iso.slice(0, 10)}`
    + `, PSF FWHM ${visits.map((v) => v.fwhmPx.toFixed(2)).join('/')} px`);
  return { kind, key, band, ra, dec, grid, visits, perPixel: DETECTOR_ARCSEC / (grid.scale * 3600) };
}

/* ------------------------------------------------------- one search run */

/** SkyView's own trackMark over these visits, without a page around it. */
function tracker(field, visits) {
  const sky = { grid: field.grid, visits, measure: SkyView.prototype.measure, covers: SkyView.prototype.covers };
  return (ra, dec) => SkyView.prototype.trackMark.call(sky, ra, dec);
}

/**
 * The page's search over these visits, as the page runs it. The sector
 * noise floor is each visit's grid noise measured before anything was
 * planted: one planted source moves a few hundred of 193 000 samples, which
 * does not move the 16th and 50th percentiles that noise is read from.
 */
async function hunt(field, visits) {
  const sectors = scoreSectors(visits, { sigmas: visits.map((v) => v.sigma ?? 0) });
  return searchField({ sectors, visits, grid: field.grid, dec: field.dec, track: tracker(field, visits) });
}

/** Distance in detector pixels between a sky position and a grid position. */
function pxFrom(field, ra, dec, at) {
  const g = field.grid.worldToIndex(ra, dec);
  return g ? Math.hypot(g[0] - at[0], g[1] - at[1]) / field.perPixel : Infinity;
}

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : Infinity; };

/**
 * Plant `sources` (each a list of grid positions, one per visit, and a peak
 * SNR), search, take the plants out again, and say what was found.
 */
async function runWith(field, visits, mover, steady = null) {
  const undo = [];
  const plant = (at, k, amplitude) => {
    const v = visits[k];
    const [ra, dec] = field.grid.indexToWorld(at[0], at[1]);
    undo.push(injectSource(v.stamp, field.grid, ra, dec, { amplitude, fwhmPx: v.fwhmPx }));
  };
  // The mover's SNR holds in every visit against that visit's own noise; the
  // star is steady, the same light in every visit, set against the median noise.
  if (mover) mover.track.forEach((at, k) => plant(at, k, mover.snr * visits[k].stamp.meta.detectorSigma));
  if (steady) {
    const sigma = median(visits.map((v) => v.stamp.meta.detectorSigma));
    visits.forEach((_, k) => plant(steady.at, k, steady.snr * sigma));
  }
  let found;
  let linker = null;
  try {
    found = await hunt(field, visits);
    // Diagnostic only, never counted as a recovery: what trackMark makes of
    // the mover when it is handed the mover's true position in the visit
    // nearest mid-run. It separates "the sectors never pointed at it" from
    // "pointed at, but the track was not linked".
    if (mover) linker = judgeLinker(field, visits, mover, tracker(field, visits));
  } finally {
    for (let n = undo.length - 1; n >= 0; n--) undo[n]();
  }
  return { ...judge(field, visits, found, mover, steady), ...linker };
}

function judgeLinker(field, visits, mover, track) {
  const mjds = visits.map((v) => v.frame.mjd);
  const half = (mjds[0] + mjds.at(-1)) / 2;
  let k = 0;
  mjds.forEach((t, i) => { if (Math.abs(t - half) < Math.abs(mjds[k] - half)) k = i; });
  const [ra, dec] = field.grid.indexToWorld(...mover.track[k]);
  const a = track(ra, dec);
  const byObs = new Map(visits.map((v, i) => [v.frame.obsId, i]));
  const d = a.track.map((p) => pxFrom(field, p.ra, p.dec, mover.track[byObs.get(p.obsId)]));
  const onIt = d.length > 0 && median(d) <= MATCH_PX;
  return {
    linkerMoving: onIt && a.kind === 'moving',
    linkerMeasured: onIt && a.kind === 'moving' && rateIsMeasured(a),
  };
}

function judge(field, visits, found, mover, steady) {
  const byObs = new Map(visits.map((v, k) => [v.frame.obsId, k]));
  // rankCandidates hands back copies, so the ranked ones are known by where they stood out.
  const keyOf = (c) => `${c.sector}|${c.visit}`;
  const ranked = new Set(found.list.map(keyOf));
  const listed = { has: (c) => ranked.has(keyOf(c)) };
  const onTrack = (c) => {
    if (!mover) return { standout: false, track: false };
    const standout = pxFrom(field, c.ra, c.dec, mover.track[c.visit]) <= MATCH_PX;
    const d = c.analysis.track.map((p) => pxFrom(field, p.ra, p.dec, mover.track[byObs.get(p.obsId)]));
    return { standout, track: d.length > 0 && median(d) <= MATCH_PX };
  };
  let flagged = false;
  let moving = false;
  let measured = false;
  let listedOk = false;
  let fpMoving = 0;
  let fpListed = 0;
  let starAsMover = 0;
  const falseMovers = [];
  for (const c of found.all) {
    const m = onTrack(c);
    const isMoving = c.analysis.kind === 'moving';
    if (m.standout) {
      flagged = true;
      if (m.track && isMoving) moving = true;
      if (m.track && isMoving && rateIsMeasured(c.analysis)) measured = true;
      if (m.track && listed.has(c)) listedOk = true;
      continue;
    }
    if (isMoving) {
      fpMoving += 1;
      falseMovers.push({
        ra: Number(c.ra.toFixed(5)), dec: Number(c.dec.toFixed(5)), seen: c.analysis.seen, total: c.analysis.total,
        ratePerHour: c.analysis.ratePerHour, rms: c.analysis.rms, measured: rateIsMeasured(c.analysis), ranked: listed.has(c),
      });
    }
    if (listed.has(c)) fpListed += 1;
    if (steady && isMoving && pxFrom(field, c.ra, c.dec, steady.at) <= 3) starAsMover += 1;
  }
  return {
    flagged, moving, measured, listed: listedOk, fpMoving, fpListed, starAsMover, checked: found.checked, falseMovers,
  };
}

/* ------------------------------------------------------------ placement */

/** True when every visit holds sky (not a blank or an overflow) all round this spot. */
function clearAt(field, visits, at, reachSamples) {
  const r = Math.ceil(reachSamples);
  const ci = Math.round(at[0]);
  const cj = Math.round(at[1]);
  if (ci - r < 0 || cj - r < 0 || ci + r >= GRID || cj + r >= GRID) return false;
  for (const v of visits) {
    const { data, quality } = v.stamp;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        const k = j * GRID + i;
        if (!(data[k] === data[k])) return false;
        if (quality && quality[k] & (QUALITY.OVERFLOW | QUALITY.GHOST)) return false;
      }
    }
  }
  return true;
}

/** A random straight track that stays clear of the edges and the blanks. */
function placeMover(field, visits, rand, shiftPx, snr, near = null) {
  const mjds = visits.map((v) => v.frame.mjd);
  const len = shiftPx * field.perPixel;
  const margin = 14 * field.perPixel + len / 2; // the measurement's ring and then some
  for (let attempt = 0; attempt < 500; attempt++) {
    const angle = rand() * 2 * Math.PI;
    const dir = [Math.cos(angle), Math.sin(angle)];
    let mid;
    let star = null;
    if (near) {
      // Beside a steady star: on the perpendicular through it, at the asked
      // separation when the run is half done.
      const s = near.pick(rand);
      if (!s) return null;
      const side = rand() < 0.5 ? 1 : -1;
      const sep = near.separation(rand) * field.perPixel;
      mid = [s.at[0] - side * dir[1] * sep, s.at[1] + side * dir[0] * sep];
      star = s;
    } else {
      mid = [margin + rand() * (GRID - 2 * margin), margin + rand() * (GRID - 2 * margin)];
    }
    if (mid[0] < margin || mid[1] < margin || mid[0] > GRID - margin || mid[1] > GRID - margin) continue;
    const track = linearTrack(mjds, mid, dir, len);
    if (!track.every((at) => clearAt(field, visits, at, 3 * field.perPixel))) continue;
    return { track, snr, star };
  }
  return null;
}

/**
 * Real steady stars, for the mover to pass: local maxima of the median of
 * the visits, 30 to 1500 times the detector noise, unsaturated and unblanked
 * in every visit, with no brighter peak within eight pixels.
 */
function realStars(field) {
  const n = field.visits.length;
  const med = new Float32Array(GRID * GRID);
  const col = new Float32Array(n);
  for (let k = 0; k < med.length; k++) {
    for (let v = 0; v < n; v++) col[v] = field.visits[v].stamp.data[k];
    col.sort();
    med[k] = col[n >> 1];
  }
  const sigma = median(field.visits.map((v) => v.stamp.meta.detectorSigma));
  const bg = median(Array.from(med.filter((x) => x === x)).filter((_, i) => i % 7 === 0));
  const reach = Math.round(8 * field.perPixel);
  const out = [];
  const edge = Math.round(20 * field.perPixel);
  for (let j = edge; j < GRID - edge; j++) {
    for (let i = edge; i < GRID - edge; i++) {
      const v = med[j * GRID + i] - bg;
      if (!(v > 30 * sigma && v < 1500 * sigma)) continue;
      let top = true;
      for (let dj = -reach; dj <= reach && top; dj++) {
        for (let di = -reach; di <= reach; di++) {
          if ((di || dj) && med[(j + dj) * GRID + i + di] - bg > v) { top = false; break; }
        }
      }
      if (!top || !clearAt(field, field.visits, [i, j], 4 * field.perPixel)) continue;
      out.push({ at: [i, j], snr: v / sigma });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- cells */

function cellSeed(...parts) {
  let h = SEED;
  for (const p of parts.join('|')) h = Math.imul(h ^ p.charCodeAt(0), 16777619) >>> 0;
  return h;
}

async function runCell(field, visits, { count, snr, shift, near, steady, seed }) {
  const rand = seeded(seed);
  // The star's side of the track has its own sequence, so the movers stay
  // the very ones the control run placed.
  const starRand = seeded(seed ^ 0x9e3779b9);
  const tally = { injected: 0, flagged: 0, moving: 0, measured: 0, listed: 0, linkerMoving: 0, linkerMeasured: 0, fpMoving: 0, fpListed: 0, starAsMover: 0 };
  for (let n = 0; n < count; n++) {
    const mover = placeMover(field, visits, rand, shift, snr, near);
    if (!mover) continue;
    const star = steady ? steady(mover, starRand) : null;
    const r = await runWith(field, visits, mover, star);
    tally.injected += 1;
    for (const k of ['flagged', 'moving', 'measured', 'listed', 'linkerMoving', 'linkerMeasured']) tally[k] += r[k] ? 1 : 0;
    for (const k of ['fpMoving', 'fpListed', 'starAsMover']) tally[k] += r[k];
  }
  return tally;
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const per = (a, b) => (b ? (a / b).toFixed(2) : '—');

/* ------------------------------------------------------------------ run */

/** Plant, search and tally every cell; returns the results object. */
async function measureAll() {
  const fields = { sparse: await loadField('sparse'), crowded: await loadField('crowded') };
  const results = { settings: { PER_CELL, SEED, FOV_DEG, GRID, MATCH_PX, quick: QUICK }, fields: {}, baseline: [], main: [], neighbour: [] };
  for (const f of Object.values(fields)) {
    results.fields[f.kind] = {
      key: f.key, band: f.band, ra: f.ra, dec: f.dec,
      visits: f.visits.map((v) => ({ obsId: v.frame.obsId, iso: v.frame.iso, fwhmPx: Number(v.fwhmPx.toFixed(3)), detectorSigma: v.stamp.meta.detectorSigma })),
    };
  }
  const subset = (field, n) => spread(field.visits, n);

  // With nothing planted: what the search reports over the real field alone.
  for (const f of Object.values(fields)) {
    for (const n of VISIT_COUNTS) {
      const r = await runWith(f, subset(f, n), null);
      results.baseline.push({ field: f.kind, visits: n, ...r });
    }
  }

  // The real bright stars of the sparse field, for the main grid's third column.
  const stars = realStars(fields.sparse);
  results.fields.sparse.brightStars = stars.length;
  const nearReal = {
    pick: (rand) => stars[Math.floor(rand() * stars.length)],
    separation: (rand) => 2 + 2 * rand(),
  };

  const started = Date.now();
  const scenarios = [
    { name: 'sparse', field: fields.sparse, near: null },
    { name: 'crowded', field: fields.crowded, near: null },
    { name: 'bright neighbour (real star, 2–4 px)', field: fields.sparse, near: stars.length ? nearReal : null },
  ];
  for (const sc of scenarios) {
    if (sc.name.startsWith('bright') && !sc.near) continue;
    for (const n of VISIT_COUNTS) {
      const visits = subset(sc.field, n);
      for (const snr of SNRS) {
        for (const shift of SHIFTS) {
          const t = await runCell(sc.field, visits, {
            count: PER_CELL, snr, shift, near: sc.near, seed: cellSeed('main', sc.name, n, snr, shift),
          });
          results.main.push({ scenario: sc.name, field: sc.field.key, visits: n, snr, shift, ...t });
        }
      }
      console.log(`  ${sc.name}, ${n} visits: done (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
  }

  // A faint mover beside a planted steady star, against the same movers alone.
  {
    const field = fields[BN.field];
    const visits = subset(field, BN.visits);
    for (const snr of BN.snrs) {
      for (const shift of BN.shifts) {
        const seed = cellSeed('bn', snr, shift);
        const control = await runCell(field, visits, { count: PER_CELL, snr, shift, seed });
        results.neighbour.push({ separation: null, ratio: null, snr, shift, ...control });
        for (const separation of BN.separations) {
          for (const ratio of BN.ratios) {
            // The same movers as the control (same seed), each with a star put
            // on the perpendicular through its mid-run position.
            const steady = (mover, rand) => {
              const a = mover.track[0];
              const b = mover.track.at(-1);
              const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
              const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
              const half = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
              const side = rand() < 0.5 ? 1 : -1;
              const d = separation * field.perPixel;
              return { at: [half[0] - side * dir[1] * d, half[1] + side * dir[0] * d], snr: snr * ratio };
            };
            const t = await runCell(field, visits, { count: PER_CELL, snr, shift, steady, seed });
            results.neighbour.push({ separation, ratio, snr, shift, ...t });
          }
        }
        console.log(`  neighbour grid, SNR ${snr}, ${shift} px: done (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      }
    }
  }

  await mkdir(join(OUT, '..'), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(results, null, 1)}\n`);
  return results;
}

const FROM = option('--from', null);
const results = FROM ? JSON.parse(await readFile(FROM, 'utf8')) : await measureAll();

/* --------------------------------------------------------------- report */

console.log('\nBaseline, nothing planted: candidates the search calls moving / ranks');
console.log('| field | visits | standouts followed | moving | rate measured | ranked | what was called moving |');
console.log('|---|---|---|---|---|---|---|');
for (const b of results.baseline) {
  const what = b.falseMovers.map((m) => `${m.ra}, ${m.dec}: ${m.seen}/${m.total} visits, ${(m.ratePerHour * 24).toFixed(2)}″/day, rms ${m.rms.toFixed(1)}″`).join('; ') || '—';
  console.log(`| ${b.field} | ${b.visits} | ${b.checked} | ${b.fpMoving} | ${b.falseMovers.filter((m) => m.measured).length} | ${b.fpListed} | ${what} |`);
}

const sum = (rows, key) => rows.reduce((a, r) => a + r[key], 0);

console.log('\nPooled over fields and visit counts (random placements; the bright-neighbour column is left out)');
console.log('| SNR | displacement, px | injected | standout on it | recovered (moving) | recovered (rate measured) | linker given the true position: moving / rate measured |');
console.log('|---|---|---|---|---|---|---|');
for (const snr of SNRS) {
  for (const shift of SHIFTS) {
    const rows = results.main.filter((r) => r.snr === snr && r.shift === shift && !r.scenario.startsWith('bright'));
    const n = sum(rows, 'injected');
    console.log(`| ${snr} | ${shift} | ${n} | ${pct(sum(rows, 'flagged'), n)} | ${pct(sum(rows, 'moving'), n)} | ${pct(sum(rows, 'measured'), n)} | ${pct(sum(rows, 'linkerMoving'), n)} / ${pct(sum(rows, 'linkerMeasured'), n)} |`);
  }
}

console.log('\nEvery cell');
console.log('| SNR | displacement, px | visits | field | injected | standout on it | recovered (moving) | recovered (rate measured) | ranked | recovery % (moving / rate measured) | false moving per run | false ranked per run | linker given the true position: moving / rate measured |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results.main) {
  console.log(`| ${r.snr} | ${r.shift} | ${r.visits} | ${r.scenario} | ${r.injected} | ${r.flagged} | ${r.moving} | ${r.measured} | ${r.listed} | ${pct(r.moving, r.injected)} / ${pct(r.measured, r.injected)} | ${per(r.fpMoving, r.injected)} | ${per(r.fpListed, r.injected)} | ${pct(r.linkerMoving, r.injected)} / ${pct(r.linkerMeasured, r.injected)} |`);
}

console.log(`\nBright neighbour: a planted steady star beside the track, ${FIELDS[BN.field].key} field, ${BN.visits} visits`);
console.log('| SNR | displacement, px | separation, px | star : mover | injected | standout on it | moving | rate measured | linker given the true position: moving | star called moving | false moving per run |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results.neighbour) {
  console.log(`| ${r.snr} | ${r.shift} | ${r.separation ?? 'no star'} | ${r.ratio ? `${r.ratio}:1` : '—'} | ${r.injected} | ${pct(r.flagged, r.injected)} | ${pct(r.moving, r.injected)} | ${pct(r.measured, r.injected)} | ${pct(r.linkerMoving, r.injected)} | ${r.starAsMover} | ${per(r.fpMoving, r.injected)} |`);
}

await writeFile(CHART, chart(results));
console.log(`\nwrote ${FROM ? '' : `${OUT} and `}${CHART instanceof URL ? CHART.pathname : CHART}`);

/* ---------------------------------------------------------------- chart */

/**
 * Recovery against displacement, one panel per visit count, a line per SNR,
 * random placements of both fields pooled. A grey dashed line is the
 * diagnostic: trackMark handed the true position, SNR 20.
 */
function chart(res) {
  const counts = [...new Set(res.main.map((r) => r.visits))];
  // One blue, light to dark by SNR; on a dark surface the order runs dark to light.
  const light = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'];
  const dark = ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
  const shown = [5, 10, 20, 100, 1000].filter((s) => SNRS.includes(s));
  const slot = new Map(shown.map((s, i) => [s, i]));
  const seriesCss = (mode) => shown.map((_, i) => `.l${i}{stroke:${mode[i]}}.d${i}{fill:${mode[i]}}`).join('');
  const pw = 250;
  const ph = 190;
  const left = 54;
  const top = 70;
  const gap = 30;
  const legendW = 230;
  const W = left + counts.length * pw + (counts.length - 1) * gap + legendW;
  const H = top + ph + 70;
  const xs = (i) => (i / (SHIFTS.length - 1)) * (pw - 20) + 10;
  const ys = (f) => ph - f * ph;
  const share = (rows, key) => {
    const n = sum(rows, 'injected');
    return n ? sum(rows, key) / n : 0;
  };
  const rowsAt = (n, snr, s) => res.main.filter((r) => r.visits === n && r.snr === snr && r.shift === s && !r.scenario.startsWith('bright'));
  const line = (pts, cls, extra = '') => `<polyline class="${cls}" fill="none" stroke-width="2"${extra} points="${pts.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ')}"/>`;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12">`);
  out.push(`<style>.ink{fill:#0b0b0b}.ink2{fill:#52514e}.grid{stroke:#e4e3df}.axis{stroke:#9a9993}.ref{stroke:#8a8983}.ring{stroke:#fcfcfb}rect.bg{fill:#fcfcfb}${seriesCss(light)}`
    + `@media (prefers-color-scheme: dark){.ink{fill:#f0efec}.ink2{fill:#c3c2b7}.grid{stroke:#33332f}.axis{stroke:#6b6a64}.ref{stroke:#a8a79f}.ring{stroke:#1a1a19}rect.bg{fill:#1a1a19}${seriesCss(dark)}}</style>`);
  out.push(`<rect class="bg" width="${W}" height="${H}"/>`);
  out.push(`<text class="ink" x="${left}" y="24" font-size="15" font-weight="600">Hunter X: share of injected movers returned as moving</text>`);
  const faintBest = Math.max(...counts.flatMap((n) => [5, 10, 20].flatMap((snr) => SHIFTS.map((s) => share(rowsAt(n, snr, s), 'moving')))));
  out.push(`<text class="ink2" x="${left}" y="44">Real SPHEREx D2 frames, sparse and crowded fields pooled, ${res.settings.PER_CELL} movers per field and cell. Peak SNR per visit.`
    + ` SNR 5, 10 and 20 never pass ${Math.ceil(faintBest * 100)}%: their lines lie on the floor.</text>`);
  counts.forEach((n, p) => {
    const x0 = left + p * (pw + gap);
    out.push(`<g transform="translate(${x0},${top})">`);
    out.push(`<text class="ink" x="0" y="-8" font-weight="600">${n} visits</text>`);
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      out.push(`<line class="grid" x1="0" x2="${pw}" y1="${ys(f)}" y2="${ys(f)}"/>`);
      if (p === 0) out.push(`<text class="ink2" x="-8" y="${ys(f) + 4}" text-anchor="end">${f * 100}%</text>`);
    }
    out.push(`<line class="axis" x1="0" x2="${pw}" y1="${ph}" y2="${ph}"/>`);
    SHIFTS.forEach((s, i) => out.push(`<text class="ink2" x="${xs(i)}" y="${ph + 18}" text-anchor="middle">${s}</text>`));
    out.push(`<text class="ink2" x="${pw / 2}" y="${ph + 38}" text-anchor="middle">displacement over the run, detector px</text>`);
    if (SNRS.includes(20)) {
      const ref = SHIFTS.map((s, i) => [xs(i), ys(share(rowsAt(n, 20, s), 'linkerMoving'))]);
      out.push(line(ref, 'ref', ' stroke-dasharray="5 4"'));
    }
    for (const snr of shown) {
      const i = slot.get(snr);
      const pts = SHIFTS.map((s, k) => { const f = share(rowsAt(n, snr, s), 'moving'); return [xs(k), ys(f), f, s]; });
      out.push(line(pts, `l${i}`));
      for (const q of pts) {
        out.push(`<circle class="d${i} ring" cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="4" stroke-width="2"><title>${n} visits, SNR ${snr}, ${q[3]} px: ${Math.round(q[2] * 100)}% returned as moving</title></circle>`);
      }
    }
    out.push('</g>');
  });
  const lx = left + counts.length * (pw + gap) - gap + 20;
  out.push(`<text class="ink" x="${lx}" y="${top - 8}" font-weight="600">Peak SNR of the mover</text>`);
  shown.forEach((snr, i) => {
    const y = top + 12 + i * 22;
    out.push(`<line class="l${i}" x1="${lx}" x2="${lx + 22}" y1="${y}" y2="${y}" stroke-width="2"/>`);
    out.push(`<circle class="d${i}" cx="${lx + 11}" cy="${y}" r="4"/>`);
    out.push(`<text class="ink" x="${lx + 30}" y="${y + 4}">SNR ${snr}</text>`);
  });
  const ry = top + 12 + shown.length * 22 + 10;
  out.push(`<line class="ref" x1="${lx}" x2="${lx + 22}" y1="${ry}" y2="${ry}" stroke-width="2" stroke-dasharray="5 4"/>`);
  out.push(`<text class="ink" x="${lx + 30}" y="${ry + 4}">SNR 20, trackMark handed</text>`);
  out.push(`<text class="ink" x="${lx + 30}" y="${ry + 20}">the true position (diagnostic)</text>`);
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}


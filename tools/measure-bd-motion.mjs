/**
 * measure-bd-motion.mjs — does SPHEREx see nearby brown dwarfs where their
 * proper motion says they should have gone since WISE?
 *
 * A science check rather than a feature. AllWISE caught these objects around
 * 2010.56; SPHEREx sees them in 2025–2026, some fifteen years on. The fastest
 * of them have moved a minute of arc or more in that time, ten SPHEREx pixels
 * and more, so the survey should find each one well away from its AllWISE
 * position and close to where its catalogued motion puts it. This measures
 * that from the delivered pixels, frame by frame, and says plainly where it
 * could not.
 *
 *   1. The catalogue motion and parallax come from Kirkpatrick et al. 2021
 *      (VizieR J/ApJS/253/7), the 20 pc brown-dwarf census.
 *   2. The 2010 position comes from AllWISE (II/328/allwise): the motion-fit
 *      position at MJD 55400.0 where AllWISE gives one, otherwise the plain
 *      catalogue position.
 *   3. IRSA SIA lists the SPHEREx frames that cover the object. Only D5
 *      (3.8–4.4 µm) and D6 (4.4–5.0 µm) are read: that is where T and Y dwarfs
 *      are brightest, next to WISE W2.
 *   4. Each frame is cut out of the public S3 mirror with the page's own
 *      reader (`stamp.js`) onto one north-up grid per object, so every frame
 *      and every stack shares coordinates.
 *   5. A windowed centroid is measured near the predicted spot, in each single
 *      frame and in a stack of each season's frames per band, with the signal
 *      to noise of a nine-pixel aperture against the detector's own sky noise.
 *   6. Isolated Gaia DR3 stars on the same grid are centroided the same way;
 *      their median offset from Gaia is taken off the brown dwarf's, so the
 *      result does not lean on any one frame's WCS.
 *   7. The measured offset from the AllWISE position is compared with the
 *      expected one, proper motion times the elapsed time plus the parallax
 *      displacement on the day. Separately, the seasons alone give a proper
 *      motion that owes nothing to WISE.
 *
 * Downloads are cached under `.cache/bd-motion/` (gitignored), so a run that
 * stops can be started again and only reads what it has not read yet.
 *
 *   node tools/measure-bd-motion.mjs                  every target
 *   node tools/measure-bd-motion.mjs --only "WISE 0855-0714"
 *   node tools/measure-bd-motion.mjs --offline        cached data only
 *
 * Writes `public/data/bd-motion.json`. The method and the results table are
 * in `docs/bd-motion.md`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DETECTOR_ARCSEC } from '../public/js/depth.js';
import { epochOfMjd, GAIA_EPOCH } from '../public/js/overlay.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'bd-motion');
const OUT = join(ROOT, 'public', 'data', 'bd-motion.json');

const VIZIER = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv';
const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const KIRKPATRICK = 'J/ApJS/253/7/tablea1';
const ALLWISE = 'II/328/allwise';
const GAIA = 'I/355/gaiadr3';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** AllWISE's motion-fit positions (RA_pm, DE_pm) are given at MJD 55400.0. */
export const ALLWISE_MJD = 55400.0;
export const ALLWISE_EPOCH = epochOfMjd(ALLWISE_MJD);

/** Kirkpatrick et al. 2021 quote CatWISE2020 positions at MJD 57170. */
const CATWISE_EPOCH = epochOfMjd(57170);

/** The PSF the SPHEREx headers state (PSF_FWHM), 1.21 detector pixels. */
export const PSF_FWHM_ARCSEC = 7.46;

/** Grid samples, about three to a detector pixel. */
const SAMPLE_ARCSEC = 2;

/** The smallest grid, so that even a slow mover has field stars round it. */
const MIN_GRID_ARCSEC = 360;

/** Room round both positions on the grid, for the sky annulus and the search. */
const GRID_MARGIN_ARCSEC = 45;

/** How far from the predicted spot a source is looked for: two detector pixels. */
const SEARCH_ARCSEC = 12;

/** Nine detector pixels, the aperture `depth.js` states its limits through. */
const APERTURE_DET_PX = 9;
const APERTURE_ARCSEC = DETECTOR_ARCSEC * Math.sqrt(APERTURE_DET_PX / Math.PI);

/** Sky annulus, inside the grid margin and clear of the PSF wings. */
const ANNULUS_ARCSEC = [22, 40];

/**
 * How well a SPHEREx frame's WCS is assumed to put a star on the sky, per
 * axis, where it cannot be checked against field stars: single frames, and
 * stacks with fewer than three usable Gaia stars. The stacks that can be
 * checked come out at 0.1–0.4″ (bd-motion.json, `fieldStars`), so this is
 * on the cautious side.
 */
export const SYSTEMATIC_ARCSEC = 0.5;

/**
 * Half a detector pixel: how close to the prediction a detection must land
 * to count as the same object having moved there, whatever the stated
 * errors (see compareMotion).
 */
export const RESIDUAL_FLOOR_ARCSEC = DETECTOR_ARCSEC / 2;

/** A detection is one at five sigma or more. */
export const MIN_SNR = 5;

/**
 * Field stars for the astrometric check: Gaia DR3 stars to G = 17, measured
 * at 20σ or better, looked for within 4″ of their Gaia position, and dropped
 * if they land further than 3″ from it. At least three are needed before
 * their offset is taken off the brown dwarf's.
 */
const FIELD_STAR_G = 17;
const FIELD_STAR_SNR = 20;
const FIELD_STAR_SEARCH_ARCSEC = 4;
const FIELD_STAR_LOST_ARCSEC = 3;
const MIN_FIELD_STARS = 3;

/** 2026 Jan 1 and 2027 Jan 1: the middle and past the far end of the SPHEREx run so far. */
const MJD_2026 = 61041;
const MJD_END = 61406;

/** Frames further apart than this belong to different seasons. */
const SEASON_GAP_DAYS = 20;

const BANDS = ['D5', 'D6'];

/**
 * The objects measured: T and Y dwarfs (and the L/T binary Luhman 16) with
 * proper motions of about an arcsecond a year or more and W2 brighter than
 * about 14.7, so that a season of SPHEREx frames should reach them. `name`
 * is the short name in Kirkpatrick et al. 2021.
 */
export const TARGETS = [
  { name: 'WISE 0855-0714', label: 'WISE 0855−0714' },
  { name: 'WISE 1049-5319', label: 'Luhman 16AB' },
  { name: 'Gl 845BC', label: 'ε Indi Ba/Bb' },
  { name: 'WISE 1639-6847', label: 'WISE 1639−6847' },
  { name: '2MASS 1114-2618', label: '2MASS 1114−2618' },
  { name: 'WISE 0254+0223', label: 'WISE 0254+0223' },
  { name: 'WISE 0410+1502', label: 'WISE 0410+1502' },
  { name: 'WISE 1405+5534', label: 'WISE 1405+5534' },
  { name: '2MASS 0415-0935', label: '2MASS 0415−0935' },
  { name: 'Gl 570D', label: 'Gl 570D' },
  { name: 'WISE 1741+2553', label: 'WISE 1741+2553' },
  { name: 'WISE 1506+7027', label: 'WISE 1506+7027' },
  { name: '2MASS 0939-2448', label: '2MASS 0939−2448' },
  { name: 'UGPS 0722-0540', label: 'UGPS 0722−0540' },
  { name: 'WISE 1541-2250', label: 'WISE 1541−2250' },
  { name: 'WISE 0350-5658', label: 'WISE 0350−5658' },
];

/* --------------------------------------------------------------- pure math */

/**
 * Kirkpatrick's adopted spectral type code as text: L0 = 0, T0 = 10, Y0 = 20.
 */
export function spectralType(code) {
  if (!Number.isFinite(code)) return null;
  const [letter, base] = code >= 20 ? ['Y', 20] : code >= 10 ? ['T', 10] : code >= 0 ? ['L', 0] : ['M', -10];
  const sub = Math.round((code - base) * 10) / 10;
  return `${letter}${sub}`;
}

/**
 * Where (ra, dec) lies from (ra0, dec0) on the tangent plane, in arcseconds
 * east and north. Exact for the separations here (minutes of arc).
 */
export function offsetArcsec(ra0, dec0, ra, dec) {
  const a0 = ra0 * D2R;
  const d0 = dec0 * D2R;
  const a = ra * D2R;
  const d = dec * D2R;
  const cosC = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosC;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosC;
  return { east: xi * R2D * 3600, north: eta * R2D * 3600 };
}

/** The inverse: the sky position `east`, `north` arcseconds from (ra0, dec0). */
export function applyOffset(ra0, dec0, east, north) {
  const xi = (east / 3600) * D2R;
  const eta = (north / 3600) * D2R;
  const a0 = ra0 * D2R;
  const d0 = dec0 * D2R;
  const denom = Math.cos(d0) - eta * Math.sin(d0);
  const ra = a0 + Math.atan2(xi, denom);
  const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, denom));
  return { ra: (((ra * R2D) % 360) + 360) % 360, dec: dec * R2D };
}

/** Position angle of an offset, degrees east of north, 0–360. */
export function positionAngle(east, north) {
  return ((Math.atan2(east, north) * R2D) + 360) % 360;
}

/** Smallest difference between two position angles, degrees, 0–180. */
export function angleBetween(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * The Earth's position from the Sun, equatorial, in AU, from the Sun's
 * low-precision coordinates (Astronomical Almanac, good to 0.01°). SPHEREx
 * orbits the Earth, 700 km up; that is ~5e-5 AU and is ignored.
 */
export function earthPosition(mjd) {
  const n = mjd + 2400000.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) * D2R;
  const g = (357.528 + 0.9856003 * n) * D2R;
  const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const R = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  const eps = (23.439 - 0.0000004 * n) * D2R;
  // The Sun seen from the Earth, turned round.
  return [
    -R * Math.cos(lambda),
    -R * Math.cos(eps) * Math.sin(lambda),
    -R * Math.sin(eps) * Math.sin(lambda),
  ];
}

/**
 * How far parallax moves a star at (ra, dec) on `mjd`, arcseconds east and
 * north. The star is seen displaced away from where the Earth stands.
 */
export function parallaxOffset(ra, dec, plxMas, mjd) {
  if (!Number.isFinite(plxMas) || plxMas <= 0) return { east: 0, north: 0 };
  const [x, y, z] = earthPosition(mjd);
  const a = ra * D2R;
  const d = dec * D2R;
  const p = plxMas / 1000;
  return {
    east: p * (x * Math.sin(a) - y * Math.cos(a)),
    north: p * (x * Math.cos(a) * Math.sin(d) + y * Math.sin(a) * Math.sin(d) - z * Math.cos(d)),
  };
}

/**
 * The offset from the AllWISE position at which the object should stand on
 * `mjd`: its proper motion (mas/yr, μα·cosδ and μδ) times the years since
 * the AllWISE epoch, plus the parallax displacement on the day. The AllWISE
 * position itself averages over a year of scans, so no parallax is taken
 * off it; that is in the error budget instead.
 */
export function expectedOffset({ ra, dec, pmRA, pmDE, plx }, mjd, fromMjd = ALLWISE_MJD) {
  const years = (mjd - fromMjd) / 365.25;
  const par = parallaxOffset(ra, dec, plx, mjd);
  return {
    east: (pmRA / 1000) * years + par.east,
    north: (pmDE / 1000) * years + par.north,
  };
}

/** Carry a catalogue position with a proper motion from one epoch to another (no parallax). */
export function carry({ ra, dec, pmRA, pmDE }, fromEpoch, toEpoch) {
  const years = toEpoch - fromEpoch;
  return applyOffset(ra, dec, (pmRA / 1000) * years, (pmDE / 1000) * years);
}

/** Median of the finite values; NaN when there are none. */
export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Median of the samples between radii r0 and r1 (samples) of (x, y). */
export function annulusMedian(image, width, height, x, y, r0, r1) {
  const values = [];
  const lo = r0 * r0;
  const hi = r1 * r1;
  for (let j = Math.max(0, Math.floor(y - r1)); j <= Math.min(height - 1, Math.ceil(y + r1)); j++) {
    for (let i = Math.max(0, Math.floor(x - r1)); i <= Math.min(width - 1, Math.ceil(x + r1)); i++) {
      const r2 = (i - x) ** 2 + (j - y) ** 2;
      if (r2 >= lo && r2 <= hi) values.push(image[j * width + i]);
    }
  }
  return median(values);
}

/**
 * Sum of (image − sky) over the samples within `r` of (x, y), and how many
 * samples that was. Samples without a value are skipped and counted apart.
 */
export function apertureSum(image, width, height, x, y, r, sky) {
  let sum = 0;
  let n = 0;
  let holes = 0;
  for (let j = Math.max(0, Math.floor(y - r)); j <= Math.min(height - 1, Math.ceil(y + r)); j++) {
    for (let i = Math.max(0, Math.floor(x - r)); i <= Math.min(width - 1, Math.ceil(x + r)); i++) {
      if ((i - x) ** 2 + (j - y) ** 2 > r * r) continue;
      const v = image[j * width + i];
      if (Number.isFinite(v)) { sum += v - sky; n++; } else holes++;
    }
  }
  return { sum, n, holes };
}

/**
 * The brightest point within `radius` samples of (x, y), after smoothing
 * with the PSF: a matched filter, so a single hot sample does not win over a
 * real star. Returns the sample indices, or null when the window is empty.
 */
export function findPeak(image, width, height, x, y, radius, sigma, sky = 0) {
  const reach = Math.ceil(3 * sigma);
  let best = null;
  for (let j = Math.max(0, Math.floor(y - radius)); j <= Math.min(height - 1, Math.ceil(y + radius)); j++) {
    for (let i = Math.max(0, Math.floor(x - radius)); i <= Math.min(width - 1, Math.ceil(x + radius)); i++) {
      if ((i - x) ** 2 + (j - y) ** 2 > radius * radius) continue;
      let s = 0;
      let w = 0;
      for (let v = Math.max(0, j - reach); v <= Math.min(height - 1, j + reach); v++) {
        for (let u = Math.max(0, i - reach); u <= Math.min(width - 1, i + reach); u++) {
          const p = image[v * width + u];
          if (!Number.isFinite(p)) continue;
          const g = Math.exp(-((u - i) ** 2 + (v - j) ** 2) / (2 * sigma * sigma));
          s += g * (p - sky);
          w += g;
        }
      }
      if (w > 0 && (!best || s / w > best.value)) best = { x: i, y: j, value: s / w };
    }
  }
  return best;
}

/**
 * A windowed centroid (the XWIN of SExtractor): moments weighted by a
 * Gaussian of the PSF's own width, iterated from a start point. For a
 * Gaussian source the factor of two makes it land on the true centre, and it
 * is far less pulled by noise and neighbours than a plain first moment.
 */
export function windowedCentroid(image, width, height, x0, y0, sigma, sky = 0, { iterations = 30, tolerance = 1e-4 } = {}) {
  let x = x0;
  let y = y0;
  const reach = Math.ceil(4 * sigma);
  for (let it = 0; it < iterations; it++) {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    for (let j = Math.max(0, Math.floor(y - reach)); j <= Math.min(height - 1, Math.ceil(y + reach)); j++) {
      for (let i = Math.max(0, Math.floor(x - reach)); i <= Math.min(width - 1, Math.ceil(x + reach)); i++) {
        const p = image[j * width + i];
        if (!Number.isFinite(p)) continue;
        const w = Math.exp(-((i - x) ** 2 + (j - y) ** 2) / (2 * sigma * sigma)) * (p - sky);
        sw += w;
        sx += w * (i - x);
        sy += w * (j - y);
      }
    }
    if (!(sw > 0)) return { x: x0, y: y0, converged: false };
    const dx = (2 * sx) / sw;
    const dy = (2 * sy) / sw;
    x += dx;
    y += dy;
    // A centroid that wanders off by more than the PSF has lost the source.
    if (Math.hypot(x - x0, y - y0) > 3 * sigma) return { x: x0, y: y0, converged: false };
    if (Math.hypot(dx, dy) < tolerance) return { x, y, converged: true };
  }
  return { x, y, converged: true };
}

/**
 * Per-axis centroid error of a source of a given SNR: the PSF's sigma over
 * the SNR, times √2 for the background-limited case. A plain approximation,
 * stated as one.
 */
export function centroidSigma(snr, fwhm = PSF_FWHM_ARCSEC) {
  return snr > 0 ? (fwhm / 2.355) * Math.SQRT2 / snr : Infinity;
}

/**
 * The comparison itself. `measured` and `expected` are offsets from the
 * AllWISE position (arcsec east, north); `sigma` the total per-axis error.
 *
 *   recovered          detected clearly away from the AllWISE position (5 σ)
 *                      and within `floor` of where the motion puts it;
 *   too small to tell  it agrees, but the motion is under 5 σ;
 *   disagrees          detected, but further than `floor` from the prediction.
 *
 * `withinErrors` says separately whether the residual is inside the 99.7 %
 * circle of a two-dimensional Gaussian (3.44 σ). A recovery outside it is
 * still a recovery at the scale of the pixels, but the stated errors do not
 * cover it, and the write-up says so.
 */
export function compareMotion(measured, expected, sigma, { floor = RESIDUAL_FLOOR_ARCSEC } = {}) {
  const measuredShift = Math.hypot(measured.east, measured.north);
  const expectedShift = Math.hypot(expected.east, expected.north);
  const residual = Math.hypot(measured.east - expected.east, measured.north - expected.north);
  const withinErrors = residual <= 3.44 * sigma;
  const agrees = withinErrors || residual <= floor;
  const moved = measuredShift >= 5 * sigma;
  let verdict;
  if (agrees && moved) verdict = 'recovered';
  else if (agrees) verdict = 'too small to tell';
  else verdict = 'disagrees';
  return {
    measuredShift,
    expectedShift,
    residual,
    measuredPA: positionAngle(measured.east, measured.north),
    expectedPA: positionAngle(expected.east, expected.north),
    ratio: expectedShift > 0 ? measuredShift / expectedShift : NaN,
    significance: measuredShift / sigma,
    withinErrors,
    verdict,
  };
}

/**
 * A straight-line fit of position against time, weighted by each point's
 * error: the proper motion SPHEREx measures on its own, from its seasons.
 * `points` are { t (years), east, north (arcsec), sigma (arcsec, per axis) }
 * with the parallax already taken off. Returns arcsec/yr east and north and
 * their error, or null with fewer than two points or no spread in time.
 *
 * The error is scaled up by √(reduced χ²) when the points scatter about the
 * line more than their own errors say: over a one-year baseline the
 * season-to-season systematics, not the centroids, set how well the motion
 * is known, and an error that ignored them would claim too much.
 */
export function fitMotion(points) {
  if (points.length < 2) return null;
  let sw = 0; let st = 0; let stt = 0; let se = 0; let sn = 0; let ste = 0; let stn = 0;
  for (const { t, east, north, sigma } of points) {
    const w = 1 / (sigma * sigma);
    sw += w; st += w * t; stt += w * t * t;
    se += w * east; sn += w * north; ste += w * t * east; stn += w * t * north;
  }
  const det = sw * stt - st * st;
  if (!(det > 0) || stt / sw - (st / sw) ** 2 < 1e-6) return null;
  const pmEast = (sw * ste - st * se) / det;
  const pmNorth = (sw * stn - st * sn) / det;
  const e0 = (se - pmEast * st) / sw;
  const n0 = (sn - pmNorth * st) / sw;
  let chi2 = 0;
  for (const { t, east, north, sigma: s } of points) {
    chi2 += ((east - e0 - pmEast * t) ** 2 + (north - n0 - pmNorth * t) ** 2) / (s * s);
  }
  const dof = 2 * points.length - 4;
  const reducedChi2 = dof > 0 ? chi2 / dof : NaN;
  const scale = reducedChi2 > 1 ? Math.sqrt(reducedChi2) : 1;
  const sigma = Math.sqrt(sw / det) * scale;
  return { pmEast, pmNorth, sigma, reducedChi2, total: Math.hypot(pmEast, pmNorth), pa: positionAngle(pmEast, pmNorth) };
}

/** Split frames sorted by time into seasons wherever they are `gapDays` apart. */
export function seasons(frames, gapDays = SEASON_GAP_DAYS) {
  const sorted = [...frames].sort((a, b) => a.mjd - b.mjd);
  const out = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && f.mjd - last[last.length - 1].mjd < gapDays) last.push(f);
    else out.push([f]);
  }
  return out;
}

/** The mean of same-sized images, sample by sample, skipping holes. */
export function stackMean(images) {
  const n = images[0].length;
  const out = new Float32Array(n).fill(NaN);
  for (let k = 0; k < n; k++) {
    let s = 0;
    let c = 0;
    for (const im of images) {
      const v = im[k];
      if (Number.isFinite(v)) { s += v; c++; }
    }
    if (c) out[k] = s / c;
  }
  return out;
}

/** Parse a VizieR ASU-TSV answer: header line, units line, dashes, then rows. */
export function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  if (lines.length < 3) return [];
  const head = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(3).map((line) => {
    const cells = line.split('\t');
    const row = {};
    head.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
}

const num = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/* ------------------------------------------------------------- fetching */

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

const slug = (name) => name.replace(/[^A-Za-z0-9+-]+/g, '_');

let OFFLINE = false;

/**
 * A cached answer, or the fetch that makes one. An answer `keep` turns down
 * is returned but not written, so the next run asks again.
 */
async function cached(file, make, keep = () => true) {
  const have = await readJson(file);
  if (have) return have;
  if (OFFLINE) throw new Error('not cached and --offline');
  const made = await make();
  if (keep(made)) await writeJson(file, made);
  return made;
}

async function fetchText(url, { tries = 3, timeoutMs = 120_000 } = {}) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      return await res.text();
    } catch (err) {
      last = err;
      if (attempt + 1 < tries) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw last;
}

/** The whole Kirkpatrick et al. 2021 table: a few hundred rows, asked once. */
function kirkpatrickTable() {
  const cols = 'Name,SpAd,plx,e_plx,pmRA,e_pmRA,pmDE,e_pmDE,RACdeg,DECdeg,W2mag,W2magC2,ch2mag,FName';
  const url = `${VIZIER}?-source=${KIRKPATRICK}&-out.max=99999&-out=${cols}`;
  return cached(join(CACHE, 'kirkpatrick2021.json'), async () => ({ url, rows: parseTsv(await fetchText(url)) }));
}

/** AllWISE rows within `arcsec` of a position. */
function allwiseCone(name, ra, dec, arcsec) {
  const q = new URLSearchParams({
    '-source': ALLWISE,
    '-c': `${ra.toFixed(6)} ${dec >= 0 ? '+' : ''}${dec.toFixed(6)}`,
    '-c.rs': String(arcsec),
    '-out': 'AllWISE,RAJ2000,DEJ2000,eeMaj,RA_pm,DE_pm,e_RA_pm,e_DE_pm,W2mag,ccf,qph',
    '-out.add': '_r',
    '-out.max': '50',
  });
  const url = `${VIZIER}?${q}`;
  // The VizieR mirror now and then answers a cone with no table at all, which
  // reads as "nothing there". An empty answer is asked again a few times, and
  // never cached: a source missing from AllWISE stays missing on every ask.
  return cached(join(CACHE, slug(name), 'allwise.json'), async () => {
    let rows = [];
    for (let attempt = 0; attempt < 4 && !rows.length; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 4000));
      rows = parseTsv(await fetchText(url));
    }
    return { url, rows };
  }, (answer) => answer.rows.length > 0);
}

/** Gaia DR3 stars within `arcsec` of a position, at their 2016.0 positions. */
function gaiaCone(name, ra, dec, arcsec) {
  const q = new URLSearchParams({
    '-source': GAIA,
    '-c': `${ra.toFixed(6)} ${dec >= 0 ? '+' : ''}${dec.toFixed(6)}`,
    '-c.rs': arcsec.toFixed(0),
    '-out': 'Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Gmag',
    Gmag: `<${FIELD_STAR_G + 2.5}`,
    '-out.max': '5000',
  });
  const url = `${VIZIER}?${q}`;
  const file = join(CACHE, slug(name), `gaia_${ra.toFixed(4)}_${dec.toFixed(4)}_${arcsec.toFixed(0)}.json`);
  // Asked again when empty, and not cached then, as allwiseCone explains.
  return cached(file, async () => {
    let rows = [];
    for (let attempt = 0; attempt < 4 && !rows.length; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 4000));
      rows = parseTsv(await fetchText(url));
    }
    const stars = rows.map((r) => ({
      id: r.Source, ra: num(r.RA_ICRS), dec: num(r.DE_ICRS), pmRA: num(r.pmRA) ?? 0, pmDE: num(r.pmDE) ?? 0, mag: num(r.Gmag),
    })).filter((st) => st.ra != null && st.dec != null && st.mag != null);
    return { url, stars };
  }, (answer) => answer.stars.length > 0);
}

/**
 * The SPHEREx D5 and D6 frames IRSA lists at a position, from every
 * collection the page reads. Each collection is asked up to five times: IRSA
 * answers a 502 now and then, and one bad answer should not cost a target.
 * Nothing is cached unless every collection answered, so a partial list is
 * never taken for the whole one.
 */
async function spherexFrames(name, ra, dec) {
  const { parseVOTable } = await import('../public/js/votable.js');
  const { COLLECTIONS } = await import('../public/js/release.js');
  const { frameFromRow } = await import('../public/js/catalog.js');
  return cached(join(CACHE, slug(name), 'frames.json'), async () => {
    const rows = [];
    for (const collection of COLLECTIONS) {
      const pos = encodeURIComponent(`circle ${ra} ${dec} 0.006`);
      const text = await fetchText(`${SIA}?COLLECTION=${collection}&POS=${pos}&MAXREC=2000`, { tries: 5, timeoutMs: 180_000 });
      const { status, message, rows: found } = parseVOTable(text);
      if (status === 'ERROR') throw new Error(`IRSA ${collection}: ${message}`);
      rows.push(...found);
    }
    const frames = rows.filter((r) => r.dataproduct_subtype === 'science').map(frameFromRow).filter(Boolean)
      .filter((f) => BANDS.includes(f.band));
    // One exposure can be listed by more than one release: keep the first.
    const seen = new Set();
    return frames.filter((f) => {
      const key = `${f.band}:${f.mjd.toFixed(5)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

/**
 * One frame cut onto the object's grid, from the cache or the S3 mirror.
 * Returns { skip } for a frame that does not cover the grid.
 */
async function frameStamp(name, frame, grid, gridKey) {
  const file = join(CACHE, slug(name), 'stamps', `${frame.obsId}_${frame.band}_${gridKey}.json`);
  const have = await readJson(file);
  if (have) {
    if (have.skip) return have;
    return {
      ...have,
      data: floatsFrom(have.data),
      quality: new Uint8Array(Buffer.from(have.quality, 'base64')),
    };
  }
  if (OFFLINE) throw new Error('not cached and --offline');
  const { loadStamp } = await import('../public/js/stamp.js');
  const { toS3 } = await import('../public/js/catalog.js');
  const stamp = await loadStamp(toS3(frame.url), grid, { minCoverage: 0.9 });
  if (!stamp) {
    await writeJson(file, { skip: 'frame does not cover the grid' });
    return { skip: 'frame does not cover the grid' };
  }
  const kept = {
    obsId: frame.obsId,
    band: frame.band,
    mjd: Number(stamp.meta.mjd) || frame.mjd,
    sigma: stamp.meta.detectorSigma,
    unit: stamp.meta.unit,
    coverage: stamp.coverage,
    bytesRead: stamp.meta.bytesRead,
  };
  await writeJson(file, {
    ...kept,
    data: Buffer.from(stamp.data.buffer, stamp.data.byteOffset, stamp.data.byteLength).toString('base64'),
    quality: Buffer.from(stamp.quality).toString('base64'),
  });
  return { ...kept, data: stamp.data, quality: stamp.quality };
}

/** A Float32Array back from its base64 text, copied out of Node's shared buffer pool. */
function floatsFrom(base64) {
  const bytes = Buffer.from(base64, 'base64');
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Run `task` over `items`, `limit` at a time. */
async function pool(items, limit, task) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------- measuring */

/** Grid scale in arcsec, and the PSF's sigma in grid samples. */
const gridScale = (grid) => grid.scale * 3600;
const psfSamples = (grid) => PSF_FWHM_ARCSEC / 2.355 / gridScale(grid);

/**
 * Aperture signal to noise at a fixed grid position, against `sigmaDet`, the
 * sky noise of one detector pixel. A grid sample covers (scale / 6.15)² of a
 * detector pixel, so sums and counts are turned into detector pixels first.
 */
function apertureSnr(image, grid, x, y, sigmaDet) {
  const scale = gridScale(grid);
  const sky = annulusMedian(image, grid.width, grid.height, x, y, ANNULUS_ARCSEC[0] / scale, ANNULUS_ARCSEC[1] / scale);
  if (!Number.isFinite(sky)) return NaN;
  const perDet = (scale / DETECTOR_ARCSEC) ** 2;
  const ap = apertureSum(image, grid.width, grid.height, x, y, APERTURE_ARCSEC / scale, sky);
  const noise = sigmaDet * Math.sqrt(ap.n * perDet);
  return noise > 0 ? (ap.sum * perDet) / noise : NaN;
}

/**
 * Find a point source within `searchArcsec` of `predicted` and centroid it.
 * Returns its position, its aperture SNR and whether the centroid settled,
 * or null when there is nothing to measure (off the grid, no sky).
 */
function measureSource(image, grid, predicted, sigmaDet, searchArcsec = SEARCH_ARCSEC) {
  const scale = gridScale(grid);
  const psf = psfSamples(grid);
  const at = grid.worldToIndex(predicted.ra, predicted.dec);
  if (!at) return null;
  const [px, py] = at;
  const sky = annulusMedian(image, grid.width, grid.height, px, py, ANNULUS_ARCSEC[0] / scale, ANNULUS_ARCSEC[1] / scale);
  if (!Number.isFinite(sky)) return null;
  const peak = findPeak(image, grid.width, grid.height, px, py, searchArcsec / scale, psf, sky);
  if (!peak) return null;
  const c = windowedCentroid(image, grid.width, grid.height, peak.x, peak.y, psf, sky);
  const [ra, dec] = grid.indexToWorld(c.x, c.y);
  return { x: c.x, y: c.y, ra, dec, converged: c.converged, snr: apertureSnr(image, grid, c.x, c.y, sigmaDet) };
}

/** Grid samples inside the aperture whose detector pixel saturated (QUALITY.OVERFLOW). */
function saturatedSamples(quality, grid, x, y) {
  if (!quality) return 0;
  const r = APERTURE_ARCSEC / gridScale(grid);
  let n = 0;
  for (let j = Math.max(0, Math.floor(y - r)); j <= Math.min(grid.height - 1, Math.ceil(y + r)); j++) {
    for (let i = Math.max(0, Math.floor(x - r)); i <= Math.min(grid.width - 1, Math.ceil(x + r)); i++) {
      if ((i - x) ** 2 + (j - y) ** 2 <= r * r && quality[j * grid.width + i] & 1) n++;
    }
  }
  return n;
}

const sepArcsec = (a, b) => Math.hypot(...Object.values(offsetArcsec(a.ra, a.dec, b.ra, b.dec)));

/**
 * The astrometry of an image checked against Gaia. `measure(position)`
 * centroids whatever is near a sky position in the image; `stars` are Gaia
 * DR3 stars, carried here to `epoch`. Their median offset is how far the
 * image's WCS puts a star from where Gaia has it, and 1.4826 × the median
 * absolute deviation is the scatter round that. Stars within `avoidArcsec`
 * of any `avoid` position (the brown dwarf, then and now) are left out.
 */
export function fieldStarOffsets(measure, stars, epoch, { avoid = [], avoidArcsec = 25, minSnr = FIELD_STAR_SNR, lostArcsec = FIELD_STAR_LOST_ARCSEC } = {}) {
  const offsets = [];
  for (const star of stars) {
    const at = carry(star, GAIA_EPOCH, epoch);
    if (avoid.some((p) => sepArcsec(p, at) < avoidArcsec)) continue;
    const m = measure(at);
    if (!m || !m.converged || !(m.snr >= minSnr)) continue;
    const off = offsetArcsec(at.ra, at.dec, m.ra, m.dec);
    if (Math.hypot(off.east, off.north) > lostArcsec) continue;
    offsets.push(off);
  }
  if (!offsets.length) return { n: 0, east: 0, north: 0, scatter: NaN };
  const east = median(offsets.map((o) => o.east));
  const north = median(offsets.map((o) => o.north));
  const mad = median(offsets.flatMap((o) => [Math.abs(o.east - east), Math.abs(o.north - north)]));
  return { n: offsets.length, east, north, scatter: 1.4826 * mad };
}

/**
 * Stars with no other star within `radiusArcsec` brighter than their own
 * magnitude plus `deltaMag`: what can be centroided cleanly at 6″ pixels.
 */
export function isolatedStars(stars, { radiusArcsec = 15, deltaMag = 2.5 } = {}) {
  return stars.filter((s) => !stars.some((o) => o !== s && o.mag < s.mag + deltaMag && sepArcsec(s, o) < radiusArcsec));
}

/**
 * Which season stack speaks for the object. When most detected seasons are
 * recovered, the object is: the brightest of those is the headline, and the
 * seasons that disagree are counted as outliers (a ghost, a neighbour or a
 * cosmic-ray cluster in one stack should not overrule five clean ones). When
 * they are not, the brightest detected stack decides, whatever it says. With
 * nothing detected, the brightest stack is shown and the object is too faint.
 */
export function headline(stacks) {
  const detected = stacks.filter((s) => s.verdict !== 'too faint');
  const recovered = detected.filter((s) => s.verdict === 'recovered');
  const brightest = (list) => list.slice().sort((a, b) => b.snr - a.snr)[0] ?? null;
  if (recovered.length && recovered.length > detected.length / 2) {
    return { best: brightest(recovered), outliers: detected.length - recovered.length };
  }
  return { best: brightest(detected.length ? detected : stacks), outliers: 0 };
}

const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const isoDay = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);
const meanOf = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

/** Everything about one object, or the reason it could not be measured. */
async function measureTarget(target, table) {
  const row = table.rows.find((r) => r.Name === target.name);
  const result = {
    name: target.name,
    label: target.label,
    sources: [
      `VizieR ${KIRKPATRICK} (Kirkpatrick et al. 2021)`, `VizieR ${ALLWISE} (AllWISE)`, `VizieR ${GAIA} (Gaia DR3, field stars)`,
      'IRSA SIA: spherex_dr1, spherex_dr1_deep, spherex_qr3, spherex_qr3_deep', 'nasa-irsa-spherex S3 mirror',
    ],
  };
  if (!row) return { ...result, verdict: 'not in catalogue' };

  const cat = {
    pmRA: num(row.pmRA), pmDE: num(row.pmDE), e_pmRA: num(row.e_pmRA), e_pmDE: num(row.e_pmDE),
    plx: num(row.plx), e_plx: num(row.e_plx), ra: num(row.RACdeg), dec: num(row.DECdeg),
    w2: num(row.W2mag) ?? num(row.W2magC2), ch2: num(row.ch2mag),
  };
  result.spectralType = spectralType(num(row.SpAd));
  result.fullName = row.FName;
  result.catalogue = {
    pmRA: cat.pmRA, pmDE: cat.pmDE, pmTotal: round(Math.hypot(cat.pmRA, cat.pmDE) / 1000, 3),
    pmPA: round(positionAngle(cat.pmRA, cat.pmDE), 1), plx: cat.plx, w2: cat.w2,
    units: 'pmRA (μα·cosδ), pmDE, plx in mas and mas/yr; pmTotal in arcsec/yr',
  };

  // AllWISE: look where the catalogue motion puts the object at 2010.56.
  const then = carry(cat, CATWISE_EPOCH, ALLWISE_EPOCH);
  let aw;
  try {
    aw = await allwiseCone(target.name, then.ra, then.dec, 15);
  } catch (err) {
    return { ...result, verdict: 'catalogue unreachable', note: `AllWISE: ${err.message}` };
  }
  const refMag = cat.w2 ?? cat.ch2;
  const candidates = aw.rows.map((r) => ({
    id: r.AllWISE, w2: num(r.W2mag), sep: num(r._r),
    ra: num(r.RA_pm) ?? num(r.RAJ2000), dec: num(r.DE_pm) ?? num(r.DEJ2000),
    motionFit: num(r.RA_pm) != null,
    err: Math.max(num(r.e_RA_pm) ?? 0, num(r.e_DE_pm) ?? 0, num(r.eeMaj) ?? 0),
  })).filter((c) => c.ra != null).sort((a, b) => a.sep - b.sep);
  const match = candidates.find((c) => refMag != null && c.w2 != null && Math.abs(c.w2 - refMag) < 1) ?? candidates[0];
  if (!match) return { ...result, verdict: 'no AllWISE match', note: 'nothing within 15″ of the back-propagated position' };
  const allwise = { ra: match.ra, dec: match.dec };
  result.allwise = {
    id: match.id, ra: match.ra, dec: match.dec, w2: match.w2, positionError: match.err,
    epoch: round(ALLWISE_EPOCH, 4), column: match.motionFit ? 'RA_pm/DE_pm (MJD 55400)' : 'RAJ2000/DEJ2000',
    offsetFromCatwise: round(sepArcsec(then, match), 2),
  };

  const motion = { ra: allwise.ra, dec: allwise.dec, pmRA: cat.pmRA, pmDE: cat.pmDE, plx: cat.plx };
  const toward = (mjd, f = 1) => applyOffset(allwise.ra, allwise.dec,
    ...Object.values(expectedOffset(motion, mjd)).map((v) => v * f));
  const mid = toward(MJD_2026);

  let frames;
  try {
    frames = await spherexFrames(target.name, mid.ra, mid.dec);
  } catch (err) {
    return { ...result, verdict: 'IRSA unreachable', note: err.message };
  }
  result.frames = { listed: frames.length, read: 0, failed: 0, notCovering: 0, errors: [] };
  if (!frames.length) return { ...result, verdict: 'no SPHEREx frames' };

  // One grid per object, wide enough for both positions over the whole run
  // and for a few field stars to check the astrometry against.
  const { TangentGrid } = await import('../public/js/wcs.js');
  const span = Math.hypot(...Object.values(expectedOffset(motion, MJD_END)));
  const centre = toward(MJD_2026, 0.5);
  const size = Math.ceil(Math.max(MIN_GRID_ARCSEC, span + 2 * GRID_MARGIN_ARCSEC) / SAMPLE_ARCSEC);
  const grid = new TangentGrid(centre.ra, centre.dec, (size * SAMPLE_ARCSEC) / 3600, size, size);
  const gridKey = `${centre.ra.toFixed(5)}_${centre.dec.toFixed(5)}_${size}x${SAMPLE_ARCSEC}`;

  let gaia = [];
  try {
    const half = (size * SAMPLE_ARCSEC) / 2 - ANNULUS_ARCSEC[1];
    const { stars } = await gaiaCone(target.name, centre.ra, centre.dec, half * Math.SQRT2);
    gaia = isolatedStars(stars).filter((s) => {
      const o = offsetArcsec(centre.ra, centre.dec, s.ra, s.dec);
      return Math.abs(o.east) < half && Math.abs(o.north) < half && s.mag <= FIELD_STAR_G;
    });
  } catch (err) {
    result.gaiaNote = `Gaia DR3 unreachable: ${err.message}`;
  }

  const stamps = (await pool(frames, 6, async (f) => {
    try {
      const s = await frameStamp(target.name, f, grid, gridKey);
      if (s.skip) { result.frames.notCovering++; return null; }
      result.frames.read++;
      return s;
    } catch (err) {
      result.frames.failed++;
      if (result.frames.errors.length < 3) result.frames.errors.push(String(err.message).slice(0, 160));
      return null;
    }
  })).filter((s) => s && Number.isFinite(s.sigma) && s.sigma > 0);
  if (!stamps.length) {
    return { ...result, verdict: result.frames.failed ? 'S3 unreachable' : 'no usable frames' };
  }

  const pmErr = Math.hypot(cat.e_pmRA ?? 0, cat.e_pmDE ?? 0) / 1000 / Math.SQRT2;
  const budget = (snr, mjd, systematic) => Math.hypot(
    centroidSigma(snr),
    match.err || 0.1,
    pmErr * ((mjd - ALLWISE_MJD) / 365.25),
    systematic,
    // AllWISE averages a year of scans, so its position carries part of the
    // parallax wobble; half the parallax is allowed for it.
    (cat.plx ?? 0) / 1000 / 2,
  );

  /**
   * The brown dwarf in one image taken over `mjds`: where it was found, where
   * the AllWISE position and the motion put it, and the comparison, with the
   * field stars' offset taken off when there are enough of them.
   */
  const measureAt = (image, mjds, sigmaDet, quality, { checkField }) => {
    const mjd = meanOf(mjds);
    const offs = mjds.map((m) => expectedOffset(motion, m));
    const expected = { east: meanOf(offs.map((o) => o.east)), north: meanOf(offs.map((o) => o.north)) };
    const predicted = applyOffset(allwise.ra, allwise.dec, expected.east, expected.north);
    const m = measureSource(image, grid, predicted, sigmaDet);
    if (!m) return null;

    const field = checkField && gaia.length
      ? fieldStarOffsets((at) => measureSource(image, grid, at, sigmaDet, FIELD_STAR_SEARCH_ARCSEC), gaia, epochOfMjd(mjd),
        { avoid: [allwise, predicted] })
      : { n: 0, east: 0, north: 0, scatter: NaN };
    const corrected = field.n >= MIN_FIELD_STARS;
    const systematic = corrected ? Math.max(0.1, (1.2533 * field.scatter) / Math.sqrt(field.n)) : SYSTEMATIC_ARCSEC;
    const raw = offsetArcsec(allwise.ra, allwise.dec, m.ra, m.dec);
    const offset = corrected ? { east: raw.east - field.east, north: raw.north - field.north } : raw;
    const sigma = budget(m.snr, mjd, systematic);

    // A second reference: the CatWISE2020 position Kirkpatrick et al. quote,
    // carried with the same motion. Independent of the AllWISE anchor.
    const viaCat = carry(cat, CATWISE_EPOCH, epochOfMjd(mjd));
    const par = mjds.map((t) => parallaxOffset(cat.ra, cat.dec, cat.plx, t));
    const catPredicted = applyOffset(viaCat.ra, viaCat.dec, meanOf(par.map((p) => p.east)), meanOf(par.map((p) => p.north)));
    const measuredSky = applyOffset(allwise.ra, allwise.dec, offset.east, offset.north);

    // Is the AllWISE spot empty now? Meaningful only when the apertures do not overlap.
    const [ax, ay] = grid.worldToIndex(allwise.ra, allwise.dec);
    const apart = Math.hypot(expected.east, expected.north) > 2 * APERTURE_ARCSEC;

    const parallax = mjds.map((t) => parallaxOffset(allwise.ra, allwise.dec, cat.plx, t));
    return {
      m, mjd, sigma, field, corrected, offset,
      parallax: { east: meanOf(parallax.map((p) => p.east)), north: meanOf(parallax.map((p) => p.north)) },
      cmp: compareMotion(offset, expected, sigma),
      residualUncorrected: Math.hypot(raw.east - expected.east, raw.north - expected.north),
      residualCatwise: sepArcsec(catPredicted, measuredSky),
      snrAtAllwise: apart ? apertureSnr(image, grid, ax, ay, sigmaDet) : NaN,
      saturated: saturatedSamples(quality, grid, m.x, m.y),
    };
  };

  // Single frames: no field-star correction, the frame's own WCS as it is.
  const singles = stamps.map((s) => measureAt(s.data, [s.mjd], s.sigma, s.quality, { checkField: false })).filter(Boolean);
  const goodSingles = singles.filter((r) => r.m.snr >= MIN_SNR && r.m.converged);

  // Season stacks per band, field stars checked in each.
  const stacks = [];
  const fitPoints = [];
  for (const band of BANDS) {
    for (const group of seasons(stamps.filter((s) => s.band === band))) {
      const image = stackMean(group.map((s) => s.data));
      const sigmaDet = Math.sqrt(group.reduce((t, s) => t + s.sigma ** 2, 0)) / group.length;
      const r = measureAt(image, group.map((s) => s.mjd), sigmaDet, null, { checkField: true });
      if (!r) continue;
      const detected = r.m.snr >= MIN_SNR && r.m.converged;
      stacks.push({
        band, n: group.length, from: isoDay(group[0].mjd), to: isoDay(group[group.length - 1].mjd),
        epoch: round(epochOfMjd(r.mjd), 3),
        snr: round(r.m.snr, 1),
        expectedShift: round(r.cmp.expectedShift), measuredShift: round(r.cmp.measuredShift),
        expectedPA: round(r.cmp.expectedPA, 1), measuredPA: round(r.cmp.measuredPA, 1),
        residual: round(r.cmp.residual), sigma: round(r.sigma), withinErrors: r.cmp.withinErrors,
        residualUncorrected: round(r.residualUncorrected),
        residualCatwise: round(r.residualCatwise),
        fieldStars: { n: r.field.n, east: round(r.field.east), north: round(r.field.north), scatter: round(r.field.scatter), applied: r.corrected },
        snrAtAllwise: round(r.snrAtAllwise, 1),
        verdict: detected ? r.cmp.verdict : 'too faint',
      });
      if (detected) {
        fitPoints.push({
          verdict: r.cmp.verdict,
          t: epochOfMjd(r.mjd),
          east: r.offset.east - r.parallax.east,
          north: r.offset.north - r.parallax.north,
          sigma: Math.hypot(centroidSigma(r.m.snr), r.corrected ? Math.max(0.1, (1.2533 * r.field.scatter) / Math.sqrt(r.field.n)) : SYSTEMATIC_ARCSEC),
        });
      }
    }
  }

  const detected = stacks.filter((s) => s.verdict !== 'too faint');
  const { best, outliers } = headline(stacks);
  // SPHEREx on its own: the motion across its own seasons, no WISE involved.
  // The seasons the verdict set aside as outliers are left out of it too.
  const used = outliers ? fitPoints.filter((p) => p.verdict === 'recovered') : fitPoints;
  const fit = fitMotion(used);
  const baseline = used.length ? Math.max(...used.map((p) => p.t)) - Math.min(...used.map((p) => p.t)) : 0;

  Object.assign(result, {
    band: best?.band ?? null,
    epoch: best?.epoch ?? null,
    nVisits: best?.n ?? 0,
    snr: best?.snr ?? null,
    expectedShift: best?.expectedShift ?? null,
    measuredShift: best?.measuredShift ?? null,
    expectedPA: best?.expectedPA ?? null,
    measuredPA: best?.measuredPA ?? null,
    residual: best?.residual ?? null,
    sigma: best?.sigma ?? null,
    withinErrors: best?.withinErrors ?? null,
    residualCatwise: best?.residualCatwise ?? null,
    spherexOnly: fit && baseline >= 0.4 ? {
      seasons: used.length, baselineYears: round(baseline),
      pmTotal: round(fit.total, 3), pmPA: round(fit.pa, 1), sigma: round(fit.sigma, 3), reducedChi2: round(fit.reducedChi2, 1),
      units: 'arcsec/yr; from SPHEREx season stacks alone, parallax removed',
    } : null,
    fieldStars: best?.fieldStars ?? null,
    snrAtAllwise: best?.snrAtAllwise ?? null,
    seasonsDetected: detected.length,
    seasonsRecovered: detected.filter((s) => s.verdict === 'recovered').length,
    seasonsSetAside: outliers,
    singleFrames: {
      measured: singles.length,
      atFiveSigma: goodSingles.length,
      recovered: goodSingles.filter((r) => r.cmp.verdict === 'recovered').length,
      medianResidual: round(median(goodSingles.map((r) => r.cmp.residual))),
      medianSnr: round(median(singles.map((r) => r.m.snr)), 1),
      withSaturatedPixels: singles.filter((r) => r.saturated > 0).length,
    },
    stacks,
    verdict: best ? best.verdict : 'too faint',
  });
  return result;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const args = process.argv.slice(2);
  OFFLINE = args.includes('--offline');
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const targets = TARGETS.filter((t) => !only || t.name === only || t.label === only);

  await mkdir(CACHE, { recursive: true });
  const previous = await readJson(OUT);
  const byName = new Map((previous?.objects ?? []).map((o) => [o.name, o]));

  let table;
  try {
    table = await kirkpatrickTable();
  } catch (err) {
    console.error(`Kirkpatrick et al. 2021 table unreachable: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  for (const target of targets) {
    const t0 = Date.now();
    process.stdout.write(`${target.label.padEnd(18)} `);
    let r;
    try {
      r = await measureTarget(target, table);
    } catch (err) {
      r = { name: target.name, label: target.label, verdict: 'error', note: err.message };
    }
    byName.set(target.name, r);
    const f = r.frames ? `${r.frames.read}/${r.frames.listed} frames` : '';
    console.log(`${r.verdict.padEnd(18)} exp ${r.expectedShift ?? '–'}″  got ${r.measuredShift ?? '–'}″  `
      + `resid ${r.residual ?? '–'}″  SNR ${r.snr ?? '–'}  ${r.band ?? ''}  ${f}  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    await writeOut(byName);
  }
}

async function writeOut(byName) {
  const objects = TARGETS.map((t) => byName.get(t.name)).filter(Boolean);
  const out = {
    about: 'Proper motion of nearby brown dwarfs from AllWISE (2010.56) to SPHEREx (2025–2026), measured from SPHEREx D5/D6 frames. See docs/bd-motion.md.',
    generated: new Date().toISOString().slice(0, 10),
    method: {
      allwiseEpoch: round(ALLWISE_EPOCH, 4),
      psfFwhmArcsec: PSF_FWHM_ARCSEC,
      sampleArcsec: SAMPLE_ARCSEC,
      searchArcsec: SEARCH_ARCSEC,
      apertureArcsec: round(APERTURE_ARCSEC),
      systematicArcsec: SYSTEMATIC_ARCSEC,
      minSnr: MIN_SNR,
      bands: BANDS,
    },
    objects,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

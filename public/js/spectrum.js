/**
 * spectrum.js — one marked source across SPHEREx's six bands, from every
 * exposure that saw it.
 *
 * SPHEREx has no filter wheel. Each detector sits behind a linear variable
 * filter, so the wavelength a source is seen at depends on which detector row
 * it lands on: "D2" is a range, 1.10–1.65 µm, and a single exposure samples one
 * narrow slice of it. A Level-2 file says which slice: its last extension,
 * WCS-WAVE, is a small lookup table of central wavelength and bandwidth over
 * the detector (the `-TAB` form of FITS WCS, alternate axis "W").
 *
 * So every exposure is a point at its own wavelength. Read enough of them and
 * the six bands fill in towards the instrument's 102 channels, and the
 * exposures that happen to share a wavelength say whether the source changed.
 *
 * Everything here is arithmetic on values already in hand — which exposures to
 * read, what the table says at a pixel, what an aperture sum is in millijansky,
 * which visits share a wavelength and what they say about a change.
 * The reading itself lives in stamp.js and app.js.
 */

import { readHeader } from './fits.js';
import { PIXEL_SR, APERTURE_PX } from './depth.js';
import { deltaRA } from './wcs.js';

export const BANDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];

/** The instrument's range, in micrometres: the chart's wavelength axis. */
export const WAVE_RANGE = [0.75, 5.0];

/** A non-detection is drawn at this many sigma, the threshold `measure` detects at. */
export const LIMIT_SIGMA = 5;

/**
 * Resolving power λ/Δλ of each band, as published for the instrument
 * (Crill et al. 2020, Proc. SPIE 11443, 114430I). The files agree: the
 * bandwidth column of WCS-WAVE gives 37–43 in D1–D4 and 108–134 in D5–D6.
 * Used only where a file's own bandwidth is missing.
 */
export const RESOLVING_POWER = { D1: 39, D2: 41, D3: 41, D4: 35, D5: 112, D6: 128 };

/**
 * How much two exposures see the same light: each one's channel is λ ± w/2,
 * w the bandwidth the file's WCS-WAVE table gives there or else λ/R for the
 * detector's resolving power, and the share is the overlap over the
 * narrower channel, 0 to 1. Two visits of one band can sit at different λ
 * where the field falls on a different part of the filter, and their
 * difference then holds the spectrum as well as any change in time.
 */
export function channelOverlap(a, b) {
  const range = ({ lambda, width, band }) => {
    const half = (width > 0 ? width : lambda / (RESOLVING_POWER[band] ?? 40)) / 2;
    return [lambda - half, lambda + half];
  };
  if (!Number.isFinite(a?.lambda) || !Number.isFinite(b?.lambda)) return null;
  const [a0, a1] = range(a);
  const [b0, b1] = range(b);
  const shared = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  return shared / Math.min(a1 - a0, b1 - b0);
}

/** How many exposures have their wavelength looked up, and how many of those are measured. */
export const MAX_POOL = 160;
export const MAX_MEASURED = 60;

/**
 * A source that moves is only looked for close in time to where it was
 * measured: SPHEREx takes a field in runs of exposures about two minutes
 * apart, and a main-belt asteroid crosses a 6.15″ pixel in some twenty.
 */
export const SAME_RUN_DAYS = 10 / 1440;

/* ------------------------------------------------------- which exposures */

/** `n` of a list, spread evenly from its first item to its last. */
export function spreadPick(items, n) {
  if (n <= 0) return [];
  if (items.length <= n) return items.slice();
  if (n === 1) return [items[Math.floor((items.length - 1) / 2)]];
  const picked = new Set();
  for (let k = 0; k < n; k++) picked.add(Math.round((k * (items.length - 1)) / (n - 1)));
  return [...picked].map((i) => items[i]);
}

/**
 * Where to look for a marked source at a given date, and over which dates.
 *
 * A source that stays put is looked for at the same place in every exposure.
 * One that moved through the loaded visits is followed along the straight
 * line fitted to its positions, and only over the dates it was measured,
 * give or take the time it takes to cross one detector pixel. One seen in a
 * single visit, with no motion known, is looked for in the exposures of that
 * same run only. Returns `{ at(mjd), from, to, kind }`.
 */
export function motionOf(mark, { pixelArcsec = 6.15 } = {}) {
  const track = (mark.track ?? []).filter((p) => Number.isFinite(p.mjd) && Number.isFinite(p.ra));
  const kind = mark.analysis?.kind ?? 'none';
  if (kind === 'moving' && track.length >= 2) {
    const t0 = track[0].mjd;
    const cosd = Math.cos((track[0].dec * Math.PI) / 180);
    const ra = track.map((p) => deltaRA(p.ra, track[0].ra) * cosd);
    const dec = track.map((p) => p.dec - track[0].dec);
    const dt = track.map((p) => p.mjd - t0);
    const line = (ys) => {
      const n = ys.length;
      const mx = dt.reduce((s, v) => s + v, 0) / n;
      const my = ys.reduce((s, v) => s + v, 0) / n;
      const sxx = dt.reduce((s, v) => s + (v - mx) ** 2, 0);
      const slope = sxx > 0 ? dt.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0) / sxx : 0;
      return { slope, at: (t) => my + slope * (t - mx) };
    };
    const fRa = line(ra);
    const fDec = line(dec);
    const degPerDay = Math.hypot(fRa.slope, fDec.slope);
    const pad = degPerDay > 0 ? pixelArcsec / 3600 / degPerDay : SAME_RUN_DAYS;
    const mjds = track.map((p) => p.mjd);
    return {
      kind: 'moving',
      from: Math.min(...mjds) - pad,
      to: Math.max(...mjds) + pad,
      at: (mjd) => ({
        ra: (((track[0].ra + fRa.at(mjd - t0) / cosd) % 360) + 360) % 360,
        dec: track[0].dec + fDec.at(mjd - t0),
      }),
    };
  }
  if (kind === 'transient' && track.length) {
    const seen = track[0];
    return {
      kind: 'run', from: seen.mjd - SAME_RUN_DAYS, to: seen.mjd + SAME_RUN_DAYS, at: () => ({ ra: seen.ra, dec: seen.dec }),
    };
  }
  // Still, or nothing seen at all: the same place throughout. Where it was
  // measured, the middle of those positions; otherwise where the click fell.
  const median = (vs) => vs.slice().sort((a, b) => a - b)[Math.floor(vs.length / 2)];
  const still = track.length
    ? { ra: (((track[0].ra + median(track.map((p) => deltaRA(p.ra, track[0].ra)))) % 360) + 360) % 360, dec: median(track.map((p) => p.dec)) }
    : { ra: mark.ra, dec: mark.dec };
  return { kind: 'still', from: -Infinity, to: Infinity, at: () => still };
}

/**
 * The exposures worth asking the wavelength of: every one already on the
 * plate, then the rest shared out between the bands as evenly as they allow,
 * each band's share spread over its whole time span. Only dates the motion
 * allows; one entry per file.
 */
export function visitPool(frames, { from = -Infinity, to = Infinity, loaded = new Set(), limit = MAX_POOL } = {}) {
  const seen = new Set();
  const usable = [];
  for (const f of frames) {
    if (!f?.url || seen.has(f.url) || !Number.isFinite(f.mjd) || f.mjd < from || f.mjd > to) continue;
    seen.add(f.url);
    usable.push(f);
  }
  const onPlate = usable.filter((f) => loaded.has(f.url));
  const rest = usable.filter((f) => !loaded.has(f.url));
  const picked = shareBetweenBands(rest, Math.max(0, limit - onPlate.length), (f) => f.band, (f) => f.mjd);
  return [...onPlate, ...picked].sort((a, b) => a.mjd - b.mjd);
}

/**
 * `n` items shared between the bands as evenly as they allow — one more for
 * each band that still has some, round after round — and each band's share
 * spread evenly along `order` (time, or wavelength).
 */
function shareBetweenBands(items, n, bandOf, order) {
  const byBand = new Map();
  for (const item of items) {
    const band = bandOf(item);
    if (!byBand.has(band)) byBand.set(band, []);
    byBand.get(band).push(item);
  }
  const share = new Map([...byBand.keys()].map((b) => [b, 0]));
  let left = n;
  while (left > 0) {
    let gave = false;
    for (const [band, list] of byBand) {
      if (left > 0 && share.get(band) < list.length) { share.set(band, share.get(band) + 1); left -= 1; gave = true; }
    }
    if (!gave) break;
  }
  return [...byBand].flatMap(([band, list]) => spreadPick(list.sort((a, b) => order(a) - order(b)), share.get(band)));
}

/* --------------------------------------------------- one wavelength, many */

/**
 * The width of one resolution element at a point, in micrometres: the
 * bandwidth the file gives at that pixel, or λ/R where it gives none.
 */
export function resolutionWidth(point) {
  if (point.width > 0) return point.width;
  const R = RESOLVING_POWER[point.band];
  return R && point.um > 0 ? point.um / R : null;
}

const medianOf = (values) => {
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The wavelengths seen most often: windows one resolution element wide
 * (±half of it about a centre), each inside one band, that hold the most
 * points. A point is `{ band, um, width? }` with a wavelength read from the
 * file — an unread one has no place in a window. Each window is centred on
 * the median of what fell in it, and no two overlap. Most populated first.
 */
export function wavelengthWindows(points, { max = 3, minCount = 3 } = {}) {
  const placed = points.filter((p) => p.um > 0 && p.measured !== false && resolutionWidth(p));
  const membersOf = (band, um, half) => placed.filter((p) => p.band === band && Math.abs(p.um - um) <= half + 1e-12);
  const candidates = placed.map((c) => {
    const half = resolutionWidth(c) / 2;
    const first = membersOf(c.band, c.um, half);
    const um = medianOf(first.map((p) => p.um));
    const members = membersOf(c.band, um, half);
    const spread = members.reduce((s, p) => s + Math.abs(p.um - um), 0) / members.length;
    return { band: c.band, um, half, members, spread };
  });
  candidates.sort((a, b) => b.members.length - a.members.length || a.spread - b.spread || a.um - b.um);
  const chosen = [];
  for (const c of candidates) {
    if (chosen.length >= max || c.members.length < minCount) break;
    if (chosen.some((o) => o.band === c.band && Math.abs(o.um - c.um) < o.half + c.half)) continue;
    chosen.push(c);
  }
  return chosen.map(({ band, um, half, members }) => ({ band, um, half, members }));
}

/**
 * Which of the pool to measure, at most `limit`: every exposure on the plate,
 * then the best-populated wavelengths in full (spread over time) so that
 * brightness can be compared at one wavelength, then the rest spread across
 * the wavelengths for the shape of the spectrum. A pool item is
 * `{ frame, place, loaded }`; only items with a place are considered.
 */
export function chooseMeasured(pool, limit = MAX_MEASURED) {
  const usable = pool.filter((p) => p.place);
  const chosen = new Set(usable.filter((p) => p.loaded).slice(0, limit));
  const add = (items, cap) => {
    for (const item of items) {
      if (chosen.size >= limit || cap <= 0) return;
      if (!chosen.has(item)) { chosen.add(item); cap -= 1; }
    }
  };
  const points = usable.map((item) => ({ ...item.place, band: item.frame.band, item }));
  const caps = [Math.ceil(limit * 0.4), Math.ceil(limit * 0.15), Math.ceil(limit * 0.15)];
  wavelengthWindows(points, { max: caps.length, minCount: 2 }).forEach((w, k) => {
    const items = w.members.map((m) => m.item).sort((a, b) => a.frame.mjd - b.frame.mjd);
    const fresh = items.filter((i) => !chosen.has(i));
    const room = caps[k] - (items.length - fresh.length);
    add(spreadPick(fresh, room), room);
  });
  const rest = usable.filter((i) => !chosen.has(i));
  add(shareBetweenBands(rest, limit - chosen.size, (i) => i.frame.band, (i) => i.place.um), limit);
  return [...chosen].sort((a, b) => a.frame.mjd - b.frame.mjd);
}

/**
 * The shape under the scatter: the median flux of the detections in bins a
 * four resolution elements wide (Δλ/λ = 4/R, about a tenth in D1–D4),
 * band by band. Sixty exposures spread over about a hundred resolution
 * elements leave most single-element bins with one point or none; four
 * gather enough for a median and still follow the shape.
 * Upper limits and saturated points are left out of it; a bin needs two
 * detections to have a median at all. Sorted by wavelength.
 */
export const BIN_ELEMENTS = 4;

export function medianLine(points) {
  const bins = new Map();
  for (const p of points) {
    const R = RESOLVING_POWER[p.band];
    if (p.kind !== 'detection' || !(p.um > 0) || p.measured === false || !R) continue;
    const key = `${p.band}:${Math.floor(Math.log(p.um) / (BIN_ELEMENTS / R))}`;
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(p);
  }
  return [...bins.values()]
    .filter((members) => members.length >= 2)
    .map((members) => ({
      band: members[0].band,
      um: medianOf(members.map((p) => p.um)),
      mJy: medianOf(members.map((p) => p.mJy)),
      n: members.length,
    }))
    .sort((a, b) => a.um - b.um);
}

/**
 * The bands where a source is saturated in most of its exposures. Whether
 * one exposure saturates depends on where the undersampled image falls on
 * the pixels as much as on the source, so the exposures in such a band that
 * did not saturate saw a star at the edge of it — and one that lost part of
 * its core to the pipeline's blanking. Their fluxes are not to be trusted.
 */
export function nearSaturation(points) {
  const bands = new Set();
  for (const band of BANDS) {
    const mine = points.filter((p) => p.band === band);
    const saturated = mine.filter((p) => p.kind === 'saturated').length;
    if (mine.length && saturated * 2 > mine.length) bands.add(band);
  }
  return bands;
}

/**
 * The detections centred somewhere else. The search box is two detector
 * pixels wide, so where two sources lie close together, one exposure can
 * lock onto one of them and the next onto its neighbour — and a steady pair
 * reads as a source that changes. Each detection's offset from where it was
 * looked for (`at`) is compared with the median offset of all of them; one
 * more than a pixel from that is a different source. Points carry
 * `{ key, kind, ra, dec, at: { ra, dec } }`; returns the keys of the strays.
 */
export function strayDetections(points, { pixelArcsec = 6.15 } = {}) {
  const found = points.filter((p) => p.kind === 'detection' && Number.isFinite(p.ra) && p.at);
  if (found.length < 3) return new Set();
  const offsets = found.map((p) => {
    const cosd = Math.cos((p.at.dec * Math.PI) / 180);
    return { key: p.key, x: deltaRA(p.ra, p.at.ra) * cosd * 3600, y: (p.dec - p.at.dec) * 3600 };
  });
  const mx = medianOf(offsets.map((o) => o.x));
  const my = medianOf(offsets.map((o) => o.y));
  return new Set(offsets.filter((o) => Math.hypot(o.x - mx, o.y - my) > pixelArcsec).map((o) => o.key));
}

/* ------------------------------------------------------------ variability */

/** AB magnitude of a flux density in mJy, and the magnitude error of its 1σ. */
export const magOfMJy = (mJy) => -2.5 * Math.log10(mJy / 3631e3);
export const magErrOf = (mJy, err) => (2.5 / Math.LN10) * (err / mJy);

/** How far apart, in sigma, two magnitudes must be to call it a change. */
export const VARIES_SIGMA = 3;
/** The least error a SPHEREx 3 × 3 aperture brightness carries, whatever the noise. */
export const PHOTOMETRY_FLOOR_MAG = 0.03;
/** Fewer detections than this make no light curve worth a verdict. */
const MIN_CURVE_POINTS = 2;

/**
 * What the visits at one wavelength say about a change in brightness.
 *
 * Saturated in more than half of them: nothing, and it says so. Otherwise
 * the brightest and the faintest detection give the peak-to-peak change and
 * its error (the two 1σ errors in quadrature). A non-detection deeper than
 * every detection, and well clear of the brightest, widens that: the source
 * was fainter than its 5σ limit, so the change is at least the distance to
 * that limit. A change of more
 * than three sigma is a change; anything less is "steady within" half of
 * whichever is larger, the change or three sigma — the most these visits
 * could have missed.
 */
export function variability(points) {
  const saturated = points.filter((p) => p.kind === 'saturated').length;
  const detections = points.filter((p) => p.kind === 'detection' && p.mJy > 0 && p.err > 0);
  const limits = points.filter((p) => p.kind === 'limit' && p.mJy > 0);
  const base = { n: points.length, saturated, detections: detections.length, limits: limits.length };
  if (saturated * 2 > points.length) return { ...base, state: 'saturated' };
  if (detections.length < MIN_CURVE_POINTS) return { ...base, state: 'few' };

  // The bars are the sky's noise alone; a bright star's own error is set by
  // where its light falls on the pixels and by the aperture, a few hundredths
  // of a magnitude. Without that floor a steady 12th-magnitude star "varied"
  // by 0.01 ± 0.00.
  const mags = detections.map((p) => ({ p, m: magOfMJy(p.mJy), e: Math.hypot(magErrOf(p.mJy, p.err), PHOTOMETRY_FLOOR_MAG) }));
  const bright = mags.reduce((a, b) => (b.m < a.m ? b : a));
  const faint = mags.reduce((a, b) => (b.m > a.m ? b : a));
  const amp = faint.m - bright.m;
  const ampErr = Math.hypot(bright.e, faint.e);

  // A limit only counts where the brightest detection clears it by three
  // sigma of the two together: a source a little above 5σ is missed now and
  // then by the noise alone, and that is not a change.
  const clear = limits.filter((l) => l.mJy < faint.p.mJy
    && bright.p.mJy - l.mJy > VARIES_SIGMA * Math.hypot(bright.p.err, l.err ?? l.mJy / LIMIT_SIGMA));
  const deepest = clear.reduce((a, b) => (!a || b.mJy < a.mJy ? b : a), null);
  if (deepest) {
    const atLeast = magOfMJy(deepest.mJy) - bright.m;
    return {
      ...base, state: 'varies', amp: atLeast, ampErr: bright.e, lowerBound: true, bright: bright.p, faint: deepest,
    };
  }
  if (amp > VARIES_SIGMA * ampErr) return { ...base, state: 'varies', amp, ampErr, lowerBound: false, bright: bright.p, faint: faint.p };
  return {
    ...base, state: 'steady', amp, ampErr, within: Math.max(amp, VARIES_SIGMA * ampErr) / 2, bright: bright.p, faint: faint.p,
  };
}

/* ----------------------------------------------------------- wavelength */

const COLUMN_BYTES = { J: 4, E: 4 };

/** "(2,11,11)" → [2, 11, 11] */
const parseDims = (tdim) => String(tdim ?? '').replace(/[()\s]/g, '').split(',').map(Number);

/**
 * Decode a WCS-WAVE extension. `buf` starts at the extension's header.
 *
 * One row, three columns: the detector X and Y at which the table is sampled
 * (1-based pixels) and VALUES, a (2, nx, ny) array holding the central
 * wavelength and the bandwidth, in micrometres, at each sample. The grid is
 * not the same size in every band, so nothing about it is assumed.
 * Returns null for anything that is not that table.
 */
export function parseWaveTable(buf) {
  const head = readHeader(buf, 0);
  if (!head) return null;
  const { cards } = head;
  if (String(cards.get('EXTNAME') ?? '').trim() !== 'WCS-WAVE') return null;

  const columns = new Map();
  let offset = head.headerEnd;
  for (let n = 1; n <= (cards.get('TFIELDS') ?? 0); n++) {
    const form = /^(\d*)([A-Z])$/.exec(String(cards.get(`TFORM${n}`) ?? '').trim());
    const width = form && COLUMN_BYTES[form[2]];
    if (!width) return null;
    const count = Number(form[1] || 1);
    columns.set(String(cards.get(`TTYPE${n}`) ?? '').trim(), { offset, count, type: form[2], dims: parseDims(cards.get(`TDIM${n}`)) });
    offset += count * width;
  }
  const cx = columns.get('X');
  const cy = columns.get('Y');
  const cv = columns.get('VALUES');
  if (!cx || !cy || !cv || cx.type !== 'J' || cy.type !== 'J' || cv.type !== 'E') return null;
  const [planes, nx, ny] = cv.dims;
  if (planes !== 2 || nx !== cx.count || ny !== cy.count || cv.count !== 2 * nx * ny) return null;
  if (offset > buf.byteLength) return null;

  const view = new DataView(buf);
  const ints = (c) => Array.from({ length: c.count }, (_, i) => view.getInt32(c.offset + i * 4, false));
  const values = new Float32Array(cv.count);
  for (let i = 0; i < cv.count; i++) values[i] = view.getFloat32(cv.offset + i * 4, false);
  return { x: ints(cx), y: ints(cy), nx, ny, values };
}

/** The cell of a rising axis that holds `v`, and how far across it `v` lies. */
function bracket(axis, v) {
  let i = 0;
  while (i < axis.length - 2 && v >= axis[i + 1]) i++;
  const span = axis[i + 1] - axis[i];
  const frac = span > 0 ? (v - axis[i]) / span : 0;
  return [i, Math.min(1, Math.max(0, frac))];
}

/**
 * Central wavelength and bandwidth, in micrometres, at a detector pixel
 * (1-based, as the FITS WCS gives it). Bilinear between the table's samples,
 * which is how a `-TAB` lookup is defined.
 */
export function wavelengthAt(table, px, py) {
  if (!table || !Number.isFinite(px) || !Number.isFinite(py)) return null;
  const { x, y, nx, values } = table;
  if (px < x[0] - 0.5 || px > x[x.length - 1] + 0.5 || py < y[0] - 0.5 || py > y[y.length - 1] + 0.5) return null;
  const [i, tx] = bracket(x, px);
  const [j, ty] = bracket(y, py);
  const at = (plane) => {
    const v = (ii, jj) => values[plane + 2 * (ii + nx * jj)];
    return v(i, j) * (1 - tx) * (1 - ty) + v(i + 1, j) * tx * (1 - ty)
      + v(i, j + 1) * (1 - tx) * ty + v(i + 1, j + 1) * tx * ty;
  };
  const um = at(0);
  const width = at(1);
  if (!(um > 0)) return null;
  return { um, width: width > 0 ? width : null };
}

/**
 * Where a point goes along the wavelength axis, and how sure that is.
 *
 * A wavelength read from the file is plotted where it is, with the bandpass
 * width as its bar. Without one, the honest statement is the band itself: the
 * point sits at the band's centre and its bar covers the whole range, because
 * the source was seen somewhere in there and nothing says where.
 */
export function placeInBand(frame, wave) {
  const inBand = wave && wave.um >= frame.emMin - 0.05 && wave.um <= frame.emMax + 0.05;
  if (inBand) {
    const half = (wave.width ?? 0) / 2;
    return { um: wave.um, width: wave.width ?? null, from: wave.um - half, to: wave.um + half, measured: true };
  }
  return { um: (frame.emMin + frame.emMax) / 2, width: null, from: frame.emMin, to: frame.emMax, measured: false };
}

/* ------------------------------------------------------------------ flux */

/**
 * A sum over detector pixels, in MJy/sr · pixel, as a flux density in mJy:
 * through the pixel's solid angle, the same step `magAB` takes on its way to
 * a magnitude.
 */
export const apertureMJy = (sumMJySrPixels) => sumMJySrPixels * 1e6 * PIXEL_SR * 1e3;

/**
 * What one exposure says about the source, from what `measure` returned.
 *
 * The error is the per-pixel noise `measure` detected against, over the nine
 * pixels of the aperture. A position with nothing above the noise is a 5σ
 * upper limit — the same arithmetic as the depth limit — and so is a "peak"
 * whose aperture sums to nothing. A null means the exposure has no usable
 * pixels there at all, which is not a statement about the source.
 */
export function fluxPoint(measurement) {
  if (!measurement || !(measurement.noise > 0)) return null;
  // Noise adds over the pixels actually summed, which is what the measurement
  // reports; the nominal aperture stands in only where it does not.
  const err = apertureMJy(measurement.noise * Math.sqrt(measurement.aperturePx ?? APERTURE_PX));
  if (measurement.limit) return { kind: 'limit', mJy: LIMIT_SIGMA * err, err };
  if (measurement.flux == null) return null;
  if (!(measurement.flux > 0)) return { kind: 'limit', mJy: LIMIT_SIGMA * err, err };
  return { kind: 'detection', mJy: apertureMJy(measurement.flux), err };
}

/**
 * The same, for a visit that may be saturated. A core past the detector's
 * well, or an aperture touching one, holds no brightness: it is kept as a
 * saturated point — the visit happened and saw the source — with no flux.
 */
export function visitPoint(measurement) {
  if (measurement?.saturated) return { kind: 'saturated' };
  return fluxPoint(measurement);
}

/* ----------------------------------------------------------------- dates */

/** The first and last exposure among the points, and the days between them. */
export function dateSpan(points) {
  const mjds = points.map((p) => p.mjd).filter(Number.isFinite);
  if (!mjds.length) return null;
  const from = Math.min(...mjds);
  const to = Math.max(...mjds);
  return { from, to, days: to - from };
}

/* ----------------------------------------------------------------- chart */

/**
 * The flux axis: logarithmic, because a spectrum that mixes detections with
 * upper limits routinely spans a factor of a hundred, and on a linear axis the
 * faint half of it is a row of points on the floor.
 * Returns the range and the round values worth labelling inside it.
 */
export function fluxAxis(points) {
  const values = [];
  for (const p of points) {
    values.push(p.mJy);
    if (p.kind === 'detection') {
      values.push(p.mJy + p.err);
      // An error bar that reaches zero has no place on a log axis; it is cut
      // at a tenth of the value and drawn to the floor.
      values.push(Math.max(p.mJy - p.err, p.mJy / 10));
    }
  }
  const good = values.filter((v) => v > 0 && Number.isFinite(v));
  if (!good.length) return null;
  // An upper limit is drawn as an arrow pointing down from its value, and the
  // arrow needs room above the axis.
  const floor = Math.min(...good);
  const limitAtFloor = points.some((p) => p.kind === 'limit' && p.mJy <= floor);
  let lo = floor / (limitAtFloor ? 2.5 : 1.5);
  let hi = Math.max(...good) * 1.5;
  // Never less than half a decade: a flat spectrum should look flat.
  const short = 0.5 - Math.log10(hi / lo);
  if (short > 0) { lo /= 10 ** (short / 2); hi *= 10 ** (short / 2); }

  const candidates = (steps) => {
    const out = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
      for (const s of steps) {
        const v = s * 10 ** e;
        if (v >= lo && v <= hi) out.push(Number(v.toPrecision(1)));
      }
    }
    return out;
  };
  let ticks = candidates([1, 2, 5]);
  if (ticks.length > 4) ticks = candidates([1]);
  if (ticks.length > 4) ticks = ticks.filter((_, i) => i % 2 === 0);
  return { lo, hi, ticks };
}

/** Decimal places that show a value to about three significant figures. */
export const fluxDigits = (v) => (v > 0 ? Math.min(4, Math.max(0, 2 - Math.floor(Math.log10(v)))) : 2);

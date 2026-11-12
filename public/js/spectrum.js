/**
 * spectrum.js — one marked source across SPHEREx's six bands.
 *
 * SPHEREx has no filter wheel. Each detector sits behind a linear variable
 * filter, so the wavelength a source is seen at depends on which detector row
 * it lands on: "D2" is a range, 1.10–1.65 µm, and a single exposure samples one
 * narrow slice of it. A Level-2 file says which slice: its last extension,
 * WCS-WAVE, is a small lookup table of central wavelength and bandwidth over
 * the detector (the `-TAB` form of FITS WCS, alternate axis "W").
 *
 * Everything here is arithmetic on values already in hand — which exposures to
 * read, what the table says at a pixel, what an aperture sum is in millijansky.
 * The reading itself lives in stamp.js and app.js.
 */

import { readHeader } from './fits.js';
import { PIXEL_SR, APERTURE_PX } from './depth.js';

export const BANDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];

/** The instrument's range, in micrometres: the chart's wavelength axis. */
export const WAVE_RANGE = [0.75, 5.0];

/** A non-detection is drawn at this many sigma, the threshold `measure` detects at. */
export const LIMIT_SIGMA = 5;

/* ------------------------------------------------------- which exposures */

/**
 * For every band, its exposures ordered by how far in time they are from the
 * visit on the plate, nearest first.
 *
 * The nearest is the one to read. The ones after it are there for a position
 * the nearest exposure turns out not to cover — the six detectors do not see
 * the same patch of sky at once, so a band's nearest frame can miss a source
 * near the edge of the field.
 */
export function nearestExposures(frames, mjd, { perBand = 3 } = {}) {
  return BANDS.map((band) => ({
    band,
    frames: frames
      .filter((f) => f.band === band && Number.isFinite(f.mjd))
      .sort((a, b) => Math.abs(a.mjd - mjd) - Math.abs(b.mjd - mjd))
      .slice(0, perBand),
  }));
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
    return { um: wave.um, from: wave.um - half, to: wave.um + half, measured: true };
  }
  return { um: (frame.emMin + frame.emMax) / 2, from: frame.emMin, to: frame.emMax, measured: false };
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

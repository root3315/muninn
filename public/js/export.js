/**
 * A mark's measurements as a table someone else can open.
 *
 * What the page says about a marked point is a verdict; what a person needs to
 * check it, or to take it further, is the numbers behind it: one row a visit,
 * in plain units, with the exposure each came from.
 */
import { visitPoint, LIMIT_SIGMA } from './spectrum.js';

const MJD_UNIX_EPOCH = 40587;
const DAY_MS = 86_400_000;

const num = (v, digits) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(digits));

/*
 * One row an exposure. The wavelength is the one the file gives at the
 * source's detector pixel, filled in for every exposure the spectrum read.
 * A detection has a flux and its 1σ; a non-detection has its 5σ limit; a
 * saturated exposure has neither. No aperture correction is applied.
 */
const COLUMNS = [
  ['date_utc', (r) => new Date((r.mjd - MJD_UNIX_EPOCH) * DAY_MS).toISOString().slice(0, 19)],
  ['mjd', (r) => r.mjd.toFixed(6)],
  ['obs_id', (r) => r.obsId],
  ['band', (r) => r.band ?? ''],
  ['wavelength_um', (r) => (r.place?.measured ? num(r.place.um, 4) : '')],
  ['bandwidth_um', (r) => (r.place?.measured ? num(r.place.width, 4) : '')],
  ['ra_deg', (r) => num(r.ra, 6)],
  ['dec_deg', (r) => num(r.dec, 6)],
  ['result', (r) => r.point?.kind ?? ''],
  ['flux_mjy', (r) => (r.point?.kind === 'detection' ? num(r.point.mJy, 4) : '')],
  ['flux_err_mjy', (r) => (r.point?.kind === 'detection' ? num(r.point.err, 4) : '')],
  [`limit_${LIMIT_SIGMA}sigma_mjy`, (r) => (r.point?.kind === 'limit' ? num(r.point.mJy, 4) : '')],
  ['mag_ab', (r) => num(r.mag, 3)],
  ['peak_snr', (r) => num(r.snr, 2)],
];

const keyOf = (obsId, band) => `${obsId}|${band ?? ''}`;

/**
 * Every exposure a mark was measured in: the visits on the plate (its track)
 * and those its spectrum read (`{ frame, place, point, measurement, at }`),
 * one row each, in time order. A visit in both is one row with both.
 */
export function markRows(track, exposures = []) {
  const rows = new Map();
  for (const p of track) {
    rows.set(keyOf(p.obsId, p.band), {
      mjd: p.mjd, obsId: p.obsId, band: p.band, ra: p.ra, dec: p.dec, mag: p.mag, snr: p.snr, point: visitPoint(p),
    });
  }
  for (const e of exposures) {
    const key = keyOf(e.frame.obsId, e.frame.band);
    const m = e.measurement;
    const row = rows.get(key) ?? {
      mjd: e.frame.mjd, obsId: e.frame.obsId, band: e.frame.band,
      ra: m?.ra ?? e.at?.ra, dec: m?.dec ?? e.at?.dec, mag: m?.mag ?? null, snr: m?.snr ?? null, point: e.point,
    };
    row.place = e.place;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.mjd - b.mjd || String(a.band).localeCompare(String(b.band)));
}

/** Quote a cell only when it has to be, the way RFC 4180 asks. */
const cell = (value) => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** A mark's exposures as CSV text, header first, CRLF between rows. */
export function trackCSV(track, exposures = []) {
  const rows = [COLUMNS.map(([name]) => name)];
  for (const r of markRows(track, exposures)) rows.push(COLUMNS.map(([, read]) => read(r)));
  return `${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

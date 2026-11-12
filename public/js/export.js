/**
 * A mark's measurements as a table someone else can open.
 *
 * What the page says about a marked point is a verdict; what a person needs to
 * check it, or to take it further, is the numbers behind it: one row a visit,
 * in plain units, with the exposure each came from.
 */
import { apertureMJy } from './spectrum.js';

const MJD_UNIX_EPOCH = 40587;
const DAY_MS = 86_400_000;

const COLUMNS = [
  ['date_utc', (p) => new Date((p.mjd - MJD_UNIX_EPOCH) * DAY_MS).toISOString().slice(0, 19)],
  ['mjd', (p) => p.mjd.toFixed(6)],
  ['obs_id', (p) => p.obsId],
  ['band', (p) => p.band ?? ''],
  ['ra_deg', (p) => p.ra.toFixed(6)],
  ['dec_deg', (p) => p.dec.toFixed(6)],
  // No aperture correction is applied; a visit whose aperture is holed has none.
  ['flux_mjy', (p) => (p.flux == null ? '' : apertureMJy(p.flux).toFixed(4))],
  ['mag_ab', (p) => (p.mag == null || !Number.isFinite(p.mag) ? '' : p.mag.toFixed(3))],
  ['peak_snr', (p) => p.snr.toFixed(2)],
];

/** Quote a cell only when it has to be, the way RFC 4180 asks. */
const cell = (value) => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The per-visit track of one mark as CSV text, header first, CRLF between rows. */
export function trackCSV(track) {
  const rows = [COLUMNS.map(([name]) => name)];
  for (const point of track) rows.push(COLUMNS.map(([, read]) => read(point)));
  return `${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

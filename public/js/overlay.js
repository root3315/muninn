/**
 * overlay.js — other missions' catalogues, laid over the SPHEREx plate.
 *
 * The arithmetic and the query text only; nothing here touches the network or
 * the page, so all of it is tested in Node.
 *
 *   · Gaia DR3 (ESA) gives every position at epoch J2016.0, with a proper
 *     motion. A plate is a photograph of one date, so each position is carried
 *     along its proper motion to that date. For most stars that is a fraction
 *     of a pixel; for Barnard's Star it is 10.4″ a year, well over a pixel,
 *     and the circle drawn at the 2016 position would sit on empty sky.
 *   · AllWISE (NASA WISE) positions belong to about 2010.5 and its proper
 *     motions are not reliable, so its marks are drawn where the catalogue has
 *     them and the page says so.
 */

export const GAIA_EPOCH = 2016.0;
export const WISE_EPOCH = 2010.5;

/** The most rows asked of a catalogue for one field. */
export const ROW_CAP = 300;

/** Room for a fast star to have come into the field since the catalogue's epoch, degrees. */
const DRIFT_MARGIN_DEG = 2 / 60;

const MAS_PER_DEG = 3_600_000;
const D2R = Math.PI / 180;

/** A Modified Julian Date as a Julian year, the unit proper motions are per. */
export const epochOfMjd = (mjd) => 2000 + (mjd - 51544.5) / 365.25;

/**
 * Where a catalogued source stands at `epoch`.
 *
 * `pmRA` is μα·cos δ in mas/yr, as Gaia and VizieR give it, so it is divided
 * by cos δ to become a change in right ascension. A source with no measured
 * proper motion stays where the catalogue has it, and says so in `moved`.
 */
export function propagate({ ra, dec, pmRA, pmDE }, epoch, from = GAIA_EPOCH) {
  const years = epoch - from;
  if (!Number.isFinite(pmRA) || !Number.isFinite(pmDE) || !Number.isFinite(years)) {
    return { ra, dec, moved: false };
  }
  const dDec = (pmDE * years) / MAS_PER_DEG;
  // The cosine half-way along the path: the star's declination changes as it goes.
  const cosd = Math.max(1e-6, Math.cos((dec + dDec / 2) * D2R));
  const dRA = (pmRA * years) / MAS_PER_DEG / cosd;
  return { ra: (((ra + dRA) % 360) + 360) % 360, dec: dec + dDec, moved: true };
}

/**
 * The faintest Gaia G magnitude worth marking in a field `fovDeg` high.
 *
 * Star counts grow about 2.5 times per magnitude, so a field of four times
 * the area keeps the same number of marks at a limit 1.5 mag brighter: five
 * times the logarithm of the side. Set so that a 9′ field away from the
 * Milky Way shows on the order of a hundred marks; ROW_CAP catches the fields
 * inside it.
 */
export function magLimit(fovDeg) {
  const limit = 18.5 - 5 * Math.log10(fovDeg / 0.15);
  return Math.min(20, Math.max(13, Math.round(limit * 2) / 2));
}

/**
 * The same cut in WISE W1 (Vega): an ordinary star is about 2.5 mag brighter
 * at 3.4 µm than in Gaia's G.
 */
export const wiseLimit = (fovDeg) => magLimit(fovDeg) - 2.5;

/** A circle that covers a plate `widthDeg` by `heightDeg`, with room for drift. */
export const searchRadius = (widthDeg, heightDeg) => Math.hypot(widthDeg, heightDeg) / 2 + DRIFT_MARGIN_DEG;

/** A number written into a query, or a refusal: nothing else is ever put there. */
function fixed(value, digits) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('A query parameter must be a finite number');
  return value.toFixed(digits);
}

const circle = (ra, dec, radiusDeg) => `CIRCLE('ICRS', ${fixed(ra, 6)}, ${fixed(dec, 6)}, ${fixed(radiusDeg, 5)})`;
const top = (cap) => fixed(Math.trunc(cap) + 1, 0);

/*
 * Both queries ask for one row more than the cap, brightest first: the extra
 * row is how a cut list is told from a complete one, and brightest first means
 * a cut list loses its faint end and nothing else.
 */

/** ADQL for the Gaia DR3 sources in a circle, through VizieR (I/355). */
export function gaiaQuery({ ra, dec, radiusDeg, limit, cap = ROW_CAP }) {
  return `SELECT TOP ${top(cap)} Source, RA_ICRS, DE_ICRS, Gmag, pmRA, pmDE, Plx, e_Plx
    FROM "I/355/gaiadr3"
    WHERE CONTAINS(POINT('ICRS', RA_ICRS, DE_ICRS), ${circle(ra, dec, radiusDeg)}) = 1 AND Gmag <= ${fixed(limit, 2)}
    ORDER BY Gmag`;
}

/** ADQL for the AllWISE sources in a circle, through VizieR (II/328). */
export function wiseQuery({ ra, dec, radiusDeg, limit, cap = ROW_CAP }) {
  return `SELECT TOP ${top(cap)} AllWISE, RAJ2000, DEJ2000, W1mag, W2mag
    FROM "II/328/allwise"
    WHERE CONTAINS(POINT('ICRS', RAJ2000, DEJ2000), ${circle(ra, dec, radiusDeg)}) = 1 AND W1mag <= ${fixed(limit, 2)}
    ORDER BY W1mag`;
}

/** `''` and anything that is not a number → null. */
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

const placed = (row) => (Number.isFinite(row.ra) && Number.isFinite(row.dec) && row.mag != null ? row : null);

/**
 * One row of the Gaia answer. The source id is a 64-bit integer and is kept
 * as the text it arrived in; a JavaScript number would round it.
 */
export function parseGaiaRow(r) {
  return placed({
    id: String(r.Source ?? '').trim(),
    ra: num(r.RA_ICRS) ?? NaN, dec: num(r.DE_ICRS) ?? NaN, mag: num(r.Gmag),
    pmRA: num(r.pmRA), pmDE: num(r.pmDE), plx: num(r.Plx), plxErr: num(r.e_Plx),
  });
}

/** One row of the AllWISE answer. `mag` is W1, the magnitude the list is cut on. */
export function parseWiseRow(r) {
  return placed({
    id: String(r.AllWISE ?? '').trim(),
    ra: num(r.RAJ2000) ?? NaN, dec: num(r.DEJ2000) ?? NaN, mag: num(r.W1mag), w2: num(r.W2mag),
  });
}

/**
 * The rows to draw, and how far down they really go.
 *
 * A list that came back longer than the cap was cut by it. The rows are
 * brightest first, so the list is then complete only to its own faintest
 * magnitude, not to the limit that was asked for.
 */
export function cutToCap(rows, limit, cap = ROW_CAP) {
  if (rows.length <= cap) return { rows, cut: false, reached: limit };
  const kept = rows.slice(0, cap);
  return { rows: kept, cut: true, reached: kept[kept.length - 1].mag };
}

/** Radius of a mark in CSS pixels: a brighter source gets a larger one. */
export function markRadius(mag, limit) {
  return Math.min(7, Math.max(2.5, 2.5 + 0.75 * (limit - mag)));
}

/** Total proper motion in arcsec a year, or null when the catalogue has none. */
export const properMotion = ({ pmRA, pmDE }) =>
  (Number.isFinite(pmRA) && Number.isFinite(pmDE) ? Math.hypot(pmRA, pmDE) / 1000 : null);

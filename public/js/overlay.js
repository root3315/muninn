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
 *   · CatWISE2020 (NASA WISE and NEOWISE) measured motions over ten years of
 *     the same sky; it is the catalogue the coldest brown dwarfs were found
 *     in, by how fast they move. It says whether a marked source moves.
 *
 * Each catalogue is held by two archives, NASA's IRSA and CDS VizieR, under
 * different column names. Every catalogue is described once, here, with the
 * column each archive uses for each field; rows from either come out under the
 * same names and go through the same parser.
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

const same = (...names) => Object.fromEntries(names.map((n) => [n, n]));

/**
 * The catalogues, as each archive names their columns. The keys of `columns`
 * are the names a row is read under, the values the archive's own. VizieR's
 * names are the shared ones, so its rows need no renaming; IRSA's rows are
 * renamed by the relay (renameRow). `ra`, `dec` and `mag` are the archive
 * columns the cone and the magnitude cut are made on.
 *
 * CatWISE2020 is asked of IRSA only. It is a NASA catalogue, and its VizieR
 * copy (II/365) names everything differently again.
 */
export const CATALOGUES = {
  gaia: {
    irsa: {
      table: 'gaia_dr3_source', ra: 'ra', dec: 'dec', mag: 'phot_g_mean_mag',
      columns: {
        Source: 'source_id', RA_ICRS: 'ra', DE_ICRS: 'dec', Gmag: 'phot_g_mean_mag',
        pmRA: 'pmra', pmDE: 'pmdec', Plx: 'parallax', e_Plx: 'parallax_error',
        VarFlag: 'phot_variable_flag', PQSO: 'classprob_dsc_combmod_quasar',
        PGal: 'classprob_dsc_combmod_galaxy', PSS: 'classprob_dsc_combmod_star',
      },
    },
    vizier: {
      table: '"I/355/gaiadr3"', ra: 'RA_ICRS', dec: 'DE_ICRS', mag: 'Gmag',
      columns: same('Source', 'RA_ICRS', 'DE_ICRS', 'Gmag', 'pmRA', 'pmDE', 'Plx', 'e_Plx', 'VarFlag', 'PQSO', 'PGal', 'PSS'),
    },
  },
  wise: {
    irsa: {
      table: 'allwise_p3as_psd', ra: 'ra', dec: 'dec', mag: 'w1mpro',
      columns: { AllWISE: 'designation', RAJ2000: 'ra', DEJ2000: 'dec', W1mag: 'w1mpro', W2mag: 'w2mpro' },
    },
    vizier: {
      table: '"II/328/allwise"', ra: 'RAJ2000', dec: 'DEJ2000', mag: 'W1mag',
      columns: same('AllWISE', 'RAJ2000', 'DEJ2000', 'W1mag', 'W2mag'),
    },
  },
  twomass: {
    irsa: {
      table: 'fp_psc', ra: 'ra', dec: 'dec', mag: 'j_m',
      columns: { '2MASS': 'designation', RAJ2000: 'ra', DEJ2000: 'dec', Jmag: 'j_m', Hmag: 'h_m', Kmag: 'k_m' },
    },
    vizier: {
      table: '"II/246/out"', ra: 'RAJ2000', dec: 'DEJ2000', mag: 'Jmag',
      columns: { '2MASS': '"2MASS"', ...same('RAJ2000', 'DEJ2000', 'Jmag', 'Hmag', 'Kmag') },
    },
  },
  catwise: {
    irsa: {
      table: 'catwise_2020', ra: 'ra', dec: 'dec', mag: 'w1mpro',
      columns: same('source_name', 'ra_pm', 'dec_pm', 'pmra', 'pmdec', 'sigpmra', 'sigpmdec', 'w1mpro', 'w2mpro'),
    },
  },
};

/**
 * ADQL for one catalogue's sources in a circle, as one archive holds it
 * (`CATALOGUES[kind].irsa` or `.vizier`), brightest first: at most `top` rows,
 * and, when `limit` is given, none fainter than it.
 *
 * Every value goes through `fixed` and every name comes from the table above:
 * nothing a caller sends ever becomes query text.
 */
export function coneQuery(archive, { ra, dec, radiusDeg, limit = null, top }) {
  const cut = limit === null ? '' : ` AND ${archive.mag} <= ${fixed(limit, 2)}`;
  return `SELECT TOP ${fixed(top, 0)} ${Object.values(archive.columns).join(', ')}
    FROM ${archive.table}
    WHERE CONTAINS(POINT('ICRS', ${archive.ra}, ${archive.dec}), ${circle(ra, dec, radiusDeg)}) = 1${cut}
    ORDER BY ${archive.mag}`;
}

/** An IRSA row under the shared names. A column the archive left out reads as ''. */
export function renameRow(row, columns) {
  return Object.fromEntries(Object.entries(columns).map(([name, col]) => [name, row[col] ?? '']));
}

/** MAST rows → the shared names, cut and ordered the way the ADQL would. */
export function mastGaiaRows(data, { limit = null, top }) {
  const { columns } = CATALOGUES.gaia.irsa;
  return data
    .map((row) => ({
      ...renameRow(row, columns),
      Source: String(row.designation ?? '').replace(/^Gaia DR3\s+/, '') || String(row.source_id ?? ''),
    }))
    .filter((row) => row.Gmag !== '' && row.Gmag != null && (limit === null || Number(row.Gmag) <= limit))
    .sort((a, b) => Number(a.Gmag) - Number(b.Gmag))
    .slice(0, top);
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

/** CatWISE2020's motion-fit positions are for MJD 57170.0, about 2015.4. */
export const CATWISE_EPOCH = epochOfMjd(57170);

/**
 * One row of the CatWISE2020 answer. Its motions come in arcsec a year and
 * become mas a year here, the unit Gaia's are in, so `propagate` takes either.
 */
export function parseCatwiseRow(r) {
  const mas = (v) => (num(v) == null ? null : num(v) * 1000);
  return placed({
    id: String(r.source_name ?? '').trim(),
    ra: num(r.ra_pm) ?? NaN, dec: num(r.dec_pm) ?? NaN, mag: num(r.w1mpro), w2: num(r.w2mpro),
    pmRA: mas(r.pmra), pmDE: mas(r.pmdec), pmRAErr: mas(r.sigpmra), pmDEErr: mas(r.sigpmdec),
  });
}

/**
 * A CatWISE motion worth saying, in arcsec a year, or null. Most faint
 * sources come back with a motion the size of its own error; only one five
 * times its error is a measurement rather than noise.
 */
export function measuredMotion(row) {
  const pm = properMotion(row);
  const err = Math.hypot(row.pmRAErr, row.pmDEErr) / 1000;
  if (pm == null || !(err > 0)) return null;
  return pm / err >= 5 ? pm : null;
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

/**
 * archives.js — which other telescopes have looked at the open field.
 *
 * The Canadian Astronomy Data Centre (one of the challenge's partner
 * resources) keeps a common observation index (CAOM) over many archives:
 * HST, JWST, TESS, Chandra, Gemini, CFHT, JCMT, SDSS, VLASS and the CSA's
 * NEOSSat among them. One question to its TAP service says how many science
 * observations each one has of a circle on the sky, and over which years.
 * The page's relay asks it (CADC sends no CORS headers); this side only
 * validates the question and reads the answer.
 */

import { deadline } from './net.js';

const ARCHIVES_DEADLINE_MS = 60_000;

/** Where a person goes to see those observations for themselves. */
export const CADC_SEARCH = 'https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/search/';

/** The circle a field's question is asked over, in degrees: clamped, so a
 * typo cannot turn into an all-sky query. */
export const ARCHIVE_RADIUS = { min: 0.005, max: 0.3 };

/** Finite numbers only: they are written into the ADQL. */
function fixed(value, digits) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('not a number');
  return n.toFixed(digits);
}

/** The one question asked of CADC, with nothing from the client but three numbers. */
export function archivesQuery({ ra, dec, radiusDeg }) {
  const r = Math.min(ARCHIVE_RADIUS.max, Math.max(ARCHIVE_RADIUS.min, Number(radiusDeg)));
  return `SELECT o.collection, COUNT(*) AS n, MIN(p.time_bounds_lower) AS first, MAX(p.time_bounds_lower) AS last
    FROM caom2.Observation AS o JOIN caom2.Plane AS p ON o.obsID = p.obsID
    WHERE o.intent = 'science' AND p.calibrationLevel >= 1
      AND INTERSECTS(CIRCLE('ICRS', ${fixed(ra, 6)}, ${fixed(dec, 6)}, ${fixed(r, 5)}), p.position_bounds) = 1
    GROUP BY o.collection`;
}

/** MJD → calendar year, or null for an archive that keeps no dates. */
const year = (mjd) => {
  const m = Number(mjd);
  return mjd === '' || mjd == null || !Number.isFinite(m) ? null : new Date((m - 40587) * 86400000).getUTCFullYear();
};

/**
 * CADC's rows → `{ name, n, from, to }`, most observations first. Derived
 * collections that re-serve another's pointings (HSTHLA beside HST,
 * CFHTMEGAPIPE beside CFHT) are left out: counted twice, one telescope would
 * read as two.
 */
export function readArchives(rows) {
  const DERIVED = new Set(['HSTHLA', 'CFHTMEGAPIPE', 'CFHTTERAPIX', 'SUBARUCADC']);
  return rows
    .map((row) => ({
      name: String(row.collection ?? '').trim(), n: Number(row.n), from: year(row.first), to: year(row.last),
    }))
    .filter((a) => a.name && !DERIVED.has(a.name) && Number.isFinite(a.n) && a.n > 0)
    .sort((a, b) => b.n - a.n);
}

/** The other archives that hold this field, through the relay. */
export async function fieldArchives({ ra, dec, radiusDeg }, { signal } = {}) {
  const q = `api/archives?ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&r=${radiusDeg.toFixed(5)}`;
  const res = await fetch(q, { signal: deadline(signal, ARCHIVES_DEADLINE_MS) });
  if (!(res.headers.get('content-type') ?? '').includes('json')) throw new Error(`relay: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? 'CADC did not answer');
  return readArchives(body.rows);
}

/**
 * archives.js — which other telescopes have looked at the open field.
 *
 * The Canadian Astronomy Data Centre (one of the challenge's partner
 * resources) keeps a common observation index (CAOM) over many archives:
 * HST, JWST, TESS, Chandra, Gemini, CFHT, JCMT, SDSS, VLASS and the CSA's
 * NEOSSat among them. One question to its TAP service says how many science
 * observations (not planes: one observation can have several) each one has of a circle on the sky, and over which years.
 * The page's relay asks it (CADC sends no CORS headers); this side only
 * validates the question and reads the answer.
 */

import { deadline } from './net.js';

const ARCHIVES_DEADLINE_MS = 60_000;

/** Where a person goes to see those observations for themselves. */
export const CADC_SEARCH = 'https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/search/';

/**
 * CADC's search, opened on the field and run: the same circle the count was
 * asked over and, given one, a single collection. Without the position the
 * page opened on an empty form, which read as an archive that did not open.
 */
export function cadcSearchUrl({ ra, dec, radiusDeg }, collection = null) {
  const r = Math.min(ARCHIVE_RADIUS.max, Math.max(ARCHIVE_RADIUS.min, Number(radiusDeg)));
  const q = new URLSearchParams();
  if (collection) q.set('Observation.collection', collection);
  q.set('Plane.position.bounds@Shape1Resolver.value', 'ALL');
  q.set('Plane.position.bounds', `${fixed(ra, 5)} ${fixed(dec, 5)} ${fixed(r, 4)}`);
  // CADC's form reads its fields' names as written: "@" escaped, it never runs the search.
  return `${CADC_SEARCH}?${q.toString().replace(/\+/g, '%20').replace(/%40/g, '@')}#resultTableTab`;
}

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
  return `SELECT o.collection, COUNT(DISTINCT o.obsID) AS n, MIN(p.time_bounds_lower) AS first, MAX(p.time_bounds_lower) AS last
    FROM caom2.Observation AS o JOIN caom2.Plane AS p ON o.obsID = p.obsID
    WHERE o.intent = 'science' AND p.calibrationLevel >= 1
      AND INTERSECTS(CIRCLE('ICRS', ${fixed(ra, 6)}, ${fixed(dec, 6)}, ${fixed(r, 5)}), p.position_bounds) = 1
    GROUP BY o.collection`;
}

/** Where CADC serves a file by its URI. */
export const CADC_FILES = 'https://ws-uv.canfar.net/minoc/files/';

/**
 * The CSA's NEOSSat, a small asteroid-hunting telescope, is in CADC's index
 * at calibration level 1: frames as delivered, with no sky coordinates. They
 * cannot be laid on the field's grid, so the newest one is shown as it is.
 */
export function neossatQuery({ ra, dec, radiusDeg, last }) {
  const r = Math.min(ARCHIVE_RADIUS.max, Math.max(ARCHIVE_RADIUS.min, Number(radiusDeg)));
  // The newest time comes from the count's own answer: asking CADC to sort
  // for it took longer than the relay will wait.
  return `SELECT TOP 1 o.observationID, o.target_name, p.time_bounds_lower, p.time_exposure, p.planeID
    FROM caom2.Observation AS o JOIN caom2.Plane AS p ON o.obsID = p.obsID
    WHERE o.collection = 'NEOSSAT' AND o.intent = 'science'
      AND p.time_bounds_lower >= ${fixed(Number(last) - 1e-6, 7)}
      AND INTERSECTS(CIRCLE('ICRS', ${fixed(ra, 6)}, ${fixed(dec, 6)}, ${fixed(r, 5)}), p.position_bounds) = 1`;
}

/** The files of that one observation's plane: asked apart, since a sorted join over files does not finish. */
export function neossatFilesQuery(planeID) {
  // A UUID, and nothing else: it is written into the ADQL.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(planeID))) throw new Error('not a plane id');
  return `SELECT uri FROM caom2.Artifact WHERE planeID = '${planeID}'`;
}

/** The newest NEOSSat observation, and its files: its preview and its FITS. */
export function readNeossat(obs, files) {
  if (!obs) return null;
  const uris = files.map((r) => String(r.uri ?? ''));
  const file = (re) => uris.find((u) => re.test(u));
  const preview = file(/_prev_256\.png$/) ?? file(/_prev\.png$/);
  const fits = file(/\.fits$/);
  const mjd = Number(obs.time_bounds_lower);
  const safe = (u) => Boolean(u) && /^cadc:NEOSSAT\/[\w.-]+$/.test(u);
  if (!safe(preview)) return null;
  return {
    id: String(obs.observationID),
    target: String(obs.target_name ?? '').trim() || null,
    iso: Number.isFinite(mjd) ? new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10) : null,
    exposure: Number(obs.time_exposure) || null,
    preview: CADC_FILES + preview,
    fits: safe(fits) ? CADC_FILES + fits : null,
  };
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
  return { list: readArchives(body.rows), neossat: body.neossat ?? null };
}

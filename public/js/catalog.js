/**
 * catalog.js — everything that answers "what is at this position".
 *
 * NASA's own services first; each of the others is there for something NASA
 * does not offer, or as a second answer so that one archive being down does
 * not leave a question unanswered.
 *
 *   · IRSA SIA2    — which SPHEREx frames cover the field. Through the relay
 *                    (server.js), because IRSA sends no CORS headers.
 *   · IRSA TAP     — Gaia DR3, AllWISE, CatWISE2020 and 2MASS: what a marked
 *                    source is, and the catalogue overlay on the plate. Also
 *                    through the relay. Raced against VizieR, which holds the
 *                    same Gaia, AllWISE and 2MASS; the first answer is used.
 *   · VizieR (CDS) — the second home of those three catalogues, and the only
 *                    one of VSX, the variable-star index. Called straight from
 *                    the browser.
 *   · SIMBAD (CDS) — turns "M51" into a position (Sesame), names what sits at
 *                    a marked spot, and the famous things worth labelling.
 *                    Straight from the browser; NASA has no equivalent.
 *   · SkyBoT       — which solar-system objects stood in the field at the
 *                    moment of an exposure. IMCCE, straight from the browser.
 *   · JPL sb_ident — the same question asked of NASA/JPL, through the relay;
 *                    merged with SkyBoT, and the whole answer when IMCCE is down.
 *
 * Every catalogue answer stands on its own: one service failing never holds
 * up or empties the others, and the page says which did not answer.
 */

import { deadline, CATALOG_DEADLINE_MS, RELAY_DEADLINE_MS, SEARCH_DEADLINE_MS } from './net.js';
import {
  CATALOGUES, ROW_CAP, coneQuery, parseGaiaRow, parseWiseRow, parseCatwiseRow, measuredMotion, cutToCap,
} from './overlay.js';
import { parseCsv } from './csv.js';
import { mergeBodies } from './sbident.js';
import { parseVOTable } from './votable.js';
import { deltaRA } from './wcs.js';

const S3_BASE = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';
const IBE_PREFIX = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/';

/** The public AWS Open Data mirror answers Range requests with CORS; IRSA does not. */
export const toS3 = (url) => (url.startsWith(IBE_PREFIX) ? S3_BASE + url.slice(IBE_PREFIX.length) : url);

/* ------------------------------------------------------------------ position */

const SEX = /^\s*([+-]?\d{1,3})[\s:hн]+(\d{1,2})[\s:mм]+(\d{1,2}(?:\.\d+)?)s?\s*[, ]\s*([+-]?\d{1,3})[\s:d°]+(\d{1,2})[\s:m'′]+(\d{1,2}(?:\.\d+)?)["″s]?\s*$/i;
const DEC = /^\s*([+-]?\d{1,3}(?:\.\d+)?)\s*[, ]\s*([+-]?\d{1,2}(?:\.\d+)?)\s*$/;

/** Accepts `148.145 +1.003`, `10 00 34.7 +01 00 11`, `10:00:34.7, +01:00:11`. */
export function parseCoordinates(text) {
  const sex = SEX.exec(text);
  if (sex) {
    const [, hh, mm, ss, dd, dm, ds] = sex;
    const ra = (Math.abs(+hh) + +mm / 60 + +ss / 3600) * 15;
    const sign = dd.trim().startsWith('-') ? -1 : 1;
    const dec = sign * (Math.abs(+dd) + +dm / 60 + +ds / 3600);
    if (ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) return { ra, dec };
    return null;
  }
  const dec = DEC.exec(text);
  if (dec) {
    const ra = +dec[1];
    const de = +dec[2];
    if (ra >= 0 && ra < 360 && de >= -90 && de <= 90) return { ra, dec: de };
  }
  return null;
}

export function formatRA(deg) {
  const h = ((deg % 360) + 360) % 360 / 15;
  const hh = Math.floor(h);
  const m = (h - hh) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${String(hh).padStart(2, '0')}ʰ ${String(mm).padStart(2, '0')}ᵐ ${ss.toFixed(2).padStart(5, '0')}ˢ`;
}

export function formatDec(deg) {
  const sign = deg < 0 ? '−' : '+';
  const a = Math.abs(deg);
  const dd = Math.floor(a);
  const m = (a - dd) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${sign}${String(dd).padStart(2, '0')}° ${String(mm).padStart(2, '0')}′ ${ss.toFixed(1).padStart(4, '0')}″`;
}

/** SIMBAD name resolution through the CDS Sesame service. */
export async function resolveName(name, { signal } = {}) {
  const url = `https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?${encodeURIComponent(name)}`;
  const res = await fetch(url, { signal: deadline(signal, CATALOG_DEADLINE_MS) });
  if (!res.ok) throw new Error(`Sesame ${res.status}`);
  const body = await res.text();
  const m = /^%J\s+([\d.+-]+)\s+([\d.+-]+)/m.exec(body);
  if (!m) return null;
  // SIMBAD pads designations for column alignment ("M  51"); collapse that.
  const label = /^%I\.0\s+(.+)$/m.exec(body) ?? /^#\s*(\S.*?)\t/m.exec(body);
  const resolved = (label ? label[1] : name).trim().replace(/\s+/g, ' ');
  return { ra: +m[1], dec: +m[2], name: resolved };
}

/* -------------------------------------------------------------- SPHEREx index */

/** Thrown when there is no relay to reach IRSA through — a static host. */
/**
 * The relay is up, but IRSA — behind it — did not answer the question of
 * which frames cover the field. Worth telling apart from a missing relay:
 * one is fixed by starting the server, the other by waiting a minute.
 */
export class UpstreamError extends Error {
  constructor(message) { super(message); this.name = 'UpstreamError'; }
}

export class NoRelayError extends Error {
  constructor(cause) { super('No archive relay available'); this.name = 'NoRelayError'; this.cause = cause; }
}

let bakedIndex = null;

/** The fields whose frame lists ship with the page. Empty if the file is absent. */
async function loadBakedIndex(signal) {
  if (bakedIndex) return bakedIndex;
  try {
    const res = await fetch('data/fields/index.json', { signal: deadline(signal, CATALOG_DEADLINE_MS) });
    bakedIndex = res.ok ? await res.json() : [];
  } catch {
    // Not remembered: one dropped request must not send every preset to the
    // relay until the page is reloaded.
    return [];
  }
  return bakedIndex;
}

/**
 * Which SPHEREx frames cover the position.
 *
 * Two routes. The pre-resolved indexes that ship with the page answer instantly
 * and need no server at all — that is what makes a plain static deployment work,
 * since the pixels themselves come straight from the CORS-enabled AWS mirror.
 * Anywhere else on the sky needs a live cone search, and IRSA sends no CORS
 * headers, so that one call goes through the local relay.
 *
 * The cone stays tiny on purpose: a SPHEREx frame is about 3.5° across, so a
 * near-point query already finds everything that could cover the field, and a
 * wider one makes the archive do far more work for no extra frames.
 */
export async function searchFrames({ ra, dec, radius = 0.006 }, { signal } = {}) {
  const index = await loadBakedIndex(signal);
  const cos = Math.cos((dec * Math.PI) / 180);
  const hit = index.find((f) => Math.hypot(deltaRA(f.ra, ra) * cos, f.dec - dec) < 0.01);
  if (hit) {
    const res = await fetch(`data/fields/${hit.key}.json`, { signal: deadline(signal, CATALOG_DEADLINE_MS) });
    if (res.ok) {
      const field = await res.json();
      return { frames: field.frames, truncated: Boolean(field.truncated), source: 'bundled' };
    }
  }

  let res;
  try {
    res = await fetch(`api/search?ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&radius=${radius}`, { signal: deadline(signal, SEARCH_DEADLINE_MS) });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new NoRelayError(err);
  }

  // A static host answers an unknown path with 404, or with its own index page.
  // A proxy in front of a relay that answers with its own error page — a
  // tunnel's 524 when the archive is slow — is the archive not answering, and
  // asking again may well work.
  const type = res.headers.get('content-type') ?? '';
  if (res.status >= 500 && !type.includes('json')) throw new UpstreamError(`HTTP ${res.status}`);
  if (res.status === 404 || !type.includes('json')) throw new NoRelayError(new Error(`HTTP ${res.status}`));

  const body = await res.json();
  if (!body.ok) throw new UpstreamError(body.error ?? 'search failed');
  // `partial`: one of the archive's collections did not answer, so the list
  // is shorter than the sky's. The page says so beside the count.
  return {
    frames: body.frames, truncated: Boolean(body.truncated),
    partial: Array.isArray(body.warnings) && body.warnings.length > 0, source: 'live',
  };
}

/** Shape a raw SIA row into the fields the app actually uses. */
export function frameFromRow(row) {
  const mjd = Number(row.t_min);
  if (!Number.isFinite(mjd)) return null;
  const band = String(row.energy_bandpassname ?? '').replace('SPHEREx-', '') || '—';
  return {
    obsId: String(row.obs_id ?? '').trim(),
    mjd,
    iso: new Date((mjd - 40587) * 86400000).toISOString().replace('Z', ''),
    band,
    detector: Number(band.slice(1)) || null,
    emMin: Number(row.em_min) * 1e6,
    emMax: Number(row.em_max) * 1e6,
    ra: Number(row.s_ra),
    dec: Number(row.s_dec),
    exptime: Number(row.t_exptime) || null,
    collection: String(row.obs_collection ?? '').trim(),
    url: String(row.access_url ?? '').trim(),
  };
}

/**
 * One frame per visit. SPHEREx often takes several exposures of the same patch
 * within minutes; showing all of them turns a blink into a stutter, so we keep
 * the one whose centre sits closest to the target and call it a visit.
 */
export function groupVisits(frames, { ra, dec, band = 'all', minGapHours = 6 } = {}) {
  const pool = frames
    .filter((f) => band === 'all' || f.band === band)
    .slice()
    .sort((a, b) => a.mjd - b.mjd);

  const visits = [];
  for (const f of pool) {
    const last = visits[visits.length - 1];
    const gapHours = last ? (f.mjd - last.mjd) * 24 : Infinity;
    const offset = Math.hypot(deltaRA(f.ra, ra) * Math.cos(dec * Math.PI / 180), f.dec - dec);
    if (gapHours >= minGapHours) {
      visits.push({ ...f, offset });
    } else if (offset < last.offset) {
      visits[visits.length - 1] = { ...f, offset };
    }
  }
  return visits;
}

export const bandsPresent = (frames) => [...new Set(frames.map((f) => f.band))].sort();

export const bandRange = (frames, band) => {
  const set = frames.filter((f) => f.band === band);
  if (!set.length) return null;
  return [Math.min(...set.map((f) => f.emMin)), Math.max(...set.map((f) => f.emMax))];
};

/* ---------------------------------------------------------------- solar system */

/**
 * Known solar-system objects standing in the field at a given instant.
 * Geocentric: SPHEREx is in low-Earth orbit, which shifts a main-belt asteroid
 * by 3–7″, up to about one pixel and inside the two-pixel match radius.
 */
export async function skybotCone({ ra, dec, radiusDeg, iso }, { signal, magLimit = 20, limit = 40 } = {}) {
  const epoch = iso.slice(0, 19);
  const url = 'https://ssp.imcce.fr/webservices/skybot/api/conesearch.php'
    + `?RA=${ra.toFixed(6)}&DEC=${dec.toFixed(6)}&SR=${Math.min(10, radiusDeg).toFixed(4)}`
    + `&EPOCH=${encodeURIComponent(epoch)}&mime=text&output=basic&loc=500&filter=0`;
  const res = await fetch(url, { signal: deadline(signal, CATALOG_DEADLINE_MS) });
  if (!res.ok) throw new Error(`SkyBoT ${res.status}`);
  const { status, rows } = parseVOTable(await res.text());
  if (status !== 'OK') return [];
  return rows
    .map((r) => ({
      num: r.Num && r.Num !== '-' ? r.Num : null,
      name: r.Name,
      ra: Number(r._RAJ2000),
      dec: Number(r._DECJ2000),
      mag: Number(r.Mv),
      cls: r.Class,
      dRA: Number(r.dRAcosDec),
      dDec: Number(r.dDEC),
      dGeo: Number(r.Dgeo),
      // How far SkyBoT's own position may be off, in arcsec; widens the match.
      err: Number(r.ErrPos),
      link: r.ExternalLink,
      source: 'SkyBoT',
    }))
    .filter((o) => Number.isFinite(o.ra) && Number.isFinite(o.dec) && (!Number.isFinite(o.mag) || o.mag <= magLimit))
    .sort((a, b) => (a.mag || 99) - (b.mag || 99))
    .slice(0, limit);
}

/** The same question asked of JPL, through the relay: JPL sends no CORS headers. */
export async function jplBodies({ ra, dec, radiusDeg, iso }, { signal, magLimit = 20 } = {}) {
  const query = `ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&r=${Math.min(2, radiusDeg).toFixed(4)}`
    + `&time=${encodeURIComponent(iso.slice(0, 19))}&mag=${magLimit}`;
  const body = await fromRelay(`api/sbident?${query}`, signal, SEARCH_DEADLINE_MS);
  return body.bodies;
}

/**
 * How long a SkyBoT answer waits for JPL's. JPL takes 20–70 s for a new field,
 * SkyBoT a few; waiting the whole time would hold every visit's marks back by
 * a minute. JPL's answer is cached by the relay as it lands, so the next look
 * at the field has both.
 */
const JPL_GRACE_MS = 3000;

/**
 * Known solar-system objects in the field at a moment, from SkyBoT and JPL
 * together, each object once (see mergeBodies). Either service alone is enough:
 * when SkyBoT fails, JPL's answer is waited for in full and is the answer.
 */
export async function knownBodies(field, { signal, magLimit = 20, limit = 40 } = {}) {
  const jpl = jplBodies(field, { signal, magLimit }).catch(() => null);
  let skybot;
  try {
    skybot = await skybotCone(field, { signal, magLimit, limit });
  } catch (err) {
    const fromJpl = await jpl;
    if (!fromJpl) throw err;
    return mergeBodies([], fromJpl).slice(0, limit);
  }
  let timer;
  const grace = new Promise((resolve) => { timer = setTimeout(() => resolve(null), JPL_GRACE_MS); });
  const fromJpl = await Promise.race([jpl, grace]);
  clearTimeout(timer);
  return mergeBodies(skybot, fromJpl ?? []).slice(0, limit);
}

/* ------------------------------------------------------------- fixed sources */

const SIMBAD_TAP = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';
const VIZIER_TAP = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';

async function tap(base, query, format, signal) {
  const url = `${base}?request=doQuery&lang=adql&format=${format}&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: deadline(signal, CATALOG_DEADLINE_MS) });
  if (!res.ok) throw new Error(`TAP ${res.status}`);
  return format === 'json' ? res.json() : res.text();
}

/**
 * The family a SIMBAD object type belongs to, for saying what a thing is in a
 * word. SIMBAD's codes run to a couple of hundred; a person asking "what is
 * this" wants star, galaxy or quasar, and the code itself when it is none of them.
 */
const CLUSTERS = new Set(['Cl*', 'OpC', 'GlC', 'As*', 'MGr', 'St*']);
const VARIABLES = new Set(['V*', 'Pu*', 'RR*', 'Ce*', 'dS*', 'Mi*', 'LP*', 'Ir*', 'Er*', 'Ro*', 'a2*', 'El*', 'BY*', 'RS*', 'gD*', 'SX*', 'WV*', 'cC*']);

export function simbadFamily(otype) {
  const t = String(otype ?? '').trim();
  if (!t) return null;
  if (/^(QSO|Bla|BLL|AGN|Sy1|Sy2|SyG|LIN)$/i.test(t)) return t === 'QSO' || /^Bl/i.test(t) ? 'quasar' : 'agn';
  if (/^(G|GiG|GiC|GiP|BiC|LSB|SBG|EmG|H2G|bCG|rG|PaG|IG|Gr|ClG|SCG)$/.test(t)) return 'galaxy';
  if (CLUSTERS.has(t)) return 'cluster';
  if (t === 'EB*') return 'eclipsing';
  if (t === '**' || t === 'SB*') return 'double';
  if (VARIABLES.has(t)) return 'variable';
  if (t.includes('*')) return 'star';
  if (t === 'IR') return 'infrared';
  if (t === 'X') return 'xray';
  if (t === 'Rad' || t === 'mR' || t === 'cm') return 'radio';
  return null;
}

/**
 * A JSON answer from the relay. A static host has no relay, and answers with
 * a 404 or its own page; either is a failure here, and the race goes to VizieR.
 */
async function fromRelay(path, signal, ms) {
  const res = await fetch(path, { signal: deadline(signal, ms) });
  if (!(res.headers.get('content-type') ?? '').includes('json')) throw new Error(`relay: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `relay: HTTP ${res.status}`);
  return body;
}

/** One catalogue's rows in a circle from IRSA, through the relay. */
async function irsaRows(kind, { ra, dec, radiusDeg, limit = null, top }, signal) {
  const mag = limit === null ? '' : `&mag=${limit.toFixed(2)}`;
  const body = await fromRelay(
    `api/tap?cat=${kind}&ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&r=${radiusDeg.toFixed(6)}&top=${top}${mag}`,
    signal, RELAY_DEADLINE_MS,
  );
  return { rows: body.rows, via: body.via ?? 'IRSA' };
}

/**
 * One catalogue's rows in a circle, under the shared column names, from
 * whichever archive answers first: IRSA through the relay, or VizieR straight
 * from the browser. Usually VizieR is quicker and IRSA is there for the days
 * CDS is down; on a static host, with no relay, VizieR is the only route.
 * `via` says which answered.
 */
export async function catalogueRows(kind, field, { signal } = {}) {
  const { vizier } = CATALOGUES[kind];
  const asks = [irsaRows(kind, field, signal)];
  if (vizier) {
    asks.push(tap(VIZIER_TAP, coneQuery(vizier, field), 'csv', signal).then((text) => ({ rows: parseCsv(text), via: 'VizieR' })));
  }
  try {
    return await Promise.any(asks);
  } catch (err) {
    throw err.errors?.[0] ?? err;
  }
}

const num = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const cone = (raCol, decCol, ra, dec, arcsec) =>
  `CONTAINS(POINT('ICRS', ${raCol}, ${decCol}), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${(arcsec / 3600).toFixed(6)})) = 1`;
const sepCol = (raCol, decCol, ra, dec) =>
  `DISTANCE(POINT('ICRS', ${raCol}, ${decCol}), POINT('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)})) * 3600 AS sep`;

/** The brightest row by `key`, ties to the nearest: the one SPHEREx saw in a shared pixel. */
const brightest = (rows, key) => rows
  .filter((r) => Number.isFinite(r.sep))
  .sort((a, b) => (a[key] ?? 99) - (b[key] ?? 99) || a.sep - b.sep)[0] ?? null;

async function askSimbad(ra, dec, signal) {
  const body = await tap(SIMBAD_TAP, `SELECT TOP 8 main_id, otype, ${sepCol('ra', 'dec', ra, dec)}, allfluxes.J AS j, allfluxes.V AS v, allfluxes.G AS g
    FROM basic LEFT JOIN allfluxes ON oid = allfluxes.oidref WHERE ${cone('ra', 'dec', ra, dec, 8)}`, 'json', signal);
  const rows = (body.data ?? []).map(([name, otype, sep, j, v, g]) => ({
    name: String(name).trim().replace(/\s+/g, ' '), otype: String(otype ?? '').trim(), sep: Number(sep),
    mag: j ?? v ?? g ?? null, magBand: j != null ? 'J' : v != null ? 'V' : g != null ? 'G' : null,
  }));
  const best = brightest(rows, 'mag');
  return best ? { ...best, family: simbadFamily(best.otype) } : null;
}

/** Angular distance in arcsec, by the haversine: exact at the few-arcsec scale. */
export function arcsecBetween(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180;
  const s = Math.sin(((dec2 - dec1) * r) / 2) ** 2
    + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(((ra2 - ra1) * r) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(s)))) / r * 3600;
}

/** How far a marked source is looked around in each catalogue: one SPHEREx pixel. */
const NEAR_ARCSEC = 6;

/**
 * One catalogue's rows around a marked spot, each with its distance from it
 * (`sep`) and the archive that answered (`via`). The distance is worked out
 * here, so IRSA and VizieR need ask nothing different.
 */
async function nearby(kind, ra, dec, signal, [raCol, decCol]) {
  const { rows, via } = await catalogueRows(kind, { ra, dec, radiusDeg: NEAR_ARCSEC / 3600, top: 8 }, { signal });
  return rows.map((r) => ({ r, via, sep: arcsecBetween(ra, dec, num(r[raCol]) ?? NaN, num(r[decCol]) ?? NaN) }));
}

async function askGaia(ra, dec, signal) {
  const rows = (await nearby('gaia', ra, dec, signal, ['RA_ICRS', 'DE_ICRS'])).map(({ r, via, sep }) => ({
    id: r.Source, mag: num(r.Gmag), sep, via, variable: /^VARIABLE/.test(r.VarFlag),
    pStar: num(r.PSS), pGalaxy: num(r.PGal), pQuasar: num(r.PQSO), plx: num(r.Plx), plxErr: num(r.e_Plx),
  }));
  return brightest(rows, 'mag');
}

async function askTwoMass(ra, dec, signal) {
  const rows = (await nearby('twomass', ra, dec, signal, ['RAJ2000', 'DEJ2000'])).map(({ r, via, sep }) => ({
    id: r['2MASS'], j: num(r.Jmag), h: num(r.Hmag), k: num(r.Kmag), sep, via,
  }));
  return brightest(rows, 'j');
}

async function askWise(ra, dec, signal) {
  const rows = (await nearby('wise', ra, dec, signal, ['RAJ2000', 'DEJ2000'])).map(({ r, via, sep }) => ({
    id: r.AllWISE, w1: num(r.W1mag), w2: num(r.W2mag), sep, via,
  }));
  return brightest(rows, 'w1');
}

/** CatWISE2020: whether the source moves, measured over ten years of WISE. */
async function askCatwise(ra, dec, signal) {
  const rows = (await nearby('catwise', ra, dec, signal, ['ra_pm', 'dec_pm'])).map(({ r, via, sep }) => {
    const row = parseCatwiseRow(r);
    return row && { id: row.id, w1: row.mag, w2: row.w2, pm: measuredMotion(row), sep, via };
  }).filter(Boolean);
  return brightest(rows, 'w1');
}

async function askVsx(ra, dec, signal) {
  const rows = parseCsv(await tap(VIZIER_TAP, `SELECT TOP 4 Name, Type, Period, max, min, ${sepCol('RAJ2000', 'DEJ2000', ra, dec)}
    FROM "B/vsx/vsx" WHERE ${cone('RAJ2000', 'DEJ2000', ra, dec, 10)}`, 'csv', signal))
    .map((r) => ({ name: r.Name.replace(/\s+/g, ' '), type: r.Type, period: num(r.Period), max: num(r.max), min: num(r.min), sep: num(r.sep) }))
    .sort((a, b) => a.sep - b.sep);
  return rows[0] ?? null;
}

/**
 * What the catalogues say about a marked spot, all asked at once.
 *
 *   SIMBAD     a name and a kind — star, galaxy, quasar;
 *   Gaia DR3   the faint stars SIMBAD never named, whether Gaia saw it vary,
 *              how sure it is of star against galaxy, and a parallax;
 *   2MASS      J, H and K — the near infrared SPHEREx itself works in;
 *   AllWISE    3.4 and 4.6 µm, the red end of SPHEREx's range;
 *   CatWISE2020  whether it moves: proper motions from ten years of WISE,
 *              said only when measured at five times their error;
 *   VSX        the variable-star index: for a source that comes and goes,
 *              the first question is whether it is simply known to vary.
 *
 * A SPHEREx pixel is 6.15″, so several catalogued things can share one; the
 * brightest is the one SPHEREx saw, so that is the one reported. Each answer is
 * on its own: one service down leaves the others standing, and says so.
 */
export async function identifySource({ ra, dec }, { signal } = {}) {
  const asks = { simbad: askSimbad, gaia: askGaia, tmass: askTwoMass, wise: askWise, catwise: askCatwise, vsx: askVsx };
  const keys = Object.keys(asks);
  const settled = await Promise.allSettled(keys.map((k) => asks[k](ra, dec, signal)));
  const out = { failed: [] };
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') out[keys[i]] = s.value;
    else { out[keys[i]] = null; out.failed.push(keys[i]); }
  });
  if (out.failed.length === keys.length) throw new Error('No catalogue answered');
  out.any = keys.some((k) => out[k]);
  return out;
}

const SURVEY_PARSERS = { gaia: parseGaiaRow, wise: parseWiseRow };

/**
 * Every source one survey (`gaia` or `wise`) has in a circle,
 * down to `limit` magnitudes, for laying over the plate. Asked once for a
 * field: the answer holds for every visit, since it is the page that carries
 * positions to each visit's date. Returns `{ rows, cut, reached, via }` (see
 * cutToCap; `via` is the archive that answered).
 *
 * One row more than the cap is asked for, brightest first: the extra row is
 * how a cut list is told from a complete one, and brightest first means a cut
 * list loses its faint end and nothing else.
 */
export async function surveySources(kind, { ra, dec, radiusDeg, limit }, { signal } = {}) {
  const parse = SURVEY_PARSERS[kind];
  const { rows, via } = await catalogueRows(kind, { ra, dec, radiusDeg, limit, top: ROW_CAP + 1 }, { signal });
  return { ...cutToCap(rows.map(parse).filter(Boolean), limit), via };
}

/**
 * The catalogued things worth naming on the picture itself.
 *
 * Only what SPHEREx could plausibly show: brighter than about 16th magnitude,
 * or famous enough to be the reason someone opened the field. A label on a
 * 21st-magnitude galaxy the picture cannot show is a mark on nothing, and it
 * reads as data. Ranked by how often the literature cites it, which puts M 51
 * ahead of the thousand star clusters catalogued inside it.
 */
export async function fieldObjects({ ra, dec, radiusDeg }, { signal, limit = 25 } = {}) {
  const body = await tap(SIMBAD_TAP, `SELECT TOP 400 main_id, otype, ra, dec, nbref, allfluxes.J AS j, allfluxes.V AS v
    FROM basic LEFT JOIN allfluxes ON oid = allfluxes.oidref
    WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radiusDeg.toFixed(5)})) = 1
    ORDER BY nbref DESC`, 'json', signal);
  return (body.data ?? []).map(([name, otype, ora, odec, refs, j, v]) => {
    const kind = String(otype ?? '').trim();
    return {
      name: String(name).trim().replace(/\s+/g, ' '), otype: kind, family: simbadFamily(kind),
      ra: Number(ora), dec: Number(odec), refs: Number(refs) || 0,
      mag: j ?? v ?? null, magBand: j != null ? 'J' : v != null ? 'V' : null,
    };
  })
    .filter((o) => Number.isFinite(o.ra) && Number.isFinite(o.dec) && !NOT_A_POINT.has(o.otype))
    .filter((o) => {
      if (o.mag != null && o.mag <= 16) return true;
      // Without a near-infrared brightness, only what is famous and is a thing
      // SPHEREx does see: galaxies, quasars, clusters, and supernovae whose
      // hosts are in the frame. X-ray and radio sources are neither.
      if (o.refs < 10 || (o.mag != null && o.mag > 18)) return false;
      if (o.otype === 'SN*') return true;
      if (o.otype === 'HII') return o.refs >= 100;
      return ['galaxy', 'agn', 'quasar', 'cluster'].includes(o.family);
    })
    .slice(0, limit);
}

/*
 * SIMBAD types whose position is the nominal centre of something with no point
 * to mark — a region, a cloud — or an event long over, like a gamma-ray burst.
 * A square on the picture there would point at nothing in it.
 */
const NOT_A_POINT = new Set(['reg', 'Cld', 'MoC', 'SFR', 'ISM', 'ev', 'gB', 'err', '?', 'grv']);

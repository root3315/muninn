/**
 * catalog.js — everything that answers "what is at this position".
 *
 * Four services, four different reasons:
 *   · IRSA SIA2  — which SPHEREx frames cover the field. Proxied through the
 *                  local server, because IRSA sends no CORS headers.
 *   · SIMBAD     — turns "M51" into a position, and names what sits at a
 *                  marked spot. Called straight from the browser.
 *   · SkyBoT     — which solar-system objects were standing in the field at the
 *                  moment of a given exposure. Also called straight from the browser.
 *   · Gaia DR3   — through VizieR, for a marked source SIMBAD has no name for.
 */

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
  const res = await fetch(url, { signal });
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

const BAND_LABEL = { 1: 'D1', 2: 'D2', 3: 'D3', 4: 'D4', 5: 'D5', 6: 'D6' };

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
    const res = await fetch('data/fields/index.json', { signal });
    bakedIndex = res.ok ? await res.json() : [];
  } catch {
    bakedIndex = [];
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
    const res = await fetch(`data/fields/${hit.key}.json`, { signal });
    if (res.ok) {
      const field = await res.json();
      return { frames: field.frames, truncated: Boolean(field.truncated), source: 'bundled' };
    }
  }

  let res;
  try {
    res = await fetch(`api/search?ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&radius=${radius}`, { signal });
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
  return { frames: body.frames, truncated: Boolean(body.truncated), source: 'live' };
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

export { BAND_LABEL };

/* ---------------------------------------------------------------- solar system */

/**
 * Known solar-system objects standing in the field at a given instant.
 * Geocentric, which is close enough: SPHEREx is in low-Earth orbit and the
 * parallax against a main-belt asteroid is far below one pixel.
 */
export async function skybotCone({ ra, dec, radiusDeg, iso }, { signal, magLimit = 20, limit = 40 } = {}) {
  const epoch = iso.slice(0, 19);
  const url = 'https://ssp.imcce.fr/webservices/skybot/api/conesearch.php'
    + `?RA=${ra.toFixed(6)}&DEC=${dec.toFixed(6)}&SR=${Math.min(10, radiusDeg).toFixed(4)}`
    + `&EPOCH=${encodeURIComponent(epoch)}&mime=text&output=basic&loc=500&filter=0`;
  const res = await fetch(url, { signal });
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
    }))
    .filter((o) => Number.isFinite(o.ra) && Number.isFinite(o.dec) && (!Number.isFinite(o.mag) || o.mag <= magLimit))
    .sort((a, b) => (a.mag || 99) - (b.mag || 99))
    .slice(0, limit);
}

/* ------------------------------------------------------------- fixed sources */

const SIMBAD_TAP = 'https://simbad.cds.unistra.fr/simbad/sim-tap/sync';
const VIZIER_TAP = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';

async function tap(base, query, format, signal) {
  const url = `${base}?request=doQuery&lang=adql&format=${format}&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal });
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
 * VizieR's CSV, as rows of named fields. Quoted fields come padded to the
 * column width, and a name may carry a comma, so this reads quotes properly
 * rather than splitting on every comma.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field.trim()); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field.trim()); if (row.some((f) => f !== '')) rows.push(row); }
  const [head, ...body] = rows;
  return (body ?? []).map((r) => Object.fromEntries((head ?? []).map((h, k) => [h, r[k] ?? ''])));
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

// Gaia source ids are 64-bit integers and do not survive a trip through a JSON
// number, so every VizieR table is read as text.
async function askGaia(ra, dec, signal) {
  const rows = parseCsv(await tap(VIZIER_TAP, `SELECT TOP 8 Source, Gmag, VarFlag, PQSO, PGal, PSS, Plx, e_Plx, ${sepCol('RA_ICRS', 'DE_ICRS', ra, dec)}
    FROM "I/355/gaiadr3" WHERE ${cone('RA_ICRS', 'DE_ICRS', ra, dec, 6)}`, 'csv', signal))
    .map((r) => ({
      id: r.Source, mag: num(r.Gmag), sep: num(r.sep), variable: /VARIABLE/.test(r.VarFlag),
      pStar: num(r.PSS), pGalaxy: num(r.PGal), pQuasar: num(r.PQSO), plx: num(r.Plx), plxErr: num(r.e_Plx),
    }));
  return brightest(rows, 'mag');
}

async function askTwoMass(ra, dec, signal) {
  const rows = parseCsv(await tap(VIZIER_TAP, `SELECT TOP 8 "2MASS", Jmag, Hmag, Kmag, ${sepCol('RAJ2000', 'DEJ2000', ra, dec)}
    FROM "II/246/out" WHERE ${cone('RAJ2000', 'DEJ2000', ra, dec, 6)}`, 'csv', signal))
    .map((r) => ({ id: r['2MASS'], j: num(r.Jmag), h: num(r.Hmag), k: num(r.Kmag), sep: num(r.sep) }));
  return brightest(rows, 'j');
}

async function askWise(ra, dec, signal) {
  const rows = parseCsv(await tap(VIZIER_TAP, `SELECT TOP 8 AllWISE, W1mag, W2mag, ${sepCol('RAJ2000', 'DEJ2000', ra, dec)}
    FROM "II/328/allwise" WHERE ${cone('RAJ2000', 'DEJ2000', ra, dec, 6)}`, 'csv', signal))
    .map((r) => ({ id: r.AllWISE, w1: num(r.W1mag), w2: num(r.W2mag), sep: num(r.sep) }));
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
 *   VSX        the variable-star index: for a source that comes and goes,
 *              the first question is whether it is simply known to vary.
 *
 * A SPHEREx pixel is 6.15″, so several catalogued things can share one; the
 * brightest is the one SPHEREx saw, so that is the one reported. Each answer is
 * on its own: one service down leaves the others standing, and says so.
 */
export async function identifySource({ ra, dec }, { signal } = {}) {
  const asks = { simbad: askSimbad, gaia: askGaia, tmass: askTwoMass, wise: askWise, vsx: askVsx };
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

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
  propagate, GAIA_EPOCH, CATWISE_EPOCH,
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
export function parseCoordinates(raw) {
  // The page prints positions with a typographic minus and superscript units
  // (08ʰ 55ᵐ 10.83ˢ −07° 14′ 42.5″); pasted back, they are the same position.
  const text = String(raw).replace(/[−–—]/g, '-')
    .replace(/ʰ/g, 'h').replace(/ᵐ/g, 'm').replace(/ˢ/g, 's');
  const sex = SEX.exec(text);
  if (sex) {
    const [, hh, mm, ss, dd, dm, ds] = sex;
    if (hh.trim().startsWith('-') || +mm >= 60 || +ss >= 60 || +dm >= 60 || +ds >= 60) return null;
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
/**
 * Sesame at CDS, and its mirror at the CfA. In November 2026 the CDS address
 * began answering with a redirect to a mirror that sends no CORS headers, so
 * a browser could resolve no name at all; both are asked and the first
 * answer is taken.
 */
const SESAME = [
  'https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?',
  'https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oI/SNV?',
];

async function askSesame(base, name, signal) {
  const res = await fetch(base + encodeURIComponent(name), { signal: deadline(signal, CATALOG_DEADLINE_MS) });
  if (!res.ok) throw new Error(`Sesame ${res.status}`);
  return res.text();
}

export async function resolveName(name, { signal } = {}) {
  let body;
  try {
    body = await Promise.any(SESAME.map((base) => askSesame(base, name, signal)));
  } catch (err) {
    throw err.errors?.[0] ?? err;
  }
  const m = /^%J\s+([\d.+-]+)\s+([\d.+-]+)/m.exec(body);
  if (!m) return null;
  // SIMBAD pads designations for column alignment ("M  51"); collapse that.
  const label = /^%I\.0\s+(.+)$/m.exec(body) ?? /^#\s*(\S.*?)\t/m.exec(body);
  const resolved = (label ? label[1] : name).trim().replace(/\s+/g, ' ');
  // SIMBAD's proper motion in mas a year, when it has one: the %J position is
  // for J2000, and a fast star has left it since.
  const pm = /^%P\s+([\d.+-]+)\s+([\d.+-]+)/m.exec(body);
  return { ra: +m[1], dec: +m[2], name: resolved, ...(pm ? { pm: [+pm[1], +pm[2]] } : {}) };
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
export function searchFrames({ ra, dec, radius = 0.006 }, { signal } = {}) {
  if (ahead && ahead.ra === ra && ahead.dec === dec && radius === ahead.radius) {
    const { promise } = ahead;
    ahead = null;
    return untilAborted(promise, signal);
  }
  return askFrames({ ra, dec, radius }, signal);
}

/**
 * A field a link opens is asked for as the page starts, before the rest of
 * it is ready to show anything: the frame list is a round trip or two to
 * the relay, and nothing else on the way needs to wait for it. The first
 * searchFrames for the same spot takes the answer over; a later one (a
 * retry, a change of band) asks afresh.
 */
let ahead = null;

export function searchAhead({ ra, dec, radius = 0.006 }) {
  const promise = askFrames({ ra, dec, radius }, null);
  promise.catch(() => {});
  ahead = { ra, dec, radius, promise };
}

/** The promise, or an AbortError as soon as the signal fires. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) { stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

async function askFrames({ ra, dec, radius }, signal) {
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

/**
 * The entry of `hosts` ([ra, dec, …] rows) nearest (ra, dec) within `reach`
 * arcseconds, or null.
 */
export function nearestHost(hosts, ra, dec, reach) {
  let best = null;
  let bestGap = reach;
  const band = reach / 3600;
  for (const host of hosts) {
    if (Math.abs(host[1] - dec) > band) continue;
    const gap = arcsecBetween(ra, dec, host[0], host[1]);
    if (gap < bestGap) { best = host; bestGap = gap; }
  }
  return best;
}

/** Exposures closer than this (in days, ~9 s) are one moment: all six detectors shoot together. */
const SAME_MOMENT_DAYS = 1e-4;

/**
 * Where a visit held before a reload sits in a new visit list. The same file
 * first; otherwise the nearest moment, and of the frames taken at that moment
 * the one from the same band, so a size change in "all bands" does not swap
 * the detector. Returns -1 for an empty list or nothing held.
 */
export function findHeldVisit(visits, held) {
  if (!held || !visits.length) return -1;
  if (held.url) {
    const same = visits.findIndex((v) => v.url === held.url);
    if (same >= 0) return same;
  }
  if (!Number.isFinite(held.mjd)) return -1;
  const gap = (v) => Math.abs(v.mjd - held.mjd);
  const nearest = Math.min(...visits.map(gap));
  const atMoment = visits
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => gap(v) - nearest <= SAME_MOMENT_DAYS);
  const sameBand = atMoment.find(({ v }) => v.band === held.band);
  return (sameBand ?? atMoment[0]).i;
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
  const body = await jplTurn(() => fromRelay(`api/sbident?${query}`, signal, SEARCH_DEADLINE_MS), signal);
  return body.bodies;
}

/**
 * JPL questions take turns: the relay keeps three open to JPL and answers
 * the rest "busy" (503), and a field asked about every visit at once, a dozen
 * and more. Two at a time from a page, and a "busy" asked again after a
 * pause, rather than a wall of refusals and visits left unchecked.
 */
const JPL_AT_ONCE = 2;
/** JPL answers in 20–70 s, so a busy relay frees a slot in seconds, not at once. */
const JPL_RETRY_MS = [5000, 10000, 20000];
let jplRunning = 0;
const jplQueue = [];

async function jplTurn(ask, signal) {
  if (jplRunning >= JPL_AT_ONCE) await new Promise((go) => jplQueue.push(go));
  jplRunning += 1;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await ask();
      } catch (err) {
        const busy = /HTTP 503|busy/i.test(String(err?.message));
        if (!busy || attempt >= JPL_RETRY_MS.length || signal?.aborted) throw err;
        await new Promise((wait, stop) => {
          const timer = setTimeout(wait, JPL_RETRY_MS[attempt]);
          signal?.addEventListener('abort', () => { clearTimeout(timer); stop(signal.reason); }, { once: true });
        });
      }
    }
  } finally {
    jplRunning -= 1;
    jplQueue.shift()?.();
  }
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

/**
 * SIMBAD at CDS, and its mirror at the CfA. CDS in Strasbourg has had days
 * this November when it answered nothing; both are asked and the first
 * answer is taken.
 */
const SIMBAD_TAPS = [
  'https://simbad.cds.unistra.fr/simbad/sim-tap/sync',
  'https://simbad.cfa.harvard.edu/simbad/sim-tap/sync',
];
/** VizieR's cone search at the CfA mirror, which also answers when CDS does not. */
const VIZIER_CFA = 'https://vizier.cfa.harvard.edu/viz-bin/votable';
/** Where a person is sent to read more: the mirrors that stayed up. */
export const SIMBAD_PAGE = 'https://simbad.cfa.harvard.edu/simbad/sim-id?Ident=';
export const VIZIER_PAGE = 'https://vizier.cfa.harvard.edu/viz-bin/VizieR-4?';

async function simbadTap(query, format, signal) {
  try {
    return await Promise.any(SIMBAD_TAPS.map((base) => tap(base, query, format, signal)));
  } catch (err) {
    throw err.errors?.[0] ?? err;
  }
}
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

async function askSimbad(ra, dec, signal, arcsec = 8) {
  const body = await simbadTap(`SELECT TOP 8 main_id, otype, ${sepCol('ra', 'dec', ra, dec)}, allfluxes.J AS j, allfluxes.V AS v, allfluxes.G AS g
    FROM basic LEFT JOIN allfluxes ON oid = allfluxes.oidref WHERE ${cone('ra', 'dec', ra, dec, arcsec)}`, 'json', signal);
  const rows = (body.data ?? []).map(([name, otype, sep, j, v, g]) => ({
    name: String(name).trim().replace(/\s+/g, ' ').replace(/^NAME /, ''), otype: String(otype ?? '').trim(), sep: Number(sep),
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

/** The fastest proper motion of any star, Barnard's 10.4″ a year, rounded up. */
const MAX_PM_ARCSEC = 11;

/**
 * The epochs the fixed-position catalogues were observed at, and how far
 * either side of that their sources were seen: a star that moves is only
 * where its catalogue says within that spread.
 */
const EPOCHS = {
  twomass: { at: 1999.5, spread: 2 },   // 2MASS, 1997–2001
  wise: { at: 2010.5, spread: 0.6 },    // AllWISE coadds, 2010 Jan – 2011 Feb
  simbad: { at: 2000.0, spread: 0 },    // SIMBAD and VSX positions: ICRS at J2000
};

/**
 * One catalogue's rows around a spot, each with its distance from it (`sep`)
 * and the archive that answered (`via`). The distance is worked out here,
 * so IRSA and VizieR need ask nothing different.
 */
async function nearby(kind, ra, dec, signal, [raCol, decCol], arcsec = NEAR_ARCSEC) {
  const { rows, via } = await catalogueRows(kind, { ra, dec, radiusDeg: arcsec / 3600, top: 8 }, { signal });
  return rows.map((r) => ({ r, via, sep: arcsecBetween(ra, dec, num(r[raCol]) ?? NaN, num(r[decCol]) ?? NaN) }))
    .filter((x) => x.sep <= arcsec);
}

/**
 * A catalogue with proper motions, matched at the visit's own date. Its
 * positions are of their own epoch — Gaia's 2016.0, CatWISE's 2015.4 — and a
 * fast star has moved since: Barnard's Star is 98″ from its Gaia position by
 * 2025. So the circle asked for is as wide as the fastest star could have gone,
 * every row is carried to `epoch`, and only then matched within a pixel.
 */
async function nearbyMoving(kind, ra, dec, epoch, from, signal, toRow) {
  const reach = NEAR_ARCSEC + MAX_PM_ARCSEC * Math.abs(epoch - from);
  const { rows, via } = await catalogueRows(kind, { ra, dec, radiusDeg: reach / 3600, top: 200 }, { signal });
  return rows.map(toRow).filter(Boolean).map((row) => {
    const now = propagate(row, epoch, from);
    return { ...row, from, via, sep: arcsecBetween(ra, dec, now.ra, now.dec) };
  }).filter((row) => row.sep <= NEAR_ARCSEC);
}

const gaiaRow = (r) => {
  const ra = num(r.RA_ICRS);
  const dec = num(r.DE_ICRS);
  if (ra == null || dec == null) return null;
  return {
    id: r.Source, ra, dec, mag: num(r.Gmag), pmRA: num(r.pmRA), pmDE: num(r.pmDE),
    variable: /^VARIABLE/.test(r.VarFlag), pStar: num(r.PSS), pGalaxy: num(r.PGal), pQuasar: num(r.PQSO),
    plx: num(r.Plx), plxErr: num(r.e_Plx),
  };
};

async function askGaia(ra, dec, signal, epoch) {
  return brightest(await nearbyMoving('gaia', ra, dec, epoch, GAIA_EPOCH, signal, gaiaRow), 'mag');
}

/** CatWISE2020: whether the source moves, measured over ten years of WISE. */
async function askCatwise(ra, dec, signal, epoch) {
  const rows = await nearbyMoving('catwise', ra, dec, epoch, CATWISE_EPOCH, signal, parseCatwiseRow);
  const best = brightest(rows, 'mag');
  return best && { ...best, w1: best.mag, pm: measuredMotion(best) };
}

async function askTwoMass(ra, dec, signal, arcsec) {
  const rows = (await nearby('twomass', ra, dec, signal, ['RAJ2000', 'DEJ2000'], arcsec)).map(({ r, via, sep }) => ({
    id: r['2MASS'], j: num(r.Jmag), h: num(r.Hmag), k: num(r.Kmag), sep, via,
  }));
  return brightest(rows, 'j');
}

async function askWise(ra, dec, signal, arcsec) {
  const rows = (await nearby('wise', ra, dec, signal, ['RAJ2000', 'DEJ2000'], arcsec)).map(({ r, via, sep }) => ({
    id: r.AllWISE, w1: num(r.W1mag), w2: num(r.W2mag), sep, via,
  }));
  return brightest(rows, 'w1');
}

async function askVsx(ra, dec, signal, arcsec = 10) {
  const read = (rows) => rows
    .map((r) => ({ name: String(r.Name ?? '').replace(/\s+/g, ' ').trim(), type: r.Type, period: num(r.Period), max: num(r.max), min: num(r.min), sep: num(r.sep ?? r._r) }))
    .filter((r) => r.name)
    .sort((x, y) => x.sep - y.sep);
  const viaTap = tap(VIZIER_TAP, `SELECT TOP 4 Name, Type, Period, max, min, ${sepCol('RAJ2000', 'DEJ2000', ra, dec)}
    FROM "B/vsx/vsx" WHERE ${cone('RAJ2000', 'DEJ2000', ra, dec, arcsec)}`, 'csv', signal).then((text) => read(parseCsv(text)));
  const q = new URLSearchParams({
    '-source': 'B/vsx/vsx', '-c': `${ra.toFixed(6)} ${dec >= 0 ? '+' : ''}${dec.toFixed(6)}`, '-c.rs': arcsec.toFixed(1),
    '-out': 'Name,Type,Period,max,min', '-out.add': '_r', '-sort': '_r', '-out.max': '4',
  });
  const viaCfa = fetch(`${VIZIER_CFA}?${q}`, { signal: deadline(signal, CATALOG_DEADLINE_MS) })
    .then((res) => { if (!res.ok) throw new Error(`VizieR ${res.status}`); return res.text(); })
    .then((xml) => {
      const { status, message, rows } = parseVOTable(xml);
      if (status === 'ERROR') throw new Error(message);
      return read(rows);
    });
  let rows;
  try {
    rows = await Promise.any([viaTap, viaCfa]);
  } catch (err) {
    throw err.errors?.[0] ?? err;
  }
  return rows[0] ?? null;
}

/**
 * The star found moving, as a position at its catalogue's epoch and a
 * motion, or null. Gaia first; CatWISE for what Gaia cannot see, the cold
 * brown dwarfs WISE 0855 belongs to — and only a motion CatWISE measured at
 * five times its error, since a noise-sized one would send the other
 * catalogues to the wrong place.
 */
export function motionAnchor(gaia, catwise) {
  const fromGaia = gaia && Number.isFinite(gaia.pmRA) && Number.isFinite(gaia.pmDE)
    ? { ra: gaia.ra, dec: gaia.dec, pmRA: gaia.pmRA, pmDE: gaia.pmDE, from: gaia.from } : null;
  const fromWise = catwise?.pm != null
    ? { ra: catwise.ra, dec: catwise.dec, pmRA: catwise.pmRA, pmDE: catwise.pmDE, from: catwise.from } : null;
  // A brown dwarf Gaia cannot see shares its pixel with some faint, still
  // star Gaia does see; the motion that matters is the one CatWISE measured.
  const fast = (a) => (a ? Math.hypot(a.pmRA, a.pmDE) / 1000 : -1);
  if (fromWise && fast(fromWise) > fast(fromGaia) + 0.5) return fromWise;
  return fromGaia ?? fromWise;
}

/**
 * Where to ask a fixed-epoch catalogue, and how wide: the anchor carried back
 * to that catalogue's epoch, with room for the years its sources span; or,
 * with no anchor, the marked spot itself.
 */
export function askedAt(anchor, ra, dec, { at, spread }, base) {
  if (!anchor) return { ra, dec, arcsec: base };
  const there = propagate(anchor, at, anchor.from);
  const pm = Math.hypot(anchor.pmRA, anchor.pmDE) / 1000;
  return { ra: there.ra, dec: there.dec, arcsec: base + pm * spread };
}

/**
 * What the catalogues say about a marked spot.
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
 * Asked all at once, and answered as each catalogue answers. Gaia and CatWISE
 * carry motions, so they are matched at `epoch`, the date of the visits;
 * whatever they find moving is carried back to the epoch of each other
 * catalogue, and that one is asked again there if the place moved. Without
 * that, the challenge's own fast stars — Barnard's, WISE 0855, ε Indi — were
 * matched to whatever faint thing sat at today's position in a 1999 catalogue.
 * The other catalogues are asked at the marked spot straight away, which is
 * where nearly every star still is; what they say is held back until Gaia has
 * answered, so a star Gaia sees moving never shows a neighbour's name. A cold
 * brown dwarf only CatWISE sees moving can, until CatWISE answers; `pending`
 * still names CatWISE then, so nothing final is drawn from it.
 * Asked one after another, SIMBAD's sub-second answer waited on CatWISE's
 * twenty.
 *
 * A SPHEREx pixel is 6.15″, so several catalogued things can share one; the
 * brightest is the one SPHEREx saw, so that is the one reported. Each answer is
 * on its own: one service down leaves the others standing, and says so.
 *
 * `onUpdate` gets the answers so far, in the shape the result has, with
 * `pending` naming the catalogues not yet shown and `asking` the questions
 * still out.
 */
export async function identifySource({ ra, dec, epoch = 2026 }, { signal, onUpdate } = {}) {
  const answers = {};
  const runs = {};
  let anchor = null;
  let gaiaAnswered = false;

  const snapshot = () => {
    const out = { failed: [], pending: [], asking: IDENTIFY_KEYS.filter((k) => !answers[k]) };
    for (const key of IDENTIFY_KEYS) {
      const answer = gaiaAnswered || !(key in FIXED_EPOCH) ? answers[key] : null;
      out[key] = answer?.ok ? answer.value : null;
      if (!answer) out.pending.push(key);
      else if (!answer.ok) out.failed.push(key);
    }
    out.any = IDENTIFY_KEYS.some((k) => out[k]);
    out.moved = anchor ? { epoch } : null;
    return out;
  };
  const publish = () => {
    // The page's trouble drawing an answer is not the catalogues' failure.
    try { onUpdate?.(snapshot()); } catch { /* the final answer still comes */ }
  };

  const askFixed = (key) => {
    const spec = FIXED_EPOCH[key];
    const at = askedAt(anchor, ra, dec, EPOCHS[spec.epoch], spec.arcsec);
    if (runs[key] && sameQuestion(runs[key].at, at)) return;
    // The old question is moot: let go of its place in the relay's queue.
    runs[key]?.stop.abort();
    delete answers[key];
    const stop = new AbortController();
    const run = { at, stop };
    runs[key] = run;
    const runSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    run.done = settled(spec.ask(at.ra, at.dec, runSignal, at.arcsec)).then((answer) => {
      if (runs[key] !== run) return;
      answers[key] = answer;
      publish();
    });
  };
  const askAllFixed = () => Object.keys(FIXED_EPOCH).forEach(askFixed);
  const moving = (key, question) => settled(question).then((answer) => {
    answers[key] = answer;
    if (key === 'gaia') gaiaAnswered = true;
    anchor = motionAnchor(answers.gaia?.value, answers.catwise?.value);
    askAllFixed();
    publish();
  });

  askAllFixed();
  await Promise.all([
    moving('gaia', askGaia(ra, dec, signal, epoch)),
    moving('catwise', askCatwise(ra, dec, signal, epoch)),
  ]);
  // With both motions in, nothing is asked again: these are the last questions.
  await Promise.all(Object.values(runs).map((run) => run.done));
  const out = snapshot();
  if (out.failed.length === IDENTIFY_KEYS.length) throw new Error('No catalogue answered');
  delete out.pending;
  delete out.asking;
  return out;
}

const IDENTIFY_KEYS = ['simbad', 'gaia', 'tmass', 'wise', 'catwise', 'vsx'];

/** The catalogues with positions at one fixed epoch: which epoch, and how wide to look. */
const FIXED_EPOCH = {
  simbad: { epoch: 'simbad', arcsec: 8, ask: askSimbad },
  tmass: { epoch: 'twomass', arcsec: NEAR_ARCSEC, ask: askTwoMass },
  wise: { epoch: 'wise', arcsec: NEAR_ARCSEC, ask: askWise },
  vsx: { epoch: 'simbad', arcsec: 10, ask: askVsx },
};

/**
 * Two circles closer than this, in centre and in radius, ask the same thing:
 * a third of a SPHEREx pixel, inside what the mark's own centre is known to.
 * Any tighter, and the gap between a still star's Gaia position and the
 * centre measured on the picture had every catalogue asked twice.
 */
const SAME_QUESTION_ARCSEC = 2;

const sameQuestion = (a, b) => arcsecBetween(a.ra, a.dec, b.ra, b.dec) <= SAME_QUESTION_ARCSEC
  && Math.abs(a.arcsec - b.arcsec) <= SAME_QUESTION_ARCSEC;

const settled = (promise) => promise.then((value) => ({ ok: true, value }), () => ({ ok: false }));

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
  const body = await simbadTap(`SELECT TOP 400 main_id, otype, ra, dec, nbref, allfluxes.J AS j, allfluxes.V AS v, pmra, pmdec
    FROM basic LEFT JOIN allfluxes ON oid = allfluxes.oidref
    WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radiusDeg.toFixed(5)})) = 1
    ORDER BY nbref DESC`, 'json', signal);
  return (body.data ?? []).map(([name, otype, ora, odec, refs, j, v, pmra, pmdec]) => {
    const kind = String(otype ?? '').trim();
    return {
      name: String(name).trim().replace(/\s+/g, ' ').replace(/^NAME /, ''), otype: kind, family: simbadFamily(kind),
      ra: Number(ora), dec: Number(odec), refs: Number(refs) || 0,
      mag: j ?? v ?? null, magBand: j != null ? 'J' : v != null ? 'V' : null,
      // SIMBAD's positions are for J2000; the motion carries a fast star to
      // the visit's date, where the picture shows it.
      pmRA: pmra == null ? null : Number(pmra), pmDE: pmdec == null ? null : Number(pmdec),
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

/**
 * sbident.js — JPL's Small-Body Identification service, the second answer to
 * "which known asteroids and comets stood in this field at this moment".
 *
 * SkyBoT (IMCCE) is the first. Two independent ephemeris services mean a known
 * object is still named when one of them is down, and an object only one of
 * them lists is still named. JPL sends no CORS headers, so the relay asks it;
 * this module is the question and the reading of the answer, shared by both
 * sides and tested in Node.
 */

export const SB_IDENT = 'https://ssd-api.jpl.nasa.gov/sb_ident.api';

/** Seconds of RA to two places, with the carry done on the rounded total. */
export function raSexagesimal(raDeg) {
  const total = Math.round(((((raDeg % 360) + 360) % 360) / 15) * 360000) % (24 * 360000);
  const h = Math.floor(total / 360000);
  const m = Math.floor((total % 360000) / 6000);
  const s = (total % 6000) / 100;
  return `${pad(h)}-${pad(m)}-${s.toFixed(2).padStart(5, '0')}`;
}

/** Arcseconds of Dec to one place; JPL writes south with an M, not a minus. */
export function decSexagesimal(decDeg) {
  const total = Math.round(Math.abs(decDeg) * 36000);
  const d = Math.floor(total / 36000);
  const m = Math.floor((total % 36000) / 600);
  const s = (total % 600) / 10;
  return `${decDeg < 0 ? 'M' : ''}${pad(d)}-${pad(m)}-${s.toFixed(1).padStart(4, '0')}`;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * The question for a square field `halfWidthDeg` each way of the centre, at
 * `iso` (UTC). Geocentric (MPC code 500), as SkyBoT is asked. Two passes: the
 * first alone places objects only to a few arcminutes, the second to well
 * under a pixel, and only the second is kept.
 */
export function sbIdentUrl({ ra, dec, halfWidthDeg, iso, magLimit }) {
  const params = new URLSearchParams({
    'mpc-code': '500',
    'obs-time': iso.slice(0, 19).replace('T', '_'),
    'fov-ra-center': raSexagesimal(ra),
    'fov-dec-center': decSexagesimal(dec),
    'fov-ra-hwidth': halfWidthDeg.toFixed(4),
    'fov-dec-hwidth': halfWidthDeg.toFixed(4),
    'two-pass': 'true',
    'suppress-first-pass': 'true',
    'vmag-lim': magLimit.toFixed(1),
  });
  return `${SB_IDENT}?${params}`;
}

/** "21:59:27.70" → degrees. */
const hmsToDeg = (text) => {
  const [h, m, s] = String(text).split(':').map(Number);
  return (h + m / 60 + s / 3600) * 15;
};

/** "-11 52'18.3\"" → degrees. The sign belongs to the whole, "-00 05'…" included. */
const dmsToDeg = (text) => {
  const m = /^\s*([+-]?)(\d+)\s+(\d+)'\s*([\d.]+)/.exec(String(text));
  if (!m) return NaN;
  const value = Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600;
  return m[1] === '-' ? -value : value;
};

/**
 * JPL's name, split the way SkyBoT splits it: "152 Atala (A875 TA)" is number
 * 152, name Atala; "103377 (2000 AG119)" is number 103377, name 2000 AG119;
 * "(2006 DK213)" has no number; a comet keeps its designation.
 */
export function splitName(full) {
  const text = String(full).trim();
  const numbered = /^(\d+)\s+(.+)$/.exec(text);
  if (numbered) {
    const rest = numbered[2];
    const own = /^(.*?)\s*\((.+)\)$/.exec(rest);
    return { num: numbered[1], name: own ? (own[1] || own[2]) : rest };
  }
  const provisional = /^\((.+)\)$/.exec(text);
  if (provisional) return { num: null, name: provisional[1] };
  return { num: null, name: text.replace(/\s*\(.+\)$/, '') || text };
}

/**
 * The second-pass table as the objects SkyBoT gives (see skybotCone), so the
 * page draws and matches either the same way. JPL gives no orbit class, no
 * distance and no position error here; those stay null.
 */
export function parseSbIdent(body) {
  const fields = body?.fields_second ?? [];
  const rows = body?.data_second_pass ?? [];
  const at = (label) => fields.findIndex((f) => f.startsWith(label));
  const col = {
    name: at('Object name'), ra: at('Astrometric RA'), dec: at('Astrometric Dec'),
    mag: at('Visual magnitude'), dRA: at('RA rate'), dDec: at('Dec rate'),
  };
  if (Object.values(col).some((k) => k < 0)) return [];
  return rows.map((r) => {
    const { num, name } = splitName(r[col.name]);
    return {
      num, name,
      ra: hmsToDeg(r[col.ra]), dec: dmsToDeg(r[col.dec]), mag: Number(r[col.mag]),
      cls: null, dRA: Number(r[col.dRA]), dDec: Number(r[col.dDec]), dGeo: null, err: null,
      link: `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${encodeURIComponent(num ?? name)}`,
      source: 'JPL',
    };
  }).filter((o) => Number.isFinite(o.ra) && Number.isFinite(o.dec));
}

/** One key per object, whichever service named it: the number, else the name. */
const bodyKey = (o) => (o.num ? `#${o.num}` : String(o.name).replace(/\s+/g, ' ').trim().toLowerCase());

/**
 * Both services' objects, each once. SkyBoT's entry is kept where both list
 * an object, since it carries the orbit class, distance and position error;
 * JPL fills in what SkyBoT does not have. Brightest first.
 */
export function mergeBodies(first, second) {
  const seen = new Map();
  for (const o of [...first, ...second]) if (!seen.has(bodyKey(o))) seen.set(bodyKey(o), o);
  return [...seen.values()].sort((a, b) => (a.mag || 99) - (b.mag || 99));
}

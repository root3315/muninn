/**
 * Asteroids and comets by name or number: what JPL is asked, and how its
 * answers are read. Shared by the page, which decides whether the text is
 * worth asking about, and the relay (server.js), which asks: JPL's Small-Body
 * Database to confirm the body, then Horizons for where it stands on a date.
 *
 * Neither JPL service sends CORS headers, so the browser cannot ask them
 * itself; the relay builds both URLs from the checked designation alone.
 */

const SBDB_API = 'https://ssd-api.jpl.nasa.gov/sbdb.api';
const HORIZONS_API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

/** The most bodies one name may stand for ("Halley": an asteroid and a comet). */
export const SMALL_BODY_MAX = 3;

/**
 * What to ask the Small-Body Database for the text, or null when the text
 * cannot be a small body's designation or name.
 *
 * `sure` says the text has a designation's own shape: "(152) Atala",
 * "433 Eros", "2024 YR4", "1P/Halley", "C/2020 F3". A single plain word
 * ("Ceres") might be one too, and is asked about alongside the star
 * catalogues, as `sure: false`.
 */
export function smallBodyQuery(raw) {
  const text = String(raw ?? '').replace(/[−–—]/g, '-').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 40) return null;

  // A provisional designation: "2024 YR4", "2024YR4", "1998 KY26".
  let m = /^(18\d\d|19\d\d|20\d\d) ?([A-Z]{2})(\d{0,4})$/i.exec(text);
  if (m) return { sstr: `${m[1]} ${m[2].toUpperCase()}${m[3]}`, sure: true };

  // "(152) Atala", "(152)", "152 Atala": the number is the designation.
  m = /^\((\d{1,7})\)(?: [\p{L}' -]+)?$/u.exec(text) ?? /^(\d{1,7}) \p{L}[\p{L}' -]*$/u.exec(text);
  if (m) return { sstr: String(Number(m[1])), sure: true };

  // A periodic comet: "1P", "1P/Halley", "67P/Churyumov-Gerasimenko".
  m = /^(\d{1,4}[PDI])(?:\/[\p{L}' -]+)?$/iu.exec(text);
  if (m) return { sstr: m[1].toUpperCase(), sure: true };

  // A comet by its year: "C/2020 F3", "P/2010 A2", "C/2020 F3 (NEOWISE)".
  m = /^([PCDXIA])\/ ?(1[6-9]\d\d|20\d\d) ?([A-Z]{1,2}\d{0,4})(?: \([\p{L}' -]+\))?$/iu.exec(text);
  if (m) return { sstr: `${m[1].toUpperCase()}/${m[2]} ${m[3].toUpperCase()}`, sure: true };

  // A plain name, one word: "Ceres", "Eros", "Halley".
  if (/^\p{L}[\p{L}'-]{2,24}$/u.test(text)) return { sstr: text, sure: false };
  return null;
}

/** The characters the relay lets through to JPL: what smallBodyQuery writes. */
export const SBDB_TEXT = /^[\p{L}\d' /-]{1,40}$/u;

export const sbdbUrl = (sstr) => `${SBDB_API}?sstr=${encodeURIComponent(sstr)}`;

/**
 * The bodies an SBDB answer names, as `{ des, name }`: one for a single
 * match, a few for a name several bodies share, none for "not found".
 * In a list, only bodies that carry the asked-for word as a whole name are
 * kept: "Kepler" is 1134 Kepler, not every body with Kepler in its name.
 */
export function readSbdb(body, sstr) {
  if (body?.object) {
    const o = body.object;
    return [{ des: String(o.des), name: o.shortname ?? o.fullname ?? String(o.des), comet: /^c/.test(o.kind ?? '') }];
  }
  if (String(body?.code) === '300' && Array.isArray(body.list)) {
    const word = String(sstr).toLowerCase();
    const named = (n) => String(n).toLowerCase().split(/[\s/()]+/).includes(word);
    return body.list
      .filter((c) => c?.pdes && (named(c.name) || String(c.pdes).toLowerCase() === word))
      .slice(0, SMALL_BODY_MAX)
      .map((c) => ({ des: String(c.pdes), name: String(c.name).replace(/\s*\([^)]*\)\s*$/, ''), comet: isCometDes(c.pdes) }));
  }
  return [];
}

const isCometDes = (des) => /^(\d+[PDI]|[PCDXI]\/)/.test(String(des));

/**
 * How Horizons is told which body: a numbered asteroid by its number and a
 * semicolon, a comet by designation and its apparition closest to now, and
 * anything else by designation. ("DES=1" is every comet 1P, and a plain
 * "20000433" a different body altogether.)
 */
export function horizonsCommand({ des, comet }) {
  if (/^\d+$/.test(des)) return `${des};`;
  if (comet || isCometDes(des)) return `DES=${des};CAP;NOFRAG;`;
  return `DES=${des};`;
}

/** Horizons, seen from the Earth's centre, RA and Dec in degrees on one UTC day. */
export function horizonsUrl(body, day) {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const q = new URLSearchParams({
    format: 'json',
    COMMAND: `'${horizonsCommand(body)}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'OBSERVER',
    CENTER: "'500@399'",
    START_TIME: `'${day}'`,
    STOP_TIME: `'${next}'`,
    STEP_SIZE: "'1 d'",
    QUANTITIES: "'1'",
    ANG_FORMAT: 'DEG',
    CSV_FORMAT: 'YES',
  });
  return `${HORIZONS_API}?${q}`;
}

/**
 * The first position in a Horizons answer, or null when it holds none, or
 * when the body Horizons answered for is not the one asked about: a
 * designation it reads another way names a different body, and a position
 * for the wrong body is worse than none.
 */
export function readHorizons(body, { des } = {}) {
  const text = String(body?.result ?? '');
  const target = /^Target body name:\s*(.+?)\s{2,}/m.exec(text)?.[1] ?? '';
  if (des && !target.includes(des)) return null;
  const from = text.indexOf('$$SOE');
  if (from < 0) return null;
  const line = text.slice(from + 5).trim().split('\n')[0] ?? '';
  const cells = line.split(',').map((c) => c.trim());
  const ra = Number(cells[3]);
  const dec = Number(cells[4]);
  if (!cells[3] || !cells[4] || !Number.isFinite(ra) || !Number.isFinite(dec)) return null;
  if (ra < 0 || ra >= 360 || Math.abs(dec) > 90) return null;
  return { ra, dec };
}

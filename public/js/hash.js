/**
 * hash.js — the field, as a link.
 *
 * Everything needed to put someone else in front of the same picture: where,
 * how wide, which band, which catalogue overlay, the mode, the visit held on
 * screen and the places marked on it. The language goes in once, so a link
 * sent in Russian opens in Russian.
 *
 *   #ra=269.44630&dec=4.76800&fov=0.3&band=D2&mode=single&v=4&marks=269.44,4.77;269.45,4.76
 */

export const FOV_CHOICES = [0.1, 0.15, 0.2, 0.3, 0.45, 0.6];
export const SURVEY_CHOICES = ['off', 'gaia', 'wise', 'both'];
export const MODES = ['blink', 'wipe', 'difference', 'single', 'stack'];
/** More than this many marks in a link is a link nobody can paste. */
const MAX_MARKS = 40;

const inSky = (ra, dec) => Number.isFinite(ra) && Number.isFinite(dec) && ra >= 0 && ra < 360 && Math.abs(dec) <= 90;

/** `ra,dec;ra,dec` → [{ ra, dec }], dropping anything that is not a place on the sky. */
export function parseMarks(text) {
  if (!text) return [];
  return text.split(';').map((pair) => {
    const [ra, dec] = pair.split(',').map((s) => (s.trim() === '' ? NaN : Number(s)));
    return { ra, dec };
  }).filter((m) => inSky(m.ra, m.dec)).slice(0, MAX_MARKS);
}

export const formatMarks = (marks) => marks.slice(0, MAX_MARKS)
  .map((m) => `${m.ra.toFixed(5)},${m.dec.toFixed(5)}`).join(';');

/** The fragment for a field, without the leading `#`. */
export function encodeHash({
  ra, dec, fov, band = 'all', lang = null, name = '', survey = 'off', mode = null, visit = null, marks = [], pm = null,
}) {
  const p = new URLSearchParams({ ra: ra.toFixed(5), dec: dec.toFixed(5), fov: String(fov), band });
  if (lang) p.set('lang', lang);
  if (name) p.set('name', name);
  // A named object's motion, so its marker follows it on a shared link.
  if (Array.isArray(pm) && pm.every(Number.isFinite)) p.set('pm', `${pm[0]},${pm[1]}`);
  if (survey && survey !== 'off') p.set('cat', survey);
  // Blink is where every field opens, so it is the absence of a mode.
  if (mode && mode !== 'blink' && MODES.includes(mode)) p.set('mode', mode);
  if (Number.isInteger(visit) && visit >= 0) p.set('v', String(visit));
  if (marks.length) p.set('marks', formatMarks(marks));
  // Commas and semicolons are safe in a fragment; left escaped they make the
  // marks unreadable to anyone looking at the link.
  return p.toString().replace(/%2C/gi, ',').replace(/%3B/gi, ';');
}

/** Whatever a fragment says, with every value checked; absent means absent. */
export function decodeHash(hash) {
  const p = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  // Number(null) is 0, which would read an empty hash as a valid position at
  // the vernal equinox.
  const ra = p.has('ra') ? Number(p.get('ra')) : NaN;
  const dec = p.has('dec') ? Number(p.get('dec')) : NaN;
  const fov = Number(p.get('fov'));
  const visit = p.has('v') ? Number(p.get('v')) : NaN;
  const mode = p.get('mode');
  const pm = p.has('pm') ? p.get('pm').split(',').map(Number) : null;
  return {
    lang: p.get('lang'),
    band: p.get('band') || 'all',
    fov: FOV_CHOICES.includes(fov) ? fov : null,
    name: p.get('name') ?? '',
    pm: pm && pm.length === 2 && pm.every(Number.isFinite) ? pm : null,
    survey: SURVEY_CHOICES.includes(p.get('cat')) ? p.get('cat') : 'off',
    mode: MODES.includes(mode) ? mode : null,
    visit: Number.isInteger(visit) && visit >= 0 ? visit : null,
    marks: parseMarks(p.get('marks')),
    position: inSky(ra, dec) ? { ra, dec } : null,
  };
}

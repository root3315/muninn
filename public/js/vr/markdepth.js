/**
 * markdepth.js — where a mark on the field stands in the depth view, and
 * what its beam says.
 *
 * A mark is a direction. Its depth comes only from somewhere honest:
 *
 *   at       a catalogue object with a distance: a SkyBoT body at its JPL
 *            distance, a Gaia star by Bailer-Jones or 1/ϖ, a galaxy by its
 *            redshift; a marker on the beam there.
 *   range    an unidentified mark linked across seasons: the link's range.
 *   ceiling  an unidentified mover: from the Sun out to the farthest its rate
 *            allows (hunt.js distanceCeilingAU), an estimate, said as one.
 *   far      no distance: the beam runs to the far shell and says why;
 *            no marker, so no distance is implied.
 *
 * `state` is what the beam's words say: at, noDistance, link, ceiling,
 * unknown, asking (the catalogues are still out) or failed (they did not
 * answer; the beam offers to ask again).
 */
import { whoSoFar } from '../marks.js';
import { distanceCeilingAU } from '../hunt.js';
import { AU_PER_PC, parallaxDistancePc, redshiftDistanceMpc, MIN_REDSHIFT } from './depth3d.js';
import { shortName } from '../sky.js';
import { arcsecBetween } from '../catalog.js';

/** How near a SIMBAD galaxy of the depth view's list must sit to be the mark's. */
const GALAXY_MATCH_ARCSEC = 6;
/** Where a ceiling's segment begins: about the Sun's distance from the observer. */
const SUN_AU = 1;
const IDENTIFIED_KINDS = new Set(['fixed', 'saturated', 'intermittent', 'transient']);

/** The mark's own colour, as its number is drawn on the field: a mover's or a still one's. */
export const markTone = (m) => (['moving', 'transient'].includes(m.analysis?.kind) ? 'counter' : 'accent');

/** A galaxy of the depth view's list at the mark, by name or by place. */
function galaxyAt(m, r, galaxies) {
  if (!galaxies?.length) return null;
  const name = r?.simbad?.name;
  return galaxies.find((g) => (name && g.name === name)
    || arcsecBetween(g.ra, g.dec, m.ra, m.dec) <= GALAXY_MATCH_ARCSEC) ?? null;
}

/** A distance for what the catalogues said, or null: Bailer-Jones, then 1/ϖ, then a galaxy's redshift. */
function catalogueDistance(m, r, { bj, galaxies }) {
  const g = r?.gaia;
  if (g) {
    const geo = g.id != null ? bj?.get(String(g.id)) : null;
    if (geo?.r > 0) return { au: geo.r * AU_PER_PC, src: 'bj', pc: geo.r };
    const plx = parallaxDistancePc(g.plx, g.plxErr);
    if (plx?.pc > 0) return { au: plx.pc * AU_PER_PC, src: 'plx', pc: plx.pc };
  }
  const isGalaxy = ['galaxy', 'agn', 'quasar'].includes(r?.simbad?.family);
  const gal = isGalaxy || (!r?.gaia && !r?.simbad) ? galaxyAt(m, r, galaxies) : null;
  if (gal && gal.z >= MIN_REDSHIFT) {
    const mpc = redshiftDistanceMpc(gal.z);
    return { au: mpc * 1e6 * AU_PER_PC, src: 'z', z: gal.z, mpc, name: gal.name };
  }
  return null;
}

/** The catalogue's name for what is at the mark, or null. */
function nameOf(r) {
  if (r?.simbad) return shortName(r.simbad.name);
  if (r?.vsx) return r.vsx.name;
  if (r?.gaia?.id != null) return `Gaia DR3 ${r.gaia.id}`;
  return null;
}

/** The season link's range for the mark, or null. */
function linkRange(m) {
  const hit = m.link?.state === 'done' && !m.link.result?.star ? m.link.result?.link : null;
  return hit ? { nearAU: hit.near, farAU: hit.far, au: hit.d } : null;
}

/**
 * The depth display for mark number `n`. `bj` is the depth view's
 * Bailer-Jones map (Gaia source id → { r }), `galaxies` its SIMBAD galaxies
 * ({ name, ra, dec, z }); `ceiling` is replaceable for the tests.
 */
export function markDepth(m, n, { bj = null, galaxies = null, ceiling = distanceCeilingAU } = {}) {
  const a = m.analysis;
  const kind = a?.kind ?? 'none';
  const base = { n, ra: m.ra, dec: m.dec, tone: markTone(m), track: kind === 'moving' ? (a.track ?? []).map((p) => ({ ra: p.ra, dec: p.dec })) : null };
  const far = (state, extra = {}) => ({ ...base, show: 'far', state, ...extra });

  // A body SkyBoT puts here: where JPL has it.
  if (m.catalog?.state === 'match') {
    const o = m.catalog.object;
    const name = m.catalog.name;
    return Number.isFinite(o?.dGeo) && o.dGeo > 0
      ? { ...base, show: 'at', state: 'at', au: o.dGeo, name, src: 'body' }
      : far('noDistance', { name });
  }
  const link = linkRange(m);
  if (kind === 'moving') {
    if (m.catalog?.state === 'waiting') return far('asking');
    if (link) return { ...base, show: 'range', state: 'link', ...link };
    const au = ceiling(a.ratePerHour);
    return au ? { ...base, show: 'ceiling', state: 'ceiling', nearAU: SUN_AU, farAU: au, au } : far('unknown', { faint: true });
  }

  // Anything else is asked of the star catalogues once SkyBoT has had its say.
  const r = whoSoFar(m);
  const name = nameOf(r);
  if (r) {
    const d = catalogueDistance(m, r, { bj, galaxies });
    if (d) return { ...base, show: 'at', state: 'at', au: d.au, name: name ?? d.name ?? null, src: d.src, z: d.z, pc: d.pc, mpc: d.mpc };
  }
  if (name) return far('noDistance', { name, asking: m.who?.state === 'asking' });
  if (link) return { ...base, show: 'range', state: 'link', ...link };
  const asking = m.who?.state === 'asking'
    || (IDENTIFIED_KINDS.has(kind) && !m.who && m.catalog?.state === 'waiting');
  if (asking) return far('asking');
  if (m.who?.state === 'failed' || m.who?.state === 'timeout') return far('failed', { faint: true });
  return far('unknown', { faint: true });
}

/** A distance in AU in the unit that reads best: AU, pc, kpc, Mpc. Returns [key, value]. */
export function distanceUnit(au) {
  if (au < 2e4) return ['vr.au', au < 10 ? au.toFixed(2) : String(Math.round(au))];
  const pc = au / AU_PER_PC;
  if (pc < 1e3) return ['vr.pc', pc < 10 ? pc.toFixed(2) : String(Math.round(pc))];
  if (pc < 1e6) return ['vr.kpc', (pc / 1e3).toFixed(1)];
  return ['vr.Mpc', String(Math.round(pc / 1e6))];
}

/** The beam's words: a first line and a second (the source), through `tv`. */
export function markWords(d, tv) {
  const dist = (au) => { const [key, v] = distanceUnit(au); return tv(key, { v }); };
  switch (d.state) {
    case 'at': return [tv('vr.markAt', { n: d.n, name: d.name ?? '—', d: dist(d.au) }), tv(`vr.markSrc.${d.src}`, { z: d.z?.toFixed(4) ?? '' })];
    case 'noDistance': return [tv('vr.markNoDistance', { n: d.n, name: d.name })];
    case 'link': return [tv('vr.markLink', { n: d.n, near: Math.round(d.nearAU), far: Math.round(d.farAU) })];
    case 'ceiling': return [tv('vr.markCeiling', { n: d.n, au: d.farAU < 10 ? d.farAU.toFixed(1) : String(Math.round(d.farAU)) })];
    case 'asking': return [tv('vr.markAsking', { n: d.n })];
    case 'failed': return [tv('vr.markFailed', { n: d.n })];
    default: return [tv('vr.markUnknown', { n: d.n })];
  }
}

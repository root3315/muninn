/**
 * The search box asking beyond the page: SIMBAD, NED and VizieR through
 * Sesame for any catalogue name, and JPL for asteroids and comets, once the
 * typing pauses. The answers become rows in the same list, each saying what
 * it is; a text none of them knows is said to be unknown to them, by name.
 */

import { resolveSesame, resolveSmallBody } from './catalog.js';
import { smallBodyQuery } from './smallbody.js';

/** SIMBAD's object types, as the kinds the list names. */
const GALAXY = /^(G|G\?|GiG|GiC|GiP|BiC|IG|PaG|SBG|SyG|Sy1|Sy2|AGN|AG\?|LIN|H2G|EmG|rG|LSB|bCG|SCG|ClG|GrG|CGG|PoG|BClG|C\?G|Gr\?|Gx|LeG)$/;
const QUASAR = /^(QSO|Q\?|Bla|BLL|Bz\?|BL\?|LeQ)$/;
const NEBULA = /^(HII|PN|PN\?|SNR|SR\?|RNe|MoC|DNe|Cld|GNe|EmO|bub|ISM|CGb|HVC|glb|cor|SFR)$/;
const CLUSTER = /^(Cl\*|GlC|OpC|As\*|St\*|MGr|C\?\*|Gl\?)$/;

/** What a SIMBAD object type is called in the list. */
export function kindOfOtype(otype) {
  const o = String(otype ?? '').trim();
  if (/^Pl\??$/.test(o)) return 'exoplanet';
  if (QUASAR.test(o)) return 'quasar';
  if (GALAXY.test(o)) return 'galaxy';
  if (NEBULA.test(o)) return 'nebula';
  if (CLUSTER.test(o)) return 'cluster';
  if (o.includes('*') || /^(Psr|WD\?|BD\?|LM\?|HB\?)$/.test(o)) return 'star';
  return 'object';
}

/** Answers kept for the page's life, by text: going back over a word asks nothing. */
const kept = new Map();
const KEEP_MAX = 100;

/** Whether the text is worth asking beyond the page about. */
export function worthAsking(text) {
  const s = String(text ?? '').trim();
  return s.length >= 3 && !/^[\d\s.,:+\-−]+$/.test(s);
}

/**
 * The rows SIMBAD, NED and JPL give for the text, and which of them did not
 * answer: `{ rows, missed: ['sesame'|'jpl'] }`. Never throws for a service
 * being down; an aborted ask rejects as fetch does.
 */
export async function lookUp(text, { signal } = {}) {
  const key = text.trim().toLowerCase();
  if (kept.has(key)) return kept.get(key);

  const small = smallBodyQuery(text);
  const [sesame, jpl] = await Promise.allSettled([
    resolveSesame(text, { signal }),
    small ? resolveSmallBody(text, { signal }) : Promise.resolve(null),
  ]);
  signal?.throwIfAborted();

  const rows = [];
  const missed = [];
  if (sesame.status === 'fulfilled' && sesame.value) {
    const hit = sesame.value;
    rows.push({ kind: kindOfOtype(hit.otype), label: hit.name, ra: hit.ra, dec: hit.dec, ref: hit, remote: true });
  } else if (sesame.status === 'rejected') {
    missed.push('sesame');
  }
  if (jpl.status === 'fulfilled' && jpl.value) {
    for (const body of jpl.value.bodies) {
      rows.push({
        kind: 'smallbody', label: body.name, ra: body.ra, dec: body.dec, day: jpl.value.day,
        ref: body, remote: true,
      });
    }
  } else if (jpl.status === 'rejected' && small) {
    missed.push('jpl');
  }
  // A designation's own shape is JPL's before it is anyone else's.
  if (small?.sure) rows.sort((a, b) => (b.kind === 'smallbody') - (a.kind === 'smallbody'));

  const answer = { rows, missed, smallBody: Boolean(small) };
  if (!missed.length) {
    kept.set(key, answer);
    if (kept.size > KEEP_MAX) kept.delete(kept.keys().next().value);
  }
  return answer;
}

/**
 * The number of a numbered asteroid, for finding it among the ready fields:
 * "(152) Atala" is a challenge target with its own date, not today's place.
 */
export const asteroidNumber = (row) => (row.kind === 'smallbody' && /^\d+$/.test(row.ref?.des ?? '') ? row.ref.des : null);

/**
 * A row from beyond the page as the sky's own hit, the shape a press on the
 * sky gives: a star (a planet's own name opens its star) or a thing the card
 * names by what it is. A small body's card and note say its place is today's.
 */
export function hitOfRow(row, say) {
  const at = { ra: row.ra, dec: row.dec };
  const what = say(`suggest.kind.${row.kind}`);
  if (row.kind === 'host') {
    return { kind: 'star', ...at, label: row.host ?? row.label, sub: '', what: row.host ? `${what} · ${row.label}` : what };
  }
  if (row.kind === 'star') return { kind: 'star', ...at, label: row.label, sub: '', what };
  if (row.kind === 'smallbody') {
    const note = say('search.today', { day: row.day });
    return { kind: 'deep', key: null, ...at, label: row.label, what: `${what} · ${note}`, note, fov: 0.3, band: 'all' };
  }
  return { kind: 'deep', key: null, ...at, label: row.label, what, fov: 0.3, band: 'all' };
}

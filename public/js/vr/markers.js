/**
 * markers.js — what on the sky can be chosen. Pure.
 *
 * The same promise the opening sky makes: a marker is only put where the tool
 * can deliver SPHEREx's frames, so these are the fields whose frame indexes
 * ship with the site (data/targets.json, the challenge targets among them) and
 * the planets, computed for now. Nothing else on the sky is a door.
 */

import { radecToVec } from './skydata.js';

/** Where a marker stands: its target's direction times the sky's radius. */
export function markerPosition({ ra, dec }, radius) {
  const [x, y, z] = radecToVec(ra, dec);
  return [x * radius, y * radius, z * radius];
}

/**
 * The fields and planets as markers: `{ kind, key, ra, dec, v, target }`,
 * `target` being the entry of targets.json (or the planet) it opens.
 */
export function buildMarkers(fields, planets = []) {
  const out = [];
  for (const f of fields) {
    if (!Number.isFinite(f.ra) || !Number.isFinite(f.dec)) continue;
    out.push({
      kind: f.group === 'challenge' ? 'challenge' : 'field',
      key: f.key, ra: f.ra, dec: f.dec, v: radecToVec(f.ra, f.dec), target: f,
    });
  }
  for (const p of planets) {
    out.push({
      kind: 'planet', key: p.key, ra: p.ra, dec: p.dec, v: radecToVec(p.ra, p.dec),
      target: { key: p.key, ra: p.ra, dec: p.dec, fov: 0.3, band: 'all', planet: true, au: p.distanceAU },
    });
  }
  return out;
}

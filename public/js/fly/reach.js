/**
 * reach.js — how far SPHEREx can see a cold body, from numbers this project
 * already stands behind.
 *
 *   D6 one-visit limit   16.58 AB  measured on the WISE 0855 field's own 17
 *                                  D6 visits: the detector noise its field
 *                                  page quotes (depth.js stackDepth), so the
 *                                  card here and the field say 16.6 and 18.1
 *   WISE 0855−0714       W2 ≈ 13.9 Vega ≈ 17.2 AB at 2.28 pc (parallax
 *                        439 mas, Kirkpatrick et al. 2021)
 *   a stack of N visits  deeper by 2.5·log10(√N), the noise of a mean
 *
 * A body like WISE 0855 at distance d is 17.2 + 5·log10(d / 2.28 pc) AB; it is
 * seen where that is brighter than the limit. Nothing else is assumed: no
 * spectrum, no model of brown dwarfs, only this one measured object moved
 * nearer or farther.
 *
 * Planet Nine is shown for what it is: predicted at V 22.6–24.3 in reflected
 * light (Linder & Mordasini 2016), 400–800 AU out (Batygin et al. 2019),
 * within 21° of the ecliptic (Brown & Batygin 2021). depth.js carries those.
 */

import { PLANET_NINE_V, PLANET_NINE_AU, PLANET_NINE_MAX_BETA } from '../depth.js';

export const D6_ONE_VISIT_AB = 16.58;
export const WISE0855_AB = 17.2;
export const WISE0855_PC = 1000 / 439;
/** Visits of the WISE 0855 field in the archive (targets.json). */
export const WISE0855_VISITS = 17;

/** The limit of a stack of n visits, AB. */
export const stackedLimit = (n, single = D6_ONE_VISIT_AB) => single + 2.5 * Math.log10(Math.sqrt(n));

/** How far a body as bright as WISE 0855 is still seen at a limit, parsecs. */
export const reachPc = (limitAB) => WISE0855_PC * 10 ** ((limitAB - WISE0855_AB) / 5);

/** The shells drawn round the Sun: one visit, and the field's own stack. */
export function shells() {
  const stacked = stackedLimit(WISE0855_VISITS);
  return [
    { key: 'one', limit: D6_ONE_VISIT_AB, pc: reachPc(D6_ONE_VISIT_AB) },
    { key: 'stack', limit: stacked, visits: WISE0855_VISITS, pc: reachPc(stacked) },
  ];
}

/** How many times too faint Planet Nine's brightest prediction is for one visit at the best limit. */
export const planetNineShortfall = (limitAB) => 10 ** (0.4 * (PLANET_NINE_V.bright - limitAB));

export { PLANET_NINE_V, PLANET_NINE_AU, PLANET_NINE_MAX_BETA };

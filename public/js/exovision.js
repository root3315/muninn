/**
 * exovision.js — the stars with known planets, and the way to their systems
 * in ExoVision, the team's exoplanet explorer. One list and one address for
 * the site's card and the headset's.
 */
import { nearestHost } from './catalog.js';
import { deadline, CATALOG_DEADLINE_MS } from './net.js';

/** Where a star's planetary system is shown. */
export const EXOVISION_URL = 'https://exovision.mydevbox.xyz';

/** A host star is taken as the asked-for star within this: the sky's catalogue and the archive's positions differ by proper motion and rounding. */
const HOST_REACH_ARCSEC = 90;

let planetHosts = null;

/** The star with known planets nearest (ra, dec) within reach, as [ra, dec, planets, name], or null. */
export async function planetHostNear(ra, dec) {
  planetHosts ??= fetch('data/planet-hosts.json', { signal: deadline(null, CATALOG_DEADLINE_MS) })
    .then((r) => (r.ok ? r.json() : { hosts: [] }))
    .then((body) => body.hosts ?? [])
    .catch(() => { planetHosts = null; return []; });
  return nearestHost(await planetHosts, ra, dec, HOST_REACH_ARCSEC);
}

/** The address of a host's system in ExoVision, named `label`, in language `lang`. */
export function systemUrl([ra, dec, , name], label, lang) {
  const url = new URL('/system', EXOVISION_URL);
  url.search = new URLSearchParams({
    ra: ra.toFixed(5), dec: dec.toFixed(5), from: 'muninn', name: label ?? name, lang,
  }).toString();
  return url.href;
}

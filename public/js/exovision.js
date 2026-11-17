/**
 * exovision.js — the stars with known planets, and the way to their systems
 * in ExoVision, the team's exoplanet explorer. One list and one address for
 * the site's card and the headset's.
 */
import { nearestHost } from './catalog.js';
import { deadline, CATALOG_DEADLINE_MS } from './net.js';
import { fetchData } from './datafiles.js';

/** Where a star's planetary system is shown. */
export const EXOVISION_URL = 'https://exovision.mydevbox.xyz';

/** A host star is taken as the asked-for star within this: the sky's catalogue and the archive's positions differ by proper motion and rounding. */
const HOST_REACH_ARCSEC = 90;

let planetHosts = null;

/**
 * The star with known planets nearest (ra, dec) within `reach` arcseconds, as
 * [ra, dec, planets, name, letters], or null.
 */
export async function planetHostNear(ra, dec, reach = HOST_REACH_ARCSEC) {
  planetHosts ??= fetchData('data/planet-hosts.json', { signal: deadline(null, CATALOG_DEADLINE_MS) })
    .then((r) => (r.ok ? r.json() : { hosts: [] }))
    .then((body) => body.hosts ?? [])
    .catch(() => { planetHosts = null; return []; });
  return nearestHost(await planetHosts, ra, dec, reach);
}

/**
 * The address of ExoVision's own search for planets round any star: it takes
 * the star's name, or its position as "RA Dec" in degrees, fetches the
 * star's TESS (or Kepler) light curve from MAST and looks for transits in it
 * with its model. For a star with no known planets, the way to look.
 */
export function detectorUrl({ name = null, ra, dec }, lang) {
  const url = new URL('/ai-detector', EXOVISION_URL);
  const target = name ?? `${ra.toFixed(5)} ${dec >= 0 ? '+' : ''}${dec.toFixed(5)}`;
  url.search = new URLSearchParams({ target, from: 'muninn', lang }).toString();
  return url.href;
}

/** The address of a host's system in ExoVision, named `label`, in language `lang`. */
export function systemUrl([ra, dec, , name], label, lang) {
  const url = new URL('/system', EXOVISION_URL);
  url.search = new URLSearchParams({
    ra: ra.toFixed(5), dec: dec.toFixed(5), from: 'muninn', name: label ?? name, lang,
  }).toString();
  return url.href;
}

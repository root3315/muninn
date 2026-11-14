/**
 * distances.js — how far the things in a field are, from whoever measured it.
 *
 * Asked straight of the archives from the browser, never through the box:
 * Gaia DR3's geometric distances (Bailer-Jones et al. 2021, VizieR I/352),
 * from the CfA's VizieR mirror and CDS's TAP service at once, the first
 * answer taken; and SIMBAD's galaxies that have a spectroscopic redshift.
 *
 * For the fields a demonstration opens, the answers are also kept as files
 * with the site (data/vr/<key>.json, written by tools/bake-vr.mjs), so the
 * demonstration does not hang on an archive's bad day; a live answer is
 * still asked for when there is no file.
 */

import { parseVOTable } from '../votable.js';
import { parseCsv } from '../csv.js';
import { simbadTap, simbadFamily } from '../catalog.js';
import { deadline } from '../net.js';

const VIZIER_CFA = 'https://vizier.cfa.harvard.edu/viz-bin/votable';
const VIZIER_TAP = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';
const ASK_MS = 25_000;

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Bailer-Jones geometric distances in a cone: Map source_id → { r, lo, hi } in parsecs (16th–84th percentiles). */
export async function geometricDistances({ ra, dec, radiusDeg }, signal) {
  const read = (rows) => {
    const out = new Map();
    for (const r of rows) {
      const id = String(r.Source ?? '').trim();
      const rgeo = num(r.rgeo);
      if (id && rgeo) out.set(id, { r: rgeo, lo: num(r.b_rgeo) ?? rgeo, hi: num(r.B_rgeo) ?? rgeo });
    }
    return out;
  };
  const q = new URLSearchParams({
    '-source': 'I/352/gedr3dis', '-c': `${ra.toFixed(6)} ${dec >= 0 ? '+' : ''}${dec.toFixed(6)}`,
    '-c.rd': radiusDeg.toFixed(4), '-out': 'Source,rgeo,b_rgeo,B_rgeo', '-out.max': '2000',
  });
  const viaCfa = fetch(`${VIZIER_CFA}?${q}`, { signal: deadline(signal, ASK_MS) })
    .then((res) => { if (!res.ok) throw new Error(`VizieR ${res.status}`); return res.text(); })
    .then((xml) => {
      const { status, message, rows } = parseVOTable(xml);
      if (status === 'ERROR') throw new Error(message);
      return read(rows);
    });
  const adql = `SELECT Source, rgeo, b_rgeo, B_rgeo FROM "I/352/gedr3dis"
    WHERE CONTAINS(POINT('ICRS', RA_ICRS, DE_ICRS), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radiusDeg.toFixed(5)})) = 1`;
  const viaTap = fetch(`${VIZIER_TAP}?request=doQuery&lang=adql&format=csv&query=${encodeURIComponent(adql)}`, { signal: deadline(signal, ASK_MS) })
    .then((res) => { if (!res.ok) throw new Error(`VizieR TAP ${res.status}`); return res.text(); })
    .then((text) => read(parseCsv(text)));
  try {
    return await Promise.any([viaCfa, viaTap]);
  } catch (err) {
    throw err.errors?.[0] ?? err;
  }
}

/**
 * Galaxies in the field with a spectroscopic redshift (SIMBAD quality A to
 * C): [{ name, family, ra, dec, z }]. A star's radial velocity sits in the
 * same column, so only what SIMBAD calls a galaxy is kept.
 */
export async function galaxiesWithRedshift({ ra, dec, radiusDeg }, signal) {
  const body = await simbadTap(`SELECT TOP 80 main_id, otype, ra, dec, rvz_redshift FROM basic
    WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radiusDeg.toFixed(5)})) = 1
    AND rvz_redshift > 0 AND rvz_qual IN ('A', 'B', 'C') ORDER BY nbref DESC`, 'json', signal);
  return (body.data ?? [])
    .map(([name, otype, ora, odec, z]) => ({
      name: String(name).trim().replace(/\s+/g, ' ').replace(/^NAME /, ''),
      family: simbadFamily(String(otype ?? '').trim()), ra: Number(ora), dec: Number(odec), z: Number(z),
    }))
    .filter((g) => ['galaxy', 'agn', 'quasar'].includes(g.family) && Number.isFinite(g.ra) && g.z > 0);
}

/** The answers kept with the site for a demonstration field, or null. */
export async function bakedAnswers(key, signal) {
  if (!key) return null;
  try {
    const res = await fetch(`data/vr/${encodeURIComponent(key)}.json`, { signal: deadline(signal, 10_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

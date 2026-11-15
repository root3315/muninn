/**
 * bake-vr.mjs — keep the catalogue answers the headset's demonstration fields
 * need as files with the site, so the demonstration does not hang on an
 * archive's bad day.
 *
 *   node tools/bake-vr.mjs [key …]     (default: atala barnard wise0855)
 *
 * For each field, the same visits the headset reads (the site's first batch,
 * from the baked frame index), and for them:
 *
 *   gaia      Gaia DR3 in the field: a running local server's relay to IRSA,
 *             raced against the CDS and CfA VizieR mirrors
 *             (BASE, default http://127.0.0.1:5173), as the page parses it
 *   bj        Bailer-Jones geometric distances (VizieR I/352) at the CfA mirror
 *   galaxies  SIMBAD's galaxies with a spectroscopic redshift, at the CfA mirror
 *   bodies    SkyBoT's known bodies at each visit's mid-exposure
 *
 * Written to public/data/vr/<key>.json. Each answer is asked patiently (again
 * after 10, 30, 60 and 120 s while an archive is flaky), the mirrors raced;
 * one that still fails keeps what the last bake had, or is left out and the
 * page asks for it live.
 *
 *   node tools/bake-vr.mjs all        every field with a frame index
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { groupVisits, skybotCone, simbadFamily, catalogueRows } from '../public/js/catalog.js';
import { spread, VISITS_PER_BATCH } from '../public/js/visits.js';
import { parseGaiaRow, cutToCap, magLimit, searchRadius, ROW_CAP } from '../public/js/overlay.js';
import { parseVOTable } from '../public/js/votable.js';
import { parseCsv } from '../public/js/csv.js';
import { loadStamp } from '../public/js/stamp.js';
import { TangentGrid } from '../public/js/wcs.js';
import { toS3 } from '../public/js/catalog.js';
import { stackDepth } from '../public/js/depth.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const asked = process.argv.slice(2);
const WAITS_S = [10, 30, 60, 120];
const UA = { 'user-agent': 'Muninn/1.0 (NASA Space Apps 2026)' };

/* The grid the headset cuts (field.js): a 1.4 : 1 screen. */
const ASPECT = 1.4;
const gridOf = (fov) => {
  const gh = Math.min(768, Math.max(360, Math.round(((fov * 3600) / 6.15) * 2.5)));
  const gw = Math.round(gh * ASPECT);
  return { widthDeg: (fov * gw) / gh, heightDeg: fov };
};

const midExposure = (f) => (f.exptime > 0
  ? new Date((f.mjd + f.exptime / 2 / 86400 - 40587) * 86400000).toISOString().replace('Z', '')
  : f.iso);

async function json(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 80)}`);
  const body = await res.json();
  // The relay says ok: false with a 200 or a 5xx: either way not an answer.
  if (body?.ok === false) throw new Error(body.error ?? 'not ok');
  return body;
}

const pause = (sec) => new Promise((r) => { setTimeout(r, sec * 1000); });

/** `ask()` again after each wait while it fails; the last failure if it never answers. */
async function patiently(what, ask) {
  for (let k = 0; ; k += 1) {
    try {
      return await ask();
    } catch (err) {
      if (k >= WAITS_S.length) throw err;
      console.warn(`    ${what}: ${err.message}; again in ${WAITS_S[k]} s`);
      await pause(WAITS_S[k]);
    }
  }
}

/** The first of several answers; the first failure if none comes. */
async function firstOf(asks) {
  try { return await Promise.any(asks); } catch (err) { throw err.errors?.[0] ?? err; }
}

async function bake(key) {
  const targets = JSON.parse(await readFile(join(ROOT, 'public/data/targets.json'), 'utf8')).targets;
  const target = targets.find((t) => t.key === key);
  if (!target) throw new Error(`no target ${key}`);
  const index = JSON.parse(await readFile(join(ROOT, `public/data/fields/${key}.json`), 'utf8'));
  const { ra, dec } = target;
  const band = target.band ?? 'all';
  const chosen = spread(groupVisits(index.frames, { ra, dec, band }), VISITS_PER_BATCH);
  const g = gridOf(target.fov ?? 0.3);
  const radiusDeg = searchRadius(g.widthDeg, g.heightDeg);
  const out = { key, ra, dec, made: new Date().toISOString().slice(0, 10), radiusDeg };
  let before = {};
  try { before = JSON.parse(await readFile(join(ROOT, 'public/data/vr', `${key}.json`), 'utf8')); } catch { /* the first bake */ }

  // How deep one visit goes, from the detector's own noise in the same
  // visits the headset reads (field.js measure), so the number is there
  // before the headset has read a frame.
  try {
    const gh = Math.min(768, Math.max(360, Math.round((((target.fov ?? 0.3) * 3600) / 6.15) * 2.5)));
    const gw = Math.round(gh * ASPECT);
    const grid = new TangentGrid(ra, dec, ((target.fov ?? 0.3) * gw) / gh, gw, gh);
    const per = [];
    for (const f of chosen) {
      const stamp = await loadStamp(toS3(f.url), grid).catch(() => null);
      const sigma = stamp?.meta?.detectorSigma;
      if (sigma > 0) per.push({ band: f.band, sigma });
    }
    const d = per.length ? stackDepth(per) : null;
    if (d) out.depth = { single: Number(d.single.toFixed(3)), band: d.band, n: d.n };
  } catch (err) { console.warn(`  ${key}: depth: ${err.message}`); }
  if (!out.depth && before.depth) out.depth = before.depth;

  try {
    const limit = magLimit(g.heightDeg);
    // IRSA through the relay, raced against the VizieR mirrors the page also asks (CDS and CfA).
    const body = await patiently('Gaia', () => firstOf([
      json(`${BASE}/api/tap?cat=gaia&ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&r=${radiusDeg.toFixed(6)}&top=${ROW_CAP + 1}&mag=${limit.toFixed(2)}`),
      catalogueRows('gaia', { ra, dec, radiusDeg, limit, top: ROW_CAP + 1 }),
    ]));
    out.gaia = { ...cutToCap(body.rows.map(parseGaiaRow).filter(Boolean), limit), via: body.via ?? 'IRSA' };
  } catch (err) { console.warn(`  ${key}: Gaia: ${err.message}`); if (before.gaia) out.gaia = before.gaia; }

  try {
    const q = new URLSearchParams({
      '-source': 'I/352/gedr3dis', '-c': `${ra.toFixed(6)} ${dec >= 0 ? '+' : ''}${dec.toFixed(6)}`,
      '-c.rd': radiusDeg.toFixed(4), '-out': 'Source,rgeo,b_rgeo,B_rgeo', '-out.max': '2000',
      // Nearest the field's centre first, so a cut list loses its edge and not its middle.
      '-out.add': '_r', '-sort': '_r',
    });
    const viaCfa = async () => {
      const res = await fetch(`https://vizier.cfa.harvard.edu/viz-bin/votable?${q}`, { headers: UA, signal: AbortSignal.timeout(90_000) });
      const { status, message, rows: got } = parseVOTable(await res.text());
      if (status === 'ERROR' || !res.ok) throw new Error(message || `VizieR ${res.status}`);
      return got;
    };
    const viaCds = async () => {
      const adql = `SELECT TOP 2000 Source, rgeo, b_rgeo, B_rgeo,
        DISTANCE(POINT('ICRS', RA_ICRS, DE_ICRS), POINT('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)})) AS d FROM "I/352/gedr3dis"
        WHERE CONTAINS(POINT('ICRS', RA_ICRS, DE_ICRS), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radiusDeg.toFixed(5)})) = 1 ORDER BY d`;
      const res = await fetch(`https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync?${new URLSearchParams({ request: 'doQuery', lang: 'adql', format: 'csv', query: adql })}`, { headers: UA, signal: AbortSignal.timeout(90_000) });
      const text = await res.text();
      if (!res.ok || text.trimStart().startsWith('<')) throw new Error(`VizieR TAP ${res.status}`);
      return parseCsv(text);
    };
    const rows = await patiently('Bailer-Jones', () => firstOf([viaCfa(), viaCds()]));
    out.bj = rows.filter((r) => Number(r.rgeo) > 0)
      .map((r) => [String(r.Source).trim(), Number(r.rgeo), Number(r.b_rgeo) || Number(r.rgeo), Number(r.B_rgeo) || Number(r.rgeo)]);
  } catch (err) { console.warn(`  ${key}: Bailer-Jones: ${err.message}`); if (before.bj) out.bj = before.bj; }

  try {
    const adql = `SELECT TOP 80 main_id, otype, ra, dec, rvz_redshift FROM basic
      WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radiusDeg.toFixed(5)})) = 1
      AND rvz_redshift > 0 AND rvz_qual IN ('A', 'B', 'C') ORDER BY nbref DESC`;
    const at = (host) => json(`https://${host}/simbad/sim-tap/sync?request=doQuery&lang=adql&format=json&query=${encodeURIComponent(adql)}`);
    const body = await patiently('SIMBAD', () => firstOf([at('simbad.cfa.harvard.edu'), at('simbad.cds.unistra.fr')]));
    out.galaxies = (body.data ?? [])
      .map(([name, otype, ora, odec, z]) => ({
        name: String(name).trim().replace(/\s+/g, ' ').replace(/^NAME /, ''),
        family: simbadFamily(String(otype ?? '').trim()), ra: Number(ora), dec: Number(odec), z: Number(z),
      }))
      .filter((x) => ['galaxy', 'agn', 'quasar'].includes(x.family) && Number.isFinite(x.ra) && x.z > 0);
  } catch (err) { console.warn(`  ${key}: SIMBAD: ${err.message}`); if (before.galaxies) out.galaxies = before.galaxies; }

  out.bodies = {};
  for (const f of chosen) {
    try {
      // The headset's cone: 0.8 of the field's longer side, at least 0.03°.
      out.bodies[f.obsId] = await patiently(`SkyBoT ${f.obsId}`, () => skybotCone({ ra, dec, radiusDeg: Math.max(0.03, g.widthDeg * 0.8), iso: midExposure(f) }));
    } catch (err) {
      console.warn(`  ${key}: SkyBoT ${f.obsId}: ${err.message}`);
      if (before.bodies?.[f.obsId]) out.bodies[f.obsId] = before.bodies[f.obsId];
    }
  }

  const dir = join(ROOT, 'public/data/vr');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${key}.json`), `${JSON.stringify(out)}\n`);
  console.log(`  ${key}: depth ${out.depth?.single ?? '—'}, gaia ${out.gaia?.rows.length ?? '—'}, bj ${out.bj?.length ?? '—'}, galaxies ${out.galaxies?.length ?? '—'}, bodies at ${Object.keys(out.bodies).length} of ${chosen.length} visits`);
}

// "all": every field the site keeps a frame index for.
const keys = asked.length === 1 && asked[0] === 'all'
  ? (await readdir(join(ROOT, 'public/data/fields'))).filter((n) => n.endsWith('.json') && n !== 'index.json').map((n) => n.slice(0, -5))
  : asked.length ? asked : ['atala', 'barnard', 'wise0855'];

for (const key of keys) {
  try { await bake(key); } catch (err) { console.error(`  ${key}: ${err.message}`); }
}

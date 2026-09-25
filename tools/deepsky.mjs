/**
 * deepsky.mjs — the things worth opening that do not move.
 *
 * The entry screen only marks what can actually be opened. Planets are computed
 * for the moment you look; everything else has a fixed place, and the obvious
 * fixed list is Messier's — 110 objects, every one of them something a person
 * has heard of or would want to see, and every one of them inside SPHEREx's
 * all-sky coverage.
 *
 * Positions, types and magnitudes come from SIMBAD, queried by ADQL, so they
 * are the same numbers an astronomer would quote. Nothing is typed in by hand
 * except the common names, and those only where the identification is certain.
 *
 *     node tools/deepsky.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data', 'sky', 'deepsky.json');

const TAP = 'https://simbad.u-strasbg.fr/simbad/sim-tap/sync';
const ADQL = `SELECT i.id AS mid, b.main_id, b.ra, b.dec, b.otype_txt, f.V
  FROM basic AS b
  JOIN ident AS i ON i.oidref = b.oid
  LEFT JOIN allfluxes AS f ON f.oidref = b.oid
  WHERE i.id LIKE 'M %' AND b.ra IS NOT NULL
  ORDER BY mid`;

/** SIMBAD's object types, collapsed to the handful a viewer cares about. */
const KIND = {
  SNR: 'remnant', HII: 'nebula', RNe: 'nebula', GNe: 'nebula', DNe: 'nebula',
  ISM: 'nebula', Cld: 'nebula', PN: 'planetary',
  GlC: 'globular', OpC: 'open', 'Cl*': 'open', 'As*': 'asterism',
  G: 'galaxy', GiG: 'galaxy', GiP: 'galaxy', AGN: 'galaxy', SyG: 'galaxy',
  Sy1: 'galaxy', Sy2: 'galaxy', rG: 'galaxy', EmG: 'galaxy', SBG: 'galaxy',
  H2G: 'galaxy', LSB: 'galaxy', IG: 'galaxy', BiC: 'galaxy', LIN: 'galaxy',
  'Sy*': 'galaxy', GrG: 'galaxy', ClG: 'galaxy',
  '*': 'star', '**': 'star', 'V*': 'star',
};

/**
 * Common names, by Messier number.
 *
 * Only the ones in general use and only where there is no ambiguity about which
 * object carries the name — a wrong name is worse than a catalogue number.
 */
const NAMES = {
  1: 'Crab Nebula', 6: 'Butterfly Cluster', 7: 'Ptolemy Cluster',
  8: 'Lagoon Nebula', 11: 'Wild Duck Cluster', 13: 'Hercules Cluster',
  16: 'Eagle Nebula', 17: 'Omega Nebula', 20: 'Trifid Nebula',
  24: 'Sagittarius Star Cloud', 27: 'Dumbbell Nebula', 31: 'Andromeda Galaxy',
  33: 'Triangulum Galaxy', 42: 'Orion Nebula', 43: "De Mairan's Nebula",
  44: 'Beehive Cluster', 45: 'Pleiades', 51: 'Whirlpool Galaxy',
  57: 'Ring Nebula', 63: 'Sunflower Galaxy', 64: 'Black Eye Galaxy',
  76: 'Little Dumbbell Nebula', 81: "Bode's Galaxy", 82: 'Cigar Galaxy',
  83: 'Southern Pinwheel', 87: 'Virgo A', 97: 'Owl Nebula',
  101: 'Pinwheel Galaxy', 104: 'Sombrero Galaxy',
};

const main = async () => {
  process.stdout.write('Asking SIMBAD for the Messier catalogue…\n');
  const body = new URLSearchParams({
    request: 'doQuery', lang: 'ADQL', format: 'tsv', query: ADQL,
  });
  const res = await fetch(TAP, { method: 'POST', body });
  if (!res.ok) throw new Error(`SIMBAD answered ${res.status}`);
  const text = await res.text();

  const objects = [];
  const seen = new Set();
  for (const line of text.split('\n').slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split('\t').map((c) => c.replace(/^"|"$/g, '').trim());
    const m = /^M\s*(\d+)$/.exec(cols[0]);
    if (!m) continue;
    const n = Number(m[1]);
    if (seen.has(n)) continue;
    const ra = Number(cols[2]);
    const dec = Number(cols[3]);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
    seen.add(n);
    const mag = Number(cols[5]);
    objects.push({
      id: `M${n}`,
      n,
      name: NAMES[n] ?? '',
      ra: Number(ra.toFixed(4)),
      dec: Number(dec.toFixed(4)),
      kind: KIND[cols[4]] ?? 'other',
      otype: cols[4],
      mag: Number.isFinite(mag) ? Number(mag.toFixed(2)) : null,
    });
  }
  objects.sort((a, b) => a.n - b.n);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    source: 'SIMBAD (CDS, Strasbourg), queried by ADQL',
    fetched: new Date().toISOString().slice(0, 10),
    epoch: 'ICRS / J2000',
    count: objects.length,
    objects,
  }), 'utf8');

  const kinds = objects.reduce((acc, o) => { acc[o.kind] = (acc[o.kind] ?? 0) + 1; return acc; }, {});
  process.stdout.write(
    `${objects.length} objects, ${objects.filter((o) => o.name).length} with a common name\n`
    + `${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' · ')}\n`
    + `→ ${OUT}\n`,
  );
};

main().catch((err) => { process.stderr.write(`${err.message}\n`); process.exitCode = 1; });

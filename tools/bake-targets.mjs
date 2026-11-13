/**
 * bake-targets.mjs — verifies the opening fields and pre-resolves their frame index.
 *
 * Two jobs:
 *   1. Ask IRSA how many separate SPHEREx visits each candidate field really has,
 *      so the numbers shown beside a preset are the archive's, not a guess.
 *   2. Write the frame index to data/fields/<key>.json. The server serves those
 *      instantly, so the first field a visitor opens does not wait on a cone
 *      search — and the demo still works when IRSA is slow or down.
 *
 * The deep fields are the reason this exists: a cone at the North Ecliptic Pole
 * returns 25 000 rows and 54 MB and takes four minutes unless MAXREC caps it.
 *
 *   node tools/bake-targets.mjs              every field
 *   node tools/bake-targets.mjs wise0855     only the fields named; the rest
 *                                            of targets.json is kept as it is
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { parseVOTable } from '../public/js/votable.js';
import { frameFromRow, groupVisits } from '../public/js/catalog.js';
import { COLLECTIONS } from '../public/js/release.js';

const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const MAXREC = 500;
const RADIUS = 0.006;
const DATA = new URL('../public/data/', import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function queryCollection(collection, ra, dec) {
  const pos = encodeURIComponent(`circle ${ra} ${dec} ${RADIUS}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(`${SIA}?COLLECTION=${collection}&POS=${pos}&MAXREC=${MAXREC}`, { signal: ctrl.signal });
    if (!res.ok) return { rows: [], truncated: false, error: `HTTP ${res.status}` };
    const { status, message, rows } = parseVOTable(await res.text());
    if (status === 'ERROR') return { rows: [], truncated: false, error: message };
    return { rows, truncated: status === 'OVERFLOW', error: null };
  } catch (err) {
    // Reported, never swallowed — an earlier version hid timeouts and produced
    // a sky survey that appeared to have no coverage over half the ecliptic.
    return { rows: [], truncated: false, error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function indexField(ra, dec) {
  const results = await Promise.all(COLLECTIONS.map((c) => queryCollection(c, ra, dec)));
  const errors = [];
  const seen = new Set();
  const frames = [];
  let truncated = false;

  results.forEach((r, i) => {
    if (r.error) errors.push(`${COLLECTIONS[i]}: ${r.error}`);
    truncated = truncated || r.truncated;
    for (const row of r.rows) {
      if (row.dataproduct_subtype !== 'science') continue;
      if (Number(row.calib_level) < 2) continue;
      const f = frameFromRow(row);
      if (!f?.url || seen.has(f.url)) continue;
      seen.add(f.url);
      frames.push(f);
    }
  });

  frames.sort((a, b) => a.mjd - b.mjd);
  return { frames, truncated, errors };
}

/**
 * Fields chosen because the archive supports them, not because they sound good.
 * The Atala field was found by tools/find-mover.mjs and checked photometrically
 * by tools/verify-mover.mjs — see the numbers in README.md.
 */
const FIELDS = [
  {
    key: 'atala', name: '(152) Atala · 25 Dec 2025',
    ra: 13.4194, dec: 3.8459, fov: 0.3, band: 'D2',
    why: {
      en: 'An asteroid sits dead centre on one visit only.',
      ru: 'Астероид стоит в центре ровно в одном заходе.',
    },
  },
  {
    key: 'nep', name: 'North Ecliptic Pole',
    ra: 269.7, dec: 66.56, fov: 0.3, band: 'all',
    why: {
      en: 'The most-visited patch of sky there is.',
      ru: 'Самый посещаемый кусок неба.',
    },
  },
  {
    key: 'sep', name: 'South Ecliptic Pole',
    ra: 90.0, dec: -66.56, fov: 0.3, band: 'all',
    why: {
      en: 'The southern deep field, same cadence.',
      ru: 'Южное глубокое поле, тот же темп.',
    },
  },
  {
    key: 'm51', name: 'M51 · Whirlpool',
    ra: 202.4696, dec: 47.1953, fov: 0.3, band: 'all',
    why: {
      en: 'A control field — nothing here should move.',
      ru: 'Контрольное поле — здесь ничто не движется.',
    },
  },
  {
    key: 'm42', name: 'M42 · Orion Nebula',
    ra: 83.8221, dec: -5.3911, fov: 0.3, band: 'all',
    why: {
      en: 'Bright and structured. Lower the white point.',
      ru: 'Ярко и структурно. Опустите точку белого.',
    },
  },
  // The five fields the challenge itself names as the test of a tool like this.
  // High-proper-motion stars are centred where they were at the mean date of
  // their SPHEREx visits in the opening band, not at J2000: Barnard's Star
  // has moved four and a half arcminutes since then. `target` is the object
  // itself, a catalogue position at its own epoch and a proper motion in mas
  // a year, which the page carries to each visit's date to mark it.
  {
    key: 'barnard', group: 'challenge', name: "Barnard's Star",
    // Gaia DR3 carried to 2026: within 3" of where it was at the mean date of its D2 visits.
    ra: 269.4463, dec: 4.7680, fov: 0.3, band: 'D2',
    target: {
      ra: 269.44850253, dec: 4.73942005, epoch: 2016.0, pmRA: -801.551, pmDE: 10362.394,
      ref: 'Gaia DR3 4472832130942575872',
    },
    why: {
      en: 'The fastest star in the sky, 10.4″ a year: under two detector pixels across this baseline.',
      ru: 'Самая быстрая звезда неба, 10,4″ в год: меньше двух пикселей детектора за этот срок.',
    },
  },
  {
    key: 'epsindib', group: 'challenge', name: 'ε Indi B',
    // Gaia DR3 carried to 2026: within 3" of where it was at the mean date of its D2 visits.
    ra: 331.0967, dec: -56.8012, fov: 0.3, band: 'D2',
    target: {
      ra: 331.07645260, dec: -56.79381207, epoch: 2016.0, pmRA: 3981.977, pmDE: -2466.832,
      ref: 'Gaia DR3 6412596012146801152',
    },
    why: {
      en: 'A pair of brown dwarfs; their star, ε Indi A, is in the same field.',
      ru: 'Пара коричневых карликов; их звезда ε Indi A в том же поле.',
    },
  },
  {
    // Found by Luhman (2014, ApJ 786, L18) in WISE multi-epoch data. The
    // challenge's 08h55m10.83s -07°14'42.5" (133.7951, -7.2452) is its WISE
    // designation, a position of about 2010.6. Position at epoch 2000.0 and
    // motion (-8123.7, +673.2) mas a year from Kirkpatrick et al. (2021,
    // ApJS 253, 7), as SIMBAD gives them; carried to 2026.12, the mean date
    // of its D6 visits, that is 2.1' west of the challenge's coordinates.
    key: 'wise0855', group: 'challenge', name: 'WISE 0855−0714',
    ra: 133.7595, dec: -7.2422, fov: 0.3, band: 'D6',
    target: {
      ra: 133.81890825, dec: -7.24704800, epoch: 2000.0, pmRA: -8123.7, pmDE: 673.2,
      ref: 'Kirkpatrick et al. 2021, ApJS 253, 7',
    },
    why: {
      en: 'The coldest known brown dwarf, bright only near 4.6 µm, so the field opens in D6. Centred where it was in 2026: 2.1′ west of the challenge’s 08h55m10.83s −07°14′42.5″, its 2010 WISE position.',
      ru: 'Самый холодный известный коричневый карлик, ярок только около 4,6 µm, поэтому поле открывается в D6. Центр там, где он был в 2026 году: на 2,1′ западнее координат задания 08h55m10.83s −07°14′42.5″, его положения по WISE 2010 года.',
    },
  },
  {
    key: 'rwaur', group: 'challenge', name: 'RW Aurigae',
    ra: 76.9564, dec: 30.4014, fov: 0.3, band: 'D2',
    // The A-B pair is 1.5" across, inside one SPHEREx pixel.
    target: {
      ra: 76.95654431, dec: 30.40131615, epoch: 2016.0, pmRA: 4.906, pmDE: -24.578,
      ref: 'Gaia DR3 156430817820015232',
    },
    why: {
      en: 'A young variable star. Use shared scaling: per-visit stretching hides a brightness change.',
      ru: 'Молодая переменная звезда. Включите общую шкалу: своя шкала у каждого кадра прячет изменение яркости.',
    },
  },
  {
    key: 'rdra', group: 'challenge', name: 'R Draconis',
    ra: 248.1675, dec: 66.7550, fov: 0.3, band: 'D3',
    target: {
      ra: 248.16737837, dec: 66.75500675, epoch: 2016.0, pmRA: -20.643, pmDE: 6.149,
      ref: 'Gaia DR3 1648328016354496384',
    },
    why: {
      en: 'A Mira variable near the north ecliptic pole, seen on more dates than almost anything.',
      ru: 'Мирида у северного полюса эклиптики: снята в большем числе дат, чем почти что угодно.',
    },
  },
];

await mkdir(new URL('fields/', DATA), { recursive: true });

// Named on the command line, only those fields are asked about again; every
// other entry of targets.json keeps its counts, so one moved field costs one query.
const only = process.argv.slice(2);
const unknown = only.filter((k) => !FIELDS.some((f) => f.key === k));
if (unknown.length) throw new Error(`No such field: ${unknown.join(', ')}`);
const kept = only.length ? JSON.parse(await readFile(new URL('targets.json', DATA), 'utf8')).targets : [];

const targets = [];
console.log('Indexing opening fields against IRSA\n');

for (const f of FIELDS) {
  if (only.length && !only.includes(f.key)) {
    const old = kept.find((t) => t.key === f.key);
    if (old) targets.push({ ...old, ...(f.target ? { target: f.target } : {}), why: f.why });
    continue;
  }
  const t0 = Date.now();
  const { frames, truncated, errors } = await indexField(f.ra, f.dec);
  const visits = groupVisits(frames, { ra: f.ra, dec: f.dec, band: f.band });
  const mjds = visits.map((v) => v.mjd);
  const spanDays = visits.length > 1 ? Math.round(Math.max(...mjds) - Math.min(...mjds)) : 0;

  console.log(`  ${f.key.padEnd(6)} ${String(frames.length).padStart(4)} frames · `
    + `${String(visits.length).padStart(3)} visits in ${f.band} · ${String(spanDays).padStart(3)} d span · `
    + `${((Date.now() - t0) / 1000).toFixed(1)} s${truncated ? ' · TRUNCATED' : ''}`);
  for (const e of errors) console.log(`         ! ${e}`);

  if (!frames.length) {
    console.log('         skipped — the archive returned nothing for this position');
    continue;
  }

  await writeFile(new URL(`fields/${f.key}.json`, DATA),
    `${JSON.stringify({ ra: f.ra, dec: f.dec, radius: RADIUS, truncated, frames })}\n`, 'utf8');

  targets.push({
    key: f.key, ...(f.group ? { group: f.group } : {}), name: f.name, ra: f.ra, dec: f.dec, fov: f.fov, band: f.band,
    ...(f.target ? { target: f.target } : {}), why: f.why, visits: visits.length, spanDays, truncated,
  });
  await sleep(500);
}

await writeFile(new URL('fields/index.json', DATA), `${JSON.stringify(
  targets.map((t) => ({ key: t.key, ra: t.ra, dec: t.dec })))}
`, 'utf8');

await writeFile(new URL('targets.json', DATA), `${JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  note: 'Visit counts come from IRSA SIA2 on the generated date. Frame indexes for these fields live in data/fields/ and are served without a round trip.',
  targets,
}, null, 2)}\n`, 'utf8');

console.log(`\nwrote ${targets.length} targets and their frame indexes`);

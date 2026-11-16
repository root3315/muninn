#!/usr/bin/env node
/**
 * build-fly-stars.mjs — the Sun's neighbourhood in three dimensions, for fly.html.
 *
 * Every star of the Hipparcos new reduction (van Leeuwen 2007, VizieR I/311)
 * whose parallax is measured to better than 20 %, placed at the distance its
 * parallax gives: about 70 000 stars out to roughly a kiloparsec. Nothing is
 * placed by guess; a star with a worse parallax is left out, not put somewhere.
 *
 *   public/data/fly/stars.bin   Float32 x, y, z per star in parsecs (ICRS
 *                               axes, the Sun at 0), every star's; then
 *                               Int16 absolute Hipparcos magnitude × 100 and
 *                               B−V × 1000 per star. Positions are full
 *                               floats: the autopilot stops a few hundredths
 *                               of a parsec from a star, and a tenth of a
 *                               parsec of rounding put the star beside its
 *                               own label.
 *   public/data/fly/named.json  the stars and targets the page names, each
 *                               with its position in parsecs
 *
 *   node tools/build-fly-stars.mjs
 *
 * Asks the VizieR mirror at the CfA, which answered while the one at CDS did not.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data', 'fly');
const ASU = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=I/311/hip2'
  + '&-out=HIP&-out=RArad&-out=DErad&-out=Plx&-out=e_Plx&-out=Hpmag&-out=B-V&-out.max=unlimited&Plx=%3E0';
/** A parallax good to 20 %: its distance is a distance. */
const MIN_PLX_SNR = 5;
const DEG = Math.PI / 180;

/** The stars the page names, by Hipparcos number. */
const NAMED = [
  [32349, 'Sirius', 'Сириус'], [30438, 'Canopus', 'Канопус'], [71683, 'α Centauri A', 'α Центавра A'],
  [70890, 'Proxima Centauri', 'Проксима Центавра'], [69673, 'Arcturus', 'Арктур'], [91262, 'Vega', 'Вега'],
  [24608, 'Capella', 'Капелла'], [24436, 'Rigel', 'Ригель'], [37279, 'Procyon', 'Процион'],
  [27989, 'Betelgeuse', 'Бетельгейзе'], [97649, 'Altair', 'Альтаир'], [21421, 'Aldebaran', 'Альдебаран'],
  [80763, 'Antares', 'Антарес'], [65474, 'Spica', 'Спика'], [37826, 'Pollux', 'Поллукс'],
  [102098, 'Deneb', 'Денеб'], [11767, 'Polaris', 'Полярная'], [113368, 'Fomalhaut', 'Фомальгаут'],
  [17702, 'Alcyone (Pleiades)', 'Альциона (Плеяды)'], [54035, 'Lalande 21185', 'Лаланд 21185'],
  [16537, 'ε Eridani', 'ε Эридана'], [3829, 'van Maanen’s Star', 'Звезда ван Маанена'],
  [87937, 'Barnard’s Star', 'Звезда Барнарда'], [108870, 'ε Indi (with B)', 'ε Индейца (с B)'],
];

const vec = (ra, dec, pc) => [
  pc * Math.cos(dec * DEG) * Math.cos(ra * DEG),
  pc * Math.cos(dec * DEG) * Math.sin(ra * DEG),
  pc * Math.sin(dec * DEG),
];

const res = await fetch(ASU, { signal: AbortSignal.timeout(300_000) });
if (!res.ok) throw new Error(`VizieR: HTTP ${res.status}`);
const rows = (await res.text()).split('\n').filter((l) => /^\s*\d/.test(l)).map((l) => l.split('\t').map((s) => s.trim()));

const positions = [];
const looks = [];
const byHip = new Map();
for (const [hip, ra, dec, plx, ePlx, hp, bv] of rows) {
  const p = Number(plx);
  const e = Number(ePlx);
  if (!(p > 0) || !(e > 0) || p < MIN_PLX_SNR * e) continue;
  const pc = 1000 / p;
  // The catalogue's RArad and DErad columns are in degrees, whatever their names say.
  const xyz = vec(Number(ra), Number(dec), pc);
  const absMag = Number(hp) + 5 * Math.log10(p / 100);
  const colour = bv === '' ? 0.65 : Number(bv);
  positions.push(...xyz);
  looks.push(Math.round(absMag * 100), Math.round(colour * 1000));
  byHip.set(Number(hip), { xyz, absMag, colour });
}

const named = [{ key: 'sun', en: 'Sun', ru: 'Солнце', pos: [0, 0, 0], absMag: 4.83, bv: 0.65, ref: 'IAU 2015' }];
for (const [hip, en, ru] of NAMED) {
  const s = byHip.get(hip);
  if (!s) continue;
  named.push({ key: `hip${hip}`, en, ru, pos: s.xyz.map((c) => +c.toFixed(4)), absMag: +s.absMag.toFixed(2), bv: s.colour, ref: `HIP ${hip}` });
}
// The challenge's own targets, at the parallaxes the site already cites.
const { targets } = JSON.parse(await readFile(join(ROOT, 'public', 'data', 'targets.json'), 'utf8'));
for (const t of targets) {
  const plx = t.target?.plx;
  if (!(plx > 0)) continue;
  named.push({
    key: t.key, en: t.name, ru: t.name, target: true,
    pos: vec(t.target.ra, t.target.dec, 1000 / plx).map((c) => +c.toFixed(4)),
    ref: t.target.ref,
  });
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'stars.bin'), Buffer.concat([
  Buffer.from(new Float32Array(positions).buffer), Buffer.from(new Int16Array(looks).buffer),
]));
await writeFile(join(OUT, 'named.json'), `${JSON.stringify({
  source: 'Hipparcos new reduction (van Leeuwen 2007, VizieR I/311), parallax better than 20 %',
  count: positions.length / 3,
  named,
})}\n`);
console.log(`${positions.length / 3} stars, ${named.length} named`);

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
 *                               B−V × 1000 per star; then Int32 Hipparcos
 *                               number per star. Positions are full
 *                               floats: the autopilot stops a few hundredths
 *                               of a parsec from a star, and a tenth of a
 *                               parsec of rounding put the star beside its
 *                               own label.
 *   public/data/fly/named.json  the stars and targets the page names, each
 *                               with its position in parsecs, its absolute
 *                               Hipparcos magnitude (absHp) and, where the
 *                               Hipparcos main catalogue has a ground-based
 *                               V, that V as seen from the Earth (v)
 *
 * The magnitudes are Hipparcos's own band, Hp, not Johnson V: the page turns
 * them into V by the star's colour (fly/stars.js, vFromHp). The brightest
 * stars saturated Hipparcos's detector — Sirius is Hp −1.09, V −1.44 — so the
 * stars the page names carry their measured V as well.
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
/** The Hipparcos main catalogue (ESA 1997, I/239): V and where it came from, G for ground-based. */
const MAIN = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=I/239/hip_main'
  + '&-out=HIP&-out=Vmag&-out=r_Vmag&-out.max=unlimited';
/** A parallax good to 20 %: its distance is a distance. */
const MIN_PLX_SNR = 5;
const DEG = Math.PI / 180;

/**
 * The stars the page names, by Hipparcos number, with their radii in solar
 * radii as measured (interferometry, eclipses, asteroseismology; rounded).
 * Every other star's radius is estimated from its brightness and colour.
 */
const NAMED = [
  [32349, 'Sirius', 'Сириус', 1.711], [30438, 'Canopus', 'Канопус', 71], [71683, 'α Centauri A', 'α Центавра A', 1.223],
  [70890, 'Proxima Centauri', 'Проксима Центавра', 0.154], [69673, 'Arcturus', 'Арктур', 25.4], [91262, 'Vega', 'Вега', 2.5],
  [24608, 'Capella', 'Капелла', 12.0], [24436, 'Rigel', 'Ригель', 78.9], [37279, 'Procyon', 'Процион', 2.05],
  [27989, 'Betelgeuse', 'Бетельгейзе', 764], [97649, 'Altair', 'Альтаир', 1.8], [21421, 'Aldebaran', 'Альдебаран', 45.1],
  [80763, 'Antares', 'Антарес', 680], [65474, 'Spica', 'Спика', 7.5], [37826, 'Pollux', 'Поллукс', 8.8],
  [102098, 'Deneb', 'Денеб', 203], [11767, 'Polaris', 'Полярная', 37.5], [113368, 'Fomalhaut', 'Фомальгаут', 1.84],
  [17702, 'Alcyone (Pleiades)', 'Альциона (Плеяды)', 9.3], [54035, 'Lalande 21185', 'Лаланд 21185', 0.39],
  [16537, 'ε Eridani', 'ε Эридана', 0.735], [3829, 'van Maanen’s Star', 'Звезда ван Маанена', 0.011],
  [87937, 'Barnard’s Star', 'Звезда Барнарда', 0.187], [108870, 'ε Indi (with B)', 'ε Индейца (с B)', 0.71],
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
const hips = [];
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
  hips.push(Number(hip));
  byHip.set(Number(hip), { xyz, absMag, colour });
}

const mainRes = await fetch(MAIN, { signal: AbortSignal.timeout(300_000) });
if (!mainRes.ok) throw new Error(`VizieR I/239: HTTP ${mainRes.status}`);
const groundV = new Map();
for (const l of (await mainRes.text()).split('\n')) {
  const [hip, v, from] = l.split('\t').map((x) => x.trim());
  if (/^\d+$/.test(hip ?? '') && from === 'G' && v !== '') groundV.set(Number(hip), Number(v));
}

const named = [{ key: 'sun', en: 'Sun', ru: 'Солнце', pos: [0, 0, 0], absV: 4.83, bv: 0.65, radius: 1, ref: 'IAU 2015' }];
for (const [hip, en, ru, radius] of NAMED) {
  const s = byHip.get(hip);
  if (!s) continue;
  const v = groundV.get(hip);
  named.push({
    key: `hip${hip}`, hip, en, ru, radius, pos: s.xyz.map((c) => +c.toFixed(4)), absHp: +s.absMag.toFixed(2),
    ...(Number.isFinite(v) ? { v } : {}), bv: s.colour, ref: `HIP ${hip}`,
  });
}
// The challenge's own targets, at the parallaxes the site already cites.
const { targets } = JSON.parse(await readFile(join(ROOT, 'public', 'data', 'targets.json'), 'utf8'));
for (const t of targets) {
  const plx = t.target?.plx;
  if (!(plx > 0)) continue;
  named.push({
    // A brown dwarf is about Jupiter's size whatever its mass: a tenth of the Sun's.
    key: t.key, en: t.name, ru: t.name, target: true, radius: 0.1,
    pos: vec(t.target.ra, t.target.dec, 1000 / plx).map((c) => +c.toFixed(4)),
    ref: t.target.ref,
  });
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'stars.bin'), Buffer.concat([
  Buffer.from(new Float32Array(positions).buffer), Buffer.from(new Int16Array(looks).buffer),
  Buffer.from(new Int32Array(hips).buffer),
]));
await writeFile(join(OUT, 'named.json'), `${JSON.stringify({
  source: 'Hipparcos new reduction (van Leeuwen 2007, VizieR I/311), parallax better than 20 %',
  count: positions.length / 3,
  named,
})}\n`);
console.log(`${positions.length / 3} stars, ${named.length} named`);

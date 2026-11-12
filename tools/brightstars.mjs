/**
 * brightstars.mjs — the naked-eye sky, from the catalogue astronomers use.
 *
 * The entry screen is a picture of the real sky, so the stars in it have to be
 * the real stars. This pulls the Bright Star Catalogue (Hoffleit & Warren 1991,
 * VizieR V/50) down to visual magnitude 6.0 — which is the naked-eye limit under
 * a dark sky, and therefore exactly the set of stars a person would see — and
 * writes it out as the compact table the page reads.
 *
 * Nothing is invented here and nothing is filtered for looks: every star the
 * catalogue lists above the limit goes in, with its own position, magnitude and
 * colour index. The constellations come out right because they are the real
 * ones, not because anyone drew them.
 *
 *     node tools/brightstars.mjs
 *
 * Re-run only to refresh; the output is committed so the page never depends on
 * a third-party service being up.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data', 'sky', 'stars.json');

const LIMIT_VMAG = 6.0;
const SOURCE = 'V/50/catalog';
const URL = `/viz-bin/asu-tsv?-source=${SOURCE}`
  + '&-out=RAJ2000,DEJ2000,Vmag,B-V,Name'
  + '&-out.max=9000'
  + `&Vmag=%3C${LIMIT_VMAG}`
  + '&-sort=Vmag';

const FAINT_VMAG = 7.0;
const FAINT_SOURCE = 'I/239/hip_main';
const FAINT_URL = `/viz-bin/asu-tsv?-source=${FAINT_SOURCE}`
  + '&-out=_RAJ2000,_DEJ2000,Vmag,B-V&-oc.form=dec&-out.max=20000'
  + `&Vmag=${LIMIT_VMAG}..${FAINT_VMAG}&-sort=Vmag`;

/** VizieR at CDS, then its mirror at CfA: the same catalogues, either will do. */
const HOSTS = ['https://vizier.cds.unistra.fr', 'https://vizier.cfa.harvard.edu'];
async function askVizier(path) {
  let last;
  for (const host of HOSTS) {
    try {
      const res = await fetch(host + path, { headers: { accept: 'text/tab-separated-values' } });
      if (res.ok) return res.text();
      last = new Error(`${host} answered ${res.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** Bayer letters as the catalogue abbreviates them. */
const GREEK = {
  Alp: 'α', Bet: 'β', Gam: 'γ', Del: 'δ', Eps: 'ε', Zet: 'ζ', Eta: 'η', The: 'θ',
  Iot: 'ι', Kap: 'κ', Lam: 'λ', Mu: 'μ', Nu: 'ν', Xi: 'ξ', Omi: 'ο', Pi: 'π',
  Rho: 'ρ', Sig: 'σ', Tau: 'τ', Ups: 'υ', Phi: 'φ', Chi: 'χ', Psi: 'ψ', Ome: 'ω',
};

/**
 * Proper names, keyed by the catalogue's own Bayer designation.
 *
 * Only names in common use and only where the identification is unambiguous —
 * a wrong name on a star is worse than no name, and the Bayer designation is
 * already a real answer to "what is that".
 */
const PROPER = {
  // Doubles carry a numbered Bayer letter in the catalogue, so the bright
  // component needs its own key or the name never finds it.
  'Alp1Cru': 'Acrux', 'Alp2Cen': 'Toliman',
  'Alp CMa': 'Sirius', 'Alp Car': 'Canopus', 'Alp Boo': 'Arcturus',
  'Alp1Cen': 'Rigil Kentaurus', 'Alp Lyr': 'Vega', 'Alp Aur': 'Capella',
  'Bet Ori': 'Rigel', 'Alp CMi': 'Procyon', 'Alp Eri': 'Achernar',
  'Alp Ori': 'Betelgeuse', 'Bet Cen': 'Hadar', 'Alp Aql': 'Altair',
  'Alp Tau': 'Aldebaran', 'Alp Vir': 'Spica', 'Alp Sco': 'Antares',
  'Bet Gem': 'Pollux', 'Alp PsA': 'Fomalhaut', 'Alp Cyg': 'Deneb',
  'Bet Cru': 'Mimosa', 'Alp Cru': 'Acrux', 'Alp Leo': 'Regulus',
  'Eps CMa': 'Adhara', 'Alp Gem': 'Castor', 'Gam Cru': 'Gacrux',
  'Lam Sco': 'Shaula', 'Gam Ori': 'Bellatrix', 'Bet Tau': 'Elnath',
  'Bet Car': 'Miaplacidus', 'Eps Ori': 'Alnilam', 'Alp Gru': 'Alnair',
  'Zet Ori': 'Alnitak', 'Eps UMa': 'Alioth', 'Alp UMa': 'Dubhe',
  'Eta UMa': 'Alkaid', 'Del CMa': 'Wezen', 'Alp Per': 'Mirfak',
  'Eps Sgr': 'Kaus Australis', 'Alp UMi': 'Polaris', 'Bet Aur': 'Menkalinan',
  'Del Ori': 'Mintaka', 'Alp Hya': 'Alphard', 'Alp Ari': 'Hamal',
  'Bet And': 'Mirach', 'Alp And': 'Alpheratz', 'Bet Per': 'Algol',
  'Alp Oph': 'Rasalhague', 'Eta Oph': 'Sabik', 'Bet UMi': 'Kochab',
  'Alp Cas': 'Schedar', 'Bet Cas': 'Caph', 'Alp Cep': 'Alderamin',
  'Alp Peg': 'Markab', 'Bet Peg': 'Scheat', 'Gam Peg': 'Algenib',
  'Eps Peg': 'Enif', 'Bet Lib': 'Zubeneschamali', 'Alp Cet': 'Menkar',
  'Bet Cet': 'Diphda', 'Alp Phe': 'Ankaa', 'Alp Pav': 'Peacock',
  'Alp TrA': 'Atria', 'Alp Ser': 'Unukalhai', 'Gam Dra': 'Eltanin',
  'Alp Dra': 'Thuban', 'Bet Sco': 'Acrab', 'Del Sco': 'Dschubba',
  'Alp Col': 'Phact', 'Zet Pup': 'Naos', 'Gam2Vel': 'Regor',
  'Eps Car': 'Avior', 'Iot Car': 'Aspidiske', 'Kap Sco': 'Girtab',
  'The Sco': 'Sargas', 'Sig Sgr': 'Nunki', 'Del Cyg': 'Fawaris',
  'Gam Cyg': 'Sadr', 'Bet Leo': 'Denebola', 'Gam Leo': 'Algieba',
  'Del Leo': 'Zosma', 'Bet UMa': 'Merak', 'Gam UMa': 'Phecda',
  'Del UMa': 'Megrez', 'Zet UMa': 'Mizar', 'Eta Boo': 'Muphrid',
  'Alp CrB': 'Alphecca', 'Alp Her': 'Rasalgethi', 'Bet Her': 'Kornephoros',
  'Alp Lup': 'Kakkab', 'Alp Cen': 'Rigil Kentaurus', 'Bet Ari': 'Sheratan',
  'Alp Aqr': 'Sadalmelik', 'Bet Aqr': 'Sadalsuud', 'Alp Cap': 'Algedi',
  'Del Cap': 'Deneb Algedi', 'Bet Peg2': '', 'Alp Lep': 'Arneb',
  'Alp Ind': 'Persian', 'Alp Tuc': '', 'Bet Gru': 'Tiaki',
  'Eta Tau': 'Alcyone', 'Alp Mus': '', 'Alp Cir': '',
};

/** "06 45 08.9" → degrees. */
function hmsToDeg(s) {
  const [h, m, sec] = s.trim().split(/\s+/).map(Number);
  if (![h, m, sec].every(Number.isFinite)) return null;
  return (h + m / 60 + sec / 3600) * 15;
}

/** "-16 42 58" → degrees, sign carried by the first field. */
function dmsToDeg(s) {
  const t = s.trim();
  const neg = t.startsWith('-');
  const [d, m, sec] = t.replace(/^[+-]/, '').split(/\s+/).map(Number);
  if (![d, m, sec].every(Number.isFinite)) return null;
  const deg = d + m / 60 + sec / 3600;
  return neg ? -deg : deg;
}

/** "  9Alp CMa" → { bayer: 'α CMa', key: 'Alp CMa' }, or null for the unnamed. */
function designation(raw) {
  const name = (raw ?? '').trim();
  if (!name) return null;
  // Strip a leading Flamsteed number; what is left is the Bayer designation.
  const bayer = name.replace(/^\d+/, '').trim();
  const m = /^([A-Za-z]{2,3})(\d?)\s*([A-Za-z]{3})$/.exec(bayer);
  if (!m) return null;
  const letter = GREEK[m[1]];
  if (!letter) return null;
  const key = `${m[1]}${m[2] || ' '}${m[3]}`.replace(/\s+/, ' ');
  return {
    key: `${m[1]}${m[2]}`.padEnd(m[2] ? 4 : 3) === m[1] ? key : `${m[1]}${m[2] || ' '}${m[3]}`,
    bayer: `${letter}${m[2] ? superscript(m[2]) : ''} ${m[3]}`,
  };
}

const SUP = { 1: '¹', 2: '²', 3: '³' };
const superscript = (d) => SUP[d] ?? d;

const main = async () => {
  process.stdout.write(`Asking VizieR for ${SOURCE} down to V ${LIMIT_VMAG}…\n`);
  const text = await askVizier(URL);

  const ra = [];
  const dec = [];
  const mag = [];
  const bv = [];
  const named = [];
  let skipped = 0;

  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const cols = line.split('\t');
    if (cols.length < 4) continue;
    const r = hmsToDeg(cols[0]);
    const d = dmsToDeg(cols[1]);
    const v = Number(cols[2]);
    if (r == null || d == null || !Number.isFinite(v)) { skipped++; continue; }

    const colour = Number(cols[3]);
    const i = ra.length;
    // Two decimals is 36 arcseconds, which is finer than a star is drawn on a
    // whole-sky picture and halves the size of the file.
    ra.push(Number(r.toFixed(2)));
    dec.push(Number(d.toFixed(2)));
    mag.push(Number(v.toFixed(2)));
    bv.push(Number.isFinite(colour) ? Number(colour.toFixed(2)) : 0);

    const des = designation(cols[4]);
    // Only the brightest get a label: past fourth magnitude the names would be
    // a fog over the picture rather than an answer to anything.
    if (des && v <= 3.2) {
      named.push({ i, bayer: des.bayer, name: PROPER[des.key] || '' });
    }
  }

  // Below the naked-eye limit the sky goes on. One more magnitude from the
  // Hipparcos catalogue (ESA 1997, VizieR I/239) triples the stars and is what
  // gives the Milky Way's edges and the faint constellations their texture.
  // The two lists do not overlap: one stops where the other starts.
  process.stdout.write(`Asking VizieR for ${FAINT_SOURCE}, V ${LIMIT_VMAG} to ${FAINT_VMAG}…\n`);
  for (const line of (await askVizier(FAINT_URL)).split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const [r, d, v, colour] = line.split('\t').map((c) => (c.trim() === '' ? NaN : Number(c)));
    if (![r, d, v].every(Number.isFinite)) continue;
    ra.push(Number(r.toFixed(2)));
    dec.push(Number(d.toFixed(2)));
    mag.push(Number(v.toFixed(2)));
    bv.push(Number.isFinite(colour) ? Number(colour.toFixed(2)) : 0);
  }

  await mkdir(dirname(OUT), { recursive: true });
  const body = {
    source: 'Bright Star Catalogue, 5th Revised Ed. (Hoffleit & Warren 1991, VizieR V/50); fainter than V 6: Hipparcos (ESA 1997, VizieR I/239)',
    fetched: new Date().toISOString().slice(0, 10),
    limitVmag: FAINT_VMAG,
    epoch: 'J2000',
    count: ra.length,
    ra, dec, mag, bv, named,
  };
  await writeFile(OUT, JSON.stringify(body), 'utf8');

  const withName = named.filter((n) => n.name).length;
  process.stdout.write(
    `${ra.length} stars to V ${FAINT_VMAG}; ${named.length} labelled, `
    + `${withName} with a proper name; ${skipped} rows unusable.\n`
    + `brightest ${mag[0]}, faintest ${Math.max(...mag)}\n`
    + `→ ${OUT}\n`,
  );
};

main().catch((err) => { process.stderr.write(`${err.message}\n`); process.exitCode = 1; });

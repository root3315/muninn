/**
 * The catalogue overlay's arithmetic: carrying a Gaia position to the date of
 * a visit, choosing how faint to go, building the queries and reading the rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GAIA_EPOCH, ROW_CAP, epochOfMjd, propagate, magLimit, wiseLimit, searchRadius,
  CATALOGUES, CATWISE_EPOCH, coneQuery, renameRow, parseGaiaRow, parseWiseRow, parseCatwiseRow, measuredMotion,
  cutToCap, markRadius, properMotion,
} from '../public/js/overlay.js';
import { parseCsv } from '../public/js/csv.js';
import { TangentGrid } from '../public/js/wcs.js';

/* Barnard's Star as Gaia DR3 has it (source 4472832130942575872), epoch J2016.0. */
const BARNARD = {
  ra: 269.44850252543836, dec: 4.739420051112412,
  pmRA: -801.5509783684709, pmDE: 10362.394206546573,
};
const ARCSEC = 1 / 3600;

test('a Modified Julian Date becomes a Julian year', () => {
  assert.equal(epochOfMjd(51544.5), 2000);
  assert.equal(epochOfMjd(57388.5), GAIA_EPOCH);
  // 15 Aug 2025, a SPHEREx visit to the Barnard field.
  assert.ok(Math.abs(epochOfMjd(60902.864715) - 2025.6218) < 1e-4);
});

test("Barnard's Star is carried 98″ north and 7.6″ west by mid-2025", () => {
  const at = propagate(BARNARD, 2025.5);
  assert.equal(at.moved, true);
  // 9.5 yr × 10362.394 mas/yr = 98.44″ in declination.
  assert.ok(Math.abs((at.dec - BARNARD.dec) / ARCSEC - 98.443) < 0.005);
  // 9.5 yr × −801.551 mas/yr = −7.61″ on the sky; divided by cos δ in right ascension.
  const onSky = (at.ra - BARNARD.ra) * Math.cos(at.dec * Math.PI / 180) / ARCSEC;
  assert.ok(Math.abs(onSky + 7.615) < 0.005);
  assert.ok(Math.abs(at.ra - 269.446380) < 1e-6);
  assert.ok(Math.abs(at.dec - 4.766765) < 1e-6);
});

test("Barnard's Star moves 10.39″ a year, and a year apart is more than a pixel", () => {
  assert.ok(Math.abs(properMotion(BARNARD) - 10.3933) < 1e-4);
  const a = propagate(BARNARD, 2025.0);
  const b = propagate(BARNARD, 2026.0);
  const step = Math.hypot((b.dec - a.dec), (b.ra - a.ra) * Math.cos(a.dec * Math.PI / 180)) / ARCSEC;
  assert.ok(Math.abs(step - 10.393) < 0.01);
  assert.ok(step > 6.15, 'more than one SPHEREx pixel');
});

test('on an 18′ plate the propagated circle lands 16 pixels from the 2016 position', () => {
  // The plate the Barnard preset opens: centred on where the star is now.
  const grid = new TangentGrid(269.4463, 4.7680, 0.3, 176, 176);
  const pixelArcsec = grid.scale * 3600;
  const then = grid.worldToIndex(BARNARD.ra, BARNARD.dec);
  const at = propagate(BARNARD, 2025.5);
  const now = grid.worldToIndex(at.ra, at.dec);
  const shift = Math.hypot(now[0] - then[0], now[1] - then[1]) * pixelArcsec;
  assert.ok(Math.abs(shift - 98.74) < 0.1, `shift ${shift}`);
  // North is up: the star has gone up the plate, and slightly west (right).
  assert.ok(now[1] < then[1] && now[0] > then[0]);
});

test('the epoch a position is already at leaves it alone', () => {
  const at = propagate(BARNARD, GAIA_EPOCH);
  assert.equal(at.ra, BARNARD.ra);
  assert.equal(at.dec, BARNARD.dec);
});

test('a source without a proper motion stays put and says so', () => {
  for (const pm of [{ pmRA: null, pmDE: null }, { pmRA: 3.1, pmDE: null }, {}]) {
    const at = propagate({ ra: 10, dec: -20, ...pm }, 2025.5);
    assert.deepEqual(at, { ra: 10, dec: -20, moved: false });
  }
});

test('right ascension wraps at 0 h and widens toward the pole', () => {
  const east = propagate({ ra: 359.9999, dec: 0, pmRA: 1000, pmDE: 0 }, 2017);
  assert.ok(east.ra < 0.001 && east.ra >= 0);
  // The same motion on the sky is twice the change in right ascension at 60°.
  const equator = propagate({ ra: 100, dec: 0, pmRA: 1000, pmDE: 0 }, 2026);
  const high = propagate({ ra: 100, dec: 60, pmRA: 1000, pmDE: 0 }, 2026);
  assert.ok(Math.abs((high.ra - 100) / (equator.ra - 100) - 2) < 1e-9);
});

test('the magnitude limit follows the field: wider is shallower', () => {
  assert.equal(magLimit(0.15), 18.5);
  assert.equal(magLimit(0.3), 17);
  assert.equal(magLimit(0.6), 15.5);
  const sizes = [0.1, 0.15, 0.2, 0.3, 0.45, 0.6];
  const limits = sizes.map(magLimit);
  assert.deepEqual(limits, [...limits].sort((a, b) => b - a));
  assert.ok(limits.every((m) => m >= 13 && m <= 20));
  assert.equal(wiseLimit(0.3), 14.5);
});

test('the search circle covers the corners of the plate, with room for drift', () => {
  const r = searchRadius(0.48, 0.3);
  assert.ok(r > Math.hypot(0.48, 0.3) / 2);
  // Barnard's Star has come 104″ since 2016: the margin has to hold that.
  assert.ok(r - Math.hypot(0.48, 0.3) / 2 >= 104 / 3600);
});

/** A query on one line, so it can be compared as text. */
const flat = (query) => query.replace(/\s+/g, ' ');

test('the queries are built from formatted numbers and nothing else', () => {
  const field = { ra: 269.4463, dec: 4.768, radiusDeg: 0.31641, limit: 17, top: ROW_CAP + 1 };
  assert.equal(flat(coneQuery(CATALOGUES.gaia.vizier, field)),
    'SELECT TOP 301 Source, RA_ICRS, DE_ICRS, Gmag, pmRA, pmDE, Plx, e_Plx, VarFlag, PQSO, PGal, PSS'
    + ' FROM "I/355/gaiadr3"'
    + " WHERE CONTAINS(POINT('ICRS', RA_ICRS, DE_ICRS), CIRCLE('ICRS', 269.446300, 4.768000, 0.31641)) = 1 AND Gmag <= 17.00"
    + ' ORDER BY Gmag');
  assert.equal(flat(coneQuery(CATALOGUES.wise.vizier, { ...field, limit: 14.5, top: 51 })),
    'SELECT TOP 51 AllWISE, RAJ2000, DEJ2000, W1mag, W2mag FROM "II/328/allwise"'
    + " WHERE CONTAINS(POINT('ICRS', RAJ2000, DEJ2000), CIRCLE('ICRS', 269.446300, 4.768000, 0.31641)) = 1 AND W1mag <= 14.50"
    + ' ORDER BY W1mag');
});

test('the IRSA templates ask the NASA tables, in their own column names', () => {
  const field = { ra: 269.452, dec: 4.693, radiusDeg: 6 / 3600, top: 8 };
  assert.equal(flat(coneQuery(CATALOGUES.gaia.irsa, { ...field, limit: 17 })),
    'SELECT TOP 8 source_id, ra, dec, phot_g_mean_mag, pmra, pmdec, parallax, parallax_error, phot_variable_flag,'
    + ' classprob_dsc_combmod_quasar, classprob_dsc_combmod_galaxy, classprob_dsc_combmod_star'
    + " FROM gaia_dr3_source WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', 269.452000, 4.693000, 0.00167)) = 1"
    + ' AND phot_g_mean_mag <= 17.00 ORDER BY phot_g_mean_mag');
  // Without a limit there is no cut, only the cone; still brightest first.
  assert.equal(flat(coneQuery(CATALOGUES.twomass.irsa, field)),
    "SELECT TOP 8 designation, ra, dec, j_m, h_m, k_m FROM fp_psc WHERE CONTAINS(POINT('ICRS', ra, dec),"
    + " CIRCLE('ICRS', 269.452000, 4.693000, 0.00167)) = 1 ORDER BY j_m");
  assert.ok(flat(coneQuery(CATALOGUES.wise.irsa, field)).startsWith('SELECT TOP 8 designation, ra, dec, w1mpro, w2mpro FROM allwise_p3as_psd'));
  assert.ok(flat(coneQuery(CATALOGUES.catwise.irsa, field)).startsWith(
    'SELECT TOP 8 source_name, ra_pm, dec_pm, pmra, pmdec, sigpmra, sigpmdec, w1mpro, w2mpro FROM catwise_2020'));
  // VizieR quotes the one column whose name starts with a digit.
  assert.ok(coneQuery(CATALOGUES.twomass.vizier, field).startsWith('SELECT TOP 8 "2MASS", RAJ2000'));
  // Every catalogue has an IRSA template; CatWISE has no VizieR one.
  assert.deepEqual(Object.keys(CATALOGUES).filter((k) => CATALOGUES[k].irsa), ['gaia', 'wise', 'twomass', 'catwise']);
  assert.equal(CATALOGUES.catwise.vizier, undefined);
});

test('a query refuses anything that is not a finite number', () => {
  const field = { ra: 10, dec: 20, radiusDeg: 0.2, limit: 17, top: 9 };
  for (const archive of [CATALOGUES.gaia.vizier, CATALOGUES.wise.irsa]) {
    for (const bad of ['10', "10'; DROP TABLE x --", NaN, Infinity, null, undefined]) {
      assert.throws(() => coneQuery(archive, { ...field, ra: bad }), TypeError);
      assert.throws(() => coneQuery(archive, { ...field, radiusDeg: bad }), TypeError);
      assert.throws(() => coneQuery(archive, { ...field, top: bad }), TypeError);
    }
    for (const bad of ['10', "10'; DROP TABLE x --", NaN, Infinity]) {
      assert.throws(() => coneQuery(archive, { ...field, limit: bad }), TypeError);
    }
  }
});

/* Recorded from IRSA TAP on 13 Nov 2026: Gaia DR3 near Barnard's Star, the IRSA template, top 3. */
const IRSA_GAIA_CSV = `source_id,ra,dec,phot_g_mean_mag,pmra,pmdec,parallax,parallax_error,phot_variable_flag,classprob_dsc_combmod_quasar,classprob_dsc_combmod_galaxy,classprob_dsc_combmod_star
4472835983521061248,269.45241699657,4.77473723896,14.975017,-1.843,-6.193,0.2183,0.0281,NOT_AVAILABLE,0.000000,0.000000,0.999987
4472835876142910336,269.44852449166,4.76290250243,16.695990,-3.157,-0.535,0.4920,0.0631,NOT_AVAILABLE,0.000000,0.000000,0.999988
`;

test('an IRSA row, renamed, reads exactly like a VizieR row', () => {
  const rows = parseCsv(IRSA_GAIA_CSV).map((r) => renameRow(r, CATALOGUES.gaia.irsa.columns));
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), Object.keys(CATALOGUES.gaia.vizier.columns));
  assert.equal(rows[0].Source, '4472835983521061248');
  assert.equal(rows[0].VarFlag, 'NOT_AVAILABLE');
  assert.deepEqual(parseGaiaRow(rows[0]), {
    id: '4472835983521061248', ra: 269.45241699657, dec: 4.77473723896, mag: 14.975017,
    pmRA: -1.843, pmDE: -6.193, plx: 0.2183, plxErr: 0.0281,
  });
  // A column the archive did not send is empty, not undefined.
  assert.equal(renameRow({}, { Gmag: 'phot_g_mean_mag' }).Gmag, '');
});

/* Recorded from IRSA TAP on 13 Nov 2026: CatWISE2020, the IRSA template. */
const IRSA_CATWISE_CSV = `source_name,ra_pm,dec_pm,pmra,pmdec,sigpmra,sigpmdec,w1mpro,w2mpro
J175754.41+044050.2,269.4767330,4.6806137,-0.01458,-0.00345,0.0040,0.0040,10.298,10.391
J175752.99+044147.7,269.4708135,4.6965593,-0.00138,-0.19722,0.0450,0.0481,16.541,16.865
`;

test('a CatWISE row gives its motion in mas a year, and only a measured one is said', () => {
  const [bright, faint] = parseCsv(IRSA_CATWISE_CSV).map(parseCatwiseRow);
  assert.equal(bright.id, 'J175754.41+044050.2');
  assert.equal(bright.mag, 10.298);
  assert.ok(Math.abs(bright.pmRA + 14.58) < 1e-9);
  assert.ok(Math.abs(bright.pmDEErr - 4) < 1e-9);
  // 15 mas/yr against a 5.7 mas/yr error: under five sigma, not a measurement.
  assert.equal(measuredMotion(bright), null);
  // 197 mas/yr against 66: three sigma, still not.
  assert.equal(measuredMotion(faint), null);
  // A brown dwarf's 8″ a year at 0.1″ error is.
  assert.ok(Math.abs(measuredMotion({ pmRA: -8000, pmDE: 600, pmRAErr: 100, pmDEErr: 100 }) - 8.0225) < 1e-3);
  assert.equal(measuredMotion({ pmRA: 100, pmDE: 0, pmRAErr: null, pmDEErr: null }), null);
  assert.ok(Math.abs(CATWISE_EPOCH - 2015.4) < 0.01);
});

test('a Gaia row keeps its 64-bit id as text and its gaps as null', () => {
  const full = parseGaiaRow({
    Source: '4472832130942575872', RA_ICRS: '269.44850252544', DE_ICRS: '4.73942005111',
    Gmag: '8.193974', pmRA: '-801.551', pmDE: '10362.394', Plx: '546.9759', e_Plx: '0.0401',
  });
  assert.deepEqual(full, {
    id: '4472832130942575872', ra: 269.44850252544, dec: 4.73942005111, mag: 8.193974,
    pmRA: -801.551, pmDE: 10362.394, plx: 546.9759, plxErr: 0.0401,
  });
  // A two-parameter solution: a position and a brightness, no motion, no parallax.
  const bare = parseGaiaRow({ Source: '1', RA_ICRS: '10.5', DE_ICRS: '-3.25', Gmag: '19.1', pmRA: '', pmDE: '', Plx: '', e_Plx: '' });
  assert.equal(bare.pmRA, null);
  assert.equal(bare.pmDE, null);
  assert.equal(bare.plx, null);
  assert.equal(propagate(bare, 2025.5).moved, false);
});

test('a row with no position or no magnitude is dropped', () => {
  assert.equal(parseGaiaRow({ Source: '1', RA_ICRS: '', DE_ICRS: '4', Gmag: '12' }), null);
  assert.equal(parseGaiaRow({ Source: '1', RA_ICRS: '3', DE_ICRS: '4', Gmag: '' }), null);
  assert.equal(parseWiseRow({ AllWISE: 'J1', RAJ2000: 'x', DEJ2000: '4', W1mag: '12' }), null);
});

test('an AllWISE row carries W1 and W2', () => {
  assert.deepEqual(
    parseWiseRow({ AllWISE: 'J175747.94+044323.8', RAJ2000: '269.4497620', DEJ2000: '4.7232970', W1mag: '4.386', W2mag: '' }),
    { id: 'J175747.94+044323.8', ra: 269.449762, dec: 4.723297, mag: 4.386, w2: null },
  );
});

test('a list longer than the cap is cut, and reports how deep it really goes', () => {
  const rows = Array.from({ length: ROW_CAP + 1 }, (_, k) => ({ mag: 10 + k * 0.01 }));
  const cut = cutToCap(rows, 17);
  assert.equal(cut.cut, true);
  assert.equal(cut.rows.length, ROW_CAP);
  assert.ok(Math.abs(cut.reached - (10 + (ROW_CAP - 1) * 0.01)) < 1e-9);

  const whole = cutToCap(rows.slice(0, ROW_CAP), 17);
  assert.equal(whole.cut, false);
  assert.equal(whole.rows.length, ROW_CAP);
  assert.equal(whole.reached, 17);
});

test('a brighter source gets a larger mark, within bounds', () => {
  assert.equal(markRadius(17, 17), 2.5);
  assert.equal(markRadius(19, 17), 2.5);
  assert.equal(markRadius(8.2, 17), 7);
  assert.ok(markRadius(14, 17) > markRadius(16, 17));
});

test('MAST Gaia rows keep the exact source id and are cut like the ADQL', async () => {
  const { mastGaiaRows } = await import('../public/js/overlay.js');
  const data = [
    { designation: 'Gaia DR3 4472832130942575872', source_id: 4472832130942576000, ra: 269.4485, dec: 4.7394, phot_g_mean_mag: 8.19, pmra: -801.55, pmdec: 10362.39 },
    { designation: 'Gaia DR3 1', source_id: 1, ra: 269.45, dec: 4.74, phot_g_mean_mag: 19.5 },
    { designation: 'Gaia DR3 2', source_id: 2, ra: 269.45, dec: 4.74, phot_g_mean_mag: 12.0 },
    { designation: 'Gaia DR3 3', source_id: 3, ra: 269.45, dec: 4.74, phot_g_mean_mag: null },
  ];
  const rows = mastGaiaRows(data, { limit: 15, top: 5 });
  assert.deepEqual(rows.map((r) => r.Source), ['4472832130942575872', '2']);
  assert.equal(rows[0].pmDE, 10362.39);
  assert.equal(mastGaiaRows(data, { limit: null, top: 1 }).length, 1);
});

test('a fast star is matched at the visit date, and the other catalogues are asked where it was', async () => {
  const { motionAnchor, askedAt } = await import('../public/js/catalog.js');
  // Barnard's Star in Gaia DR3 (J2016.0).
  const gaia = { ra: 269.44850252544, dec: 4.73942005111, pmRA: -801.551, pmDE: 10362.394, from: 2016 };
  const anchor = motionAnchor(gaia, null);
  // 2MASS saw it around 1999.5: 171″ south of its 2016 place.
  const tm = askedAt(anchor, 0, 0, { at: 1999.5, spread: 2 }, 6);
  assert.ok(Math.abs((tm.dec - gaia.dec) * 3600 + 10.362394 * 16.5) < 0.5, `dec ${tm.dec}`);
  assert.ok(tm.arcsec > 26 && tm.arcsec < 28, `radius ${tm.arcsec}`);
  // No anchor: the marked spot itself, a pixel wide.
  assert.deepEqual(askedAt(null, 10, 20, { at: 2000, spread: 0 }, 6), { ra: 10, dec: 20, arcsec: 6 });
  // A still faint Gaia star in the pixel does not outrank a CatWISE brown dwarf's motion.
  const still = { ra: 133.79, dec: -7.24, pmRA: 2, pmDE: -3, from: 2016 };
  const dwarf = { ra: 133.7951, dec: -7.2452, pmRA: -8100, pmDE: 680, pm: 8.1, from: 2015.4 };
  assert.equal(motionAnchor(still, dwarf).pmRA, -8100);
  assert.equal(motionAnchor(still, null).pmRA, 2);
});

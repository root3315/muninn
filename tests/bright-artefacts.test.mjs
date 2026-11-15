/**
 * A bright star's own light in other missions' catalogues: AllWISE's spike,
 * halo and ghost detections, Gaia's confused images, the marks that fall on
 * pixels the pipeline closed, and the one line that says what those pixels are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOGUES, renameRow, parseWiseRow, parseGaiaRow, wiseArtefact, gaiaArtefact,
} from '../public/js/overlay.js';
import { catalogueRows, wiseMatch } from '../public/js/catalog.js';
import { brightStarNear } from '../public/js/brightstars.js';
import { parseCsv } from '../public/js/csv.js';
import { SkyView, patchLabelGroups } from '../public/js/sky.js';
import { TangentGrid } from '../public/js/wcs.js';

const HAMAL = { ra: 31.7934, dec: 23.4624, mag: 2.0, name: 'Hamal' };
const nearHamal = (row) => brightStarNear([HAMAL], row.ra, row.dec) !== null;

/*
 * AllWISE round Hamal, as the CfA mirror of VizieR (II/328) gave the rows on
 * 15 Nov 2026: AllWISE, RAJ2000, DEJ2000, W1mag, W2mag, ccf, ex. And whether
 * the overlay draws each, with why.
 */
const HAMAL_WISE = [
  [['J020710.54+232742.8', '031.7939534', '+23.4619006', '-0.620', '1.645', 'HHHH', '0'], false], // Hamal itself, its own halo
  [['J020707.68+232756.9', '031.7820154', '+23.4658096', '3.658', '2.334', 'ddDD', '1'], false], // 0.7′ out, on a spike
  [['J020714.57+232941.6', '031.8107419', '+23.4948983', '9.182', '10.535', 'DDdD', '1'], false], // spike, upper case
  [['J020703.76+232709.4', '031.7656715', '+23.4526122', '10.615', '10.530', 'hHDH', '1'], false], // halo in W2
  [['J020705.43+232717.3', '031.7726660', '+23.4548312', '9.839', '9.318', 'hhdH', '1'], false], // 1.2′ out, not a point
  [['J020728.54+232714.2', '031.8689266', '+23.4539503', '8.471', '8.576', 'hhhH', '0'], true], // Gaia G 10.8 under it
  [['J020726.60+233036.7', '031.8608340', '+23.5102152', '10.077', '10.129', 'hhH0', '0'], true], // Gaia G 11.5 under it
  [['J020718.22+232233.4', '031.8259417', '+23.3759495', '7.469', '7.668', 'hhh0', '0'], true], // beyond Hamal's reach
  [['J020639.38+233100.1', '031.6641124', '+23.5167074', '10.708', '10.906', 'ddd0', '0'], true], // beyond it, lower case
  [['J020709.54+231310.7', '031.7897660', '+23.2196439', '11.138', '11.171', '0000', '0'], true], // clean
];
const WISE_FIELDS = ['AllWISE', 'RAJ2000', 'DEJ2000', 'W1mag', 'W2mag', 'ccf', 'ex'];

const votable = (fields, rows) => '<?xml version="1.0"?><VOTABLE><RESOURCE><TABLE>'
  + fields.map((n) => `<FIELD name="${n}" datatype="char"/>`).join('')
  + `<DATA><TABLEDATA>${rows.map((r) => `<TR>${r.map((v) => `<TD>${v}</TD>`).join('')}</TR>`).join('')}`
  + '</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>';

/* The same rows as IRSA's allwise_p3as_psd names its columns (IRSA answered 502 that day). */
const IRSA_CSV = `designation,ra,dec,w1mpro,w2mpro,cc_flags,ext_flg
${HAMAL_WISE.map(([r]) => r.join(',')).join('\n')}
`;

const drawn = (rows) => rows.map(parseWiseRow).map((row) => !wiseArtefact(row, { nearBright: nearHamal(row) }));

test('the overlay asks both archives for the flags it judges by', () => {
  assert.equal(CATALOGUES.wise.irsa.columns.ccf, 'cc_flags');
  assert.equal(CATALOGUES.wise.irsa.columns.ex, 'ext_flg');
  assert.equal(CATALOGUES.wise.vizier.columns.ccf, 'ccf');
  assert.equal(CATALOGUES.gaia.irsa.columns.RUWE, 'ruwe');
  assert.equal(CATALOGUES.gaia.irsa.columns.IPDfmp, 'ipd_frac_multi_peak');
  assert.equal(CATALOGUES.gaia.vizier.columns.IPDfmp, 'IPDfmp');
});

test('round Hamal, AllWISE rows from the VizieR mirror keep the stars and drop the spikes and halo', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url), 'http://local/');
    if (u.hostname !== 'vizier.cfa.harvard.edu') throw new Error('down');
    assert.ok(u.searchParams.get('-out').split(',').includes('ccf'));
    return { ok: true, status: 200, text: async () => votable(WISE_FIELDS, HAMAL_WISE.map(([r]) => r)) };
  };
  try {
    const { rows, via } = await catalogueRows('wise', { ra: HAMAL.ra, dec: HAMAL.dec, radiusDeg: 0.25, top: 50 });
    assert.equal(via, 'VizieR');
    assert.deepEqual(drawn(rows), HAMAL_WISE.map(([, keep]) => keep));
  } finally {
    globalThis.fetch = real;
  }
});

test('the same rows from IRSA, renamed, are judged the same', () => {
  const rows = parseCsv(IRSA_CSV).map((r) => renameRow(r, CATALOGUES.wise.irsa.columns));
  assert.equal(rows[0].ccf, 'HHHH');
  assert.deepEqual(drawn(rows), HAMAL_WISE.map(([, keep]) => keep));
});

test('only W1 and W2 are read, and lower case counts only by a bright star', () => {
  const row = (ccf, ex = 1) => ({ ccf, ex });
  // A spike in W3 alone says nothing of the W1 mark.
  assert.equal(wiseArtefact(row('00D0')), false);
  for (const flag of ['D', 'H', 'O', 'P']) {
    assert.equal(wiseArtefact(row(`${flag}000`)), true, flag);
    assert.equal(wiseArtefact(row(`0${flag}00`)), true, flag);
  }
  for (const flag of ['d', 'h', 'o', 'p']) {
    assert.equal(wiseArtefact(row(`${flag}000`)), false, flag);
    assert.equal(wiseArtefact(row(`${flag}000`), { nearBright: true }), true, flag);
    // A point source under a lower-case flag is a star with some light on it.
    assert.equal(wiseArtefact(row(`${flag}000`, 0), { nearBright: true }), false, flag);
  }
  // A row from an archive that left the flags out is drawn.
  assert.equal(wiseArtefact({ ccf: '', ex: null }, { nearBright: true }), false);
});

/* Gaia DR3 round Hamal, from the CfA mirror of I/355 on 15 Nov 2026. */
const gaiaRow = (Source, RA_ICRS, DE_ICRS, Gmag, Plx, RUWE, IPDfmp) => parseGaiaRow({ Source, RA_ICRS, DE_ICRS, Gmag, Plx, RUWE, IPDfmp });

test('Gaia sources are judged only inside the bright star\'s reach, by Gaia\'s own quality', () => {
  const confused = gaiaRow('103832281785501824', '31.78225686816', '23.50807003648', '12.885405', '2.8792', '12.468', '43');
  const clean = gaiaRow('103790637782603776', '31.86895149133', '23.45394098991', '10.845270', '0.9770', '1.094', '13');
  const binaryLike = gaiaRow('3', '31.80', '23.47', '14.0', '1.0', '2.5', '3');
  const twoParam = gaiaRow('1', '31.80', '23.47', '19.5', '', '', '12');
  for (const row of [confused, clean, binaryLike, twoParam]) assert.equal(nearHamal(row), true);
  assert.equal(gaiaArtefact(confused, { nearBright: true }), true);
  assert.equal(gaiaArtefact(clean, { nearBright: true }), false);
  // A bad fit alone, on single-peaked images, is left to the reader.
  assert.equal(gaiaArtefact(binaryLike, { nearBright: true }), false);
  assert.equal(gaiaArtefact(twoParam, { nearBright: true }), true);
  // Away from a bright star nothing is judged.
  assert.equal(gaiaArtefact(twoParam), false);
  assert.equal(gaiaArtefact(confused), false);
});

test('a mark is matched to a clean AllWISE source, and says so when only an artefact is there', () => {
  const spike = { id: 'J1', w1: 4.6, w2: 2.1, sep: 1.0, ccf: 'DDdD' };
  const star = { id: 'J2', w1: 11.2, w2: 11.1, sep: 4.5, ccf: 'hh00' };
  assert.equal(wiseMatch([spike, star]).id, 'J2');
  assert.equal(wiseMatch([spike, star]).artefact, undefined);
  const only = wiseMatch([spike]);
  assert.equal(only.id, 'J1');
  assert.equal(only.artefact, true);
  assert.equal(wiseMatch([]), null);
});

/* ------------------------------------------------ the saturated patches */

const patch = (ci, cj, reach, area) => ({ ci, cj, reach, area, cells: new Int32Array(0) });

test('two patches of one star make one label round both', () => {
  const core = patch(40, 40, 10, 300);
  const bleed = patch(40, 62, 4, 50);
  const groups = patchLabelGroups([core, bleed], () => HAMAL);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].star, HAMAL);
  assert.equal(groups[0].area, 350);
  // The circle reaches past both: the far side of the bleed is 66 samples down.
  const { cj, reach } = groups[0];
  assert.ok(cj - reach <= 30 + 1e-9 && cj + reach >= 66 - 1e-9, `${cj} ± ${reach}`);
});

test('patches of different stars keep a label each; unknown ones share one', () => {
  const other = { ra: 0, dec: 0, mag: 1, name: 'Other' };
  const ps = [patch(10, 10, 5, 80), patch(70, 70, 5, 80), patch(20, 20, 3, 30), patch(50, 50, 3, 30)];
  const starOf = (p) => (p.ci < 30 ? HAMAL : p.ci > 60 ? other : null);
  const groups = patchLabelGroups(ps, starOf);
  assert.deepEqual(groups.map((g) => g.star?.name ?? null), ['Hamal', 'Other', null]);
  assert.deepEqual(groups.map((g) => g.area), [110, 80, 30]);
  assert.deepEqual(patchLabelGroups([], starOf), []);
});

/** A canvas context that only keeps what was written on it. */
function recordingContext() {
  const said = [];
  return {
    said,
    save() {}, restore() {}, beginPath() {}, arc() {}, stroke() {}, moveTo() {}, lineTo() {}, closePath() {},
    measureText: (text) => ({ width: text.length * 6 }),
    fillText: (text, x, y) => said.push({ text, x, y }),
    strokeText() {},
  };
}

/** The parts of a SkyView the patch label and the survey marks use, on an 81-sample grid. */
function plate() {
  const size = 81;
  const grid = new TangentGrid(HAMAL.ra, HAMAL.dec, (size * 6.15) / 2.5 / 3600, size, size);
  const cells = [];
  for (let j = 30; j <= 50; j++) for (let i = 30; i <= 50; i++) if ((i - 40) ** 2 + (j - 40) ** 2 <= 100) cells.push(j * size + i);
  for (let j = 52; j <= 58; j++) cells.push(j * size + 40);
  const core = { ...patch(40, 40, 10, cells.length - 7), cells: Int32Array.from(cells.slice(0, -7)) };
  const bleed = { ...patch(40, 55, 3, 7), cells: Int32Array.from(cells.slice(-7)) };
  const view = Object.create(SkyView.prototype);
  Object.defineProperty(view, 'brightInField', { value: HAMAL });
  Object.defineProperty(view, 'samplesPerPixel', { value: 2.5 });
  Object.defineProperty(view, 'view', { value: { scale: 4, offX: 38, offY: 38, gw: size, gh: size } });
  Object.assign(view, {
    grid, mode: 'single', cssW: 400, cssH: 400,
    brightStars: [HAMAL], hits: [], taken: [], fonts: { compass: '10px sans-serif' },
    colors: { muted: '#888', well: '#000', ink: '#fff' },
    labels: { saturated: (name, n) => `${name}: saturated (${n} px)` },
    visits: [{ patches: [core, bleed], stamp: { width: size, height: size }, frame: { mjd: 60900 } }], index: 0, a: 0,
  });
  return view;
}

test('a star with two patches is said once, beside them and not on them', () => {
  const view = plate();
  const ctx = recordingContext();
  view.labelPatches(ctx, view.current);
  assert.equal(ctx.said.length, 1);
  assert.match(ctx.said[0].text, /^Hamal: saturated/);
  const [x, y] = view.toCanvas(40, 40);
  assert.ok(Math.hypot(ctx.said[0].x - x, ctx.said[0].y - y) > 10 * view.view.scale, 'outside the core');
  // Only the label's own room stays booked.
  assert.equal(view.taken.length, 1);
});

test('the label steps round the survey marks when there is room', () => {
  const view = plate();
  const [x, y] = view.toCanvas(40, 40);
  const free = recordingContext();
  plate().labelPatches(free, view.current);
  assert.ok(free.said[0].y < y, 'with nothing in the way, above the patch');
  // Marks all over the sky above the patch, where the label would go first.
  for (let dy = 40; dy <= 140; dy += 8) {
    for (let dx = -160; dx <= 160; dx += 8) view.hits.push({ kind: 'wise', x: x + dx, y: y - dy });
  }
  const ctx = recordingContext();
  view.labelPatches(ctx, view.current);
  assert.equal(ctx.said.length, 1);
  assert.ok(ctx.said[0].y >= y, 'moved off the marks');
  // The marks were in this label's way only: nothing else is kept from them.
  assert.equal(view.taken.length, 1);
});

test('marks on closed pixels and flagged artefacts are counted, not drawn', () => {
  const view = plate();
  const at = (i, j) => view.grid.indexToWorld(i, j);
  const [inRa, inDec] = at(40, 40);
  const [bleedRa, bleedDec] = at(40, 56);
  const [skyRa, skyDec] = at(70, 15);
  const rows = [
    { ra: inRa, dec: inDec, mag: 9, ccf: '0000', ex: 0 },
    { ra: bleedRa, dec: bleedDec, mag: 9, ccf: '0000', ex: 0 },
    { ra: skyRa, dec: skyDec, mag: 9, ccf: 'DD00', ex: 1 },
    { ra: skyRa, dec: skyDec, mag: 9, ccf: '0000', ex: 0 },
  ];
  view.surveys = { wise: { rows, limit: 14 } };
  view.surveyShown = {};
  view.surveyHidden = {};
  view.drawSurvey(recordingContext(), 'wise', '#fff', 1, (o) => o, () => {});
  assert.equal(view.surveyShown.wise, 1);
  assert.equal(view.surveyHidden.wise, 3);
  // In a difference the patches are not drawn, and a mark on one is shown.
  view.mode = 'difference';
  view.drawSurvey(recordingContext(), 'wise', '#fff', 1, (o) => o, () => {});
  assert.equal(view.surveyShown.wise, 3);
});

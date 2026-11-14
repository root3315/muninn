import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifySource } from '../public/js/catalog.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });

/**
 * A stand-in for the archives: the relay answers per catalogue after its own
 * delay, SIMBAD names whatever sits at the circle it is asked about, and
 * VizieR is down, as CDS was.
 */
function archives({ gaiaRows, catwiseMs, simbadAt, calls = {} }) {
  return async (url) => {
    const kind = String(url).includes('sim-tap') ? 'simbad' : String(url).match(/cat=(\w+)/)?.[1] ?? 'other';
    calls[kind] = (calls[kind] ?? 0) + 1;
    const u = String(url);
    if (u.startsWith('api/tap?cat=gaia')) { await sleep(30); return json({ ok: true, rows: gaiaRows }); }
    if (u.startsWith('api/tap?cat=catwise')) { await sleep(catwiseMs); return json({ ok: true, rows: [] }); }
    if (u.startsWith('api/tap?')) { await sleep(10); return json({ ok: true, rows: [] }); }
    if (u.includes('sim-tap')) {
      const [, ra] = decodeURIComponent(u).match(/CIRCLE\('ICRS', ([\d.]+), ([-\d.]+)/);
      return json({ data: [[simbadAt(Number(ra)), '*', 1, 5, null, null]] });
    }
    throw new Error('down');
  };
}

async function withArchives(fake, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = real; }
}

test('SIMBAD\'s name shows while CatWISE is still out', async () => {
  const updates = [];
  const result = await withArchives(archives({
    gaiaRows: [{ Source: '1', RA_ICRS: '180', DE_ICRS: '0', Gmag: '9', pmRA: '1', pmDE: '1' }],
    catwiseMs: 250,
    simbadAt: () => 'HD 1',
  }), () => identifySource({ ra: 180, dec: 0, epoch: 2026 }, { onUpdate: (u) => updates.push(u) }));

  const early = updates.find((u) => u.simbad && u.pending.includes('catwise'));
  assert.ok(early, 'a name came before CatWISE answered');
  assert.equal(early.simbad.name, 'HD 1');
  assert.equal(result.simbad.name, 'HD 1');
  assert.equal(result.pending, undefined);
});

test('a fast star never shows the name at its present-day spot', async () => {
  // 10″ a year in RA: at Gaia's 2016.0 it sat 100″ west of where it is in 2026,
  // and at SIMBAD's J2000 260″ west.
  const updates = [];
  const result = await withArchives(archives({
    gaiaRows: [{ Source: '2', RA_ICRS: String(180 - 100 / 3600), DE_ICRS: '0', Gmag: '9', pmRA: '10000', pmDE: '0' }],
    catwiseMs: 20,
    simbadAt: (ra) => (Math.abs(ra - 180) * 3600 < 1 ? 'Neighbour' : 'Fast star'),
  }), () => identifySource({ ra: 180, dec: 0, epoch: 2026 }, { onUpdate: (u) => updates.push(u) }));

  assert.ok(updates.every((u) => u.simbad?.name !== 'Neighbour'));
  assert.equal(result.simbad.name, 'Fast star');
  assert.ok(result.moved);
});

test('a still star a second off its Gaia position is asked about once', async () => {
  const calls = {};
  const updates = [];
  const result = await withArchives(archives({
    gaiaRows: [{ Source: '3', RA_ICRS: String(180 + 1 / 3600), DE_ICRS: '0', Gmag: '9', pmRA: '5', pmDE: '5' }],
    catwiseMs: 20,
    simbadAt: () => 'HD 3',
    calls,
  }), () => identifySource({ ra: 180, dec: 0, epoch: 2026 }, { onUpdate: (u) => updates.push(u) }));

  assert.equal(result.simbad.name, 'HD 3');
  // One question, sent to both SIMBAD mirrors.
  assert.equal(calls.simbad, 2);
  assert.equal(calls.twomass, 1);
  // SIMBAD answered before Gaia: held back, but no longer said to be asked.
  assert.ok(updates.some((u) => u.pending.includes('simbad') && !u.asking.includes('simbad') && u.asking.includes('gaia')));
  assert.equal(result.asking, undefined);
});

/** A VOTable as VizieR's cone search sends it, one row per object of `rows`. */
function cfaVotable(rows) {
  const names = Object.keys(rows[0] ?? {});
  return '<?xml version="1.0"?><VOTABLE><RESOURCE><TABLE>'
    + names.map((n) => `<FIELD name="${n}" datatype="char"/>`).join('')
    + `<DATA><TABLEDATA>${rows.map((r) => `<TR>${names.map((n) => `<TD>${r[n]}</TD>`).join('')}</TR>`).join('')}`
    + '</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>';
}

const MIRROR_ROWS = {
  'II/246/out': [{ '2MASS': '12000000+0000000', RAJ2000: '180.0', DEJ2000: '0.0', Jmag: '9.1', Hmag: '8.8', Kmag: '8.7' }],
  'II/328/allwise': [{ AllWISE: 'J120000.00+000000.0', RAJ2000: '180.0', DEJ2000: '0.0', W1mag: '8.5', W2mag: '8.4' }],
  'II/365/catwise': [{
    Name: 'J120000.00+000000.0', RAPMdeg: '180.0', DEPMdeg: '0.0', pmRA: '0.01', pmDE: '0.02',
    e_pmRA: '0.001', e_pmDE: '0.001', W1mproPM: '8.6', W2mproPM: '8.5',
  }],
  'I/355/gaiadr3': [{
    Source: '4472832130942575872', RA_ICRS: '180.0', DE_ICRS: '0.0', Gmag: '10.2', pmRA: '1', pmDE: '1',
    Plx: '5', e_Plx: '0.1', VarFlag: 'NOT_AVAILABLE', PQSO: '0', PGal: '0', PSS: '1',
  }],
};

/** The same sources as IRSA's relay sends them, under the shared names. */
const RELAY_ROWS = {
  twomass: MIRROR_ROWS['II/246/out'],
  wise: MIRROR_ROWS['II/328/allwise'],
  catwise: [{
    source_name: 'J120000.00+000000.0', ra_pm: '180.0', dec_pm: '0.0', pmra: '0.01', pmdec: '0.02',
    sigpmra: '0.001', sigpmdec: '0.001', w1mpro: '8.6', w2mpro: '8.5',
  }],
  gaia: MIRROR_ROWS['I/355/gaiadr3'],
};

/**
 * CDS down, as in the review: VizieR's TAP times out and SIMBAD says 404.
 * IRSA's TAP, behind the relay, never answers. Only the CfA's VizieR is up.
 */
function cdsDown(calls) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('api/tap?')) {
      calls.relay = (calls.relay ?? 0) + 1;
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (u.includes('vizier.cfa.harvard.edu/viz-bin/votable')) {
      const source = new URL(u).searchParams.get('-source');
      calls[source] = (calls[source] ?? 0) + 1;
      return { ok: true, status: 200, text: async () => cfaVotable(MIRROR_ROWS[source] ?? []) };
    }
    if (u.includes('sim-tap')) return { ok: false, status: 404 };
    throw new Error('timed out');
  };
}

test('with CDS down and IRSA silent, the CfA mirror names 2MASS, AllWISE, CatWISE and Gaia', async () => {
  const calls = {};
  const started = Date.now();
  const result = await withArchives(cdsDown(calls), () => identifySource({ ra: 180, dec: 0, epoch: 2026 }));
  assert.ok(Date.now() - started < 5000, 'no wait on the silent relay');
  assert.equal(result.tmass.id, '12000000+0000000');
  assert.equal(result.tmass.j, 9.1);
  assert.equal(result.tmass.via, 'VizieR');
  assert.equal(result.wise.id, 'J120000.00+000000.0');
  assert.equal(result.wise.w1, 8.5);
  assert.equal(result.catwise.id, 'J120000.00+000000.0');
  assert.equal(result.catwise.w1, 8.6);
  // Motions in arcsec a year at the mirror, mas a year in the answer, as from IRSA.
  assert.equal(result.catwise.pmRA, 10);
  assert.equal(result.gaia.id, '4472832130942575872');
  assert.equal(result.gaia.mag, 10.2);
  assert.equal(result.simbad, null);
  assert.ok(result.failed.includes('simbad'));
  assert.ok(!result.failed.includes('tmass'));
  assert.ok(calls['II/246/out'] >= 1 && calls['II/365/catwise'] >= 1);
});

test('a mark\'s answer has the same keys whichever archive gave it', async () => {
  const viaMirror = await withArchives(cdsDown({}), () => identifySource({ ra: 180, dec: 0, epoch: 2026 }));
  const viaIrsa = await withArchives(async (url) => {
    const kind = String(url).match(/^api\/tap\?cat=(\w+)/)?.[1];
    if (kind) return json({ ok: true, rows: RELAY_ROWS[kind] ?? [], via: 'IRSA' });
    throw new Error('down');
  }, () => identifySource({ ra: 180, dec: 0, epoch: 2026 }));
  for (const key of ['tmass', 'wise', 'catwise', 'gaia']) {
    assert.deepEqual(Object.keys(viaMirror[key]).sort(), Object.keys(viaIrsa[key]).sort(), key);
    assert.equal(viaIrsa[key].via, 'IRSA');
  }
  assert.deepEqual(viaMirror.catwise.pm, viaIrsa.catwise.pm);
});

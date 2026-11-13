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
function archives({ gaiaRows, catwiseMs, simbadAt }) {
  return async (url) => {
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

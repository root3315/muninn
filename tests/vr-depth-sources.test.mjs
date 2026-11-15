/**
 * The depth view's catalogues as the headset asks them (vr/distances.js):
 * through the box first, straight of the mirrors when the box cannot answer,
 * with each failing in turn. `fetch` is replaced for the test.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { geometricDistances, galaxiesWithRedshift } from '../public/js/vr/distances.js';

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

const field = { ra: 269.4463, dec: 4.768, radiusDeg: 0.2 };
const reply = (status, body, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
const votable = '<?xml version="1.0"?><VOTABLE><RESOURCE type="results"><INFO name="QUERY_STATUS" value="OK"/><TABLE>'
  + '<FIELD name="Source" datatype="char"/><FIELD name="rgeo" datatype="double"/><FIELD name="b_rgeo" datatype="double"/><FIELD name="B_rgeo" datatype="double"/>'
  + '<DATA><TABLEDATA><TR><TD>7</TD><TD>5</TD><TD>4</TD><TD>6</TD></TR></TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>';

/** A fetch that answers by where it is asked: the box, the VizieR mirrors, SIMBAD. */
function serve({ box = 'ok', vizier = 'ok', simbad = 'ok' }) {
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.startsWith('api/depth')) {
      if (box === 'fail') return reply(502, { ok: false, error: 'archives down' });
      if (box === 'static') return reply(404, 'not found', 'text/html');
      return u.includes('kind=bj')
        ? reply(200, { ok: true, bj: [['1', 10, 9, 11]], via: 'VizieR CfA' })
        : reply(200, { ok: true, rows: [['NGC 1', 'G', 269.45, 4.77, 0.02]], via: 'SIMBAD CDS' });
    }
    if (u.includes('vizier') || u.includes('TAPVizieR')) {
      if (vizier === 'fail') return reply(503, 'down', 'text/plain');
      return u.includes('votable') ? reply(200, votable, 'text/xml') : reply(200, 'Source,rgeo,b_rgeo,B_rgeo\n7,5,4,6\n', 'text/csv');
    }
    if (u.includes('simbad')) {
      if (simbad === 'fail') return reply(503, 'down', 'text/plain');
      return reply(200, { data: [['NGC 2', 'G', 269.44, 4.76, 0.03]] });
    }
    return reply(404, 'no', 'text/plain');
  };
  return seen;
}

test('distances come through the box when it answers', async () => {
  serve({});
  const bj = await geometricDistances(field);
  assert.deepEqual(bj.get('1'), { r: 10, lo: 9, hi: 11 });
});

test('the box down or absent: distances straight from the mirrors', async () => {
  for (const box of ['fail', 'static']) {
    serve({ box });
    const bj = await geometricDistances(field);
    assert.deepEqual(bj.get('7'), { r: 5, lo: 4, hi: 6 });
  }
});

test('the box and the mirrors both down: an error, for the depth view to name and retry', async () => {
  serve({ box: 'fail', vizier: 'fail' });
  await assert.rejects(geometricDistances(field));
});

test('galaxies through the box, else from SIMBAD, else an error', async () => {
  serve({});
  assert.equal((await galaxiesWithRedshift(field))[0].name, 'NGC 1');
  serve({ box: 'fail' });
  assert.equal((await galaxiesWithRedshift(field))[0].name, 'NGC 2');
  serve({ box: 'fail', simbad: 'fail' });
  await assert.rejects(galaxiesWithRedshift(field));
});

/**
 * The headset's depth catalogues through the box (server.js /api/depth),
 * against fake mirrors on this machine: only what it allows is asked, the
 * first mirror to answer wins, and a kept answer is sent, marked stale, when
 * every mirror fails.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = (Number(process.env.TEST_PORT) || 5199) + 7;
const BASE = `http://127.0.0.1:${PORT}`;
const cacheDir = join(tmpdir(), `muninn-depth-test-${process.pid}`);

describe('the depth relay against fake mirrors', () => {
  /** What each fake mirror does now: 'ok', 'fail' or 'slow'. */
  const mode = { cfa: 'ok', tap: 'fail', simbadCds: 'fail', simbadCfa: 'ok' };
  const asked = [];
  let fake;
  let box;

  const votable = '<?xml version="1.0"?><VOTABLE><RESOURCE type="results"><INFO name="QUERY_STATUS" value="OK"/><TABLE>'
    + '<FIELD name="Source" datatype="char"/><FIELD name="rgeo" datatype="double"/><FIELD name="b_rgeo" datatype="double"/><FIELD name="B_rgeo" datatype="double"/>'
    + '<DATA><TABLEDATA><TR><TD>4472832130942575872</TD><TD>1.83</TD><TD>1.82</TD><TD>1.84</TD></TR>'
    + '<TR><TD>42</TD><TD>120</TD><TD>110</TD><TD>130</TD></TR></TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>';

  before(async () => {
    await mkdir(cacheDir, { recursive: true });
    fake = createServer((req, res) => {
      const url = new URL(req.url, 'http://fake');
      const which = url.pathname.slice(1);
      asked.push(which);
      const fail = () => { res.writeHead(503); res.end('down'); };
      if (mode[which] === 'fail') return fail();
      if (which === 'cfa') { res.writeHead(200, { 'content-type': 'text/xml' }); return res.end(votable); }
      if (which === 'tap') { res.writeHead(200, { 'content-type': 'text/csv' }); return res.end('Source,rgeo,b_rgeo,B_rgeo,d\n7,5,4,6,0.01\n'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [['M 51', 'G', 202.47, 47.19, 0.0016]] }));
    });
    await new Promise((resolve) => { fake.listen(0, '127.0.0.1', resolve); });
    const at = `http://127.0.0.1:${fake.address().port}`;
    box = spawn(process.execPath, ['server.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        MUNINN_CACHE_DIR: cacheDir,
        MUNINN_VIZIER_CFA_URL: `${at}/cfa`,
        MUNINN_VIZIER_TAP_URL: `${at}/tap`,
        MUNINN_SIMBAD_CDS_URL: `${at}/simbadCds`,
        MUNINN_SIMBAD_CFA_URL: `${at}/simbadCfa`,
        MUNINN_DEPTH_TIMEOUT_MS: '2000',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('depth server did not start')), 10000);
      box.stdout.on('data', (chunk) => { if (String(chunk).includes(`:${PORT}`)) { clearTimeout(timer); resolve(); } });
    });
  });

  after(async () => {
    box?.kill();
    fake?.closeAllConnections?.();
    fake?.close();
    await rm(cacheDir, { recursive: true, force: true });
  });

  const ask = async (query) => {
    const res = await fetch(`${BASE}/api/depth?${query}`);
    return { status: res.status, body: await res.json() };
  };

  test('only the two kinds, a real position and a radius are asked; nothing names a host', async () => {
    assert.equal((await ask('kind=simbad&ra=10&dec=10&r=0.2')).status, 400);
    assert.equal((await ask('kind=bj&ra=400&dec=10&r=0.2')).status, 400);
    assert.equal((await ask('kind=bj&ra=10&dec=10')).status, 400);
    assert.equal((await ask('kind=bj&ra=10&dec=10&r=1e3')).status, 400);
    const before = asked.length;
    const { status } = await ask('kind=bj&ra=11&dec=11&r=0.2&url=https://evil.example/&host=evil.example');
    assert.equal(status, 200);
    // Whatever the request carried, only the fixed mirrors were asked.
    assert.ok(asked.slice(before).every((w) => ['cfa', 'tap'].includes(w)));
  });

  test('the first mirror to answer wins: distances from the CfA when CDS is down, galaxies from the CfA SIMBAD', async () => {
    const bj = await ask('kind=bj&ra=12&dec=12&r=0.2');
    assert.equal(bj.status, 200);
    assert.equal(bj.body.via, 'VizieR CfA');
    assert.deepEqual(bj.body.bj[0], ['4472832130942575872', 1.83, 1.82, 1.84]);
    const g = await ask('kind=galaxies&ra=202.47&dec=47.19&r=0.2');
    assert.equal(g.body.via, 'SIMBAD CfA');
    assert.equal(g.body.rows[0][0], 'M 51');
  });

  test('a fresh answer is kept and sent again without asking', async () => {
    const before = asked.length;
    const again = await ask('kind=bj&ra=12&dec=12&r=0.2');
    assert.equal(again.body.cached, true);
    assert.equal(asked.length, before);
  });

  test('every mirror down: the kept answer, however old, marked stale; none kept: an error', async () => {
    mode.cfa = 'fail';
    mode.tap = 'fail';
    // Kept ten days ago: past fresh, within the month it is kept.
    const key = 'depth_bj_13.0000_13.0000_0.2';
    const file = join(cacheDir, `${key}.json`);
    await writeFile(file, JSON.stringify({ bj: [['99', 50, 40, 60]], via: 'VizieR CfA' }), 'utf8');
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    await utimes(file, old, old);
    const stale = await ask('kind=bj&ra=13&dec=13&r=0.2');
    assert.equal(stale.status, 200);
    assert.equal(stale.body.stale, true);
    assert.deepEqual(stale.body.bj, [['99', 50, 40, 60]]);
    assert.ok(stale.body.staleAgeS > 9 * 24 * 3600);
    const none = await ask('kind=bj&ra=14&dec=14&r=0.2');
    assert.equal(none.status, 502);
    assert.equal(none.body.ok, false);
  });
});

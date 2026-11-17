/**
 * The local server: static files, the relay's input checks, the security
 * headers, and a malformed request not taking the process down.
 * Only answers that need no network are asked for; the frame search is
 * tested against a fake IRSA on this machine.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request, createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdir, rm, writeFile, readFile, utimes as touch } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { COLLECTIONS } from '../public/js/release.js';
import { ROW, tileOf, indexRowFromObscore } from '../public/js/frameindex.js';
import { CATALOGUES, columnsTag } from '../public/js/overlay.js';

const PORT = Number(process.env.TEST_PORT) || 5199;
const BASE = `http://127.0.0.1:${PORT}`;
/** No own frame index unless a test gives one: a built .index/ in the checkout must not change the answers. */
const NO_INDEX = join(tmpdir(), `muninn-no-index-${process.pid}`);
let child;

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MUNINN_INDEX_DIR: NO_INDEX },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`:${PORT}`)) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});

after(() => { child?.kill(); });

const get = (path, init) => fetch(BASE + path, init);

test('serves the page and its images with real types', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const moon = await get('/img/moon-nearside-lro.jpg');
  assert.equal(moon.headers.get('content-type'), 'image/jpeg');
});

test('refuses to walk out of public/ and to crash on a bad escape', async () => {
  assert.ok([403, 404].includes((await get('/..%2fserver.js')).status));
  assert.equal((await get('/%E0%A4%A')).status, 400);
});

test('search: absent coordinates are an error, a baked field answers offline', async () => {
  assert.equal((await get('/api/search')).status, 400);
  assert.equal((await get('/api/search?ra=&dec=')).status, 400);
  const res = await get('/api/search?ra=13.4194&dec=3.8459');
  const body = await res.json();
  assert.equal(body.cached, 'baked');
  assert.ok(body.frames.length > 10);
  // A whole frame list may be kept; a refused question may not.
  assert.match(res.headers.get('cache-control'), /public, max-age=\d+/);
  assert.equal((await get('/api/search?ra=&dec=')).headers.get('cache-control'), 'no-cache');
});

test('catalogue relay: only a named template, a real position and a radius are asked', async () => {
  for (const path of [
    '/api/tap?ra=269.45&dec=4.69&r=0.01',
    '/api/tap?cat=simbad&ra=269.45&dec=4.69&r=0.01',
    '/api/tap?cat=__proto__&ra=269.45&dec=4.69&r=0.01',
    "/api/tap?cat=gaia';DROP&ra=269.45&dec=4.69&r=0.01",
    '/api/tap?cat=gaia&ra=&dec=4.69&r=0.01',
    '/api/tap?cat=gaia&ra=400&dec=4.69&r=0.01',
    '/api/tap?cat=gaia&ra=269.45&dec=4.69',
    '/api/tap?cat=gaia&ra=269.45&dec=4.69&r=wide',
  ]) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
    assert.equal((await res.json()).ok, false);
  }
});

test('small-body relay: refuses a time that is not UTC to the second', async () => {
  for (const time of ['', 'now', '2025-08-15', '2025-13-45T99:00:00', '1850-08-15T12:00:00']) {
    const res = await get(`/api/sbident?ra=330&dec=-12&r=0.3&time=${encodeURIComponent(time)}`);
    assert.equal(res.status, 400, time);
  }
  assert.equal((await get('/api/sbident?ra=330&dec=95&time=2025-08-15T12:00:00')).status, 400);
});

test('CDS relay: only a plain name, or one of the page\'s two SIMBAD questions about a place', async () => {
  for (const path of [
    '/api/cds', '/api/cds?ask=tap&query=SELECT%201', '/api/cds?ask=sesame&name=', '/api/cds?ask=sesame&name=%3Cscript%3E',
    `/api/cds?ask=sesame&name=${'x'.repeat(81)}`, '/api/cds?ask=near&ra=269.4&dec=95&r=8', '/api/cds?ask=near&ra=269.4&dec=4.7&r=600',
    '/api/cds?ask=near&ra=269.4&dec=4.7', '/api/cds?ask=field&ra=269.4&dec=4.7&r=5', '/api/cds?ask=field&ra=269.4&dec=4.7&r=1e-1',
  ]) {
    assert.equal((await get(path)).status, 400, path);
  }
});

test('names relay: only an asteroid or comet name or designation goes to JPL', async () => {
  for (const name of ['', 'M51', 'TRAPPIST-1', 'NGC 4565', '<script>', 'Ceres&sstr=1', 'a'.repeat(41), '148.1 +1.0', 'ab']) {
    const res = await get(`/api/smallbody?name=${encodeURIComponent(name)}`);
    assert.equal(res.status, 400, name);
    assert.equal((await res.json()).ok, false);
  }
  assert.equal((await get('/api/smallbody')).status, 400);
});

test('same-orbit relay: only three numbers of a closed orbit go to JPL', async () => {
  for (const query of [
    '', 'a=3.1', 'a=3.1&e=0.08', 'a=abc&e=0.08&i=12', 'a=3.1&e=1.2&i=12', 'a=3.1&e=0.08&i=200',
    'a=-3&e=0.08&i=12', 'a=0&e=0.08&i=12', 'a=3e2&e=0.08&i=12', 'a=3.1&e=0.08&i=12%7C',
    `a=3.1&e=0.08&i=${encodeURIComponent('12|RG|0|180')}`, 'a=3.1&e=0.08&i=Infinity',
  ]) {
    const res = await get(`/api/sbdb-near?${query}`);
    assert.equal(res.status, 400, query);
    assert.equal((await res.json()).ok, false);
  }
});

test('a malformed request line is a 400, and the server is still there', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path: '//' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
  assert.equal((await get('/')).status, 200);
});

test('the page is served with the content-security policy from _headers', async () => {
  const page = await get('/');
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});

test('text is sent compressed, and an unchanged file is a 304', async () => {
  const plain = await get('/js/app.js', { headers: { 'accept-encoding': 'identity' } });
  const packed = await get('/js/app.js', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(packed.headers.get('content-encoding'), 'gzip');
  // fetch inflates the body, so the two must read the same.
  assert.equal(await packed.text(), await plain.text());
  const again = await get('/js/app.js', { headers: { 'if-none-match': plain.headers.get('etag') } });
  assert.equal(again.status, 304);
});

const IMMUTABLE_RE = /immutable/;
async function pageTag() {
  const html = await (await get('/')).text();
  const tag = html.match(/js\/app\.js\?v=([0-9a-f]+)/)?.[1];
  assert.ok(tag, 'the page names its code under a tag');
  return tag;
}

test('only code under the current tag is kept for good, not the page or its data', async () => {
  const tag = await pageTag();
  assert.match((await get(`/js/app.js?v=${tag}`)).headers.get('cache-control'), IMMUTABLE_RE);
  assert.doesNotMatch((await get(`/?v=${tag}`)).headers.get('cache-control'), IMMUTABLE_RE);
  assert.doesNotMatch((await get(`/talk.html?v=${tag}`)).headers.get('cache-control'), IMMUTABLE_RE);
  assert.doesNotMatch((await get(`/data/targets.json?v=${tag}`)).headers.get('cache-control'), IMMUTABLE_RE);
  assert.doesNotMatch((await get('/js/app.js?v=0000000000')).headers.get('cache-control'), IMMUTABLE_RE);
});

test('a data file under its own hash is the file, kept for good; under another hash it is not kept', async () => {
  const { DATA_NAMES } = await import('../public/js/datanames.js');
  const named = DATA_NAMES['data/targets.json'];
  assert.match(named, /^data\/targets\.[0-9a-f]{10}\.bin$/, 'an extension the edge keeps');
  const res = await get(`/${named}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), IMMUTABLE_RE);
  assert.match(res.headers.get('content-type'), /json/);
  assert.deepEqual(await res.json(), await (await get('/data/targets.json')).json());
  const stale = await get('/data/targets.0000000000.bin');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('cache-control'), 'no-cache');
  assert.equal((await get('/data/nothing.0000000000.bin')).status, 404);
  // A picture and a binary file keep their own extension under their hash.
  for (const path of ['data/sky/milkyway.png', 'data/fly/stars.bin']) {
    const hit = await get(`/${DATA_NAMES[path]}`);
    assert.equal(hit.status, 200, path);
    assert.match(hit.headers.get('cache-control'), IMMUTABLE_RE, path);
    assert.equal(Buffer.compare(Buffer.from(await hit.arrayBuffer()), Buffer.from(await (await get(`/${path}`)).arrayBuffer())), 0, path);
  }
  assert.ok([403, 404].includes((await get('/data/..%2f..%2fpackage.0000000000.bin')).status));
});

test('the sky relay passes on only files the all-sky cube has', async () => {
  // Each of these is refused before IRSA is asked: a wrong order, a directory
  // that does not hold that index, an index past the order, a frame past the
  // cube, an Allsky at an order that has none, a way out of the cube, and
  // numbers with leading zeros, which would keep one tile under two names.
  for (const path of [
    'Norder6/Dir0/Npix1.png', 'Norder3/Dir10000/Npix300.png', 'Norder3/Dir0/Npix768.png',
    'Norder3/Dir0/Npix300_102.png', 'Norder3/Dir0/Npix300_0.png', 'Norder4/Allsky.png',
    'Norder3/Dir0/../../../properties', 'Norder3/Dir0/Npix300.fits', 'properties',
    'Norder3/Dir00/Npix300.png', 'Norder3/Dir0/Npix0300.png', 'Norder3/Dir0/Npix300_01.png',
    'Norder3/Allsky_007.png', 'Norder03/Allsky.png',
  ]) {
    const res = await get(`/api/hips/${path}`);
    assert.equal(res.status, 404, path);
  }
});

test('the headset page is served with the same policy, and its library under the tag for good', async () => {
  const page = await get('/vr.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  const html = await page.text();
  const tag = html.match(/js\/vr\/main\.js\?v=([0-9a-f]+)/)?.[1];
  assert.ok(tag, 'the page names its code under a tag');
  assert.equal(tag, await pageTag());
  const three = await get(`/js/vendor/three.module.js?v=${tag}`);
  assert.equal(three.status, 200);
  assert.match(three.headers.get('content-type'), /javascript/);
  assert.match(three.headers.get('cache-control'), IMMUTABLE_RE);
  // Its import of the core carries the tag too, so the core is kept as well.
  assert.match(await three.text(), new RegExp(`three\\.core\\.js\\?v=${tag}`));
  assert.match((await get(`/js/vendor/three.core.js?v=${tag}`)).headers.get('cache-control'), IMMUTABLE_RE);
});

// Before the tests below move file dates about: the page's tag is reread
// at most every 30 s, and must match the disk here.
test('a page load\'s worth of tagged requests at once all get the current tag', async () => {
  const tag = await pageTag();
  const names = ['app', 'sky', 'stamp', 'catalog', 'wcs', 'fits', 'render', 'net'];
  const all = await Promise.all(Array.from({ length: 40 }, (_, k) => get(`/js/${names[k % names.length]}.js?v=${tag}`)));
  for (const res of all) assert.match(res.headers.get('cache-control'), IMMUTABLE_RE);
});

test('code changed on disk is never kept under the tag from before the change', async () => {
  const { stat, utimes } = await import('node:fs/promises');
  const tag = await pageTag();
  await get(`/js/app.js?v=${tag}`);
  const file = fileURLToPath(new URL('../public/css/tokens.css', import.meta.url));
  const { atime, mtime } = await stat(file);
  try {
    await utimes(file, atime, new Date(mtime.getTime() + 5000));
    // At once, inside any recheck window: the old tag no longer names what is on disk.
    assert.doesNotMatch((await get(`/css/tokens.css?v=${tag}`)).headers.get('cache-control'), IMMUTABLE_RE);
    assert.doesNotMatch((await get(`/js/sky.js?v=${tag}`)).headers.get('cache-control'), IMMUTABLE_RE);
    const fresh = await pageTag();
    assert.notEqual(fresh, tag);
    assert.match((await get(`/js/sky.js?v=${fresh}`)).headers.get('cache-control'), IMMUTABLE_RE);
  } finally {
    await utimes(file, atime, mtime);
  }
});

test('a picture keeps its ETag across a code deploy', async () => {
  const { stat, utimes } = await import('node:fs/promises');
  const img = '/img/fields/atala.png';
  assert.ok((await get(img)).ok);
  const before = (await get(img)).headers.get('etag');
  const file = fileURLToPath(new URL('../public/css/tokens.css', import.meta.url));
  const { atime, mtime } = await stat(file);
  try {
    await utimes(file, atime, new Date(mtime.getTime() + 7000));
    await pageTag();
    assert.equal((await get(img)).headers.get('etag'), before);
  } finally {
    await utimes(file, atime, mtime);
  }
});

test('code changed in a folder under js/ changes the tag', async () => {
  const { stat, utimes } = await import('node:fs/promises');
  const tag = await pageTag();
  const file = fileURLToPath(new URL('../public/js/vr/main.js', import.meta.url));
  const { atime, mtime } = await stat(file);
  try {
    await utimes(file, atime, new Date(mtime.getTime() + 9000));
    assert.doesNotMatch((await get(`/js/vr/main.js?v=${tag}`)).headers.get('cache-control'), IMMUTABLE_RE);
    assert.notEqual(await pageTag(), tag);
  } finally {
    await utimes(file, atime, mtime);
  }
});

test('a coordinate is a plain decimal number, not whatever Number() accepts', async () => {
  for (const query of ['ra=1e1&dec=0x10', 'ra=10&dec=0x10', 'ra=1e1&dec=5', 'ra=10.&dec=5', 'ra=Infinity&dec=5']) {
    assert.equal((await get(`/api/search?${query}`)).status, 400, query);
    assert.equal((await get(`/api/tap?cat=gaia&${query}&r=0.01`)).status, 400, query);
  }
  assert.equal((await get('/api/search?ra=+13.4194&dec=3.8459')).status, 200);
});

test('a missing file is a 404 in plain text', async () => {
  const res = await get('/no-such-file.txt');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
});

test('an answer from the own cache of the server may be kept for a few minutes, an error never', async () => {
  const dir = join(fileURLToPath(new URL('..', import.meta.url)), '.cache');
  const file = join(dir, `tap_gaia${columnsTag(CATALOGUES.gaia.irsa)}_269.4500_4.6900_0.01_9_all.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ rows: [], via: 'test' }), 'utf8');
  try {
    const hit = await get('/api/tap?cat=gaia&ra=269.45&dec=4.69&r=0.01');
    assert.equal(hit.status, 200);
    assert.equal((await hit.json()).cached, true);
    assert.equal(hit.headers.get('cache-control'), 'private, max-age=300');
  } finally {
    await rm(file, { force: true });
  }
  const refused = await get('/api/tap?cat=gaia&ra=&dec=4.69&r=0.01');
  assert.equal(refused.headers.get('cache-control'), 'no-cache');
});

/* ------------------------------------------------ the frame search, IRSA faked */

/**
 * A second server whose frame search asks a fake IRSA on this machine, so the
 * archive can be made slow, down or half-down on purpose. Its cache is a
 * folder of its own, thrown away after.
 */
describe('frame search against a fake IRSA', () => {
  const SEARCH_PORT = PORT + 1;
  const SEARCH_BASE = `http://127.0.0.1:${SEARCH_PORT}`;
  const cacheDir = join(tmpdir(), `muninn-search-test-${process.pid}`);
  /** How the fake answers, by `${collection} ${ra}` or `* ${ra}`: steps, the last one repeated. */
  const plan = new Map();
  const hits = new Map();
  let fake;
  let relayed;

  const votable = (collection, ra, dec, n) => {
    const fields = ['obs_id', 't_min', 'energy_bandpassname', 'access_url', 'dataproduct_subtype',
      'calib_level', 'obs_collection', 's_ra', 's_dec', 'em_min', 'em_max', 't_exptime'];
    const rows = Array.from({ length: n }, (_, i) => [
      `${collection}_${i}`, 60800 + i, 'SPHEREx-D2', `https://example.invalid/${collection}/${ra}/${i}.fits`,
      'science', 3, collection, ra, dec, 1.1e-6, 1.6e-6, 100,
    ]);
    return '<?xml version="1.0"?><VOTABLE><RESOURCE type="results">'
      + '<INFO name="QUERY_STATUS" value="OK"/><TABLE>'
      + fields.map((f) => `<FIELD name="${f}" datatype="char"/>`).join('')
      + `<DATA><TABLEDATA>${rows.map((r) => `<TR>${r.map((v) => `<TD>${v}</TD>`).join('')}</TR>`).join('')}`
      + '</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>';
  };

  /** How the fake TAP answers, by `${collection} ${ra}`: { status, csv }. Unplanned: 503. */
  const tapPlan = new Map();
  const tapHits = new Map();

  /** The fake TAP's ObsCore answer and the fake S3 mirror's listing. */
  async function answerTap(req, res) {
    let body = '';
    for await (const chunk of req) body += chunk;
    const query = new URLSearchParams(body).get('QUERY') ?? '';
    const collection = /obs_collection = '([\w]+)'/.exec(query)?.[1];
    const ra = Number(/CIRCLE\('ICRS', ([\d.]+),/.exec(query)?.[1]);
    const at = `${collection} ${ra}`;
    tapHits.set(at, (tapHits.get(at) ?? 0) + 1);
    const step = tapPlan.get(at) ?? { status: 503 };
    res.writeHead(step.status, { 'content-type': 'text/csv' });
    res.end(step.csv ?? 'Service unavailable');
  }
  function answerS3(url, res) {
    const prefix = url.searchParams.get('prefix');
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<ListBucketResult><CommonPrefixes><Prefix>${prefix}l2b-test/</Prefix></CommonPrefixes></ListBucketResult>`);
  }

  before(async () => {
    await mkdir(cacheDir, { recursive: true });
    fake = createServer((req, res) => {
      const url = new URL(req.url, 'http://fake');
      if (url.pathname.startsWith('/TAP')) { answerTap(req, res); return; }
      if (url.pathname.startsWith('/S3')) { answerS3(url, res); return; }
      const collection = url.searchParams.get('COLLECTION');
      const [, ra, dec] = url.searchParams.get('POS').split(' ');
      const at = `${collection} ${ra}`;
      const n = hits.get(at) ?? 0;
      hits.set(at, n + 1);
      const steps = plan.get(at) ?? plan.get(`* ${ra}`) ?? [{ status: 200 }];
      const step = steps[Math.min(n, steps.length - 1)];
      setTimeout(() => {
        if (res.destroyed) return;
        if (step.status !== 200) { res.writeHead(step.status); res.end('Bad gateway'); return; }
        res.writeHead(200, { 'content-type': 'text/xml' });
        // A page that is not a table at all, sent as 200.
        if (step.body !== undefined) { res.end(step.body); return; }
        const table = votable(collection, Number(ra), Number(dec), step.rows ?? 3);
        // Half a table, then the connection dropped.
        if (step.cut) { res.write(table.slice(0, table.length >> 1)); res.socket.destroy(); return; }
        res.end(table);
      }, step.delay ?? 0);
    });
    await new Promise((resolve) => { fake.listen(0, '127.0.0.1', resolve); });
    relayed = spawn(process.execPath, ['server.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        PORT: String(SEARCH_PORT),
        HOST: '127.0.0.1',
        MUNINN_SIA_URL: `http://127.0.0.1:${fake.address().port}/SIA`,
        MUNINN_TAP_URL: `http://127.0.0.1:${fake.address().port}/TAP/sync`,
        MUNINN_S3_URL: `http://127.0.0.1:${fake.address().port}/S3/`,
        MUNINN_INDEX_DIR: NO_INDEX,
        MUNINN_CACHE_DIR: cacheDir,
        MUNINN_RETRY_MS: '20,40',
        MUNINN_ATTEMPT_MS: '300',
        MUNINN_RETRY_LATER_MS: '150',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('search server did not start')), 10000);
      relayed.stdout.on('data', (chunk) => {
        if (String(chunk).includes(`:${SEARCH_PORT}`)) { clearTimeout(timer); resolve(); }
      });
    });
  });

  after(async () => {
    relayed?.kill();
    fake?.closeAllConnections?.();
    fake?.close();
    await rm(cacheDir, { recursive: true, force: true });
  });

  const search = async (ra, dec, extra = '') => {
    const res = await fetch(`${SEARCH_BASE}/api/search?ra=${ra}&dec=${dec}${extra}`);
    return { res, body: await res.json() };
  };
  const hitsAt = (ra) => COLLECTIONS.map((c) => hits.get(`${c} ${ra}`) ?? 0);
  const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const waitFor = async (check) => {
    for (let i = 0; i < 100 && !check(); i += 1) await pause(20);
  };

  /** A list kept on disk ten days ago, past its days, in the form the server writes. */
  async function keepOld(collection, ra, dec, frames) {
    const key = `frames_${collection}_${ra.toFixed(4)}_${dec.toFixed(4)}_${(0.006).toFixed(4)}`;
    const file = join(cacheDir, `${key}.json`);
    await writeFile(file, JSON.stringify({ frames, truncated: false }), 'utf8');
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    await touch(file, old, old);
  }
  const oldFrame = (collection, i) => ({
    obsId: `old_${i}`, mjd: 60000 + i, band: 'D2', collection, url: `https://example.invalid/old/${collection}/${i}.fits`,
  });

  test('search: a 502 from IRSA is asked again, and the answer is whole', async () => {
    plan.set('spherex_dr1 101.5', [{ status: 502 }, { status: 502 }, { status: 200 }]);
    const { body } = await search(101.5, 10);
    assert.equal(body.ok, true);
    assert.equal(body.partial, false);
    assert.deepEqual(body.missing, []);
    assert.equal(body.stale, false);
    assert.equal(body.frames.length, 12);
    assert.deepEqual(hitsAt(101.5), [3, 1, 1, 1]);
  });

  test('search: a question that times out is asked again', async () => {
    plan.set('spherex_qr3 102.5', [{ status: 200, delay: 1000 }, { status: 200 }]);
    const { body } = await search(102.5, 10);
    assert.equal(body.ok, true);
    assert.equal(body.frames.length, 12);
    assert.equal(hits.get('spherex_qr3 102.5'), 2);
  });

  test('search: a collection that keeps failing is named as missing, and can be asked for alone', async () => {
    plan.set('spherex_qr3_deep 103.5', [{ status: 504 }]);
    const { res, body } = await search(103.5, 10);
    assert.equal(body.ok, true);
    assert.equal(body.partial, true);
    assert.deepEqual(body.missing, ['spherex_qr3_deep']);
    assert.equal(body.warnings.length, 1);
    assert.equal(body.frames.length, 9);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    // The first ask and two retries, no more while the page waits.
    assert.equal(hits.get('spherex_qr3_deep 103.5'), 3);

    // IRSA recovers; the server asks again by itself, and keeps the answer.
    plan.set('spherex_qr3_deep 103.5', [{ status: 200 }]);
    await waitFor(() => hits.get('spherex_qr3_deep 103.5') === 4);
    await pause(50);
    const whole = await search(103.5, 10);
    assert.equal(whole.body.partial, false);
    assert.equal(whole.body.frames.length, 12);
    assert.deepEqual(hitsAt(103.5), [1, 1, 1, 4]);
    assert.match(whole.res.headers.get('cache-control'), /public, max-age=\d+/);
  });

  test('search: the missing part alone can be asked for again', async () => {
    plan.set('spherex_qr3 108.5', [{ status: 502 }, { status: 502 }, { status: 502 }, { status: 200 }]);
    const { body } = await search(108.5, 10);
    assert.deepEqual(body.missing, ['spherex_qr3']);
    const again = await search(108.5, 10, `&collections=${body.missing.join(',')}`);
    assert.equal(again.body.ok, true);
    assert.equal(again.body.partial, false);
    assert.deepEqual(again.body.missing, []);
    assert.deepEqual(again.body.queried.collections, ['spherex_qr3']);
    assert.equal(again.body.frames.length, 3);
    assert.ok(again.body.frames.every((f) => f.collection === 'spherex_qr3'));
  });

  test('search: DR1 alone opens a field while both QR3 collections are down', async () => {
    plan.set('spherex_qr3 109.5', [{ status: 502 }]);
    plan.set('spherex_qr3_deep 109.5', [{ status: 502 }]);
    plan.set('spherex_dr1_deep 109.5', [{ status: 200, rows: 0 }]);
    const { res, body } = await search(109.5, 10);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.partial, true);
    assert.deepEqual(body.missing, ['spherex_qr3', 'spherex_qr3_deep']);
    assert.equal(body.frames.length, 3);
  });

  test('search: an unknown collection is refused', async () => {
    assert.equal((await search(103.5, 10, '&collections=spherex_dr9')).res.status, 400);
  });

  test('search: every collection failing with nothing kept is an error that names them all', async () => {
    plan.set('* 104.5', [{ status: 500 }]);
    const { body } = await search(104.5, 10);
    assert.equal(body.ok, false);
    assert.equal(body.partial, false);
    assert.deepEqual(body.missing, COLLECTIONS);
    // A 500 is an answer, not a gateway hiccup: asked once.
    assert.deepEqual(hitsAt(104.5), [1, 1, 1, 1]);
  });

  test('search: the same question five times at once goes to IRSA once', async () => {
    plan.set('* 105.5', [{ status: 200, delay: 150 }]);
    const answers = await Promise.all(Array.from({ length: 5 }, () => search(105.5, 10)));
    for (const { body } of answers) {
      assert.equal(body.ok, true);
      assert.equal(body.frames.length, 12);
    }
    assert.deepEqual(hitsAt(105.5), [1, 1, 1, 1]);
  });

  test('search: with IRSA down, a list past its days is served at once, marked stale with its age', async () => {
    for (const c of COLLECTIONS) await keepOld(c, 106.5, 10, [oldFrame(c, 1), oldFrame(c, 2)]);
    plan.set('* 106.5', [{ status: 502 }]);
    const first = await search(106.5, 10);
    assert.equal(first.res.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.stale, true);
    assert.equal(first.body.partial, false);
    assert.equal(first.body.frames.length, 8);
    assert.ok(Math.abs(first.body.staleAgeS - 10 * 24 * 3600) < 120, String(first.body.staleAgeS));
    assert.equal(first.res.headers.get('x-muninn-stale-age'), String(first.body.staleAgeS));
    assert.equal(first.res.headers.get('cache-control'), 'no-cache');

    // The refresh behind it fails, three asks a collection, and the kept list stands.
    await waitFor(() => hitsAt(106.5).every((n) => n === 3));
    assert.deepEqual(hitsAt(106.5), [3, 3, 3, 3]);
    await pause(100);
    const second = await search(106.5, 10);
    assert.equal(second.body.stale, true);
    assert.equal(second.body.frames.length, 8);
    // Not asked again straight after a failed refresh.
    assert.deepEqual(hitsAt(106.5), [3, 3, 3, 3]);
  });

  test('search: a stale list is refreshed in the background, and the next answer is current', async () => {
    for (const c of COLLECTIONS) await keepOld(c, 107.5, 10, [oldFrame(c, 1)]);
    const first = await search(107.5, 10);
    assert.equal(first.body.stale, true);
    assert.equal(first.body.frames.length, 4);
    await waitFor(() => hitsAt(107.5).every((n) => n === 1));
    await pause(100);
    const second = await search(107.5, 10);
    assert.equal(second.body.stale, false);
    assert.equal(second.body.staleAgeS, 0);
    assert.equal(second.body.frames.length, 12);
  });

  test('search: a maintenance page sent as 200 is a failure, never kept as "no frames here"', async () => {
    plan.set('spherex_dr1 110.5', [{ status: 200, body: '<html><body>IRSA is down for maintenance</body></html>' }]);
    const { body } = await search(110.5, 10);
    assert.equal(body.ok, true);
    assert.deepEqual(body.missing, ['spherex_dr1']);
    assert.match(body.warnings[0], /not a whole VOTable/);
    assert.equal(hits.get('spherex_dr1 110.5'), 3, 'asked again like a dropped connection');
    // Back up: the next answer is whole, so nothing empty was kept meanwhile.
    plan.set('spherex_dr1 110.5', [{ status: 200 }]);
    await waitFor(() => hits.get('spherex_dr1 110.5') >= 4);
    await pause(50);
    const again = await search(110.5, 10);
    assert.equal(again.body.partial, false);
    assert.equal(again.body.frames.length, 12);
  });

  test('search: a table cut off mid-answer is asked again, and the relay keeps serving', async () => {
    plan.set('spherex_qr3 111.5', [{ status: 200, cut: true }, { status: 200 }]);
    const { body } = await search(111.5, 10);
    assert.equal(body.ok, true);
    assert.equal(body.partial, false);
    assert.equal(body.frames.length, 12);
    assert.equal(hits.get('spherex_qr3 111.5'), 2);
    assert.equal(relayed.exitCode, null, 'the process is still up');
    assert.equal((await fetch(`${SEARCH_BASE}/api/search?ra=13.4194&dec=3.8459`)).status, 200);
  });

  test('search: every collection cut off is said as JSON, and the process stays up', async () => {
    plan.set('* 112.5', [{ status: 200, cut: true }]);
    const { res, body } = await search(112.5, 10);
    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.deepEqual(body.missing, COLLECTIONS);
    assert.equal(relayed.exitCode, null);
  });

  test("search: with the SIA failing, IRSA's TAP answers, the footprint rule applied and the file named from the mirror", async () => {
    plan.set('* 113.5', [{ status: 502 }]);
    tapPlan.set('spherex_dr1 113.5', {
      status: 200,
      csv: obscoreCsv([
        obscoreRow('2025W30_1A_0001_1', 'spherex_dr1', 114.5, 10.5),
        obscoreRow('2025W30_1A_0002_1', 'spherex_dr1', 116.5, 10),
      ]),
    });
    const { res, body } = await search(113.5, 10);
    assert.equal(body.ok, true);
    assert.equal(body.source, 'irsa-tap');
    assert.equal(body.partial, true);
    assert.deepEqual(body.missing, ['spherex_dr1_deep', 'spherex_qr3', 'spherex_qr3_deep']);
    assert.deepEqual(body.frames.map((f) => f.obsId), ['2025W30_1A_0001_1']);
    assert.equal(body.frames[0].url,
      'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W30_1A/l2b-test/2/level2_2025W30_1A_0001_1D2_spx_l2b-test.fits');
    assert.equal(body.frames[0].band, 'D2');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    // Asked once the SIA had failed, its three asks done.
    assert.equal(tapHits.get('spherex_dr1 113.5'), 1);
    assert.equal(hits.get('spherex_dr1 113.5'), 3);
  });
});

/* ------------------------------------------- the sky relay against a fake IRSA */

describe('the sky relay against a fake IRSA', () => {
  test('a tile IRSA does not have is asked for once, then answered from memory', async () => {
    const port = PORT + 21;
    const cacheDir = join(tmpdir(), `muninn-hips-test-${process.pid}`);
    await mkdir(cacheDir, { recursive: true });
    const asked = [];
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(0)]);
    const fake = createServer((req, res) => {
      asked.push(req.url);
      if (req.url.endsWith('/Npix5.png')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return; }
      res.writeHead(404);
      res.end('no');
    });
    await new Promise((resolve) => { fake.listen(0, '127.0.0.1', resolve); });
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env, PORT: String(port), HOST: '127.0.0.1', MUNINN_CACHE_DIR: cacheDir, MUNINN_INDEX_DIR: NO_INDEX,
        MUNINN_HIPS_URL: `http://127.0.0.1:${fake.address().port}/hips/`,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
        proc.stdout.on('data', (chunk) => { if (String(chunk).includes(`:${port}`)) { clearTimeout(timer); resolve(); } });
      });
      const tile = (path) => fetch(`http://127.0.0.1:${port}/api/hips/${path}`);
      for (let i = 0; i < 3; i += 1) {
        const res = await tile('Norder3/Dir0/Npix4.png');
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('x-muninn-hips'), '1');
      }
      assert.deepEqual(asked, ['/hips/Norder3/Dir0/Npix4.png']);
      // A tile it has is passed on, and kept.
      for (let i = 0; i < 2; i += 1) {
        const res = await tile('Norder3/Dir0/Npix5.png');
        assert.equal(res.status, 200);
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
      }
      assert.equal(asked.length, 2);
    } finally {
      proc.kill();
      fake.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------- the memory the cache keeps */

describe('the in-memory cache under a byte ceiling', () => {
  test('a tiny ceiling still answers every question, from disk', async () => {
    const port = PORT + 2;
    const cacheDir = join(tmpdir(), `muninn-mem-test-${process.pid}`);
    await mkdir(cacheDir, { recursive: true });
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', MUNINN_CACHE_DIR: cacheDir, MUNINN_MEMORY_MAX_BYTES: '10', MUNINN_INDEX_DIR: NO_INDEX },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
        proc.stdout.on('data', (chunk) => { if (String(chunk).includes(`:${port}`)) { clearTimeout(timer); resolve(); } });
      });
      const key = `frames_spherex_dr1_120.5000_10.0000_${(0.006).toFixed(4)}`;
      await writeFile(join(cacheDir, `${key}.json`), JSON.stringify({ frames: [{ obsId: 'a', mjd: 1, url: 'u1' }], truncated: false }));
      for (let i = 0; i < 3; i += 1) {
        const body = await (await fetch(`http://127.0.0.1:${port}/api/search?ra=120.5&dec=10&collections=spherex_dr1`)).json();
        assert.equal(body.ok, true);
        assert.equal(body.frames.length, 1);
      }
    } finally {
      proc.kill();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

/** A 3.5° square frame centred at (ra, dec), as ObsCore writes a footprint. */
function square(ra, dec, half = 1.75) {
  const w = half / Math.cos((dec * Math.PI) / 180);
  return `POLYGON ICRS ${ra - w} ${dec - half} ${ra + w} ${dec - half} ${ra + w} ${dec + half} ${ra - w} ${dec + half} ${ra - w} ${dec - half}`;
}

const OBSCORE_FIELDS = ['obs_id', 'obs_collection', 'energy_bandpassname', 'em_min', 'em_max', 't_min', 't_exptime', 's_ra', 's_dec', 's_region'];

function obscoreRow(obsId, collection, ra, dec, mjd = 60900) {
  return {
    obs_id: obsId, obs_collection: collection, energy_bandpassname: 'SPHEREx-D2', em_min: '1.1033e-06', em_max: '1.6499e-06',
    t_min: String(mjd), t_exptime: '113.5826', s_ra: String(ra), s_dec: String(dec), s_region: square(ra, dec),
  };
}

const obscoreCsv = (rows) => [OBSCORE_FIELDS.join(','), ...rows.map((r) => OBSCORE_FIELDS.map((f) => r[f]).join(','))].join('\n');

describe('frame search with an own frame index', () => {
  const INDEX_PORT = PORT + 3;
  const INDEX_BASE = `http://127.0.0.1:${INDEX_PORT}`;
  const indexDir = join(tmpdir(), `muninn-index-test-${process.pid}`);
  const cacheDir = join(tmpdir(), `muninn-index-cache-${process.pid}`);
  const BUILT = '2026-11-14T10:00:00.000Z';
  /** How the fake SIA answers, by ra: { status, delay }. */
  const plan = new Map();
  const hits = new Map();
  let tapAsked = 0;
  let fake;
  let relayed;

  const votable = (collection, ra) => {
    const fields = ['obs_id', 't_min', 'energy_bandpassname', 'access_url', 'dataproduct_subtype', 'calib_level', 'obs_collection', 's_ra', 's_dec'];
    const rows = [0, 1, 2].map((i) => [`${collection}_${i}`, 60800 + i, 'SPHEREx-D2', `https://example.invalid/${collection}/${ra}/${i}.fits`, 'science', 2, collection, ra, 10]);
    return '<?xml version="1.0"?><VOTABLE><RESOURCE type="results"><INFO name="QUERY_STATUS" value="OK"/><TABLE>'
      + fields.map((f) => `<FIELD name="${f}" datatype="char"/>`).join('')
      + `<DATA><TABLEDATA>${rows.map((r) => `<TR>${r.map((v) => `<TD>${v}</TD>`).join('')}</TR>`).join('')}`
      + '</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>';
  };

  /** Each field: one DR1 frame over it, one beside it, and one QR3 frame over it. */
  async function writeIndex() {
    const meta = { collections: COLLECTIONS, versions: ['l2b-test'] };
    const cells = new Map();
    for (const ra of [120.5, 131.5, 140.5]) {
      const tag = String(ra).replace('.', '');
      const rows = [
        obscoreRow(`2025W30_1A_${tag}_1`, 'spherex_dr1', ra + 1, 10.5),
        obscoreRow(`2025W30_1A_${tag}_2`, 'spherex_dr1', ra + 3, 10, 60901),
        obscoreRow(`2026W30_1A_${tag}_1`, 'spherex_qr3', ra - 1, 9, 61250),
      ];
      for (const row of rows) {
        const stored = indexRowFromObscore(row, COLLECTIONS, 0);
        const tile = tileOf(stored[ROW.ra], stored[ROW.dec]);
        if (!cells.has(tile)) cells.set(tile, []);
        cells.get(tile).push(stored);
      }
    }
    for (const [tile, rows] of cells) {
      const band = tile.split('-')[0];
      await mkdir(join(indexDir, 'tiles', band), { recursive: true });
      await writeFile(join(indexDir, 'tiles', band, `${tile}.json.gz`), gzipSync(JSON.stringify(rows)));
    }
    const counts = Object.fromEntries(COLLECTIONS.map((c) => [c, 1]));
    await writeFile(join(indexDir, 'meta.json'), JSON.stringify({ ...meta, format: 1, builtAt: BUILT, reachDeg: 2.6, counts, rows: 6 }));
  }

  before(async () => {
    await mkdir(cacheDir, { recursive: true });
    await writeIndex();
    fake = createServer((req, res) => {
      const url = new URL(req.url, 'http://fake');
      if (url.pathname.startsWith('/TAP')) { tapAsked += 1; res.writeHead(503); res.end(); return; }
      const collection = url.searchParams.get('COLLECTION');
      const ra = Number(url.searchParams.get('POS').split(' ')[1]);
      hits.set(ra, (hits.get(ra) ?? 0) + 1);
      const step = plan.get(`${collection} ${ra}`) ?? plan.get(ra) ?? { status: 200 };
      setTimeout(() => {
        if (res.destroyed) return;
        if (step.status !== 200) { res.writeHead(step.status); res.end('Bad gateway'); return; }
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(votable(collection, ra));
      }, step.delay ?? 0);
    });
    await new Promise((resolve) => { fake.listen(0, '127.0.0.1', resolve); });
    relayed = spawn(process.execPath, ['server.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        PORT: String(INDEX_PORT),
        HOST: '127.0.0.1',
        MUNINN_SIA_URL: `http://127.0.0.1:${fake.address().port}/SIA`,
        MUNINN_TAP_URL: `http://127.0.0.1:${fake.address().port}/TAP/sync`,
        MUNINN_INDEX_DIR: indexDir,
        MUNINN_CACHE_DIR: cacheDir,
        MUNINN_RETRY_MS: '20,40',
        MUNINN_ATTEMPT_MS: '5000',
        MUNINN_RETRY_LATER_MS: '150',
        MUNINN_INDEX_AFTER_MS: '300',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('index server did not start')), 10000);
      relayed.stdout.on('data', (chunk) => {
        if (String(chunk).includes(`:${INDEX_PORT}`)) { clearTimeout(timer); resolve(); }
      });
    });
  });

  after(async () => {
    relayed?.kill();
    fake?.closeAllConnections?.();
    fake?.close();
    await rm(cacheDir, { recursive: true, force: true });
    await rm(indexDir, { recursive: true, force: true });
  });

  const search = async (ra, dec, extra = "") => {
    const res = await fetch(`${INDEX_BASE}/api/search?ra=${ra}&dec=${dec}${extra}`);
    return { res, body: await res.json() };
  };

  test('search: with IRSA failing, the own index answers, by the footprint rule, and says of when', async () => {
    plan.set(120.5, { status: 502 });
    const { res, body } = await search(120.5, 10);
    assert.equal(body.ok, true);
    assert.equal(body.source, 'own-index');
    assert.equal(body.indexDate, BUILT);
    assert.deepEqual(body.fromIndex, COLLECTIONS);
    assert.equal(body.partial, false);
    assert.deepEqual(body.missing, []);
    assert.deepEqual(body.frames.map((f) => f.obsId), ['2025W30_1A_1205_1', '2026W30_1A_1205_1']);
    assert.deepEqual(body.frames.map((f) => f.collection), ['spherex_dr1', 'spherex_qr3']);
    assert.equal(body.frames[1].url,
      'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/2026W30_1A/l2b-test/2/level2_2026W30_1A_1205_1D2_spx_l2b-test.fits');
    // Not kept by the browser: IRSA's own list is asked for again behind it.
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    // With an own index, IRSA's slow TAP is not asked.
    assert.equal(tapAsked, 0);
  });

  test('search: a slow IRSA is answered for by the own index, and its list is kept for the next ask', async () => {
    plan.set(131.5, { status: 200, delay: 1200 });
    const began = Date.now();
    const first = await search(131.5, 10);
    assert.ok(Date.now() - began < 1100, `took ${Date.now() - began} ms`);
    assert.equal(first.body.source, 'own-index');
    assert.equal(first.body.frames.length, 2);
    await new Promise((r) => { setTimeout(r, 1500); });
    const second = await search(131.5, 10);
    assert.equal(second.body.source, 'irsa');
    assert.equal(second.body.indexDate, undefined);
    assert.equal(second.body.frames.length, 12);
    assert.equal(hits.get(131.5), 4);
  });

  test('search: IRSA answering in time is answered with, at once, the own index unused', async () => {
    const began = Date.now();
    const { body } = await search(122.5, 10);
    assert.ok(Date.now() - began < 250, `a healthy SIA waited ${Date.now() - began} ms`);
    assert.equal(body.source, 'irsa');
    assert.equal(body.frames.length, 12);
  });

  test('search: a frame IRSA has and the index does not appears on the next ask, once IRSA is back', async () => {
    plan.set(140.5, { status: 502 });
    const first = await search(140.5, 10);
    assert.equal(first.body.source, 'own-index');
    assert.equal(first.body.indexDate, BUILT);
    assert.ok(!first.body.frames.some((f) => f.obsId === 'spherex_dr1_0'));
    // IRSA recovers; the relay's own retry behind the answer keeps its list.
    plan.set(140.5, { status: 200 });
    const before = hits.get(140.5);
    await waitUntil(() => hits.get(140.5) >= before + 4);
    await new Promise((r) => { setTimeout(r, 100); });
    const second = await search(140.5, 10);
    assert.equal(second.body.source, 'irsa');
    assert.ok(second.body.frames.some((f) => f.obsId === 'spherex_dr1_0'), 'the frame only IRSA lists');
    assert.equal(second.body.frames.length, 12);
  });

  test('search: one collection from the index beside three from IRSA is said, collection by collection', async () => {
    plan.set('spherex_qr3 120.5', { status: 502 });
    plan.delete(120.5);
    const { res, body } = await search(120.5, 10, '&radius=0.007');
    assert.equal(body.source, 'own-index');
    assert.deepEqual(body.fromIndex, ['spherex_qr3']);
    assert.equal(body.partial, false);
    assert.deepEqual(body.frames.map((f) => f.collection).sort(),
      ['spherex_dr1', 'spherex_dr1', 'spherex_dr1', 'spherex_dr1_deep', 'spherex_dr1_deep', 'spherex_dr1_deep',
        'spherex_qr3', 'spherex_qr3_deep', 'spherex_qr3_deep', 'spherex_qr3_deep']);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });
});

async function waitUntil(check, ms = 5000) {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((r) => { setTimeout(r, 20); });
}

describe('frame search with a missing or broken own index', () => {
  const base = join(tmpdir(), `muninn-broken-index-${process.pid}`);
  let fake;

  /** The fake IRSA: the SIA always 502, TAP one DR1 frame over every position, the mirror one version. */
  before(async () => {
    fake = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://fake');
      if (url.pathname.startsWith('/S3')) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(`<ListBucketResult><CommonPrefixes><Prefix>${url.searchParams.get('prefix')}l2b-test/</Prefix></CommonPrefixes></ListBucketResult>`);
        return;
      }
      if (url.pathname.startsWith('/TAP')) {
        let body = '';
        for await (const chunk of req) body += chunk;
        const query = new URLSearchParams(body).get('QUERY') ?? '';
        const ra = Number(/CIRCLE\('ICRS', ([\d.]+),/.exec(query)?.[1]);
        if (!query.includes("'spherex_dr1'")) { res.writeHead(503); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/csv' });
        res.end(obscoreCsv([obscoreRow('2025W30_1A_0009_1', 'spherex_dr1', ra + 0.5, 10)]));
        return;
      }
      res.writeHead(502);
      res.end('Bad gateway');
    });
    await new Promise((resolve) => { fake.listen(0, '127.0.0.1', resolve); });
  });

  after(async () => {
    fake?.closeAllConnections?.();
    fake?.close();
    await rm(base, { recursive: true, force: true });
  });

  /** A relay on its own port and index folder; everything it logs, collected. */
  async function relayWith(port, indexDir) {
    const logs = [];
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        MUNINN_SIA_URL: `http://127.0.0.1:${fake.address().port}/SIA`,
        MUNINN_TAP_URL: `http://127.0.0.1:${fake.address().port}/TAP/sync`,
        MUNINN_S3_URL: `http://127.0.0.1:${fake.address().port}/S3/`,
        MUNINN_INDEX_DIR: indexDir,
        MUNINN_CACHE_DIR: join(base, `cache-${port}`),
        MUNINN_RETRY_MS: '20,40',
        MUNINN_RETRY_LATER_MS: '60000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', (c) => logs.push(String(c)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay did not start')), 10000);
      proc.stdout.on('data', (c) => {
        logs.push(String(c));
        if (String(c).includes(`:${port}`)) { clearTimeout(timer); resolve(); }
      });
    });
    return { proc, logs, text: () => logs.join('') };
  }

  /** IRSA's SIA failing, the answer comes from the TAP route, and the relay is still up. */
  async function fallsBackToTap(port, relay, ra) {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/search?ra=${ra}&dec=10`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.source, 'irsa-tap');
    assert.deepEqual(body.frames.map((f) => f.obsId), ['2025W30_1A_0009_1']);
    assert.equal(relay.proc.exitCode, null, 'still up');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/search?ra=13.4194&dec=3.8459`)).status, 200);
  }

  async function writeGoodIndex(dir) {
    const row = indexRowFromObscore(obscoreRow('2025W30_1A_0001_1', 'spherex_dr1', 160.5, 10), COLLECTIONS, 0);
    const tile = tileOf(row[ROW.ra], row[ROW.dec]);
    await mkdir(join(dir, 'tiles', tile.split('-')[0]), { recursive: true });
    await writeFile(join(dir, 'tiles', tile.split('-')[0], `${tile}.json.gz`), gzipSync(JSON.stringify([row])));
    const counts = Object.fromEntries(COLLECTIONS.map((c) => [c, 1]));
    await writeFile(join(dir, 'meta.json'), JSON.stringify({
      format: 1, builtAt: '2026-11-14T10:00:00.000Z', reachDeg: 2.6, collections: COLLECTIONS, versions: ['l2b-test'], counts, rows: 1,
    }));
    return join(dir, 'tiles', tile.split('-')[0], `${tile}.json.gz`);
  }

  const cases = [
    ['no index folder at all', async () => join(base, 'nowhere'), /No own frame index/],
    ['an empty folder', async () => { const d = join(base, 'empty'); await mkdir(d, { recursive: true }); return d; }, /own frame index: not usable/],
    ['a meta.json cut short', async () => {
      const d = join(base, 'partial-meta');
      await writeGoodIndex(d);
      const meta = await readFile(join(d, 'meta.json'), 'utf8');
      await writeFile(join(d, 'meta.json'), meta.slice(0, meta.length >> 1));
      return d;
    }, /own frame index: not usable/],
    ['a meta.json with no build date', async () => {
      const d = join(base, 'thin-meta');
      await writeGoodIndex(d);
      await writeFile(join(d, 'meta.json'), JSON.stringify({ format: 1, collections: COLLECTIONS, versions: [], reachDeg: 2.6, counts: {} }));
      return d;
    }, /meta\.json .*no build date/],
  ];

  for (const [i, [name, make, said]] of cases.entries()) {
    test(`search: ${name} is no index, said in the log, and IRSA's routes answer`, async () => {
      const port = PORT + 4 + i;
      const relay = await relayWith(port, await make());
      try {
        await waitUntil(() => said.test(relay.text()));
        assert.match(relay.text(), said);
        await fallsBackToTap(port, relay, 160.5);
      } finally {
        relay.proc.kill();
      }
    });
  }

  test('search: a cell file cut short fails the index route, logged, and TAP answers', async () => {
    const port = PORT + 4 + cases.length;
    const dir = join(base, 'cut-cell');
    const cell = await writeGoodIndex(dir);
    const whole = await readFile(cell);
    await writeFile(cell, whole.subarray(0, whole.length >> 1));
    const relay = await relayWith(port, dir);
    try {
      await waitUntil(() => /Own frame index of 2026-11-14/.test(relay.text()));
      assert.match(relay.text(), /Own frame index of 2026-11-14/);
      await fallsBackToTap(port, relay, 160.5);
      await waitUntil(() => /unreadable/.test(relay.text()));
      assert.match(relay.text(), /own frame index: cell \d+-\d+ unreadable/);
    } finally {
      relay.proc.kill();
    }
  });
});

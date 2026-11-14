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
import { mkdir, rm, writeFile, utimes as touch } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { COLLECTIONS } from '../public/js/release.js';

const PORT = Number(process.env.TEST_PORT) || 5199;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
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

test('names relay: only an asteroid or comet name or designation goes to JPL', async () => {
  for (const name of ['', 'M51', 'TRAPPIST-1', 'NGC 4565', '<script>', 'Ceres&sstr=1', 'a'.repeat(41), '148.1 +1.0', 'ab']) {
    const res = await get(`/api/smallbody?name=${encodeURIComponent(name)}`);
    assert.equal(res.status, 400, name);
    assert.equal((await res.json()).ok, false);
  }
  assert.equal((await get('/api/smallbody')).status, 400);
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
  const file = join(dir, 'tap_gaia_269.4500_4.6900_0.01_9_all.json');
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

  before(async () => {
    await mkdir(cacheDir, { recursive: true });
    fake = createServer((req, res) => {
      const url = new URL(req.url, 'http://fake');
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
        res.end(votable(collection, Number(ra), Number(dec), step.rows ?? 3));
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
});

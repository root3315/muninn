/**
 * The local server: static files, the relay's input checks, the security
 * headers, and a malformed request not taking the process down.
 * Only answers that need no network are asked for.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

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

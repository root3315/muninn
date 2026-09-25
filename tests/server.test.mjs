/**
 * The local server: static files, the relay's input checks, and the fallback
 * byte-range relay refusing anything that is not one bounded SPHEREx range.
 * Only answers that need no network are asked for.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = 5199;
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
});

test('fits relay: only one bounded range of a SPHEREx file', async () => {
  const s3 = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr2/x.fits';
  const walk = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/../../../robots.txt';
  const range = { headers: { Range: 'bytes=0-2879' } };
  assert.equal((await get(`/api/fits?url=${encodeURIComponent(walk)}`, range)).status, 400);
  assert.equal((await get(`/api/fits?url=${encodeURIComponent('https://evil.example/x')}`, range)).status, 400);
  assert.equal((await get(`/api/fits?url=${encodeURIComponent(s3)}`)).status, 400, 'no range');
  assert.equal((await get(`/api/fits?url=${encodeURIComponent(s3)}`, { headers: { Range: 'bytes=0-' } })).status, 400, 'open range');
});

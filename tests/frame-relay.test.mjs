/**
 * The frame relay (/api/frame): what it refuses, what it keeps, when it asks
 * the bucket again and what it lets go of, against a fake S3 on this
 * machine; and the page's side of it, which must read the bucket itself
 * whenever the relay is missing or fails.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdir, rm, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fetchFrame, relayedUrl, useFrameRelay, S3_HOSTS } from '../public/js/ranges.js';

const PORT = (Number(process.env.TEST_PORT) || 5199) + 11;
const SMALL_PORT = PORT + 1;
const NARROW_PORT = PORT + 2;
const NO_INDEX = join(tmpdir(), `muninn-no-index-${process.pid}`);
const KEY = 'dr1/level2/2025W26_2A/l2b-v27-2026-214/1/level2_2025W26_2A_0530_1D1_spx_l2b-v27-2026-214.fits';
const OTHER = 'dr1/level2/2025W26_2A/l2b-v27-2026-214/4/level2_2025W26_2A_0530_2D4_spx_l2b-v27-2026-214.fits';
const BLOCK = 256 * 1024;
const FILE_BYTES = 5 * BLOCK + 1000;
/** The longest range the relay passes on. */
const RANGE_MAX = 6 * 1024 * 1024;
/** A key of that length: a read of all of it is the longest the relay sends. */
const LONG = KEY.replace('2025W26_2A_0530', '2025W26_2A_0777');
const sizeOf = (key) => (key.includes('_0777_') ? RANGE_MAX : FILE_BYTES);
/** The small relay's ceiling: five blocks, and room for the records of the frames they belong to. */
const SMALL_CEILING = 5 * BLOCK + 2048;
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

/** The fake bucket: every key holds FILE_BYTES bytes, which change with its version. */
const versions = new Map();
const asked = [];
const byteOf = (key, i) => (i * 7 + (versions.get(key) ?? 0) * 13 + key.length) % 251;

function answerBucket(req, res) {
  const key = decodeURIComponent(new URL(req.url, 'http://fake').pathname.replace(/^\/S3\//, ''));
  asked.push({ key, range: req.headers.range });
  if (key.includes('_0999_')) { res.writeHead(404); res.end(); return; }
  const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
  if (!m) { res.writeHead(400); res.end(); return; }
  const size = sizeOf(key);
  const from = Number(m[1]);
  if (from >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
  const to = Math.min(Number(m[2]), size - 1);
  const body = Buffer.alloc(to - from + 1);
  for (let i = 0; i < body.length; i += 1) body[i] = byteOf(key, from + i);
  res.writeHead(206, {
    'content-range': `bytes ${from}-${to}/${size}`,
    'content-length': String(body.length),
    etag: `"v${versions.get(key) ?? 0}"`,
  });
  res.end(body);
}

function expected(key, from, to) {
  const out = Buffer.alloc(to - from + 1);
  for (let i = 0; i < out.length; i += 1) out[i] = byteOf(key, from + i);
  return out;
}

async function startServer(port, cacheDir, fakePort, extra = {}) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      MUNINN_S3_URL: `http://127.0.0.1:${fakePort}/S3/`,
      MUNINN_INDEX_DIR: NO_INDEX,
      MUNINN_CACHE_DIR: cacheDir,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    proc.stdout.on('data', (chunk) => { if (String(chunk).includes(`:${port}`)) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return proc;
}

const read = (port, key, range) => fetch(`http://127.0.0.1:${port}/api/frame?path=${encodeURIComponent(key)}`, range ? { headers: { range } } : {});

describe('the frame relay against a fake bucket', () => {
  const base = join(tmpdir(), `muninn-frame-test-${process.pid}`);
  let fake;
  let relay;
  let small;
  let narrow;

  before(async () => {
    await mkdir(base, { recursive: true });
    fake = createServer(answerBucket);
    await new Promise((resolve) => { fake.listen(0, '127.0.0.1', resolve); });
    relay = await startServer(PORT, join(base, 'main'), fake.address().port);
    small = await startServer(SMALL_PORT, join(base, 'small'), fake.address().port, { MUNINN_FRAME_CACHE_BYTES: String(SMALL_CEILING) });
    // One answer from the disk at a time.
    narrow = await startServer(NARROW_PORT, join(base, 'narrow'), fake.address().port, { MUNINN_FRAME_DISK_MAX: '1' });
  });

  after(async () => {
    relay?.kill();
    small?.kill();
    narrow?.kill();
    fake?.close();
    await rm(base, { recursive: true, force: true });
  });

  test('only a level-2 key is passed on, with nothing else in the query', async () => {
    for (const bad of [
      '../server.js',
      `dr1/level2/../../${KEY}`,
      'dr1/level2/2025W26_2A/l2b-v27-2026-214/1/level2_2025W26_2A_0530_1D2_spx_l2b-v27-2026-214.fits',
      'dr1/level2/2025W26_2A/l2b-v27-2026-214/1/level2_2025W27_2A_0530_1D1_spx_l2b-v27-2026-214.fits',
      'dr1/level2/2025W26_2A/l2b-v27-2026-214/1/level2_2025W26_2A_0530_1D1_spx_l2b-v28-2026-214.fits',
      `${KEY}.json`,
      `https://example.org/${KEY}`,
      `/${KEY}`,
      `dr1/level3/2025W26_2A/l2b-v27-2026-214/1/level2_2025W26_2A_0530_1D1_spx_l2b-v27-2026-214.fits`,
      '',
    ]) {
      const res = await read(PORT, bad, 'bytes=0-99');
      assert.equal(res.status, 400, bad);
      assert.equal(res.headers.get('x-muninn-frame'), 'error');
    }
    const extra = await fetch(`http://127.0.0.1:${PORT}/api/frame?path=${encodeURIComponent(KEY)}&x-id=GetObject`, { headers: { range: 'bytes=0-99' } });
    assert.equal(extra.status, 400);
    const twice = await fetch(`http://127.0.0.1:${PORT}/api/frame?path=${encodeURIComponent(KEY)}&path=${encodeURIComponent(KEY)}`, { headers: { range: 'bytes=0-99' } });
    assert.equal(twice.status, 400);
    assert.equal(asked.length, 0);
  });

  test('one bounded range only', async () => {
    for (const range of [undefined, 'bytes=0-', 'bytes=0-99,200-299', 'bytes=99-0', 'items=0-99', `bytes=0-${RANGE_MAX}`, `bytes=100-${RANGE_MAX + 100}`, 'bytes=-0', `bytes=-${RANGE_MAX + 1}`]) {
      const res = await read(PORT, KEY, range);
      assert.equal(res.status, 416, String(range));
    }
    assert.equal(asked.length, 0);
  });

  test('a range is read from the bucket once, and then from the disk alone', async () => {
    asked.length = 0;
    const first = await read(PORT, KEY, `bytes=1000-${BLOCK + 99}`);
    assert.equal(first.status, 206);
    assert.equal(first.headers.get('x-muninn-frame'), 'miss');
    assert.equal(first.headers.get('content-range'), `bytes 1000-${BLOCK + 99}/${FILE_BYTES}`);
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), expected(KEY, 1000, BLOCK + 99));
    // Whole blocks, in one read.
    assert.deepEqual(asked.map((a) => a.range), [`bytes=0-${2 * BLOCK - 1}`]);

    const again = await read(PORT, KEY, `bytes=1000-${BLOCK + 99}`);
    assert.equal(again.headers.get('x-muninn-frame'), 'hit');
    assert.deepEqual(Buffer.from(await again.arrayBuffer()), expected(KEY, 1000, BLOCK + 99));
    // Another range inside the same blocks: no new read either.
    const inside = await read(PORT, KEY, 'bytes=5-36868');
    assert.equal(inside.headers.get('x-muninn-frame'), 'hit');
    assert.deepEqual(Buffer.from(await inside.arrayBuffer()), expected(KEY, 5, 36868));
    assert.equal(asked.length, 1);

    // The last bytes of the file, as the wavelength table is read; the length is known by now.
    const tail = await read(PORT, KEY, 'bytes=-5760');
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get('content-range'), `bytes ${FILE_BYTES - 5760}-${FILE_BYTES - 1}/${FILE_BYTES}`);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), expected(KEY, FILE_BYTES - 5760, FILE_BYTES - 1));
    // A range running past the end is cut at it, as S3 does.
    const over = await read(PORT, KEY, `bytes=${FILE_BYTES - 10}-${FILE_BYTES + 100}`);
    assert.equal(over.headers.get('content-range'), `bytes ${FILE_BYTES - 10}-${FILE_BYTES - 1}/${FILE_BYTES}`);
    assert.equal((await read(PORT, KEY, `bytes=${FILE_BYTES}-${FILE_BYTES + 10}`)).status, 416);
  });

  test('a long read from the disk comes whole, a block at a time', async () => {
    const range = `bytes=0-${RANGE_MAX - 1}`;
    const want = expected(LONG, 0, RANGE_MAX - 1);
    const first = await read(PORT, LONG, range);
    assert.equal(first.headers.get('x-muninn-frame'), 'miss');
    assert.ok(Buffer.from(await first.arrayBuffer()).equals(want));
    asked.length = 0;
    const again = await read(PORT, LONG, range);
    assert.equal(again.status, 206);
    assert.equal(again.headers.get('x-muninn-frame'), 'hit');
    assert.equal(again.headers.get('content-length'), String(RANGE_MAX));
    assert.ok(Buffer.from(await again.arrayBuffer()).equals(want));
    // Starting and ending inside blocks, across several of them.
    const middle = await read(PORT, LONG, `bytes=${BLOCK + 17}-${7 * BLOCK + 5}`);
    assert.equal(middle.headers.get('content-range'), `bytes ${BLOCK + 17}-${7 * BLOCK + 5}/${RANGE_MAX}`);
    assert.deepEqual(Buffer.from(await middle.arrayBuffer()), expected(LONG, BLOCK + 17, 7 * BLOCK + 5));
    assert.equal(asked.length, 0);
  });

  test('a block cut short on the disk is dropped and read from the bucket again', async () => {
    const id = createHash('sha256').update(KEY).digest('hex').slice(0, 24);
    const dir = join(base, 'main');
    await (await read(PORT, KEY, `bytes=0-${FILE_BYTES - 1}`)).arrayBuffer();
    const name = (await readdir(dir)).find((n) => n.startsWith(`frame_${id}_`) && n.endsWith('_2.bin'));
    assert.ok(name, 'block 2 is kept');
    const whole = await readFile(join(dir, name));
    await writeFile(join(dir, name), whole.subarray(0, 1000));
    asked.length = 0;
    const res = await read(PORT, KEY, `bytes=${2 * BLOCK + 10}-${2 * BLOCK + 2000}`);
    assert.equal(res.headers.get('x-muninn-frame'), 'miss');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), expected(KEY, 2 * BLOCK + 10, 2 * BLOCK + 2000));
    assert.deepEqual(asked.map((a) => a.range), [`bytes=${2 * BLOCK}-${3 * BLOCK - 1}`]);
    assert.equal((await stat(join(dir, name))).size, BLOCK);
    // The file's last block is shorter than the rest, and is kept as it is.
    const tail = await read(PORT, KEY, `bytes=${5 * BLOCK}-${FILE_BYTES - 1}`);
    assert.equal(tail.headers.get('x-muninn-frame'), 'hit');
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), expected(KEY, 5 * BLOCK, FILE_BYTES - 1));
  });

  test('a range past the end of a file not kept yet is a 416 with its length', async () => {
    const key = KEY.replace('2025W26_2A_0530', '2025W26_2A_0531');
    const res = await read(PORT, key, `bytes=${FILE_BYTES + 10}-${FILE_BYTES + 20}`);
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('content-range'), `bytes */${FILE_BYTES}`);
    assert.equal(res.headers.get('x-muninn-frame'), 'error');
  });

  test('past its limit of answers from the disk the relay says busy, and the page reads the bucket', async () => {
    const range = `bytes=0-${RANGE_MAX - 1}`;
    await (await read(NARROW_PORT, LONG, range)).arrayBuffer();
    // A visitor that takes nothing of a long answer keeps its place.
    let slow;
    const held = await new Promise((resolve) => {
      slow = request({ host: '127.0.0.1', port: NARROW_PORT, path: `/api/frame?path=${encodeURIComponent(LONG)}`, headers: { range } }, (res) => {
        res.pause();
        resolve(res);
      });
      slow.on('error', () => {});
      slow.end();
    });
    assert.equal(held.headers['x-muninn-frame'], 'hit');
    await sleep(200);
    const busy = await read(NARROW_PORT, LONG, 'bytes=0-99');
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('x-muninn-frame'), 'error');
    await busy.arrayBuffer();
    // Gone, it gives its place back.
    slow.destroy();
    await sleep(200);
    const later = await read(NARROW_PORT, LONG, 'bytes=0-99');
    assert.equal(later.status, 206);
    assert.deepEqual(Buffer.from(await later.arrayBuffer()), expected(LONG, 0, 99));
  });

  test('a file the bucket answers with another ETag has its kept blocks dropped', async () => {
    const key = OTHER;
    await (await read(PORT, key, 'bytes=0-99')).arrayBuffer();
    assert.equal((await read(PORT, key, 'bytes=0-99')).headers.get('x-muninn-frame'), 'hit');
    versions.set(key, 1);
    asked.length = 0;
    // Blocks 0 and 1: block 0 is kept from before, block 1 is asked for and comes back under the new ETag.
    const mixed = await read(PORT, key, `bytes=100-${BLOCK + 10}`);
    assert.equal(mixed.status, 206);
    assert.equal(mixed.headers.get('etag'), '"v1"');
    assert.deepEqual(Buffer.from(await mixed.arrayBuffer()), expected(key, 100, BLOCK + 10));
    // Block 0 was read again rather than served from before the change.
    assert.ok(asked.some((a) => a.range.startsWith('bytes=0-')), JSON.stringify(asked));
    const now = await read(PORT, key, 'bytes=0-99');
    assert.equal(now.headers.get('x-muninn-frame'), 'hit');
    assert.deepEqual(Buffer.from(await now.arrayBuffer()), expected(key, 0, 99));
  });

  test('a file the bucket does not have is a 404, and nothing is kept of it', async () => {
    const missing = KEY.replace('2025W26_2A_0530', '2025W26_2A_0999');
    asked.length = 0;
    assert.equal((await read(PORT, missing, 'bytes=0-99')).status, 404);
    assert.equal((await read(PORT, missing, 'bytes=0-99')).status, 404);
    assert.equal(asked.length, 2);
  });

  test('past its ceiling the disk lets go of the least recently used blocks', async () => {
    const dir = join(base, 'small');
    const keyA = KEY;
    const keyB = OTHER.replace('0530_2D4', '0530_3D4');
    const idOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 24);
    const blocksOf = (names, key) => names.filter((n) => n.startsWith(`frame_${idOf(key)}_`)).map((n) => Number(/_(\d+)\.bin$/.exec(n)[1])).sort();
    // Four blocks of A, then A's first block used again, then two of B:
    // the second of B finds no room and sends the sweep, which lets go of
    // one of A's three unused blocks, the oldest.
    await (await read(SMALL_PORT, keyA, `bytes=0-${4 * BLOCK - 1}`)).arrayBuffer();
    await sleep(60);
    await (await read(SMALL_PORT, keyA, 'bytes=0-99')).arrayBuffer();
    await sleep(60);
    await (await read(SMALL_PORT, keyB, `bytes=0-${2 * BLOCK - 1}`)).arrayBuffer();
    await sleep(400);
    const names = (await readdir(dir)).filter((n) => n.startsWith('frame_'));
    let total = 0;
    for (const n of names) total += (await stat(join(dir, n))).size;
    assert.ok(total <= SMALL_CEILING, `${total} bytes kept`);
    assert.deepEqual(blocksOf(names, keyB), [0]);
    const leftOfA = blocksOf(names, keyA);
    assert.equal(leftOfA[0], 0);
    assert.equal(leftOfA.length, 3);
    // What is kept is served without the bucket.
    asked.length = 0;
    assert.equal((await read(SMALL_PORT, keyB, 'bytes=0-9')).headers.get('x-muninn-frame'), 'hit');
    assert.equal((await read(SMALL_PORT, keyA, 'bytes=0-9')).headers.get('x-muninn-frame'), 'hit');
    assert.equal(asked.length, 0);
  });
});

describe('the page reads through the relay, and around it', () => {
  const s3 = `https://${S3_HOSTS[0]}/${KEY}`;
  const RELAY = 'https://muninn.test/api/frame';
  const init = { headers: { Range: 'bytes=0-99' } };
  const answer = (status, headers = {}) => new Response(status === 206 ? new Uint8Array(100) : 'no', { status, headers });

  /** A fetch that answers by address, and says what it was asked. */
  function fake(byUrl) {
    const calls = [];
    const fn = async (url) => {
      calls.push(url);
      const step = byUrl(url);
      if (step instanceof Error) throw step;
      return step;
    };
    return { fn, calls };
  }

  test('a bucket address goes to the relay first, under its key alone', async () => {
    useFrameRelay(RELAY);
    assert.equal(relayedUrl(s3), `${RELAY}?path=${encodeURIComponent(KEY)}`);
    assert.equal(relayedUrl(`https://${S3_HOSTS[1]}/${KEY}`), `${RELAY}?path=${encodeURIComponent(KEY)}`);
    assert.equal(relayedUrl('https://irsa.ipac.caltech.edu/ibe/data/spherex/x.fits'), null);
    assert.equal(relayedUrl(`${s3}?x-id=GetObject`), null);
    const { fn, calls } = fake(() => answer(206, { 'x-muninn-frame': 'hit' }));
    assert.equal((await fetchFrame(s3, init, 0, fn)).status, 206);
    assert.deepEqual(calls, [relayedUrl(s3)]);
  });

  test('a relay that fails is read around in the same attempt, and asked again next time', async () => {
    useFrameRelay(RELAY);
    for (const failure of [answer(503, { 'x-muninn-frame': 'error' }), answer(502, { 'x-muninn-frame': 'error' }), new TypeError('network')]) {
      const { fn, calls } = fake((url) => (url.startsWith(RELAY) ? failure : answer(206)));
      assert.equal((await fetchFrame(s3, init, 0, fn)).status, 206);
      assert.deepEqual(calls, [relayedUrl(s3), s3]);
    }
    assert.ok(relayedUrl(s3));
  });

  test('a host with no relay is asked once, then never again', async () => {
    useFrameRelay(RELAY);
    const { fn, calls } = fake((url) => (url.startsWith(RELAY) ? answer(404, { 'content-type': 'text/html' }) : answer(206)));
    assert.equal((await fetchFrame(s3, init, 0, fn)).status, 206);
    assert.equal((await fetchFrame(s3, init, 0, fn)).status, 206);
    assert.deepEqual(calls, [`${RELAY}?path=${encodeURIComponent(KEY)}`, s3, s3]);
    assert.equal(relayedUrl(s3), null);
  });

  test('a retry goes to the bucket; a cancelled read is not read again', async () => {
    useFrameRelay(RELAY);
    const { fn, calls } = fake(() => answer(206));
    await fetchFrame(s3, init, 1, fn);
    assert.deepEqual(calls, [s3]);
    const ctrl = new AbortController();
    ctrl.abort();
    const stopped = fake((url) => (url.startsWith(RELAY) ? new DOMException('Aborted', 'AbortError') : answer(206)));
    await assert.rejects(fetchFrame(s3, { ...init, signal: ctrl.signal }, 0, stopped.fn), { name: 'AbortError' });
    assert.equal(stopped.calls.length, 1);
  });

  test('the warm-up reads through the relay only', async () => {
    useFrameRelay(RELAY, { fallback: false });
    const { fn, calls } = fake(() => answer(503, { 'x-muninn-frame': 'error' }));
    assert.equal((await fetchFrame(s3, init, 2, fn)).status, 503);
    assert.deepEqual(calls, [relayedUrl(s3)]);
    useFrameRelay(null);
    assert.equal(relayedUrl(s3), null);
  });
});

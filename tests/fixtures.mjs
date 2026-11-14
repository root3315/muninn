/**
 * fixtures.mjs — a small SPHEREx-shaped FITS file built in memory, and a fetch
 * that serves it by byte range, so the reading pipeline can be tested without
 * the network.
 */

const BLOCK = 2880;

/** One header, padded to whole 2880-byte blocks. */
export function header(cards) {
  const lines = cards.map(([key, value]) => {
    if (key === 'END') return 'END'.padEnd(80);
    if (key === '') return ' '.repeat(80);
    let v;
    if (typeof value === 'string') v = `'${value.padEnd(8)}'`.padEnd(20);
    else if (typeof value === 'boolean') v = (value ? 'T' : 'F').padStart(20);
    else v = String(value).padStart(20);
    return `${key.padEnd(8)}= ${v}`.padEnd(80);
  });
  let text = lines.join('');
  text += ' '.repeat((BLOCK - (text.length % BLOCK)) % BLOCK);
  return new TextEncoder().encode(text);
}

function pad(bytes) {
  const out = new Uint8Array(bytes.length + ((BLOCK - (bytes.length % BLOCK)) % BLOCK));
  out.set(bytes);
  return out;
}

/** Deterministic noise, so a test that passes once passes every time. */
function gaussian(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next());
}

export const DETECTOR_DEG = 6.15 / 3600;

/**
 * A 64×64 detector at (ra, dec), east to the left as SPHEREx's own frames are
 * (CD1_1 < 0), background 1 MJy/sr with 0.02 of noise, and:
 *   · a real source, a 3×3 blob peaking at 5, at detector (20, 40), 1-based;
 *   · a cosmic-ray hit, one pixel at 50, at (44, 20), flagged TRANSIENT;
 *   · the source's own pixels flagged OUTLIER, which must not be masked.
 */
export function syntheticFrame({ ra = 150, dec = 10, n = 64, noise = 0.02, imageHeaderBlocks = 1 } = {}) {
  const rand = gaussian(12345);
  const img = new Float32Array(n * n);
  const flags = new Int32Array(n * n);
  for (let k = 0; k < img.length; k++) img[k] = 1 + noise * rand();
  const at = (x, y) => (y - 1) * n + (x - 1);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      img[at(20 + dx, 40 + dy)] += dx === 0 && dy === 0 ? 4 : 1.5;
      flags[at(20 + dx, 40 + dy)] |= 1 << 19;
    }
  }
  img[at(44, 20)] = 50;
  flags[at(44, 20)] |= (1 << 0) | (1 << 2) | (1 << 19);

  const wcs = [
    ['CRPIX1', (n + 1) / 2], ['CRPIX2', (n + 1) / 2], ['CRVAL1', ra], ['CRVAL2', dec],
    ['CD1_1', -DETECTOR_DEG], ['CD1_2', 0], ['CD2_1', 0], ['CD2_2', DETECTOR_DEG],
    ['CTYPE1', 'RA---TAN'], ['CTYPE2', 'DEC--TAN'],
  ];
  const bigEndian = (typed, write) => {
    const buf = new Uint8Array(typed.length * 4);
    const view = new DataView(buf.buffer);
    typed.forEach((v, i) => write(view, i * 4, v));
    return buf;
  };

  const imageCards = [['XTENSION', 'IMAGE'], ['BITPIX', -32], ['NAXIS', 2], ['NAXIS1', n], ['NAXIS2', n],
    ['PCOUNT', 0], ['GCOUNT', 1], ['EXTNAME', 'IMAGE'], ['BUNIT', 'MJy/sr'], ...wcs, ['MJD-OBS', 61000]];
  // Blank cards stretch the header, to put the image data where a real
  // file's starts (SPHEREx's IMAGE headers run to eight or nine blocks).
  const blanks = Math.max(0, imageHeaderBlocks * 36 - imageCards.length - 1);
  const parts = [
    header([['SIMPLE', true], ['BITPIX', 8], ['NAXIS', 0], ['EXTEND', true], ['END']]),
    header([...imageCards, ...Array.from({ length: blanks }, () => ['', '']), ['END']]),
    pad(bigEndian(img, (v, o, x) => v.setFloat32(o, x, false))),
    header([['XTENSION', 'IMAGE'], ['BITPIX', 32], ['NAXIS', 2], ['NAXIS1', n], ['NAXIS2', n],
      ['PCOUNT', 0], ['GCOUNT', 1], ['EXTNAME', 'FLAGS'], ...wcs, ['END']]),
    pad(bigEndian(flags, (v, o, x) => v.setInt32(o, x, false))),
  ];
  const file = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { file.set(p, off); off += p.length; }
  return { file, n, ra, dec, noise };
}

/**
 * A fetch that serves `file` at any URL. `honourRange: false` answers 200 with
 * the whole file, as a server that ignores Range would.
 */
export function serve(file, { honourRange = true } = {}) {
  return async (url, init = {}) => {
    const range = init.headers?.Range ?? init.headers?.range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!honourRange || !m) return new Response(file.slice(), { status: 200 });
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), file.length - 1);
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${file.length}` },
    });
  };
}

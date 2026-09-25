/**
 * fits.js — a small FITS reader that works from partial byte ranges.
 *
 * SPHEREx Level-2 spectral images are ~70 MB multi-extension FITS files. We never
 * want the whole thing: the flux plane we care about (HDU 1, "IMAGE") sits near the
 * front of the file, and within it we only need the rows that overlap the target.
 * Everything here is written so that a caller can hand us a few kilobytes at a time.
 *
 * Only what SPHEREx actually uses is implemented: uncompressed IMAGE extensions,
 * BITPIX -32 / -64 / 8 / 16 / 32 / 64, big-endian, no tile compression.
 */

const BLOCK = 2880;
const CARD = 80;

/** Turn the right-hand side of a header card into a JS value. */
function parseValue(raw) {
  const s = raw.trim();
  if (s === '') return null;
  if (s === 'T') return true;
  if (s === 'F') return false;
  if (s[0] === "'") {
    // FITS escapes a quote by doubling it.
    const end = s.lastIndexOf("'");
    return s.slice(1, end).replace(/''/g, "'").trim();
  }
  const num = Number(s.replace(/[DdEe]([+-]?\d)/, 'e$1'));
  return Number.isNaN(num) ? s : num;
}

/**
 * Read one header from `buf` starting at `offset`.
 * Returns null when the buffer does not yet hold the whole header.
 */
export function readHeader(buf, offset = 0) {
  const bytes = new Uint8Array(buf);
  const cards = new Map();
  let pos = offset;
  let ended = false;

  while (!ended) {
    if (pos + BLOCK > bytes.length) return null; // need more bytes
    for (let i = 0; i < BLOCK; i += CARD) {
      const card = String.fromCharCode(...bytes.subarray(pos + i, pos + i + CARD));
      const key = card.slice(0, 8).trim();
      if (key === 'END') { ended = true; break; }
      if (!key || key === 'COMMENT' || key === 'HISTORY') continue;
      if (card.slice(8, 10) !== '= ') continue;
      const body = card.slice(10);
      // strip the comment, but not a slash living inside a quoted string
      let cut = body.length;
      let inStr = false;
      for (let c = 0; c < body.length; c++) {
        if (body[c] === "'") inStr = !inStr;
        else if (body[c] === '/' && !inStr) { cut = c; break; }
      }
      cards.set(key, parseValue(body.slice(0, cut)));
    }
    pos += BLOCK;
  }
  return { cards, headerEnd: pos, headerBytes: pos - offset };
}

/** Bytes of data that follow a header, padded up to a 2880-byte boundary. */
export function dataLength(cards) {
  const naxis = cards.get('NAXIS') ?? 0;
  if (!naxis) return 0;
  let n = 1;
  for (let a = 1; a <= naxis; a++) n *= cards.get(`NAXIS${a}`) ?? 0;
  const bitpix = cards.get('BITPIX') ?? 0;
  const pcount = cards.get('PCOUNT') ?? 0;
  const gcount = cards.get('GCOUNT') ?? 1;
  return (Math.abs(bitpix) / 8) * gcount * (pcount + n);
}

export const padded = (n) => n + ((BLOCK - (n % BLOCK)) % BLOCK);

/**
 * Walk the HDUs present in `buf`, stopping when the buffer runs out.
 * Each entry carries where its data starts so a caller can range-fetch into it.
 */
export function scanHDUs(buf, { limit = 16 } = {}) {
  const out = [];
  let offset = 0;
  while (out.length < limit) {
    const head = readHeader(buf, offset);
    if (!head) break;
    const len = dataLength(head.cards);
    out.push({
      index: out.length,
      cards: head.cards,
      name: String(head.cards.get('EXTNAME') ?? (out.length === 0 ? 'PRIMARY' : '')).trim(),
      dataStart: head.headerEnd,
      dataBytes: len,
    });
    offset = head.headerEnd + padded(len);
    if (offset >= buf.byteLength) break;
  }
  return out;
}

const READERS = {
  8: (v, o) => v.getUint8(o),
  16: (v, o) => v.getInt16(o, false),
  32: (v, o) => v.getInt32(o, false),
  64: (v, o) => Number(v.getBigInt64(o, false)),
  '-32': (v, o) => v.getFloat32(o, false),
  '-64': (v, o) => v.getFloat64(o, false),
};

/**
 * Decode a contiguous run of pixels from a big-endian FITS data array.
 * `buf` holds exactly the bytes of the run (already range-fetched).
 */
export function decodePixels(buf, byteOffset, count, bitpix, { bzero = 0, bscale = 1 } = {}) {
  const read = READERS[String(bitpix)];
  if (!read) throw new Error(`Unsupported BITPIX ${bitpix}`);
  const width = Math.abs(bitpix) / 8;
  const view = new DataView(buf);
  const out = new Float32Array(count);
  const scaled = bscale !== 1 || bzero !== 0;
  for (let i = 0; i < count; i++) {
    const v = read(view, byteOffset + i * width);
    out[i] = scaled ? bzero + bscale * v : v;
  }
  return out;
}

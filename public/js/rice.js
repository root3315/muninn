/**
 * rice.js — the FITS tile-compression codec RICE_1, decoding only.
 *
 * From SPHEREx DR1 on, the FLAGS plane of a Level-2 file is stored as a
 * tile-compressed image: a binary table with one tile per detector row, each
 * tile Rice-coded (BLOCKSIZE 32, BYTEPIX 4). Read as an ordinary image it is
 * eight bytes a row of pointers, and nothing gets masked.
 *
 * The coding is the one in the FITS tile-compression convention (Pence,
 * White & Seaman 2010) and cfitsio's `fits_rdecomp`: the first pixel as a
 * plain 32-bit value, then blocks of differences, each block opened by a
 * 5-bit code that says how many low bits are sent as they are. A code of 0
 * means a block of zero differences; 25 means the differences are sent whole.
 */

const FS_BITS = 5;
const FS_MAX = 25;
const BITS = 32;

/** How many bits a byte needs: 0 for 0, 1 for 1, 2 for 2–3, … 8 for 128–255. */
const WIDTH = new Uint8Array(256);
for (let b = 1; b < 256; b++) WIDTH[b] = 32 - Math.clz32(b);

/**
 * Decode one Rice-coded tile of 32-bit integers.
 *
 * @param {Uint8Array} c   the tile's compressed bytes
 * @param {number} n       pixels in the tile
 * @param {number} [block] pixels per block (the ZVAL of BLOCKSIZE)
 * @returns {Int32Array}
 */
export function riceDecode(c, n, block = 32) {
  const out = new Int32Array(n);
  if (c.length < 5) throw new Error('Rice tile too short');
  let at = 0;
  let last = ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) | 0;
  at = 4;
  // `b` holds the bits read but not used yet, `nbits` how many of them.
  let b = c[at++];
  let nbits = 8;
  const next = () => {
    if (at >= c.length) throw new Error('Rice tile ended early');
    return c[at++];
  };

  for (let i = 0; i < n;) {
    nbits -= FS_BITS;
    while (nbits < 0) { b = (b << 8) | next(); nbits += 8; }
    const fs = (b >>> nbits) - 1;
    b &= (1 << nbits) - 1;
    const end = Math.min(i + block, n);

    if (fs < 0) {
      // Nothing changed across the block.
      for (; i < end; i++) out[i] = last;
    } else if (fs === FS_MAX) {
      // The differences did not compress: each is sent in full.
      for (; i < end; i++) {
        let k = BITS - nbits;
        let diff = k < 32 ? (b << k) >>> 0 : 0;
        for (k -= 8; k >= 0; k -= 8) diff = (diff | (next() << k)) >>> 0;
        if (nbits > 0) {
          b = next();
          diff = (diff | (b >>> -k)) >>> 0;
          b &= (1 << nbits) - 1;
        } else {
          b = 0;
        }
        last = (unfold(diff) + last) | 0;
        out[i] = last;
      }
    } else {
      for (; i < end; i++) {
        // A run of zero bits, then a one: the high part of the difference.
        while (b === 0) { nbits += 8; b = next(); }
        const zeros = nbits - WIDTH[b];
        nbits -= zeros + 1;
        b ^= 1 << nbits;
        // Then `fs` bits as they are: the low part.
        nbits -= fs;
        while (nbits < 0) { b = (b << 8) | next(); nbits += 8; }
        const diff = ((zeros << fs) | (b >>> nbits)) >>> 0;
        b &= (1 << nbits) - 1;
        last = (unfold(diff) + last) | 0;
        out[i] = last;
      }
    }
  }
  return out;
}

/** Differences are folded to unsigned (0, −1, 1, −2, …); fold them back. */
function unfold(d) {
  return (d & 1) === 0 ? d >>> 1 : ~(d >>> 1);
}

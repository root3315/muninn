/**
 * hips-png.mjs — the few PNG files the build scripts read and write, by hand.
 *
 * The cube's tiles are 8-bit (grey or paletted); what the scripts write is
 * 8-bit grey or RGB. That is all this covers; nothing here depends on a
 * package.
 */

import { inflateSync, deflateSync } from 'node:zlib';

/** Grey value and whether there is data, per pixel, of an 8-bit PNG tile. */
export function decodePng(buf) {
  let at = 8;
  let w;
  let h;
  let type;
  let depth;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const kind = buf.toString('ascii', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; }
    if (kind === 'PLTE') palette = data;
    if (kind === 'tRNS') trns = data;
    if (kind === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels) throw new Error(`unsupported PNG: type ${type}, depth ${depth}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const value = new Uint8Array(w * h);
  const has = new Uint8Array(w * h);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (line[i] + p) & 255;
    }
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const s = cur[x * channels];
      if (type === 3) {
        value[k] = palette[s * 3];
        has[k] = trns && s < trns.length ? (trns[s] > 0 ? 1 : 0) : 1;
      } else {
        value[k] = s;
        has[k] = type === 4 ? (cur[x * channels + 1] > 0 ? 1 : 0) : type === 6 ? (cur[x * 4 + 3] > 0 ? 1 : 0) : 1;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, value, has };
}

/**
 * An 8-bit grey (1 channel) or RGB (3) PNG. Each row takes whichever of the PNG filters leaves the least to
 * compress, as encoders do; the sky's smooth light compresses far better as
 * differences than as values.
 */
export function encodePng(w, h, data, channels = 1) {
  const stride = w * channels;
  const raw = Buffer.alloc(h * (1 + stride));
  const row = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const cur = data.subarray(y * stride, (y + 1) * stride);
    const up = y ? data.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    let best = null;
    let bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      let cost = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? cur[x - channels] : 0;
        const b = up[x];
        const c = x >= channels ? up[x - channels] : 0;
        let p = 0;
        if (f === 1) p = a;
        else if (f === 2) p = b;
        else if (f === 3) p = (a + b) >> 1;
        else if (f === 4) {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        row[x] = (cur[x] - p) & 255;
        cost += row[x] < 128 ? row[x] : 256 - row[x];
      }
      if (cost < bestCost) { bestCost = cost; best = [f, Uint8Array.from(row)]; }
    }
    raw[y * (1 + stride)] = best[0];
    raw.set(best[1], y * (1 + stride) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(kind, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, channels === 3 ? 2 : 0, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}


/**
 * relief.js — the rocky bodies' heights, as the slope of their ground.
 *
 * The height maps (public/data/fly/tex/<key>-height.png, maps.json `heights`)
 * are 16-bit grey PNGs. A browser's Image gives a page only 8 bits of them,
 * which for Mars is 112 m a step: terraces, not slopes. So the PNG is read
 * here, all 16 bits, and turned once into the slope of the ground east and
 * north at every cell, which is what light falling on it needs. The renderer
 * keeps the slopes as a two-channel half-float texture and tilts each
 * pixel's normal by them, times the exaggeration below.
 */

/**
 * How much steeper than true the ground is drawn from afar. A cell of these
 * maps is 11–39 km across, and averaging over it softens every slope: a
 * crater wall or a mountain side is many times steeper than its cell's mean.
 * Each factor brings the steepest cell in a hundred to 12–17°, so the bodies
 * read alike (the Moon's, true, are 11°, Venus's and the Earth's under 2°);
 * close to the surface the ground is drawn as it is (see reliefScale).
 */
export const RELIEF = { mercury: 3, venus: 8, earth: 8, moon: 1.5, mars: 4 };

/** Radii in km the slopes are measured on (IAU mean radii). */
const RADIUS_KM = { mercury: 2439.4, venus: 6051.8, earth: 6371.0, moon: 1737.4, mars: 3389.5 };

/**
 * The exaggeration for a body from a camera `altitude` radii above it: the
 * full factor from a radius up, the true one from a sixth of a radius down,
 * eased between, so a planet flown down to does not flatten in one step.
 */
export function reliefScale(key, altitude) {
  const n = RELIEF[key];
  if (!n) return 0;
  const x = Math.min(1, Math.max(0, (altitude - 1 / 6) / (1 - 1 / 6)));
  return 1 + (n - 1) * x * x * (3 - 2 * x);
}

/** A PNG's chunks: its header and its image data, still compressed. */
function chunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = [];
  let header = null;
  for (let o = 8; o + 8 <= bytes.length;) {
    const n = view.getUint32(o);
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    if (type === 'IHDR') {
      header = { w: view.getUint32(o + 8), h: view.getUint32(o + 12), depth: bytes[o + 16], colour: bytes[o + 17], interlace: bytes[o + 20] };
    }
    if (type === 'IDAT') data.push(bytes.subarray(o + 8, o + 8 + n));
    if (type === 'IEND') break;
    o += 12 + n;
  }
  return { header, data };
}

async function inflate(parts) {
  // PNG's image data is one zlib stream, which is what 'deflate' means here.
  const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Paeth's predictor, from the PNG standard. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undo each row's filter in place: `raw` is rows of (filter byte, stride bytes). */
function unfilter(raw, h, stride, bpp) {
  const out = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const up = row - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[row + i - bpp] : 0;
      const b = y ? out[up + i] : 0;
      const c = y && i >= bpp ? out[up + i - bpp] : 0;
      const p = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0;
      out[row + i] = (raw[src + i] + p) & 255;
    }
  }
  return out;
}

/** A 16-bit grey, non-interlaced PNG as { w, h, values: Uint16Array }; null for any other kind. */
export async function decodeGrey16(buffer) {
  const { header, data } = chunks(new Uint8Array(buffer));
  if (!header || header.depth !== 16 || header.colour !== 0 || header.interlace !== 0) return null;
  const { w, h } = header;
  const bytes = unfilter(await inflate(data), h, w * 2, 2);
  const values = new Uint16Array(w * h);
  for (let k = 0; k < values.length; k++) values[k] = (bytes[k * 2] << 8) | bytes[k * 2 + 1];
  return { w, h, values };
}

/**
 * The ground's slope east and north at every cell, metres per metre, as
 * pairs: centred differences, round the seam at ±180°. Ground below
 * `seaLevel` (the Earth's oceans) is flat, and the sea floor is not seen
 * from a coast: a neighbour under water counts as sea level.
 */
export function slopes({ w, h, values }, meta, key, seaLevel = null) {
  const radius = RADIUS_KM[key] * 1000;
  const scale = (meta.maxMetres - meta.minMetres) / 65535;
  const height = (x, y) => {
    const m = meta.minMetres + values[y * w + ((x + w) % w)] * scale;
    return seaLevel == null ? m : Math.max(m, seaLevel);
  };
  const cell = (2 * Math.PI * radius) / w;
  const out = new Float32Array(w * h * 2);
  for (let y = 0; y < h; y++) {
    // A cell's width east is narrower towards the poles; held off zero there.
    const across = cell * Math.max(0.05, Math.cos((0.5 - (y + 0.5) / h) * Math.PI));
    const n = Math.max(0, y - 1);
    const s = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 2;
      if (seaLevel != null && meta.minMetres + values[y * w + x] * scale < seaLevel) continue;
      out[k] = (height(x + 1, y) - height(x - 1, y)) / (2 * across);
      out[k + 1] = (height(x, n) - height(x, s)) / ((s - n) * cell);
    }
  }
  return out;
}

/** Each smaller level of a two-channel map, halving it, down to one cell: the means of four. */
export function halvings(data, w, h) {
  const levels = [{ data, w, h }];
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const next = new Float32Array(nw * nh * 2);
    for (let y = 0; y < nh; y++) {
      // Rows and columns of a side one cell wide are counted twice.
      const r0 = 2 * y * w;
      const r1 = Math.min(h - 1, 2 * y + 1) * w;
      for (let x = 0; x < nw; x++) {
        const c0 = 2 * x;
        const c1 = Math.min(w - 1, 2 * x + 1);
        const o = (y * nw + x) * 2;
        for (let c = 0; c < 2; c++) {
          next[o + c] = (data[(r0 + c0) * 2 + c] + data[(r0 + c1) * 2 + c] + data[(r1 + c0) * 2 + c] + data[(r1 + c1) * 2 + c]) / 4;
        }
      }
    }
    levels.push({ data: next, w: nw, h: nh });
    data = next;
    w = nw;
    h = nh;
  }
  return levels;
}

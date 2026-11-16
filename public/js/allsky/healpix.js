/**
 * healpix.js — the sky cut into HEALPix cells, as far as drawing it needs.
 *
 * HiPS, the format the all-sky survey is served in, is a HEALPix tree: twelve
 * base faces, each split in four at every order, one 512-pixel tile a cell.
 * Everything here works in face coordinates — a face and a position (x, y) in
 * [0, 1]² on it, x along the cell's ix axis and y along iy — because a tile is
 * a square in those and nowhere else.
 *
 * The formulas are the continuous forms of HEALPix's own `loc2xyf` and
 * `xyf2loc` (Górski et al. 2005; healpix_base.cc), for nside 1.
 */

const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];
const DEG = Math.PI / 180;

/** A unit vector in ICRS from RA and Dec in degrees. */
export function vecOf(ra, dec) {
  const a = ra * DEG;
  const d = dec * DEG;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

/** RA in [0, 360) and Dec in degrees from a vector of any length. */
export function radecOf([x, y, z]) {
  let ra = Math.atan2(y, x) / DEG;
  if (ra < 0) ra += 360;
  return { ra, dec: Math.atan2(z, Math.hypot(x, y)) / DEG };
}

/** The face and face coordinates under a point of the sky. */
export function xyfOf(ra, dec) {
  const z = Math.sin(dec * DEG);
  const za = Math.abs(z);
  let tt = (ra / 90) % 4;
  if (tt < 0) tt += 4;
  if (za <= 2 / 3) {
    const jp = 0.5 + tt - 0.75 * z;
    const jm = 0.5 + tt + 0.75 * z;
    const ifp = Math.floor(jp);
    const ifm = Math.floor(jm);
    const face = ifp === ifm ? (ifp % 4) | 4 : ifp < ifm ? ifp % 4 : (ifm % 4) + 8;
    return { face, x: jm - ifm, y: 1 - (jp - ifp) };
  }
  const ntt = Math.min(3, Math.floor(tt));
  const tp = tt - ntt;
  const tmp = Math.sqrt(3 * (1 - za));
  const jp = Math.min(tp * tmp, 1 - 1e-12);
  const jm = Math.min((1 - tp) * tmp, 1 - 1e-12);
  return z > 0 ? { face: ntt, x: 1 - jm, y: 1 - jp } : { face: ntt + 8, x: jp, y: jm };
}

/** The unit vector at face coordinates (x, y) on a face. */
export function vecOfXyf(x, y, face) {
  const jr = JRLL[face] - x - y;
  let nr;
  let z;
  if (jr < 1) {
    nr = jr;
    z = 1 - (nr * nr) / 3;
  } else if (jr > 3) {
    nr = 4 - jr;
    z = (nr * nr) / 3 - 1;
  } else {
    nr = 1;
    z = ((2 - jr) * 2) / 3;
  }
  let tmp = JPLL[face] * nr + x - y;
  if (tmp < 0) tmp += 8;
  if (tmp >= 8) tmp -= 8;
  const phi = nr < 1e-15 ? 0 : (Math.PI / 4) * tmp / nr;
  const s = Math.sqrt(Math.max(0, (1 - z) * (1 + z)));
  return [s * Math.cos(phi), s * Math.sin(phi), z];
}

/** Spread the low 16 bits of v to the even bits of the result. */
function spread(v) {
  let r = 0;
  for (let i = 0; i < 16; i++) r += ((v >> i) & 1) * 2 ** (2 * i);
  return r;
}

/** The inverse of spread: the even bits of v, packed. */
function compact(v) {
  let r = 0;
  for (let i = 0; i < 16; i++) r |= (Math.floor(v / 2 ** (2 * i)) & 1) << i;
  return r;
}

/** The nested index of the cell (ix, iy) on a face at an order. */
export const nestOf = (order, face, ix, iy) => face * 4 ** order + spread(ix) + 2 * spread(iy);

/** The face and cell coordinates of a nested index. */
export function cellOf(order, npix) {
  const per = 4 ** order;
  const face = Math.floor(npix / per);
  const sub = npix - face * per;
  return { face, ix: compact(sub), iy: compact(Math.floor(sub / 2)) };
}

/**
 * Where a point of the sky falls in the tiles of an order: the tile, and the
 * point's place in it as (a, b) in [0, 1]², a along ix and b along iy.
 */
export function tileAt(order, ra, dec) {
  const { face, x, y } = xyfOf(ra, dec);
  const n = 2 ** order;
  const ix = Math.min(n - 1, Math.floor(x * n));
  const iy = Math.min(n - 1, Math.floor(y * n));
  return { npix: nestOf(order, face, ix, iy), a: x * n - ix, b: y * n - iy };
}

/**
 * A tile as a grid of (steps + 1)² sky vectors, row by row in a, and the
 * texture coordinate of each.
 *
 * In a HiPS PNG the image rows run along ix and the columns along iy, with no
 * mirror: measured against eight bright stars on equatorial and both polar
 * faces of the SPHEREx DR1 cube, every one of them landed on its own disc
 * under that reading and off it under the seven others.
 */
export function tileMesh(order, npix, steps) {
  const { face, ix, iy } = cellOf(order, npix);
  const n = 2 ** order;
  const count = (steps + 1) ** 2;
  const positions = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let k = 0;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const a = i / steps;
      const b = j / steps;
      positions.set(vecOfXyf((ix + a) / n, (iy + b) / n, face), k * 3);
      uv[k * 2] = b;
      uv[k * 2 + 1] = a;
      k++;
    }
  }
  return { positions, uv };
}

/** The unit vector at the middle of a tile. */
export function tileCentre(order, npix) {
  const { face, ix, iy } = cellOf(order, npix);
  const n = 2 ** order;
  return vecOfXyf((ix + 0.5) / n, (iy + 0.5) / n, face);
}

/**
 * The largest angle, in degrees, from a tile's middle to any of its corners: a
 * HEALPix cell is not a square on the sky, and near the poles a corner
 * reaches further than the order's nominal size.
 */
export function tileRadius(order, npix) {
  const { face, ix, iy } = cellOf(order, npix);
  const n = 2 ** order;
  const c = tileCentre(order, npix);
  let most = 0;
  for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const v = vecOfXyf((ix + a) / n, (iy + b) / n, face);
    const cos = Math.min(1, c[0] * v[0] + c[1] * v[1] + c[2] * v[2]);
    most = Math.max(most, Math.acos(cos) / DEG);
  }
  return most;
}

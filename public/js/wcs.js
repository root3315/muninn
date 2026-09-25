/**
 * wcs.js — gnomonic (TAN) world coordinates with SIP distortion, both directions.
 *
 * SPHEREx headers carry CTYPE 'RA---TAN-SIP' / 'DEC--TAN-SIP' with third-order
 * forward (A_, B_) and inverse (AP_, BP_) polynomials. Both are needed here: the
 * forward pair to work out where a detector pixel lands on the sky, the inverse
 * pair to resample every epoch onto one shared north-up grid.
 *
 * Pixel coordinates follow the FITS convention — the centre of the first pixel is
 * 1.0, not 0.0. Callers that think in array indices should add 1 on the way in.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * A SIP polynomial as a flat coefficient table, `c[p * (order + 1) + q]`.
 *
 * Resampling one field evaluates this four times a pixel, a few hundred thousand
 * times over; a list of `[p, q, c]` triples destructured and raised with `**` on
 * every term cost more than the projection around it.
 */
function collectSIP(cards, prefix) {
  const order = cards.get(`${prefix}_ORDER`);
  if (!order) return null;
  const side = order + 1;
  const coef = new Float64Array(side * side);
  let any = false;
  for (let p = 0; p <= order; p++) {
    for (let q = 0; q + p <= order; q++) {
      const c = cards.get(`${prefix}_${p}_${q}`);
      if (c) { coef[p * side + q] = c; any = true; }
    }
  }
  return any ? { order, side, coef } : null;
}

const applySIP = (sip, u, v) => {
  const { order, side, coef } = sip;
  let s = 0;
  let up = 1;
  for (let p = 0; p <= order; p++) {
    let term = 0;
    let vq = 1;
    for (let q = 0; q + p <= order; q++) {
      term += coef[p * side + q] * vq;
      vq *= v;
    }
    s += term * up;
    up *= u;
  }
  return s;
};

export class WCS {
  constructor(cards) {
    this.crpix1 = cards.get('CRPIX1');
    this.crpix2 = cards.get('CRPIX2');
    this.crval1 = cards.get('CRVAL1');
    this.crval2 = cards.get('CRVAL2');
    this.naxis1 = cards.get('NAXIS1');
    this.naxis2 = cards.get('NAXIS2');

    // CD = PC · CDELT. SPHEREx ships PC + CDELT=1; other products ship CD directly.
    const cd1 = cards.get('CDELT1') ?? 1;
    const cd2 = cards.get('CDELT2') ?? 1;
    this.cd = cards.has('CD1_1')
      ? [cards.get('CD1_1'), cards.get('CD1_2') ?? 0, cards.get('CD2_1') ?? 0, cards.get('CD2_2')]
      : [(cards.get('PC1_1') ?? 1) * cd1, (cards.get('PC1_2') ?? 0) * cd1,
         (cards.get('PC2_1') ?? 0) * cd2, (cards.get('PC2_2') ?? 1) * cd2];

    const [a, b, c, d] = this.cd;
    const det = a * d - b * c;
    if (!det) throw new Error('WCS: singular CD matrix');
    this.cdInv = [d / det, -b / det, -c / det, a / det];

    this.A = collectSIP(cards, 'A');
    this.B = collectSIP(cards, 'B');
    this.AP = collectSIP(cards, 'AP');
    this.BP = collectSIP(cards, 'BP');

    // Scale in degrees per pixel, from the determinant — correct under rotation.
    this.scale = Math.sqrt(Math.abs(det));
  }

  /** FITS pixel (1-based) → [ra, dec] in degrees. */
  pixToWorld(x, y) {
    let u = x - this.crpix1;
    let v = y - this.crpix2;
    if (this.A) { const du = applySIP(this.A, u, v), dv = applySIP(this.B, u, v); u += du; v += dv; }

    const [a, b, c, d] = this.cd;
    const xi = (a * u + b * v) * D2R;
    const eta = (c * u + d * v) * D2R;

    const a0 = this.crval1 * D2R;
    const d0 = this.crval2 * D2R;
    const rho = Math.hypot(xi, eta);
    if (rho === 0) return [this.crval1, this.crval2];
    const cRad = Math.atan(rho);
    const sinC = Math.sin(cRad);
    const cosC = Math.cos(cRad);

    const dec = Math.asin(cosC * Math.sin(d0) + (eta * sinC * Math.cos(d0)) / rho);
    const ra = a0 + Math.atan2(xi * sinC, rho * Math.cos(d0) * cosC - eta * Math.sin(d0) * sinC);
    return [((ra * R2D) % 360 + 360) % 360, dec * R2D];
  }

  /** [ra, dec] in degrees → FITS pixel (1-based). Returns null behind the projection. */
  worldToPix(ra, dec) {
    const a0 = this.crval1 * D2R;
    const d0 = this.crval2 * D2R;
    const a1 = ra * D2R;
    const d1 = dec * D2R;
    const dA = a1 - a0;

    const cosC = Math.sin(d0) * Math.sin(d1) + Math.cos(d0) * Math.cos(d1) * Math.cos(dA);
    if (cosC <= 0) return null; // more than 90° away — wrong side of the tangent plane

    const xi = (Math.cos(d1) * Math.sin(dA)) / cosC * R2D;
    const eta = (Math.cos(d0) * Math.sin(d1) - Math.sin(d0) * Math.cos(d1) * Math.cos(dA)) / cosC * R2D;

    const [ia, ib, ic, id] = this.cdInv;
    const U = ia * xi + ib * eta;
    const V = ic * xi + id * eta;

    let u = U;
    let v = V;
    if (this.AP) { u = U + applySIP(this.AP, U, V); v = V + applySIP(this.BP, U, V); }
    return [u + this.crpix1, v + this.crpix2];
  }

  /** Position angle of north, measured east-of-north, in degrees. */
  get rollDeg() {
    const [a, b, c, d] = this.cd;
    return Math.atan2(-b, d) * R2D;
  }
}

/**
 * A plain north-up TAN grid used as the common frame every epoch is resampled onto.
 * No distortion, no rotation — the neutral ground the blink comparison needs.
 */
export class TangentGrid {
  /**
   * `fovDeg` is the width of the field; the height follows from the pixel count,
   * so a wide grid shows more sky rather than squashing it.
   */
  constructor(ra, dec, fovDeg, width, height = width) {
    this.ra = ra;
    this.dec = dec;
    this.width = width;
    this.height = height;
    this.fovDeg = fovDeg;
    this.scale = fovDeg / width; // degrees per output pixel, both axes
    this.fovHeightDeg = this.scale * height;
    this.cx = (width - 1) / 2;
    this.cy = (height - 1) / 2;
    this.a0 = ra * D2R;
    this.d0 = dec * D2R;
  }

  /** The longer side, in degrees — what a bounding search has to cover. */
  get spanDeg() { return Math.max(this.fovDeg, this.fovHeightDeg); }

  /** Grid index (i across, j down) → [ra, dec]. j grows downward so north stays up. */
  indexToWorld(i, j) {
    const xi = (i - this.cx) * this.scale * D2R;
    const eta = -(j - this.cy) * this.scale * D2R;
    const rho = Math.hypot(xi, eta);
    if (rho === 0) return [this.ra, this.dec];
    const cRad = Math.atan(rho);
    const sinC = Math.sin(cRad);
    const cosC = Math.cos(cRad);
    const dec = Math.asin(cosC * Math.sin(this.d0) + (eta * sinC * Math.cos(this.d0)) / rho);
    const ra = this.a0 + Math.atan2(xi * sinC, rho * Math.cos(this.d0) * cosC - eta * Math.sin(this.d0) * sinC);
    return [((ra * R2D) % 360 + 360) % 360, dec * R2D];
  }

  /** [ra, dec] → fractional grid index, for drawing overlays on top of the canvas. */
  worldToIndex(ra, dec) {
    const d1 = dec * D2R;
    const dA = ra * D2R - this.a0;
    const cosC = Math.sin(this.d0) * Math.sin(d1) + Math.cos(this.d0) * Math.cos(d1) * Math.cos(dA);
    if (cosC <= 0) return null;
    const xi = (Math.cos(d1) * Math.sin(dA)) / cosC * R2D;
    const eta = (Math.cos(this.d0) * Math.sin(d1) - Math.sin(this.d0) * Math.cos(d1) * Math.cos(dA)) / cosC * R2D;
    return [xi / this.scale + this.cx, -eta / this.scale + this.cy];
  }
}

/** Angular separation between two sky positions, in degrees. */
export function separation(ra1, dec1, ra2, dec2) {
  const p1 = dec1 * D2R;
  const p2 = dec2 * D2R;
  const dl = (ra2 - ra1) * D2R;
  const dp = p2 - p1;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * R2D;
}

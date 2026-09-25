/**
 * gate.js — the way in: inside the celestial sphere, drifting.
 *
 * You are not looking at a map of the sky. You are inside it, at the centre,
 * with a camera pointed outward, and it is turning — slowly, the way an
 * instrument in orbit turns while it sweeps. Everything is where it really is:
 * every point is a star from the Bright Star Catalogue at its own position,
 * sized by its own magnitude and tinted by its own colour index, down to visual
 * magnitude 6.0, which is what an eye can see from a dark place.
 *
 * Because it is a real perspective from a real point, the sky behaves: turn
 * toward Orion and Orion is the right shape and the right size, the
 * constellations hold together, and the Milky Way passes overhead instead of
 * bending along a rectangle's edge. A flat all-sky chart cannot do any of that,
 * which is why it reads as a diagram however well it is painted.
 *
 * Three layers, and they are different kinds of thing, so they are said to be:
 *
 *   · stars      — catalogue positions and magnitudes. Nothing invented.
 *   · markers    — things this tool can open: planets computed for tonight,
 *                  Messier objects, and fields whose frames are indexed here.
 *   · the disc   — the Milky Way, computed from galactic coordinates. A model
 *                  of the galactic disc, not a photograph and not a survey. It
 *                  is there so the sky reads as a sky; nothing is measured from
 *                  it, and the colophon says as much.
 *
 * Drag to look around, wheel to widen or narrow. Press a marker and the camera
 * turns onto it and dives: the field of view closes from seventy-eight degrees
 * to one, so everything off-axis sweeps outward past the edges. The streaks are
 * the real displacement between where a star was a fifth of a second ago and
 * where it is now, computed from the same curve that drives the dive — a long
 * exposure of the motion rather than a blur laid over it.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/* The north galactic pole and the galactic longitude of the north celestial
   pole, J2000. These three numbers define the galactic frame. */
const NGP_RA = 192.85948 * D2R;
const NGP_DEC = 27.12825 * D2R;
const L_NCP = 122.93192 * D2R;

/** Equatorial degrees to galactic (l, b) in degrees. */
export function galactic(raDeg, decDeg) {
  const ra = raDeg * D2R;
  const dec = decDeg * D2R;
  const sinB = Math.sin(dec) * Math.sin(NGP_DEC)
    + Math.cos(dec) * Math.cos(NGP_DEC) * Math.cos(ra - NGP_RA);
  const b = Math.asin(Math.max(-1, Math.min(1, sinB)));
  const y = Math.cos(dec) * Math.sin(ra - NGP_RA);
  const x = Math.sin(dec) * Math.cos(NGP_DEC)
    - Math.cos(dec) * Math.sin(NGP_DEC) * Math.cos(ra - NGP_RA);
  let l = L_NCP - Math.atan2(y, x);
  l = ((l * R2D) % 360 + 360) % 360;
  return [l, b * R2D];
}

/**
 * Star colour from colour index.
 *
 * B−V to effective temperature by Ballesteros (2012), then temperature to a
 * screen colour by the usual blackbody approximation. A B star comes out blue
 * and Betelgeuse comes out orange because that is what they are.
 */
export function starColour(bv) {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const k = Math.max(1000, Math.min(40000, t)) / 100;
  let r;
  let g;
  let b;
  if (k <= 66) {
    r = 255;
    g = 99.47 * Math.log(k) - 161.12;
    b = k <= 19 ? 0 : 138.52 * Math.log(k - 10) - 305.04;
  } else {
    r = 329.7 * (k - 60) ** -0.1332;
    g = 288.12 * (k - 60) ** -0.0755;
    b = 255;
  }
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)];
}

/** An integer hash to the unit interval. No trigonometry, no table. */
function hash2(x, y) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A direction on the sky as a unit vector. */
export function direction(raDeg, decDeg) {
  const ra = raDeg * D2R;
  const dec = decDeg * D2R;
  const cd = Math.cos(dec);
  return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)];
}

/** The catalogue, fetched once. */
export async function loadStars(url = 'data/sky/stars.json') {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`stars ${res.status}`);
  return res.json();
}

/**
 * What to spend, from most to least.
 *
 *   dpr      how much of the device's pixel density to use
 *   haze     points in the modelled faint field
 *   band     screen pixels per sample of the disc; larger is coarser
 *   glowTo   the faintest magnitude that gets a glow drawn under it
 *   spikeTo  the faintest that gets diffraction spikes
 */
const TIERS = [
  { dpr: 2, haze: 9000, band: 8, glowTo: 4.4, spikeTo: 2.1 },
  { dpr: 1.6, haze: 6000, band: 10, glowTo: 3.8, spikeTo: 1.9 },
  { dpr: 1.3, haze: 3600, band: 13, glowTo: 3.2, spikeTo: 1.6 },
  { dpr: 1.0, haze: 2200, band: 18, glowTo: 2.6, spikeTo: 1.2 },
];

/** What the device says about itself, before anything has been timed. */
function guessTier() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const small = Math.min(window.innerWidth, window.innerHeight) < 620;
  if (coarse && (cores <= 4 || mem <= 4 || small)) return 3;
  if (coarse || small) return 2;
  if (cores <= 4 || mem <= 4) return 1;
  return 0;
}

/** How wide the camera opens, and how far it closes at the end of a dive. */
const FOV_WIDE = 78;
const FOV_MIN = 20;
const FOV_MAX = 108;
const FOV_DIVE = 1.0;

export class Gate {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onPick: (o: object) => void, onName: (o: object|null) => void}} hooks
   */
  constructor(canvas, { onPick, onName }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.onPick = onPick;
    this.onName = onName;

    this.stars = null;
    this.targets = [];

    /** Where the camera looks, and how wide. Starts on the galactic centre. */
    this.cam = { ra: 266, dec: -12, fov: FOV_WIDE };
    /** The sweep: a slow turn with a gentle nod across the plane. */
    this.glide = { rate: 0.8, nod: 13, period: 110, phase: 0 };

    this.pointer = null;
    this.hit = null;
    this.drag = null;
    /** Live pointers, so two of them can pinch. */
    this.touches = new Map();
    this.pinch = null;
    this.coarse = matchMedia('(pointer: coarse)').matches;
    this.running = false;
    this.flight = null;
    this.band = null;

    this.tier = guessTier();
    /** A rolling average of how long a frame takes to draw, in milliseconds. */
    this.cost = 0;
    this.slow = 0;

    this.readTheme();
    this.bindPointer();
  }

  /* --------------------------------------------------------------- data */

  setStars(stars) {
    this.stars = stars;
    const n = stars.count;
    this.rgb = new Array(n);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    // Unit vectors once, so a frame is dot products rather than trigonometry.
    this.sv = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // Pushed away from grey: the catalogue colours are real, but the eye sees
      // far more of them against a black sky than a linear rendering gives back.
      const [r0, g0, b0] = starColour(stars.bv[i]);
      const mid = (r0 + g0 + b0) / 3;
      const sat = (v) => Math.max(0, Math.min(255, Math.round(mid + (v - mid) * 1.55)));
      this.rgb[i] = `${sat(r0)},${sat(g0)},${sat(b0)}`;

      const m = stars.mag[i];
      this.size[i] = Math.max(0.6, 2.4 - 0.33 * m);
      this.alpha[i] = Math.max(0.4, Math.min(1, 1.3 - 0.11 * m));

      const [x, y, z] = direction(stars.ra[i], stars.dec[i]);
      this.sv[i * 3] = x;
      this.sv[i * 3 + 1] = y;
      this.sv[i * 3 + 2] = z;
    }
    this.named = new Map(stars.named.map((x) => [x.i, x]));
    this.buildBuckets();
  }

  /**
   * Stars grouped by the state they need, so a bucket draws in one call.
   *
   * Seven colour bins by eight steps of opacity. Both are quantities the eye
   * reads as a ladder rather than a continuum — the opacity comes from
   * magnitude, which is a ladder by definition — so nothing is lost, and the
   * geometry of every individual star stays exact.
   */
  buildBuckets() {
    const STEPS = 8;
    const n = this.stars.count;
    const key = new Int32Array(n);
    const tally = new Int32Array(7 * STEPS);
    for (let i = 0; i < n; i++) {
      const bin = this.glowBin(this.stars.bv[i]);
      // Opacity runs 0.4 to 1.0; put it on the ladder.
      const step = Math.max(0, Math.min(STEPS - 1,
        Math.round(((this.alpha[i] - 0.4) / 0.6) * (STEPS - 1))));
      const k = bin * STEPS + step;
      key[i] = k;
      tally[k]++;
    }

    this.starBuckets = [];
    const fill = new Int32Array(7 * STEPS);
    const slots = new Array(7 * STEPS);
    for (let k = 0; k < tally.length; k++) {
      if (!tally[k]) { slots[k] = null; continue; }
      slots[k] = new Int32Array(tally[k]);
    }
    for (let i = 0; i < n; i++) {
      const k = key[i];
      slots[k][fill[k]++] = i;
    }
    for (let k = 0; k < slots.length; k++) {
      if (!slots[k]) continue;
      const idx = slots[k];
      // One representative width for the whole bucket, used only for the
      // trails during a dive — within a bucket the stars differ by a quarter
      // of a pixel.
      let width = 0;
      for (let q = 0; q < idx.length; q++) width += this.size[idx[q]];
      this.starBuckets.push({
        idx,
        style: `rgb(${this.rgb[idx[0]]})`,
        alpha: 0.4 + (0.6 * (k % STEPS)) / (STEPS - 1),
        width: width / idx.length,
      });
    }
  }

  /**
   * The things worth opening.
   *
   * Only these are marked. A star in the background is scenery; a marker is a
   * promise that pressing it gets you SPHEREx's frames of that position, so
   * nothing goes in here that the tool cannot actually deliver.
   */
  setTargets(targets) {
    this.targets = targets
      .filter((t) => Number.isFinite(t.ra) && Number.isFinite(t.dec))
      .map((t) => ({ ...t, v: direction(t.ra, t.dec) }));
  }

  /* ------------------------------------------------------------- camera */

  get quality() { return TIERS[this.tier]; }

  /**
   * Drop a rung.
   *
   * The canvas is re-measured because the pixel density changed, and the faint
   * field is rebuilt because it has fewer points in it. Both are cheap and both
   * happen at most three times in the life of the page.
   */
  stepDown() {
    if (this.tier >= TIERS.length - 1) return false;
    this.tier++;
    this.haze = null;
    this.low = null;
    this.measure();
    this.buildHaze(this.quality.haze);
    this.cost = 0;
    this.slow = 0;
    return true;
  }

  measure() {
    const dpr = Math.min(this.quality.dpr, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.box = { width: w * dpr, height: h * dpr, dpr, cssW: w, cssH: h };
    this.canvas.width = this.box.width;
    this.canvas.height = this.box.height;
    this.buildBasis();
  }

  /**
   * The camera's three axes.
   *
   * Forward is where it looks. Right is the direction of increasing right
   * ascension, which puts east on the left of the screen — every sky chart is
   * drawn that way, because the sky is seen from inside the sphere. Up is what
   * is left over, so celestial north is up wherever the camera is not pointed
   * at a pole.
   */
  buildBasis(fov = this.cam.fov) {
    const f = direction(this.cam.ra, this.cam.dec);
    // right = ẑ × f, normalised. Degenerate only at the poles themselves.
    let rx = -f[1];
    let ry = f[0];
    let rl = Math.hypot(rx, ry);
    if (rl < 1e-6) { rx = 1; ry = 0; rl = 1; }
    rx /= rl;
    ry /= rl;
    const r = [rx, ry, 0];
    const u = [
      f[1] * r[2] - f[2] * r[1],
      f[2] * r[0] - f[0] * r[2],
      f[0] * r[1] - f[1] * r[0],
    ];
    this.basis = { f, r, u };
    this.focal = (this.box.height / 2) / Math.tan((fov / 2) * D2R);
  }

  /**
   * A direction to canvas pixels, or null if it is behind the camera.
   *
   * @param {number[]} v unit vector
   * @param {number} [focal] overridden during a dive, to draw where it was
   */
  projectV(v, focal = this.focal) {
    return this.at(v[0], v[1], v[2], focal) ? [this.px, this.py] : null;
  }

  /**
   * The same projection with nothing allocated: the answer lands in `px` and
   * `py` and the return value says whether it is in front of the camera.
   *
   * Nineteen thousand points go through here every frame. A returned pair would
   * be nineteen thousand short-lived arrays a frame, which is what the garbage
   * collector was choking on — the arithmetic was never the cost.
   */
  at(vx, vy, vz, focal = this.focal) {
    const { f, r, u } = this.basis;
    const z = vx * f[0] + vy * f[1] + vz * f[2];
    if (z <= 0.04) return false;
    const x = vx * r[0] + vy * r[1] + vz * r[2];
    const y = vx * u[0] + vy * u[1] + vz * u[2];
    // Minus on x: right ascension increases to the left.
    this.px = this.box.width / 2 - (focal * x) / z;
    this.py = this.box.height / 2 - (focal * y) / z;
    return true;
  }

  project(raDeg, decDeg, focal) {
    return this.projectV(direction(raDeg, decDeg), focal);
  }

  /** Canvas pixels back to sky coordinates. */
  unproject(px, py) {
    const { f, r, u } = this.basis;
    const a = (this.box.width / 2 - px) / this.focal;
    const b = (this.box.height / 2 - py) / this.focal;
    const v = [
      f[0] + a * r[0] + b * u[0],
      f[1] + a * r[1] + b * u[1],
      f[2] + a * r[2] + b * u[2],
    ];
    const len = Math.hypot(v[0], v[1], v[2]);
    const dec = Math.asin(v[2] / len) * R2D;
    const ra = ((Math.atan2(v[1], v[0]) * R2D) % 360 + 360) % 360;
    return [ra, dec];
  }

  /** Kept for callers that think in terms of where the sky is centred. */
  get centreRA() { return this.cam.ra; }

  set centreRA(v) { this.cam.ra = ((v % 360) + 360) % 360; }

  /* --------------------------------------------------------- milky way */

  /**
   * How bright the disc is in that direction, 0 to 1.
   *
   * Four terms, each a real feature described at the crudest useful level —
   * this is a model, and the page says so:
   *
   *   core   a thin, bright disc: most of the light, within a few degrees
   *   halo   a much wider, fainter one: the thick disc and the near field
   *   bulge  the inner Galaxy toward Sagittarius, the brightest part of the
   *          Milky Way in every photograph anyone has ever taken of it
   *   rift   the Great Rift — dust in the Cygnus-to-Sagittarius arm, which cuts
   *          the northern band lengthwise and is why it looks split
   */
  discBrightness(l, b, ra, dec) {
    const ab = Math.abs(b);
    const core = 0.44 * Math.exp(-ab / 8.5);
    const halo = 0.26 * Math.exp(-ab / 26);
    const dl = Math.min(Math.abs(l), 360 - Math.abs(l));
    const bulge = 2.1 * Math.exp(-((dl / 26) ** 2)) * Math.exp(-((ab / 15) ** 2));
    let v = (core + halo) * (1 + bulge);

    if (l > 340 || l < 100) {
      const along = l > 340 ? l - 360 : l;
      const reach = Math.exp(-(((along - 42) / 50) ** 2));
      const across = Math.exp(-(((b + 1.4) / 4.2) ** 2));
      v *= 1 - 0.68 * reach * across;
      // A second, narrower lane: the dark clouds that break the band into
      // strands rather than splitting it once.
      v *= 1 - 0.3 * Math.exp(-(((along - 20) / 26) ** 2))
        * Math.exp(-(((b + 4.5) / 2.4) ** 2));
    }

    v *= 0.74 + 0.5 * this.mottle(ra, dec);
    return Math.max(0, Math.min(1, v));
  }

  /**
   * Value noise on the sphere, deterministic: the same sky on every machine.
   *
   * Two octaves, not three. The band is stretched over tens of degrees and the
   * third octave was finer than anything the eye could find in it.
   */
  mottle(ra, dec) {
    const a = this.lattice(ra * 0.55, (dec + 90) * 0.55);
    const b = this.lattice(ra * 1.27, (dec + 90) * 1.27);
    return (a + 0.5 * b) / 1.5;
  }

  /**
   * One cell of value noise.
   *
   * The hash is an integer mix rather than the usual fract(sin(...)) — the same
   * output to the eye, and it does not put a transcendental function inside a
   * loop that runs half a million times.
   */
  lattice(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    return (hash2(xi, yi) * (1 - u) + hash2(xi + 1, yi) * u) * (1 - v)
      + (hash2(xi, yi + 1) * (1 - u) + hash2(xi + 1, yi + 1) * u) * v;
  }

  /** The disc as an image in sky coordinates, laid on the sphere as a mesh. */
  buildBand() {
    const W = 900;
    const H = 450;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    for (let py = 0; py < H; py++) {
      const dec = 90 - (py + 0.5) * (180 / H);
      for (let px = 0; px < W; px++) {
        const ra = (px + 0.5) * (360 / W);
        const [l, b] = galactic(ra, dec);
        const v = this.discBrightness(l, b, ra, dec);
        const i = (py * W + px) * 4;
        // Warmer where it is bright, bluer where it is faint — which is what
        // happens, because the bright parts are the crowded inner disc.
        const warm = Math.min(1, v * 1.25);
        d[i] = Math.round((92 + 86 * warm) * v);
        d[i + 1] = Math.round((128 + 58 * warm) * v);
        d[i + 2] = Math.round((186 + 14 * warm) * v);
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.band = c;
    this.bandW = W;
    this.bandH = H;
    // Kept so the faint field can be sampled from the model already evaluated
    // rather than evaluating it again a million times.
    this.bandPixels = d;
  }

  /**
   * The faint field.
   *
   * Five thousand catalogued stars is the naked-eye sky, and the naked-eye sky
   * is emptier than a photograph of it. The rest of what a camera picks up is
   * tens of thousands of stars too faint to catalogue here, and they crowd the
   * disc rather than scattering evenly — so these are drawn from the same disc
   * model as the band, by rejection sampling, with a fixed seed.
   *
   * Modelled, not catalogued. Nothing in the tool ever measures them.
   */
  buildHaze(n = TIERS[0].haze) {
    if (!this.band) this.buildBand();
    const W = this.bandW;
    const H = this.bandH;
    const px = this.bandPixels;

    let seed = 20260921;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const v = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    let made = 0;
    let guard = 0;
    while (made < n && guard < n * 40) {
      guard++;
      const ra = rnd() * 360;
      // Uniform on the sphere, so the poles are not over-populated.
      const dec = Math.asin(rnd() * 2 - 1) * R2D;
      // The model, already evaluated: read the band's own green channel, which
      // tracks its brightness, instead of computing the disc again.
      const ix = Math.min(W - 1, Math.floor((ra / 360) * W));
      const iy = Math.min(H - 1, Math.floor(((90 - dec) / 180) * H));
      const b = px[(iy * W + ix) * 4 + 1] / 255;
      if (rnd() > 0.09 + 0.91 * b) continue;
      const [x, y, z] = direction(ra, dec);
      v[made * 3] = x;
      v[made * 3 + 1] = y;
      v[made * 3 + 2] = z;
      alpha[made] = 0.2 + 0.5 * rnd();
      made++;
    }
    // Grouped by opacity for the same reason the stars are: one state change
    // per group rather than one per point.
    const STEPS = 6;
    const tally = new Int32Array(STEPS);
    const key = new Int32Array(made);
    for (let i = 0; i < made; i++) {
      const k = Math.max(0, Math.min(STEPS - 1,
        Math.round(((alpha[i] - 0.2) / 0.5) * (STEPS - 1))));
      key[i] = k;
      tally[k]++;
    }
    const slots = [];
    const fill = new Int32Array(STEPS);
    for (let k = 0; k < STEPS; k++) slots.push(tally[k] ? new Int32Array(tally[k]) : null);
    for (let i = 0; i < made; i++) slots[key[i]][fill[key[i]]++] = i;

    this.haze = {
      v,
      n: made,
      buckets: slots
        .map((idx, k) => (idx ? { idx, alpha: 0.2 + (0.5 * k) / (STEPS - 1) } : null))
        .filter(Boolean),
    };
  }

  /**
   * Glow sprites, one per colour bin.
   *
   * A bright point spreads — in the eye, in a lens, on a sensor. Drawing that
   * spread as a blurred disc under the star is the single thing that makes a
   * field of dots look like a sky. Built once, at seven colour temperatures,
   * and stamped rather than computed, so it costs one blit per bright star.
   */
  buildGlows() {
    const R = 48;
    this.glows = [];
    for (let bin = 0; bin < 7; bin++) {
      const bv = -0.3 + (bin / 6) * 2.1;
      const [r, g, b] = starColour(bv);
      const c = document.createElement('canvas');
      c.width = R * 2;
      c.height = R * 2;
      const x = c.getContext('2d');
      const grad = x.createRadialGradient(R, R, 0, R, R, R);
      // Three stops, not two: a real point spread has a tight core and a long
      // faint skirt, and a linear fade has neither.
      grad.addColorStop(0, `rgba(${r},${g},${b},0.95)`);
      grad.addColorStop(0.12, `rgba(${r},${g},${b},0.34)`);
      grad.addColorStop(0.36, `rgba(${r},${g},${b},0.08)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      x.fillStyle = grad;
      x.fillRect(0, 0, R * 2, R * 2);
      this.glows.push(c);
    }
  }

  glowBin(bv) { return Math.max(0, Math.min(6, Math.round(((bv + 0.3) / 2.1) * 6))); }

  /* ------------------------------------------------------------- paint */

  /**
   * The disc, laid onto the sphere as a mesh of small quads.
   *
   * Each cell of sky is a rectangle in the band image and a four-sided figure
   * on screen; over six degrees the difference between that figure and a
   * parallelogram is under a pixel, so one affine transform per cell is enough.
   * Cells are drawn slightly large so the seams between them close.
   */
  drawBand(target) {
    if (!this.band) return;
    /** Screen pixels per sample. The disc has no detail this fine. */
    const SS = this.quality.band;
    const { width, height } = this.box;
    const W = Math.max(2, Math.ceil(width / SS));
    const H = Math.max(2, Math.ceil(height / SS));

    if (!this.low || this.low.width !== W || this.low.height !== H) {
      this.low = document.createElement('canvas');
      this.low.width = W;
      this.low.height = H;
      this.lowCtx = this.low.getContext('2d');
      this.lowImg = this.lowCtx.createImageData(W, H);
    }

    const out = this.lowImg.data;
    const src = this.bandPixels;
    const bw = this.bandW;
    const bh = this.bandH;
    const { f, r, u } = this.basis;
    const { focal } = this;
    const cx = width / 2;
    const cy = height / 2;
    const INV_PI = 1 / Math.PI;

    for (let py = 0; py < H; py++) {
      const b = (cy - (py + 0.5) * SS) / focal;
      for (let px = 0; px < W; px++) {
        const a = (cx - (px + 0.5) * SS) / focal;
        // The ray through that pixel, in world coordinates.
        const vx = f[0] + a * r[0] + b * u[0];
        const vy = f[1] + a * r[1] + b * u[1];
        const vz = f[2] + a * r[2] + b * u[2];
        const len = Math.sqrt(vx * vx + vy * vy + vz * vz);

        // Straight to the band's own row and column: the declination only ever
        // gets used to index a row, so it never has to become degrees.
        let row = (0.5 - Math.asin(vz / len) * INV_PI) * bh;
        row = row < 0 ? 0 : (row >= bh ? bh - 1 : row | 0);
        let col = (Math.atan2(vy, vx) * INV_PI * 0.5 + 1) * bw;
        col %= bw;
        col |= 0;

        const si = (row * bw + col) * 4;
        const di = (py * W + px) * 4;
        out[di] = src[si];
        out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2];
        out[di + 3] = 255;
      }
    }

    this.lowCtx.putImageData(this.lowImg, 0, 0);
    target.imageSmoothingEnabled = true;
    target.imageSmoothingQuality = 'high';
    target.globalCompositeOperation = 'lighter';
    target.drawImage(this.low, 0, 0, width, height);
    target.globalCompositeOperation = 'source-over';
  }

  draw() {
    const { ctx } = this;
    const { width, height, dpr } = this.box;
    const f = this.flight;
    this.buildBasis(f ? f.fov : this.cam.fov);
    const focal = this.focal;
    // Where things were a fifth of a second ago, for the trails.
    const focalPrev = f ? (height / 2) / Math.tan((f.fovPrev / 2) * D2R) : focal;
    const streak = !!f && Math.abs(focalPrev - focal) > 0.5;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.paint.well;
    ctx.fillRect(0, 0, width, height);

    this.drawBand(ctx);
    if (!this.stars) return;

    // The faint field: the ground the catalogue sits on.
    if (this.haze) {
      const { v } = this.haze;
      ctx.fillStyle = '#cfe0f2';
      ctx.strokeStyle = '#cfe0f2';
      ctx.lineWidth = dpr;
      ctx.lineCap = 'round';
      for (const b of this.haze.buckets) {
        const { idx } = b;
        ctx.globalAlpha = b.alpha;
        ctx.beginPath();
        let drew = false;
        for (let k = 0; k < idx.length; k++) {
          const j = idx[k] * 3;
          const vx = v[j];
          const vy = v[j + 1];
          const vz = v[j + 2];
          if (!this.at(vx, vy, vz, focal)) continue;
          const x = this.px;
          const y = this.py;
          if (x < -2 || x > width + 2 || y < -2 || y > height + 2) continue;
          if (streak && this.at(vx, vy, vz, focalPrev)) {
            ctx.moveTo(this.px, this.py);
            ctx.lineTo(x, y);
          } else {
            ctx.rect(x, y, dpr, dpr);
          }
          drew = true;
        }
        if (!drew) continue;
        if (streak) ctx.stroke();
        else ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    const { mag, bv } = this.stars;
    const n = this.stars.count;
    const sv = this.sv;
    const { glowTo, spikeTo } = this.quality;

    // The spread first, all of it, so no star sits on another's glow.
    if (this.glows && !streak) {
      // Wider when the camera is narrow: a bright star fills more of a small
      // field, which is why a telescope's stars are fat.
      const zoom = Math.min(2.4, Math.sqrt(FOV_WIDE / Math.max(FOV_DIVE, this.cam.fov)));
      ctx.globalCompositeOperation = 'lighter';
      let lastAlpha = -1;
      for (let i = 0; i < n; i++) {
        if (mag[i] > glowTo) continue;
        const j = i * 3;
        if (!this.at(sv[j], sv[j + 1], sv[j + 2], focal)) continue;
        const x = this.px;
        const y = this.py;
        if (x < -90 || x > width + 90 || y < -90 || y > height + 90) continue;
        const r = Math.max(3, 17 - 2.7 * mag[i]) * dpr * zoom;
        // The catalogue comes sorted by magnitude, so this only ever steps
        // down: about twenty changes for five thousand stars.
        const a = Math.round(Math.max(0.05, Math.min(0.9, 0.52 - 0.09 * mag[i])) * 40) / 40;
        if (a !== lastAlpha) { ctx.globalAlpha = a; lastAlpha = a; }
        ctx.drawImage(this.glows[this.glowBin(bv[i])], x - r, y - r, r * 2, r * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    ctx.lineCap = 'round';
    const TAU = Math.PI * 2;
    for (const b of this.starBuckets) {
      const { idx } = b;
      ctx.globalAlpha = b.alpha;
      ctx.beginPath();
      let drew = false;
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        const j = i * 3;
        const vx = sv[j];
        const vy = sv[j + 1];
        const vz = sv[j + 2];
        if (!this.at(vx, vy, vz, focal)) continue;
        const x = this.px;
        const y = this.py;
        if (x < -6 || x > width + 6 || y < -6 || y > height + 6) continue;
        if (streak) {
          if (!this.at(vx, vy, vz, focalPrev)) continue;
          ctx.moveTo(this.px, this.py);
          ctx.lineTo(x, y);
          drew = true;
          continue;
        }
        const r = this.size[i] * dpr;
        if (r < 0.9) ctx.rect(x, y, r * 2, r * 2);
        else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); }
        drew = true;
      }
      if (!drew) continue;
      if (streak) {
        ctx.strokeStyle = b.style;
        ctx.lineWidth = Math.max(b.width * dpr * 1.3, 0.9 * dpr);
        ctx.stroke();
      } else {
        ctx.fillStyle = b.style;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Spikes, only where a camera would actually show them.
    if (!streak) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        if (mag[i] > spikeTo) continue;
        const j = i * 3;
        if (!this.at(sv[j], sv[j + 1], sv[j + 2], focal)) continue;
        const p = [this.px, this.py];
        if (p[0] < -70 || p[0] > width + 70 || p[1] < -70 || p[1] > height + 70) continue;
        const len = (28 - 7 * mag[i]) * dpr;
        ctx.strokeStyle = `rgb(${this.rgb[i]})`;
        ctx.lineWidth = 0.9 * dpr;
        ctx.globalAlpha = 0.32;
        ctx.beginPath();
        ctx.moveTo(p[0] - len, p[1]);
        ctx.lineTo(p[0] + len, p[1]);
        ctx.moveTo(p[0], p[1] - len);
        ctx.lineTo(p[0], p[1] + len);
        ctx.stroke();
        const dd = len * 0.5;
        ctx.globalAlpha = 0.15;
        ctx.beginPath();
        ctx.moveTo(p[0] - dd, p[1] - dd);
        ctx.lineTo(p[0] + dd, p[1] + dd);
        ctx.moveTo(p[0] + dd, p[1] - dd);
        ctx.lineTo(p[0] - dd, p[1] + dd);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // Labels have no business in a moving frame: they are not in the sky, so
    // they would slide across it rather than through it.
    if (!f) {
      this.drawTargets(ctx);
      this.drawHit(ctx);
    }
    this.drawArrival(ctx);
  }

  /**
   * The markers.
   *
   * The glyph says what kind of thing it is, because "galaxy" and "planet" are
   * different answers to "what am I about to open". Planets and ready fields
   * keep their names on screen; the rest name themselves when the pointer
   * reaches them, or the sky would be a wall of type instead of a sky.
   */
  drawTargets(ctx) {
    const { dpr, width, height } = this.box;
    const { accent, counter, ink } = this.paint;

    ctx.lineWidth = 1.2 * dpr;
    ctx.font = `${12 * dpr}px ${this.paint.body}`;
    ctx.textBaseline = 'middle';

    for (const tgt of this.targets) {
      const p = this.projectV(tgt.v);
      if (!p) continue;
      const [x, y] = p;
      if (x < -60 || x > width + 60 || y < -30 || y > height + 30) continue;
      const near = this.hit?.item === tgt;
      const colour = tgt.kind === 'planet' ? counter : accent;
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.globalAlpha = near ? 1 : (tgt.kind === 'deep' ? 0.38 : 0.85);

      const r = (tgt.kind === 'deep' ? 4 : 7) * dpr;
      this.glyph(ctx, tgt, x, y, r);

      if (tgt.kind !== 'deep' || near) {
        ctx.globalAlpha = near ? 1 : 0.8;
        ctx.fillStyle = near ? ink : colour;
        ctx.fillText(tgt.label, x + r + 7 * dpr, y);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** One shape per kind of thing. */
  glyph(ctx, tgt, x, y, r) {
    ctx.beginPath();
    switch (tgt.kind === 'deep' ? tgt.shape : tgt.kind) {
      case 'planet':
        // Filled, with a ring: it is solid, and it moves.
        ctx.arc(x, y, r * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'field':
        // Two rings: the frames for this one are already on disk.
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'galaxy':
        ctx.ellipse(x, y, r, r * 0.52, -0.5, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'cluster':
        ctx.arc(x, y, r * 0.85, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'nebula':
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.stroke();
        break;
      default:
        ctx.moveTo(x - r * 0.8, y);
        ctx.lineTo(x + r * 0.8, y);
        ctx.moveTo(x, y - r * 0.8);
        ctx.lineTo(x, y + r * 0.8);
        ctx.stroke();
    }
  }

  /** A ring around whatever the pointer is nearest to. */
  drawHit(ctx) {
    if (!this.hit) return;
    const p = this.projectV(direction(this.hit.ra, this.hit.dec));
    if (!p) return;
    ctx.strokeStyle = this.paint.ink;
    ctx.lineWidth = this.box.dpr;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 16 * this.box.dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /**
   * Arriving.
   *
   * The last stretch of the dive blows out from the target, which hides the
   * moment the frames take over and is, honestly, what arriving at something
   * bright looks like.
   */
  drawArrival(ctx) {
    const f = this.flight;
    if (!f || f.t < 0.84) return;
    const p = this.projectV(direction(f.ra, f.dec)) ?? [this.box.width / 2, this.box.height / 2];
    const s = (f.t - 0.84) / 0.16;
    const r = Math.max(this.box.width, this.box.height) * (0.12 + 1.5 * s * s);
    const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
    const a = Math.min(1, s * 1.35);
    g.addColorStop(0, `rgba(226,240,252,${a})`);
    g.addColorStop(0.45, `rgba(120,180,230,${a * 0.5})`);
    g.addColorStop(1, 'rgba(120,180,230,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.box.width, this.box.height);
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * The palette, read once.
   *
   * Resolving a custom property means resolving the cascade, and the cascade
   * does not change between two frames of a star drifting. Call this when the
   * theme might have moved; never from inside a frame.
   */
  readTheme() {
    // From the canvas, not the root: the gate re-declares the night palette on
    // itself, so the way in stays the night sky when the page is set to day.
    const css = getComputedStyle(this.canvas);
    const get = (token, fallback) => css.getPropertyValue(token).trim() || fallback;
    this.paint = {
      well: get('--color-well', '#05080e'),
      accent: get('--color-accent', '#6cc4f0'),
      counter: get('--color-counter', '#f0a94b'),
      ink: get('--color-ink', '#e9f1f7'),
      body: get('--font-body', 'sans-serif'),
    };
  }

  /* ---------------------------------------------------------- pointing */

  bindPointer() {
    const local = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      return [
        (e.clientX - rect.left) * (this.box?.width ?? 0) / (rect.width || 1),
        (e.clientY - rect.top) * (this.box?.height ?? 0) / (rect.height || 1),
      ];
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.flight) return;
      this.canvas.setPointerCapture(e.pointerId);
      this.touches.set(e.pointerId, local(e));
      // A touch has not hovered anything, so the press has to find its own
      // target; setting the pointer here is what lets it.
      this.pointer = this.touches.get(e.pointerId);

      if (this.touches.size === 2) {
        // A second finger cancels the drag and starts a pinch.
        this.drag = null;
        const [a, b] = [...this.touches.values()];
        this.pinch = { span: Math.hypot(a[0] - b[0], a[1] - b[1]), fov: this.cam.fov };
        return;
      }
      this.drag = { at: this.pointer, ra: this.cam.ra, dec: this.cam.dec, moved: 0 };
      this.canvas.style.cursor = 'grabbing';
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const p = local(e);
      if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, p);
      this.pointer = p;

      if (this.pinch && this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        const span = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (span > 8 && this.pinch.span > 8) {
          // Fingers apart is a narrower field: the sky comes toward you.
          this.cam.fov = Math.max(FOV_MIN, Math.min(FOV_MAX,
            (this.pinch.fov * this.pinch.span) / span));
          this.draw();
        }
        return;
      }

      if (this.drag) {
        // Degrees per pixel at the current field of view, so the sky moves by
        // exactly as much as the pointer moved across it.
        const perPx = this.cam.fov / this.box.height;
        const dx = p[0] - this.drag.at[0];
        const dy = p[1] - this.drag.at[1];
        this.drag.moved = Math.max(this.drag.moved, Math.hypot(dx, dy));
        this.cam.ra = ((this.drag.ra + dx * perPx) % 360 + 360) % 360;
        this.cam.dec = Math.max(-88, Math.min(88, this.drag.dec - dy * perPx));
        if (this.hit) { this.hit = null; this.onName?.(null); }
        this.draw();
        return;
      }
      this.findHit();
    });

    const release = (e) => {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      if (!this.drag) return;
      const { moved } = this.drag;
      this.drag = null;
      this.canvas.style.cursor = 'grab';
      // A drag is not a press. A thumb wobbles further than a cursor does.
      if (moved < (this.coarse ? 10 : 4)) { this.findHit(); this.press(); }
    };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);

    this.canvas.addEventListener('pointerleave', () => {
      // A touch that lifts is gone; a cursor that leaves takes its label with it.
      if (this.coarse) return;
      this.pointer = null;
      if (this.hit) { this.hit = null; this.onName?.(null); }
    });

    this.canvas.addEventListener('wheel', (e) => {
      if (this.flight) return;
      e.preventDefault();
      this.cam.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, this.cam.fov * Math.exp(e.deltaY * 0.0012)));
      this.findHit();
      this.draw();
    }, { passive: false });
  }

  press() {
    if (this.hit) { this.onPick?.(this.hit); return; }
    if (!this.pointer) return;
    const [ra, dec] = this.unproject(this.pointer[0], this.pointer[1]);
    this.onPick?.({ kind: 'sky', ra, dec, label: null });
  }

  /**
   * What is under the pointer.
   *
   * A marker always wins over a star behind it: the marker is something the
   * tool can open now, the star is a position it would have to go and fetch.
   */
  findHit() {
    if (!this.pointer || !this.stars || this.flight) return;
    const [px, py] = this.pointer;
    let best = null;
    let bestD = (this.coarse ? 40 : 24) * this.box.dpr;

    for (const tgt of this.targets) {
      const p = this.projectV(tgt.v);
      if (!p) continue;
      const d = Math.hypot(p[0] - px, p[1] - py);
      if (d < bestD) { bestD = d; best = { ...tgt, item: tgt }; }
    }
    if (!best) {
      for (const [i, entry] of this.named) {
        const p = this.projectV([this.sv[i * 3], this.sv[i * 3 + 1], this.sv[i * 3 + 2]]);
        if (!p) continue;
        const d = Math.hypot(p[0] - px, p[1] - py);
        if (d < bestD) {
          bestD = d;
          best = {
            kind: 'star',
            ra: this.stars.ra[i],
            dec: this.stars.dec[i],
            label: entry.name || entry.bayer,
            sub: entry.name ? entry.bayer : '',
            mag: this.stars.mag[i],
          };
        }
      }
    }

    const changed = best?.label !== this.hit?.label;
    this.hit = best;
    if (changed) { this.onName?.(best); this.draw(); }
    if (!this.drag) this.canvas.style.cursor = best ? 'pointer' : 'grab';
  }

  /* -------------------------------------------------------------- dive */

  /**
   * Turn onto a position and dive at it.
   *
   * The camera turns first, over the opening third, and then the field of view
   * closes from seventy-eight degrees to one. Everything off-axis sweeps
   * outward past the edges, faster the further out it starts — which is what
   * approaching something looks like from inside a sphere.
   *
   * @param {{ra:number, dec:number}} at
   * @param {{out?:boolean, ms?:number}} how — `out` runs the same path backwards
   */
  fly(at, { out = false, ms = 2600 } = {}) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.cam.ra = at.ra;
      this.cam.dec = at.dec;
      this.cam.fov = FOV_WIDE;
      this.flight = null;
      this.draw();
      return new Promise((r) => { setTimeout(r, 140); });
    }

    /** The exposure the trails are drawn over, as a fraction of the run. */
    const TAU = 0.075;
    const from = { ra: this.cam.ra, dec: this.cam.dec };
    // The short way round: turning 350 degrees to reach a point 10 degrees away
    // is a bug, not a flourish.
    const dRA = ((at.ra - from.ra + 540) % 360) - 180;
    const dDec = at.dec - from.dec;

    return new Promise((resolve) => {
      const t0 = performance.now();
      // Where the camera is, and how wide, at a given point in the run.
      const state = (t) => {
        const tc = Math.max(0, Math.min(1, t));
        const turn = Math.min(1, tc / 0.34);
        const ease = turn * turn * (3 - 2 * turn);
        // Cubic, so the speed builds through the whole dive rather than
        // arriving all at once at the end.
        const k = out ? 1 - tc ** 3 : tc ** 3;
        const aim = out ? 1 : ease;
        return {
          ra: from.ra + dRA * aim,
          dec: from.dec + dDec * aim,
          fov: FOV_WIDE * (FOV_DIVE / FOV_WIDE) ** k,
        };
      };

      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        const s = state(t);
        const prev = state(out ? t + TAU : t - TAU);
        this.cam.ra = s.ra;
        this.cam.dec = s.dec;
        this.flight = { ra: at.ra, dec: at.dec, fov: s.fov, fovPrev: prev.fov, t: out ? 1 - t : t };
        this.draw();
        if (t < 1) { this.flightRaf = requestAnimationFrame(step); return; }
        this.flight = null;
        this.cam.fov = out ? FOV_WIDE : FOV_DIVE;
        this.draw();
        resolve();
      };
      this.flightRaf = requestAnimationFrame(step);
    });
  }

  /* ------------------------------------------------------------- loop */

  start() {
    if (this.running) return;
    this.running = true;
    this.cam.fov = FOV_WIDE;
    // Someone who has asked for less motion gets a still sky that still
    // answers the pointer — and a device that never spins up for it.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.draw();
      return;
    }
    let last = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      if (this.flight) { this.raf = requestAnimationFrame(tick); return; }
      // The sweep turns the camera by a hundredth of a degree a frame at
      // display rate, which is a fraction of a pixel. Thirty frames a second
      // is indistinguishable from sixty here and costs half as much; a drag or
      // a dive drives its own frames and is not throttled.
      if (!this.drag && now - last < 32) { this.raf = requestAnimationFrame(tick); return; }
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // The sweep: a slow turn with a gentle nod, the way an instrument in
      // orbit crosses the sky. It holds still while you are reading it.
      if (!this.pointer && !this.drag) {
        this.glide.phase += dt;
        this.cam.ra = (this.cam.ra + this.glide.rate * dt) % 360;
        this.cam.dec = this.glide.nod
          * Math.sin(((2 * Math.PI) / this.glide.period) * this.glide.phase) - 6;
      }

      const t0 = performance.now();
      this.draw();
      // A rolling average rather than one reading: a single slow frame is a
      // garbage collection or another tab, not a verdict on the machine.
      this.cost = this.cost ? this.cost * 0.9 + (performance.now() - t0) * 0.1
        : performance.now() - t0;
      if (this.cost > 19) {
        if (++this.slow > 45) this.stepDown();
      } else if (this.slow) {
        this.slow--;
      }

      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.flightRaf) cancelAnimationFrame(this.flightRaf);
  }

  resize() {
    this.readTheme();
    this.measure();
    if (!this.band) this.buildBand();
    if (!this.haze) this.buildHaze(this.quality.haze);
    if (!this.glows) this.buildGlows();
    this.draw();
  }
}

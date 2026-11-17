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
 *   · the disc   — the Milky Way as SPHEREx surveyed it (data/sky/milkyway.png,
 *                  made by tools/build-gate-sky.mjs from the DR1 all-sky cube
 *                  at 0.91, 2.00 and 4.70 µm as blue, green and red). Until it
 *                  has arrived, a model of the galactic disc stands in for it,
 *                  computed from galactic coordinates, and gives way to it
 *                  over most of a second; the colophon says which is on screen.
 *
 * Drag to look around, wheel to widen or narrow. Press a marker and the camera
 * turns onto it and dives: the field of view closes from seventy-eight degrees
 * to one, so everything off-axis sweeps outward past the edges. The streaks are
 * the real displacement between where a star was a fifth of a second ago and
 * where it is now, computed from the same curve that drives the dive — a long
 * exposure of the motion rather than a blur laid over it.
 */

import { createBandLayer } from './gate-band.js';
import { createSurveySky } from './gate-sky.js';
import { starColour } from './starcolour.js';
import { vecOfXyf, tileAt, tileCentre, radecOf } from './allsky/healpix.js';

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

/** Star colour from colour index: starcolour.js, kept here under its old address. */
export { starColour };

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

/**
 * How a catalogued star is drawn, from its own numbers: the same mapping for
 * the sky here and for the sky in the headset (js/vr/).
 *
 * The colour is pushed away from grey: the catalogue colours are real, but the
 * eye sees far more of them against a black sky than a linear rendering gives
 * back. The size is steep on purpose: the bright stars carry the
 * constellations, the faint ones are the texture behind them.
 */
export function starTint(bv) {
  const [r0, g0, b0] = starColour(bv);
  const mid = (r0 + g0 + b0) / 3;
  const sat = (v) => Math.max(0, Math.min(255, Math.round(mid + (v - mid) * 1.55)));
  return [sat(r0), sat(g0), sat(b0)];
}

/** A star's radius in CSS pixels, from its magnitude. */
export const starRadius = (mag) => Math.max(0.45, 3.0 - 0.42 * mag);

/** A star's opacity, from its magnitude. */
export const starAlpha = (mag) => Math.max(0.3, Math.min(1, 1.4 - 0.15 * mag));

/** The spread drawn under a bright star: its radius in CSS pixels at the wide view, and its opacity. */
export const glowRadius = (mag) => Math.max(3, 20 - 3.1 * mag);
export const glowAlpha = (mag) => Math.max(0.05, Math.min(0.9, 0.62 - 0.1 * mag));

/* ----------------------------------------------------------- milky way */

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
export function discBrightness(l, b, ra, dec) {
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

  v *= 0.74 + 0.5 * mottle(ra, dec);
  return Math.max(0, Math.min(1, v));
}

/**
 * Value noise on the sphere, deterministic: the same sky on every machine.
 *
 * Two octaves, not three. The band is stretched over tens of degrees and the
 * third octave was finer than anything the eye could find in it.
 */
function mottle(ra, dec) {
  const a = lattice(ra * 0.55, (dec + 90) * 0.55);
  const b = lattice(ra * 1.27, (dec + 90) * 1.27);
  return (a + 0.5 * b) / 1.5;
}

/**
 * One cell of value noise.
 *
 * The hash is an integer mix rather than the usual fract(sin(...)) — the same
 * output to the eye, and it does not put a transcendental function inside a
 * loop that runs half a million times.
 */
function lattice(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return (hash2(xi, yi) * (1 - u) + hash2(xi + 1, yi) * u) * (1 - v)
    + (hash2(xi, yi + 1) * (1 - u) + hash2(xi + 1, yi + 1) * u) * v;
}

/**
 * The disc as an equirectangular picture: RGBA into `d`, `W` by `H`, right
 * ascension 0 to 360 across, declination +90 at the top row to −90 at the
 * bottom.
 */
export function paintBand(d, W, H) {
  for (let py = 0; py < H; py++) {
    const dec = 90 - (py + 0.5) * (180 / H);
    for (let px = 0; px < W; px++) {
      const ra = (px + 0.5) * (360 / W);
      const [l, b] = galactic(ra, dec);
      const v = discBrightness(l, b, ra, dec);
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
}

/** The catalogue, fetched once. */
export async function loadStars(url = 'data/sky/stars.json') {
  const res = await fetch(url, { cache: 'force-cache', signal: AbortSignal.timeout(30_000) });
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
/** Whether the reader has asked for less motion; read each time, it can change. */
const REDUCED_QUERY = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const REDUCED = () => Boolean(REDUCED_QUERY?.matches);

const TIERS = [
  { dpr: 2, haze: 9000, band: 8, glowTo: 5.0, spikeTo: 2.7 },
  { dpr: 1.6, haze: 6000, band: 10, glowTo: 4.4, spikeTo: 2.4 },
  { dpr: 1.3, haze: 3600, band: 13, glowTo: 3.6, spikeTo: 2.0 },
  { dpr: 1.0, haze: 2200, band: 18, glowTo: 2.6, spikeTo: 1.2 },
  // A machine without a GPU worth the name: fewer, coarser pixels, still smooth.
  { dpr: 0.75, haze: 1200, band: 24, glowTo: 2.0, spikeTo: 0.9 },
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
/**
 * How far in the sky can be zoomed: on SPHEREx's own sky, two degrees, where
 * a pixel of its finest tiles is still about one of the screen's; finer than
 * that is the field's own frames, which a press dives into. On the drawn sky,
 * no finer than the drawing.
 */
const FOV_MIN_SURVEY = 2;
const FOV_MAX = 108;
const FOV_DIVE = 1.0;
/**
 * The pixel density a dive is drawn at. Every star is a trail by then, and a
 * trail is a smear, so the full density buys nothing the eye can find; the
 * frame is filled by the GPU, and fewer pixels is what keeps it on time.
 */
const DIVE_DPR = 0.7;
/** How long the model takes to give way to the surveyed band, ms. */
const SURVEY_FADE_MS = 900;
/**
 * The Messier objects are marked only once the sky is narrower than this, in
 * degrees: at the opening's width a hundred unnamed rings stood over the
 * Milky Way, and the named fields and the planets were lost among them.
 */
const DEEP_FOV = 30;
/**
 * The sky grid: the HEALPix cells the all-sky cube is served in, order 3
 * (about 7.3° a side, the cells of its Allsky image) on a wide sky and order
 * 4 (3.7°) once it is narrower than this, in degrees.
 */
const GRID_FINE_FOV = 25;
/** Points along each cell's side, so a curved edge is drawn as a curve. */
const GRID_STEPS = 4;
const GRID_ALPHA = 0.08;

/**
 * The cell edges of one HEALPix order as polylines of unit vectors, made once:
 * on each of the twelve base faces, the lines of constant x and of constant y
 * at every cell boundary. `starts[i]` is where line i begins in `v`, counted
 * in points; the last entry is the total.
 */
function healpixLines(order) {
  const n = 2 ** order;
  const per = n * GRID_STEPS + 1;
  const lines = 12 * 2 * (n + 1);
  const v = new Float32Array(lines * per * 3);
  const starts = new Int32Array(lines + 1);
  let p = 0;
  let line = 0;
  for (let face = 0; face < 12; face++) {
    for (let k = 0; k <= n; k++) {
      for (const across of [false, true]) {
        starts[line++] = p;
        for (let s = 0; s < per; s++) {
          const along = s / (per - 1);
          const [x, y, z] = across ? vecOfXyf(along, k / n, face) : vecOfXyf(k / n, along, face);
          v[p * 3] = x;
          v[p * 3 + 1] = y;
          v[p * 3 + 2] = z;
          p++;
        }
      }
    }
  }
  starts[line] = p;
  return { v, starts };
}

export class Gate {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onPick: (o: object) => void, onName: (o: object|null) => void}} hooks
   */
  constructor(canvas, { onPick, onName, onSurvey = () => {}, onStepOut = null }) {
    this.canvas = canvas;
    // The band on the GPU, under this canvas, where WebGL 2 can be had; then
    // this canvas is clear between the stars so the band shows through it.
    // Best of all, SPHEREx's own sky: the whole-sky renderer, under this
    // canvas, from this camera. It shows the stars as SPHEREx saw them, so
    // the catalogue is then only for naming and pointing, not drawn.
    this.skySurvey = createSurveySky(canvas, {
      onFirstSky: () => {
        this.surveyCube = true;
        this.cubeAt = performance.now();
        this.canvas.closest('.gate')?.classList.add('gate--cube');
        // The rings wait for this; a sky standing still would not draw them.
        this.requestDraw();
        this.onSurvey();
      },
    });
    // Under it, the Milky Way as one picture (430 KB, drawn by the GPU): there
    // from the first second, while SPHEREx's own sky is still arriving, so the
    // page never opens on black.
    this.bandLayer = createBandLayer(canvas);
    // The picture waits, unseen, for the real Milky Way; the opening poster
    // stands until then, and nothing invented is shown in between.
    this.canvas.previousElementSibling?.classList.add('gate__band--wait');
    if (this.skySurvey && this.bandLayer) {
      // The picture under the survey's layer, and the survey's layer fading in over it.
      const band = this.canvas.previousElementSibling;
      const survey = band.previousElementSibling;
      survey.before(band);
      survey.classList.add('gate__band--survey');
    }
    this.fovMin = this.skySurvey ? FOV_MIN_SURVEY : FOV_MIN;
    this.ctx = canvas.getContext('2d', { alpha: Boolean(this.skySurvey || this.bandLayer) });
    this.onPick = onPick;
    this.onName = onName;
    this.onSurvey = onSurvey;
    /**
     * The way out into space, for the keys and for a pinch out past the
     * widest; the front page's "Explore in 3D" is the way most take. The
     * wheel only zooms.
     */
    this.onStepOut = onStepOut;
    this.bindKeys();

    /** The sky grid (HEALPix cells), off until asked for; its lines are made once per order. */
    this.grid = false;
    this.gridLines = new Map();

    this.outward = 0;
    /** The surveyed band, once it has arrived: `{ pixels, W, H }`. */
    this.survey = null;
    this.surveyAt = 0;

    this.stars = null;
    this.targets = [];

    /** Where the camera looks, and how wide. Starts on the galactic centre. */
    this.cam = { ra: 266, dec: -12, fov: FOV_WIDE };
    /** The sweep: a slow turn with a gentle nod across the plane. */
    this.glide = { rate: 0.8, nod: 13, period: 110, phase: 0, speed: 1 };

    this.pointer = null;
    this.hit = null;
    /** What the open card is about. The sky holds still and marks it. */
    this.selected = null;
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
      this.rgb[i] = starTint(stars.bv[i]).join(',');

      const m = stars.mag[i];
      this.size[i] = starRadius(m);
      this.alpha[i] = starAlpha(m);

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
    this.gap = 0;
    this.late = 0;
    return true;
  }

  /** @param {number} [cap] a lower ceiling on the pixel density, for a dive */
  measure(cap = Infinity) {
    const dpr = Math.min(this.quality.dpr, window.devicePixelRatio || 1, cap);
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.box = { width: w * dpr, height: h * dpr, dpr, cssW: w, cssH: h };
    this.canvas.width = this.box.width;
    this.canvas.height = this.box.height;
    // Setting the size clears the canvas: whatever was on it has to be drawn again.
    this.dirty = true;
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

  /** How bright the disc is in that direction, 0 to 1 (see discBrightness). */
  discBrightness(l, b, ra, dec) { return discBrightness(l, b, ra, dec); }

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
    paintBand(d, W, H);
    g.putImageData(img, 0, 0);
    this.band = c;
    this.bandW = W;
    this.bandH = H;
    // Kept so the faint field can be sampled from the model already evaluated
    // rather than evaluating it again a million times.
    this.bandPixels = d;
    this.bandLayer?.setModel(c);
  }

  /**
   * The Milky Way as SPHEREx surveyed it, in the same layout as the model's
   * band. Fetched once, after the model is up, so nothing on the page waits
   * for it; if it cannot be had, the model stays and says so.
   */
  async loadSurvey(url = 'data/sky/milkyway.png') {
    this.surveyAsked = true;
    try {
      const res = await fetch(url, { cache: 'force-cache', signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return;
      const bitmap = await createImageBitmap(await res.blob());
      if (this.bandLayer) {
        // On the GPU the picture is all that is needed; its pixels never come back.
        this.bandLayer.setSurvey(bitmap);
        this.survey = { W: bitmap.width, H: bitmap.height };
      } else {
        const c = document.createElement('canvas');
        c.width = bitmap.width;
        c.height = bitmap.height;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bitmap, 0, 0);
        this.survey = { pixels: g.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
      }
      this.surveyAt = performance.now();
      this.onSurvey();
      this.canvas.parentElement?.querySelector('.gate__band--wait')?.classList.remove('gate__band--wait');
      const step = () => {
        this.draw();
        if (this.surveyShare() < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    } catch { /* the model stays, and the colophon says it is the model */ }
  }

  /** How far the surveyed band has come in over the model, 0 to 1. */
  surveyShare() {
    if (!this.survey) return 0;
    if (REDUCED()) return 1;
    return Math.min(1, (performance.now() - this.surveyAt) / SURVEY_FADE_MS);
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
  drawBand(target, source = { pixels: this.bandPixels, W: this.bandW, H: this.bandH }, alpha = 1) {
    if (!this.band || alpha <= 0) return;
    /** Screen pixels per sample. The band has no detail this fine — and in a
     * dive it is smeared by the motion anyway, so it is sampled coarser. The
     * survey is sampled as the model was: finer cost every frame of a drag
     * two and a half times the work, and the page stuttered. */
    const SS = this.quality.band * (this.flight ? 1.6 : 1);
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
    const src = source.pixels;
    const bw = source.W;
    const bh = source.H;
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
    // The disc is a smooth gradient; the cheap filter is the same picture, and
    // in a dive it is one less full-frame pass for the GPU.
    target.imageSmoothingQuality = this.flight ? 'low' : 'high';
    target.globalCompositeOperation = 'lighter';
    target.globalAlpha = alpha;
    target.drawImage(this.low, 0, 0, width, height);
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'source-over';
  }

  draw() {
    // Before the first resize there is nothing measured to draw into; a tap
    // that early still records its choice, and the first resize draws it.
    if (!this.box) return;
    const { ctx } = this;
    const { width, height, dpr } = this.box;
    const f = this.flight;
    this.markDrawn();
    this.buildBasis(f ? f.fov : this.cam.fov);
    const focal = this.focal;
    // Where things were a fifth of a second ago, for the trails.
    const focalPrev = f ? (height / 2) / Math.tan((f.fovPrev / 2) * D2R) : focal;
    const streak = !!f && Math.abs(focalPrev - focal) > 0.5;
    // A trail longer than this is clipped at its far end. Near the end of the
    // dive the fifth-of-a-second displacement runs past the edge of the frame,
    // and rasterising thousands of window-length lines was what made the dive
    // stutter: the script took 15 ms a frame and the paint behind it 60.
    this.trailMax = 0.22 * Math.max(width, height);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.skySurvey) {
      ctx.clearRect(0, 0, width, height);
      this.skySurvey.draw({ ra: this.cam.ra, dec: this.cam.dec, fov: f ? f.fov : this.cam.fov, width: this.box.cssW, height: this.box.cssH });
      // Until the cube is up, the picture underneath stands in for it.
      if (!this.surveyCube && this.bandLayer) {
        this.bandLayer.draw({ basis: this.basis, focal, width, height, well: this.paint.wellRgb, mix: this.surveyShare() });
      }
      // The rings wait for the real sky, then come in over it.
      if (!f && this.surveyCube) {
        if (this.grid) this.drawGrid(ctx);
        this.drawTargets(ctx);
        this.drawSelected(ctx);
        this.drawHit(ctx);
      }
      this.drawArrival(ctx);
      return;
    }
    // The model, giving way to the survey once it is here.
    const surveyed = this.surveyShare();
    if (this.bandLayer) {
      ctx.clearRect(0, 0, width, height);
      this.bandLayer.draw({ basis: this.basis, focal, width, height, well: this.paint.wellRgb, mix: surveyed });
    } else {
      ctx.fillStyle = this.paint.well;
      ctx.fillRect(0, 0, width, height);
      if (surveyed < 1) this.drawBand(ctx, undefined, 1 - surveyed);
      if (surveyed > 0) this.drawBand(ctx, this.survey, surveyed);
    }
    if (!this.stars) return;

    // The faint field: the ground the catalogue sits on. It is drawn from the
    // model, so it goes when the survey comes, which shows the real one.
    if (this.haze && surveyed < 1) {
      const { v } = this.haze;
      ctx.fillStyle = '#cfe0f2';
      ctx.strokeStyle = '#cfe0f2';
      ctx.lineWidth = dpr;
      // Butt ends in a dive: a round cap on every trail doubles the work and
      // is invisible at that speed.
      ctx.lineCap = streak ? 'butt' : 'round';
      for (const b of this.haze.buckets) {
        const { idx } = b;
        ctx.globalAlpha = b.alpha * (1 - surveyed);
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
          if (streak) {
            // A third of the faint field is plenty of trails: in motion it
            // reads as texture, and each one costs a line to rasterise.
            if (k % 3 || !this.at(vx, vy, vz, focalPrev)) continue;
            this.trail(ctx, x, y);
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
        const r = glowRadius(mag[i]) * dpr * zoom;
        // The catalogue comes sorted by magnitude, so this only ever steps
        // down: about twenty changes for five thousand stars.
        const a = Math.round(glowAlpha(mag[i]) * 40) / 40;
        if (a !== lastAlpha) { ctx.globalAlpha = a; lastAlpha = a; }
        ctx.drawImage(this.glows[this.glowBin(bv[i])], x - r, y - r, r * 2, r * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    ctx.lineCap = streak ? 'butt' : 'round';
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
          this.trail(ctx, x, y);
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
      if (this.grid) this.drawGrid(ctx);
      this.drawTargets(ctx);
      this.drawSelected(ctx);
      this.drawHit(ctx);
    }
    this.drawArrival(ctx);
  }

  /** What this frame was drawn from, so the loop can tell when nothing has changed since. */
  markDrawn() {
    this.dirty = false;
    this.drawnRa = this.cam.ra;
    this.drawnDec = this.cam.dec;
    this.drawnFov = this.cam.fov;
    this.drawnAt = performance.now();
  }

  /** Whether the camera has moved since the last frame was drawn. */
  moved() {
    return this.cam.ra !== this.drawnRa || this.cam.dec !== this.drawnDec || this.cam.fov !== this.drawnFov;
  }

  /**
   * A frame for something the reader did: a drag, a wheel, a pinch. Drawn by
   * the loop, once, however many events came in that frame — drawing on each
   * event as well as in the loop painted the sky twice a frame. With no loop
   * running (less motion asked for, or stopped) it is drawn at once.
   */
  requestDraw() {
    if (this.running && this.raf && !REDUCED()) this.dirty = true;
    else this.draw();
  }

  /**
   * Whether the reticle needs a frame of its own. It settles over its first
   * second and then only breathes, a slow swell over three and a half seconds
   * that twenty frames a second carry as smoothly as sixty; off the screen it
   * needs none. Letting go fades it out at full rate.
   */
  reticleWants(now) {
    if (this.leaving) return true;
    const s = this.selected;
    if (!s || !this.box) return false;
    s.v ??= direction(s.ra, s.dec);
    if (!this.at(s.v[0], s.v[1], s.v[2])) return false;
    const m = 60 * this.box.dpr;
    if (this.px < -m || this.px > this.box.width + m || this.py < -m || this.py > this.box.height + m) return false;
    return (now - s.since) < 1200 || now - (this.drawnAt ?? 0) >= 50;
  }

  /**
   * One trail, from where the point was (`px`, `py`, just projected) to where
   * it is now, no longer than `trailMax`: the far end is pulled in along the
   * same line, so the direction stays the real one.
   */
  trail(ctx, x, y) {
    let x0 = this.px;
    let y0 = this.py;
    const dx = x - x0;
    const dy = y - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > this.trailMax) {
      const k = this.trailMax / len;
      x0 = x - dx * k;
      y0 = y - dy * k;
    }
    ctx.moveTo(x0, y0);
    ctx.lineTo(x, y);
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
    // A font is parsed each time it is set; the string, at least, is made once.
    if (this.fontFor !== dpr) {
      this.fontFor = dpr;
      this.font = `${12 * dpr}px ${this.paint.body}`;
      this.noteFont = `${10.5 * dpr}px ${this.paint.body}`;
    }
    ctx.font = this.font;
    ctx.textBaseline = 'middle';
    const deepShown = this.deepShown();
    // The names put down so far, as boxes: a name that would land on one is
    // left to its marker (the pointer names it), unless it is the one picked
    // or under the pointer. The north ecliptic pole and R Dra are 1.5° apart.
    const boxes = (this.labelBoxes ??= []);
    boxes.length = 0;
    const free = (x0, y0, w, h) => boxes.every(([bx, by, bw, bh]) => x0 >= bx + bw || bx >= x0 + w || y0 >= by + bh || by >= y0 + h);

    for (const tgt of this.targets) {
      if (tgt.kind === 'deep' && !deepShown && !this.isSelected(tgt)) continue;
      if (!this.at(tgt.v[0], tgt.v[1], tgt.v[2])) continue;
      const x = this.px;
      const y = this.py;
      if (x < -60 || x > width + 60 || y < -30 || y > height + 30) continue;
      const near = this.hit?.item === tgt;
      const colour = tgt.kind === 'planet' ? counter : accent;
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.globalAlpha = near ? 1 : (tgt.kind === 'deep' ? 0.38 : 0.85);

      const r = (tgt.kind === 'deep' ? 4 : 7) * dpr;
      this.glyph(ctx, tgt, x, y, r);

      // Under a cursor the pin names the marker, in the same place; drawing
      // the name here too set one over the other. A touch has no pin beside
      // the marker, so there the name stays.
      const pinned = near && !this.coarse;
      if ((tgt.kind !== 'deep' || near) && !pinned) {
        ctx.globalAlpha = near ? 1 : 0.8;
        // A dark edge under the letters: a star behind a name struck it through.
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = this.paint.labelEdge;
        // Past the reticle's ticks when this is the one picked, so the name and
        // the crosshair do not cross.
        const lx = x + (this.isSelected(tgt) ? 40 : r / dpr + 7) * dpr;
        if (tgt.labelFont !== this.font) {
          tgt.labelFont = this.font;
          tgt.labelW = ctx.measureText(tgt.label).width;
        }
        const lh = 16 * dpr;
        const first = near || this.isSelected(tgt);
        if (!first && !free(lx, y - lh / 2, tgt.labelW, lh)) continue;
        boxes.push([lx, y - lh / 2, tgt.labelW, lh]);
        ctx.strokeText(tgt.label, lx, y);
        ctx.fillStyle = near ? ink : colour;
        ctx.fillText(tgt.label, lx, y);
        // A deep field the cube leaves blank says so under its name, once the
        // cube is the sky: the hatched disc round it is not sky.
        if (tgt.note && this.surveyCube) {
          ctx.font = this.noteFont;
          if (tgt.noteFont !== this.noteFont) {
            tgt.noteFont = this.noteFont;
            tgt.noteW = ctx.measureText(tgt.note).width;
          }
          const ny = y + 14 * dpr;
          if (!first && !free(lx, ny - 7 * dpr, tgt.noteW, 14 * dpr)) {
            ctx.font = this.font;
            continue;
          }
          boxes.push([lx, ny - 7 * dpr, tgt.noteW, 14 * dpr]);
          ctx.globalAlpha = near ? 1 : 0.7;
          ctx.strokeText(tgt.note, lx, y + 14 * dpr);
          ctx.fillStyle = ink;
          ctx.fillText(tgt.note, lx, y + 14 * dpr);
          ctx.font = this.font;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Whether the sky is narrow enough for the Messier objects to be marked (and pressed). */
  deepShown() {
    return (this.flight ? this.flight.fov : this.cam.fov) < DEEP_FOV;
  }

  /** The grid's order at the present width of the sky. */
  gridOrder() {
    return this.cam.fov > GRID_FINE_FOV ? 3 : 4;
  }

  /** Show the sky grid, or take it away. */
  setGrid(on) {
    this.grid = Boolean(on);
    this.requestDraw();
  }

  /**
   * The HEALPix cells, barely there: one path, stroked once, so where two
   * faces share an edge it is not drawn darker. A point behind the camera
   * breaks its line; nothing is allocated once an order's lines are made.
   */
  drawGrid(ctx) {
    const order = this.gridOrder();
    if (!this.gridLines.has(order)) this.gridLines.set(order, healpixLines(order));
    const { v, starts } = this.gridLines.get(order);
    ctx.strokeStyle = this.paint.ink;
    ctx.globalAlpha = GRID_ALPHA;
    ctx.lineWidth = this.box.dpr;
    ctx.beginPath();
    for (let line = 0; line + 1 < starts.length; line++) {
      let pen = false;
      for (let p = starts[line]; p < starts[line + 1]; p++) {
        if (!this.at(v[p * 3], v[p * 3 + 1], v[p * 3 + 2])) { pen = false; continue; }
        if (pen) ctx.lineTo(this.px, this.py);
        else ctx.moveTo(this.px, this.py);
        pen = true;
      }
    }
    ctx.stroke();
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

  /**
   * Turn the camera onto a position, the short way round, without diving.
   * A target picked from the buttons below the sky was marked off-screen;
   * now the sky swings to it first.
   */
  lookAt({ ra, dec }, ms = 1100) {
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return Promise.resolve();
    cancelAnimationFrame(this.turnRaf);
    const from = { ra: this.cam.ra, dec: this.cam.dec };
    const dRA = ((ra - from.ra + 540) % 360) - 180;
    const dDec = Math.max(-80, Math.min(80, dec)) - from.dec;
    if (REDUCED()) {
      this.cam.ra = ((from.ra + dRA) % 360 + 360) % 360;
      this.cam.dec = from.dec + dDec;
      this.draw();
      return Promise.resolve();
    }
    const t0 = performance.now();
    let done;
    const arrived = new Promise((r) => { done = r; });
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      this.cam.ra = ((from.ra + dRA * e) % 360 + 360) % 360;
      this.cam.dec = from.dec + dDec * e;
      if (!this.running) this.draw();
      if (k < 1) this.turnRaf = requestAnimationFrame(step);
      else done();
    };
    this.turnRaf = requestAnimationFrame(step);
    return arrived;
  }

  /** Mark what the card is about, or let it go with `null`. */
  select(hit) {
    const now = performance.now();
    // Letting go fades the reticle out where it stands rather than dropping it.
    if (!hit && this.selected) this.leaving = { ...this.selected, out: now };
    this.selected = hit ? { ra: hit.ra, dec: hit.dec, since: now } : null;
    if (hit) this.leaving = null;
    this.draw();
  }

  /** Whether a target is the one the card is about: its name steps aside. */
  isSelected(tgt) {
    const s = this.selected;
    return Boolean(s) && Math.abs(s.ra - tgt.ra) < 1e-6 && Math.abs(s.dec - tgt.dec) < 1e-6;
  }

  /**
   * The selected object: a finder's reticle that settles onto it. The ring
   * closes and fades in together, easing out so it arrives rather than
   * stops; the four ticks follow a beat later; then it only breathes, gently.
   * A released reticle fades out in place.
   */
  drawSelected(ctx) {
    const now = performance.now();
    const still = !this.running || REDUCED();
    let s = this.selected;
    let fade = 1;
    if (!s && this.leaving) {
      const out = still ? 1 : (now - this.leaving.out) / 280;
      if (out >= 1) { this.leaving = null; return; }
      s = this.leaving;
      fade = 1 - out * out;
    }
    if (!s) return;
    s.v ??= direction(s.ra, s.dec);
    const p = this.projectV(s.v);
    if (!p) return;
    const { dpr } = this.box;
    const age = still ? 10 : (now - s.since) / 1000;
    const easeOut = (k, pow) => 1 - (1 - Math.min(1, Math.max(0, k))) ** pow;
    const close = easeOut(age / 0.7, 3);
    const shown = easeOut(age / 0.35, 2) * fade;
    const ticks = easeOut((age - 0.2) / 0.5, 3) * fade;
    // The breath starts once it has settled, and stays small.
    const breath = close * (0.5 + 0.5 * Math.sin(age * (2 * Math.PI / 3.6)));
    const r = (30 - 10 * close) * dpr;

    // A small glow on the object itself, not a wash over the sky around it.
    const glow = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * 0.7);
    glow.addColorStop(0, `${this.paint.accentRgba}${(0.22 + 0.08 * breath) * shown})`);
    glow.addColorStop(1, `${this.paint.accentRgba}0)`);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = glow;
    ctx.fillRect(p[0] - r, p[1] - r, r * 2, r * 2);
    ctx.globalCompositeOperation = 'source-over';

    const a = r + 4 * dpr;
    const b = r + 4 * dpr + 8 * dpr * ticks;
    const ring = () => { ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.stroke(); };
    const finder = () => {
      if (ticks <= 0.01) return;
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(p[0] + dx * a, p[1] + dy * a);
        ctx.lineTo(p[0] + dx * b, p[1] + dy * b);
      }
      ctx.stroke();
    };
    ctx.lineCap = 'round';
    // A thin dark edge first, so it reads over the bright band of the Milky
    // Way as well as over black sky.
    ctx.strokeStyle = this.paint.well;
    ctx.lineWidth = 3 * dpr;
    ctx.globalAlpha = 0.35 * shown;
    ring();
    ctx.globalAlpha = 0.35 * ticks;
    finder();
    ctx.strokeStyle = this.paint.ink;
    ctx.lineWidth = 1.5 * dpr;
    ctx.globalAlpha = shown * (0.88 + 0.12 * breath);
    ring();
    ctx.globalAlpha = ticks * (0.88 + 0.12 * breath);
    finder();
    ctx.globalAlpha = 1;
  }

  /** A CSS colour with its alpha replaced; the palette is hex or rgb(). */
  tint(color, alpha) { return `${this.tintPrefix(color)}${alpha})`; }

  /** The same colour up to its alpha, `rgba(r,g,b,`: read from the palette once, not every frame. */
  tintPrefix(color) {
    const hex = /^#([0-9a-f]{6})$/i.exec(color);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},`;
    }
    const rgb = /rgba?\(([^)]+)\)/.exec(color);
    if (rgb) {
      const [r, g, b] = rgb[1].split(/[\s,/]+/).map(Number);
      return `rgba(${r},${g},${b},`;
    }
    return 'rgba(108,196,240,';
  }

  /** A ring around whatever the pointer is nearest to. */
  drawHit(ctx) {
    if (!this.hit) return;
    const s = this.selected;
    if (s && Math.abs(s.ra - this.hit.ra) < 1e-6 && Math.abs(s.dec - this.hit.dec) < 1e-6) return;
    this.hit.v ??= direction(this.hit.ra, this.hit.dec);
    const p = this.projectV(this.hit.v);
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
    // The night as numbers, for the band's shader: whatever colour syntax the
    // token is written in, a canvas reads it back as RGB.
    const probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = this.paint.well;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    this.paint.wellRgb = [r / 255, g / 255, b / 255];
    // The colours a frame would otherwise rebuild from the palette every time:
    // the dark edge under a name, and the accent ready to take an opacity.
    this.paint.labelEdge = this.tint(this.paint.well, 0.7);
    this.paint.accentRgba = this.tintPrefix(this.paint.accent);
    this.fontFor = null;
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
      this.setCursor('grabbing');
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
          const want = (this.pinch.fov * this.pinch.span) / span;
          // Pinched past either end: out into space, or in to the detail.
          if (want > FOV_MAX * 1.25 && this.onStepOut) {
            this.pinch = null;
            this.onStepOut({ ra: this.cam.ra, dec: this.cam.dec, fov: FOV_MAX });
            return;
          }
          this.cam.fov = Math.max(this.fovMin, Math.min(FOV_MAX, want));
          this.findHit();
          this.requestDraw();
        }
        return;
      }

      if (this.drag && this.box) {
        // Degrees per pixel at the current field of view, so the sky moves by
        // exactly as much as the pointer moved across it.
        const perPx = this.cam.fov / this.box.height;
        const dx = p[0] - this.drag.at[0];
        const dy = p[1] - this.drag.at[1];
        this.drag.moved = Math.max(this.drag.moved, Math.hypot(dx, dy));
        this.cam.ra = ((this.drag.ra + dx * perPx) % 360 + 360) % 360;
        this.cam.dec = Math.max(-88, Math.min(88, this.drag.dec + dy * perPx));
        if (this.hit) { this.hit = null; this.onName?.(null); }
        this.requestDraw();
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
      this.setCursor('grab');
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
      // The wheel zooms, and only zooms: flying is the keys' (see bindKeys).
      this.cam.fov = Math.max(this.fovMin, Math.min(FOV_MAX, this.cam.fov * Math.exp(e.deltaY * 0.0012)));
      this.findHit();
      this.requestDraw();
    }, { passive: false });
  }

  /**
   * W, A, S, D or the arrows: leave the sky and fly, from the Earth, the way
   * it faces; the key held goes on flying in space. On a phone, with no keys,
   * a pinch out past the widest field does the same.
   */
  bindKeys() {
    addEventListener('keydown', (e) => {
      if (!this.onStepOut || this.flight || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown'].includes(e.code)) return;
      if (this.canvas.closest('[hidden]') || !this.canvas.offsetParent) return;
      e.preventDefault();
      this.onStepOut({ ra: this.cam.ra, dec: this.cam.dec, fov: this.cam.fov, key: e.code });
    });
  }

  press() {
    if (this.hit) { this.onPick?.(this.hit); return; }
    if (!this.pointer || !this.box) return;
    const [ra, dec] = this.unproject(this.pointer[0], this.pointer[1]);
    // With the grid on, a press on empty sky is a press on its cell: the
    // cell's centre is what opens, and the card names the cell.
    if (this.grid) {
      const order = this.gridOrder();
      const { npix } = tileAt(order, ra, dec);
      const c = radecOf(tileCentre(order, npix));
      this.onPick?.({ kind: 'sky', ra: c.ra, dec: c.dec, label: null, cell: { order, npix } });
      return;
    }
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
    const deepShown = this.deepShown();

    for (const tgt of this.targets) {
      // A ring not drawn is not there to be pressed.
      if (tgt.kind === 'deep' && !deepShown) continue;
      if (!this.at(tgt.v[0], tgt.v[1], tgt.v[2])) continue;
      const d = Math.hypot(this.px - px, this.py - py);
      if (d < bestD) { bestD = d; best = { ...tgt, item: tgt }; }
    }
    if (!best) {
      const { sv } = this;
      for (const [i, entry] of this.named) {
        if (!this.at(sv[i * 3], sv[i * 3 + 1], sv[i * 3 + 2])) continue;
        const d = Math.hypot(this.px - px, this.py - py);
        if (d < bestD) {
          bestD = d;
          best = {
            kind: 'star',
            ra: this.stars.ra[i],
            dec: this.stars.dec[i],
            label: entry.name || entry.bayer,
            sub: entry.name ? entry.bayer : '',
            mag: this.stars.mag[i],
            bv: this.stars.bv[i],
          };
        }
      }
    }

    const changed = best?.label !== this.hit?.label;
    this.hit = best;
    if (changed) { this.onName?.(best); this.draw(); }
    if (!this.drag) this.setCursor(best ? 'pointer' : 'grab');
  }

  /** The pointer's shape, written only when it changes: a style write each move dirtied the page's style for nothing. */
  setCursor(shape) {
    if (this.cursor === shape) return;
    this.cursor = shape;
    this.canvas.style.cursor = shape;
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

    const fov0 = out ? FOV_WIDE : Math.max(FOV_DIVE, this.cam.fov);
    this.measure(DIVE_DPR);
    return new Promise((resolve) => {
      this.flightDone = resolve;
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
          // From the field the sky was left at: zoomed in already, the dive goes on from there.
          fov: fov0 * (FOV_DIVE / fov0) ** k,
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
        this.measure();
        this.draw();
        this.flightDone = null;
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
      const g = this.glide;
      // A sky that is not moving and has nothing breathing on it only needs
      // redrawing now and then; a moving one gets every display frame, since
      // thirty a second is where a slow pan starts to judder.
      const still = g.speed < 0.002 && !this.selected && !this.leaving && !this.drag;
      if (still && now - last < 100) {
        // Nothing moves by itself; what the reader asked for is still drawn now.
        if (this.dirty) this.draw();
        this.raf = requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // The sweep: a slow turn with a gentle nod, the way an instrument in
      // orbit crosses the sky. It holds still while you are reading it or
      // looking at something you picked, and eases in and out of the stop
      // rather than snapping.
      const hold = this.pointer || this.drag || this.selected;
      g.speed += ((hold ? 0 : 1) - g.speed) * (1 - Math.exp(-dt / (hold ? 0.6 : 1.2)));
      if (!this.drag && g.speed > 0.0005) {
        const w = (2 * Math.PI) / g.period;
        const step = dt * g.speed;
        // The nod is added as a change, not set as a position, so the sky
        // goes on from wherever a drag left it instead of jumping back.
        this.cam.ra = (this.cam.ra + g.rate * step) % 360;
        this.cam.dec = Math.max(-80, Math.min(80,
          this.cam.dec + g.nod * w * Math.cos(w * g.phase) * step));
        g.phase += step;
      }

      // What the screen actually got: the time between frames, which counts
      // the painting the GPU (or a CPU standing in for one) does after the
      // script has returned. Timing the script alone missed exactly the
      // machines that needed a lighter sky: 20 ms of script, 110 ms of paint.
      const moving = g.speed > 0.05 && !this.drag;
      const gap = now - (this.lastFrame ?? now);
      this.lastFrame = now;
      if (moving && gap > 0 && gap < 250) {
        this.gap = this.gap ? this.gap * 0.9 + gap * 0.1 : gap;
        // Against the best this screen has managed, not against 60 Hz: a
        // display or a battery saver capped at 30 frames is not a slow GPU,
        // and stepping down there only blurs the sky.
        this.bestGap = Math.min(this.bestGap ?? Infinity, this.gap);
        // Below 25 frames a second is slow on any screen.
        if (this.gap > 40 || this.gap > Math.max(25, this.bestGap * 1.6)) {
          // Far behind steps down sooner: three seconds of judder is enough.
          this.late += this.gap > 50 ? 3 : 1;
          if (this.late > 90) this.stepDown();
        } else if (this.late) {
          this.late--;
        }
      }

      // A sky that has not moved, with no reticle settling or breathing on it,
      // is the frame already on screen: nothing is drawn, and nothing timed.
      if (!this.dirty && !this.moved() && !this.reticleWants(now)) {
        this.raf = requestAnimationFrame(tick);
        return;
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
    // A flight cut short still ends: whoever awaits it is holding visits back.
    if (this.flightDone) {
      this.flight = null;
      this.flightDone();
      this.flightDone = null;
    }
  }

  resize() {
    this.readTheme();
    this.measure();
    if (!this.band) this.buildBand();
    if (!this.haze) this.buildHaze(this.quality.haze);
    if (!this.glows) this.buildGlows();
    this.draw();
    if (!this.surveyAsked) this.loadSurvey();
  }
}

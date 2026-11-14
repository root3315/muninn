/**
 * sky.js — the instrument face.
 *
 * Holds the reprojected visits, paints whichever comparison the user asked for,
 * and draws the annotation that makes the picture readable: a coordinate grid, a
 * scale bar, the objects a catalogue already knows about, and the marks the user
 * has dropped.
 *
 * The reprojected grid is rectangular and roughly the shape of the viewport, so
 * the sky can fill the screen instead of sitting in a box. Because a window can
 * be resized after a field is loaded, everything is composited with cover
 * semantics — one scale, centred — so the sky is never stretched and never
 * leaves a blank margin.
 *
 * Every visit is kept as its own small canvas at grid resolution. Changing the
 * stretch repaints those; changing the mode only re-composites them, which is why
 * blinking stays smooth while the sliders are being dragged.
 */

import { DETECTOR_ARCSEC, magAB } from './depth.js';
import { limitsFromSorted, limitsFromTable, quantileTable, quantileAt, sortedFinite, paint, paintDifference, rampFromToken, resolveColor } from './render.js';
import { SECTOR_COLS, SECTOR_ROWS, sectorBounds } from './sectors.js';
import { deltaRA } from './wcs.js';
import { coadd } from './stack.js';
import { epochOfMjd, propagate, markRadius } from './overlay.js';
import { QUALITY } from './stamp.js';
import { sharpness, sharpVerdict } from './sharpness.js';

const RAMP_TOKENS = { deep: '--cmap-deep', ice: '--cmap-ice', infrared: '--cmap-infrared' };

/**
 * What a visit's quality plane says about the samples within `reach` of
 * (ci, cj): how many sit on a saturated detector pixel and where they are
 * centred, and what share of them hold no value at all.
 */
export function coreQuality(quality, width, height, ci, cj, reach) {
  let overflow = 0;
  let holes = 0;
  let ghost = 0;
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let j = Math.max(0, cj - reach); j <= Math.min(height - 1, cj + reach); j++) {
    for (let i = Math.max(0, ci - reach); i <= Math.min(width - 1, ci + reach); i++) {
      const q = quality[j * width + i];
      n += 1;
      if (q & QUALITY.HOLE) holes += 1;
      if (q & QUALITY.GHOST) ghost += 1;
      if (q & QUALITY.OVERFLOW) { overflow += 1; sx += i; sy += j; }
    }
  }
  return { overflow, ghost, holeShare: n ? holes / n : 0, centre: overflow ? [sx / overflow, sy / overflow] : null };
}

/**
 * Most of a mark's detections on saturated pixels: the measurement has
 * nothing to say about its brightness or how it moves.
 */
export const mostlySaturated = (track) => track.length > 0
  && 2 * track.filter((p) => p.saturated).length > track.length;

/** The two survey marks, added to the path being built. */
function ring(ctx, x, y, r) {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}
function diamond(ctx, x, y, r) {
  const h = r + 1.5;
  ctx.moveTo(x, y - h);
  ctx.lineTo(x + h, y);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x - h, y);
  ctx.closePath();
}

/** Angular steps a grid line is allowed to land on, in degrees. */
const GRID_STEPS = [1 / 240, 1 / 120, 1 / 60, 1 / 30, 1 / 12, 1 / 6, 0.5, 1];
const BAR_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 1800];

export class SkyView {
  constructor(canvas, { onHover, onPick, onItem, onReferenceMoved, onRepainted } = {}) {
    this.canvas = canvas;
    /* Called when a catalogue-drawn reference is drawn again for another date. */
    this.onReferenceMoved = onReferenceMoved;
    this.onRepainted = onRepainted;
    this.ctx = canvas.getContext('2d');
    this.onHover = onHover;
    this.onPick = onPick;
    /* Called with whatever drawn thing — a mark, a SkyBoT body, a catalogued
       object — is under the pointer, or null, so the page can say what it is. */
    this.onItem = onItem;
    /* Where each of those was drawn last frame, for finding it under the pointer. */
    this.hits = [];
    /* SIMBAD's notable objects in the field, drawn as small squares. */
    this.catalog = [];

    this.grid = null;
    this.visits = [];
    this.index = 0;
    this.a = 0;
    this.b = 1;
    this.mode = 'blink';
    this.wipe = 0.5;
    this.render = { stretch: 'asinh', clip: 99.5, palette: 'deep', shared: false };
    this.overlays = { grid: true, compass: true, catalog: true, skybot: true, marks: true, sectors: false, gaia: false, wise: false };
    /* Other missions' catalogues for this field, by survey: { rows, limit }. */
    this.surveys = {};
    /* How many of each landed on the plate in the last frame drawn. */
    this.surveyShown = {};
    /* Which sector the matrix is pointing at, if any. */
    this.sector = null;
    /* Label boxes already drawn this frame, which later labels avoid. */
    this.taken = [];
    /* Exposures read only for the stack, and the set it adds (see reset). */
    this.extra = new Map();
    this.stackUrls = null;
    /* SkyBoT's answer for each visit, keyed by the frame's obsId rather than its
       place in the list: visits are sorted by date as they arrive, and an answer
       filed under a position drifted onto the wrong visit when one landed early. */
    this.knownObjects = new Map();
    this.marks = [];
    /* One mark's parallax arc into another season, while it is being looked
       at: { points, ticks, match, tickLabel } in sky coordinates, or null. */
    this.link = null;
    /* The object the field was opened for, when it was opened by name:
       { ra, dec, epoch, pmRA, pmDE, label } — a catalogue position at its own
       epoch and a motion in mas a year, either of which may be missing. */
    this.target = null;
    /* Words the picture needs in the reader's language, set by the page. */
    this.labels = { rate: (r) => `${r.toFixed(r < 10 ? 1 : 0)}″/h` };
    this.hover = null;
    this.diffCache = null;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    /* Insets the legend keeps clear of. The shell gives the picture a cell of
       its own, so these stay at zero; they exist for a caller that does put
       something over the canvas. */
    this.chrome = { top: 0, right: 0, bottom: 0, left: 0 };

    this.ramps = {};
    this.fonts = {};
    this.colors = {};
    this.readTheme();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.bindPointer();
  }

  /* --------------------------------------------------------------- theming */

  /** Pull ramps, annotation colours and the label face out of the token layer. */
  readTheme() {
    const root = document.documentElement;
    for (const [name, token] of Object.entries(RAMP_TOKENS)) this.ramps[name] = rampFromToken(root, token);
    this.ramps.diff = rampFromToken(root, '--cmap-diff');
    const css = getComputedStyle(root);
    const pick = (t) => {
      const [r, g, b] = resolveColor(css.getPropertyValue(t).trim());
      return `rgb(${r} ${g} ${b})`;
    };
    const mono = css.getPropertyValue('--font-mono').trim();
    this.fonts = { mark: `500 12px ${mono}`, compass: `500 11px ${mono}` };
    this.colors = {
      accent: pick('--color-accent'),
      accentDim: pick('--color-accent-dim'),
      counter: pick('--color-counter'),
      ink: pick('--color-ink'),
      muted: pick('--color-muted'),
      neutral: pick('--color-neutral'),
      paper: pick('--color-paper'),
      well: pick('--color-well'),
    };
    this.repaintAll();
  }

  /* ---------------------------------------------------------------- layout */

  resize() {
    const box = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(240, Math.round(box.clientWidth));
    const h = Math.max(200, Math.round(box.clientHeight || box.clientWidth));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.draw();
  }

  /** The aspect a freshly opened field should be resampled at. */
  get viewAspect() {
    const box = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(240, box.clientWidth);
    const h = Math.max(200, box.clientHeight || w);
    return w / h;
  }

  /**
   * One transform for everything: the grid is drawn to cover the canvas at a
   * single scale, centred. Overlays use the same mapping, so a mark stays on its
   * star no matter how the window is shaped.
   */
  get view() {
    const gw = this.grid?.width ?? 1;
    const gh = this.grid?.height ?? 1;
    // Fit, never fill. A `max` here would scale until the shorter side covered
    // the canvas and push the rest of the resampled field off the edges — sky
    // that was fetched, reprojected and then thrown away. The grid is built at
    // the canvas's own aspect, so the two usually agree exactly; when a panel
    // opens and they briefly disagree, the leftover is the well, which is the
    // same colour as the bottom of every image ramp and therefore invisible.
    const scale = Math.min(this.cssW / gw, this.cssH / gh);
    return { scale, offX: (this.cssW - gw * scale) / 2, offY: (this.cssH - gh * scale) / 2, gw, gh };
  }

  /**
   * Grid index to canvas point, and back. An index names a sample's centre
   * (the grid's own convention, see wcs.js), and drawImage paints sample i
   * across [i, i + 1] of the scaled grid: its centre is at i + ½. Without the
   * half, every ring, square, label and mark sat half a sample up and to the
   * left of the pixel it was about.
   */
  toCanvas(i, j) {
    const { scale, offX, offY } = this.view;
    return [offX + (i + 0.5) * scale, offY + (j + 0.5) * scale];
  }

  toGrid(x, y) {
    const { scale, offX, offY } = this.view;
    return [(x - offX) / scale - 0.5, (y - offY) / scale - 0.5];
  }

  /* ----------------------------------------------------------------- state */

  reset(grid) {
    this.grid = grid;
    this.visits = [];
    this.knownObjects = new Map();
    this.marks = [];
    this.index = 0;
    this.a = 0;
    this.b = 1;
    this.diffCache = null;
    this.stackCache = null;
    // Exposures read only for the stack, by URL, and the set the stack adds.
    this.extra = new Map();
    this.stackUrls = null;
    // A lit sector belongs to the field it was lit in.
    this.sector = null;
    // Another mission's picture of this field, for the wipe; and whether the
    // wipe shows it as B.
    this.ref = null;
    this.useRef = false;
    this.link = null;
    this.draw();
  }

  /**
   * Another survey's image of the field on the same grid (an AllWISE cutout,
   * or the Gaia model), or null. Cut on its own pixels, never shared with
   * SPHEREx's: the units and the depth are another instrument's. A reference
   * with `follow(mjd)` is drawn from a catalogue and is drawn again for the
   * date of whichever visit is A (see followReference).
   */
  setReference(ref) {
    if (ref) {
      const cv = document.createElement('canvas');
      cv.width = ref.stamp.width;
      cv.height = ref.stamp.height;
      this.ref = { ...ref, canvas: cv, ctx: cv.getContext('2d'), cut: null };
      this.paintVisit(this.ref);
    } else {
      this.ref = null;
    }
    this.draw();
  }

  /** B of the wipe is the reference image, or the visit chosen as B. */
  setUseRef(on) { this.useRef = on; this.draw(); }

  /** A catalogue-drawn reference, moved to A's date when A is another visit. */
  followReference(a) {
    const ref = this.ref;
    if (!ref?.follow || !a || ref.mjd === a.frame.mjd) return;
    Object.assign(ref, ref.follow(a.frame.mjd));
    this.paintVisit(ref);
    this.onReferenceMoved?.();
  }

  /** An exposure read only to be stacked: not a visit, not in the run. */
  addExtra(frame, stamp) {
    this.extra.set(frame.url, { frame, stamp });
    this.stackCache = null;
    if (this.mode === 'stack') this.draw();
  }

  /** Which exposures the stack adds, by URL; the app decides, from the archive. */
  setStack(urls) {
    this.stackUrls = urls;
    if (this.mode === 'stack') this.draw();
  }

  /** The loaded exposures the stack adds right now, visits and extras alike. */
  stackMembers() {
    const ref = this.visits[this.index];
    if (!ref) return [];
    const want = new Set(this.stackUrls ?? [ref.frame.url]);
    want.add(ref.frame.url);
    const seen = new Set();
    const out = [];
    for (const item of [...this.visits, ...(this.extra?.values() ?? [])]) {
      const url = item.frame.url;
      if (!want.has(url) || seen.has(url)) continue;
      seen.add(url);
      out.push(item);
    }
    return out.sort((a, b) => a.frame.mjd - b.frame.mjd);
  }

  addVisit(frame, stamp) {
    const cv = document.createElement('canvas');
    cv.width = stamp.width;
    cv.height = stamp.height;
    // A visit resampled in a worker arrives with its default cut already made.
    const entry = { frame, stamp, canvas: cv, ctx: cv.getContext('2d'), limits: null, cut: stamp.cut ?? null };
    // Keep the frame on screen where it was: arrivals are out of date order, and
    // a sort that moves the shown visit under the viewer is a jump they did not ask for.
    const shown = this.visits[this.index];
    this.visits.push(entry);
    this.visits.sort((x, y) => x.frame.mjd - y.frame.mjd);
    if (shown) this.index = this.visits.indexOf(shown);
    // Only shared scaling ties one frame's cut to the others; otherwise the
    // newcomer is the only thing that needs paint.
    if (this.render.shared) this.repaintAll();
    else { this.paintVisit(entry); this.diffCache = null; this.draw(); }
    if (this.visits.length === 2) this.b = this.visits.length - 1;
    return entry;
  }

  /**
   * One visit's own black and white point, cut once per clip setting. Its
   * pixels are sorted once, into a table of percentiles, so a new clip is a
   * lookup rather than a sort.
   */
  ownLimits(v) {
    const key = this.render.clip;
    if (v.cut?.key !== key) {
      v.quantiles ??= v.stamp.quantiles ?? quantileTable(sortedFinite(v.stamp.data));
      v.cut = { key, lim: limitsFromTable(v.quantiles, { loPercent: 5, hiPercent: key }) };
    }
    return v.cut.lim;
  }

  paintVisit(v, shared = null) {
    const lut = this.ramps[this.render.palette] ?? this.ramps.deep;
    // A model drawn from a catalogue brings its own black and white point:
    // its sky is exactly zero, and a percentile cut would find nothing.
    const lim = shared ?? v.stamp.limits ?? this.ownLimits(v);
    v.limits = lim;
    const img = v.ctx.createImageData(v.stamp.width, v.stamp.height);
    paint(img, v.stamp.data, lut, { lo: lim.lo, hi: lim.hi, stretch: this.render.stretch, quality: v.stamp.quality });
    v.ctx.putImageData(img, 0, 0);
    // The run keeps a small copy of each picture; a repaint makes it stale.
    v.canvasVersion = (v.canvasVersion ?? 0) + 1;
  }

  setRender(patch) { Object.assign(this.render, patch); this.repaintAll(); }
  setOverlays(patch) { Object.assign(this.overlays, patch); this.draw(); }
  setMode(mode) { this.mode = mode; this.diffCache = null; this.draw(); }

  /** Modes that show one visit, or one visit's season, by index. */
  get indexed() { return this.mode === 'single' || this.mode === 'blink' || this.mode === 'stack'; }

  setIndex(i) {
    if (!this.visits.length) return;
    this.index = ((i % this.visits.length) + this.visits.length) % this.visits.length;
    this.draw();
  }

  setAB(a, b) {
    if (a != null) this.a = a;
    if (b != null) this.b = b;
    this.diffCache = null;
    this.draw();
  }

  setKnownObjects(obsId, objects) { this.knownObjects.set(obsId, objects); this.draw(); }
  setCatalog(list) { this.catalog = list ?? []; this.draw(); }
  setSurvey(kind, data) { this.surveys[kind] = data; this.draw(); }

  /* ------------------------------------------------------------- rendering */

  /** Shared scaling uses one low/high pair for every visit, so brightness is comparable. */
  sharedLimits() {
    const lows = [];
    const highs = [];
    for (const v of this.visits) {
      const l = this.ownLimits(v);
      lows.push(l.lo);
      highs.push(l.hi);
    }
    if (!lows.length) return { lo: 0, hi: 1 };
    lows.sort((a, b) => a - b);
    highs.sort((a, b) => a - b);
    return { lo: lows[Math.floor(lows.length / 2)], hi: highs[highs.length - 1] };
  }

  /**
   * A new cut, stretch or palette for every visit. The ones on screen are
   * painted as they are drawn; the rest one at a time behind, so a step of
   * the white-point slider costs one visit's paint and not sixty.
   */
  repaintAll() {
    clearTimeout(this.paintTimer);
    if (!this.visits.length) { this.draw(); return; }
    const job = { shared: this.render.shared ? this.sharedLimits() : null };
    this.paintJob = job;
    for (const v of this.visits) v.stale = true;
    if (this.ref) this.paintVisit(this.ref);
    this.diffCache = null;
    this.stackCache = null;
    this.draw();
    const behind = () => {
      if (this.paintJob !== job) return;
      const v = this.visits.find((x) => x.stale);
      if (!v) { this.draw(); this.onRepainted?.(); return; }
      this.fresh(v);
      this.paintTimer = setTimeout(behind, 0);
    };
    this.paintTimer = setTimeout(behind, 0);
  }

  /** A visit painted to the current cut, if the last repaint has not reached it yet. */
  fresh(v) {
    if (v?.stale) {
      v.stale = false;
      this.paintVisit(v, this.paintJob?.shared ?? null);
    }
    return v;
  }

  /**
   * The season of the visit on screen, added up (see stack.js) and cut and
   * tinted like any single visit. Rebuilt only when the members, the cut or
   * the palette change.
   */
  stackCanvas() {
    const ref = this.visits[this.index];
    if (!ref) return null;
    const members = this.stackMembers();
    const key = `${members.map((m) => m.frame.url).join('|')}|${this.render.clip}|${this.render.stretch}|${this.render.palette}`;
    if (this.stackCache?.key === key) return this.stackCache;
    const data = coadd(members.map((m) => m.stamp.data));
    const lim = limitsFromSorted(sortedFinite(data), { loPercent: 5, hiPercent: this.render.clip });
    const cv = document.createElement('canvas');
    cv.width = ref.stamp.width;
    cv.height = ref.stamp.height;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(cv.width, cv.height);
    const lut = this.ramps[this.render.palette] ?? this.ramps.deep;
    paint(img, data, lut, { lo: lim.lo, hi: lim.hi, stretch: this.render.stretch });
    ctx.putImageData(img, 0, 0);
    this.stackCache = { key, canvas: cv, data, members };
    return this.stackCache;
  }

  differenceCanvas() {
    const a = this.visits[this.a];
    const b = this.visits[this.b];
    if (!a || !b || a === b) return null;
    const key = `${a.frame.obsId}|${b.frame.obsId}|${this.render.clip}`;
    if (this.diffCache?.key === key) return this.diffCache;

    const cv = document.createElement('canvas');
    cv.width = a.stamp.width;
    cv.height = a.stamp.height;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(a.stamp.width, a.stamp.height);
    const { scale } = paintDifference(img, a.stamp.data, b.stamp.data, this.ramps.diff);
    ctx.putImageData(img, 0, 0);
    this.diffCache = { key, canvas: cv, scale };
    return this.diffCache;
  }

  get current() {
    if (this.indexed) return this.visits[this.index] ?? null;
    return this.visits[this.a] ?? null;
  }

  /** Draw one visit's canvas to cover the viewport. */
  place(ctx, source) {
    const { scale, offX, offY, gw, gh } = this.view;
    // The grid is resampled at roughly the detector's own sampling, so the last
    // magnification up to screen size happens here. Chrome's high-quality
    // resampler makes that a smooth blur rather than the tent-shaped plateaus a
    // plain bilinear leaves around a bright pixel.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, offX, offY, gw * scale, gh * scale);
  }

  draw() {
    const { ctx, canvas } = this;
    if (!canvas.width) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.colors.well;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(this.dpr, this.dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (this.visits.length && this.grid) {
      if (this.mode === 'difference') {
        const diff = this.differenceCanvas();
        if (diff) this.place(ctx, diff.canvas);
        else if (this.visits[this.a]) this.place(ctx, this.fresh(this.visits[this.a]).canvas);
      } else if (this.mode === 'stack') {
        const stack = this.stackCanvas();
        if (stack) this.place(ctx, stack.canvas);
      } else if (this.mode === 'wipe') {
        const a = this.visits[this.a];
        if (this.useRef) this.followReference(a);
        const b = (this.useRef && this.ref) || (this.visits[this.b] ?? a);
        if (a) this.place(ctx, this.fresh(a).canvas);
        const x = Math.round(this.cssW * this.wipe);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, 0, this.cssW - x, this.cssH);
        ctx.clip();
        if (b) this.place(ctx, this.fresh(b).canvas);
        ctx.restore();
        this.drawWipeHandle(ctx, x);
      } else {
        const v = this.current;
        if (v) this.place(ctx, this.fresh(v).canvas);
      }
    }

    this.hits = [];
    // Room already spoken for — SkyBoT's names and the compass — which a star's
    // label steps around instead of landing on ("BD+02′128" was the scale bar
    // drawn through a name).
    this.taken = [];
    if (this.grid) {
      if (this.overlays.grid) this.drawGrid(ctx);
      if (this.overlays.compass) this.taken.push(this.compassBox(ctx));
      // SkyBoT's rings are positions at one exposure's moment; on a season's
      // sum they would pin a body to a place it held for one of the visits.
      if (this.overlays.skybot && this.mode !== 'stack') this.drawKnownObjects(ctx);
      if (this.overlays.marks && this.target) this.drawTarget(ctx);
      if (this.overlays.catalog) this.drawCatalog(ctx);
      this.drawSurveys(ctx);
      if (this.overlays.sectors || this.sector) this.drawSectors(ctx);
      if (this.link) this.drawLink(ctx);
      if (this.overlays.marks) this.drawMarks(ctx);
      if (this.overlays.compass) this.drawCompass(ctx);
      if (this.hover) this.drawCrosshair(ctx);
    }
    ctx.restore();
  }

  /**
   * The districts the frame is cut into, numbered the way the matrix numbers
   * them. Drawn over the picture only when asked for, and a single sector is
   * lit whenever the matrix is pointing at one - that is the whole link between
   * "this cell does not look like itself" and "look here".
   */
  drawSectors(ctx) {
    const { scale, offX, offY, gw, gh } = this.view;
    const W = gw * scale;
    const H = gh * scale;
    ctx.save();
    ctx.font = this.fonts.compass;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    if (this.overlays.sectors) {
      ctx.strokeStyle = this.colors.accentDim;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < SECTOR_COLS; c++) {
        const x = Math.round(offX + (c / SECTOR_COLS) * W) + 0.5;
        ctx.moveTo(x, offY); ctx.lineTo(x, offY + H);
      }
      for (let r = 1; r < SECTOR_ROWS; r++) {
        const y = Math.round(offY + (r / SECTOR_ROWS) * H) + 0.5;
        ctx.moveTo(offX, y); ctx.lineTo(offX + W, y);
      }
      ctx.stroke();

      ctx.globalAlpha = 0.8;
      ctx.fillStyle = this.colors.accentDim;
      for (let n = 1; n <= SECTOR_COLS * SECTOR_ROWS; n++) {
        const b = sectorBounds(n);
        ctx.fillText(String(n), offX + b.x0 * W + 5, offY + b.y0 * H + 4);
      }
    }

    if (this.sector) {
      const b = sectorBounds(this.sector);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.colors.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(
        Math.round(offX + b.x0 * W) + 1, Math.round(offY + b.y0 * H) + 1,
        Math.round((b.x1 - b.x0) * W) - 2, Math.round((b.y1 - b.y0) * H) - 2,
      );
      ctx.fillStyle = this.colors.accent;
      ctx.fillText(String(this.sector), offX + b.x0 * W + 5, offY + b.y0 * H + 4);
    }
    ctx.restore();
  }

  drawWipeHandle(ctx, x) {
    const H = this.cssH;
    ctx.save();
    ctx.strokeStyle = this.colors.accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
    ctx.fillStyle = this.colors.accent;
    for (const cy of [H / 2 - 14, H / 2 + 14]) {
      ctx.beginPath();
      ctx.moveTo(x - 6, cy);
      ctx.lineTo(x + 6, cy);
      ctx.lineTo(x, cy + (cy < H / 2 ? -7 : 7));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** Lines of constant RA and Dec, stepped onto a round angular interval. */
  drawGrid(ctx) {
    const span = this.grid.spanDeg;
    const step = GRID_STEPS.find((sp) => span / sp <= 7) ?? GRID_STEPS[GRID_STEPS.length - 1];
    const raStep = step / Math.max(0.05, Math.cos(this.grid.dec * Math.PI / 180));

    ctx.save();
    ctx.strokeStyle = this.colors.neutral;
    // Faint enough to read as a ruling on the picture rather than a mesh over it.
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);

    const half = span * 0.8;
    const line = (points) => {
      let started = false;
      ctx.beginPath();
      for (const p of points) {
        const idx = this.grid.worldToIndex(p[0], p[1]);
        if (!idx) { started = false; continue; }
        const [x, y] = this.toCanvas(idx[0], idx[1]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    const d0 = Math.ceil((this.grid.dec - half) / step) * step;
    for (let d = d0; d <= this.grid.dec + half; d += step) {
      const pts = [];
      for (let k = 0; k <= 40; k++) pts.push([this.grid.ra - half + (2 * half * k) / 40, d]);
      line(pts);
    }
    const r0 = Math.ceil((this.grid.ra - half) / raStep) * raStep;
    for (let r = r0; r <= this.grid.ra + half; r += raStep) {
      const pts = [];
      for (let k = 0; k <= 40; k++) pts.push([r, this.grid.dec - half + (2 * half * k) / 40]);
      line(pts);
    }
    ctx.restore();
  }

  /**
   * Text on the picture, set off from it by a thin rim of the well colour, so
   * a bright star or a track running under it cannot eat into the letters.
   */
  label(ctx, text, x, y, color) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.colors.well;
    ctx.globalAlpha = 0.85;
    ctx.strokeText(text, x, y);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /**
   * SIMBAD's notable objects in the field: a small square each, quiet, so it
   * reads as a note on the sky and not as a source in it. Squares because the
   * ring already means "SkyBoT says a body is here" and the cross means "you
   * marked this". Only the best-known few carry a name, and a name that would
   * land on another is left off rather than stacked.
   */
  drawCatalog(ctx) {
    if (!this.catalog.length) return;
    const LABELLED = 12;
    const placed = [];
    // At the date of the visit on screen: SIMBAD gives J2000, and Barnard's
    // Star had moved four arcminutes from its square by 2025.
    const epoch = this.current ? epochOfMjd(this.current.frame.mjd) : null;
    const target = this.overlays.marks ? this.targetAt() : null;
    // A mark on the object already names it; a second label would say it twice.
    const marked = this.overlays.marks
      ? this.marks.map((m) => this.grid.worldToIndex(m.ra, m.dec)).filter(Boolean).map((g) => this.toCanvas(g[0], g[1]))
      : [];
    ctx.save();
    ctx.font = this.fonts.compass;
    ctx.textBaseline = 'middle';
    this.catalog.forEach((o, k) => {
      const at = epoch == null ? o : propagate(o, epoch, 2000);
      const g = this.grid.worldToIndex(at.ra, at.dec);
      if (!g) return;
      const [x, y] = this.toCanvas(g[0], g[1]);
      if (x < 4 || y < 4 || x > this.cssW - 4 || y > this.cssH - 4) return;
      ctx.strokeStyle = this.colors.muted;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x) - 4.5, Math.round(y) - 4.5, 9, 9);
      ctx.globalAlpha = 1;
      this.hits.push({ kind: 'catalog', x, y, item: o });
      if (k >= LABELLED || marked.some(([mx, my]) => Math.hypot(mx - x, my - y) < 14)) return;
      // The field's own target is already named in its own words.
      if (target && Math.hypot((deltaRA(at.ra, target.ra) * Math.cos((at.dec * Math.PI) / 180)), at.dec - target.dec) * 3600 < 10) return;

      const text = shortName(o.name);
      const w = ctx.measureText(text).width;
      const right = x + 9 + w <= this.cssW - 4;
      const box = { x0: right ? x + 8 : x - 9 - w, x1: right ? x + 9 + w : x - 8, y0: y - 7, y1: y + 7 };
      const hit = (b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1;
      if (placed.some(hit) || this.taken.some(hit)) return;
      placed.push(box);
      ctx.textAlign = right ? 'left' : 'right';
      this.label(ctx, text, right ? x + 9 : x - 9, y, this.colors.muted);
    });
    ctx.restore();
  }

  /**
   * Other missions' catalogues: Gaia DR3 as open circles, AllWISE as open
   * diamonds, each sized by brightness. Told apart by shape first, since the
   * accent the SkyBoT rings use turns with the band and can land on any hue;
   * and small and unlabelled, so they read as a layer under the rings, the
   * squares and the user's crosses rather than as more of them.
   *
   * A Gaia position is carried to the date of the visit on screen (see
   * overlay.js), so the circle stays on a fast star from visit to visit.
   * AllWISE has no proper motions worth using and is drawn where it stands.
   */
  drawSurveys(ctx) {
    this.surveyShown = {};
    const v = this.current;
    if (!v) return;
    const epoch = epochOfMjd(v.frame.mjd);
    ctx.save();
    ctx.lineWidth = 1;
    if (this.overlays.wise) this.drawSurvey(ctx, 'wise', this.colors.ink, 0.7, (o) => o, diamond);
    if (this.overlays.gaia) this.drawSurvey(ctx, 'gaia', this.colors.counter, 0.9, (o) => propagate(o, epoch), ring);
    ctx.restore();
  }

  drawSurvey(ctx, kind, color, alpha, where, shape) {
    const survey = this.surveys[kind];
    if (!survey?.rows.length) return;
    let shown = 0;
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (const o of survey.rows) {
      const at = where(o);
      const g = this.grid.worldToIndex(at.ra, at.dec);
      if (!g) continue;
      const [x, y] = this.toCanvas(g[0], g[1]);
      if (x < 0 || y < 0 || x > this.cssW || y > this.cssH) continue;
      shape(ctx, x, y, markRadius(o.mag, survey.limit));
      this.hits.push({ kind, x, y, item: o, at });
      shown += 1;
    }
    ctx.stroke();
    this.surveyShown[kind] = shown;
  }

  /**
   * What SkyBoT says was in the field at the moment of the visit on screen,
   * each with the line it is travelling along.
   *
   * SkyBoT gives the motion at that instant, in arcsec an hour. Drawn out
   * across the frame it answers the question the picture otherwise raises —
   * why a main-belt asteroid is here in one visit and nowhere in the next: at
   * twenty arcsec an hour it is a degree away along this line a week later.
   */
  drawKnownObjects(ctx) {
    const v = this.current;
    const objects = v ? this.knownObjects.get(v.frame.obsId) : null;
    if (!objects?.length) return;

    const reach = this.grid.spanDeg * 3600 * 1.5;
    const cosd = Math.max(0.05, Math.cos((this.grid.dec * Math.PI) / 180));
    const far = Math.hypot(this.cssW, this.cssH);
    ctx.save();
    ctx.font = this.fonts.mark;
    ctx.textBaseline = 'middle';
    for (const o of objects) {
      const g = this.grid.worldToIndex(o.ra, o.dec);
      if (!g) continue;
      const [x, y] = this.toCanvas(g[0], g[1]);
      if (x < -20 || y < -20 || x > this.cssW + 20 || y > this.cssH + 20) continue;

      const rate = Math.hypot(o.dRA, o.dDec);
      let dir = null;
      if (rate > 0) {
        const hours = reach / rate;
        const ahead = this.grid.worldToIndex(
          o.ra + (o.dRA * hours) / 3600 / cosd,
          o.dec + (o.dDec * hours) / 3600,
        );
        if (ahead) {
          const [ax, ay] = this.toCanvas(ahead[0], ahead[1]);
          const len = Math.hypot(ax - x, ay - y);
          if (len > 1) dir = [(ax - x) / len, (ay - y) / len];
        }
      }

      ctx.strokeStyle = this.colors.accent;
      ctx.fillStyle = this.colors.accent;
      if (dir) {
        // The track, faint and broken so it reads as a path and not a mark,
        // with a gap where the ring is.
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.4;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(x - dir[0] * far, y - dir[1] * far);
        ctx.lineTo(x - dir[0] * 15, y - dir[1] * 15);
        ctx.moveTo(x + dir[0] * 15, y + dir[1] * 15);
        ctx.lineTo(x + dir[0] * far, y + dir[1] * far);
        ctx.stroke();
        ctx.setLineDash([]);
        // Which way along it: a small head just outside the ring.
        const hx = x + dir[0] * 17;
        const hy = y + dir[1] * 17;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(hx + dir[0] * 6, hy + dir[1] * 6);
        ctx.lineTo(hx - dir[1] * 3.5, hy + dir[0] * 3.5);
        ctx.lineTo(hx + dir[1] * 3.5, hy - dir[0] * 3.5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.lineWidth = 1.25;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      this.hits.push({ kind: 'skybot', x, y, item: o });
      const name = o.num ? `(${o.num})` : o.name;
      const text = rate > 0 ? `${name} ${this.labels.rate(rate)}` : name;
      // Near the right edge the label goes on the ring's left, or it is cut off.
      const w = ctx.measureText(text).width;
      const right = x + 16 + w <= this.cssW - 4;
      this.taken.push(
        { x0: x - 13, x1: x + 13, y0: y - 13, y1: y + 13 },
        { x0: right ? x + 15 : x - 17 - w, x1: right ? x + 17 + w : x - 15, y0: y - 7, y1: y + 8 },
      );
      ctx.textAlign = right ? 'left' : 'right';
      this.label(ctx, text, right ? x + 16 : x - 16, y + 1, this.colors.accent);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  /**
   * Where the named target was at the date of the visit on screen: its
   * catalogue position carried by its proper motion, or where it stands
   * when no motion is known.
   */
  targetAt() {
    const t = this.target;
    const v = this.current;
    if (!t) return null;
    if (!v || !Number.isFinite(t.epoch)) return { ra: t.ra, dec: t.dec };
    return propagate(t, epochOfMjd(v.frame.mjd), t.epoch);
  }

  /**
   * The object the field was opened for: a thin ring and its name, in the
   * ink of the user's own marks but open, so it reads as "this is the one
   * you asked for" and not as a measurement. It follows a fast star from
   * visit to visit.
   */
  drawTarget(ctx) {
    const at = this.targetAt();
    const g = at && this.grid.worldToIndex(at.ra, at.dec);
    if (!g) return;
    const [x, y] = this.toCanvas(g[0], g[1]);
    if (x < -20 || y < -20 || x > this.cssW + 20 || y > this.cssH + 20) return;
    const r = 16;
    ctx.save();
    ctx.strokeStyle = this.colors.ink;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    this.taken.push({ x0: x - r - 2, x1: x + r + 2, y0: y - r - 2, y1: y + r + 2 });
    const text = this.target.label;
    if (text) {
      ctx.font = this.fonts.mark;
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(text).width;
      // Under the ring, or over it at the bottom edge; never on the star.
      const below = y + r + 14 <= this.cssH - 4;
      const ty = below ? y + r + 9 : y - r - 9;
      const tx = Math.min(Math.max(x, 4 + w / 2), this.cssW - 4 - w / 2);
      ctx.textAlign = 'center';
      this.label(ctx, text, tx, ty, this.colors.ink);
      this.taken.push({ x0: tx - w / 2 - 2, x1: tx + w / 2 + 2, y0: ty - 8, y1: ty + 8 });
    }
    ctx.restore();
  }

  drawMarks(ctx) {
    ctx.save();
    ctx.lineWidth = 1.4;
    ctx.font = this.fonts.mark;
    ctx.textBaseline = 'middle';
    this.marks.forEach((m, n) => {
      const g = this.grid.worldToIndex(m.ra, m.dec);
      if (!g) return;
      const [x, y] = this.toCanvas(g[0], g[1]);
      ctx.strokeStyle = m.known ? this.colors.neutral : this.colors.ink;
      ctx.beginPath();
      ctx.moveTo(x - 14, y); ctx.lineTo(x - 6, y);
      ctx.moveTo(x + 6, y); ctx.lineTo(x + 14, y);
      ctx.moveTo(x, y - 14); ctx.lineTo(x, y - 6);
      ctx.moveTo(x, y + 6); ctx.lineTo(x, y + 14);
      ctx.stroke();
      this.hits.push({ kind: 'mark', x, y, item: m, n: n + 1 });
      const num = String(n + 1);
      this.label(ctx, num, x + 16, y - 12, m.known ? this.colors.neutral : this.colors.ink);
      // What the mark turned out to be, in a word or a name, beside its number —
      // unless it is a body whose SkyBoT ring right there already carries the name.
      const ringSays = m.known && this.overlays.skybot;
      if (m.tag && !ringSays) this.label(ctx, m.tag, x + 16 + ctx.measureText(num).width + 6, y - 12, this.colors.muted);

      if (m.track?.length > 1) {
        ctx.strokeStyle = this.colors.counter;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        m.track.forEach((p, k) => {
          const gi = this.grid.worldToIndex(p.ra, p.dec);
          if (!gi) return;
          const [px, py] = this.toCanvas(gi[0], gi[1]);
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });
    ctx.restore();
  }

  /**
   * Where a marked source would be in another season at each trial distance:
   * a thin line, ticks at round distances, and a ring on the point that
   * matched, if one did. Clipped to the plate, since only that part was looked at.
   */
  drawLink(ctx) {
    const { points, ticks, match, tickLabel } = this.link;
    const at = (p) => {
      const g = this.grid.worldToIndex(p.ra, p.dec);
      return g ? this.toCanvas(g[0], g[1]) : null;
    };
    const xy = points.map(at);
    const { offX, offY, gw, gh, scale } = this.view;
    ctx.save();
    ctx.beginPath();
    ctx.rect(offX, offY, gw * scale, gh * scale);
    ctx.clip();
    ctx.strokeStyle = this.colors.accent;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    let open = false;
    for (const q of xy) {
      if (!q) { open = false; continue; }
      if (open) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
      open = true;
    }
    ctx.stroke();

    // A tick across the line at each round distance, its label to one side.
    ctx.font = this.fonts.compass;
    ctx.textBaseline = 'middle';
    for (const tk of ticks) {
      const q = at(tk.point);
      const r = at(tk.next);
      if (!q || !r) continue;
      const len = Math.hypot(r[0] - q[0], r[1] - q[1]) || 1;
      const nx = -(r[1] - q[1]) / len;
      const ny = (r[0] - q[0]) / len;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(q[0] - nx * 4, q[1] - ny * 4);
      ctx.lineTo(q[0] + nx * 4, q[1] + ny * 4);
      ctx.stroke();
      const text = tickLabel(tk.d);
      const w = ctx.measureText(text).width;
      const lx = q[0] + nx * 10 - (nx < 0 ? w : 0);
      this.label(ctx, text, lx, q[1] + ny * 10, this.colors.accent);
    }
    if (match) {
      const q = at(match);
      if (q) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ring(ctx, q[0], q[1], 9);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Where the compass and scale bar go, and the box they fill. */
  compassLayout(ctx) {
    const pad = 20;
    const len = 22;
    const gap = 22;
    const arcsecPerPx = (this.grid.scale * 3600) / this.view.scale;
    const target = Math.min(this.cssW * 0.1, 150) * arcsecPerPx;
    const bar = BAR_STEPS.find((b) => b >= target) ?? BAR_STEPS[BAR_STEPS.length - 1];
    const px = bar / arcsecPerPx;
    const label = bar >= 60 ? `${bar / 60}′` : `${bar}″`;
    ctx.save();
    ctx.font = this.fonts.compass;
    const labelW = ctx.measureText(label).width;
    ctx.restore();
    const total = 12 + len + gap + px + 8 + labelW;
    const ox = Math.round((this.cssW - total) / 2) + 12 + len;
    const y = Math.round(this.cssH - pad - this.chrome.bottom);
    const box = { x0: ox - len - 14, x1: ox + gap + px + 10 + labelW, y0: y - len - 15, y1: y + 7 };
    return { len, gap, px, label, ox, y, box };
  }

  compassBox(ctx) { return this.compassLayout(ctx).box; }

  /**
   * Orientation and scale as one legend, set on the clear ground at the foot
   * of the frame. North is up and east is left because every frame is
   * reprojected onto the same north-up tangent plane.
   */
  drawCompass(ctx) {
    const { len, gap, px, label, ox, y } = this.compassLayout(ctx);

    ctx.save();
    ctx.strokeStyle = this.colors.muted;
    ctx.fillStyle = this.colors.muted;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.font = this.fonts.compass;
    ctx.textBaseline = 'middle';

    ctx.beginPath();
    ctx.moveTo(ox, y); ctx.lineTo(ox, y - len);
    ctx.moveTo(ox, y); ctx.lineTo(ox - len, y);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText('N', ox, y - len - 8);
    ctx.textAlign = 'right';
    ctx.fillText('E', ox - len - 4, y);

    const bx = ox + gap;
    ctx.beginPath();
    ctx.moveTo(bx, y - 5); ctx.lineTo(bx, y); ctx.lineTo(bx + px, y); ctx.lineTo(bx + px, y - 5);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillText(label, bx + px + 8, y - 1);
    ctx.restore();
  }

  drawCrosshair(ctx) {
    const [x, y] = this.toCanvas(this.hover.i, this.hover.j);
    ctx.save();
    ctx.strokeStyle = this.colors.accent;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, this.cssH);
    ctx.moveTo(0, y); ctx.lineTo(this.cssW, y);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------------------------------------------------- interaction */

  bindPointer() {
    const c = this.canvas;
    // In the wipe a drag moves the divider and a press that does not move
    // marks the sky, as in every other mode. A press on the divider itself
    // takes hold of it at once.
    let dragging = false;
    let pressAt = null;
    let dragged = false;
    const DRAG_PX = 5;
    const GRAB_PX = 20;
    const local = (e) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    // Each sample covers half a step either side of its index.
    const inside = (i, j) => this.grid
      && i >= -0.5 && j >= -0.5 && i < this.grid.width - 0.5 && j < this.grid.height - 0.5;

    c.addEventListener('pointermove', (e) => {
      if (!this.grid) return;
      const [x, y] = local(e);
      if (pressAt && !dragging && this.mode === 'wipe' && Math.hypot(x - pressAt[0], y - pressAt[1]) > DRAG_PX) {
        dragging = true;
        c.setPointerCapture(e.pointerId);
      }
      if (dragging && this.mode === 'wipe') {
        dragged = true;
        this.wipe = Math.max(0, Math.min(1, x / this.cssW));
        this.draw();
        return;
      }
      const [i, j] = this.toGrid(x, y);
      if (!inside(i, j)) { this.hover = null; this.draw(); this.onHover?.(null); this.onItem?.(null); return; }
      this.hover = { i, j };
      this.draw();
      this.onHover?.(this.sample(i, j));
      this.onItem?.(this.itemAt(x, y), x, y);
    });

    c.addEventListener('pointerleave', () => { this.hover = null; this.draw(); this.onHover?.(null); this.onItem?.(null); });

    c.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'wipe') return;
      const [x, y] = local(e);
      pressAt = [x, y];
      dragged = false;
      if (Math.abs(x - this.wipe * this.cssW) <= GRAB_PX) {
        dragging = true;
        c.setPointerCapture(e.pointerId);
      }
    });
    const release = (e) => {
      if (dragging && c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      dragging = false;
      pressAt = null;
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);

    c.addEventListener('click', (e) => {
      if (!this.grid) return;
      // The end of a drag of the divider is not a mark.
      if (this.mode === 'wipe' && dragged) { dragged = false; return; }
      const [x, y] = local(e);
      const [i, j] = this.toGrid(x, y);
      if (!inside(i, j)) return;
      const [ra, dec] = this.grid.indexToWorld(i, j);
      this.onPick?.({ ra, dec, i, j });
    });
  }

  /**
   * The drawn thing nearest the pointer, within a ring's reach. A mark wins a
   * tie, since it is the thing the user put there; then a SkyBoT body.
   */
  itemAt(x, y, reach = 13) {
    const rank = { mark: 0, skybot: 1, catalog: 2, gaia: 3, wise: 4 };
    let best = null;
    let bestD = reach;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - x, h.y - y) + rank[h.kind] * 0.5;
      if (d < bestD) { best = h; bestD = d; }
    }
    return best;
  }

  /** What sits under the cursor, in the visit currently on screen. */
  sample(i, j) {
    const [ra, dec] = this.grid.indexToWorld(i, j);
    const v = this.current;
    let value = null;
    if (v) {
      const ii = Math.round(i);
      const jj = Math.round(j);
      // On a stack the value under the pointer is the stack's.
      const data = this.mode === 'stack' && this.stackCache ? this.stackCache.data : v.stamp.data;
      const raw = data[jj * v.stamp.width + ii];
      value = raw === raw ? raw : null;
    }
    return { ra, dec, value, visit: v?.frame ?? null, i, j };
  }

  /* ----------------------------------------------------------- photometry */

  /**
   * Whether a visit could have shown the spot at all: the spot lies inside
   * its frame with room for the measurement's ring, and most of the pixels
   * there hold sky rather than a blank. A saturated core, blanked around
   * OVERFLOW pixels near it, still counts: the star was there, only too bright.
   * A spot on an optical ghost does not: the light there is a reflection, and
   * counted either way it would read as something that came and went.
   */
  covers(visit, ra, dec, boxPixels = 2) {
    const g = this.grid.worldToIndex(ra, dec);
    if (!g) return false;
    const { width: W, height: H, data, quality } = visit.stamp;
    const perPixel = DETECTOR_ARCSEC / (this.grid.scale * 3600);
    const r = Math.max(2, Math.round(boxPixels * perPixel));
    const out = r + Math.max(1, Math.round(perPixel)) + Math.max(3, Math.round(1.5 * perPixel));
    const ci = Math.round(g[0]);
    const cj = Math.round(g[1]);
    if (ci - out < 0 || cj - out < 0 || ci + out >= W || cj + out >= H) return false;
    if (quality && coreQuality(quality, W, H, ci, cj, r).ghost) return false;
    if (quality && coreQuality(quality, W, H, ci, cj, out).overflow) return true;
    let sky = 0;
    let all = 0;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        all += 1;
        if (data[j * W + i] === data[j * W + i]) sky += 1;
      }
    }
    return sky * 2 >= all;
  }

  /**
   * Find the brightest coherent thing near (ra, dec) in one visit and return its
   * flux-weighted centre. Used to turn a click into a measured position in every
   * visit, which is what makes a drift number honest rather than eyeballed.
   */
  measure(visit, ra, dec, { boxPixels = 2, minSnr = 5, orLimit = false } = {}) {
    const g = this.grid.worldToIndex(ra, dec);
    if (!g) return null;
    const W = visit.stamp.width;
    const H = visit.stamp.height;
    const data = visit.stamp.data;
    const ci = Math.round(g[0]);
    const cj = Math.round(g[1]);
    // Every size here is in detector pixels and turned into grid samples: a
    // narrow field is cut finer, and a box fixed in samples shrank inside the
    // star's own light there, so the ring read the star as background.
    const perPixel = DETECTOR_ARCSEC / (this.grid.scale * 3600);
    const r = Math.max(2, Math.round(boxPixels * perPixel));
    const gap = Math.max(1, Math.round(perPixel));
    const band = Math.max(3, Math.round(1.5 * perPixel));
    const out = r + gap + band;
    if (ci - out < 0 || cj - out < 0 || ci + out >= W || cj + out >= H) return null;

    // A star too bright for the detector: its core ran past the well
    // (OVERFLOW) and the pipeline blanked much of it. Its rim is not its
    // centre and the light left is not its brightness, so the answer is
    // that it is saturated, where the saturated pixels are, and nothing more.
    // Only the FLAGS plane can say this; a stamp without one claims nothing.
    const quality = visit.stamp.quality;
    if (quality) {
      const box = coreQuality(quality, W, H, ci, cj, r);
      const wide = box.overflow ? box : coreQuality(quality, W, H, ci, cj, out);
      if (box.overflow || (box.holeShare > 0.5 && wide.overflow)) {
        const [mra, mdec] = this.grid.indexToWorld(wide.centre[0], wide.centre[1]);
        return {
          ra: mra, dec: mdec, saturated: true, peak: null, flux: null, mag: null, snr: null, noise: null,
          mjd: visit.frame.mjd, obsId: visit.frame.obsId,
        };
      }
    }

    // Background and noise from an annulus a pixel clear of the search box.
    const ring = [];
    for (let j = cj - out; j <= cj + out; j++) {
      for (let i = ci - out; i <= ci + out; i++) {
        const d = Math.max(Math.abs(i - ci), Math.abs(j - cj));
        if (d <= r + gap || d > out) continue;
        const v = data[j * W + i];
        if (v === v) ring.push(v);
      }
    }
    if (ring.length < 12) return null;
    ring.sort((a, b) => a - b);
    const bg = ring[Math.floor(ring.length / 2)];
    const spread = ring[Math.floor(ring.length * 0.84)] - bg;
    // The ring is on the resampled grid, and bilinear resampling smooths it:
    // its spread reads about 0.64 of the detector's own noise. Against that
    // alone, "5σ" let roughly one blank position in eight through as a source
    // over ten visits. The floor is the noise of the detector pixels this
    // visit was cut from.
    const noise = Math.max(spread, visit.stamp.meta?.detectorSigma ?? 0, 1e-6);

    let peak = -Infinity;
    let pi = ci;
    let pj = cj;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        const v = data[j * W + i];
        if (v === v && v > peak) { peak = v; pi = i; pj = j; }
      }
    }
    if (!(peak > bg + minSnr * noise)) {
      // A spectrum needs to know how deep the look was where nothing was seen.
      return orLimit ? { limit: true, noise, mjd: visit.frame.mjd, obsId: visit.frame.obsId } : null;
    }

    let sum = 0;
    let sx = 0;
    let sy = 0;
    for (let j = pj - 2; j <= pj + 2; j++) {
      for (let i = pi - 2; i <= pi + 2; i++) {
        const v = data[j * W + i] - bg;
        if (!(v === v) || v <= 0) continue;
        sum += v; sx += v * i; sy += v * j;
      }
    }
    if (sum <= 0) return null;
    const cx = sx / sum;
    const cy = sy / sum;
    const [mra, mdec] = this.grid.indexToWorld(cx, cy);

    // Brightness: the background-subtracted sum over three detector pixels
    // square about the centroid — the aperture the depth limit is stated for.
    // The grid is cut finer than the detector, so the sum of its samples is
    // divided by how many of them one detector pixel holds. A peak pixel moved
    // by up to a factor of two with where a steady star fell on the detector;
    // an aperture holds the light wherever it falls.
    const half = Math.max(1, Math.round(1.5 * perPixel));
    let flux = 0;
    let lost = 0;
    let overflow = 0;
    for (let j = Math.round(cy) - half; j <= Math.round(cy) + half; j++) {
      for (let i = Math.round(cx) - half; i <= Math.round(cx) + half; i++) {
        const outside = i < 0 || j < 0 || i >= W || j >= H;
        const v = outside ? NaN : data[j * W + i] - bg;
        if (v === v) flux += v;
        else lost += 1;
        if (!outside && quality && quality[j * W + i] & QUALITY.OVERFLOW) overflow += 1;
      }
    }
    // An aperture with a hole in it is not the star's light. Past a tenth
    // masked or off the frame, no brightness is quoted for this visit; nor
    // when any of it lies on a saturated pixel, a bright neighbour's core.
    const whole = lost <= 0.1 * (2 * half + 1) ** 2 && !overflow;
    flux = whole ? flux / (perPixel * perPixel) : null;

    return {
      ...(overflow ? { saturated: true } : {}),
      ra: mra, dec: mdec, peak: peak - bg, flux, mag: whole ? magAB(flux) : null,
      snr: (peak - bg) / noise, noise, mjd: visit.frame.mjd, obsId: visit.frame.obsId,
      // The area actually summed, in detector pixels: the box is a whole number
      // of grid samples, so it is a little more than the nominal 3 × 3.
      aperturePx: (2 * half + 1) ** 2 / (perPixel * perPixel),
    };
  }

  /**
   * Everything in one visit that stands at least `minSnr` above its own
   * background, measured the way a mark is. Local maxima are the candidates;
   * the same photometry decides, so a source here and a mark on it agree.
   */
  sources(visit, { minSnr = 5 } = {}) {
    const { width: W, height: H, data } = visit.stamp;
    const sigma = visit.stamp.meta?.detectorSigma;
    visit.quantiles ??= visit.stamp.quantiles ?? quantileTable(sortedFinite(data));
    if (!(sigma > 0) || !visit.quantiles.n) return [];
    const median = quantileAt(visit.quantiles, 50);
    // A little below the bar the measurement sets, since the local background
    // differs from the field's median; the measurement has the last word.
    const floor = median + 0.8 * minSnr * sigma;
    const perPixel = DETECTOR_ARCSEC / (this.grid.scale * 3600);
    const out = [];
    for (let j = 1; j < H - 1; j++) {
      for (let i = 1; i < W - 1; i++) {
        const v = data[j * W + i];
        if (!(v > floor)) continue;
        let top = true;
        for (let dj = -1; dj <= 1 && top; dj++) {
          for (let di = -1; di <= 1; di++) {
            if ((di || dj) && data[(j + dj) * W + i + di] > v) { top = false; break; }
          }
        }
        if (!top) continue;
        const [ra, dec] = this.grid.indexToWorld(i, j);
        const m = this.measure(visit, ra, dec, { minSnr });
        if (!m) continue;
        const g = this.grid.worldToIndex(m.ra, m.dec);
        // One source, found from two neighbouring maxima, is kept once.
        if (out.some((o) => Math.hypot(o.i - g[0], o.j - g[1]) < perPixel)) continue;
        out.push({ ...m, i: g[0], j: g[1] });
      }
    }
    return out;
  }

  /**
   * Measure a marked position in every loaded visit and say what the numbers
   * support — no more than that.
   *
   * The honest classification is not "how far did it drift". A main-belt asteroid
   * moves ~20″ an hour; between two visits days apart it has left the field
   * entirely, so it appears in one frame and nowhere else. Calling the scatter
   * between unrelated noise peaks a "drift" would be a lie dressed as a number.
   */
  trackMark(ra, dec) {
    const track = [];
    let total = 0;
    for (const v of this.visits) {
      // A visit that never saw the spot — off its frame, or the spot blanked
      // by the pipeline's flags — says nothing about whether it is there. Counted
      // against it, a steady star found in 36 of 38 visits read as one that
      // comes and goes.
      if (!this.covers(v, ra, dec)) continue;
      total += 1;
      const m = this.measure(v, ra, dec);
      if (m) track.push({ ...m, band: v.frame.band, sharp: m.saturated ? null : sharpnessOf(v, m) });
    }

    const seen = track.length;
    // The detector's pixel, not the grid's: the grid is cut finer than the
    // detector, and resampling finely does not make the astrometry finer.
    const pixelArcsec = DETECTOR_ARCSEC;
    const result = { track, seen, total, loaded: this.visits.length, kind: 'none', pixelArcsec };
    if (!seen) return result;

    // Magnitudes run backwards: the smaller number is the brighter visit.
    const mags = track.map((p) => p.mag).filter((m) => m != null);
    const sameBand = new Set(track.map((p) => p.band)).size === 1;
    result.brightness = sameBand && mags.length
      ? { brightest: Math.min(...mags), faintest: Math.max(...mags), band: track[0].band }
      : null;

    // Saturated in most visits: neither "fixed" nor "comes and goes" is
    // something these pixels can support. A visit missed or a centre a pixel
    // off is the saturation talking, not the star.
    if (mostlySaturated(track)) {
      result.kind = 'saturated';
      result.saturated = track.filter((p) => p.saturated).length;
      result.spanDays = track[track.length - 1].mjd - track[0].mjd;
      return result;
    }

    if (seen === 1) {
      result.kind = 'transient';
      result.at = track[0];
      return result;
    }

    // Straight-line fit of position against time. A real mover has a slope that
    // dominates its own scatter; a fixed source does not.
    const t0 = track[0].mjd;
    const cosd = Math.cos((dec * Math.PI) / 180);
    const fit = (values) => {
      const n = values.length;
      const sx = track.reduce((s, p) => s + (p.mjd - t0), 0);
      const sy = values.reduce((s, v) => s + v, 0);
      const sxx = track.reduce((s, p) => s + (p.mjd - t0) ** 2, 0);
      const sxy = track.reduce((s, p, i) => s + (p.mjd - t0) * values[i], 0);
      const den = n * sxx - sx * sx;
      if (Math.abs(den) < 1e-12) return { slope: 0, intercept: sy / n };
      return { slope: (n * sxy - sx * sy) / den, intercept: (sy * sxx - sx * sxy) / den };
    };

    const raArc = track.map((p) => deltaRA(p.ra, ra) * cosd * 3600);
    const decArc = track.map((p) => (p.dec - dec) * 3600);
    const fRa = fit(raArc);
    const fDec = fit(decArc);

    let sq = 0;
    track.forEach((p, i) => {
      const dt = p.mjd - t0;
      sq += (raArc[i] - (fRa.intercept + fRa.slope * dt)) ** 2
        + (decArc[i] - (fDec.intercept + fDec.slope * dt)) ** 2;
    });
    // Two positions fit a line exactly and leave no scatter to quote; how far
    // apart they are is the only spread there is. From three, the line has
    // taken two degrees of freedom.
    const rms = seen > 2
      ? Math.sqrt(sq / (seen - 2))
      : Math.hypot(raArc[1] - raArc[0], decArc[1] - decArc[0]);
    const spanDays = track[track.length - 1].mjd - t0;
    const ratePerDay = Math.hypot(fRa.slope, fDec.slope);

    result.spanDays = spanDays;
    result.rms = rms;
    result.ratePerHour = ratePerDay / 24;

    if (seen >= 3 && ratePerDay * spanDays > Math.max(2 * rms, pixelArcsec)) result.kind = 'moving';
    else if (seen === total) result.kind = 'fixed';
    else result.kind = 'intermittent';
    return result;
  }
}

/**
 * Star or single pixel, for one detection: read on the detector pixels the
 * visit was cut from (see sharpness.js), never on the resampled grid. Null
 * for a visit that arrived without them.
 */
function sharpnessOf(visit, m) {
  const det = visit.stamp.detector;
  if (!det) return null;
  return sharpVerdict(sharpness(det, m.ra, m.dec), visit.stamp.meta?.detectorSigma);
}

/**
 * A catalogue name as a label: SIMBAD's designations carry prefixes that say
 * what kind of name it is ("NAME Orion Nebula Cluster", "* tet01 Ori C",
 * "V* T Ori"), which a label on a picture does not need.
 */
export function shortName(name) {
  return String(name ?? '').replace(/^(NAME|V\*|\*\*?)\s+/, '').trim();
}

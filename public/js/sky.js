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

import { limits, paint, paintDifference, rampFromToken, resolveColor } from './render.js';
import { SECTOR_COLS, SECTOR_ROWS, sectorBounds } from './sectors.js';

const RAMP_TOKENS = { deep: '--cmap-deep', ice: '--cmap-ice', infrared: '--cmap-infrared' };

/** Angular steps a grid line is allowed to land on, in degrees. */
const GRID_STEPS = [1 / 240, 1 / 120, 1 / 60, 1 / 30, 1 / 12, 1 / 6, 0.5, 1];
const BAR_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 1800];

export class SkyView {
  constructor(canvas, { onHover, onPick, onItem } = {}) {
    this.canvas = canvas;
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
    this.overlays = { grid: true, compass: true, catalog: true, skybot: true, marks: true, sectors: false };
    /* Which sector the matrix is pointing at, if any. */
    this.sector = null;
    /* SkyBoT's answer for each visit, keyed by the frame's obsId rather than its
       place in the list: visits are sorted by date as they arrive, and an answer
       filed under a position drifted onto the wrong visit when one landed early. */
    this.knownObjects = new Map();
    this.marks = [];
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

  toCanvas(i, j) {
    const { scale, offX, offY } = this.view;
    return [offX + i * scale, offY + j * scale];
  }

  toGrid(x, y) {
    const { scale, offX, offY } = this.view;
    return [(x - offX) / scale, (y - offY) / scale];
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
    this.draw();
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

  /** One visit's own black and white point, cut once per clip setting. */
  ownLimits(v) {
    const key = this.render.clip;
    if (v.cut?.key !== key) v.cut = { key, lim: limits(v.stamp.data, { loPercent: 5, hiPercent: key }) };
    return v.cut.lim;
  }

  paintVisit(v, shared = null) {
    const lut = this.ramps[this.render.palette] ?? this.ramps.deep;
    const lim = shared ?? this.ownLimits(v);
    v.limits = lim;
    const img = v.ctx.createImageData(v.stamp.width, v.stamp.height);
    paint(img, v.stamp.data, lut, { lo: lim.lo, hi: lim.hi, stretch: this.render.stretch });
    v.ctx.putImageData(img, 0, 0);
  }

  setRender(patch) { Object.assign(this.render, patch); this.repaintAll(); }
  setOverlays(patch) { Object.assign(this.overlays, patch); this.draw(); }
  setMode(mode) { this.mode = mode; this.diffCache = null; this.draw(); }

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

  repaintAll() {
    if (!this.visits.length) { this.draw(); return; }
    const shared = this.render.shared ? this.sharedLimits() : null;
    for (const v of this.visits) this.paintVisit(v, shared);
    this.diffCache = null;
    this.draw();
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
    if (this.mode === 'single' || this.mode === 'blink') return this.visits[this.index] ?? null;
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
        else if (this.visits[this.a]) this.place(ctx, this.visits[this.a].canvas);
      } else if (this.mode === 'wipe') {
        const a = this.visits[this.a];
        const b = this.visits[this.b] ?? a;
        if (a) this.place(ctx, a.canvas);
        const x = Math.round(this.cssW * this.wipe);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, 0, this.cssW - x, this.cssH);
        ctx.clip();
        if (b) this.place(ctx, b.canvas);
        ctx.restore();
        this.drawWipeHandle(ctx, x);
      } else {
        const v = this.current;
        if (v) this.place(ctx, v.canvas);
      }
    }

    this.hits = [];
    if (this.grid) {
      if (this.overlays.grid) this.drawGrid(ctx);
      if (this.overlays.catalog) this.drawCatalog(ctx);
      if (this.overlays.skybot) this.drawKnownObjects(ctx);
      if (this.overlays.sectors || this.sector) this.drawSectors(ctx);
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
    // A mark on the object already names it; a second label would say it twice.
    const marked = this.overlays.marks
      ? this.marks.map((m) => this.grid.worldToIndex(m.ra, m.dec)).filter(Boolean).map((g) => this.toCanvas(g[0], g[1]))
      : [];
    ctx.save();
    ctx.font = this.fonts.compass;
    ctx.textBaseline = 'middle';
    this.catalog.forEach((o, k) => {
      const g = this.grid.worldToIndex(o.ra, o.dec);
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

      const text = shortName(o.name);
      const w = ctx.measureText(text).width;
      const right = x + 9 + w <= this.cssW - 4;
      const box = { x0: right ? x + 8 : x - 9 - w, x1: right ? x + 9 + w : x - 8, y0: y - 7, y1: y + 7 };
      if (placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) return;
      placed.push(box);
      ctx.textAlign = right ? 'left' : 'right';
      this.label(ctx, text, right ? x + 9 : x - 9, y, this.colors.muted);
    });
    ctx.restore();
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
      const right = x + 16 + ctx.measureText(text).width <= this.cssW - 4;
      ctx.textAlign = right ? 'left' : 'right';
      this.label(ctx, text, right ? x + 16 : x - 16, y + 1, this.colors.accent);
      ctx.textAlign = 'left';
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
   * Orientation and scale as one legend, set on the clear ground at the foot
   * of the frame. North is up and east is left because every frame is
   * reprojected onto the same north-up tangent plane.
   */
  drawCompass(ctx) {
    const pad = 20;
    const len = 22;
    const gap = 22;
    const arcsecPerPx = (this.grid.scale * 3600) / this.view.scale;
    const target = Math.min(this.cssW * 0.1, 150) * arcsecPerPx;
    const bar = BAR_STEPS.find((b) => b >= target) ?? BAR_STEPS[BAR_STEPS.length - 1];
    const px = bar / arcsecPerPx;
    const label = bar >= 60 ? `${bar / 60}′` : `${bar}″`;

    ctx.save();
    ctx.strokeStyle = this.colors.muted;
    ctx.fillStyle = this.colors.muted;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.font = this.fonts.compass;
    ctx.textBaseline = 'middle';

    const labelW = ctx.measureText(label).width;
    const total = 12 + len + gap + px + 8 + labelW;
    const ox = Math.round((this.cssW - total) / 2) + 12 + len;
    const y = Math.round(this.cssH - pad - this.chrome.bottom);

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
    let dragging = false;
    const local = (e) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const inside = (i, j) => this.grid
      && i >= 0 && j >= 0 && i <= this.grid.width - 1 && j <= this.grid.height - 1;

    c.addEventListener('pointermove', (e) => {
      if (!this.grid) return;
      const [x, y] = local(e);
      if (dragging && this.mode === 'wipe') {
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
      dragging = true;
      c.setPointerCapture(e.pointerId);
      const [x] = local(e);
      this.wipe = Math.max(0, Math.min(1, x / this.cssW));
      this.draw();
    });
    c.addEventListener('pointerup', (e) => {
      if (dragging) { dragging = false; c.releasePointerCapture(e.pointerId); }
    });

    c.addEventListener('click', (e) => {
      if (!this.grid || this.mode === 'wipe') return;
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
    const rank = { mark: 0, skybot: 1, catalog: 2 };
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
      const raw = v.stamp.data[jj * v.stamp.width + ii];
      value = raw === raw ? raw : null;
    }
    return { ra, dec, value, visit: v?.frame ?? null, i, j };
  }

  /* ----------------------------------------------------------- photometry */

  /**
   * Find the brightest coherent thing near (ra, dec) in one visit and return its
   * flux-weighted centre. Used to turn a click into a measured position in every
   * visit, which is what makes a drift number honest rather than eyeballed.
   */
  measure(visit, ra, dec, { boxPx = 5, minSnr = 5 } = {}) {
    const g = this.grid.worldToIndex(ra, dec);
    if (!g) return null;
    const W = visit.stamp.width;
    const H = visit.stamp.height;
    const data = visit.stamp.data;
    const ci = Math.round(g[0]);
    const cj = Math.round(g[1]);
    const r = boxPx;
    if (ci - r - 3 < 0 || cj - r - 3 < 0 || ci + r + 3 >= W || cj + r + 3 >= H) return null;

    // Background and noise from an annulus just outside the search box.
    const ring = [];
    for (let j = cj - r - 3; j <= cj + r + 3; j++) {
      for (let i = ci - r - 3; i <= ci + r + 3; i++) {
        const d = Math.max(Math.abs(i - ci), Math.abs(j - cj));
        if (d <= r || d > r + 3) continue;
        const v = data[j * W + i];
        if (v === v) ring.push(v);
      }
    }
    if (ring.length < 12) return null;
    ring.sort((a, b) => a - b);
    const bg = ring[Math.floor(ring.length / 2)];
    const mad = ring[Math.floor(ring.length * 0.84)] - bg;
    const noise = Math.max(mad, 1e-6);

    let peak = -Infinity;
    let pi = ci;
    let pj = cj;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        const v = data[j * W + i];
        if (v === v && v > peak) { peak = v; pi = i; pj = j; }
      }
    }
    if (!(peak > bg + minSnr * noise)) return null;

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
    const [mra, mdec] = this.grid.indexToWorld(sx / sum, sy / sum);
    return { ra: mra, dec: mdec, peak: peak - bg, snr: (peak - bg) / noise, mjd: visit.frame.mjd, obsId: visit.frame.obsId };
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
    for (const v of this.visits) {
      const m = this.measure(v, ra, dec);
      if (m) track.push({ ...m, band: v.frame.band });
    }

    const total = this.visits.length;
    const seen = track.length;
    const pixelArcsec = this.grid.scale * 3600;
    const result = { track, seen, total, kind: 'none', pixelArcsec };
    if (!seen) return result;

    const peaks = track.map((p) => p.peak);
    const sameBand = new Set(track.map((p) => p.band)).size === 1;
    result.brightness = sameBand
      ? { min: Math.min(...peaks), max: Math.max(...peaks), band: track[0].band }
      : null;

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

    const raArc = track.map((p) => (p.ra - ra) * cosd * 3600);
    const decArc = track.map((p) => (p.dec - dec) * 3600);
    const fRa = fit(raArc);
    const fDec = fit(decArc);

    let sq = 0;
    track.forEach((p, i) => {
      const dt = p.mjd - t0;
      sq += (raArc[i] - (fRa.intercept + fRa.slope * dt)) ** 2
        + (decArc[i] - (fDec.intercept + fDec.slope * dt)) ** 2;
    });
    const rms = Math.sqrt(sq / track.length);
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
 * A catalogue name as a label: SIMBAD's designations carry prefixes that say
 * what kind of name it is ("NAME Orion Nebula Cluster", "* tet01 Ori C",
 * "V* T Ori"), which a label on a picture does not need.
 */
export function shortName(name) {
  return String(name ?? '').replace(/^(NAME|V\*|\*\*?)\s+/, '').trim();
}

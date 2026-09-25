/**
 * twilight.js — changing theme the way the sky changes.
 *
 * Two effects, one per direction, and both are things the sky really does.
 *
 *   To day, sunrise from orbit. A horizon climbs the page from the bottom edge,
 *   curved the way a planet's limb is, with the thin shell of its atmosphere
 *   lit along it — blue far from the sun, red and gold over it — and the sun
 *   coming up out of it. The sun rides the horizon up the page and leaves over
 *   the top with it.
 *
 *   To night, dusk facing away from the Sun: the Earth's shadow rising under
 *   the rose of the Belt of Venus while the colour drains out of the day, and
 *   the full Moon coming up out of the shadow, riding the edge up the page the
 *   way the Sun does the other way.
 *
 * Nothing else. No star is ever drawn — the page exists to show real ones, and
 * a point of light an effect put there reads as data — and nothing is left on
 * the page when the change is done.
 *
 * Underneath, both work as the fire does on the sister site this was modelled
 * on. `startViewTransition` freezes the outgoing page as a snapshot and paints
 * the new theme live beneath it; a clip-path on the snapshot eats it away along
 * the horizon, so the content is live and readable on both sides of the edge
 * the whole time — nothing is hidden behind a slab of colour.
 *
 * The clip and the light are one motion, so they share one clock: the clip
 * animation is paused and stepped from the same frame that draws the canvas.
 * Left to run on the compositor it kept perfect time while the canvas, busy,
 * fell behind it — and the sun visibly trailed its own horizon in fits.
 */

const TAU = Math.PI * 2;

/** Long enough to watch; much past four seconds a transition becomes a wait. */
const DAWN_MS = 3600;
const DUSK_MS = 3800;
/** Points along the horizon, for the clip and the crisp line on it. */
const SEGMENTS = 120;
/** Key frames for the clip; the clip is stepped between them by the clock. */
const STEPS = 90;
/** Slices the soft bands along the horizon are laid in. */
const SLICES = 192;

let running = false;

/* ------------------------------------------------------------------ shape */

/**
 * The horizon: a gentle arc, highest over `x0`, with a faint shimmer.
 * A limb is curved and smooth; the shimmer is two slow waves a few pixels high.
 */
function makeShape({ x0, curve }) {
  const bowAt = (x) => { const d = (x - x0) / 0.6; return curve * d * d; };
  const maxBow = Math.max(bowAt(0), bowAt(1));
  const waves = [
    { freq: 3 + Math.random() * 2, phase: Math.random() * TAU, amp: 0.6, drift: 1.1 },
    { freq: 9 + Math.random() * 4, phase: Math.random() * TAU, amp: 0.4, drift: -2.3 },
  ];
  return { x0, curve, bowAt, maxBow, waves, amp: 0.008 };
}

/**
 * Height of the horizon at `x` (0..1), as a fraction of the viewport from the
 * top, at progress `p`: wholly below the bottom at 0, wholly above the top at 1.
 */
function edgeAt(s, x, p) {
  let shimmer = 0;
  for (const w of s.waves) shimmer += Math.sin(x * w.freq + w.phase + p * w.drift) * w.amp;
  const travel = 1 + s.maxBow + s.amp * 6;
  return 1 + s.amp * 3 - p * travel + s.bowAt(x) + shimmer * s.amp;
}

/** Everything above the horizon — the part of the old page still standing. */
function clipAbove(s, p) {
  const pts = ['0% -5%', '100% -5%'];
  for (let i = SEGMENTS; i >= 0; i--) {
    const x = i / SEGMENTS;
    pts.push(`${(x * 100).toFixed(2)}% ${(edgeAt(s, x, p) * 100).toFixed(2)}%`);
  }
  return `polygon(${pts.join(',')})`;
}

/**
 * Nearly constant speed, with only a short gather at the start and a short
 * settle at the end. A full ease-in-out spent a third of the run crawling,
 * which read as the horizon stalling.
 */
const ease = (t) => t - Math.sin(TAU * t) / (TAU * 1.6);
const smooth = (a, b, t) => { const k = Math.min(1, Math.max(0, (t - a) / (b - a))); return k * k * (3 - 2 * k); };

/** How far toward night the day side has gone, 0..1, at raw progress `raw`. */
const nightfall = (raw) => smooth(0, 0.8, raw);

/**
 * The old page's own dusk. At nightfall colour goes before light does — the
 * eye stops seeing it well before it stops seeing — so the day side greys out
 * first and dims less. Applied to the snapshot itself, so it is the page that
 * dusks and not a sheet laid over it.
 */
function duskFilter(raw) {
  const k = nightfall(raw);
  return `saturate(${(1 - 0.62 * k).toFixed(3)}) brightness(${(1 - 0.3 * k).toFixed(3)})`;
}

/* --------------------------------------------------------------- the stage */

/** Hold the page still: the outgoing theme is a photograph and cannot scroll. */
let holds = 0;
let heldOverflow = '';
function holdPage() {
  const root = document.documentElement;
  if (holds === 0) heldOverflow = root.style.overflow;
  holds++;
  root.style.overflow = 'hidden';
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (holds === 0) root.style.overflow = heldOverflow;
  };
}

/** End the transition: the do-nothing animation in the stylesheet keeps it open. */
function releaseTransition() {
  for (const a of document.getAnimations()) {
    if (a.animationName === 'vt-hold') a.finish();
  }
}

/**
 * The canvas the effect is drawn on, carried by the transition as a layer of
 * its own above both themes. Everything on it lies on the old page's side of
 * the horizon — the Sun and the Moon ride just above the line, the light and
 * the Belt of Venus along it. Nothing is drawn below the line: there, the new
 * page's side column was painted over this layer during the change.
 */
function makeLayer() {
  const canvas = document.createElement('canvas');
  canvas.className = 'twilight';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  return canvas;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** A soft round sprite, drawn once and stamped. */
function softDisc(size, inner, outer) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/**
 * A band's vertical profile, drawn once: `stops` are [offset in px from the
 * horizon, rgba] from top to bottom. Laid along the horizon in slices, this
 * replaces blurred strokes, which cost a full-canvas blur each, every frame —
 * the reason the light used to fall behind its horizon.
 */
function bandSprite(stops) {
  const top = stops[0][0];
  const bottom = stops[stops.length - 1][0];
  const c = makeCanvas(1, bottom - top);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, bottom - top);
  for (const [at, colour] of stops) grad.addColorStop((at - top) / (bottom - top), colour);
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, bottom - top);
  return { canvas: c, top, bottom };
}

/**
 * Lay a band along the horizon; `alphaAt(x)` shapes it across the page.
 *
 * The slices meet on whole device pixels and never overlap: an overlap of a
 * pixel, added twice under 'lighter', drew every seam as a bright line.
 */
function drawBand(ctx, s, p, w, h, band, alphaAt = () => 1) {
  const k = ctx.getTransform().a;
  const W = Math.round(w * k);
  const sy = ((band.bottom - band.top) * k) / band.canvas.height;
  // Each slice is sheared to run from the horizon's height at its left side to
  // its height at its right, so the band is one continuous line of segments.
  // Laid level, each slice stepped where the horizon is steep, and the band's
  // bright core showed as a staircase.
  let x0 = 0;
  let y0 = (edgeAt(s, 0, p) * h + band.top) * k;
  ctx.save();
  for (let i = 0; i < SLICES; i++) {
    const x1 = Math.round(((i + 1) / SLICES) * W);
    const y1 = (edgeAt(s, x1 / W, p) * h + band.top) * k;
    const a = alphaAt((i + 0.5) / SLICES);
    if (a >= 0.01 && x1 > x0) {
      ctx.globalAlpha = Math.min(1, a);
      ctx.setTransform(x1 - x0, y1 - y0, 0, sy, x0, y0);
      ctx.drawImage(band.canvas, 0, 0);
    }
    x0 = x1;
    y0 = y1;
  }
  ctx.restore();
}

function traceEdge(ctx, s, p, w, h, offset = 0) {
  ctx.beginPath();
  for (let i = 0; i <= SEGMENTS; i++) {
    const x = i / SEGMENTS;
    const y = edgeAt(s, x, p) * h + offset;
    if (i === 0) ctx.moveTo(x * w, y);
    else ctx.lineTo(x * w, y);
  }
}

/** Restrict drawing to the side of the horizon the old page is still on. */
function clipAbove2d(ctx, s, p, w, h) {
  ctx.beginPath();
  ctx.moveTo(0, -60);
  ctx.lineTo(w, -60);
  for (let i = SEGMENTS; i >= 0; i--) {
    const x = i / SEGMENTS;
    ctx.lineTo(x * w, edgeAt(s, x, p) * h);
  }
  ctx.closePath();
  ctx.clip();
}

function sizeLayer(canvas, w, h, dpr) {
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/* ---------------------------------------------------------------- the run */

/**
 * Change theme. `swap` applies the new one; `target` is where it goes; `done`
 * is called once, however the change ends, when the page is fully handed back.
 */
export function themeTransition(swap, target, done = () => {}) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (running) return;
  if (reduced || !document.body) { swap(); done(); return; }
  running = true;

  const toDay = target === 'light';
  // The sun comes up right of centre; the shadow's highest point is left of
  // it, so the two directions are not one gesture played backwards.
  const shape = toDay
    ? makeShape({ x0: 0.64 + (Math.random() - 0.5) * 0.08, curve: 0.12 })
    : makeShape({ x0: 0.34 + (Math.random() - 0.5) * 0.1, curve: 0.05 });
  const ms = toDay ? DAWN_MS : DUSK_MS;
  // Linear key frames of progress; the easing is applied here, so the clip
  // and the canvas agree on where the horizon is at every instant.
  const frames = Array.from({ length: STEPS + 1 }, (_, i) => {
    const frame = { clipPath: clipAbove(shape, ease(i / STEPS)) };
    if (!toDay) frame.filter = duskFilter(i / STEPS);
    return frame;
  });

  const layers = () => ({ over: makeLayer() });
  // Every sprite the scene needs is drawn now, while the old page is still up:
  // built between the snapshot and the first frame, it held the start back.
  const scene = toDay ? dawnScene(window.innerWidth, window.innerHeight, shape) : duskScene(window.innerWidth, window.innerHeight, shape);

  if (typeof document.startViewTransition !== 'function') {
    swap();
    play(layers(), scene, ms, null, toDay, done);
    return;
  }

  let made = null;
  const transition = document.startViewTransition(() => {
    swap();
    // Made inside the update, so the transition captures them with the new state.
    made = layers();
  });

  transition.ready
    .then(() => {
      const anim = document.documentElement.animate(frames, {
        duration: ms, easing: 'linear', fill: 'forwards',
        pseudoElement: '::view-transition-old(root)',
      });
      // Stepped by hand from the drawing loop, never left to run ahead of it.
      anim.pause();
      play(made, scene, ms, anim, toDay, done);
    })
    .catch(() => {
      made?.over.remove();
      releaseTransition();
      running = false;
      done();
    });
}

function play({ over }, scene, ms, anim, toDay, done) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const ctx = sizeLayer(over, w, h, dpr);

  const unhold = holdPage();
  let started = null;

  const frame = (now) => {
    if (started == null) started = now;
    const elapsed = now - started;
    const raw = Math.min(1, elapsed / ms);
    // The clip goes exactly where the light is drawn, in this same frame.
    if (anim) anim.currentTime = Math.min(ms, elapsed);
    ctx.clearRect(0, 0, w, h);
    if (raw < 1) {
      scene(ctx, ease(raw), raw, 0);
      requestAnimationFrame(frame);
      return;
    }
    // The horizon is over the top, and the Sun or the Moon over it with it:
    // there is nothing left to draw, so the change ends here. It used to run on
    // for half a second after, and with the horizon gone there was nothing to
    // cut the glare at — it showed whole for that half second, as a flash.
    releaseTransition();
    unhold();
    over.remove();
    running = false;
    done();
  };
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------- dawn */

/**
 * Sunrise over a limb, as a camera in orbit sees it.
 *
 * What makes a photograph of it read as real is not the sun's disc — a camera
 * never sees one, it is over-exposed into a white core with no edge — but what
 * the light does to the air and to the lens. So:
 *
 *   The air. A shell only a few pixels thick, layered the way the light has
 *   come through it: over the sun, red at the limb itself, then orange, gold,
 *   white, and blue above; away from the sun only the blue. Laid from two
 *   profiles mixed by how near each slice is to the sun.
 *
 *   The lens. Needle spikes from the aperture blades, a faint rainbow ring,
 *   hexagonal ghosts marching through the centre of the frame, a horizontal
 *   streak, and a veil of glare over everything still in shadow.
 *
 * The core comes up out of the limb, cut by it, and the first sliver is the
 * brightest instant of the event — the "diamond". Then it keeps its place just
 * above the horizon and goes up with it, off the top of the page. Every piece
 * of glare is laid on the night side only: over the new page it whited out the
 * very thing the page is for.
 */
function dawnScene(w, h, s) {
  const m = Math.min(w, h);
  const coreR = m * 0.05;
  const sx = s.x0 * w;
  const warmth = (x) => Math.exp(-(((x - s.x0) / 0.16) ** 2));

  const coolShell = bandSprite([
    [-160, 'rgba(40, 90, 230, 0)'], [-80, 'rgba(50, 110, 250, 0.2)'], [-26, 'rgba(90, 170, 255, 0.5)'],
    [-7, 'rgba(170, 222, 255, 0.85)'], [0, 'rgba(236, 248, 255, 1)'], [8, 'rgba(236, 248, 255, 0)'],
  ]);
  const warmShell = bandSprite([
    [-160, 'rgba(90, 140, 255, 0)'], [-84, 'rgba(90, 150, 255, 0.24)'], [-40, 'rgba(180, 220, 255, 0.5)'],
    [-20, 'rgba(255, 240, 205, 0.8)'], [-10, 'rgba(255, 200, 110, 0.92)'], [-4, 'rgba(255, 128, 58, 0.95)'],
    [0, 'rgba(255, 250, 240, 1)'], [8, 'rgba(255, 240, 220, 0)'],
  ]);
  const dayHaze = bandSprite([
    [0, 'rgba(255, 196, 120, 0.38)'], [30, 'rgba(255, 206, 140, 0.22)'], [170, 'rgba(255, 220, 170, 0)'],
  ]);
  const lens = {
    core: coreSprite(Math.round(coreR * 3.2)),
    glow: softDisc(256, 'rgba(255, 238, 205, 1)', 'rgba(255, 170, 90, 0)'),
    spikes: spikeSprite(Math.round(m * 0.55)),
    streak: streakSprite(Math.round(w * 0.5)),
    ring: ringSprite(Math.round(m * 0.3)),
    fan: raySprite(Math.round(h * 1.1)),
  };
  const ghosts = [
    { t: 0.28, r: 0.04, rgb: '130, 255, 190', a: 0.12 },
    { t: 0.52, r: 0.018, rgb: '255, 220, 140', a: 0.18 },
    { t: 0.78, r: 0.085, rgb: '120, 150, 255', a: 0.06 },
    { t: 1.1, r: 0.03, rgb: '220, 130, 255', a: 0.12 },
    { t: 1.42, r: 0.12, rgb: '255, 170, 110', a: 0.045 },
    { t: 1.75, r: 0.022, rgb: '140, 255, 230', a: 0.14 },
  ].map((g) => ({ ...g, sprite: hexSprite(Math.round(g.r * m), g.rgb) }));

  return (ctx, p, raw, after) => {
    const live = raw < 1;
    const fade = 1 - after;
    const limbY = edgeAt(s, s.x0, p) * h;
    // Clearing the limb, in core radii: from one below it to a little more than
    // one above, over the first ~40% of the run; from then on it keeps that
    // place on the horizon and moves with it.
    const clear = -1.1 + 2.4 * smooth(0.03, 0.42, raw);
    const sy = limbY - clear * coreR;
    // The diamond: a swell of light as the first of the sun clears the limb,
    // held for most of a second and kept gentle — a sharp full-strength flash
    // was over before it could be seen and hurt when it was.
    const diamond = 0.5 * Math.exp(-((raw - 0.14) ** 2) / (2 * 0.07 ** 2));
    const up = smooth(-1.05, -0.5, clear);
    const glare = (up * 0.75 + diamond) * fade;

    // The night, already paling ahead of the horizon.
    if (live) {
      ctx.save();
      clipAbove2d(ctx, s, p, w, h);
      const wash = ctx.createLinearGradient(0, limbY, 0, limbY - h * 0.6);
      const k = smooth(0, 0.4, raw);
      wash.addColorStop(0, `rgba(56, 118, 214, ${0.4 * k})`);
      wash.addColorStop(0.35, `rgba(40, 70, 160, ${0.18 * k})`);
      wash.addColorStop(1, 'rgba(20, 30, 90, 0)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    // The first light on the new page, under the shell.
    ctx.globalCompositeOperation = 'source-over';
    drawBand(ctx, s, p, w, h, dayHaze, (x) => (0.35 + 0.65 * warmth(x)) * fade);

    // The shell: cool everywhere, layered warm over the sun.
    ctx.globalCompositeOperation = 'lighter';
    drawBand(ctx, s, p, w, h, coolShell, (x) => (1 - warmth(x)) * fade);
    drawBand(ctx, s, p, w, h, warmShell, (x) => warmth(x) * fade);
    traceEdge(ctx, s, p, w, h);
    ctx.strokeStyle = `rgba(255, 255, 250, ${0.95 * fade})`;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    if (glare < 0.01 && up < 0.01) { ctx.globalCompositeOperation = 'source-over'; return; }

    // All of the glare, on the night side only.
    ctx.save();
    if (live) clipAbove2d(ctx, s, p, w, h);
    ctx.globalCompositeOperation = 'lighter';

    // A veil over the whole frame: glare scattered inside the lens.
    ctx.globalAlpha = 0.07 * glare;
    ctx.fillStyle = 'rgb(255, 238, 214)';
    ctx.fillRect(0, 0, w, h);

    const stamp = (img, size, a, x = sx, y = sy, ratio = 1) => {
      if (a < 0.005) return;
      ctx.globalAlpha = Math.min(1, a);
      ctx.drawImage(img, x - size, y - size * ratio, size * 2, size * 2 * ratio);
    };
    ctx.globalAlpha = Math.min(1, 0.4 * glare);
    ctx.drawImage(lens.fan, sx - lens.fan.width / 2, sy - lens.fan.height);
    stamp(lens.glow, m * (0.4 + diamond * 0.2), 0.7 * glare);
    stamp(lens.ring, lens.ring.width / 2, 0.8 * glare);
    const L = lens.streak.width / 2 * (0.8 + diamond * 0.5);
    stamp(lens.streak, L, glare, sx, sy, (12 * (0.8 + diamond * 0.5)) / L);
    stamp(lens.spikes, lens.spikes.width / 2 * (0.65 + diamond * 0.55), 0.85 * glare);
    stamp(lens.core, lens.core.width / 2, fade * (0.25 + 0.75 * up));

    // Ghosts, along the line from the sun through the middle of the frame.
    for (const g of ghosts) {
      const gx = sx + (w / 2 - sx) * g.t;
      const gy = sy + (h / 2 - sy) * g.t;
      stamp(g.sprite, g.sprite.width / 2, g.a * glare, gx, gy);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  };
}

/** An over-exposed sun: a white core with no edge, falling off into gold. */
function coreSprite(r) {
  const c = makeCanvas(r * 2, r * 2);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(0.24, 'rgba(255, 255, 252, 1)');
  grad.addColorStop(0.34, 'rgba(255, 248, 228, 0.92)');
  grad.addColorStop(0.52, 'rgba(255, 222, 160, 0.42)');
  grad.addColorStop(0.75, 'rgba(255, 186, 110, 0.12)');
  grad.addColorStop(1, 'rgba(255, 170, 90, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, r * 2, r * 2);
  return c;
}

/**
 * Diffraction spikes from an eight-bladed aperture: eight long needles and
 * eight faint short ones between them, each tapering to nothing.
 */
function spikeSprite(len) {
  const c = makeCanvas(len * 2, len * 2);
  const g = c.getContext('2d');
  const needle = (at, l, width, alpha) => {
    const ex = len + Math.cos(at) * l;
    const ey = len + Math.sin(at) * l;
    const nx = -Math.sin(at) * width;
    const ny = Math.cos(at) * width;
    const grad = g.createLinearGradient(len, len, ex, ey);
    grad.addColorStop(0, `rgba(255, 252, 244, ${alpha})`);
    grad.addColorStop(0.35, `rgba(255, 238, 210, ${alpha * 0.4})`);
    grad.addColorStop(1, 'rgba(255, 230, 200, 0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(len + nx, len + ny);
    g.lineTo(ex, ey);
    g.lineTo(len - nx, len - ny);
    g.closePath();
    g.fill();
  };
  for (let i = 0; i < 8; i++) {
    const at = (i / 8) * TAU + 0.18;
    needle(at, len * (i % 2 ? 0.8 : 1), 2.2, 0.9);
    needle(at + TAU / 16, len * 0.38, 1.2, 0.45);
  }
  return c;
}

/** The streak a bright point throws across a lens: a flat ellipse of light. */
function streakSprite(L) {
  const c = makeCanvas(L * 2, 24);
  const g = c.getContext('2d');
  g.translate(L, 12);
  g.scale(1, 12 / L);
  const f = g.createRadialGradient(0, 0, 0, 0, 0, L);
  f.addColorStop(0, 'rgba(255, 250, 236, 0.55)');
  f.addColorStop(0.25, 'rgba(200, 225, 255, 0.16)');
  f.addColorStop(1, 'rgba(160, 200, 255, 0)');
  g.fillStyle = f;
  g.fillRect(-L, -L, L * 2, L * 2);
  return c;
}

/** A faint rainbow ring around the sun, the reflection inside the lens barrel. */
function ringSprite(r) {
  const size = Math.round(r * 2.3);
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const mid = size / 2;
  g.filter = `blur(${Math.max(1, r * 0.012)}px)`;
  const hues = ['255, 90, 70', '255, 190, 80', '140, 255, 140', '90, 170, 255', '170, 110, 255'];
  hues.forEach((rgb, i) => {
    g.strokeStyle = `rgba(${rgb}, 0.09)`;
    g.lineWidth = Math.max(1.5, r * 0.018);
    g.beginPath();
    g.arc(mid, mid, r * (1 - i * 0.022), 0, TAU);
    g.stroke();
  });
  g.filter = 'none';
  return c;
}

/** A lens ghost: the shape of the aperture, tinted, brighter at its rim. */
function hexSprite(r, rgb) {
  const size = Math.max(4, r * 2 + 4);
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const mid = size / 2;
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const at = (i / 6) * TAU + Math.PI / 6;
    const x = mid + Math.cos(at) * r;
    const y = mid + Math.sin(at) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  const grad = g.createRadialGradient(mid, mid, 0, mid, mid, r);
  grad.addColorStop(0, `rgba(${rgb}, 0.35)`);
  grad.addColorStop(0.8, `rgba(${rgb}, 0.55)`);
  grad.addColorStop(1, `rgba(${rgb}, 0.9)`);
  g.fillStyle = grad;
  g.fill();
  return c;
}

/**
 * Light through the last of the air: soft wedges fanning up, drawn once. Held
 * well back — from orbit the needles of the lens are the rays one sees.
 */
function raySprite(len) {
  const c = makeCanvas(len * 2, len);
  const g = c.getContext('2d');
  const x = len;
  const y = len;
  const n = 15;
  for (let i = 0; i < n; i++) {
    const at = -Math.PI + (i + 0.5) * (Math.PI / n);
    const spread = 0.012 + ((i * 7) % 5) * 0.005;
    const strength = 0.035 + ((i * 3) % 4) * 0.018;
    const grad = g.createRadialGradient(x, y, 0, x, y, len);
    grad.addColorStop(0, `rgba(255, 232, 180, ${strength})`);
    grad.addColorStop(1, 'rgba(255, 220, 170, 0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(at - spread) * len, y + Math.sin(at - spread) * len);
    g.lineTo(x + Math.cos(at + spread) * len, y + Math.sin(at + spread) * len);
    g.closePath();
    g.fill();
  }
  return c;
}

/* ------------------------------------------------------------------- dusk */

/**
 * Dusk as it looks facing away from the setting Sun, with the full Moon — which
 * is always opposite the Sun — coming up in the middle of it.
 *
 * Low over that horizon lies the Earth's shadow, a band of slate blue, and
 * above it the Belt of Venus: rose where the last sunlight is scattered back,
 * shading through mauve into the shadow. Both climb as the Sun sinks, so the
 * whole arch rises and deepens through the run, and it is brightest around the
 * Moon, the anti-solar point, falling off to either side. Meanwhile the colour
 * drains from what is left of the day (see duskFilter) and a faint blue settles
 * over it. Every part is a gradient.
 *
 * Even the line: the shadow thickens into the night page's own colour over the
 * last few tens of pixels above it, so where the old page ends the new one is
 * already the colour it continues in. Left bare, the line was a ruled cut from
 * slate to near-black — the one hard thing in the picture.
 */
function duskScene(w, h, s) {
  // In its own units, the top of the arch at -300 and the line at 0; laid at
  // whatever height the arch has reached.
  const arch = bandSprite([
    [-300, 'rgba(250, 172, 184, 0)'],
    [-236, 'rgba(248, 168, 182, 0.13)'],
    [-176, 'rgba(244, 156, 178, 0.3)'],
    [-134, 'rgba(218, 146, 190, 0.32)'],
    [-102, 'rgba(150, 124, 180, 0.3)'],
    [-74, 'rgba(92, 98, 152, 0.36)'],
    [-32, 'rgba(64, 74, 130, 0.46)'],
    [0, 'rgba(48, 58, 112, 0.54)'],
  ]);
  // Into the night page's ground, darkest of its surfaces to lightest, which
  // lie between (1, 5, 14) and (5, 18, 33).
  const fringeH = Math.round(Math.min(72, Math.max(40, h * 0.08)));
  const fringe = bandSprite([
    [-fringeH, 'rgba(20, 30, 70, 0)'],
    [-Math.round(fringeH * 0.72), 'rgba(16, 26, 62, 0.12)'],
    [-Math.round(fringeH * 0.46), 'rgba(10, 20, 46, 0.38)'],
    [-Math.round(fringeH * 0.22), 'rgba(5, 14, 32, 0.72)'],
    [-Math.round(fringeH * 0.07), 'rgba(3, 12, 27, 0.9)'],
    [0, 'rgba(2, 11, 26, 0.97)'],
    // A hair past the line: the clip's antialiased edge let the old page's
    // last pale pixel through, a thin light thread along the whole cut.
    [3, 'rgba(2, 11, 26, 0.97)'],
  ]);
  const moon = risingMoon(w, h, s);
  // Strongest opposite the Sun, where the Moon is.
  const around = (x) => 0.7 + 0.36 * Math.exp(-(((x - moon.u) / 0.34) ** 2));

  return (ctx, p, raw, after) => {
    ctx.globalCompositeOperation = 'source-over';
    setMoonClip(s, p, w, h);
    const k = nightfall(raw);
    ctx.save();
    ctx.clip(moonClip);
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(30, 46, 108, ${(0.18 * k).toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    const height = h * 0.3 * (0.78 + 0.34 * smooth(0, 0.9, raw));
    drawBand(ctx, s, p, w, h, { canvas: arch.canvas, top: -height, bottom: 0 }, around);
    drawBand(ctx, s, p, w, h, fringe);
    const at = moon.place(p, raw, after);
    if (!at) return;
    moon.back(ctx, at);
    moon.disc(ctx, at);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  };
}

/**
 * The Moon itself is a photograph: the Lunar Reconnaissance Orbiter's mosaic
 * of the near side (NASA/GSFC/Arizona State University, public domain), lit
 * up to the flat brightness a full Moon has to the eye. Loaded with the page,
 * so it is in hand by the time anyone asks for night; if it is not, the Moon
 * is drawn instead of photographed.
 */
const moonPhoto = new Image();
moonPhoto.decoding = 'async';
moonPhoto.src = new URL('../img/moon-nearside-lro.jpg', import.meta.url).href;

/**
 * The Moon brings the night with it.
 *
 * It rises on the side of the line that is still day, and moonlight is no
 * light at all against a pale sky. So it does in reverse what the Sun does —
 * the Sun carries light into the dark, the Moon carries a pocket of night into
 * the day, deep blue around it and running down into the shadow below. Inside
 * that pocket its light shows: a cold halo, a bright bloom over its limb, and
 * the coloured rings of a lunar corona, as a bright Moon looks through the
 * thinnest haze.
 */
function risingMoon(w, h, s) {
  const m = Math.min(w, h);
  const R = m * 0.08;
  // East of the picture, clear of the findings column's text.
  const u = 0.7 + (Math.random() - 0.5) * 0.05;
  const x = w * u;
  const ready = moonPhoto.complete && moonPhoto.naturalWidth > 0;
  const disc = ready ? photoMoon(R) : paintMoon(R, [238, 240, 246]);
  const night = nightPocket(Math.round(R * 7));
  const wide = softDisc(256, 'rgba(170, 196, 255, 0.5)', 'rgba(170, 196, 255, 0)');
  const near = softDisc(128, 'rgba(240, 244, 255, 0.95)', 'rgba(240, 244, 255, 0)');
  const corona = coronaSprite(R);
  let lastY = null;

  const stamp = (ctx, img, cx, cy, rx, ry, a) => {
    if (a < 0.005) return;
    ctx.globalAlpha = Math.min(1, a);
    ctx.drawImage(img, cx - rx, cy - ry, rx * 2, ry * 2);
  };

  return {
    u,
    R,
    /** Where it rides: on the line itself, its lower edge just in the dark. */
    lift: 0.9 * R,
    /** Where it is: up out of the line, then riding it, then away over the top. */
    place(p, raw, after) {
      const lineY = edgeAt(s, u, p) * h;
      // From a radius below the line to sitting on it — its lower rim just in
      // the dark — over the first half of the run; then it rides the line.
      const clear = -1.1 + 2.0 * smooth(0.04, 0.5, raw); // ends at 0.9 radii: lift
      let y;
      if (after === 0) {
        y = lineY - clear * R;
        lastY = y;
      } else {
        y = lastY - after * (lastY + R * 7.5);
      }
      if (y < -R * 7) return null;
      return { x, y, clear, live: raw < 1, show: smooth(-1.1, -0.6, clear) * (1 - after * 0.3) };
    },
    /** The night it brings, and its light in the air around it. */
    back(ctx, { y, live, show }) {
      ctx.save();
      if (live) ctx.clip(moonClip);
      ctx.globalCompositeOperation = 'source-over';
      // Wider than tall, and sitting low, so it runs down into the shadow.
      const r = night.width / 2;
      stamp(ctx, night, x, y + R * 0.9, r * 1.45, r, show);
      ctx.globalCompositeOperation = 'lighter';
      stamp(ctx, wide, x, y, R * 5, R * 5, 0.55 * show);
      stamp(ctx, corona, x, y, corona.width / 2, corona.width / 2, 0.9 * show);
      stamp(ctx, near, x, y, R * 1.75, R * 1.75, 0.55 * show);
      ctx.restore();
    },
    disc(ctx, { y, live, show }) {
      ctx.save();
      if (live) ctx.clip(moonClip);
      ctx.globalCompositeOperation = 'source-over';
      stamp(ctx, disc, x, y, R, R, show * 1.4);
      // Moonlight is bright enough to spill over its own edge in any lens.
      ctx.globalCompositeOperation = 'lighter';
      stamp(ctx, near, x, y, R * 1.28, R * 1.28, 0.28 * show);
      ctx.restore();
    },
    spill(ctx, { y, show }) {
      ctx.save();
      ctx.clip(moonClip);
      ctx.globalCompositeOperation = 'lighter';
      stamp(ctx, near, x, y, R * 2.2, R * 2.2, 0.14 * show);
      ctx.restore();
    },
  };
}

/*
 * The side of the line still in day, as a reusable path, set once a frame so
 * the Moon, its night and the cloud all cut at exactly the same horizon.
 */
let moonClip = null;
function setMoonClip(s, p, w, h) {
  const path = new Path2D();
  path.moveTo(0, -60);
  path.lineTo(w, -60);
  for (let i = SEGMENTS; i >= 0; i--) {
    const x = i / SEGMENTS;
    path.lineTo(x * w, edgeAt(s, x, p) * h);
  }
  path.closePath();
  moonClip = path;
}

/** A pocket of night: deep blue in the middle, thinning to nothing at its rim. */
function nightPocket(r) {
  const c = makeCanvas(r * 2, r * 2);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(8, 14, 38, 0.94)');
  grad.addColorStop(0.22, 'rgba(10, 18, 46, 0.86)');
  grad.addColorStop(0.48, 'rgba(18, 28, 70, 0.5)');
  grad.addColorStop(0.75, 'rgba(40, 44, 100, 0.16)');
  grad.addColorStop(1, 'rgba(60, 60, 120, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, r * 2, r * 2);
  return c;
}

/**
 * A lunar corona: diffraction by the droplets of the thinnest cloud, seen as
 * a blue-white aureole hugging the Moon and a ring of warm brown-red outside
 * it, then a faint second ring of blue-green.
 */
function coronaSprite(R) {
  const r = Math.round(R * 2.6);
  const c = makeCanvas(r * 2, r * 2);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(r, r, R * 0.95, r, r, r);
  const at = (d) => (d * R - R * 0.95) / (r - R * 0.95);
  grad.addColorStop(0, 'rgba(210, 225, 255, 0.5)');
  grad.addColorStop(at(1.35), 'rgba(200, 215, 255, 0.22)');
  grad.addColorStop(at(1.62), 'rgba(255, 214, 160, 0.16)');
  grad.addColorStop(at(1.8), 'rgba(230, 150, 120, 0.14)');
  grad.addColorStop(at(2.0), 'rgba(120, 90, 140, 0.05)');
  grad.addColorStop(at(2.22), 'rgba(140, 220, 210, 0.07)');
  grad.addColorStop(at(2.45), 'rgba(160, 180, 255, 0.03)');
  grad.addColorStop(1, 'rgba(160, 180, 255, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, r * 2, r * 2);
  return c;
}

/**
 * The photograph, cut to its disc and lit as a full Moon is to the eye. The
 * mosaic was taken at low sun for relief; a full Moon is flat and bright, so
 * it is brightened, its contrast eased and its colour taken out.
 */
function photoMoon(R) {
  const scale = 2;
  const size = Math.round(R * 2 * scale);
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const r = size / 2;
  g.beginPath();
  g.arc(r, r, r, 0, TAU);
  g.clip();
  // The disc fills the frame but for a thin black margin, and a caption in a
  // corner the circle leaves out.
  const k = moonPhoto.naturalWidth / 960;
  // Silver with the faintest cream in it, which is the colour of a bright Moon
  // to the eye, not the neutral grey of the mosaic.
  g.filter = 'brightness(2.35) contrast(0.64) saturate(0) sepia(0.14)';
  g.drawImage(moonPhoto, 9 * k, 9 * k, 942 * k, 942 * k, 0, 0, size, size);
  g.filter = 'none';
  // The faintest darkening at the rim, which is what makes a disc a sphere.
  const rim = g.createRadialGradient(r, r, r * 0.7, r, r, r);
  rim.addColorStop(0, 'rgba(0, 0, 0, 0)');
  rim.addColorStop(1, 'rgba(0, 0, 10, 0.22)');
  g.fillStyle = rim;
  g.fillRect(0, 0, size, size);
  return c;
}

/** The drawn Moon, for when the photograph has not arrived. */
function paintMoon(R, [r, g, b]) {
  const pad = 2;
  const c = makeCanvas(R * 2 + pad * 2, R * 2 + pad * 2);
  const ctx = c.getContext('2d');
  const cx = R + pad;
  const cy = R + pad;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.clip();
  const base = ctx.createRadialGradient(cx - R * 0.12, cy - R * 0.12, 0, cx, cy, R);
  base.addColorStop(0, `rgb(${r}, ${g}, ${b})`);
  base.addColorStop(1, `rgb(${r * 0.84 | 0}, ${g * 0.82 | 0}, ${b * 0.82 | 0})`);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.filter = `blur(${Math.max(1.5, R * 0.1)}px)`;
  ctx.fillStyle = `rgba(${r * 0.58 | 0}, ${g * 0.58 | 0}, ${b * 0.62 | 0}, 0.62)`;
  for (const [u, v, ru, rv] of [[-0.56, -0.02, 0.3, 0.5], [-0.3, -0.44, 0.28, 0.2], [0.12, -0.4, 0.15, 0.14], [0.3, -0.1, 0.19, 0.17], [0.67, -0.28, 0.1, 0.12], [0.52, 0.2, 0.12, 0.17]]) {
    ctx.beginPath();
    ctx.ellipse(cx + u * R, cy + v * R, ru * R, rv * R, u * 0.6, 0, TAU);
    ctx.fill();
  }
  ctx.filter = 'none';
  return c;
}

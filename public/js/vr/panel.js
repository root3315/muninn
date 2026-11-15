/**
 * panel.js — a screen in the room: a canvas, drawn with the page's own type
 * and colours, on a flat rectangle facing the viewer.
 *
 * A screen is drawn only when what it says changes, and its texture is sent
 * to the GPU once per change, not once a frame. Whatever on it can be pressed
 * is recorded while it is drawn, as rectangles in canvas pixels, so a ray's
 * hit on the screen becomes a press without any arithmetic being repeated.
 */

import * as THREE from '../vendor/three.module.js';
import { resolveColor } from '../render.js';

/**
 * A screen `widthM` by `heightM` metres at `pxPerM` canvas pixels a metre, or
 * over a canvas someone else draws (`canvas`, e.g. the field's SkyView).
 * Returns `{ mesh, canvas, ctx, hits, draw(fn), dirty(), hitAt(uv), dispose() }`.
 */
export function createPanel({ widthM, heightM, pxPerM = 700, canvas = null, transparent = true, opaque = false, mipmaps = true, name = 'panel' }) {
  const own = !canvas;
  const cv = canvas ?? document.createElement('canvas');
  if (own) {
    cv.width = Math.round(widthM * pxPerM);
    cv.height = Math.round(heightM * pxPerM);
  }
  const ctx = own ? cv.getContext('2d') : null;
  const texture = new THREE.CanvasTexture(cv);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  // A screen that changes often (the field) goes up without a mip chain.
  texture.generateMipmaps = mipmaps;
  texture.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  // An opaque screen with rounded corners is cut by its alpha, not blended:
  // it draws in the opaque pass, front to back, and hides what is behind it.
  const blended = transparent && !opaque;
  const material = new THREE.MeshBasicMaterial({
    map: texture, transparent: blended, alphaTest: opaque ? 0.5 : 0, toneMapped: false, depthWrite: !blended,
  });
  const geometry = new THREE.PlaneGeometry(widthM, heightM);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.renderOrder = 10;

  const panel = {
    mesh,
    canvas: cv,
    ctx,
    widthM,
    heightM,
    /** What can be pressed: `{ x, y, w, h, id, ... }` in canvas pixels. */
    hits: [],
    /** Redraw: `fn(ctx, width, height, hits)` with the old hits cleared. */
    draw(fn) {
      if (ctx) {
        this.hits = [];
        ctx.save();
        ctx.clearRect(0, 0, cv.width, cv.height);
        const rec = recordLayout(ctx);
        try {
          fn(ctx, cv.width, cv.height, this.hits);
        } finally {
          rec.stop();
          ctx.restore();
        }
        this.layout = layoutIssues(rec.texts, this.hits, rec.plate(cv.width, cv.height));
        if (this.layout.length && LAYOUT_LOG) console.warn(`[layout] ${name}:`, this.layout.slice(0, 4).map((v) => v.what).join(' | '));
      }
      texture.needsUpdate = true;
    },
    /** What the last drawing got wrong: text or buttons over each other, or past the plate's edge. */
    layout: [],
    /** The canvas changed under it (drawn by someone else): send it again. */
    dirty() { texture.needsUpdate = true; },
    /** The pressable thing under a point of the screen, by its texture coordinate. */
    hitAt(uv) {
      const x = uv.x * cv.width;
      const y = (1 - uv.y) * cv.height;
      for (let i = this.hits.length - 1; i >= 0; i--) {
        const h = this.hits[i];
        if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
      }
      return null;
    },
    /** A point of the screen in canvas pixels. */
    toCanvas(uv) { return [uv.x * cv.width, (1 - uv.y) * cv.height]; },
    dispose() {
      livePanels.delete(panel);
      texture.dispose();
      material.dispose();
      geometry.dispose();
      mesh.removeFromParent();
      if (own) { cv.width = 0; cv.height = 0; }
    },
  };
  mesh.userData.panel = panel;
  livePanels.add(panel);
  return panel;
}

/* ------------------------------------------------------- the layout check */

/** Every panel alive, for the layout check. */
const livePanels = new Set();
/** Violations are said in the console on a local or diagnostic run. */
const LAYOUT_LOG = typeof location !== 'undefined'
  && (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || new URLSearchParams(location.search).has('diag'));
/** A box overlapping another by less than this many pixels is a touch, not an overlap. */
const SLACK = 2;

/**
 * While a panel draws: every line of text it writes, as the box its ink
 * covers on the canvas, and the largest rounded rectangle, taken for its plate.
 */
function recordLayout(ctx) {
  const texts = [];
  let plate = null;
  const fillText = ctx.fillText;
  const roundRectOf = ctx.roundRect;
  const { save, restore, clip } = ctx;
  // Text drawn under a clip (a rolling digit) is cut on purpose: not checked.
  const clipped = [false];
  ctx.save = function rec() { clipped.push(clipped.at(-1)); return save.call(this); };
  ctx.restore = function rec() { if (clipped.length > 1) clipped.pop(); return restore.call(this); };
  ctx.clip = function rec(...args) { clipped[clipped.length - 1] = true; return clip.apply(this, args); };
  ctx.fillText = function record(text, x, y, maxWidth) {
    const m = this.measureText(text);
    const t = this.getTransform();
    const scale = Math.hypot(t.a, t.b) || 1;
    const w = maxWidth != null ? Math.min(m.actualBoundingBoxRight + m.actualBoundingBoxLeft, maxWidth) : m.actualBoundingBoxRight + m.actualBoundingBoxLeft;
    if (String(text).trim() && t.b === 0 && t.c === 0 && !clipped.at(-1)) {
      texts.push({
        x: t.a * (x - m.actualBoundingBoxLeft) + t.e, y: t.d * (y - m.actualBoundingBoxAscent) + t.f,
        w: w * scale, h: (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) * scale, text: String(text),
      });
    }
    return fillText.call(this, text, x, y, maxWidth);
  };
  ctx.roundRect = function record(x, y, w, h, r) {
    const t = this.getTransform();
    const box = { x: t.a * x + t.e, y: t.d * y + t.f, w: w * t.a, h: h * t.d };
    if (!plate || box.w * box.h > plate.w * plate.h) plate = box;
    return roundRectOf.call(this, x, y, w, h, r);
  };
  return {
    texts,
    stop() { for (const k of ['fillText', 'roundRect', 'save', 'restore', 'clip']) delete ctx[k]; },
    /** The plate: the largest rounded rectangle if it covers a good part of the canvas, else the canvas. */
    plate: (W, H) => (plate && plate.w * plate.h > 0.3 * W * H ? plate : { x: 0, y: 0, w: W, h: H }),
  };
}

const overlaps = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > SLACK
  && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > SLACK;
const inside = (a, b) => a.x >= b.x - SLACK && a.y >= b.y - SLACK && a.x + a.w <= b.x + b.w + SLACK && a.y + a.h <= b.y + b.h + SLACK;

/**
 * Text and buttons over each other or past the plate: `{ what, a, b }` each.
 * A label inside its own button is not an overlap; nor is text drawn twice in
 * one place (a shadow), nor anything wholly inside another.
 */
export function layoutIssues(texts, hits, plate) {
  const boxes = [...texts.map((b) => ({ ...b, kind: 'text' })), ...hits.map((h) => ({ x: h.x, y: h.y, w: h.w, h: h.h, kind: 'button', text: `[${h.id}]` }))];
  const out = [];
  for (const b of boxes) {
    if (b.w <= 0 || b.h <= 0) continue;
    if (!inside(b, plate)) out.push({ what: `clipped: ${b.text.slice(0, 40)}`, a: b });
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (!overlaps(a, b) || inside(a, b) || inside(b, a)) continue;
      out.push({ what: `overlap: ${a.text.slice(0, 30)} × ${b.text.slice(0, 30)}`, a, b });
    }
  }
  return out;
}

/** For the checks: every live panel shown now that has a layout problem, by name. */
export function layoutReport({ shownOnly = true } = {}) {
  const out = [];
  for (const p of livePanels) {
    if (shownOnly && !shownInScene(p.mesh)) continue;
    if (p.layout.length) out.push({ name: p.mesh.name, issues: p.layout.map((v) => v.what) });
  }
  return out;
}

function shownInScene(o) {
  for (let n = o; n; n = n.parent) if (!n.visible) return false;
  return Boolean(o.parent);
}

/** Stand a screen at a pose from layout.js. */
export function placePanel(panel, { position, yaw, pitch }) {
  panel.mesh.position.set(position[0], position[1], position[2]);
  panel.mesh.rotation.set(pitch, yaw, 0, 'YXZ');
}

/* ------------------------------------------------------------- the look */

/** The page's tokens, read once the stylesheets are in: colours as CSS strings. */
export function readLook() {
  const css = getComputedStyle(document.documentElement);
  const pick = (token, fallback) => {
    const raw = css.getPropertyValue(token).trim();
    if (!raw) return fallback;
    try {
      const [r, g, b] = resolveColor(raw);
      return `rgb(${r}, ${g}, ${b})`;
    } catch {
      return fallback;
    }
  };
  return {
    well: pick('--color-well', '#0b0b14'),
    paper: pick('--color-paper', '#1b1b26'),
    paper2: pick('--color-paper-2', '#262634'),
    paper3: pick('--color-paper-3', '#30303f'),
    rule: pick('--color-rule', '#3a3a4c'),
    ruleStrong: pick('--color-rule-strong', '#6c6c86'),
    neutral: pick('--color-neutral', '#a3a3bc'),
    muted: pick('--color-muted', '#cfcfe0'),
    ink: pick('--color-ink', '#f1f1f8'),
    accent: pick('--color-accent', '#a9b6ff'),
    accentDim: pick('--color-accent-dim', '#7d89cc'),
    accentDeep: pick('--color-accent-deep', '#5a6299'),
    accentInk: pick('--color-accent-ink', '#141420'),
    counter: pick('--color-counter', '#f3c27a'),
    counterDim: pick('--color-counter-dim', '#c79a52'),
  };
}

export const FONTS = {
  display: '"Unbounded", ui-sans-serif, system-ui, sans-serif',
  body: '"Onest", ui-sans-serif, system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
};

/** The page's faces, loaded before anything is drawn with them. */
export async function loadFonts() {
  if (!document.fonts?.load) return;
  const faces = [
    `600 40px ${FONTS.display}`, `500 40px ${FONTS.display}`,
    `400 30px ${FONTS.body}`, `500 30px ${FONTS.body}`, `600 30px ${FONTS.body}`,
    `400 30px ${FONTS.mono}`, `500 30px ${FONTS.mono}`,
  ];
  // Cyrillic and Latin are separate files; ask for both.
  await Promise.race([
    Promise.all(faces.map((f) => document.fonts.load(f, 'Muninn Мунин 0123456789'))).then(() => document.fonts.ready),
    new Promise((resolve) => { setTimeout(resolve, 4000); }),
  ]).catch(() => {});
}

/** A rounded rectangle as a path. */
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

/**
 * Text broken into lines no wider than `maxW`, at most `maxLines` (the last
 * one ending in an ellipsis if cut). Draws them from `y` down; returns the y
 * under the last line.
 */
export function wrapText(ctx, text, x, y, maxW, lineH, maxLines = 99) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= maxW || !line) line = next;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    let last = shown[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    shown[maxLines - 1] = `${last}…`;
  }
  for (const l of shown) { ctx.fillText(l, x, y); y += lineH; }
  return y;
}

let measureCtx = null;
/**
 * Text broken into at most `maxLines` lines no wider than `maxW` in `font`,
 * without drawing it: for sizing a label to its words before it is made.
 */
export function wrapLines(font, text, maxW, maxLines = 99) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (measureCtx.measureText(next).width <= maxW || !line) line = next;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fitText(measureCtx, `${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, maxW);
    return kept;
  }
  return lines;
}

/** How wide a chip must be for its word: the text and most of a height of room, never under `minPx`. */
export function chipWidth(ctx, font, label, h, minPx) {
  ctx.font = font;
  return Math.max(minPx, Math.ceil(ctx.measureText(label).width + 0.9 * h));
}

/** One line cut to fit `maxW`, with an ellipsis if it had to be. */
export function fitText(ctx, text, maxW) {
  let s = String(text ?? '');
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

/**
 * A button: a rounded chip with a label, recorded as pressable. `on` is the
 * pressed state, `hover` the pointed-at one.
 */
export function button(ctx, hits, look, { x, y, w, h, label, id, on = false, hover = false, font, data, tone = null }) {
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = on ? look.accent : hover ? look.paper3 : look.paper2;
  if (tone && !on) ctx.fillStyle = hover ? look.paper3 : look.paper2;
  ctx.fill();
  if (!on) {
    ctx.lineWidth = Math.max(2, h * 0.04);
    ctx.strokeStyle = hover ? look.accent : look.rule;
    ctx.stroke();
  }
  ctx.fillStyle = on ? look.accentInk : tone ? look[tone] : look.ink;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // A control's word is never cut: one that does not fit goes on two lines,
  // a size smaller if it must.
  const room = w - h * 0.5;
  if (ctx.measureText(label).width <= room) {
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
  } else {
    const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? '30');
    let px = size;
    let lines = [];
    for (; px >= size * 0.7; px -= 1) {
      ctx.font = font.replace(/\d+(?:\.\d+)?px/, `${px}px`);
      lines = wrapLines(ctx.font, label, room, 2);
      if (lines.every((l) => ctx.measureText(l).width <= room) && lines.length <= 2 && px * 1.1 * lines.length <= h) break;
    }
    lines.forEach((l, k) => ctx.fillText(l, x + w / 2, y + h / 2 + 1 + (k - (lines.length - 1) / 2) * px * 1.05));
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  hits.push({ x, y, w, h, id, data });
}

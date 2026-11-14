/**
 * card.js — one small card in the room, for whatever was just pointed at and
 * chosen: a star on the sky, a point of empty sky, an object in the field's
 * depth, a mark on the field. It says what the thing is and where the number
 * comes from, and carries a button or two ("Open field here", "Close").
 *
 * One card at a time; a new choice redraws it where the new thing is.
 *
 *   createCard({ look }) -> { mesh, show(content, at, head), hide(), dispose() }
 *
 * `content` is { title, lines: [{ text, tone }], actions: [{ id, label, run }] };
 * `at` is where it stands (a world point), `head` what it turns to face.
 */

import * as THREE from '../vendor/three.module.js';
import { createPanel, FONTS, wrapLines, button, roundRect, chipWidth } from './panel.js';
import { minTextPx } from './layout.js';
import { tv } from './strings.js';

const W_M = 0.95;
const H_M = 0.8;
const PX_PER_M = 640;
const DIST = 2.0;

export function createCard({ look }) {
  const panel = createPanel({ widthM: W_M, heightM: H_M, pxPerM: PX_PER_M, name: 'card-pop' });
  panel.mesh.visible = false;
  // Over everything: it is what was just asked for.
  panel.mesh.renderOrder = 100;
  panel.mesh.material.depthTest = false;
  const px = minTextPx(PX_PER_M, DIST);
  let content = null;
  let hover = null;

  function draw() {
    if (!content) return;
    panel.draw((ctx, W, H, hits) => {
      const pad = 28;
      const w = W - pad * 2;
      const titleFont = `600 ${Math.round(px * 1.15)}px ${FONTS.display}`;
      const lineFont = (l) => `400 ${px}px ${l.mono ? FONTS.mono : FONTS.body}`;
      // The buttons first: each as wide as its word, never wider than the
      // plate's inside, in rows that wrap; the plate is then made to fit
      // the words and the rows, with room all round.
      const bh = Math.round(px * 1.55);
      const gap = 14;
      const font = `500 ${px}px ${FONTS.body}`;
      const actions = [...(content.actions ?? []), { id: 'close', label: tv('vr.close'), run: () => hide() }];
      const rows = [[]];
      let used = 0;
      for (const a of actions) {
        const bw = Math.min(w, chipWidth(ctx, font, a.label, bh, 0.09 * PX_PER_M));
        if (rows.at(-1).length && used + gap + bw > w) { rows.push([]); used = 0; }
        used += (rows.at(-1).length ? gap : 0) + bw;
        rows.at(-1).push({ ...a, bw });
      }
      const titleLines = wrapLines(titleFont, content.title, w, 3);
      const bodyLines = content.lines.map((l) => wrapLines(lineFont(l), l.text, w, 6));
      const textH = titleLines.length * px * 1.3 + 6 + bodyLines.reduce((n, ls) => n + ls.length * px * 1.25 + 2, 0);
      const Hc = Math.min(H, Math.ceil(pad + px + textH + 10 + rows.length * (bh + gap) - gap + pad));
      roundRect(ctx, 2, 2, W - 4, Hc - 4, 26);
      ctx.fillStyle = look.paper;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = look.accent;
      ctx.stroke();
      let y = pad + px;
      ctx.fillStyle = look.ink;
      ctx.font = titleFont;
      for (const l of titleLines) { ctx.fillText(l, pad, y); y += px * 1.3; }
      y += 6;
      content.lines.forEach((l, k) => {
        ctx.font = lineFont(l);
        ctx.fillStyle = look[l.tone ?? 'muted'] ?? look.muted;
        for (const t of bodyLines[k]) { ctx.fillText(t, pad, y); y += px * 1.25; }
        y += 2;
      });
      let by = Hc - pad - rows.length * (bh + gap) + gap;
      for (const row of rows) {
        let bx = pad;
        for (const a of row) {
          button(ctx, hits, look, { x: bx, y: by, w: a.bw, h: bh, label: a.label, id: a.id, font, hover: hover === a.id, on: a.primary });
          bx += a.bw + gap;
        }
        by += bh + gap;
      }
      content.run = Object.fromEntries(actions.map((a) => [a.id, a.run]));
    });
  }

  function hide() {
    panel.mesh.visible = false;
    content = null;
  }

  panel.mesh.userData.hover = (uv) => {
    const h = uv ? panel.hitAt(uv)?.id ?? null : null;
    if (h !== hover) { hover = h; draw(); }
  };
  panel.mesh.userData.pick = (uv) => { const h = panel.hitAt(uv); if (h) content?.run?.[h.id]?.(); };
  panel.mesh.userData.pickable = (uv) => Boolean(panel.hitAt(uv));

  return {
    mesh: panel.mesh,
    /** Show `c` at `at`, turned to `head`. */
    show(c, at, head) {
      content = c;
      hover = null;
      draw();
      // A little nearer than the thing it is about, so it reads in front of it.
      const dir = at.clone().sub(head);
      const pos = head.clone().addScaledVector(dir.normalize(), DIST);
      panel.mesh.position.copy(pos);
      panel.mesh.lookAt(head);
      panel.mesh.visible = true;
    },
    hide,
    get visible() { return panel.mesh.visible; },
    dispose() { panel.dispose(); },
  };
}

/** Light-travel time, as words: minutes, hours, years, or millions or billions of years. */
export function lightTime(au, { lookbackGyr = null } = {}) {
  if (lookbackGyr != null) return lookbackGyr >= 1 ? tv('vr.lightGyr', { n: lookbackGyr.toFixed(1) }) : tv('vr.lightMyr', { n: Math.round(lookbackGyr * 1000) });
  const minutes = au * 8.3167;
  if (minutes < 120) return tv('vr.lightMin', { n: minutes.toFixed(minutes < 10 ? 1 : 0) });
  const hours = minutes / 60;
  if (hours < 48) return tv('vr.lightHours', { n: hours.toFixed(1) });
  const years = au / 63241.08;
  return years < 1e5 ? tv('vr.lightYears', { n: years < 10 ? years.toFixed(2) : Math.round(years).toLocaleString('en-US') })
    : tv('vr.lightMyr', { n: (years / 1e6).toFixed(years < 1e7 ? 2 : 0) });
}

export { THREE };

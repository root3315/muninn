/**
 * pagespanel.js — a short text read a page at a time, in the headset: the
 * five-step guide, and the site's own "How to read this" cards.
 *
 *   createPagesPanel({ look, widthM, heightM, pxPerM, dist, onClose })
 *     -> { mesh, show(title, pages, index), hide(), visible, dispose() }
 *
 * `pages` is [{ heading, text }]; ‹ and › turn them, "Close" puts it away.
 */
import { createPanel, FONTS, wrapLines, button, roundRect, chipWidth } from './panel.js';
import { minTextPx } from './layout.js';
import { tv } from './strings.js';

export function createPagesPanel({ look, widthM, heightM, pxPerM, dist, onClose = () => {} }) {
  const panel = createPanel({ widthM, heightM, pxPerM, name: 'pages', opaque: true });
  panel.mesh.visible = false;
  const px = minTextPx(pxPerM, dist);
  let state = null;
  let hover = null;

  function draw() {
    if (!state) return;
    panel.draw((ctx, W, H, hits) => {
      const pad = 34;
      const w = W - pad * 2;
      const page = state.pages[state.index];
      const font = `500 ${px}px ${FONTS.body}`;
      const bh = Math.round(px * 1.8);
      const small = Math.round(px * 0.85);
      const headFont = `600 ${Math.round(px * 1.35)}px ${FONTS.display}`;
      const bodyFont = `400 ${px}px ${FONTS.body}`;
      const head = wrapLines(headFont, page.heading, w, 3);
      const body = wrapLines(bodyFont, page.text, w, 99);
      const lh = Math.round(px * 1.32);
      const textH = small * 2 + head.length * Math.round(px * 1.5) + 14 + body.length * lh;
      const Hc = Math.min(H, Math.ceil(pad + textH + 24 + bh + pad));
      panel.used = Hc / H;
      roundRect(ctx, 2, 2, W - 4, Hc - 4, 26);
      ctx.fillStyle = look.paper;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = look.accent;
      ctx.stroke();
      let y = pad + small;
      ctx.font = `500 ${small}px ${FONTS.mono}`;
      ctx.fillStyle = look.neutral;
      ctx.fillText(`${state.title} · ${state.index + 1} / ${state.pages.length}`, pad, y);
      y += small + Math.round(px * 1.4);
      ctx.font = headFont;
      ctx.fillStyle = look.ink;
      for (const l of head) { ctx.fillText(l, pad, y); y += Math.round(px * 1.5); }
      y += 4;
      ctx.font = bodyFont;
      ctx.fillStyle = look.muted;
      for (const l of body) { ctx.fillText(l, pad, y); y += lh; }
      // Back, on, and away, along the bottom of the plate.
      const by = Hc - pad - bh;
      const close = tv('vr.close');
      const cw = chipWidth(ctx, font, close, bh, 0.09 * pxPerM);
      button(ctx, hits, look, { x: W - pad - cw, y: by, w: cw, h: bh, label: close, id: 'close', font, hover: hover === 'close' });
      const sw = Math.round(bh * 1.6);
      if (state.index > 0) button(ctx, hits, look, { x: pad, y: by, w: sw, h: bh, label: '‹', id: 'prev', font, hover: hover === 'prev' });
      if (state.index < state.pages.length - 1) {
        button(ctx, hits, look, { x: pad + sw + 12, y: by, w: sw, h: bh, label: '›', id: 'next', font, hover: hover === 'next', on: true });
      }
    });
  }

  function hide() {
    panel.mesh.visible = false;
    state = null;
    onClose();
  }

  panel.mesh.userData.hover = (uv) => {
    const h = uv ? panel.hitAt(uv)?.id ?? null : null;
    if (h !== hover) { hover = h; draw(); }
  };
  panel.mesh.userData.pick = (uv) => {
    const h = panel.hitAt(uv)?.id;
    if (!h || !state) return;
    if (h === 'close') { hide(); return; }
    state.index = Math.max(0, Math.min(state.pages.length - 1, state.index + (h === 'next' ? 1 : -1)));
    draw();
  };
  panel.mesh.userData.pickable = (uv) => Boolean(panel.hitAt(uv));
  panel.mesh.userData.solid = (uv) => uv.y >= 1 - (panel.used ?? 1);

  return {
    mesh: panel.mesh,
    show(title, pages, index = 0) {
      state = { title, pages, index };
      hover = null;
      panel.mesh.visible = true;
      draw();
    },
    hide,
    get visible() { return panel.mesh.visible; },
    dispose() { panel.dispose(); },
  };
}

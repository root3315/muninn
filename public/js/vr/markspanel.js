/**
 * markspanel.js — the marks made on a field, in the headset: the same list
 * the site keeps beside its plate, numbered, the newest open and the rest
 * folded to a line. Every word comes from marks.js, as on the site; this only
 * lays them out on a screen and says which button was pressed.
 *
 *   createMarksPanel({ look, widthM, heightM, pxPerM, dist, onAct })
 *     -> { mesh, render(view), hover(uv), dispose() }
 *
 * `view` is { marks, visits, undo, target, bright (brightstars.js) }; `onAct(id, index)`
 * gets fold, remove, link, arc, jump, spectrum, retry, clear, undo, up, down.
 */
import { createPanel, FONTS, wrapLines, button, roundRect, chipWidth } from './panel.js';
import { minTextPx } from './layout.js';
import { tv } from './strings.js';
import {
  markCall, verdict, sharpWords, saturatedMotion, skybotLine, STILL, whoWords, predictedWords,
  brightnessWords, peaksOf, linkWords, brightNeighbourWords,
} from '../marks.js';
import { formatRA, formatDec } from '../catalog.js';
import { fmtDate } from '../i18n.js';

/** Who-asking is in flight: the line gets a dot that pulses. */
const ASKING = Symbol('asking');

export function createMarksPanel({ look, widthM, heightM, pxPerM, dist, onAct }) {
  const panel = createPanel({ widthM, heightM, pxPerM, name: 'marks', opaque: true });
  const px = minTextPx(pxPerM, dist);
  const small = Math.round(px * 0.82);
  const pad = 26;
  let last = null;
  let hover = null;
  let scroll = 0;

  /** The lines and buttons one mark puts on the screen, as the site lays them out. */
  function blocks(m, i, view) {
    const a = m.analysis;
    const predicted = predictedWords(m);
    let call = a ? markCall(a, tv) : tv('mark.measuring');
    let detail = a ? verdict(a) : tv('mark.measuringWhy');
    if (predicted) { call = predicted.call; detail = predicted.detail; }
    const out = { n: i + 1, call, kind: predicted ? 'predicted' : a?.kind ?? 'none', open: m.open !== false, lines: [] };
    const brief = m.tag && m.tag !== call ? m.tag : detail;
    if (!out.open) { out.lines.push({ text: brief, tone: 'muted' }); return out; }
    const L = out.lines;
    L.push({ text: detail, tone: 'ink' });
    const shape = sharpWords(a);
    if (shape) L.push({ text: shape.text, tone: shape.verdict === 'sharp' ? 'counter' : 'muted' });
    const motion = saturatedMotion(m, view.target);
    if (motion) L.push({ text: motion, tone: 'muted' });
    // Near a naked-eye star, its stray light and ghosts are a likelier cause (marks.js, as on the site).
    const neighbour = brightNeighbourWords(m, view.bright ?? []);
    if (neighbour) L.push({ text: neighbour, tone: 'muted' });

    const who = [];
    if (!STILL.has(a?.kind)) who.push({ text: predicted ? predicted.id : skybotLine(m.catalog, view.visits), tone: m.catalog?.state === 'match' ? 'counter' : 'muted' });
    if (m.who) {
      for (const w of whoWords(m.who, a?.kind)) {
        who.push(w.asking
          ? { text: w.text, tone: 'neutral', [ASKING]: true }
          : { text: w.parts.map((x) => (typeof x === 'string' ? x : x.text)).join(''), tone: 'muted' });
      }
    }
    if (who.length) { L.push({ key: tv('mark.kWho') }); L.push(...who); }
    const failed = m.who && (m.who.state === 'failed' || m.who.state === 'timeout' || m.who.result?.failed?.length);
    if (failed) L.push({ buttons: [{ id: 'retry', label: tv('vr.markAskAgain') }] });

    const light = [];
    if (a?.seen && view.visits.length > 1) light.push({ curve: true });
    const b = brightnessWords(a);
    if (b) light.push({ text: b, tone: 'muted' });
    if (light.length) { L.push({ key: tv('mark.kLight') }); L.push(...light); }
    L.push({ key: tv('mark.kWhere') });
    L.push({ text: `${formatRA(m.ra)} ${formatDec(m.dec)}`, tone: 'muted', mono: true });

    // The season link, unless SkyBoT has named a body here: that one moves too fast for any arc.
    const acts = [{ id: 'spectrum', label: tv('vr.markSpectrum') }];
    if (!m.known && m.link?.state !== 'reading') {
      acts.unshift({ id: 'link', label: tv(m.link && m.link.state !== 'single' ? 'link.again' : 'link.run') });
    }
    L.push({ buttons: acts });
    if (m.link) {
      for (const w of linkWords(m.link)) L.push({ text: w.text, tone: w.tone === 'counter' ? 'counter' : w.tone === 'quiet' ? 'neutral' : w.tone === 'wait' ? 'neutral' : 'muted' });
      if (m.link.state === 'done' && !m.link.result.star) {
        const more = [{ id: 'arc', label: tv(m.link.shown ? 'link.hideArc' : 'link.showArc') }];
        if (m.link.loadedB && view.visits.includes(m.link.loadedB)) more.push({ id: 'jump', label: tv('link.jump', { date: fmtDate(m.link.loadedB.frame.iso) }) });
        L.push({ buttons: more });
      }
    }
    return out;
  }

  /** The light curve: a bar per visit by its peak, a tick where nothing rose above the noise. */
  function curve(ctx, m, visits, x, y, w, h) {
    const peakOf = peaksOf(m.analysis);
    const max = Math.max(...peakOf.values(), 1e-6);
    const mjds = visits.map((v) => v.frame.mjd);
    const lo = Math.min(...mjds);
    const span = (Math.max(...mjds) - lo) || 1;
    const base = y + h - 8;
    ctx.strokeStyle = look.rule;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, base);
    ctx.lineTo(x + w, base);
    ctx.stroke();
    for (const v of visits) {
      const bx = x + 6 + ((v.frame.mjd - lo) / span) * (w - 12);
      const peak = peakOf.get(v.frame.obsId);
      if (peak == null) {
        ctx.fillStyle = look.neutral;
        ctx.fillRect(bx - 1, base, 2, 8);
        continue;
      }
      const bh = Math.max(4, Math.sqrt(peak / max) * (h - 16));
      ctx.fillStyle = look.accent;
      roundRect(ctx, bx - 5, base - bh, 10, bh, 4);
      ctx.fill();
    }
  }

  function render(view) {
    last = view;
    panel.draw((ctx, W, H, hits) => {
      const w = W - pad * 2;
      const head = `600 ${Math.round(px * 1.2)}px ${FONTS.display}`;
      const callFont = `600 ${Math.round(px * 1.05)}px ${FONTS.display}`;
      const body = (mono) => `400 ${px}px ${mono ? FONTS.mono : FONTS.body}`;
      const chipFont = `500 ${px}px ${FONTS.body}`;
      const bh = Math.round(px * 1.55);
      const lh = Math.round(px * 1.28);

      // Everything first as a list of things to draw, with heights; then the
      // plate to fit, cut to the screen with a way to scroll.
      const items = [];
      for (const [i, m] of view.marks.entries()) {
        const b = blocks(m, i, view);
        const textW = w - 64 - (bh * 2 + 24);
        items.push({ type: 'call', b, h: Math.round(px * 1.5) + 6, lines: wrapLines(callFont, b.call, textW, 2) });
        items.at(-1).h = items.at(-1).lines.length * Math.round(px * 1.3) + 10;
        for (const l of b.lines) {
          if (l.key) items.push({ type: 'key', text: l.key.toUpperCase(), h: Math.round(small * 1.9) });
          else if (l.curve) items.push({ type: 'curve', m, h: Math.round(px * 1.9) });
          else if (l.buttons) {
            // As many rows as the buttons need, each as wide as its word.
            let x = pad + 64;
            let rows = 1;
            for (const btn of l.buttons) {
              const bw = Math.min(w - 64, chipWidth(ctx, chipFont, btn.label, bh, 0.09 * pxPerM));
              if (x > pad + 64 && x + bw > W - pad) { rows += 1; x = pad + 64; }
              x += bw + 12;
            }
            items.push({ type: 'buttons', list: l.buttons, i, h: rows * (bh + 10) + 4 });
          }
          else {
            const lines = wrapLines(body(l.mono), l.text, w - 64 - (l[ASKING] ? 26 : 0), b.open ? 12 : 3);
            items.push({ type: 'text', l, lines, h: lines.length * lh + 6 });
          }
        }
        items.push({ type: 'gap', h: 18 });
      }
      const topH = Math.round(px * 1.2) + bh;
      const content = items.reduce((s, it) => s + it.h, 0);
      const room = H - topH - pad * 2 - bh - 12;
      const scrolls = content > room;
      const maxScroll = Math.max(0, content - room);
      scroll = Math.min(Math.max(0, scroll), maxScroll);
      const plateH = Math.min(H, topH + pad * 2 + Math.min(content, room) + (scrolls ? bh + 16 : 0));

      roundRect(ctx, 2, 2, W - 4, plateH - 4, 24);
      ctx.fillStyle = look.paper;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = look.ruleStrong;
      ctx.stroke();

      // The heading, with the count, and clearing all of them (taken back for a few seconds).
      ctx.font = head;
      ctx.fillStyle = look.ink;
      ctx.fillText(`${tv('vr.marksTitle')} · ${view.marks.length}`, pad, pad + px);
      const clearLabel = view.undo ? tv('mark.undo') : tv('mark.clear');
      const cw = chipWidth(ctx, chipFont, clearLabel, bh, 0.09 * pxPerM);
      button(ctx, hits, look, { x: W - pad - cw, y: pad - 6, w: cw, h: bh, label: clearLabel, id: view.undo ? 'undo' : 'clear', font: chipFont, hover: hover === (view.undo ? 'undo' : 'clear') });

      const top = pad + topH;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top - 4, W, Math.min(content, room) + 4);
      ctx.clip();
      let y = top - scroll;
      const visible = (h) => y + h > top - 4 && y < top + room + 4;
      for (const it of items) {
        if (visible(it.h)) {
          if (it.type === 'call') {
            const { b } = it;
            const i = b.n - 1;
            // The number, as on the plate.
            ctx.beginPath();
            ctx.arc(pad + 22, y + px * 0.62, 22, 0, Math.PI * 2);
            ctx.fillStyle = b.kind === 'moving' || b.kind === 'transient' ? look.counter : look.accent;
            ctx.fill();
            ctx.fillStyle = look.accentInk;
            ctx.font = `600 ${Math.round(px * 0.8)}px ${FONTS.mono}`;
            ctx.textAlign = 'center';
            ctx.fillText(String(b.n), pad + 22, y + px * 0.62 + px * 0.28);
            ctx.textAlign = 'left';
            ctx.font = callFont;
            ctx.fillStyle = b.kind === 'moving' || b.kind === 'transient' || b.kind === 'predicted' ? look.counter : look.ink;
            it.lines.forEach((l, k) => ctx.fillText(l, pad + 64, y + px * 0.95 + k * Math.round(px * 1.3)));
            // Fold and remove, at the line's end, drawn as marks rather than letters.
            const fx = W - pad - bh * 2 - 12;
            for (const [id, x] of [['fold', fx], ['remove', fx + bh + 12]]) {
              button(ctx, hits, look, { x, y: y - 4, w: bh, h: bh, label: '', id, data: i, font: chipFont, hover: hover === `${id}:${i}` });
              ctx.strokeStyle = look.ink;
              ctx.lineWidth = 4;
              ctx.lineCap = 'round';
              ctx.beginPath();
              const cx = x + bh / 2;
              const cy = y - 4 + bh / 2;
              const r = bh * 0.2;
              if (id === 'remove') {
                ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
                ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
              } else if (b.open) {
                ctx.moveTo(cx - r, cy + r * 0.5); ctx.lineTo(cx, cy - r * 0.5); ctx.lineTo(cx + r, cy + r * 0.5);
              } else {
                ctx.moveTo(cx - r, cy - r * 0.5); ctx.lineTo(cx, cy + r * 0.5); ctx.lineTo(cx + r, cy - r * 0.5);
              }
              ctx.stroke();
            }
          } else if (it.type === 'key') {
            ctx.font = `600 ${small}px ${FONTS.mono}`;
            ctx.fillStyle = look.neutral;
            ctx.fillText(it.text, pad + 64, y + small * 1.3);
          } else if (it.type === 'curve') {
            curve(ctx, it.m, view.visits, pad + 64, y, Math.min(w - 64, 420), it.h);
          } else if (it.type === 'buttons' && (y < top - 4 || y + it.h > top + room + 4)) {
            // A row of buttons is shown whole or not at all: half a button cannot be pressed.
          } else if (it.type === 'buttons') {
            let x = pad + 64;
            let by = y;
            for (const btn of it.list) {
              const bw = Math.min(w - 64, chipWidth(ctx, chipFont, btn.label, bh, 0.09 * pxPerM));
              if (x > pad + 64 && x + bw > W - pad) { x = pad + 64; by += bh + 10; }
              button(ctx, hits, look, { x, y: by, w: bw, h: bh, label: btn.label, id: btn.id, data: it.i, font: chipFont, hover: hover === `${btn.id}:${it.i}` });
              x += bw + 12;
            }
          } else if (it.type === 'text') {
            const { l } = it;
            let x = pad + 64;
            if (l[ASKING]) {
              const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
              ctx.globalAlpha = 0.4 + 0.6 * pulse;
              ctx.fillStyle = look.accent;
              ctx.beginPath();
              ctx.arc(x + 8, y + px * 0.6, 7, 0, Math.PI * 2);
              ctx.fill();
              ctx.globalAlpha = 1;
              x += 26;
            }
            ctx.font = body(l.mono);
            ctx.fillStyle = look[l.tone] ?? look.muted;
            it.lines.forEach((t, k) => ctx.fillText(t, x, y + px * 0.95 + k * lh));
          }
        }
        y += it.h;
      }
      ctx.restore();
      // Hits under the cut are not there.
      for (let k = hits.length - 1; k >= 0; k--) {
        const h = hits[k];
        if (h.id !== 'clear' && h.id !== 'undo' && (h.y < top - 4 || h.y + h.h > top + room)) hits.splice(k, 1);
      }
      if (scrolls) {
        // A rule between the list and the scroll, so a half-shown line reads as cut, not as the end.
        ctx.strokeStyle = look.rule;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pad, top + room + 6);
        ctx.lineTo(W - pad, top + room + 6);
        ctx.stroke();
        const sy = top + room + 14;
        const sw = Math.round(bh * 2.2);
        button(ctx, hits, look, { x: W - pad - sw * 2 - 12, y: sy, w: sw, h: bh, label: '↑', id: 'up', font: chipFont, hover: hover === 'up:' });
        button(ctx, hits, look, { x: W - pad - sw, y: sy, w: sw, h: bh, label: '↓', id: 'down', font: chipFont, hover: hover === 'down:' });
        ctx.font = `400 ${small}px ${FONTS.mono}`;
        ctx.fillStyle = look.neutral;
        ctx.fillText(`${Math.round((scroll / maxScroll) * 100)}%`, pad, sy + bh * 0.68);
      }
      panel.used = plateH / H;
    });
  }

  panel.mesh.userData.hover = (uv) => {
    const h = uv ? panel.hitAt(uv) : null;
    const id = h ? `${h.id}:${h.data ?? ''}` : null;
    if (id !== hover) { hover = id; if (last) render(last); }
  };
  panel.mesh.userData.pick = (uv) => {
    const h = panel.hitAt(uv);
    if (!h) return;
    if (h.id === 'up' || h.id === 'down') {
      scroll += (h.id === 'up' ? -1 : 1) * Math.round(panel.canvas.height * 0.4);
      if (last) render(last);
      return;
    }
    onAct(h.id, h.data);
  };
  panel.mesh.userData.pickable = (uv) => Boolean(panel.hitAt(uv));
  panel.mesh.userData.solid = (uv) => uv.y >= 1 - (panel.used ?? 1);

  return {
    mesh: panel.mesh,
    render,
    /** Back to the top of the list, where a new mark is. */
    reveal() { scroll = 0; },
    /** Whether something on it moves (the asking dot), so it is redrawn each beat. */
    get animated() { return Boolean(last?.marks.some((m) => m.who?.state === 'asking' && m.open !== false)); },
    dispose() { panel.dispose(); },
  };
}

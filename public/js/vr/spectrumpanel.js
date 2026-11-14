/**
 * spectrumpanel.js — the spectrum of a mark, across every visit read.
 *
 * SPHEREx's filter changes wavelength across the detector, so the same point
 * of sky lands at a different wavelength in each visit: the brightness of a
 * mark visit by visit, set against the wavelength each visit saw it at, is a
 * spectrum. The measurement is the site's (sky.js measure, spectrum.js
 * visitPoint); the wavelength is read from each file's own table
 * (stamp.js loadWavelength). Detections are dots with their error, the
 * visits that saw nothing are upper limits, drawn as arrows down; each point
 * in its band's hue.
 *
 *   createSpectrumPanel({ look }) -> { mesh, show({ ra, dec, visits, sky, signal }), hide(), dispose() }
 */

import { createPanel, FONTS, wrapText, wrapLines, button, roundRect, chipWidth } from './panel.js';
import { loadWavelength } from '../stamp.js';
import { toS3, formatRA, formatDec } from '../catalog.js';
import { visitPoint, fluxAxis, placeInBand } from '../spectrum.js';
import { fmt } from '../i18n.js';
import { minTextPx, SCREENS } from './layout.js';
import { tv } from './strings.js';

const { w: W_M, h: H_M, dist: DIST } = SCREENS.spectrum;
const PX_PER_M = 760;
/** SPHEREx's range, µm, and its six bands' hues (redesign.css --hue-d1 … d6). */
const RANGE = [0.7, 5.1];
const HUES = { D1: 285, D2: 235, D3: 160, D4: 100, D5: 60, D6: 25 };

export function createSpectrumPanel({ look }) {
  const panel = createPanel({ widthM: W_M, heightM: H_M, pxPerM: PX_PER_M, name: 'spectrum', opaque: true });
  panel.mesh.visible = false;
  const px = minTextPx(PX_PER_M, DIST);
  let state = null;
  let hover = null;
  let job = 0;

  function draw() {
    if (!state) return;
    panel.draw((ctx, W, H, hits) => {
      roundRect(ctx, 2, 2, W - 4, H - 4, 24);
      ctx.fillStyle = look.paper;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = look.ruleStrong;
      ctx.stroke();
      const x0 = 30;
      // The close button, top right; the title wraps short of it.
      const font = `500 ${px}px ${FONTS.body}`;
      const bh = Math.round(px * 1.7);
      const bw = chipWidth(ctx, font, tv('vr.close'), bh, 70);
      button(ctx, hits, look, { x: W - bw - 24, y: 20, w: bw, h: bh, label: tv('vr.close'), id: 'close', font, hover: hover === 'close' });
      const titleFont = `600 ${Math.round(px * 1.1)}px ${FONTS.display}`;
      const title = wrapLines(titleFont, tv('vr.spectrumTitle'), W - bw - 24 - x0 - 24, 2);
      ctx.fillStyle = look.ink;
      ctx.font = titleFont;
      let y = 26 + px;
      for (const l of title) { ctx.fillText(l, x0, y); y += Math.round(px * 1.3); }
      ctx.font = `400 ${Math.round(px * 0.9)}px ${FONTS.mono}`;
      ctx.fillStyle = look.neutral;
      ctx.fillText(`${formatRA(state.ra)}  ${formatDec(state.dec)}`, x0, y);

      const pts = state.points.filter((p) => p.um && p.pt && p.pt.kind !== 'saturated');
      // The legend under the chart, wrapped; the chart takes the room between.
      const legendFont = `400 ${Math.round(px * 0.85)}px ${FONTS.body}`;
      const legend = wrapLines(legendFont, tv('vr.spectrumLegend', { n: pts.length, total: state.total }), W - x0 * 2, 2);
      const legendH = legend.length * Math.round(px * 1.15);
      const top = y + px;
      const box = { x: 110, y: top, w: W - 150, h: H - top - legendH - px * 2.6 - 20 };
      if (!pts.length) {
        ctx.font = `400 ${px}px ${FONTS.body}`;
        ctx.fillStyle = look.muted;
        wrapText(ctx, state.done < state.total ? tv('vr.spectrumWait', { done: state.done, total: state.total }) : tv('vr.spectrumNone'), x0, box.y + px, W - x0 * 2, px * 1.3, 4);
        return;
      }
      const axis = fluxAxis(pts.map((p) => p.pt));
      if (!axis) return;
      const X = (um) => box.x + ((um - RANGE[0]) / (RANGE[1] - RANGE[0])) * box.w;
      const Y = (mJy) => box.y + box.h - ((Math.log10(mJy) - Math.log10(axis.lo)) / (Math.log10(axis.hi) - Math.log10(axis.lo))) * box.h;
      // Axes and their numbers.
      ctx.strokeStyle = look.rule;
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.font = `400 ${Math.round(px * 0.85)}px ${FONTS.mono}`;
      ctx.fillStyle = look.neutral;
      ctx.textAlign = 'center';
      for (const um of [1, 2, 3, 4, 5]) {
        ctx.fillText(String(um), X(um), box.y + box.h + px * 1.05);
      }
      ctx.textAlign = 'right';
      ctx.fillText('µm', box.x + box.w, box.y + box.h + px * 2.1);
      ctx.textAlign = 'right';
      for (const v of axis.ticks) {
        const y = Y(v);
        ctx.fillText(fmt(v, v < 1 ? 2 : v < 10 ? 1 : 0), box.x - 10, y + px * 0.3);
        ctx.strokeStyle = look.paper3;
        ctx.beginPath();
        ctx.moveTo(box.x, y);
        ctx.lineTo(box.x + box.w, y);
        ctx.stroke();
      }
      ctx.save();
      ctx.translate(30, box.y + box.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText('mJy', 0, 0);
      ctx.restore();
      ctx.textAlign = 'left';
      // The points, each in its band's hue.
      for (const p of pts) {
        const x = X(p.um);
        ctx.strokeStyle = ctx.fillStyle = `oklch(80% 0.14 ${HUES[p.band] ?? 250})`;
        ctx.lineWidth = 3;
        if (p.pt.kind === 'detection') {
          const lo = Math.max(axis.lo, p.pt.mJy - p.pt.err);
          ctx.beginPath();
          ctx.moveTo(x, Y(Math.min(axis.hi, p.pt.mJy + p.pt.err)));
          ctx.lineTo(x, Y(lo));
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, Y(p.pt.mJy), 8, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // An upper limit: nothing above it was seen; an arrow down from it.
          const y = Y(p.pt.mJy);
          ctx.beginPath();
          ctx.moveTo(x - 9, y);
          ctx.lineTo(x + 9, y);
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + 22);
          ctx.moveTo(x - 7, y + 14);
          ctx.lineTo(x, y + 22);
          ctx.lineTo(x + 7, y + 14);
          ctx.stroke();
        }
      }
      ctx.font = legendFont;
      ctx.fillStyle = look.muted;
      legend.forEach((l, k) => ctx.fillText(l, x0, H - 22 - (legend.length - 1 - k) * Math.round(px * 1.15)));
    });
  }

  panel.mesh.userData.hover = (uv) => {
    const h = uv ? panel.hitAt(uv)?.id ?? null : null;
    if (h !== hover) { hover = h; draw(); }
  };
  panel.mesh.userData.pick = (uv) => { if (panel.hitAt(uv)?.id === 'close') hide(); };
  panel.mesh.userData.pickable = (uv) => Boolean(panel.hitAt(uv));

  function hide() {
    panel.mesh.visible = false;
    state = null;
    job += 1;
  }

  return {
    mesh: panel.mesh,
    /** Measure (ra, dec) in every visit, and read the wavelength each one saw it at. */
    show({ ra, dec, visits, sky, signal }) {
      const mine = ++job;
      state = { ra, dec, points: [], done: 0, total: visits.length };
      panel.mesh.visible = true;
      for (const v of visits) {
        const m = sky.covers(v, ra, dec) ? sky.measure(v, ra, dec, { orLimit: true }) : null;
        state.points.push({ band: v.frame.band, pt: visitPoint(m), um: null, frame: v.frame });
      }
      draw();
      // Two at a time: each is a small read of a file's header and its wavelength table.
      let next = 0;
      const one = async () => {
        while (job === mine && next < state.points.length) {
          const p = state.points[next++];
          try {
            // Where in its band the visit saw the source, as the site places it (spectrum.js).
            const wave = await loadWavelength(toS3(p.frame.url), ra, dec, { signal });
            p.um = wave ? placeInBand(p.frame, wave).um : null;
          } catch { p.um = null; }
          if (job !== mine) return;
          state.done += 1;
          draw();
        }
      };
      one();
      one();
    },
    hide,
    dispose() { panel.dispose(); },
  };
}

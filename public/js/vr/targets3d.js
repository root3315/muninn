/**
 * targets3d.js — the markers on the sky: the fields this tool can open, the
 * challenge targets among them, and the planets where they are now; and the
 * words the sky itself needs.
 *
 * A marker is a ring at its target's position, a square inside it the true
 * size of the field SPHEREx's frames are cut to, and its name under it;
 * pointed at, it grows and says why the field is worth opening. Rings and
 * names stand on the sky's own sphere, sized as angles, so they stay the same
 * size wherever they are and whichever way the head turns.
 */

import * as THREE from '../vendor/three.module.js';
import { t, fmt } from '../i18n.js';
import { buildMarkers, markerPosition } from './markers.js';
import { angleBetween, radecToVec } from './skydata.js';
import { createPanel, FONTS, wrapText, fitText } from './panel.js';
import { tv } from './strings.js';
import { galactic } from '../gate.js';

/** Where the markers stand: inside the stars, far outside anything in the room. */
const MARKER_RADIUS = 300;
const D2R = Math.PI / 180;
/** A ray picks a marker within this many degrees, and keeps it until it is this far off. */
const PICK_IN_DEG = 3;
const PICK_OUT_DEG = 4.5;

/** Metres on the marker sphere for an angle in degrees. */
const atR = (deg) => MARKER_RADIUS * Math.tan(deg * D2R);

/** The label's width on the sky, in degrees, and its canvas. */
const LABEL_DEG = 14;
const LABEL_PX = 380;
const LABEL_H_PX = 470;
const PX_PER_DEG = LABEL_PX / LABEL_DEG;

export function createMarkers({ fields, planets, look, lang }) {
  const group = new THREE.Group();
  group.name = 'markers';
  const markers = buildMarkers(fields, planets);
  const ringGeo = new THREE.RingGeometry(0.8, 1, 48);
  const dotGeo = new THREE.CircleGeometry(1, 32);
  const matOf = (css, opacity = 0.95) => new THREE.MeshBasicMaterial({ color: new THREE.Color(css), transparent: true, opacity, depthWrite: false });
  const mats = { challenge: matOf(look.counter), field: matOf(look.accent), planet: matOf(look.ink, 0.9) };
  const disposables = [ringGeo, dotGeo, ...Object.values(mats)];

  // The field squares, all in one draw call: the frames' true size on the sky.
  const sq = [];
  for (const m of markers) {
    if (m.kind === 'planet') continue;
    const half = (m.target.fov ?? 0.3) / 2;
    const c = Math.cos(m.dec * D2R);
    const corners = [[-half, -half], [half, -half], [half, half], [-half, half]]
      .map(([e, n]) => radecToVec(m.ra + e / Math.max(0.05, c), m.dec + n).map((x) => x * MARKER_RADIUS));
    for (let k = 0; k < 4; k++) sq.push(...corners[k], ...corners[(k + 1) % 4]);
  }
  const sqGeo = new THREE.BufferGeometry();
  sqGeo.setAttribute('position', new THREE.Float32BufferAttribute(sq, 3));
  const sqMat = new THREE.LineBasicMaterial({ color: new THREE.Color(look.ink), transparent: true, opacity: 0.8, depthWrite: false });
  group.add(new THREE.LineSegments(sqGeo, sqMat));
  disposables.push(sqGeo, sqMat);

  for (const m of markers) {
    const holder = new THREE.Object3D();
    holder.position.fromArray(markerPosition(m, MARKER_RADIUS));
    holder.lookAt(0, 0, 0);
    const ring = new THREE.Mesh(m.kind === 'planet' ? dotGeo : ringGeo, mats[m.kind].clone());
    disposables.push(ring.material);
    const r = atR(m.kind === 'planet' ? 0.35 : 0.9);
    ring.scale.setScalar(r);
    ring.renderOrder = 5;
    holder.add(ring);
    const label = createPanel({
      widthM: atR(LABEL_DEG), heightM: atR(LABEL_DEG * (LABEL_H_PX / LABEL_PX)), pxPerM: LABEL_PX / atR(LABEL_DEG), name: `label-${m.key}`,
    });
    label.mesh.renderOrder = 6;
    // The label's top edge just under the ring.
    label.mesh.position.set(0, -(r * 1.3 + label.heightM / 2), 0);
    holder.add(label.mesh);
    group.add(holder);
    Object.assign(m, { holder, ring, label, baseScale: r, drawn: '', pulse: false, burst: null });
  }

  function title(m) {
    if (m.kind === 'planet') return t(`planet.${m.key}`);
    return m.key ? t(`preset.${m.key}`) : m.target.name;
  }

  function sub(m) {
    if (m.kind === 'planet') return tv('vr.au', { v: fmt(m.target.au, 2) });
    // A challenge target says so by its gold; the line itself is short.
    return `${m.target.visits ?? '—'} ${t('stats.visits')}`;
  }

  // Body type 1.5° on the sky, the name a little more.
  const PX = { name: Math.round(PX_PER_DEG * 1.6), body: Math.round(PX_PER_DEG * 1.5) };

  function drawLabel(m, hover) {
    const key = `${hover}|${lang}`;
    if (m.drawn === key) return;
    m.drawn = key;
    m.label.draw((ctx, W) => {
      ctx.textAlign = 'center';
      // A dark halo behind each line: the band can be bright behind a name.
      ctx.shadowColor = 'rgba(8, 8, 16, 0.95)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = hover ? look.ink : look.muted;
      ctx.font = `600 ${PX.name}px ${FONTS.display}`;
      // A long name takes a second line rather than losing its end.
      let y = wrapText(ctx, title(m), W / 2, PX.name + 2, W - 8, PX.name * 1.1, 2);
      ctx.font = `500 ${PX.body}px ${FONTS.mono}`;
      ctx.fillStyle = m.kind === 'challenge' ? look.counter : look.neutral;
      ctx.fillText(fitText(ctx, sub(m), W - 8), W / 2, y + 6);
      y += PX.body + 20;
      const why = m.target.why?.[lang] ?? m.target.why?.en;
      if (hover && why) {
        ctx.font = `400 ${PX.body}px ${FONTS.body}`;
        ctx.fillStyle = look.ink;
        wrapText(ctx, why, W / 2, y, W - 12, PX.body + 6, 6);
      }
    });
  }

  for (const m of markers) drawLabel(m, false);

  // Names that would cover one another on the sky: the field's stays, the
  // other steps down under it, once or twice, and is hidden if still covered.
  {
    const rank = { challenge: 3, field: 2, planet: 1 };
    const placedBoxes = [];
    const nameH = (PX.name + PX.body + 24) / PX_PER_DEG;
    for (const m of markers.slice().sort((a, b) => rank[b.kind] - rank[a.kind])) {
      const cos = Math.cos(m.dec * D2R);
      let drop = 0;
      const box = () => ({ x: m.ra * cos, y: m.dec - 1.6 - drop - nameH / 2, w: LABEL_DEG * 0.45, h: nameH / 2 });
      const covered = (b) => placedBoxes.some((o) => Math.abs(((o.x - b.x + 540) % 360) - 180) < o.w + b.w && Math.abs(o.y - b.y) < o.h + b.h);
      let b = box();
      for (let k = 0; k < 2 && covered(b); k++) { drop += nameH; b = box(); }
      if (covered(b)) { m.label.mesh.visible = false; m.label.placed = false; continue; }
      if (drop) m.label.mesh.position.y -= atR(drop);
      placedBoxes.push(b);
    }
  }

  /* ---- the sky's own words ------------------------------------------ */
  const captions = [];
  function caption(text, ra, dec, tone = 'neutral') {
    const px = Math.round(PX_PER_DEG * 1.5);
    const widthDeg = text.length * 0.95 + 2;
    const panel = createPanel({ widthM: atR(widthDeg), heightM: atR((px * 1.6) / PX_PER_DEG), pxPerM: PX_PER_DEG / atR(1), name: 'sky-caption' });
    panel.draw((ctx, W, H) => {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(8, 8, 16, 0.95)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = look[tone];
      ctx.font = `400 ${px}px ${FONTS.mono}`;
      ctx.fillText(fitText(ctx, text, W - 8), W / 2, H / 2);
    });
    panel.mesh.position.fromArray(radecToVec(ra, dec).map((x) => x * MARKER_RADIUS * 1.01));
    panel.dir = radecToVec(ra, dec);
    panel.mesh.lookAt(0, 0, 0);
    panel.mesh.renderOrder = 6;
    group.add(panel.mesh);
    captions.push(panel);
  }
  // Near where the viewer starts: below Barnard's Star, on the band toward Aquila, on the ecliptic.
  caption(tv('vr.skyStars'), 248, 24, 'neutral');
  {
    // A point on the galactic plane at l = 30°, found by search so the label sits on the band.
    let best = [281, -2];
    let bestGap = 99;
    for (let ra = 270; ra <= 292; ra += 0.5) {
      for (let dec = -12; dec <= 8; dec += 0.5) {
        const [l, b] = galactic(ra, dec);
        const gap = Math.abs(b) + Math.abs(l - 30) * 0.2;
        if (gap < bestGap) { bestGap = gap; best = [ra, dec]; }
      }
    }
    caption(tv('vr.skyBand'), best[0], best[1], 'muted');
  }
  // Clear of the visits' arc in front, where the ecliptic runs higher.
  caption(tv('vr.ecliptic'), 225, -16.2, 'neutral');

  let hovered = null;
  let first = null;

  return {
    group,
    markers,
    /** The marker a direction (in the sky's own frame) points at, held a little past where it was first caught. */
    pick(dir) {
      const v = [dir.x, dir.y, dir.z];
      if (hovered && angleBetween(v, hovered.v) <= PICK_OUT_DEG) return hovered;
      let best = null;
      let bestAngle = PICK_IN_DEG;
      for (const m of markers) {
        const a = angleBetween(v, m.v);
        if (a <= bestAngle) { best = m; bestAngle = a; }
      }
      return best;
    },
    setHover(m) {
      if (m === hovered) return;
      if (hovered) drawLabel(hovered, false);
      hovered = m;
      if (m) drawLabel(m, true);
    },
    /** The marker the first sign points at, pulsing until something is chosen. */
    setFirst(m) { first = m; },
    /** A chosen marker's ring grows and fades: the start of the dive. */
    burst(m) { m.burst = { t0: performance.now() }; },
    /** Once a frame: hover growth, the first marker's pulse, a burst. */
    tick(now, { growMs = 400, grow = 3 } = {}) {
      for (const m of markers) {
        let s = m === hovered ? 1.35 : 1;
        if (m === first) s *= 1 + 0.075 * (1 - Math.cos((now / 1600) * Math.PI * 2));
        let opacity = m.ring.material.userData.base ?? m.ring.material.opacity;
        m.ring.material.userData.base = opacity;
        if (m.burst) {
          const k = Math.min(1, (now - m.burst.t0) / growMs);
          s *= 1 + (grow - 1) * (1 - (1 - k) ** 3);
          opacity *= 1 - k;
          if (k >= 1) m.burst = null;
        }
        m.ring.scale.setScalar(m.baseScale * s);
        m.ring.material.opacity = m.burst ? opacity : m.ring.material.userData.dimmed ?? m.ring.material.userData.base;
      }
    },
    /**
     * Quieter while a field is open, so the screens are what is read; and,
     * along `axis` (a direction in the sky's own frame), quieter still, so the
     * names on the sky do not stand in the field's corridor.
     */
    setDim(k, axis = null, clearDeg = 35, kAxis = 0.12, screens = null) {
      // A name behind the field's screens or in its corridor is not shown at
      // all: half-seen through a gap, it reads as part of what is in front.
      const hiddenAt = (v) => (axis && angleBetween([axis.x, axis.y, axis.z], v) < clearDeg)
        || (screens && angleBetween([screens.x, screens.y, screens.z], v) < 62);
      for (const m of markers) {
        const along = axis && angleBetween([axis.x, axis.y, axis.z], m.v) < clearDeg;
        const f = along ? Math.min(k, kAxis) : k;
        m.ring.material.userData.dimmed = (m.ring.material.userData.base ?? 0.95) * f;
        m.label.mesh.material.opacity = f;
        m.label.mesh.visible = !(k < 1 && hiddenAt(m.v)) && m.label.placed !== false;
      }
      for (const c of captions) c.mesh.visible = !(k < 1 && hiddenAt(c.dir));
    },
    dispose() {
      for (const m of markers) m.label.dispose();
      for (const c of captions) c.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}

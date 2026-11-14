/**
 * timeline.js — the field's visits on the Earth's orbit, around the viewer.
 *
 * Every visit is a small frame on a ring below the screens, standing where
 * the Earth was in its orbit that day (orbit.js). SPHEREx comes back to a
 * patch of sky half a year apart, so the visits gather in two seasons on
 * opposite sides of the ring, with the empty stretches between them labelled
 * for how long they were; a second year hangs a little lower. Across the ring
 * the baseline between the seasons is drawn with what it does: how far it
 * shifts a body at 500 AU.
 *
 * The ring stands still. During the blink only a glow travels round it, and
 * the visit on the main screen comes a little toward the viewer. Pointed at,
 * a frame grows and shows its date; pressed, it opens on the main screen.
 * Frames far from where the head points are dimmed.
 *
 * All the thumbnails are one texture (an atlas) on one mesh, so the whole
 * ring is a handful of draw calls however many visits it holds.
 *
 *   createTimeline({ visits, onPick, look, lang }) ->
 *     { object3d, setCurrent(i), update(visits), tick(dt, gazeYaw), dispose() }
 *
 * `visits` are every planned visit in date order: `{ frame, visit, status }`,
 * `visit` being the read SkyView entry (its painted canvas) or null while it
 * is on its way. `object3d` is placed by the caller at the viewer's head,
 * turned so its −z is the direction of the main screen.
 */

import * as THREE from '../vendor/three.module.js';
import { formatDay } from '../i18n.js';
import { createPanel, FONTS, fitText } from './panel.js';
import { LAYOUT, minTextPx } from './layout.js';
import { ringLayout } from './orbit.js';
import { tv } from './strings.js';

const D2R = Math.PI / 180;
const R = LAYOUT.ring;
const CELL_W = 256;
const CELL_H = 192;
const COLS = 4;

const MJD_UNIX = 40587;
const dateOf = (mjd) => new Date((mjd - MJD_UNIX) * 86400000);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const FRAME_VERTEX = /* glsl */ `
  attribute vec2 local;
  attribute float state;
  attribute float fade;
  varying vec2 vUv;
  varying vec2 vLocal;
  varying float vState;
  varying float vFade;
  void main() {
    vUv = uv; vLocal = local; vState = state; vFade = fade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAME_FRAGMENT = /* glsl */ `
  uniform sampler2D atlas;
  uniform vec3 well;
  uniform vec3 rule;
  uniform vec3 ink;
  uniform vec3 accent;
  varying vec2 vUv;
  varying vec2 vLocal;
  varying float vState;
  varying float vFade;
  void main() {
    // state: 0 a read visit, 1 the one on the main screen, 2 pointed at, 3 not read yet
    vec3 c = vState > 2.5 ? well : texture2D(atlas, vUv).rgb;
    float edge = min(min(vLocal.x, 1.0 - vLocal.x) * 1.33, min(vLocal.y, 1.0 - vLocal.y));
    float w = vState > 0.5 && vState < 2.5 ? 0.045 : 0.018;
    if (edge < w) c = vState > 0.5 && vState < 1.5 ? accent : vState > 1.5 && vState < 2.5 ? ink : rule;
    gl_FragColor = vec4(c * vFade, 1.0);
  }
`;

export function createTimeline({ visits, onPick, look, lang }) {
  const object3d = new THREE.Group();
  object3d.name = 'timeline';
  const disposables = [];
  const dy0 = Math.tan(R.pitchDeg * D2R) * R.radius;

  /* ---- the atlas ----------------------------------------------------- */
  const atlasCanvas = document.createElement('canvas');
  const atlas = new THREE.CanvasTexture(atlasCanvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.generateMipmaps = false;
  atlas.minFilter = THREE.LinearFilter;
  disposables.push(atlas);

  const css = (c) => new THREE.Color(c);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      atlas: { value: atlas }, well: { value: css(look.well) }, rule: { value: css(look.rule) },
      ink: { value: css(look.ink) }, accent: { value: css(look.accent) },
    },
    vertexShader: FRAME_VERTEX,
    fragmentShader: FRAME_FRAGMENT,
    side: THREE.DoubleSide,
  });
  disposables.push(material);

  let mesh = null;
  let geo = null;
  let list = visits;
  let quads = [];
  let current = -1;
  let hover = -1;
  let labels = [];
  let lines = [];

  /* ---- the glow that runs round the ring ---------------------------- */
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = 128;
  glowCanvas.height = 128;
  {
    const g = glowCanvas.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0.6)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.2)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  const glowTex = new THREE.CanvasTexture(glowCanvas);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex, color: css(look.accent), transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(R.frameW * 2.4, R.frameH * 2.6), glowMat);
  glow.renderOrder = 9;
  object3d.add(glow);
  disposables.push(glowTex, glowMat, glow.geometry);

  /* ---- labels: dates, gaps, the baseline ---------------------------- */
  const LABEL_PX = 640;
  function label(text, { widthM, tone = 'muted', font = 'mono' }) {
    const dist = R.radius;
    const px = minTextPx(LABEL_PX, dist);
    const heightM = (px * 1.45) / LABEL_PX;
    const panel = createPanel({ widthM, heightM, pxPerM: LABEL_PX, name: 'ring-label' });
    panel.draw((ctx, W, H) => {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(8, 8, 16, 0.95)';
      ctx.shadowBlur = 6;
      ctx.fillStyle = look[tone] ?? look.muted;
      ctx.font = font === 'mono' ? `500 ${px}px ${FONTS.mono}` : `500 ${px}px ${FONTS.body}`;
      ctx.fillText(fitText(ctx, text, W - 8), W / 2, H / 2 + 2);
    });
    panel.mesh.renderOrder = 11;
    object3d.add(panel.mesh);
    labels.push(panel);
    return panel;
  }

  /** A point on the ring and the frame facing the head there. */
  function ringPoint(yawDeg, tier = 0, inward = 0) {
    const yaw = yawDeg * D2R;
    const r = R.radius - inward;
    const p = new THREE.Vector3(-Math.sin(yaw) * r, dy0 - tier * R.tierDropM, -Math.cos(yaw) * r);
    const n = p.clone().negate().normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(n).normalize();
    const up = n.clone().cross(right).normalize();
    return { p, n, right, up };
  }

  /** Turn a mesh in the ring's own frame so its face looks at the head (the ring's origin). */
  const basis = new THREE.Matrix4();
  function faceHead(obj) {
    const n = obj.position.clone().negate().normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(n).normalize();
    const up = n.clone().cross(right).normalize();
    obj.quaternion.setFromRotationMatrix(basis.makeBasis(right, up, n));
  }

  function placeLabel(panel, yawDeg, tier, where = 'below') {
    const { p, up, right } = ringPoint(yawDeg, tier);
    if (where === 'left') {
      // Beside the row, level with it, clear of the first frame.
      p.addScaledVector(right, -(R.frameW / 2 + panel.widthM / 2 + 0.03));
    } else {
      p.addScaledVector(up, where === 'below' ? -(R.frameH / 2 + panel.heightM * 0.7) : R.frameH / 2 + panel.heightM * 0.7);
    }
    panel.mesh.position.copy(p);
    faceHead(panel.mesh);
  }

  let layout = null;
  let dateFor = null;
  /** The date under each season's first visit, by its index: hidden while that visit has its own. */
  let seasonLabels = new Map();

  function build() {
    for (const l of labels) l.dispose();
    labels = [];
    for (const l of lines) { l.removeFromParent(); l.geometry.dispose(); l.material.dispose(); }
    lines = [];
    if (mesh) { mesh.removeFromParent(); geo.dispose(); }
    mesh = null;
    const n = list.length;
    if (!n) return;

    layout = ringLayout(list.map((s) => s.frame.mjd), { gapDays: R.gapDays, minSepDeg: R.minSepDeg });
    const rows = Math.ceil(n / COLS);
    atlasCanvas.width = CELL_W * COLS;
    atlasCanvas.height = CELL_H * rows;
    const actx = atlasCanvas.getContext('2d');
    actx.fillStyle = look.well;
    actx.fillRect(0, 0, atlasCanvas.width, atlasCanvas.height);

    geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 4 * 3);
    const uv = new Float32Array(n * 4 * 2);
    const local = new Float32Array(n * 4 * 2);
    const state = new Float32Array(n * 4).fill(3);
    const fade = new Float32Array(n * 4).fill(1);
    const index = [];
    quads = [];
    for (let i = 0; i < n; i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const u0 = (col * CELL_W + 2) / atlasCanvas.width;
      const u1 = ((col + 1) * CELL_W - 2) / atlasCanvas.width;
      // The canvas is uploaded flipped: its first row is the texture's top.
      const v1 = 1 - (row * CELL_H + 2) / atlasCanvas.height;
      const v0 = 1 - ((row + 1) * CELL_H - 2) / atlasCanvas.height;
      uv.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8);
      local.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      const b = i * 4;
      index.push(b, b + 1, b + 2, b, b + 2, b + 3);
      quads.push({ yaw: layout.angles[i], tier: layout.tiers[i], lift: 0, grow: 0, drawn: null, fade: 1 });
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('local', new THREE.BufferAttribute(local, 2));
    geo.setAttribute('state', new THREE.BufferAttribute(state, 1));
    geo.setAttribute('fade', new THREE.BufferAttribute(fade, 1));
    geo.setIndex(index);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, dy0, 0), R.radius + 0.6);
    mesh = new THREE.Mesh(geo, material);
    mesh.name = 'visits';
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;
    mesh.userData.pick = (uvHit, hit) => { const i = quadOf(hit); if (i >= 0) onPick?.(i); };
    mesh.userData.hover = (uvHit, hit) => setHover(uvHit ? quadOf(hit) : -1);
    object3d.add(mesh);
    for (let i = 0; i < n; i++) placeQuad(i);

    // The date under the first visit of each season; the year under a second year's.
    seasonLabels = new Map();
    for (const s of layout.seasons) {
      const day = dateOf(list[s.from].frame.mjd);
      const l = label(formatDay(day, { year: true, lang }), { widthM: 0.42 });
      placeLabel(l, quads[s.from].yaw, quads[s.from].tier);
      seasonLabels.set(s.from, l);
    }
    const second = layout.tiers.indexOf(1);
    if (second >= 0) placeLabel(label(tv('vr.year2'), { widthM: 0.36, tone: 'neutral' }), quads[second].yaw, 1, 'left');
    for (const g of layout.gaps) {
      const months = Math.max(1, Math.round(g.days / 30.44));
      placeLabel(label(tv('vr.gap', { n: months }), { widthM: 0.9, tone: 'neutral', font: 'body' }), g.at, quads[g.to].tier, 'above');
    }
    if (layout.baseline) {
      const { a, b, chordAU, shiftArcmin, bodyAU } = layout.baseline;
      const pa = ringPoint(a, 0, 0.05).p;
      const pb = ringPoint(b, 0, 0.05).p;
      pa.y = dy0 - 0.12;
      pb.y = dy0 - 0.12;
      const lineGeo = new THREE.BufferGeometry().setFromPoints([pa, pb]);
      const line = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color: css(look.counter), dashSize: 0.06, gapSize: 0.04, transparent: true, opacity: 0.8 }));
      line.computeLineDistances();
      object3d.add(line);
      lines.push(line);
      const text = tv('vr.baseline', { au: chordAU.toFixed(1), body: bodyAU, shift: shiftArcmin.toFixed(1) });
      const l = label(text, { widthM: 2.6, tone: 'counter', font: 'body' });
      // Beside the nearer end, where it can be read.
      const near = Math.abs(a) < Math.abs(b) ? a : b;
      placeLabel(l, near + (near >= 0 ? 34 : -34), 0, 'below');
    }
    // The date of the visit on the screen and of the one pointed at.
    dateFor = { current: label(' ', { widthM: 0.42, tone: 'accent' }), hover: label(' ', { widthM: 0.42, tone: 'ink' }) };
    dateFor.current.mesh.visible = false;
    dateFor.hover.mesh.visible = false;
    paintThumbs();
  }

  function quadOf(hit) {
    return hit?.faceIndex != null ? Math.floor(hit.faceIndex / 2) : -1;
  }

  function placeQuad(i) {
    const q = quads[i];
    const { p, n, right, up } = ringPoint(q.yaw, q.tier);
    p.addScaledVector(n, R.liftM * q.lift);
    const s = 1 + (R.hoverScale - 1) * q.grow;
    const hw = (R.frameW / 2) * s;
    const hh = (R.frameH / 2) * s;
    const pos = geo.attributes.position;
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    corners.forEach(([x, y], k) => {
      pos.setXYZ(i * 4 + k,
        p.x + right.x * x + up.x * y, p.y + right.y * x + up.y * y, p.z + right.z * x + up.z * y);
    });
    pos.needsUpdate = true;
  }

  function setState(i, value) {
    const a = geo.attributes.state;
    for (let k = 0; k < 4; k++) a.setX(i * 4 + k, value);
    a.needsUpdate = true;
  }

  function stateOf(i) {
    if (!list[i]?.visit) return 3;
    if (i === current) return 1;
    if (i === hover) return 2;
    return 0;
  }

  /** Each visit's thumbnail drawn into the atlas once, when its picture arrives or is repainted. */
  function paintThumbs() {
    if (!mesh) return;
    const actx = atlasCanvas.getContext('2d');
    actx.imageSmoothingEnabled = true;
    actx.imageSmoothingQuality = 'high';
    let changed = false;
    list.forEach((s, i) => {
      const v = s.visit;
      const key = v ? `${v.frame.obsId}|${v.canvasVersion ?? 0}` : null;
      if (quads[i].drawn !== key && v?.canvas) {
        const x = (i % COLS) * CELL_W;
        const y = Math.floor(i / COLS) * CELL_H;
        const sw = v.canvas.width;
        const sh = v.canvas.height;
        const k = Math.max(CELL_W / sw, CELL_H / sh);
        actx.save();
        actx.beginPath();
        actx.rect(x, y, CELL_W, CELL_H);
        actx.clip();
        actx.drawImage(v.canvas, x + CELL_W / 2 - (sw * k) / 2, y + CELL_H / 2 - (sh * k) / 2, sw * k, sh * k);
        actx.restore();
        changed = true;
      }
      quads[i].drawn = key;
      setState(i, stateOf(i));
    });
    if (changed) atlas.needsUpdate = true;
  }

  function showDate(panel, i) {
    if (!panel) return;
    if (i < 0 || !list[i]) { panel.mesh.visible = false; return; }
    const text = formatDay(dateOf(list[i].frame.mjd), { year: true, lang });
    if (panel.text !== text) {
      panel.text = text;
      const px = minTextPx(LABEL_PX, R.radius);
      panel.draw((ctx, W, H) => {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(8, 8, 16, 0.95)';
        ctx.shadowBlur = 6;
        ctx.fillStyle = panel === dateFor.current ? look.accent : look.ink;
        ctx.font = `500 ${px}px ${FONTS.mono}`;
        ctx.fillText(text, W / 2, H / 2 + 2);
      });
    }
    panel.mesh.visible = true;
    panel.at = i;
  }

  function setHover(i) {
    if (i === hover) return;
    const was = hover;
    hover = i;
    if (was >= 0 && was < quads.length) setState(was, stateOf(was));
    if (i >= 0) setState(i, stateOf(i));
    showDate(dateFor?.hover, i === current ? -1 : i);
  }

  list = visits;
  build();

  return {
    object3d,
    /** The visit on the main screen, by its place in `visits`. */
    setCurrent(i) {
      if (i === current || !mesh) return;
      const was = current;
      current = i;
      if (was >= 0 && was < quads.length) setState(was, stateOf(was));
      if (i >= 0 && i < quads.length) setState(i, stateOf(i));
      showDate(dateFor.current, i);
    },
    /** New statuses or pictures; the ring is rebuilt only when the visits themselves change. */
    update(next) {
      const rebuilt = next.length !== list.length || next.some((s, i) => s.frame?.mjd !== list[i]?.frame?.mjd);
      list = next;
      if (rebuilt) {
        const was = current;
        current = -1;
        build();
        if (was >= 0) this.setCurrent(Math.min(was, list.length - 1));
      } else {
        paintThumbs();
      }
    },
    /** Once a frame: the current visit easing forward, the pointed-at one growing, the glow, the dimming away from the gaze. */
    tick(dt, gazeYaw = 0) {
      if (!mesh) return;
      const kLift = 1 - Math.exp(-dt / (R.liftMs / 3000));
      const kGrow = 1 - Math.exp(-dt / (R.hoverMs / 3000));
      const fadeAttr = geo.attributes.fade;
      let faded = false;
      quads.forEach((q, i) => {
        const lift = i === current ? 1 : 0;
        const grow = i === hover ? 1 : 0;
        let moved = false;
        if (Math.abs(q.lift - lift) > 1e-3) { q.lift += (lift - q.lift) * kLift; moved = true; } else if (q.lift !== lift) { q.lift = lift; moved = true; }
        if (Math.abs(q.grow - grow) > 1e-3) { q.grow += (grow - q.grow) * kGrow; moved = true; } else if (q.grow !== grow) { q.grow = grow; moved = true; }
        if (moved) placeQuad(i);
        const off = Math.abs(wrapPi(q.yaw * D2R - gazeYaw)) / D2R;
        const f = off <= R.gazeDeg ? 1 : off >= R.gazeDeg + 15 ? R.gazeDim : 1 - ((off - R.gazeDeg) / 15) * (1 - R.gazeDim);
        if (Math.abs(f - q.fade) > 0.01) {
          q.fade += (f - q.fade) * Math.min(1, dt * 6);
          for (let k = 0; k < 4; k++) fadeAttr.setX(i * 4 + k, q.fade);
          faded = true;
        }
      });
      if (faded) fadeAttr.needsUpdate = true;
      // The glow follows the current visit round the ring.
      const target = current >= 0 ? ringPoint(quads[current].yaw, quads[current].tier, R.liftM * quads[current].lift + 0.01) : null;
      if (target) {
        if (glowMat.opacity < 0.02) glow.position.copy(target.p);
        else glow.position.lerp(target.p, Math.min(1, dt * 14));
        faceHead(glow);
      }
      glowMat.opacity += ((target ? 0.85 : 0) - glowMat.opacity) * Math.min(1, dt * 6);
      // A season's date gives way while a visit near it shows its own: the
      // labels are wider than the frames, and two dates side by side read as one.
      const near = (i, j) => j >= 0 && quads[j] && quads[i].tier === quads[j].tier
        && Math.abs(quads[i].yaw - quads[j].yaw) < 16;
      for (const [i, l] of seasonLabels) l.mesh.visible = !near(i, current) && !near(i, hover);
      for (const [panel, i] of [[dateFor?.current, current], [dateFor?.hover, hover]]) {
        if (panel?.mesh.visible && i >= 0) {
          const q = quads[i];
          const { p, n, up } = ringPoint(q.yaw, q.tier);
          const s = 1 + (R.hoverScale - 1) * q.grow;
          panel.mesh.position.copy(p).addScaledVector(n, R.liftM * q.lift + 0.02).addScaledVector(up, -(R.frameH / 2) * s - panel.heightM * 0.7);
          faceHead(panel.mesh);
        }
      }
    },
    /** The band's hue, for a new field. */
    setLook(next) {
      look = next;
      material.uniforms.accent.value.set(look.accent);
      glowMat.color.set(look.accent);
    },
    dispose() {
      for (const l of labels) l.dispose();
      for (const l of lines) { l.geometry.dispose(); l.material.dispose(); }
      if (geo) geo.dispose();
      for (const d of disposables) d.dispose();
      atlasCanvas.width = 0;
      atlasCanvas.height = 0;
      object3d.removeFromParent();
    },
  };
}

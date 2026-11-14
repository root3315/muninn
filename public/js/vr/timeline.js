/**
 * timeline.js — the field's visits on the Earth's orbit, in front of the viewer.
 *
 * Every visit is a small frame on an arc below the screens, at the place in
 * the Earth's orbit SPHEREx looked from that day (orbit.js). It comes back to
 * a patch of sky half a year apart, so the visits gather at two places, set
 * either side of the front in the orbit's order; a return to the same place a
 * year later is a row below. The empty stretch between the places is
 * labelled for how long it was, and the chord between them is the baseline,
 * with what it does: how far it shifts a body at 500 AU.
 *
 * The arc stands still. During the blink only a glow runs along it, and the
 * visit on the main screen comes a little toward the viewer. Pointed at, a
 * frame grows and shows its date; pressed, it opens on the main screen.
 * Frames far from where the head points are dimmed. A frame still on its way
 * is a dashed outline with its date in it, pulsing while it is read; one that
 * could not be read is crossed.
 *
 * All the thumbnails are one texture (an atlas) on one mesh, so the whole arc
 * is a handful of draw calls however many visits it holds. Its labels are
 * placed once a frame by priority (the visit on the screen, the one pointed
 * at, each season's month, the gaps), and one that would touch a label
 * placed before it is not shown.
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
import { arcLayout } from './orbit.js';
import { tv } from './strings.js';

const D2R = Math.PI / 180;
const R = LAYOUT.ring;
const CELL_W = 256;
const CELL_H = 192;
const COLS = 4;
const LABEL_PX = 900;

const MJD_UNIX = 40587;
const dateOf = (mjd) => new Date((mjd - MJD_UNIX) * 86400000);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/* state: 0 read, 1 on the main screen, 2 pointed at, 3 not read (its placeholder), 4 being read */
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
  uniform vec3 rule;
  uniform vec3 ink;
  uniform vec3 accent;
  uniform float time;
  varying vec2 vUv;
  varying vec2 vLocal;
  varying float vState;
  varying float vFade;
  void main() {
    vec3 c = texture2D(atlas, vUv).rgb;
    // A frame on its way breathes, 0.55 to 0.85, once a second.
    if (vState > 3.5) c *= 0.7 + 0.15 * sin(time * 6.2831853);
    float edge = min(min(vLocal.x, 1.0 - vLocal.x) * 1.33, min(vLocal.y, 1.0 - vLocal.y));
    bool lit = vState > 0.5 && vState < 2.5;
    if (vState < 2.5 && edge < (lit ? 0.045 : 0.018)) c = vState > 0.5 && vState < 1.5 ? accent : vState > 1.5 ? ink : rule;
    gl_FragColor = vec4(c * vFade, 1.0);
  }
`;

export function createTimeline({ visits, onPick, look, lang }) {
  const object3d = new THREE.Group();
  object3d.name = 'timeline';
  const disposables = [];
  const dy0 = Math.tan(R.pitchDeg * D2R) * R.radius;
  const css = (c) => new THREE.Color(c);

  /* ---- the atlas ----------------------------------------------------- */
  const atlasCanvas = document.createElement('canvas');
  const atlas = new THREE.CanvasTexture(atlasCanvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.generateMipmaps = false;
  atlas.minFilter = THREE.LinearFilter;
  disposables.push(atlas);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      atlas: { value: atlas }, rule: { value: css(look.rule) }, ink: { value: css(look.ink) },
      accent: { value: css(look.accent) }, time: { value: 0 },
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
  let layout = null;
  let dateFor = null;
  let tags = null;
  let backdrop = null;
  let ab = [-1, -1];

  /* ---- the glow that runs along the arc ------------------------------ */
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
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(R.frameW * 2.2, R.frameH * 2.4), glowMat);
  glow.renderOrder = 9;
  object3d.add(glow);
  disposables.push(glowTex, glowMat, glow.geometry);

  /* ---- where things stand --------------------------------------------- */
  /** A point on the arc and the frame facing the head there. */
  function ringPoint(yawDeg, tier = 0, inward = 0) {
    const yaw = yawDeg * D2R;
    const r = R.radius - inward;
    const p = new THREE.Vector3(-Math.sin(yaw) * r, dy0 - tier * R.tierDropM, -Math.cos(yaw) * r);
    const n = p.clone().negate().normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(n).normalize();
    const up = n.clone().cross(right).normalize();
    return { p, n, right, up };
  }

  const basis = new THREE.Matrix4();
  /** Turn a mesh in the arc's own frame so its face looks at the head (the arc's origin). */
  function faceHead(obj) {
    const n = obj.position.clone().negate().normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(n).normalize();
    const up = n.clone().cross(right).normalize();
    obj.quaternion.setFromRotationMatrix(basis.makeBasis(right, up, n));
  }

  /* ---- labels ---------------------------------------------------------- */
  const textPx = minTextPx(LABEL_PX, R.radius);

  /** A label sized to its words, with a priority for the collision pass. */
  function label(text, { tone = 'muted', font = 'mono', priority = 1 }) {
    const f = font === 'mono' ? `500 ${textPx}px ${FONTS.mono}` : `500 ${textPx}px ${FONTS.body}`;
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = f;
    const widthM = (probe.measureText(text).width + textPx) / LABEL_PX;
    const heightM = (textPx * 1.45) / LABEL_PX;
    const panel = createPanel({ widthM, heightM, pxPerM: LABEL_PX, name: 'ring-label' });
    panel.paint = (t, color) => panel.draw((ctx, W, H) => {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(8, 8, 16, 0.95)';
      ctx.shadowBlur = 6;
      ctx.fillStyle = look[color] ?? look.muted;
      ctx.font = f;
      ctx.fillText(fitText(ctx, t, W - 4), W / 2, H / 2 + 2);
    });
    panel.paint(text, tone);
    panel.mesh.renderOrder = 11;
    panel.priority = priority;
    object3d.add(panel.mesh);
    labels.push(panel);
    return panel;
  }

  function placeLabel(panel, yawDeg, tier, where = 'below', scale = 1) {
    const { p, up, right } = ringPoint(yawDeg, tier);
    const half = (R.frameH / 2) * scale;
    if (where === 'left') p.addScaledVector(right, -((R.frameW / 2) * scale + panel.widthM / 2 + 0.03));
    else p.addScaledVector(up, where === 'below' ? -(half + panel.heightM * 0.7) : half + panel.heightM * 0.7);
    panel.mesh.position.copy(p);
    faceHead(panel.mesh);
  }

  /**
   * The collision pass: labels by priority, each shown only if it does not
   * touch one already shown. Compared by their angular extent along the arc
   * and their height, which is what the eye sees from the centre.
   */
  function settleLabels() {
    const shown = [];
    const ordered = labels.filter((l) => l.wanted !== false).sort((a, b) => b.priority - a.priority);
    for (const l of labels) if (l.wanted === false) l.mesh.visible = false;
    for (const l of ordered) {
      // As the eye sees them from the centre: by angle across and angle up,
      // so a label nearer the viewer is weighed by how much of the view it takes.
      const p = l.mesh.position;
      const flat = Math.hypot(p.x, p.z);
      const yaw = Math.atan2(-p.x, -p.z) / D2R;
      const half = ((l.widthM * l.mesh.scale.x) / 2 / flat) / D2R + 0.6;
      const box = { yaw, half, y: Math.atan2(p.y, flat) / D2R, h: ((l.heightM * l.mesh.scale.y) / 2 / flat) / D2R + 0.3 };
      const hits = shown.some((o) => Math.abs(wrapPi((o.yaw - box.yaw) * D2R)) / D2R < o.half + box.half && Math.abs(o.y - box.y) < o.h + box.h);
      l.mesh.visible = !hits;
      if (!hits) shown.push(box);
    }
  }

  /* ---- building the arc ------------------------------------------------- */
  function build() {
    for (const l of labels) l.dispose();
    labels = [];
    for (const l of lines) { l.removeFromParent(); l.geometry.dispose(); l.material.dispose(); }
    lines = [];
    if (backdrop) { backdrop.removeFromParent(); backdrop.geometry.dispose(); backdrop.material.dispose(); backdrop = null; }
    if (mesh) { mesh.removeFromParent(); geo.dispose(); }
    mesh = null;
    const n = list.length;
    if (!n) return;

    layout = arcLayout(list.map((s) => s.frame.mjd), { gapDays: R.gapDays, minSepDeg: R.minSepDeg, gapDeg: R.gapDeg, arcDeg: R.arcDeg });
    const rows = Math.ceil(n / COLS);
    atlasCanvas.width = CELL_W * COLS;
    atlasCanvas.height = CELL_H * rows;

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
      const season = layout.seasons.findIndex((s) => i >= s.from && i <= s.to);
      quads.push({ yaw: layout.angles[i], tier: layout.tiers[i], season, lift: 0, grow: 0, drawn: null, fade: 1 });
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

    // A dark band behind the whole strip, frames and words, like the site's run.
    {
      const lo = Math.min(...layout.angles) - (R.frameW / R.radius) / D2R;
      const hi = Math.max(...layout.angles) + (R.frameW / R.radius) / D2R;
      const rows = Math.max(...layout.tiers) + 1;
      const top = dy0 + R.frameH / 2 + 0.12;
      const bottom = dy0 - (rows - 1) * R.tierDropM - R.frameH / 2 - 0.42;
      const g = new THREE.CylinderGeometry(R.radius + 0.04, R.radius + 0.04, top - bottom, 48, 1, true, (lo + 180) * D2R, (hi - lo) * D2R);
      g.translate(0, (top + bottom) / 2, 0);
      backdrop = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: css(look.well), transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false }));
      backdrop.renderOrder = 8;
      object3d.add(backdrop);
    }

    // Each season's month under its first visit, short: the day is on the frame.
    seasonLabels = new Map();
    layout.seasons.forEach((s, k) => {
      const parts = formatDay(dateOf(list[s.from].frame.mjd), { year: true, lang }).split(' ');
      const l = label(parts.slice(1).join(' '), { priority: 2 });
      l.season = k;
      // A return a year later is named beside its row, clear of the chord under it.
      // Over the first row, or beside a later row: never between the frames.
      placeLabel(l, quads[s.from].yaw, quads[s.from].tier, quads[s.from].tier ? 'left' : 'above');
      seasonLabels.set(k, l);
    });
    for (const g of layout.gaps) {
      const months = Math.max(1, Math.round(g.days / 30.44));
      placeLabel(label(tv('vr.gap', { n: months }), { tone: 'neutral', font: 'body', priority: 1 }), g.at, 0, 'above');
    }
    if (layout.baseline) {
      const { a, b, chordAU, shiftArcmin, bodyAU } = layout.baseline;
      const pa = ringPoint(a, 0).p;
      const pb = ringPoint(b, 0).p;
      // Under every row of frames, so it crosses none of them.
      pa.y = dy0 - Math.max(...layout.tiers) * R.tierDropM - R.frameH / 2 - 0.17;
      pb.y = pa.y;
      const lineGeo = new THREE.BufferGeometry().setFromPoints([pa, pb]);
      const line = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color: css(look.counter), dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.85 }));
      line.computeLineDistances();
      object3d.add(line);
      lines.push(line);
      // The chord's real length, to two figures, and its shift to the nearest arcminute.
      const text = tv('vr.baseline', { au: chordAU.toFixed(2), body: bodyAU, shift: Math.round(shiftArcmin) });
      const l = label(text, { tone: 'counter', font: 'body', priority: 0.5 });
      // Under the chord's middle, nearer the viewer than the frames.
      const mid = pa.clone().lerp(pb, 0.5);
      l.mesh.position.copy(mid).add(new THREE.Vector3(0, -l.heightM * 1.8, 0));
      faceHead(l.mesh);
    }
    // The date of the visit on the screen and of the one pointed at.
    // Sized for the longest date there is, so none is ever cut.
    const longest = list.reduce((m, s) => {
      const d = formatDay(dateOf(s.frame.mjd), { year: true, lang });
      return d.length > m.length ? d : m;
    }, '');
    dateFor = { current: label(longest, { tone: 'accent', priority: 4 }), hover: label(longest, { tone: 'ink', priority: 3 }) };
    dateFor.current.wanted = false;
    dateFor.hover.wanted = false;
    // A and B, when two visits are compared, over their frames.
    tags = { a: label('A', { tone: 'accent', priority: 3.5 }), b: label('B', { tone: 'counter', priority: 3.5 }) };
    tags.a.wanted = false;
    tags.b.wanted = false;
    paintThumbs();
  }

  /** The date under the season's first visit, by season: hidden while a visit of that season shows its own. */
  let seasonLabels = new Map();

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
    [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].forEach(([x, y], k) => {
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
    const s = list[i];
    if (!s?.visit) return s?.status === 'reading' ? 4 : 3;
    if (i === current) return 1;
    if (i === hover) return 2;
    return 0;
  }

  /** A visit's cell in the atlas: its picture, or its placeholder while it has none. */
  function paintCell(actx, i, s) {
    const x = (i % COLS) * CELL_W;
    const y = Math.floor(i / COLS) * CELL_H;
    actx.save();
    actx.beginPath();
    actx.rect(x, y, CELL_W, CELL_H);
    actx.clip();
    const v = s.visit;
    if (v?.canvas) {
      const sw = v.canvas.width;
      const sh = v.canvas.height;
      const k = Math.max(CELL_W / sw, CELL_H / sh);
      actx.drawImage(v.canvas, x + CELL_W / 2 - (sw * k) / 2, y + CELL_H / 2 - (sh * k) / 2, sw * k, sh * k);
    } else {
      actx.fillStyle = look.paper2;
      actx.fillRect(x, y, CELL_W, CELL_H);
      actx.setLineDash([10, 8]);
      actx.lineWidth = 4;
      actx.strokeStyle = look.ruleStrong;
      actx.strokeRect(x + 6, y + 6, CELL_W - 12, CELL_H - 12);
      actx.setLineDash([]);
      const gone = s.status === 'failed' || s.status === 'dropped';
      actx.textAlign = 'center';
      actx.textBaseline = 'middle';
      if (gone) {
        actx.strokeStyle = look.counter;
        actx.lineWidth = 6;
        actx.beginPath();
        actx.moveTo(x + CELL_W / 2 - 22, y + CELL_H / 2 - 44);
        actx.lineTo(x + CELL_W / 2 + 22, y + CELL_H / 2);
        actx.moveTo(x + CELL_W / 2 + 22, y + CELL_H / 2 - 44);
        actx.lineTo(x + CELL_W / 2 - 22, y + CELL_H / 2);
        actx.stroke();
      }
      actx.fillStyle = gone ? look.counter : look.muted;
      actx.font = `500 50px ${FONTS.mono}`;
      actx.fillText(formatDay(dateOf(s.frame.mjd), { lang }), x + CELL_W / 2, y + CELL_H / 2 + (gone ? 40 : 0));
    }
    actx.restore();
  }

  /** Each visit's cell drawn into the atlas when what it shows changes. */
  function paintThumbs() {
    if (!mesh) return;
    const actx = atlasCanvas.getContext('2d');
    actx.imageSmoothingEnabled = true;
    actx.imageSmoothingQuality = 'high';
    let changed = false;
    list.forEach((s, i) => {
      const v = s.visit;
      const key = v ? `${v.frame.obsId}|${v.canvasVersion ?? 0}` : `${s.status}|${lang}`;
      if (quads[i].drawn !== key) {
        paintCell(actx, i, s);
        quads[i].drawn = key;
        changed = true;
      }
      setState(i, stateOf(i));
    });
    if (changed) atlas.needsUpdate = true;
  }

  function showDate(panel, i) {
    if (!panel) return;
    if (i < 0 || !list[i]) { panel.wanted = false; return; }
    const text = formatDay(dateOf(list[i].frame.mjd), { year: true, lang });
    if (panel.text !== text) {
      panel.text = text;
      panel.paint(text, panel === dateFor.current ? 'accent' : 'ink');
    }
    panel.wanted = true;
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

  let clock = 0;
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
    /** New statuses or pictures; the arc is rebuilt only when the visits themselves change. */
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
    /** Once a frame: the current visit easing forward, the pointed-at one growing, the glow, the dimming, the labels. */
    tick(dt, gazeYaw = 0) {
      if (!mesh) return;
      clock += dt;
      material.uniforms.time.value = clock;
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
      // The glow follows the visit on the screen.
      const target = current >= 0 ? ringPoint(quads[current].yaw, quads[current].tier, R.liftM * quads[current].lift + 0.01) : null;
      if (target) {
        if (glowMat.opacity < 0.02) glow.position.copy(target.p);
        else glow.position.lerp(target.p, Math.min(1, dt * 14));
        faceHead(glow);
      }
      glowMat.opacity += ((target ? 0.85 : 0) - glowMat.opacity) * Math.min(1, dt * 6);
      // The dates of the visit on the screen and the one pointed at, under their frames.
      for (const [panel, i] of [[dateFor?.current, current], [dateFor?.hover, hover]]) {
        if (panel?.wanted && i >= 0) {
          const q = quads[i];
          placeLabel(panel, q.yaw, q.tier, 'below', 1 + (R.hoverScale - 1) * q.grow);
          panel.mesh.position.addScaledVector(ringPoint(q.yaw, q.tier).n, R.liftM * q.lift + 0.02);
        }
      }
      // A season's month gives way while a visit of that season shows its own date.
      for (const l of seasonLabels.values()) {
        l.wanted = !(current >= 0 && quads[current].season === l.season) && !(hover >= 0 && quads[hover].season === l.season);
      }
      if (tags) {
        for (const [l, i] of [[tags.a, ab[0]], [tags.b, ab[1]]]) {
          l.wanted = i >= 0 && i < quads.length;
          if (l.wanted) placeLabel(l, quads[i].yaw, quads[i].tier, 'above', 1 + (R.hoverScale - 1) * quads[i].grow);
        }
      }
      settleLabels();
    },
    /** The two visits compared (Wipe, Difference), by their places in `visits`, or −1. */
    setAB(a, b) { ab = [a, b]; },
    /** The band's hue, for a new field. */
    setLook(next) {
      look = next;
      material.uniforms.accent.value.set(look.accent);
      glowMat.color.set(look.accent);
    },
    dispose() {
      for (const l of labels) l.dispose();
      for (const l of lines) { l.geometry.dispose(); l.material.dispose(); }
      if (backdrop) { backdrop.geometry.dispose(); backdrop.material.dispose(); }
      if (geo) geo.dispose();
      for (const d of disposables) d.dispose();
      atlasCanvas.width = 0;
      atlasCanvas.height = 0;
      object3d.removeFromParent();
    },
  };
}

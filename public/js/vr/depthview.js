/**
 * depthview.js — behind the viewer, the same field laid out in depth.
 *
 * Turn round from the screens and the field is there again as a small plate,
 * the visit on the main screen, at arm's length; from it a corridor runs away
 * from you. Every object in the field leaves the plate from its own pixel and
 * travels along its own line of sight as far as its distance on one
 * logarithmic scale in AU (depth3d.js): a ring for every power of ten, named
 * milestones (1 AU, Neptune's 30 AU, a parsec, a kiloparsec, a megaparsec, a
 * hundred), and a translucent shell where Planet X is predicted, left empty.
 * The field's few tenths of a degree are spread wide so its objects can be
 * told apart, and the sign at the mouth says by how much.
 *
 * What is placed, and by what: Gaia DR3 stars by their geometric distance
 * (Bailer-Jones et al. 2021) where it could be had, else by parallax measured
 * to 20 % or better, corrected for the zero-point, each with its ±1σ as a
 * segment along the ray; the asteroids and comets SkyBoT or JPL find in the
 * field, at their distance at the visit's moment, with their path over the
 * season; galaxies by spectroscopic redshift, as a comoving distance (Planck
 * 2018). Everything else in the field waits on the far shell, counted.
 * A filled mark is seen by SPHEREx in the visit on the screen; a hollow one
 * is in the catalogue only.
 */

import * as THREE from '../vendor/three.module.js';
import { fmt, formatDay } from '../i18n.js';
import { deltaRA } from '../wcs.js';
import { propagate, GAIA_EPOCH } from '../overlay.js';
import {
  placeByDistance, depthMetres, unknownShell, parallaxDistancePc, redshiftDistanceMpc, MIN_REDSHIFT, matchTarget,
  AU_PER_PC, DEPTH_TICKS, PLANET_X_AU, lookbackGyr, PLANET_X_V, PLANET_X_MAX_BETA, eclipticLatitude, decadeRings, viewFrame, fieldDirection,
} from './depth3d.js';
import { createPanel, FONTS, wrapText, fitText, wrapLines, button, chipWidth, roundRect } from './panel.js';
import { LAYOUT, minTextPx } from './layout.js';
import { lightTime } from './card.js';
import { formatRA, formatDec } from '../catalog.js';
import { tv } from './strings.js';

const D2R = Math.PI / 180;
const D = LAYOUT.depth;
const MJD_UNIX = 40587;

const POINT_VERTEX = /* glsl */ `
  attribute float sizeDeg;
  attribute vec3 tint;
  attribute float solid;
  attribute vec3 skyPos;
  uniform float morph;
  uniform float pxPerDeg;
  uniform float nearM;
  uniform float farM;
  uniform float falloff;
  varying vec3 vTint;
  varying float vSolid;
  varying float vDim;
  void main() {
    // Between where it is (its distance) and where it looks to be from the
    // Earth (every object at one distance on the sky): the morph.
    vec3 p = mix(position, skyPos, morph);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = max(3.0, sizeDeg * pxPerDeg);
    vTint = tint;
    vSolid = solid;
    // A little dimmer toward the far end, so the near reads as near (a depth cue, not a brightness).
    vDim = mix(1.0, falloff, clamp((length(position) - nearM) / (farM - nearM), 0.0, 1.0) * (1.0 - morph));
  }
`;

const POINT_FRAGMENT = /* glsl */ `
  varying vec3 vTint;
  varying float vSolid;
  varying float vDim;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float disc = 1.0 - smoothstep(0.7, 1.0, d);
    float ring = disc * smoothstep(0.42, 0.62, d);
    float a = mix(ring, disc, vSolid) * vDim;
    if (a < 0.02) discard;
    gl_FragColor = vec4(vTint * a, 1.0);
  }
`;

/**
 * The corridor for a field. `head` is where the viewer stood when the field
 * opened (a THREE.Vector3), `behind` the horizontal direction behind them,
 * `pxPerDeg` a shared uniform, `field` { ra, dec, radiusDeg, widthDeg,
 * heightDeg, target }.
 */
export function createDepthView({ head, behind, field, look, pxPerDeg, onAction }) {
  const group = new THREE.Group();
  group.name = 'depth';
  group.position.copy(head);

  // The corridor rises a little, so the ring of visits below does not cut it,
  // and turns a little aside, so it is seen three-quarter rather than end-on.
  const axis = behind.clone().normalize()
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), D.axisYawDeg * D2R)
    .multiplyScalar(Math.cos(D.axisPitchDeg * D2R));
  axis.y = Math.sin(D.axisPitchDeg * D2R);
  const frame = viewFrame([axis.x, axis.y, axis.z]);
  const spread = D.coneDeg / Math.max(0.02, field.radiusDeg);
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const color = (c) => new THREE.Color(c);
  const along = (r) => v3(frame.f).multiplyScalar(r);
  const cone = (r) => r * Math.tan(D.coneDeg * D2R);

  const disposables = [];
  const layers = {};
  /** 0: every object at its distance; 1: all on one sphere, as seen from the Earth. */
  const morph = { value: 0 };
  const morphTo = { from: 0, to: 0, t0: 0 };
  /** The level the pins drop to, a metre under the eye. */
  const PLANE_Y = -1.0;
  /** The sphere "as seen from the Earth" is drawn on, in metres. */
  const SKY_M = 3.2;
  const labels = [];
  const state = {
    gaia: null, bodies: [], galaxies: null, candidates: [], failed: [], depthAB: null,
    asking: true, target: field.target ?? null, bodyNote: false, gaiaLimit: null,
    beta: eclipticLatitude(field.ra, field.dec),
  };

  /** A position on the sky to a direction in the corridor. */
  function dirOf(ra, dec) {
    const cos = Math.cos(field.dec * D2R);
    return fieldDirection(deltaRA(ra, field.ra) * cos, dec - field.dec, frame, spread);
  }
  const unit = (d) => { const l = Math.hypot(...d); return [d[0] / l, d[1] / l, d[2] / l]; };

  /** A circle across the corridor at `r` metres, as line segments. */
  function circle(r, N, out) {
    const c = along(r);
    const R = cone(r);
    for (let k = 0; k < N; k++) {
      for (const kk of [k, k + 1]) {
        const a = (kk / N) * Math.PI * 2;
        out.push(
          c.x + R * (Math.cos(a) * frame.r[0] + Math.sin(a) * frame.u[0]),
          c.y + R * (Math.cos(a) * frame.r[1] + Math.sin(a) * frame.u[1]),
          c.z + R * (Math.cos(a) * frame.r[2] + Math.sin(a) * frame.u[2]),
        );
      }
    }
  }

  function lines(points, css, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const mat = new THREE.LineBasicMaterial({ color: color(css), transparent: true, opacity, depthWrite: false });
    const obj = new THREE.LineSegments(geo, mat);
    group.add(obj);
    return obj;
  }

  /* ---- the plate: the visit on the screen, at the corridor's mouth ---- */
  const plateMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide });
  const plateGeo = new THREE.BufferGeometry();
  {
    const hw = field.widthDeg / 2;
    const hh = field.heightDeg / 2;
    const corner = (e, n) => {
      const d = unit(fieldDirection(e, n, frame, spread));
      return [d[0] * D.nearM, d[1] * D.nearM, d[2] * D.nearM];
    };
    // East is on the left as the viewer faces the corridor, north up.
    const pts = [corner(hw, -hh), corner(-hw, -hh), corner(-hw, hh), corner(hw, hh)];
    plateGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
    plateGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    plateGeo.setIndex([0, 1, 2, 0, 2, 3]);
  }
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.renderOrder = 6;
  group.add(plate);
  disposables.push(plateGeo, plateMat);

  /* ---- rings, a ruler on the floor, the Planet X shell -------------- */
  const statics = [];
  {
    const pts = [];
    for (const au of decadeRings()) circle(depthMetres(au), 64, pts);
    statics.push(lines(pts, look.ruleStrong, 0.4));
    // The named distances that are not powers of ten, fainter still.
    const named = [];
    for (const t of DEPTH_TICKS) for (const au of [t.au, t.to].filter(Boolean)) circle(depthMetres(au), 64, named);
    statics.push(lines(named, look.neutral, 0.3));

    // The ruler: along the floor under the corridor, a tick at every power of ten.
    const floorY = -head.y + 0.002;
    const flat = new THREE.Vector3(frame.f[0], 0, frame.f[2]).normalize();
    const side = new THREE.Vector3(-flat.z, 0, flat.x);
    const onFloor = (r) => flat.clone().multiplyScalar(r * Math.cos(D.axisPitchDeg * D2R)).setY(floorY);
    const rp = [...onFloor(D.nearM).toArray(), ...onFloor(D.farM).toArray()];
    for (const au of decadeRings()) {
      const p = onFloor(depthMetres(au));
      const w = DEPTH_TICKS.some((t) => Math.abs(Math.log10(t.au) - Math.log10(au)) < 0.01) ? 0.12 : 0.05;
      rp.push(...p.clone().addScaledVector(side, -w).toArray(), ...p.clone().addScaledVector(side, w).toArray());
    }
    statics.push(lines(rp, look.neutral, 0.55));

    // Planet X's shell: the two circles where it begins and ends, and a faint
    // band on the corridor's wall between them. Left empty.
    const [r0, r1] = PLANET_X_AU.map((au) => depthMetres(au));
    const bandGeo = new THREE.CylinderGeometry(cone(r1), cone(r0), r1 - r0, 64, 1, true);
    // Built around +y with its top at +h/2: turn it onto the axis and stand it between the circles.
    bandGeo.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v3(frame.f)),
    ));
    bandGeo.translate(...along((r0 + r1) / 2).toArray());
    const bandMat = new THREE.MeshBasicMaterial({
      color: color(look.counter), transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    });
    const band = new THREE.Mesh(bandGeo, bandMat);
    band.renderOrder = 4;
    group.add(band);
    statics.push(band);
    const xp = [];
    for (const r of [r0, r1]) circle(r, 64, xp);
    statics.push(lines(xp, look.counter, Math.abs(state.beta) <= PLANET_X_MAX_BETA ? 0.6 : 0.25));
  }

  /* ---- labels: sized as angles, turned to the head ------------------- */
  function addLabel(textLines, pos, { tone = 'ink', width = 22, keep = false, priority = keep ? 1 : 3 } = {}) {
    const p = v3(pos);
    const dist = Math.max(0.5, p.length());
    // The first line at body size (1.5°) at whatever distance it stands.
    const widthM = 2 * dist * Math.tan((width / 2) * D2R);
    const pxPerM = 640 / widthM;
    const px = minTextPx(pxPerM, dist);
    // Each line of text wrapped to the label's width, never cut: two lines at most each.
    const fontOf = (k) => `${k === 0 ? 500 : 400} ${k === 0 ? px : Math.round(px * 0.92)}px ${k === 0 ? FONTS.body : FONTS.mono}`;
    const W0 = Math.round(widthM * pxPerM);
    const wrapped = textLines.map((text, k) => wrapLines(fontOf(k), text, W0 - 12, 3));
    const count = wrapped.reduce((n, l) => n + l.length, 0);
    const heightM = ((px * 1.35) * count + px * 0.4) / pxPerM;
    const panel = createPanel({ widthM, heightM, pxPerM, name: 'depth-label' });
    panel.draw((ctx, W) => {
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(8, 8, 16, 0.95)';
      ctx.shadowBlur = 8;
      let row = 0;
      wrapped.forEach((ls, k) => {
        ctx.fillStyle = k === 0 ? (look[tone] ?? look.ink) : look.muted;
        ctx.font = fontOf(k);
        for (const l of ls) { ctx.fillText(l, W / 2, px * (1.05 + 1.35 * row)); row += 1; }
      });
    });
    panel.mesh.renderOrder = 12;
    panel.mesh.material.depthTest = false;
    if (keep) {
      panel.mesh.position.copy(p).addScaledVector(v3(frame.u), heightM * 0.75);
    } else {
      // Out from the axis to the corridor's wall, with a thin line back to its object,
      // so names in a crowded field do not stand on each other.
      const a = along(p.dot(v3(frame.f)));
      const out = p.clone().sub(a);
      if (out.lengthSq() < 1e-6) out.copy(v3(frame.r));
      out.normalize();
      const r = p.length();
      const at = a.clone().addScaledVector(out, cone(r) * (1.15 + 0.12 * (labels.filter((l) => !l.keep).length % 3)));
      panel.mesh.position.copy(at);
      const lead = lines([...p.toArray(), ...at.toArray()], look[tone] ?? look.ink, 0.5);
      lead.userData.truth = true;
      panel.lead = lead;
    }
    // Turned before it joins the corridor, whose origin is the viewer.
    panel.mesh.lookAt(0, 0, 0);
    panel.keep = keep;
    panel.priority = priority;
    group.add(panel.mesh);
    labels.push(panel);
    return panel;
  }

  // The milestones, over their ticks on the floor's ruler: seen from the
  // head the floor rises toward the far end, so they stand one above the
  // next instead of on one another as the rings' edges would.
  {
    const flat = new THREE.Vector3(frame.f[0], 0, frame.f[2]).normalize();
    const side = new THREE.Vector3(-flat.z, 0, flat.x);
    DEPTH_TICKS.forEach((t, k) => {
      const r = depthMetres(t.to ? Math.sqrt(t.au * t.to) : t.au) * Math.cos(D.axisPitchDeg * D2R);
      // Either side of the ruler in turn: toward the far end the floor's
      // perspective packs the ticks close, and their names would touch.
      const p = flat.clone().multiplyScalar(r).addScaledVector(side, (k % 2 ? 1 : -1) * (0.25 + r * 0.06)).setY(-head.y + 0.02);
      addLabel([tv(`vr.tick.${t.key}`)], p.toArray(), { tone: 'neutral', width: 14, keep: true });
    });
  }

  /* ---- the sign at the mouth, and Planet X's -------------------------- */
  const sign = createPanel({ widthM: 1.05, heightM: 1.05, pxPerM: 760, name: 'depth-sign', opaque: true });
  {
    const p = v3(frame.f).multiplyScalar(1.2).addScaledVector(v3(frame.r), -1.7);
    p.y = -0.45;
    sign.mesh.position.copy(p);
    sign.mesh.lookAt(0, -0.15, 0);
    group.add(sign.mesh);
  }
  const xSign = createPanel({ widthM: 1.0, heightM: 1.0, pxPerM: 640, name: 'planet-x' });
  {
    const r = depthMetres(600);
    const p = along(r).addScaledVector(v3(frame.r), cone(r) * 1.25);
    xSign.mesh.position.copy(p);
    xSign.mesh.scale.setScalar(r / 2.1);
    xSign.mesh.lookAt(0, 0, 0);
    xSign.mesh.renderOrder = 12;
    xSign.mesh.material.depthTest = false;
    group.add(xSign.mesh);
  }

  const signType = { body: minTextPx(760, 2.1), heading: minTextPx(760, 2.1, 2.2) };
  function drawSign() {
    sign.draw((ctx, W, H) => {
      // Every word in full: the sign is as tall as its text, drawn on a plate that fits it.
      const x = 30;
      const w = W - 60;
      const lh = signType.body + 8;
      const paragraphs = [];
      const g = state.gaia;
      const counts = state.asking && !g ? tv('vr.depthAsking')
        : g ? tv('vr.depthUnknown', { n: g.unknown, m: g.known + g.unknown, g: fmt(state.gaiaLimit, 1) }) : '';
      paragraphs.push([tv('vr.depthScale', { n: Math.round(spread) }), 'muted']);
      paragraphs.push([tv('vr.legendCue'), 'neutral']);
      if (counts) paragraphs.push([counts, 'accent']);
      if (state.candidates.length) paragraphs.push([tv('vr.depthUnmatched', { n: state.candidates.length }), 'counter']);
      if (state.bodyNote) paragraphs.push([tv('vr.nearFar'), 'counter']);
      if (state.failed.length) paragraphs.push([state.failed.map((what) => tv('vr.depthFailed', { what })).join(' · '), 'counter']);
      const titleLines = wrapLines(`600 ${signType.heading}px ${FONTS.display}`, tv('vr.depthTitle'), w, 3);
      const bodyLines = paragraphs.map(([text]) => wrapLines(`400 ${signType.body}px ${FONTS.body}`, text, w, 99).length);
      const need = 24 + titleLines.length * signType.heading * 1.15 + 14 + bodyLines.reduce((n, k) => n + k * lh + 6, 0) + 20;
      const Hc = Math.min(H, need);
      ctx.fillStyle = look.paper;
      ctx.fillRect(0, 0, W, Hc);
      ctx.lineWidth = 4;
      ctx.strokeStyle = look.ruleStrong;
      ctx.strokeRect(2, 2, W - 4, Hc - 4);
      let y = signType.heading + 18;
      ctx.fillStyle = look.ink;
      ctx.font = `600 ${signType.heading}px ${FONTS.display}`;
      for (const l of titleLines) { ctx.fillText(l, x, y); y += signType.heading * 1.15; }
      y += lh - signType.heading * 1.15 + 14;
      ctx.font = `400 ${signType.body}px ${FONTS.body}`;
      for (const [text, tone] of paragraphs) {
        ctx.fillStyle = look[tone];
        y = wrapText(ctx, text, x, y, w, lh, 99) + 6;
      }
    });
    xSign.draw((ctx, W, H) => {
      const px = 34;
      const here = Math.abs(state.beta) <= PLANET_X_MAX_BETA;
      const d = state.depthAB;
      const v = { nominal: fmt(PLANET_X_V.nominal, 1), faint: fmt(PLANET_X_V.faint, 1) };
      const text = !here
        ? tv('vr.planetXNo', { beta: `${state.beta >= 0 ? '+' : '−'}${fmt(Math.abs(state.beta), 0)}`, max: PLANET_X_MAX_BETA })
        : d != null
          ? tv('vr.planetXNote', { ...v, ab: fmt(d, 1), a: fmt(PLANET_X_V.nominal - d, 1), b: fmt(PLANET_X_V.faint - d, 1) })
          : tv('vr.planetXWait', v);
      const title = wrapLines(`600 ${px + 6}px ${FONTS.display}`, tv('vr.planetX'), W - 24, 2);
      const body = wrapLines(`400 ${px}px ${FONTS.body}`, text, W - 24, 99);
      const Hc = Math.min(H, 20 + title.length * (px + 12) + body.length * (px + 8) + 24);
      // A dark plate under the words: the corridor's rings run behind it.
      ctx.fillStyle = 'rgba(10, 10, 18, 0.82)';
      ctx.beginPath();
      ctx.roundRect(0, 0, W, Hc, 18);
      ctx.fill();
      let y = px + 14;
      ctx.fillStyle = look.counter;
      ctx.font = `600 ${px + 6}px ${FONTS.display}`;
      for (const l of title) { ctx.fillText(l, 12, y); y += px + 12; }
      ctx.font = `400 ${px}px ${FONTS.body}`;
      ctx.fillStyle = look.ink;
      for (const l of body) { ctx.fillText(l, 12, y); y += px + 8; }
    });
  }
  drawSign();

  /* ---- points and their lines --------------------------------------- */
  function clearLayer(name) {
    const l = layers[name];
    if (!l) return;
    for (const o of l.objects) { o.removeFromParent(); o.geometry.dispose(); o.material.dispose(); }
    for (const p of l.labels) { dropLead(p); p.dispose(); labels.splice(labels.indexOf(p), 1); }
    delete layers[name];
  }

  function dropLead(p) {
    if (!p.lead) return;
    p.lead.removeFromParent();
    p.lead.geometry.dispose();
    p.lead.material.dispose();
  }

  /** Points `{ pos, sizeDeg, color, solid, known }`, each with a line back to the plate, and ±1σ segments. */
  function setLayer(name, items, { segments = [], lineColor = look.ruleStrong, plateLines = true } = {}) {
    clearLayer(name);
    const layer = { objects: [], labels: [] };
    layers[name] = layer;
    if (!items.length) return layer;
    const pos = new Float32Array(items.length * 3);
    const size = new Float32Array(items.length);
    const tint = new Float32Array(items.length * 3);
    const solid = new Float32Array(items.length);
    const skyPos = new Float32Array(items.length * 3);
    items.forEach((it, i) => {
      pos.set(it.pos, i * 3);
      const u = unit(it.pos);
      skyPos.set([u[0] * SKY_M, u[1] * SKY_M, u[2] * SKY_M], i * 3);
      size[i] = it.sizeDeg;
      const c = color(it.color);
      tint.set([c.r, c.g, c.b], i * 3);
      solid[i] = it.solid ? 1 : 0;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('sizeDeg', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
    geo.setAttribute('solid', new THREE.BufferAttribute(solid, 1));
    geo.setAttribute('skyPos', new THREE.BufferAttribute(skyPos, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { pxPerDeg, morph, nearM: { value: D.nearM }, farM: { value: D.unknownM }, falloff: { value: D.falloff } },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 7;
    group.add(points);
    layer.objects.push(points);
    // From each object's own pixel on the plate to where it stands.
    const lp = [];
    if (plateLines) {
      for (const it of items) {
        if (!it.known) continue;
        const u = unit(it.pos);
        lp.push(u[0] * D.nearM, u[1] * D.nearM, u[2] * D.nearM, ...it.pos);
      }
    }
    for (const [a, b] of segments) lp.push(...a, ...b);
    if (lp.length) layer.objects.push(lines(lp, lineColor, 0.22));
    // A line from each object down to one level, like a star map's pins: the
    // eye reads depth from where the pins stand.
    const drop = [];
    for (const it of items) if (it.known) drop.push(...it.pos, it.pos[0], PLANE_Y, it.pos[2]);
    if (drop.length) {
      const pins = lines(drop, lineColor, 0.16);
      pins.userData.truth = true;
      layer.objects.push(pins);
    }
    for (const o of layer.objects) if (o.isLineSegments) o.userData.truth = true;
    return layer;
  }

  /* ---- pointing at objects, filtering them, and the way back ------------ */
  /** What can be pointed at, by class: `{ pos: [x,y,z] in the corridor, card() }`. */
  let scaleNow = 1;
  let settleFrame = 0;
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  /** Labels by priority, each hidden if it would cover one shown before it, by angle from the head. */
  function settleLabels(headWorld) {
    group.updateMatrixWorld();
    const truth = morph.value < 0.05;
    const shownBoxes = [];
    // The Planet X note is always shown, and nothing may stand on it.
    const fixedBox = { mesh: xSign.mesh, widthM: xSign.widthM, heightM: xSign.heightM * 0.7, priority: 99, fixed: true };
    const order = [fixedBox, ...labels.filter((l) => l.on !== false && (l.keep || truth))].sort((a, b) => b.priority - a.priority);
    for (const l of order) {
      const p = l.mesh.getWorldPosition(tmpA).sub(headWorld);
      const d = Math.max(0.1, p.length());
      const s = l.mesh.getWorldScale(tmpB).x;
      const box = {
        yaw: Math.atan2(p.x, -p.z), el: Math.asin(Math.max(-1, Math.min(1, p.y / d))),
        hw: Math.atan((l.widthM * s) / 2 / d) * 0.8, hh: Math.atan((l.heightM * s) / 2 / d),
      };
      const hit = shownBoxes.some((o) => Math.abs(Math.atan2(Math.sin(o.yaw - box.yaw), Math.cos(o.yaw - box.yaw))) < o.hw + box.hw
        && Math.abs(o.el - box.el) < o.hh + box.hh);
      if (!l.fixed) {
        l.mesh.visible = !hit;
        if (l.lead) l.lead.visible = !hit;
      }
      if (!hit || l.fixed) shownBoxes.push(box);
    }
  }
  const pickables = { gaia: [], gaiaUnknown: [], bodies: [], galaxies: [], candidates: [], target: [] };
  const shown = { stars: true, bodies: true, galaxies: true, unknown: true };
  const classOf = { gaia: 'stars', target: 'stars', gaiaUnknown: 'unknown', candidates: 'unknown', bodies: 'bodies', galaxies: 'galaxies' };

  function applyFilters() {
    const truth = morph.value < 0.05;
    for (const [name, layer] of Object.entries(layers)) {
      const on = shown[classOf[name]] ?? true;
      for (const o of layer.objects) { o.userData.on = on; o.visible = on && (!o.userData.truth || truth); }
      for (const l of layer.labels) { l.on = on; l.mesh.visible = on && truth; if (l.lead) { l.lead.userData.on = on; l.lead.visible = on && truth; } }
    }
  }

  const controls = createPanel({ widthM: 1.15, heightM: 0.42, pxPerM: 760, name: 'depth-controls', opaque: true });
  {
    // Beside the sign, at arm's reach and a little lower: pressed often.
    const p = v3(frame.f).multiplyScalar(1.15).addScaledVector(v3(frame.r), -1.65);
    p.y = -0.95;
    controls.mesh.position.copy(p);
    controls.mesh.lookAt(0, -0.3, 0);
    group.add(controls.mesh);
  }
  let hoverId = null;
  function drawControls() {
    applyFilters();
    controls.draw((ctx, W, H, hits) => {
      roundRect(ctx, 2, 2, W - 4, H - 4, 24);
      ctx.fillStyle = look.paper;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = look.ruleStrong;
      ctx.stroke();
      const px = minTextPx(760, 1.9);
      const font = `500 ${px}px ${FONTS.body}`;
      const bh = Math.round(px * 1.8);
      let x = 18;
      let y = 16;
      const chip = (id, label, on = false, data = null) => {
        const w = chipWidth(ctx, font, label, bh, 0.09 * 760);
        if (x + w > W - 18) { x = 18; y += bh + 12; }
        button(ctx, hits, look, { x, y, w, h: bh, label, id, font, on, hover: hoverId === `${id}:${data ?? ''}`, data });
        x += w + 12;
      };
      chip('back', tv('vr.backSky'));
      chip('flip', tv('vr.depthFront'));
      chip('morph', morphTo.to > 0.5 ? tv('vr.trueDistances') : tv('vr.asSeen'), morphTo.to > 0.5);
      chip('reset', tv('vr.resetView'));
      // What a metre along the corridor is worth now, in distance.
      const decades = Math.log10((D.maxPc * AU_PER_PC) / D.minAU);
      const perM = 10 ** (decades / (D.farM - D.nearM) / scaleNow);
      const f = perM >= 100 ? Math.round(perM).toLocaleString('en-US').replace(/,/g, ' ') : perM.toFixed(1);
      ctx.font = `400 ${Math.round(px * 0.9)}px ${FONTS.mono}`;
      ctx.fillStyle = look.neutral;
      ctx.fillText(tv('vr.scaleNow', { f, s: scaleNow.toFixed(scaleNow < 1 ? 2 : 1) }), 18, H - 18);
      x = 18;
      y += bh + 12;
      const g = state.gaia;
      chip('filter', tv('vr.filterStars', { n: g?.known ?? 0, m: (g?.known ?? 0) + (g?.unknown ?? 0) }), shown.stars, 'stars');
      chip('filter', tv('vr.filterBodies', { n: state.bodies.length }), shown.bodies, 'bodies');
      chip('filter', tv('vr.filterGalaxies', { n: state.galaxies?.length ?? 0, m: state.galaxyCount ?? 0 }), shown.galaxies, 'galaxies');
      chip('filter', tv('vr.filterUnknown', { n: (g?.unknown ?? 0) + state.candidates.length }), shown.unknown, 'unknown');
    });
  }
  controls.mesh.userData.hover = (uv) => {
    const h = uv ? controls.hitAt(uv) : null;
    const id = h ? `${h.id}:${h.data ?? ''}` : null;
    if (id !== hoverId) { hoverId = id; drawControls(); }
  };
  controls.mesh.userData.pick = (uv) => {
    const h = controls.hitAt(uv);
    if (!h) return;
    if (h.id === 'filter') { shown[h.data] = !shown[h.data]; applyFilters(); drawControls(); return; }
    if (h.id === 'morph') { api.toggleMorph(); return; }
    onAction?.(h.id);
  };
  controls.mesh.userData.pickable = (uv) => Boolean(controls.hitAt(uv));
  drawControls();

  /** Labels are few: the field's own target, the bodies, a galaxy or two. */
  const objectLabels = () => labels.filter((l) => !l.keep).length;

  function placeAlong(dir, distAU) {
    const u = unit(dir);
    const r = distAU == null ? unknownShell() : depthMetres(distAU);
    return [u[0] * r, u[1] * r, u[2] * r];
  }

  const api = {
    group,
    /** The visit on the screen, as the plate's picture. */
    setPlate(texture) {
      if (plateMat.map === texture) return;
      plateMat.map = texture;
      plateMat.needsUpdate = true;
    },
    /** The object a world ray points at (within 1.5°), as a card's content, or null. */
    pick(origin, dir) {
      group.updateMatrixWorld();
      const inv = group.matrixWorld.clone().invert();
      const o = origin.clone().applyMatrix4(inv);
      const d = dir.clone().transformDirection(inv);
      let best = null;
      let bestAngle = 1.5 * D2R;
      for (const [name, list] of Object.entries(pickables)) {
        if (!(shown[classOf[name]] ?? true)) continue;
        for (const it of list) {
          const to = v3(it.pos).sub(o);
          const a = to.angleTo(d);
          if (a < bestAngle) { bestAngle = a; best = { it, distance: to.length() }; }
        }
      }
      if (!best) return null;
      const world = v3(best.it.pos).applyMatrix4(group.matrixWorld);
      return { card: best.it.card(), at: world, distance: best.distance };
    },
    /** Between true distances and as seen from the Earth, eased over 1.2 s. */
    toggleMorph() {
      morphTo.from = morph.value;
      morphTo.to = morphTo.to > 0.5 ? 0 : 1;
      morphTo.t0 = performance.now();
      drawControls();
    },
    get apparent() { return morphTo.to > 0.5; },
    /** The scene's scale, for the readout: what a metre along the corridor is worth. */
    setScale(s) {
      if (Math.abs(s - scaleNow) / scaleNow < 0.02 && s !== 1) return;
      scaleNow = s;
      drawControls();
    },
    /** The controls, for the field to make pressable. */
    controls: controls.mesh,
    /** The depth one visit reaches, for Planet X's sign. */
    setDepth(ab) { state.depthAB = ab; drawSign(); },
    /**
     * Gaia DR3 rows (surveySources), with Bailer-Jones distances by source
     * id when they came (`bj`: Map id → { r, lo, hi } in pc), or an Error.
     * `detected(ra, dec)` says whether SPHEREx sees the source in the visit on the screen.
     */
    setGaia(rows, { bj = null, epoch = 2026, detected = () => false, limit = null } = {}) {
      state.gaiaLimit = limit;
      if (rows instanceof Error) {
        state.failed.push('Gaia DR3');
        state.gaia = { known: 0, unknown: 0 };
        state.asking = false;
        drawSign();
        return;
      }
      const objs = rows.map((r) => {
        const at = propagate(r, epoch, GAIA_EPOCH);
        // A geometric distance is taken only where it is itself known to 20 %:
        // for a faint star it is mostly the prior, and that is not a measurement.
        const g0 = bj?.get(r.id);
        const geom = g0 && (g0.hi - g0.lo) / (2 * g0.r) <= 0.2 ? g0 : null;
        const plx = geom ? null : parallaxDistancePc(r.plx, r.plxErr);
        const pc = geom?.r ?? plx?.pc ?? null;
        return {
          id: r.id, dir: dirOf(at.ra, at.dec), au: pc ? pc * AU_PER_PC : null, mag: r.mag, pc, src: geom ? 'bj' : plx ? 'plx' : null,
          lo: geom?.lo ?? plx?.lo ?? null, hi: geom?.hi ?? plx?.hi ?? null, ra: at.ra, dec: at.dec,
        };
      });
      const placed = placeByDistance(objs);
      const known = placed.filter((p) => p.known).length;
      state.gaia = { known, unknown: placed.length - known };
      const segments = objs.filter((o) => o.pc && o.lo && o.hi).map((o) => [placeAlong(o.dir, o.lo * AU_PER_PC), placeAlong(o.dir, o.hi * AU_PER_PC)]);
      const items = placed.map((p, i) => ({
        pos: p.pos, known: p.known,
        // Brighter is larger; a star without a distance is a dim speck on the shell.
        sizeDeg: Math.max(0.16, Math.min(0.8, 0.8 - 0.05 * ((objs[i].mag ?? 18) - 8))) * (p.known ? 1 : 0.7),
        color: p.known ? look.ink : look.ruleStrong,
        solid: detected(objs[i].ra, objs[i].dec),
      }));
      const knownItems = items.filter((it) => it.known);
      const knownObjs = objs.filter((o, i) => placed[i].known);
      const layer = setLayer('gaia', knownItems, { segments, lineColor: look.neutral });
      setLayer('gaiaUnknown', items.filter((it) => !it.known), { plateLines: false });
      const fixed = (pc) => fmt(pc, pc < 10 ? 2 : pc < 100 ? 1 : 0);
      const starCard = (o, seen) => () => ({
        title: `Gaia DR3 ${o.id}`,
        lines: [
          { text: `${tv('vr.cardStar')} · G ${fmt(o.mag, 1)}`, tone: 'muted' },
          o.pc
            ? { text: tv(o.src === 'bj' ? 'vr.cardBJ' : 'vr.cardPlx', { pc: fixed(o.pc), lo: fixed(o.lo), hi: fixed(o.hi) }), tone: 'accent' }
            : { text: tv('vr.cardStarNoDist'), tone: 'counter' },
          ...(o.pc ? [{ text: lightTime(o.pc * AU_PER_PC) }] : []),
          { text: tv(seen ? 'vr.cardStarSeen' : 'vr.cardStarNotSeen'), tone: seen ? 'ink' : 'neutral' },
          { text: `${formatRA(o.ra)}  ${formatDec(o.dec)}`, mono: true, tone: 'neutral' },
        ],
      });
      pickables.gaia = knownObjs.map((o, i) => ({ pos: knownItems[i].pos, card: starCard(o, knownItems[i].solid) }));
      const unknownObjs = objs.filter((o, i) => !placed[i].known);
      pickables.gaiaUnknown = items.filter((it) => !it.known).map((it, i) => ({ pos: it.pos, card: starCard(unknownObjs[i], it.solid) }));
      // The field's own target, named, with where its distance comes from:
      // the Gaia source it is (by its id, or within 3″ and moving within 20 %
      // of its own motion), else a published parallax, else nothing.
      const t = state.target;
      if (t) {
        const hit = matchTarget(t, rows, epoch);
        const o = hit ? objs[rows.indexOf(hit)] : null;
        const fixed = (pc) => fmt(pc, pc < 10 ? 2 : 0);
        if (o?.pc) {
          layer.labels.push(addLabel([t.label, tv(o.src === 'bj' ? 'vr.distBJ' : 'vr.distPlx', { pc: fixed(o.pc) })], placed[objs.indexOf(o)].pos, { tone: 'accent', priority: 6 }));
        } else {
          const at = propagate(t, epoch, t.epoch ?? GAIA_EPOCH);
          const lit = !o && t.plx > 0 ? 1000 / t.plx : null;
          const pos = placeAlong(dirOf(at.ra, at.dec), lit ? lit * AU_PER_PC : null);
          if (lit) {
            const own = setLayer('target', [{ pos, sizeDeg: 1.0, color: look.accent, solid: detected(at.ra, at.dec), known: true }]);
            own.labels.push(addLabel([t.label, tv('vr.distLit', { pc: fixed(lit), ref: t.ref })], pos, { tone: 'accent', priority: 6 }));
          } else {
            layer.labels.push(addLabel([t.label, tv('vr.notMeasured')], pos, { tone: 'accent', priority: 6 }));
          }
        }
      }
      layer.labels.push(addLabel([tv('vr.unknown')], along(unknownShell()).addScaledVector(v3(frame.u), cone(unknownShell()) * 0.7).toArray(), { tone: 'neutral', width: 16, priority: 2 }));
      state.asking = false;
      drawSign();
      drawControls();
    },
    /**
     * The solar-system bodies at the visit on the screen (SkyBoT's or JPL's,
     * with dGeo), each with its path over the season: `tracks` Map name →
     * [{ ra, dec, au, mjd }].
     */
    setBodies(bodies, tracks = new Map()) {
      if (bodies instanceof Error) {
        if (!state.failed.includes('SkyBoT')) state.failed.push('SkyBoT');
        drawSign();
        return;
      }
      const withDistance = bodies.filter((b) => Number.isFinite(b.dGeo) && b.dGeo > 0);
      state.bodies = withDistance;
      state.bodyNote = withDistance.length > 0;
      const items = withDistance.map((b) => ({ pos: placeAlong(dirOf(b.ra, b.dec), b.dGeo), sizeDeg: 1.0, color: look.counter, solid: Boolean(b.seen), known: true }));
      const layer = setLayer('bodies', items, { lineColor: look.counter });
      pickables.bodies = withDistance.map((b, i) => ({
        pos: items[i].pos,
        card: () => ({
          title: b.num ? `(${b.num}) ${b.name}` : b.name,
          lines: [
            { text: `${tv('vr.cardBody')}${b.cls ? ` · ${b.cls}` : ''}${Number.isFinite(b.mag) ? ` · V ${fmt(b.mag, 1)}` : ''}`, tone: 'muted' },
            { text: tv('vr.cardBodyAt', { au: fmt(b.dGeo, 3) }), tone: 'counter' },
            { text: lightTime(b.dGeo) },
            { text: tv(b.seen ? 'vr.cardStarSeen' : 'vr.cardStarNotSeen'), tone: b.seen ? 'ink' : 'neutral' },
          ],
        }),
      }));
      const paths = [];
      withDistance.forEach((b) => {
        const track = tracks.get(b.name) ?? [];
        if (track.length < 2) return;
        const pts = track.map((p) => new THREE.Vector3(...placeAlong(dirOf(p.ra, p.dec), p.au)));
        for (let k = 1; k < pts.length; k++) paths.push(...pts[k - 1].toArray(), ...pts[k].toArray());
      });
      if (paths.length) layer.objects.push(lines(paths, look.counter, 0.85));
      const room = Math.max(0, Math.min(3, D.maxLabels - objectLabels()));
      withDistance.slice(0, room).forEach((b, i) => {
        const name = b.num ? `(${b.num}) ${b.name}` : b.name;
        const track = tracks.get(b.name) ?? [];
        const day = (mjd) => formatDay(new Date((mjd - MJD_UNIX) * 86400000));
        const second = track.length >= 2
          ? tv('vr.bodyPath', { au: fmt(b.dGeo, 2), from: day(track[0].mjd), to: day(track.at(-1).mjd) })
          : tv('vr.bodyAt', { au: fmt(b.dGeo, 2) });
        layer.labels.push(addLabel([name, second], items[i].pos, { tone: 'counter', priority: 5 }));
      });
      drawSign();
      drawControls();
    },
    /** SIMBAD galaxies with a spectroscopic redshift, or an Error. */
    setGalaxies(list) {
      if (list instanceof Error) { state.failed.push('SIMBAD'); state.galaxies = []; drawSign(); return; }
      const objs = list.map((g) => {
        const mpc = g.z >= MIN_REDSHIFT ? redshiftDistanceMpc(g.z) : null;
        return { g, dir: dirOf(g.ra, g.dec), mpc, au: mpc ? mpc * 1e6 * AU_PER_PC : null };
      });
      state.galaxies = objs.filter((o) => o.au);
      state.galaxyCount = objs.length;
      const items = objs.map((o) => ({ pos: placeAlong(o.dir, o.au), sizeDeg: 0.75, color: look.accent, solid: false, known: Boolean(o.au) }));
      const layer = setLayer('galaxies', items, { lineColor: look.accentDim });
      pickables.galaxies = objs.map((o, i) => ({
        pos: items[i].pos,
        card: () => ({
          title: o.g.name,
          lines: [
            { text: tv('vr.cardGalaxy'), tone: 'muted' },
            o.au ? { text: tv('vr.cardGalaxyAt', { z: fmt(o.g.z, 4), mpc: fmt(o.mpc, 0) }), tone: 'accent' } : { text: `z ${fmt(o.g.z, 4)} · ${tv('vr.unknown')}`, tone: 'counter' },
            ...(o.au ? [{ text: lightTime(0, { lookbackGyr: lookbackGyr(o.g.z) }) }] : []),
            { text: `${formatRA(o.g.ra)}  ${formatDec(o.g.dec)}`, mono: true, tone: 'neutral' },
          ],
        }),
      }));
      const room = Math.max(0, Math.min(2, D.maxLabels - objectLabels()));
      objs.filter((o) => o.au).slice(0, room).forEach((o) => {
        layer.labels.push(addLabel([o.g.name, tv('vr.galaxyAt', { z: fmt(o.g.z, 4), mpc: fmt(o.mpc, 0) })], placeAlong(o.dir, o.au), { tone: 'accent', priority: 4 }));
      });
      drawSign();
      drawControls();
    },
    /** SPHEREx's own finds with no catalogue match: on the far shell, as candidates. */
    setCandidates(list) {
      state.candidates = list;
      const items = list.map((c) => ({ pos: placeAlong(dirOf(c.ra, c.dec), null), sizeDeg: 1.0, color: look.counter, solid: false, known: false }));
      const layer = setLayer('candidates', items, { plateLines: false });
      pickables.candidates = list.map((c, i) => ({
        pos: items[i].pos,
        card: () => ({ title: tv('vr.candidate'), lines: [{ text: tv('vr.cardCandidate'), tone: 'counter' }, { text: `${formatRA(c.ra)}  ${formatDec(c.dec)}`, mono: true, tone: 'neutral' }] }),
      }));
      if (list.length && objectLabels() < D.maxLabels) layer.labels.push(addLabel([tv('vr.candidate')], items[0].pos, { tone: 'counter', width: 12 }));
      drawSign();
      drawControls();
    },
    /** Once a frame: labels near the viewer keep turning to face them as they move. */
    tick(headWorld) {
      // Every few frames, the names that would cover one another as seen
      // from where the viewer now stands: the more important one is shown.
      if (++settleFrame % 8 === 0) settleLabels(headWorld);
      if (morph.value !== morphTo.to) {
        const k = Math.min(1, (performance.now() - morphTo.t0) / 1200);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        morph.value = morphTo.from + (morphTo.to - morphTo.from) * e;
        // Lines and names belong to the distances: they go while the field is flat.
        const truth = morph.value < 0.05;
        group.traverse((o) => { if (o.userData.truth) o.visible = truth && o.userData.on !== false; });
        for (const l of labels) if (!l.keep) l.mesh.visible = truth && l.on !== false;
      }
      group.updateMatrixWorld();
      const local = group.worldToLocal(headWorld.clone());
      for (const l of labels) {
        if (l.mesh.position.distanceTo(local) < D.faceWithinM) l.mesh.lookAt(headWorld);
      }
    },
    dispose() {
      for (const name of Object.keys(layers)) clearLayer(name);
      for (const l of labels.splice(0)) { dropLead(l); l.dispose(); }
      for (const o of statics) { o.geometry.dispose(); o.material.dispose(); }
      sign.dispose();
      xSign.dispose();
      controls.dispose();
      for (const d of disposables) d.dispose();
      group.removeFromParent();
    },
  };
  return api;
}

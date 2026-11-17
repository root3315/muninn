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
import { fmt, formatDay, fmtDate } from '../i18n.js';
import { deltaRA, separation } from '../wcs.js';
import { propagate, GAIA_EPOCH } from '../overlay.js';
import {
  placeByDistance, depthMetres, unknownShell, starDistance, galaxyDistance, matchTarget,
  AU_PER_PC, DEPTH_TICKS, PLANET_X_AU, lookbackGyr, PLANET_X_V, PLANET_X_MAX_BETA, eclipticLatitude, decadeRings, viewFrame, fieldDirection, motionPath,
} from './depth3d.js';
import { createPanel, FONTS, wrapText, fitText, wrapLines, button, chipWidth, roundRect } from './panel.js';
import { LAYOUT, minTextPx } from './layout.js';
import { lightTime } from './card.js';
import { depthStep, DEPTH_IDLE } from './depthmodes.js';
import { formatRA, formatDec } from '../catalog.js';
import { tv } from './strings.js';
import { markWords } from './markdepth.js';
import { createBeam, createRibbon } from './beam.js';

const D2R = Math.PI / 180;
const D = LAYOUT.depth;
const MJD_UNIX = 40587;
/** How far either way the stars' clock runs: years. */
const STAR_YEARS = 10000;
/** How fast the stars' clock runs at ×1: years a second. */
const CLOCK_YPS = 400;
/** How long a jump of the clock takes, eased: ms. */
const READOUT_EASE_MS = 600;
/** Stars per cubic parsec near the Sun, all kinds (about 0.1), and how far the corridor's emptiness note counts. */
const LOCAL_STARS_PC3 = 0.1;
const CONE_FAR_PC = 200;

const POINT_VERTEX = /* glsl */ `
  attribute float sizeDeg;
  attribute vec3 tint;
  attribute float solid;
  attribute vec3 pA;
  attribute vec3 pB;
  attribute vec3 pD;
  attribute vec3 pE;
  uniform float when;
  uniform float pxPerDeg;
  uniform float nearM;
  uniform float farM;
  uniform float falloff;
  uniform float dim;
  varying vec3 vTint;
  varying float vSolid;
  varying float vDim;
  void main() {
    // The clock, −1 … 1 across the whole span: between the five places
    // worked out for it, from the farthest past through now to the farthest future.
    float t = clamp(when, -1.0, 1.0) * 2.0;
    vec3 at = t <= -1.0 ? mix(pB, pA, -t - 1.0) : t < 0.0 ? mix(position, pB, -t) : t < 1.0 ? mix(position, pD, t) : mix(pD, pE, t - 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(at, 1.0);
    gl_PointSize = max(3.0, sizeDeg * pxPerDeg);
    vTint = tint;
    vSolid = solid;
    // A little dimmer toward the far end, so the near reads as near (a depth cue, not a brightness).
    vDim = dim * mix(1.0, falloff, clamp((length(position) - nearM) / (farM - nearM), 0.0, 1.0));
  }
`;

/**
 * A star's trail along its motion: only the part already travelled in the
 * clock's direction, brightest at the star and fading behind it. `tk` is a
 * vertex's time on the clock (−1 … 1); the field's own star keeps its whole
 * trail.
 */
const TRAIL_VERTEX = /* glsl */ `
  attribute float tk;
  attribute float hi;
  varying float vTk;
  varying float vHi;
  void main() {
    vTk = tk;
    vHi = hi;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FRAGMENT = /* glsl */ `
  uniform float when;
  uniform float dir;
  uniform vec3 tint;
  uniform vec3 hiTint;
  varying float vTk;
  varying float vHi;
  void main() {
    float behind = (when - vTk) * dir;
    float len = mix(0.35, 2.0, vHi);
    if (behind < 0.0 || behind > len) discard;
    float a = pow(1.0 - behind / len, 1.5) * mix(0.55, 1.0, vHi);
    gl_FragColor = vec4(mix(tint, hiTint, vHi) * a, 1.0);
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
export function createDepthView({ head, behind, field, look, pxPerDeg, onAction, sound = null }) {
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
  /** The level the pins drop to, a metre under the eye. */
  const PLANE_Y = -1.0;
  const labels = [];
  const state = {
    gaia: null, bodies: [], galaxies: null, candidates: [], failed: [], depthAB: null,
    asking: true, target: field.target ?? null, bodyNote: false, gaiaLimit: null, retry: {},
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
    const p = v3(frame.f).multiplyScalar(1.5).addScaledVector(v3(frame.r), -1.15);
    p.y = -0.3;
    sign.mesh.position.copy(p);
    sign.mesh.lookAt(0, -0.15, 0);
    group.add(sign.mesh);
  }
  const xSign = createPanel({ widthM: 1.0, heightM: 1.0, pxPerM: 640, name: 'planet-x' });
  {
    const r = depthMetres(600);
    // Beside the field's picture at the corridor's end, clear of it.
    const p = along(r).addScaledVector(v3(frame.r), cone(r) * 1.6);
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
      // What did not come, each with when it is asked again; what came is drawn regardless.
      if (state.failed.length) {
        const now = performance.now();
        paragraphs.push([state.failed.map((what) => {
          const at = state.retry[what];
          const later = at ? Math.max(1, Math.ceil((at - now) / 1000)) : null;
          const words = what === 'Bailer-Jones' ? tv('vr.depthNoBJ') : tv('vr.depthFailed', { what });
          return later ? `${words} · ${tv('vr.retryIn', { s: later })}` : words;
        }).join(' · '), 'counter']);
      }
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
      const v = { bright: fmt(PLANET_X_V.bright, 1), faint: fmt(PLANET_X_V.faint, 1), nominal: fmt(PLANET_X_V.nominal, 1), near: PLANET_X_AU[0], far: PLANET_X_AU[1] };
      const text = !here
        ? tv('vr.planetXNo', { beta: `${state.beta >= 0 ? '+' : '−'}${fmt(Math.abs(state.beta), 0)}`, max: PLANET_X_MAX_BETA })
        : d != null
          ? tv('vr.planetXNote', { ...v, ab: fmt(d, 1), a: fmt(PLANET_X_V.bright - d, 1), b: fmt(PLANET_X_V.faint - d, 1) })
          : tv('vr.planetXWait', v);
      const title = wrapLines(`600 ${px + 6}px ${FONTS.display}`, tv(here ? 'vr.planetX' : 'vr.planetXAway'), W - 24, 2);
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
    const keys = [0, 1, 2, 3].map(() => new Float32Array(items.length * 3));
    items.forEach((it, i) => {
      pos.set(it.pos, i * 3);
      keys.forEach((k, j) => k.set(it.path?.[j] ?? it.pos, i * 3));
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
    ['pA', 'pB', 'pD', 'pE'].forEach((name, j) => geo.setAttribute(name, new THREE.BufferAttribute(keys[j], 3)));
    const mat = new THREE.ShaderMaterial({
      uniforms: { pxPerDeg, when: clock.uniform, dim: focusDim, nearM: { value: D.nearM }, farM: { value: D.unknownM }, falloff: { value: D.falloff } },
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
      layer.objects.push(lines(drop, lineColor, 0.16));
    }
    return layer;
  }

  /* ---- pointing at objects, filtering them, and the way back ------------ */
  /** What can be pointed at, by class: `{ pos: [x,y,z] in the corridor, card() }`. */
  let scaleNow = 1;
  let settleFrame = 0;
  let settledAt = null;
  let settledSig = '';
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  /** Labels by priority, each hidden if it would cover one shown before it, by angle from the head. */
  function settleLabels(headWorld) {
    group.updateMatrixWorld();
    const shownBoxes = [];
    // The Planet X note is always shown, and nothing may stand on it.
    // Nor on the corridor's sign and controls: names give way to the panels.
    const fixed = [xSign, sign, controls].map((p) => ({ mesh: p.mesh, widthM: p.widthM, heightM: p.heightM, priority: 99, fixed: true }));
    const order = [...fixed, ...labels.filter((l) => l.on !== false)].sort((a, b) => b.priority - a.priority);
    for (const l of order) {
      const p = l.mesh.getWorldPosition(tmpA).sub(headWorld);
      const d = Math.max(0.1, p.length());
      const s = l.mesh.getWorldScale(tmpB).x;
      const box = {
        yaw: Math.atan2(p.x, -p.z), el: Math.asin(Math.max(-1, Math.min(1, p.y / d))),
        hw: Math.atan((l.widthM * s) / 2 / d) * 0.8, hh: Math.atan((l.heightM * s) / 2 / d),
      };
      // Hysteresis once settled: a shown name holds until clearly covered, a hidden one returns only when clearly free.
      const k = l.fixed || !l.settled ? 1 : l.mesh.visible ? 0.8 : 1.2;
      l.settled = true;
      const hit = shownBoxes.some((o) => Math.abs(Math.atan2(Math.sin(o.yaw - box.yaw), Math.cos(o.yaw - box.yaw))) < (o.hw + box.hw) * k
        && Math.abs(o.el - box.el) < (o.hh + box.hh) * k);
      if (!l.fixed) {
        l.mesh.visible = !hit;
        if (l.lead) l.lead.visible = !hit;
      }
      if (!hit || l.fixed) shownBoxes.push(box);
    }
  }
  const pickables = { gaia: [], gaiaUnknown: [], bodies: [], galaxies: [], candidates: [], target: [], marks: [] };
  /** The tape: the first thing measured from, and the line drawn to the second. */
  const tape = { from: null };
  /** What the depth view is doing (depthmodes.js): one mode at a time, each ending the ones it must. */
  let mode = { ...DEPTH_IDLE };
  /** Take an action through the modes and carry out what it ends; the effects, for the caller. */
  function go(action) {
    const r = depthStep(mode, action);
    mode = r.state;
    if (r.effects.has('cancelTape')) tape.from = null;
    if (r.effects.has('pauseClock')) clock.playing = false;
    if (r.effects.has('resetClock')) { clock.anim = null; clock.playing = false; setYears(0); }
    if (r.effects.has('clearFocus')) clearFocus();
    if (r.effects.has('closeCard')) onAction?.('closeCard');
    drawControls();
    return r.effects;
  }
  /** Time: the bodies on this day of their season. */
  const when = { mjd: null, bodies: null };
  /**
   * The stars' clock: years from now, within ±STAR_YEARS, running or not, at
   * ×1 or ×10. The shader moves every star from it; nothing loops over them.
   */
  const clock = { years: 0, playing: false, dir: 1, dirU: { value: 1 }, fast: false, uniform: { value: 0 }, drawn: 0, last: 0, anim: null, epochMjd: null };
  /** The points are dimmed a little while a flight's target is in focus. */
  const focusDim = { value: 1 };
  /** The thing flown to: ringed and named, pulsing on the way, steady once there. */
  const focus = { it: null, phase: null, ring: null, label: null, t0: 0 };
  /** Things that follow the clock on the CPU: a few names, and the pickable places. */
  const followers = [];
  /** The paths shown, by the thing they belong to. */
  const paths = new Map();
  /** Where the line under the filters says why no bodies are shown. */
  let bodyNoteY = 0;
  /** Where the clock's slider lies on the controls, once drawn. */
  let clockBox = null;
  const shown = { stars: true, bodies: true, galaxies: true, unknown: true };
  const classOf = { gaia: 'stars', target: 'stars', gaiaUnknown: 'unknown', candidates: 'unknown', bodies: 'bodies', galaxies: 'galaxies' };

  function applyFilters() {
    for (const [name, layer] of Object.entries(layers)) {
      const kind = name.startsWith('path:') ? { gaia: 'stars', body: 'bodies', galaxy: 'galaxies' }[name.split(':')[1]] : classOf[name];
      const on = shown[kind] ?? true;
      for (const o of layer.objects) { o.userData.on = on; o.visible = on; }
      // A name filtered off goes at once; one filtered on waits for the next
      // settling, which decides whether it would cover another.
      for (const l of layer.labels) {
        l.on = on;
        if (!on) l.mesh.visible = false;
        if (l.lead) { l.lead.userData.on = on; if (!on) l.lead.visible = false; }
      }
    }
    settledSig = '';
    applyTime();
  }

  // Drawn as tall as what it holds; the canvas leaves room for the most it can hold.
  const controls = createPanel({ widthM: 1.5, heightM: 1.5, pxPerM: 760, name: 'depth-controls', opaque: true });
  {
    // Across the corridor's mouth from the sign, a little below the eyes and
    // within a flat screen's width: pressed often, never read looking down.
    const p = v3(frame.f).multiplyScalar(1.5).addScaledVector(v3(frame.r), 1.2);
    // Its top a little under the eyes, where it always was; it grows downward.
    p.y = -0.1 - 0.75;
    controls.mesh.position.copy(p);
    controls.mesh.lookAt(0, -0.3, 0);
    group.add(controls.mesh);
  }
  let yearAt = null;
  /** Lay the year's panel over the room the controls left for it. */
  function placeYear() {
    if (!readout.mesh.parent) controls.mesh.add(readout.mesh);
    if (!yearAt) { readout.mesh.visible = false; return; }
    readout.mesh.position.set(0, controls.heightM / 2 - (yearAt.y + yearAt.h / 2) / 760, 0.004);
    readout.mesh.visible = true;
    drawYear();
  }
  let hoverId = null;
  function drawControls() {
    applyFilters();
    controls.draw((ctx, W, H, hits) => {
      queueMicrotask(placeYear);
      const px = minTextPx(760, 1.9);
      const font = `500 ${px}px ${FONTS.body}`;
      const bh = Math.round(px * 1.8);
      // Laid out first, then the plate drawn to fit what it holds.
      const laid = [];
      let x = 18;
      let y = 18;
      const chip = (id, label, on = false, data = null) => {
        const w = chipWidth(ctx, font, label, bh, 0.09 * 760);
        if (x + w > W - 18) { x = 18; y += bh + 12; }
        laid.push({ x, y, w, h: bh, label, id, font, on, hover: hoverId === `${id}:${data ?? ''}`, data });
        x += w + 12;
      };
      const row = () => { x = 18; y += bh + 12; };
      // Back to the field's screens, the way the viewer came; or out to the sky.
      chip('screens', `‹ ${tv('vr.screensAway')}`);
      chip('back', tv('vr.backSky'));
      chip('reset', tv('vr.resetView'));
      row();
      // A catalogue that did not answer can be asked again from here, first thing under the way out.
      if (state.failed.length) {
        for (const what of state.failed) chip('retrySource', `↻ ${what}`, false, what);
        row();
      }
      const g = state.gaia;
      chip('filter', tv('vr.filterStars', { n: g?.known ?? 0, m: (g?.known ?? 0) + (g?.unknown ?? 0) }), shown.stars, 'stars');
      if (state.bodies.length) chip('filter', tv('vr.filterBodies', { n: state.bodies.length }), shown.bodies, 'bodies');
      else laid.push({ x, y, w: chipWidth(ctx, font, tv('vr.filterBodies', { n: 0 }), bh, 0.09 * 760), h: bh, label: tv('vr.filterBodies', { n: 0 }), id: 'none', font, tone: 'neutral', disabled: true }), (x += chipWidth(ctx, font, tv('vr.filterBodies', { n: 0 }), bh, 0.09 * 760) + 12);
      chip('filter', tv('vr.filterGalaxies', { n: state.galaxies?.length ?? 0, m: state.galaxyCount ?? 0 }), shown.galaxies, 'galaxies');
      chip('filter', tv('vr.filterUnknown', { n: (g?.unknown ?? 0) + state.candidates.length }), shown.unknown, 'unknown');
      row();
      // Why there are no bodies: a line of its own under the filters, wrapped to the panel.
      const noteFont = `400 ${Math.round(px * 0.8)}px ${FONTS.body}`;
      const noteLh = Math.round(px * 1.0);
      const noteRow = (text) => {
        const lines = wrapLines(noteFont, text, W - 36, 6);
        laid.push({ note: lines, y: y - 12 });
        y += lines.length * noteLh + 12;
      };
      if (!state.bodies.length) noteRow(tv(state.bodiesFailed ? 'vr.bodiesFailed' : state.bodyAsked ? 'vr.bodiesNone' : 'vr.bodiesAsking'));
      // Time: the stars along their own motion; the bodies along their season.
      if (state.gaia?.known) {
        // Back and on: play either way (a second tap pauses), or a step at a time.
        chip('playBack', clock.playing && clock.dir < 0 ? '❚❚' : '◀', clock.playing && clock.dir < 0);
        chip('step', '‹', false, '-1');
        chip('step', '›', false, '1');
        chip('play', clock.playing && clock.dir > 0 ? '❚❚' : '▶', clock.playing && clock.dir > 0);
        chip('speed', clock.fast ? '×10' : '×1', clock.fast);
        chip('today', tv('vr.today'), Math.abs(clock.years) < 1e-3);
        if (clock.epochMjd != null) chip('epoch', tv('vr.epochFrame'), clock.epochAt != null && Math.abs(clock.years - epochYears()) < 1e-3);
        row();
        laid.push({ slider: true, x: 18, y, w: W - 36, h: bh });
        clockBox = { x: 18, y, w: W - 36, h: bh };
        y += bh + 8;
        laid.push({ readout: true, y, h: Math.round(px * 1.9) });
        y += Math.round(px * 1.9) + 12;
        noteRow(tv('vr.timeNote'));
      }
      const span = bodySpan();
      if (span) {
        chip('day', '‹', false, '-1');
        chip('dayNow', formatDay(new Date(((when.mjd ?? span.at) - MJD_UNIX) * 86400000)), when.mjd != null && Math.abs(when.mjd - span.at) > 0.5);
        chip('day', '›', false, '1');
      }
      if (mode.tape) chip('tapeCancel', tv('vr.tapeArmed'), true);
      if (layers.tape) chip('tapeClear', tv('vr.tapeClear'));
      if (state.moved) chip('home', tv('vr.backEarth'));
      if (sound) chip('sound', sound.enabled ? tv('vr.soundOn') : tv('vr.soundOff'), sound.enabled);
      // What a metre along the corridor is worth now, in distance.
      const decades = Math.log10((D.maxPc * AU_PER_PC) / D.minAU);
      const perM = 10 ** (decades / (D.farM - D.nearM) / scaleNow);
      const f = perM >= 100 ? Math.round(perM).toLocaleString('en-US').replace(/,/g, ' ') : perM.toFixed(1);
      const small = Math.round(px * 0.9);
      // The last row of chips, if any, then the scale under it.
      const lastChipBottom = laid.reduce((m, c) => (c.id ? Math.max(m, c.y + c.h) : m), 0);
      const scaleY = Math.max(y, lastChipBottom + 12) + small;
      const bottom = Math.min(H - 2, scaleY + 18);
      roundRect(ctx, 2, 2, W - 4, bottom - 2, 24);
      ctx.fillStyle = look.paper;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = look.ruleStrong;
      ctx.stroke();
      // The way the clock runs, on its button only: warm toward the future, cool toward the past.
      if (clock.playing) {
        const b = laid.find((c) => c.id === (clock.dir > 0 ? 'play' : 'playBack'));
        if (b) {
          ctx.save();
          ctx.shadowColor = clock.dir > 0 ? look.counter : look.accent;
          ctx.shadowBlur = 22;
          ctx.strokeStyle = ctx.shadowColor;
          ctx.lineWidth = 4;
          roundRect(ctx, b.x - 3, b.y - 3, b.w + 6, b.h + 6, (b.h + 6) / 2);
          ctx.stroke();
          ctx.restore();
        }
      }
      let year = null;
      for (const b of laid) {
        if (b.slider) { drawSlider(ctx, hits, b); continue; }
        if (b.readout) { year = b; continue; }
        if (b.note) {
          ctx.font = noteFont;
          ctx.fillStyle = look.neutral;
          b.note.forEach((l, k) => ctx.fillText(l, 18, b.y + Math.round(px * 0.8) + k * noteLh));
          continue;
        }
        if (b.disabled) { button(ctx, [], look, b); continue; }
        button(ctx, hits, look, b);
      }
      yearAt = year;
      ctx.font = `400 ${small}px ${FONTS.mono}`;
      ctx.fillStyle = look.neutral;
      ctx.fillText(tv('vr.scaleNow', { f, s: scaleNow.toFixed(scaleNow < 1 ? 2 : 1) }), 18, scaleY);
    });
  }
  controls.mesh.userData.hover = (uv) => {
    const h = uv ? controls.hitAt(uv) : null;
    const id = h ? `${h.id}:${h.data ?? ''}` : null;
    if (id !== hoverId) { hoverId = id; drawControls(); }
  };
  // The slider can be dragged as well as pressed.
  controls.mesh.userData.press = () => hoverId === 'clock:';
  controls.mesh.userData.drag = (uv) => { if (clockBox) { clock.playing = false; setYears(yearsAt(uv)); } };
  controls.mesh.userData.pickAs = (id, data) => controls.mesh.userData.pick(null, null, { id, data });
  controls.mesh.userData.pick = (uv, _hit, forced = null) => {
    const h = forced ?? controls.hitAt(uv);
    if (!h) return;
    if (h.id === 'filter') { shown[h.data] = !shown[h.data]; applyFilters(); drawControls(); return; }
    if (h.id === 'play' || h.id === 'playBack') { playToward(h.id === 'play' ? 1 : -1); return; }
    if (h.id === 'step') { onAction?.('sound', { kind: 'step', dir: Number(h.data) }); easeYears(Math.round(clock.years + Number(h.data) * stepYears())); return; }
    if (h.id === 'epoch') { clock.epochAt = clock.epochMjd; easeYears(epochYears()); return; }
    if (h.id === 'home') { clearFocus(); onAction?.('home'); return; }
    if (h.id === 'sound' && sound) { sound.start(); sound.setEnabled(!sound.enabled); drawControls(); return; }
    if (h.id === 'speed') { clock.fast = !clock.fast; drawControls(); return; }
    if (h.id === 'today') { easeYears(0); return; }
    if (h.id === 'clock') { easeYears(yearsAt(uv)); return; }
    if (h.id === 'day') { stepBodies(Number(h.data)); return; }
    if (h.id === 'dayNow') { when.mjd = null; if (when.bodies) api.setBodies(...when.bodies); return; }
    if (h.id === 'reset') clearFocus();
    if (h.id === 'tapeCancel') { go('tapeCancel'); return; }
    if (h.id === 'retrySource') { onAction?.('retrySource', h.data); return; }
    if (h.id === 'tapeClear') { clearLayer('tape'); drawControls(); return; }
    onAction?.(h.id);
  };
  controls.mesh.userData.pickable = (uv) => Boolean(controls.hitAt(uv));
  drawControls();

  /* ---- the stars' clock ------------------------------------------------ */

  /** Years at a point of the controls' slider. */
  function yearsAt(uv) {
    const [x] = controls.toCanvas(uv);
    const k = Math.max(0, Math.min(1, (x - clockBox.x) / clockBox.w));
    return Math.round((k * 2 - 1) * STAR_YEARS);
  }

  /** The slider: a track from −STAR_YEARS to +STAR_YEARS, now marked, the thumb where the clock is. */
  function drawSlider(ctx, hits, b) {
    const cy = b.y + b.h / 2;
    ctx.strokeStyle = look.rule;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.x + 10, cy);
    ctx.lineTo(b.x + b.w - 10, cy);
    ctx.stroke();
    const xOf = (y) => b.x + 10 + ((y / STAR_YEARS + 1) / 2) * (b.w - 20);
    ctx.strokeStyle = look.neutral;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(xOf(0), cy - b.h * 0.3);
    ctx.lineTo(xOf(0), cy + b.h * 0.3);
    ctx.stroke();
    ctx.fillStyle = hoverId === 'clock:' ? look.ink : look.accent;
    ctx.beginPath();
    ctx.arc(xOf(clock.years), cy, b.h * 0.32, 0, Math.PI * 2);
    ctx.fill();
    hits.push({ x: b.x, y: b.y, w: b.w, h: b.h, id: 'clock' });
  }

  /** Play the clock toward the future (1) or the past (−1); the same way again pauses. From an end, it starts over from the other. */
  function playToward(dir) {
    if (clock.playing && clock.dir === dir) { go('pause'); return; }
    // At the end it runs toward, it first glides back to the other end: no jump.
    const atEnd = dir > 0 ? clock.years >= STAR_YEARS : clock.years <= -STAR_YEARS;
    if (atEnd) {
      easeYears(-dir * STAR_YEARS);
      clock.anim.then = dir;
      return;
    }
    clock.dir = dir;
    clock.dirU.value = dir;
    clock.anim = null;
    go('play');
    clock.playing = true;
    clock.last = performance.now();
    drawControls();
  }

  /** A step of the ‹ › buttons: a century at ×1, a millennium at ×10. */
  const stepYears = () => (clock.fast ? 1000 : 100);

  /** A date as a decimal year. */
  const decimalYear = (ms) => 1970 + ms / (365.2425 * 86400000);
  /** Years from now to the visit on the screen. */
  const yearsTo = (mjd) => (mjd == null ? 0 : decimalYear((mjd - MJD_UNIX) * 86400000) - decimalYear(Date.now()));
  /** Years from now to the frame chosen with "Epoch of the frame" (the visit on the screen when it was pressed). */
  const epochYears = () => yearsTo(clock.epochAt);

  /** A jump of the clock (a step, Today, the frame, a press on the slider), eased over READOUT_EASE_MS. */
  function easeYears(to) {
    if (mode.playing) go('pause');
    clock.playing = false;
    clock.anim = { from: clock.years, to: Math.max(-STAR_YEARS, Math.min(STAR_YEARS, to)), t0: performance.now() };
    drawControls();
  }

  /** The year, large, on its own small panel so it can roll every frame without redrawing the controls. */
  const RPX = minTextPx(760, 1.9);
  const readout = createPanel({ widthM: controls.widthM - 0.06, heightM: Math.ceil(RPX * 1.9) / 760, pxPerM: 760, name: 'depth-year' });
  readout.mesh.visible = false;
  readout.mesh.renderOrder = 12;
  readout.mesh.material.depthTest = false;

  /**
   * The year as an odometer: each digit rolls into the next as the clock
   * runs, either way, and the words around it say which era; on the right,
   * how far from today, or that this is today or the frame's own moment.
   */
  function drawYear() {
    if (!readout.mesh.visible) return;
    readout.draw((ctx, W, H) => {
      const Y = decimalYear(Date.now()) + clock.years;
      const thisYear = Math.floor(decimalYear(Date.now()));
      const shown = Math.floor(Y);
      const ad = shown > 0;
      // Rolling only while it moves; at rest every digit stands whole.
      const moving = clock.playing || clock.anim;
      const v0 = Math.max(0, ad ? Y : 1 - Y);
      const v = moving ? v0 : (ad ? shown : 1 - shown);
      const big = Math.round(RPX * 1.35);
      const lh = big * 1.15;
      const base = H / 2 + big * 0.36;
      ctx.font = `600 ${big}px ${FONTS.display}`;
      ctx.fillStyle = clock.years > 0.5 ? look.counter : clock.years < -0.5 ? look.accent : look.ink;
      const [pre, post] = tv(ad ? 'vr.yearAD' : 'vr.yearBC', { y: '\u0000' }).split('\u0000');
      const arrow = clock.playing ? `${clock.dir > 0 ? '▶' : '◀'} ` : '';
      let x = 4;
      ctx.fillText(arrow + pre, x, base);
      x += ctx.measureText(arrow + pre).width;
      const n = String(Math.floor(v)).length;
      const slot = ctx.measureText('0').width * 1.04;
      for (let i = 0; i < n; i++) {
        const k = n - 1 - i;
        const p = 10 ** k;
        const d = Math.floor(v / p) % 10;
        const rest = v % p;
        const f = k === 0 ? v % 1 : Math.max(0, rest - (p - 1));
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, base - big, slot, lh);
        ctx.clip();
        ctx.fillText(String(d), x, base - f * lh);
        ctx.fillText(String((d + 1) % 10), x, base + (1 - f) * lh);
        ctx.restore();
        x += slot;
      }
      ctx.fillText(post, x, base);
      x += ctx.measureText(post).width;
      ctx.font = `400 ${Math.round(RPX * 0.85)}px ${FONTS.mono}`;
      ctx.fillStyle = look.neutral;
      const atEpoch = clock.epochAt != null && Math.abs(clock.years - epochYears()) < 1e-3;
      const off = Math.abs(clock.years) < 1e-3 ? tv('vr.today')
        : atEpoch ? tv('vr.epochAt', { date: fmtDate(new Date((clock.epochAt - MJD_UNIX) * 86400000).toISOString()) })
          : `${thisYear} ${shown >= thisYear ? '+' : '−'} ${Math.abs(shown - thisYear)}`;
      ctx.fillText(off, Math.min(W - ctx.measureText(off).width - 8, x + 24), base);
    });
  }

  /** Ring and name the thing being flown to, and dim the rest a little. */
  function focusOn(it) {
    clearFocus();
    const content = it.card();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1, 48),
      new THREE.MeshBasicMaterial({ color: color(look.ink), transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
    );
    ring.renderOrder = 13;
    ring.position.set(...it.pos);
    group.add(ring);
    const label = addLabel([content.title, content.lines?.[1]?.text ?? ''].filter(Boolean), it.pos, { tone: 'ink', keep: true, priority: 97 });
    label.minor = true;
    Object.assign(focus, { it, phase: 'flying', ring, label, t0: performance.now(), d0: Math.max(0.5, v3(it.pos).length()) });
    focusDim.value = 0.45;
  }

  /** Put the focus away: the ring and the name gone, the rest as bright as before. */
  function clearFocus() {
    if (focus.ring) { focus.ring.removeFromParent(); focus.ring.geometry.dispose(); focus.ring.material.dispose(); }
    if (focus.label) {
      dropLead(focus.label);
      focus.label.dispose();
      const i = labels.indexOf(focus.label);
      if (i >= 0) labels.splice(i, 1);
    }
    Object.assign(focus, { it: null, phase: null, ring: null, label: null });
    focusDim.value = 1;
  }

  /** The focus each frame: on the thing, facing the head, pulsing on the way and steady there; gone once left behind. */
  function tickFocus(headWorld) {
    if (!focus.it) return;
    focus.ring.position.set(...focus.it.pos);
    focus.label.mesh.position.set(...focus.it.pos);
    focus.ring.updateMatrixWorld();
    const at = focus.ring.getWorldPosition(new THREE.Vector3());
    const d = at.distanceTo(headWorld);
    focus.ring.lookAt(headWorld);
    const s = group.getWorldScale(new THREE.Vector3()).x;
    const pulse = focus.phase === 'flying' ? 1 + 0.2 * Math.sin((performance.now() - focus.t0) / 120) : 1;
    focus.ring.scale.setScalar((d * Math.tan(1.6 * D2R) * pulse) / s);
    focus.ring.material.opacity = focus.phase === 'flying' ? 0.55 + 0.4 * Math.abs(Math.sin((performance.now() - focus.t0) / 240)) : 0.95;
    // The name keeps its size to the eye as the head comes close: never larger than it was made.
    focus.label.mesh.scale.setScalar(Math.max(0.05, Math.min(1, d / (focus.d0 * s))));
    if (focus.phase === 'flying' && d < 1.1) { focus.phase = 'there'; go('arrive'); }
    else if (focus.phase === 'there' && d > 2.5) clearFocus();
  }

  /** Where a thing with five places (−T, −T/2, now, +T/2, +T) stands at the clock. */
  function placeAt(path5, years) {
    const t = Math.max(-1, Math.min(1, years / STAR_YEARS)) * 2;
    const [a, b, c, d, e] = path5;
    const mix = (p, q, f) => p.map((x, k) => x + (q[k] - x) * f);
    return t <= -1 ? mix(b, a, -t - 1) : t < 0 ? mix(c, b, -t) : t < 1 ? mix(c, d, t) : mix(d, e, t - 1);
  }

  /** Set the clock: the shader moves the stars; the few names and picks follow on the CPU. */
  function setYears(years) {
    clock.years = Math.max(-STAR_YEARS, Math.min(STAR_YEARS, years));
    clock.uniform.value = clock.years / STAR_YEARS;
    for (const f of followers) {
      const p = placeAt(f.path, clock.years);
      if (f.label) { f.label.mesh.position.set(...p); if (f.label.lead) f.label.lead.visible = clock.years === 0 && f.label.mesh.visible; }
      if (f.pick) f.pick.pos = p;
    }
    applyTime();
    drawYear();
    const now = performance.now();
    if ((!clock.playing && !clock.anim) || now - clock.drawn > 100) { clock.drawn = now; drawControls(); }
  }

  /** While the clock is off today: the trails shown, the pins and plate lines (which stay where today is) put away. */
  function applyTime() {
    const off = clock.years !== 0 || clock.playing;
    for (const name of ['gaia', 'gaiaUnknown', 'target']) {
      for (const o of layers[name]?.objects ?? []) {
        if (o.userData.trail) o.visible = off && (shown.stars ?? true);
        else if (o.isLineSegments) o.visible = !off && o.userData.on !== false;
      }
    }
  }

  /** A thing's path through time or space, drawn on the corridor, one line per path, or put away. */
  function togglePath(key, build) {
    if (paths.has(key)) {
      clearLayer(`path:${key}`);
      paths.delete(key);
      return false;
    }
    const layer = { objects: [], labels: [] };
    layers[`path:${key}`] = layer;
    build(layer);
    paths.set(key, true);
    return true;
  }

  /** How many measurements the tape has made: for the walk-through. */
  let tapesDone = 0;

  /** Beams and paths whose pulse runs with the clock; one gone from the scene drops out. */
  const pulsing = new Set();

  /**
   * A path as it is shown when asked for: the object's colour, a bright core
   * in a glow sleeve with a dark rim (beam.js), a pulse running the way it
   * moves, an arrowhead at its end and a bright tick at each dated point.
   */
  function pathRibbon(pts, css, { ticks = null } = {}) {
    const rib = createRibbon(pts, { color: css });
    group.add(rib.mesh);
    pulsing.add(rib);
    const out = [rib.mesh, ...arrowAt(pts, css)];
    if (ticks?.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(ticks.flat(), 3));
      const dots = new THREE.Points(geo, new THREE.PointsMaterial({ color: color(css), size: 9, sizeAttenuation: false, transparent: true, depthWrite: false, toneMapped: false }));
      dots.renderOrder = 11;
      dots.frustumCulled = false;
      group.add(dots);
      out.push(dots);
    }
    return out;
  }

  /** An arrowhead at the end of a polyline, pointing on along its last step: a chevron in the path's own style. */
  function arrowAt(points, css) {
    const a = v3(points.at(-2));
    const b = v3(points.at(-1));
    const back = a.clone().sub(b);
    const len = Math.max(0.03, Math.min(0.15, b.length() * 0.03));
    back.setLength(len);
    // Its barbs across the path as the viewer sees it: square to the path and to the line of sight.
    const side = back.clone().cross(b);
    if (side.lengthSq() < 1e-10) side.set(1, 0, 0);
    side.setLength(len * 0.5);
    // Each barb its own straight strip: a strip bent through the tip would pinch there.
    return [side, side.clone().negate()].map((s) => {
      const barb = createRibbon([b.clone().add(back).add(s).toArray(), b.toArray()], { color: css, pulse: 0, near: 1, far: 1, k: 1.3 });
      group.add(barb.mesh);
      return barb.mesh;
    });
  }


  /* ---- the tape, the flight, and time ------------------------------- */

  /** How far apart two things are, in the unit that reads best: AU, light years, parsecs. */
  function apart(au) {
    if (au < 2000) return tv('vr.tapeAU', { d: fmt(au, au < 10 ? 2 : 0) });
    const ly = au / 63241.08;
    if (ly < 1e5) return tv('vr.tapeLy', { d: fmt(ly, ly < 10 ? 2 : ly < 100 ? 1 : 0) });
    const mpc = au / AU_PER_PC / 1e6;
    return tv('vr.tapeMpc', { d: fmt(mpc, mpc < 10 ? 2 : 0) });
  }

  /** The true distance between two things with distances, through the angle between them on the sky. */
  function between(a, b) {
    const ca = Math.cos(a.dec * D2R);
    const cb = Math.cos(b.dec * D2R);
    const va = [ca * Math.cos(a.ra * D2R) * a.au, ca * Math.sin(a.ra * D2R) * a.au, Math.sin(a.dec * D2R) * a.au];
    const vb = [cb * Math.cos(b.ra * D2R) * b.au, cb * Math.sin(b.ra * D2R) * b.au, Math.sin(b.dec * D2R) * b.au];
    return Math.hypot(va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]);
  }

  /** A picked thing's card, with the flight to it and the tape from or to it. */
  function withTools(it, world) {
    const content = it.card();
    const actions = [...(content.actions ?? [])];
    const lines = [...content.lines];
    actions.push({ id: 'fly', label: tv('vr.flyTo'), run: () => { go('fly'); focusOn(it); onAction?.('fly', world); } });
    if (it.path) {
      const shownPath = paths.has(it.key);
      actions.push({
        id: 'path', label: tv(shownPath ? 'vr.pathHide' : 'vr.pathShow'),
        run: () => {
          const on = togglePath(it.key, it.path);
          // A known body ticks softly from where it is as its path appears.
          if (on && it.key?.startsWith('body:')) onAction?.('sound', { kind: 'body', world });
        },
      });
    }
    if (it.pathNote) lines.push({ text: it.pathNote, tone: 'neutral' });
    // The tape: armed from one thing, it measures to the next one opened, shows the result and is put down.
    if (mode.tape && tape.from && tape.from !== it) {
      if (it.real?.au) {
        const d = between(tape.from.real, it.real);
        lines.push({ text: tv('vr.tapeLine', { from: tape.from.name, d: apart(d) }), tone: 'accent' });
        drawTape(tape.from, it, apart(d));
        tape.from = null;
        go('tapeDone');
        tapesDone += 1;
      } else {
        lines.push({ text: tv('vr.tapeNoDistance'), tone: 'neutral' });
      }
    }
    if (it.real?.au) {
      if (mode.tape && tape.from === it) actions.push({ id: 'tapeFrom', label: tv('vr.tapeCancel'), run: () => go('tapeCancel') });
      else actions.push({ id: 'tapeFrom', label: tv('vr.tapeFrom'), run: () => { if (mode.tape) go('tapeCancel'); tape.from = it; go('tapeArm'); } });
    }
    return { ...content, lines, actions };
  }

  /** The tape on the corridor: a line between the two, its true length at its middle. */
  function drawTape(a, b, words) {
    clearLayer('tape');
    const layer = { objects: [], labels: [] };
    layers.tape = layer;
    layer.objects.push(lines([...a.pos, ...b.pos], look.accent, 0.95));
    const mid = a.pos.map((x, k) => (x + b.pos[k]) / 2);
    layer.labels.push(addLabel([words, tv('vr.tapeNote')], mid, { tone: 'accent', priority: 9 }));
    drawControls();
  }

  /** The days the bodies' paths cover, and the visit's own day, or null. */
  function bodySpan() {
    const tracks = when.bodies?.[1];
    if (!tracks?.size) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of tracks.values()) for (const p of t) { lo = Math.min(lo, p.mjd); hi = Math.max(hi, p.mjd); }
    if (!(hi > lo)) return null;
    const at = when.bodies[0][0]?.mjd ?? (lo + hi) / 2;
    return { lo, hi, at };
  }

  /** The bodies where their paths put them on day `mjd`, between the path's points. */
  function bodiesOn(bodies, tracks, mjd) {
    return bodies.map((b) => {
      const t = tracks.get(b.name);
      if (!t || t.length < 2) return b;
      let k = t.findIndex((p) => p.mjd >= mjd);
      if (k <= 0) k = k === 0 ? 1 : t.length - 1;
      const p = t[k - 1];
      const q = t[k];
      const f = Math.max(0, Math.min(1, (mjd - p.mjd) / Math.max(1e-6, q.mjd - p.mjd)));
      return { ...b, ra: p.ra + deltaRA(q.ra, p.ra) * f, dec: p.dec + (q.dec - p.dec) * f, dGeo: p.au + (q.au - p.au) * f, seen: false };
    });
  }

  /** A step of a few days along the season, for the bodies. */
  function stepBodies(d) {
    const span = bodySpan();
    if (!span) return;
    const step = Math.max(1, (span.hi - span.lo) / 12);
    when.mjd = Math.max(span.lo, Math.min(span.hi, (when.mjd ?? span.at) + d * step));
    api.setBodies(...when.bodies);
  }

  /** Labels are few: the field's own target, the bodies, a galaxy or two. */
  const objectLabels = () => labels.filter((l) => !l.keep && !l.minor).length;

  function placeAlong(dir, distAU) {
    const u = unit(dir);
    const r = distAU == null ? unknownShell() : depthMetres(distAU);
    return [u[0] * r, u[1] * r, u[2] * r];
  }

  /* ---- the marks: a beam each along its direction, a marker where a distance is known ---- */
  /** The markers, one instanced mesh for all; each pulses once when it first appears. */
  const markFx = { mesh: null, items: [], born: new Map(), asking: [], sig: '', beams: [] };
  const MARK_PULSE_MS = 1400;
  /** A marker's size: a constant 0.5 degree at whatever distance it stands. */
  const markerSize = (r) => r * Math.tan(0.5 * D2R);
  const markMatrix = new THREE.Matrix4();

  /** The markers in place, the new ones pulsing: up to twice as large, easing back. */
  function placeMarkers(now) {
    const mesh = markFx.mesh;
    if (!mesh) return;
    markFx.items.forEach((it, i) => {
      const k = (now - (markFx.born.get(it.n) ?? 0)) / MARK_PULSE_MS;
      const pulse = k < 1 ? 1 + 1.2 * Math.sin(Math.PI * k) * (1 - k) : 1;
      const size = markerSize(Math.hypot(...it.pos)) * pulse;
      markMatrix.makeScale(size, size, size).setPosition(...it.pos);
      mesh.setMatrixAt(i, markMatrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** The card a mark's beam opens: its words, where it is, and a retry when the catalogues failed. */
  function markCard(d, words) {
    return {
      title: words[0],
      // The second line is the one the flight's name carries: where the distance is from.
      lines: [
        { text: `${formatRA(d.ra)}  ${formatDec(d.dec)}`, mono: true, tone: 'neutral' },
        ...(words[1] ? [{ text: words[1], tone: 'muted' }] : []),
      ],
      actions: d.state === 'failed' ? [{ id: 'markRetry', label: tv('vr.markAskAgain'), run: () => onAction?.('markRetry', d.n) }] : [],
    };
  }

  function setMarks(list) {
    const sig = JSON.stringify(list.map((d) => [d.n, d.state, d.show, d.au, d.nearAU, d.farAU, d.name, d.tone, d.ra, d.dec, d.track?.length, d.folded]));
    if (sig === markFx.sig) return;
    markFx.sig = sig;
    clearLayer('marks');
    if (markFx.mesh) { markFx.mesh.removeFromParent(); markFx.mesh.geometry.dispose(); markFx.mesh.material.dispose(); markFx.mesh = null; }
    markFx.items = [];
    markFx.asking = [];
    markFx.beams = [];
    pickables.marks = [];
    const layer = { objects: [], labels: [] };
    layers.marks = layer;
    // A beam (beam.js): the mark's colour, a core and a glow sleeve, a dark rim against bright sky,
    // and a pulse running out along it toward where the mark is.
    const shaft = (from, to, css, opts) => {
      const b = createBeam({ color: css, widthM: 0, ...opts });
      b.set(from, to);
      group.add(b.mesh);
      layer.objects.push(b.mesh);
      markFx.beams.push(b);
    };
    const farM = unknownShell();
    const seen = new Set();
    for (const d of list) {
      const css = look[d.tone] ?? look.accent;
      const u = unit(dirOf(d.ra, d.dec));
      const at = (m) => [u[0] * m, u[1] * m, u[2] * m];
      // The beam: from the viewer's end of the corridor through all of it.
      // To a marker, the beam runs bright to it and on, quieter, through the rest of the corridor.
      const stopM = d.show === 'at' ? depthMetres(d.au) : farM;
      shaft(at(D.nearM * 0.6), at(stopM), css, d.faint
        ? { k: 0.5, widthAng: 0.003, near: 0.8, far: 0.3, rim: 0.35 }
        : { k: 1, widthAng: 0.0045, near: 1, far: d.show === 'at' ? 0.9 : 0.45, pulse: 1, rim: 0.5 });
      if (stopM < farM) shaft(at(stopM), at(farM), css, { k: 0.45, widthAng: 0.0028, near: 0.6, far: 0.2, rim: 0.3 });
      let end = at(farM);
      if (d.show === 'range' || d.show === 'ceiling') {
        // The part of the beam the measurement allows, brighter.
        const b = depthMetres(d.farAU);
        shaft(at(depthMetres(d.nearAU)), at(b), css, { k: 1.3, widthAng: 0.0065, near: 1, far: 1, pulse: 1, rim: 0.55 });
        end = at(b);
      } else if (d.show === 'at') {
        end = at(depthMetres(d.au));
        markFx.items.push({ pos: end, css, n: d.n });
        if (!markFx.born.has(d.n)) markFx.born.set(d.n, performance.now());
        seen.add(d.n);
      }
      // A mover's path over its visits, at the distance its beam gives it.
      if (d.track?.length > 1 && d.show !== 'far') {
        const m = depthMetres(d.show === 'at' ? d.au : d.farAU);
        const pts = d.track.map((q) => { const v = unit(dirOf(q.ra, q.dec)); return [v[0] * m, v[1] * m, v[2] * m]; });
        layer.objects.push(...pathRibbon(pts, css, { ticks: pts }));
      }
      const words = markWords(d, tv);
      // A folded mark keeps its beam and its one line; an open one says where the distance is from.
      const label = addLabel(d.folded ? words.slice(0, 1) : words, end, { tone: d.tone, priority: 96 });
      layer.labels.push(label);
      if (d.state === 'asking') markFx.asking.push(label);
      pickables.marks.push({
        pos: end,
        real: d.show === 'at' ? { ra: d.ra, dec: d.dec, au: d.au } : null,
        name: words[0].split(':')[0],
        key: `mark:${d.n}`,
        card: () => markCard(d, words),
      });
    }
    for (const n of [...markFx.born.keys()]) if (!seen.has(n)) markFx.born.delete(n);
    if (markFx.items.length) {
      const mesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, 14, 10),
        new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false }),
        markFx.items.length,
      );
      markFx.items.forEach((it, i) => mesh.setColorAt(i, color(it.css)));
      mesh.instanceColor.needsUpdate = true;
      mesh.renderOrder = 10;
      mesh.frustumCulled = false;
      group.add(mesh);
      markFx.mesh = mesh;
      placeMarkers(performance.now());
    }
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
      return { card: withTools(best.it, world), at: world, distance: best.distance };
    },
    /** For the checks: a filter on or off, as its chip would; the count of each class. */
    filter(kind, on) { shown[kind] = on; applyFilters(); drawControls(); return { bodies: state.bodies.length, labels: layers.bodies?.labels.filter((l) => l.mesh.visible).length ?? 0 }; },
    /** Whether the viewer has walked or flown from where the frame was taken: offers the way back. */
    setMoved(on) { if (Boolean(state.moved) !== on) { state.moved = on; drawControls(); } },
    /** The date of the visit on the screen, for the clock's "Epoch of the frame". */
    setEpoch(mjd) { if (clock.epochMjd !== mjd) { clock.epochMjd = mjd; drawControls(); drawYear(); } },
    /** The flight's focus put away (back on the Earth, or to the screens). */
    clearFocus() { clearFocus(); },
    /** For the checks: the focus's state. */
    get focusPhase() { return focus.phase; },
    /** For the checks: set the stars' clock, in years from now, or run it. */
    clockTo(years, play = false, dir = 1) { clock.playing = play; clock.dir = dir; clock.dirU.value = dir; clock.last = performance.now(); setYears(years); },
    /** For the checks: press a control by its id. */
    press(id, data = null) { controls.mesh.userData.pickAs?.(id, data); },
    /** The marks on the field, as markdepth.js describes them: a beam each, a marker where a distance is known. */
    setMarks(list) { setMarks(list); },
    /** Fly to a mark's place in the corridor, as its card's "Fly there" would; false if it has none. */
    flyToMark(n) {
      const it = pickables.marks.find((p) => p.key === `mark:${n}`);
      if (!it) return false;
      group.updateMatrixWorld();
      const world = v3(it.pos).applyMatrix4(group.matrixWorld);
      go('fly');
      focusOn(it);
      onAction?.('fly', world);
      return true;
    },
    get tapesDone() { return tapesDone; },
    /** The controls' panel, for the walk-through's ring. */
    get controlsPanel() { return controls; },
    /** For the checks: how the marks stand in depth. */
    get marksShown() { return { markers: markFx.items.length, beams: pickables.marks.length, asking: markFx.asking.length, words: layers.marks?.labels.length ?? 0 }; },
    /** A catalogue being asked (again): its failure no longer said. */
    sourceAsking(what) { delete state.retry[what]; drawSign(); },
    /** A catalogue that answered. */
    sourceOk(what) {
      const k = state.failed.indexOf(what);
      if (k >= 0) state.failed.splice(k, 1);
      delete state.retry[what];
      drawSign();
      drawControls();
    },
    /** A catalogue that failed, and when it will be asked again (page time), or null. */
    sourceFailed(what, retryAt) {
      if (!state.failed.includes(what)) state.failed.push(what);
      state.retry[what] = retryAt;
      drawSign();
      drawControls();
    },
    /** Whether any failed catalogue is counting down to its retry. */
    get retrying() { return Object.values(state.retry).some(Boolean); },
    /** For the checks: which catalogues failed, and how much of each was drawn. */
    get sources() { return { failed: [...state.failed], stars: state.gaia?.known ?? 0, unknown: state.gaia?.unknown ?? 0, galaxies: state.galaxies?.length ?? 0, bodies: state.bodies.length }; },
    redrawSign() { drawSign(); },
    /** B in the depth view: one level unwound; true if it was used here, false to leave the view. */
    back() { return !go('back').has('leaveDepth'); },
    /** Out of the depth view: everything stopped, the clock back to today. */
    leave() { go('leave'); },
    /** The card shown or put away, so B knows. */
    cardShown(on) { if (mode.card !== on) go(on ? 'cardOpen' : 'cardClose'); },
    /** For the checks: the modes now. */
    get mode() { return { ...mode }; },
    /** The clock as it runs, for its sound. */
    get clockState() { return clock; },
    /** The controls panel, for the stick to scrub the clock while a ray is on it. */
    get clockPanel() { return clock.uniform && state.gaia?.known ? controls.mesh : null; },
    /** The stick aside scrubs the clock: `x` −1…1 over `dt` seconds; any push stops it playing. */
    scrub(x, dt) {
      if (Math.abs(x) < 0.15) { if (mode.scrubbing) go('scrubEnd'); return; }
      if (!mode.scrubbing || clock.playing) go('scrub');
      clock.playing = false;
      clock.anim = null;
      // The trail turns only on a clear push, never on the stick's tremble.
      if (Math.abs(x) > 0.3) clock.dirU.value = x > 0 ? 1 : -1;
      setYears(clock.years + x * dt * CLOCK_YPS * 4 * (clock.fast ? 10 : 1));
    },
    /** For the checks: where the `i`th pickable thing of a class stands, in the world. */
    placeOf(kind, i = 0) {
      const it = pickables[kind]?.[i];
      if (!it) return null;
      group.updateMatrixWorld();
      return v3(it.pos).applyMatrix4(group.matrixWorld);
    },
    /** The scene's scale, for the readout: what a metre along the corridor is worth. */
    setScale(s) {
      if (Math.abs(s - scaleNow) / scaleNow < 0.02 && s !== 1) return;
      scaleNow = s;
      drawControls();
    },
    /** The controls, for the field to make pressable. */
    controls: controls.mesh,
    /** The view's standing panels, which a card must keep off: the sign, Planet X's note, the controls. */
    panels: [sign.mesh, xSign.mesh, controls.mesh],
    /** The depth one visit reaches, for Planet X's sign. */
    setDepth(ab) { state.depthAB = ab; drawSign(); },
    /**
     * Gaia DR3 rows (surveySources), with Bailer-Jones distances by source
     * id when they came (`bj`: Map id → { r, lo, hi } in pc), or an Error.
     * `detected(ra, dec)` says whether SPHEREx sees the source in the visit on the screen.
     */
    setGaia(rows, opts = {}) {
      const { bj = null, detected = () => false, limit = null } = opts;
      const epoch = opts.epoch ?? 2026;
      state.gaiaLimit = limit;
      if (rows instanceof Error) {
        if (!state.failed.includes('Gaia DR3')) state.failed.push('Gaia DR3');
        state.gaia = { known: 0, unknown: 0 };
        state.asking = false;
        drawSign();
        return;
      }
      const objs = rows.map((r) => {
        const at = propagate(r, epoch, GAIA_EPOCH);
        // Geometric where it is known to 20 %, else the parallax (starDistance).
        const { pc, lo, hi, src } = starDistance(r, bj);
        return {
          id: r.id, dir: dirOf(at.ra, at.dec), au: pc ? pc * AU_PER_PC : null, mag: r.mag, pc, src,
          lo, hi, ra: at.ra, dec: at.dec,
          // Where it stands across the clock's span, by its proper motion alone:
          // the distance is held, since these rows carry no radial velocity.
          moves: Number.isFinite(r.pmRA) && Number.isFinite(r.pmDE),
          row: r,
        };
      });
      const placed = placeByDistance(objs);
      const known = placed.filter((p) => p.known).length;
      state.gaia = { known, unknown: placed.length - known };
      const segments = objs.filter((o) => o.pc && o.lo && o.hi).map((o) => [placeAlong(o.dir, o.lo * AU_PER_PC), placeAlong(o.dir, o.hi * AU_PER_PC)]);
      // Each star's path by its proper motion: every sample moved on the sky
      // and mapped as the star itself is (motionPath), on its own shell; one
      // that would leave the corridor stops at its edge, and its card says so.
      const pathOf = (o, p) => {
        if (!o.moves) return null;
        const m = motionPath((f) => propagate(o.row, epoch + f * STAR_YEARS, GAIA_EPOCH), { dirOf, axis: frame.f, coneRad: D.coneDeg * D2R });
        o.shortened = m.shortened;
        const at = (d) => placeAlong(d, p.known ? o.au : null);
        const keys = m.keys.map(at);
        // The four places the clock moves it between, and every sample for the drawn path.
        return Object.assign([keys[0], keys[1], keys[3], keys[4]], { samples: m.dirs.map(at) });
      };
      const items = placed.map((p, i) => ({
        pos: p.pos, known: p.known, path: pathOf(objs[i], p),
        // Brighter is larger; a star without a distance is a dim speck on the shell.
        sizeDeg: Math.max(0.16, Math.min(0.8, 0.8 - 0.05 * ((objs[i].mag ?? 18) - 8))) * (p.known ? 1 : 0.7),
        color: p.known ? look.ink : look.ruleStrong,
        solid: detected(objs[i].ra, objs[i].dec),
      }));
      const knownItems = items.filter((it) => it.known);
      const knownObjs = objs.filter((o, i) => placed[i].known);
      const layer = setLayer('gaia', knownItems, { segments, lineColor: look.neutral });
      // Faint trails along each star's motion, shown while the clock is off today.
      // The field's own star, if Gaia has it: its trail is kept whole and bright.
      const tHit = state.target ? matchTarget(state.target, rows, epoch) : null;
      const tObj = tHit ? objs[rows.indexOf(tHit)] : null;
      const tv3 = [];
      const tk = [];
      const hi = [];
      knownItems.forEach((it, i) => {
        if (!it.path) return;
        const five = [it.path[0], it.path[1], it.pos, it.path[2], it.path[3]];
        const bright = knownObjs[i] === tObj ? 1 : 0;
        for (let k = 0; k < 16; k++) {
          const a = -1 + k / 8;
          const b = -1 + (k + 1) / 8;
          tv3.push(...placeAt(five, a * STAR_YEARS), ...placeAt(five, b * STAR_YEARS));
          tk.push(a, b);
          hi.push(bright, bright);
        }
      });
      if (tv3.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(tv3, 3));
        geo.setAttribute('tk', new THREE.Float32BufferAttribute(tk, 1));
        geo.setAttribute('hi', new THREE.Float32BufferAttribute(hi, 1));
        const mat = new THREE.ShaderMaterial({
          uniforms: { when: clock.uniform, dir: clock.dirU, tint: { value: color(look.accentDim) }, hiTint: { value: color(look.ink) } },
          vertexShader: TRAIL_VERTEX, fragmentShader: TRAIL_FRAGMENT,
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        });
        const t = new THREE.LineSegments(geo, mat);
        t.frustumCulled = false;
        t.renderOrder = 6;
        t.userData.trail = true;
        t.visible = false;
        group.add(t);
        layer.objects.push(t);
      }
      followers.length = 0;
      const unknownLayer = setLayer('gaiaUnknown', items.filter((it) => !it.known), { plateLines: false });
      // The far shell named, and each thing on it: the "No distance" filter shows and hides exactly these.
      for (const it of items.filter((x) => !x.known).slice(0, 3)) {
        const l = addLabel([tv('vr.unknown')], it.pos, { tone: 'neutral', width: 10, priority: 1 });
        l.minor = true;
        unknownLayer.labels.push(l);
      }
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
      const five = (it) => [it.path[0], it.path[1], it.pos, it.path[2], it.path[3]];
      pickables.gaia = knownObjs.map((o, i) => {
        const it = knownItems[i];
        const pick = {
          pos: it.pos, card: starCard(o, it.solid), real: { ra: o.ra, dec: o.dec, au: o.au }, name: `Gaia DR3 ${o.id}`, key: `gaia:${o.id}`,
          pathNote: o.moves ? `${tv('vr.pathStarNote', { n: fmt(STAR_YEARS, 0) })}${o.shortened ? ` ${tv('vr.pathShortened')}` : ''}` : tv('vr.pathNone'),
          path: it.path?.samples?.length > 1 ? (layerOut) => {
            const pts = it.path.samples;
            layerOut.objects.push(...pathRibbon(pts, look.accent, { ticks: [pts[0], it.pos, pts.at(-1)] }));
          } : null,
        };
        if (it.path) followers.push({ path: five(it), pick });
        return pick;
      });
      const unknownObjs = objs.filter((o, i) => !placed[i].known);
      pickables.gaiaUnknown = items.filter((it) => !it.known).map((it, i) => ({ pos: it.pos, card: starCard(unknownObjs[i], it.solid), pathNote: tv('vr.pathNoDistance') }));
      // The field's own target, named, with where its distance comes from:
      // the Gaia source it is (by its id, or within 3″ and moving within 20 %
      // of its own motion), else a published parallax, else nothing.
      const t = state.target;
      if (t) {
        const hit = matchTarget(t, rows, epoch);
        const o = hit ? objs[rows.indexOf(hit)] : null;
        const fixed = (pc) => fmt(pc, pc < 10 ? 2 : 0);
        if (o?.pc) {
          const k = objs.indexOf(o);
          const label = addLabel([t.label, tv(o.src === 'bj' ? 'vr.distBJ' : 'vr.distPlx', { pc: fixed(o.pc) })], placed[k].pos, { tone: 'accent', priority: 6 });
          layer.labels.push(label);
          // The field's own star leads the clock's example: its name goes with it.
          if (items[k].path) followers.push({ path: [items[k].path[0], items[k].path[1], items[k].pos, items[k].path[2], items[k].path[3]], label });
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
      // Why the near part of the corridor is empty: a narrow cone holds little
      // volume close by. Stars expected there at the local density, from the
      // nearest one with a distance out to 200 pc.
      const nearPc = Math.max(1, Math.min(...objs.filter((o) => o.pc).map((o) => o.pc), 200));
      if (nearPc < CONE_FAR_PC / 2) {
        // The cone the sample really covers: out to its farthest star from the field's centre.
        const reachDeg = Math.max(...objs.map((o) => separation(o.ra, o.dec, field.ra, field.dec)), 1e-3);
        const omega = 2 * Math.PI * (1 - Math.cos(reachDeg * D2R));
        const expected = (omega / 3) * LOCAL_STARS_PC3 * (CONE_FAR_PC ** 3 - nearPc ** 3);
        const drawn = objs.filter((o) => o.pc >= nearPc && o.pc <= CONE_FAR_PC).length;
        const words = tv('vr.coneNote', {
          from: fmt(nearPc, nearPc < 10 ? 1 : 0), to: fmt(CONE_FAR_PC, 0), r: fmt(reachDeg * 60, 1),
          n: fmt(expected, expected < 10 ? 1 : 0), count: expected < 10 && expected % 1 ? 2 : Math.round(expected),
        });
        const mid = Math.sqrt(nearPc * CONE_FAR_PC) * AU_PER_PC;
        layer.labels.push(addLabel([words, tv('vr.coneShown', { m: drawn, g: fmt(state.gaiaLimit, 1) })], along(depthMetres(mid)).addScaledVector(v3(frame.u), cone(depthMetres(mid)) * 1.3).toArray(), { tone: 'neutral', width: 46, priority: 3 }));
      }
      unknownLayer.labels.push(addLabel([tv('vr.unknownShell')], along(unknownShell()).addScaledVector(v3(frame.u), cone(unknownShell()) * 0.7).toArray(), { tone: 'neutral', width: 16, priority: 2 }));
      state.asking = false;
      setYears(clock.years);
      drawSign();
      drawControls();
    },
    /**
     * The solar-system bodies at the visit on the screen (SkyBoT's or JPL's,
     * with dGeo), each with its path over the season: `tracks` Map name →
     * [{ ra, dec, au, mjd }].
     */
    setBodies(bodies, tracks = new Map(), { failed = false } = {}) {
      state.bodiesFailed = failed;
      if (!(bodies instanceof Error)) {
        when.bodies = [bodies, tracks];
        if (when.mjd != null) bodies = bodiesOn(bodies, tracks, when.mjd);
      }
      if (bodies instanceof Error) {
        if (!state.failed.includes('SkyBoT')) state.failed.push('SkyBoT');
        drawSign();
        return;
      }
      const withDistance = bodies.filter((b) => Number.isFinite(b.dGeo) && b.dGeo > 0);
      state.bodyAsked = true;
      state.bodies = withDistance;
      state.bodyNote = withDistance.length > 0;
      const items = withDistance.map((b) => ({ pos: placeAlong(dirOf(b.ra, b.dec), b.dGeo), sizeDeg: 1.0, color: look.counter, solid: Boolean(b.seen), known: true }));
      const layer = setLayer('bodies', items, { lineColor: look.counter });
      pickables.bodies = withDistance.map((b, i) => ({
        pos: items[i].pos,
        real: { ra: b.ra, dec: b.dec, au: b.dGeo },
        name: b.num ? `(${b.num}) ${b.name}` : b.name,
        key: `body:${b.name}`,
        pathNote: (tracks.get(b.name) ?? []).length >= 2 ? tv('vr.pathBodyNote') : tv('vr.pathOnePlace'),
        path: (tracks.get(b.name) ?? []).length >= 2 ? (layerOut) => {
          const track = tracks.get(b.name);
          const pts = track.map((p) => placeAlong(dirOf(p.ra, p.dec), p.au));
          layerOut.objects.push(...pathRibbon(pts, look.counter, { ticks: pts }));
          const day = (mjd) => formatDay(new Date((mjd - MJD_UNIX) * 86400000));
          layerOut.labels.push(addLabel([day(track[0].mjd)], pts[0], { tone: 'counter', width: 13, priority: 8 }));
          layerOut.labels.push(addLabel([day(track.at(-1).mjd)], pts.at(-1), { tone: 'counter', width: 13, priority: 8 }));
        } : null,
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
      // The nearest first: every one named while there is room among the names.
      const order = withDistance.map((b, i) => i).sort((p, q) => withDistance[p].dGeo - withDistance[q].dGeo);
      const day = (mjd) => formatDay(new Date((mjd - MJD_UNIX) * 86400000));
      // Each body's path over its season, faint, so where they are going reads at a glance.
      const faint = [];
      withDistance.forEach((b) => {
        const t = tracks.get(b.name) ?? [];
        for (let k = 1; k < t.length; k++) faint.push(...placeAlong(dirOf(t[k - 1].ra, t[k - 1].dec), t[k - 1].au), ...placeAlong(dirOf(t[k].ra, t[k].dec), t[k].au));
      });
      if (faint.length) layer.objects.push(lines(faint, look.counter, 0.5));
      order.slice(0, Math.max(0, Math.min(6, D.maxLabels + 2 - objectLabels()))).forEach((i) => {
        const b = withDistance[i];
        const name = b.num ? `(${b.num}) ${b.name}` : b.name;
        const second = Number.isFinite(b.mjd)
          ? tv('vr.bodyAtDate', { au: fmt(b.dGeo, 2), date: day(b.mjd) })
          : tv('vr.bodyAt', { au: fmt(b.dGeo, 2) });
        layer.labels.push(addLabel([name, second], items[i].pos, { tone: 'counter', priority: 5 }));
      });
      drawSign();
      drawControls();
    },
    /** SIMBAD galaxies with a spectroscopic redshift, or an Error. */
    setGalaxies(list) {
      if (list instanceof Error) { if (!state.failed.includes('SIMBAD')) state.failed.push('SIMBAD'); state.galaxies = []; drawSign(); return; }
      const objs = list.map((g) => {
        const { mpc, au } = galaxyDistance(g.z);
        return { g, dir: dirOf(g.ra, g.dec), mpc, au };
      });
      state.galaxies = objs.filter((o) => o.au);
      state.galaxyCount = objs.length;
      const items = objs.map((o) => ({ pos: placeAlong(o.dir, o.au), sizeDeg: 0.75, color: look.accent, solid: false, known: Boolean(o.au) }));
      const layer = setLayer('galaxies', items, { lineColor: look.accentDim });
      pickables.galaxies = objs.map((o, i) => ({
        pos: items[i].pos,
        real: o.au ? { ra: o.g.ra, dec: o.g.dec, au: o.au } : null,
        name: o.g.name,
        key: `galaxy:${o.g.name}`,
        pathNote: tv('vr.pathGalaxy', { z: fmt(o.g.z, 4), v: fmt(o.g.z * 299792.458, 0) }),
        path: o.au ? (layerOut) => {
          const a = items[i].pos;
          const u = unit(a);
          const b = [a[0] + u[0] * 0.25, a[1] + u[1] * 0.25, a[2] + u[2] * 0.25];
          layerOut.objects.push(...pathRibbon([a, b], look.accent));
        } : null,
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
        pathNote: tv('vr.pathNoDistance'),
        card: () => ({ title: tv('vr.candidate'), lines: [{ text: tv('vr.cardCandidate'), tone: 'counter' }, { text: `${formatRA(c.ra)}  ${formatDec(c.dec)}`, mono: true, tone: 'neutral' }] }),
      }));
      if (list.length && objectLabels() < D.maxLabels) layer.labels.push(addLabel([tv('vr.candidate')], items[0].pos, { tone: 'counter', width: 12 }));
      drawSign();
      drawControls();
    },
    /** Once a frame: labels near the viewer keep turning to face them as they move. */
    tick(headWorld) {
      if (clock.anim) {
        const k = Math.min(1, (performance.now() - clock.anim.t0) / READOUT_EASE_MS);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        const { from, to } = clock.anim;
        const then = k >= 1 ? clock.anim.then : null;
        if (k >= 1) clock.anim = null;
        clock.dirU.value = to >= from ? 1 : -1;
        setYears(from + (to - from) * e);
        if (!clock.anim) drawControls();
        if (then) playToward(then);
      }
      tickFocus(headWorld);
      const nowMs = performance.now();
      if (markFx.items.some((it) => nowMs - (markFx.born.get(it.n) ?? 0) < MARK_PULSE_MS + 100)) placeMarkers(nowMs);
      // "Identifying" breathes while the catalogues are out.
      for (const l of markFx.asking) l.mesh.material.opacity = 0.55 + 0.45 * Math.sin(nowMs / 300) ** 2;
      for (const b of markFx.beams) b.tick(nowMs / 1000);
      for (const b of pulsing) { if (b.mesh.parent) b.tick(nowMs / 1000); else pulsing.delete(b); }
      if (clock.playing) {
        const now = performance.now();
        const dt = Math.min(0.1, (now - clock.last) / 1000);
        clock.last = now;
        const next = clock.years + clock.dir * dt * CLOCK_YPS * (clock.fast ? 10 : 1);
        if (Math.abs(next) >= STAR_YEARS) { go('pause'); setYears(Math.sign(next) * STAR_YEARS); drawControls(); } else setYears(next);
      }
      // Every few frames, the names that would cover one another as seen
      // from where the viewer now stands: the more important one is shown.
      // Names are settled by where the head is, not where it looks: again only
      // once it has moved a few centimetres, or the names changed.
      if (++settleFrame % 8 === 0) {
        const sig = `${labels.length}|${labels.filter((l) => l.on !== false).length}`;
        if (!settledAt || settledAt.distanceTo(headWorld) > 0.05 || sig !== settledSig) {
          settleLabels(headWorld);
          settledAt = (settledAt ?? new THREE.Vector3()).copy(headWorld);
          settledSig = sig;
        }
      }
      group.updateMatrixWorld();
      const local = group.worldToLocal(headWorld.clone());
      for (const l of labels) {
        if (l.mesh.position.distanceTo(local) < D.faceWithinM) l.mesh.lookAt(headWorld);
      }
    },
    dispose() {
      for (const name of Object.keys(layers)) clearLayer(name);
      if (markFx.mesh) { markFx.mesh.geometry.dispose(); markFx.mesh.material.dispose(); }
      for (const l of labels.splice(0)) { dropLead(l); l.dispose(); }
      for (const o of statics) { o.geometry.dispose(); o.material.dispose(); }
      sign.dispose();
      xSign.dispose();
      controls.dispose();
      readout.dispose();
      clearFocus();
      for (const d of disposables) d.dispose();
      group.removeFromParent();
    },
  };
  return api;
}

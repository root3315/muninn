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
import { PLANET_NINE_V } from '../depth.js';
import {
  placeByDistance, depthMetres, unknownShell, parallaxDistancePc, redshiftDistanceMpc, MIN_REDSHIFT,
  AU_PER_PC, DEPTH_TICKS, PLANET_X_AU, decadeRings, viewFrame, fieldDirection,
} from './depth3d.js';
import { createPanel, FONTS, wrapText, fitText } from './panel.js';
import { LAYOUT, minTextPx } from './layout.js';
import { tv } from './strings.js';

const D2R = Math.PI / 180;
const D = LAYOUT.depth;
const MJD_UNIX = 40587;

const POINT_VERTEX = /* glsl */ `
  attribute float sizeDeg;
  attribute vec3 tint;
  attribute float solid;
  uniform float pxPerDeg;
  uniform float nearM;
  uniform float farM;
  uniform float falloff;
  varying vec3 vTint;
  varying float vSolid;
  varying float vDim;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(3.0, sizeDeg * pxPerDeg);
    vTint = tint;
    vSolid = solid;
    // A little dimmer toward the far end, so the near reads as near.
    vDim = mix(1.0, falloff, clamp((length(position) - nearM) / (farM - nearM), 0.0, 1.0));
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
export function createDepthView({ head, behind, field, look, pxPerDeg }) {
  const group = new THREE.Group();
  group.name = 'depth';
  group.position.copy(head);

  // The corridor rises a little, so the ring of visits below does not cut it.
  const axis = behind.clone().normalize().multiplyScalar(Math.cos(D.axisPitchDeg * D2R));
  axis.y = Math.sin(D.axisPitchDeg * D2R);
  const frame = viewFrame([axis.x, axis.y, axis.z]);
  const spread = D.coneDeg / Math.max(0.02, field.radiusDeg);
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const color = (c) => new THREE.Color(c);
  const along = (r) => v3(frame.f).multiplyScalar(r);
  const cone = (r) => r * Math.tan(D.coneDeg * D2R);

  const disposables = [];
  const layers = {};
  const labels = [];
  const state = {
    gaia: null, bodies: [], galaxies: null, candidates: [], failed: [], depthAB: null, total: 0,
    asking: true, target: field.target ?? null, bodyNote: false,
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

    // Planet X's shell: a translucent cap across the corridor, from 400 to 800 AU, left empty.
    const [r0, r1] = PLANET_X_AU.map((au) => depthMetres(au));
    const capGeo = new THREE.SphereGeometry((r0 + r1) / 2, 48, 8, 0, Math.PI * 2, 0, D.coneDeg * D2R);
    capGeo.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v3(frame.f)),
    ));
    const capMat = new THREE.MeshBasicMaterial({
      color: color(look.counter), transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.renderOrder = 4;
    group.add(cap);
    statics.push(cap);
    const xp = [];
    for (const r of [r0, r1]) circle(r, 64, xp);
    statics.push(lines(xp, look.counter, 0.6));
  }

  /* ---- labels: sized as angles, turned to the head ------------------- */
  function addLabel(textLines, pos, { tone = 'ink', width = 22, keep = false } = {}) {
    const p = v3(pos);
    const dist = Math.max(0.5, p.length());
    // The first line at body size (1.5°) at whatever distance it stands.
    const widthM = 2 * dist * Math.tan((width / 2) * D2R);
    const pxPerM = 640 / widthM;
    const px = minTextPx(pxPerM, dist);
    const heightM = ((px * 1.35) * textLines.length + px * 0.4) / pxPerM;
    const panel = createPanel({ widthM, heightM, pxPerM, name: 'depth-label' });
    panel.draw((ctx, W) => {
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(8, 8, 16, 0.95)';
      ctx.shadowBlur = 8;
      textLines.forEach((text, k) => {
        ctx.fillStyle = k === 0 ? (look[tone] ?? look.ink) : look.muted;
        ctx.font = `${k === 0 ? 500 : 400} ${k === 0 ? px : Math.round(px * 0.92)}px ${k === 0 ? FONTS.body : FONTS.mono}`;
        ctx.fillText(fitText(ctx, text, W - 10), W / 2, px * (1.05 + 1.35 * k));
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
      const r = depthMetres(t.au) * Math.cos(D.axisPitchDeg * D2R);
      // Either side of the ruler in turn: toward the far end the floor's
      // perspective packs the ticks close, and their names would touch.
      const p = flat.clone().multiplyScalar(r).addScaledVector(side, (k % 2 ? 1 : -1) * (0.25 + r * 0.06)).setY(-head.y + 0.02);
      addLabel([tv(`vr.tick.${t.key}`)], p.toArray(), { tone: 'neutral', width: 14, keep: true });
    });
  }

  /* ---- the sign at the mouth, and Planet X's -------------------------- */
  const sign = createPanel({ widthM: 1.05, heightM: 0.74, pxPerM: 760, name: 'depth-sign', transparent: false });
  {
    const p = v3(frame.f).multiplyScalar(1.75).addScaledVector(v3(frame.r), -1.1);
    p.y = -0.5;
    sign.mesh.position.copy(p);
    sign.mesh.lookAt(0, -0.15, 0);
    group.add(sign.mesh);
  }
  const xSign = createPanel({ widthM: 1.0, heightM: 0.46, pxPerM: 640, name: 'planet-x' });
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
      ctx.fillStyle = look.paper;
      ctx.fillRect(0, 0, W, H);
      ctx.lineWidth = 4;
      ctx.strokeStyle = look.ruleStrong;
      ctx.strokeRect(2, 2, W - 4, H - 4);
      const x = 30;
      const w = W - 60;
      const lh = signType.body + 8;
      let y = signType.heading + 18;
      ctx.fillStyle = look.ink;
      ctx.font = `600 ${signType.heading}px ${FONTS.display}`;
      ctx.fillText(fitText(ctx, tv('vr.depthTitle'), w), x, y);
      y += lh + 10;
      ctx.font = `400 ${signType.body}px ${FONTS.body}`;
      ctx.fillStyle = look.muted;
      y = wrapText(ctx, tv('vr.depthScale', { n: Math.round(spread) }), x, y, w, lh, 3) + 4;
      ctx.fillStyle = look.accent;
      const known = (state.gaia?.known ?? 0) + state.bodies.length + (state.galaxies?.length ?? 0);
      const counts = state.asking && !state.gaia ? tv('vr.depthAsking')
        : tv('vr.depthUnknown', { n: Math.max(0, state.total - known), m: state.total });
      y = wrapText(ctx, counts, x, y, w, lh, 2) + 4;
      if (state.bodyNote) {
        ctx.fillStyle = look.counter;
        y = wrapText(ctx, tv('vr.nearFar'), x, y, w, lh, 1) + 4;
      }
      if (state.failed.length) {
        ctx.fillStyle = look.counter;
        wrapText(ctx, state.failed.map((what) => tv('vr.depthFailed', { what })).join(' · '), x, y, w, lh, 1);
      }
    });
    xSign.draw((ctx, W) => {
      const px = 36;
      ctx.shadowColor = 'rgba(8, 8, 16, 0.95)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = look.counter;
      ctx.font = `600 ${px + 6}px ${FONTS.display}`;
      ctx.fillText(tv('vr.planetX'), 12, px + 10);
      ctx.font = `400 ${px}px ${FONTS.body}`;
      ctx.fillStyle = look.ink;
      const d = state.depthAB;
      const text = d != null
        ? tv('vr.planetXNote', { lo: fmt(PLANET_NINE_V.bright, 1), hi: fmt(PLANET_NINE_V.faint, 1), ab: fmt(d, 1), a: fmt(PLANET_NINE_V.bright - d, 1), b: fmt(PLANET_NINE_V.faint - d, 1) })
        : tv('vr.planetXWait', { lo: fmt(PLANET_NINE_V.bright, 1), hi: fmt(PLANET_NINE_V.faint, 1) });
      wrapText(ctx, text, 12, px * 2 + 26, W - 24, px + 8, 5);
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
    items.forEach((it, i) => {
      pos.set(it.pos, i * 3);
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
    const mat = new THREE.ShaderMaterial({
      uniforms: { pxPerDeg, nearM: { value: D.nearM }, farM: { value: D.unknownM }, falloff: { value: D.falloff } },
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
    return layer;
  }

  /** Labels are few: the field's own target, the bodies, a galaxy or two. */
  const objectLabels = () => labels.filter((l) => !l.keep).length;

  function placeAlong(dir, distAU) {
    const u = unit(dir);
    const r = distAU == null ? unknownShell() : depthMetres(distAU);
    return [u[0] * r, u[1] * r, u[2] * r];
  }

  return {
    group,
    /** The visit on the screen, as the plate's picture. */
    setPlate(texture) {
      if (plateMat.map === texture) return;
      plateMat.map = texture;
      plateMat.needsUpdate = true;
    },
    /** The depth one visit reaches, for Planet X's sign. */
    setDepth(ab) { state.depthAB = ab; drawSign(); },
    /** How many sources the field holds in all, for the count of those without a distance. */
    setTotal(n) { state.total = n; drawSign(); },
    /**
     * Gaia DR3 rows (surveySources), with Bailer-Jones distances by source
     * id when they came (`bj`: Map id → { r, lo, hi } in pc), or an Error.
     * `detected(ra, dec)` says whether SPHEREx sees the source in the visit on the screen.
     */
    setGaia(rows, { bj = null, epoch = 2026, detected = () => false } = {}) {
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
          id: r.id, dir: dirOf(at.ra, at.dec), au: pc ? pc * AU_PER_PC : null, mag: r.mag, pc,
          lo: geom?.lo ?? plx?.lo ?? null, hi: geom?.hi ?? plx?.hi ?? null, ra: at.ra, dec: at.dec,
        };
      });
      const placed = placeByDistance(objs);
      const known = placed.filter((p) => p.known).length;
      state.gaia = { known, unknown: placed.length - known };
      state.total = Math.max(state.total, rows.length + state.bodies.length + (state.galaxies?.length ?? 0));
      const segments = objs.filter((o) => o.pc && o.lo && o.hi).map((o) => [placeAlong(o.dir, o.lo * AU_PER_PC), placeAlong(o.dir, o.hi * AU_PER_PC)]);
      const items = placed.map((p, i) => ({
        pos: p.pos, known: p.known,
        // Brighter is larger; a star without a distance is a dim speck on the shell.
        sizeDeg: Math.max(0.16, Math.min(0.8, 0.8 - 0.05 * ((objs[i].mag ?? 18) - 8))) * (p.known ? 1 : 0.7),
        color: p.known ? look.ink : look.ruleStrong,
        solid: detected(objs[i].ra, objs[i].dec),
      }));
      const layer = setLayer('gaia', items, { segments, lineColor: look.neutral });
      // The field's own target, named.
      const t = state.target;
      if (t) {
        const near = objs.findIndex((o) => o.pc && Math.hypot(deltaRA(o.ra, t.ra) * Math.cos(t.dec * D2R), o.dec - t.dec) * 3600 < 30);
        if (near >= 0) {
          const o = objs[near];
          layer.labels.push(addLabel([t.label, tv('vr.starDistance', { pc: fmt(o.pc, o.pc < 10 ? 2 : 0), ly: fmt(o.pc * 3.2616, o.pc < 10 ? 1 : 0) })], placed[near].pos, { tone: 'accent' }));
        }
      }
      layer.labels.push(addLabel([tv('vr.unknown')], along(unknownShell()).addScaledVector(v3(frame.u), cone(unknownShell()) * 0.7).toArray(), { tone: 'neutral', width: 16 }));
      state.asking = false;
      drawSign();
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
        layer.labels.push(addLabel([name, second], items[i].pos, { tone: 'counter' }));
      });
      drawSign();
    },
    /** SIMBAD galaxies with a spectroscopic redshift, or an Error. */
    setGalaxies(list) {
      if (list instanceof Error) { state.failed.push('SIMBAD'); state.galaxies = []; drawSign(); return; }
      const objs = list.map((g) => {
        const mpc = g.z >= MIN_REDSHIFT ? redshiftDistanceMpc(g.z) : null;
        return { g, dir: dirOf(g.ra, g.dec), mpc, au: mpc ? mpc * 1e6 * AU_PER_PC : null };
      });
      state.galaxies = objs.filter((o) => o.au);
      state.total = Math.max(state.total, (state.gaia ? state.gaia.known + state.gaia.unknown : 0) + state.bodies.length + objs.length);
      const items = objs.map((o) => ({ pos: placeAlong(o.dir, o.au), sizeDeg: 0.75, color: look.accent, solid: false, known: Boolean(o.au) }));
      const layer = setLayer('galaxies', items, { lineColor: look.accentDim });
      const room = Math.max(0, Math.min(2, D.maxLabels - objectLabels()));
      objs.filter((o) => o.au).slice(0, room).forEach((o) => {
        layer.labels.push(addLabel([o.g.name, tv('vr.galaxyAt', { z: fmt(o.g.z, 4), mpc: fmt(o.mpc, 0) })], placeAlong(o.dir, o.au), { tone: 'accent' }));
      });
      drawSign();
    },
    /** SPHEREx's own finds with no catalogue match: on the far shell, as candidates. */
    setCandidates(list) {
      state.candidates = list;
      const items = list.map((c) => ({ pos: placeAlong(dirOf(c.ra, c.dec), null), sizeDeg: 1.0, color: look.counter, solid: false, known: false }));
      const layer = setLayer('candidates', items, { plateLines: false });
      if (list.length && objectLabels() < D.maxLabels) layer.labels.push(addLabel([tv('vr.candidate')], items[0].pos, { tone: 'counter', width: 12 }));
    },
    /** Once a frame: labels near the viewer keep turning to face them as they move. */
    tick(headWorld) {
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
      for (const d of disposables) d.dispose();
      group.removeFromParent();
    },
  };
}

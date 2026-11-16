/**
 * indepth.js — the field in depth, on the page: the headset's corridor
 * (vr/depthview.js) for a flat screen and a hand on a mouse or a glass.
 *
 * The visit on the plate stands at the mouth of a corridor, and every object
 * in the field leaves it from its own pixel along its own line of sight, as
 * far as its distance on one logarithmic scale in AU (vr/depth3d.js): a ring
 * for every power of ten, the named milestones (1 AU, Neptune, the Oort
 * cloud, a parsec, the Galactic centre, a megaparsec…) and a translucent
 * shell where Planet X is predicted, left empty.
 *
 * What is placed, and by what, is the headset's rule, from the same code:
 * Gaia DR3 stars by their geometric distance (Bailer-Jones et al. 2021) where
 * it is known to 20 %, else by a parallax measured to 20 %; the asteroids and
 * comets SkyBoT or JPL found in the field, at their distance at the visit's
 * moment; galaxies by spectroscopic redshift, as a comoving distance. What
 * has no measured distance is not given one: it waits on a far shell,
 * counted. A filled point is seen by SPHEREx in the visit on the plate; a
 * hollow one is in the catalogue only.
 *
 * Every placed thing is joined to the photo by a ray, as in the headset: from
 * its own pixel on the plate (the plate's own grid, so the ray leaves the
 * star in the picture) back to where it stands, bright at the photo and
 * fading with distance. The rays drawn are capped, the ones SPHEREx sees and
 * the brightest first; what has no distance gets only a short stub.
 *
 * Loaded only when the mode is chosen (app.js), so the page does not carry
 * three.js until someone asks for depth. It draws when something changed —
 * a turn, an answer, another visit, the rays' first growth out of the plate —
 * and not at all while it is off screen.
 */

import * as THREE from './vendor/three.module.js';
import { t, fmt, formatDay } from './i18n.js';
import { deltaRA } from './wcs.js';
import { propagate, GAIA_EPOCH, magLimit, searchRadius, epochOfMjd } from './overlay.js';
import { surveySources, formatRA, formatDec } from './catalog.js';
import { resolveColor } from './render.js';
import {
  placeByDistance, depthMetres, unknownShell, starDistance, galaxyDistance, matchTarget,
  AU_PER_PC, DEPTH_SCALE, DEPTH_TICKS, PLANET_X_AU, PLANET_X_MAX_BETA, eclipticLatitude,
  decadeRings, viewFrame, fieldDirection, plateUV, platePoint, capRays,
} from './vr/depth3d.js';
import { geometricDistances, galaxiesWithRedshift, bakedAnswers } from './vr/distances.js';
import { tv } from './vr/strings.js';

// Its own stylesheet, in before anything is laid out, so the names are measured in their real type.
await new Promise((resolve) => {
  if (document.querySelector('link[data-indepth]')) { resolve(); return; }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/indepth.css', import.meta.url).href;
  link.dataset.indepth = '';
  link.onload = resolve;
  link.onerror = resolve;
  document.head.append(link);
});

const D2R = Math.PI / 180;
const D = DEPTH_SCALE;
const MJD_UNIX = 40587;
/** A body's path is drawn over the visits this many days either side of the one on the plate. */
const SEASON_DAYS = 45;
/** Pointer travel, in CSS pixels, below which a press is a tap rather than a turn. */
const TAP_PX = 6;
/** How near a tap must land to a point to pick it, in CSS pixels. */
const PICK_PX = 18;
/** How long the rays take to grow out of the plate when the mode opens. */
const INTRO_MS = 1500;
/** The most rays drawn at once, on a wide plate and on a phone's: past that they are a fog. */
const MAX_RAYS = { wide: 70, narrow: 36 };
/** The most stubs drawn for things with no distance, and how far each runs past the plate, in metres. */
const MAX_STUBS = { wide: 60, narrow: 24 };
const STUB_M = 0.3;
/** The corridor, looked along from its mouth: −z ahead, x to the right, y up. */
const FRAME = viewFrame([0, 0, -1]);
const TAN_CONE = Math.tan(D.coneDeg * D2R);
const cone = (r) => r * TAN_CONE;

/**
 * The view as it opens: near the plate, a little above and to its side, so the
 * photo is the first thing seen and its rays run away behind it three-quarter.
 */
const HOME = { yaw: 0.38, pitch: 0.14, dist: 1.8, along: 1.55 };

/** Each kind of thing, the token it is drawn in, and whether the "No distance" switch holds it. */
const KINDS = ['stars', 'bodies', 'galaxies', 'unknown'];

const POINT_VERTEX = /* glsl */ `
  attribute float size;
  attribute vec3 tint;
  attribute float solid;
  uniform float dpr;
  uniform float nearM;
  uniform float farM;
  uniform float grow;
  varying vec3 vTint;
  varying float vSolid;
  varying float vDim;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(3.0, size * dpr);
    vTint = tint;
    vSolid = solid;
    // A little dimmer toward the far end, so the near reads as near (a depth cue, not a brightness);
    // and there only once the rays have reached it.
    vDim = mix(1.0, 0.65, clamp((length(position) - nearM) / (farM - nearM), 0.0, 1.0)) * smoothstep(0.7, 1.0, grow);
  }
`;

/*
 * A ray: one segment from the object's pixel on the plate (`start`) to where
 * it stands (`position`). `grow` runs it out from the plate as the mode
 * opens; the colour is the plate end's (`tint0`) fading to the far end's
 * (`tint`), each already scaled by how strongly the ray is drawn.
 */
const RAY_VERTEX = /* glsl */ `
  attribute vec3 start;
  attribute float along;
  attribute vec3 tint;
  attribute vec3 tint0;
  uniform float grow;
  uniform float dim;
  varying vec3 vTint;
  void main() {
    vec3 p = mix(start, position, along * grow);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vTint = mix(tint0, tint, grow) * dim;
  }
`;

const RAY_FRAGMENT = /* glsl */ `
  varying vec3 vTint;
  void main() { gl_FragColor = vec4(vTint, 1.0); }
`;

/** A soft glint where a ray leaves the photo. */
const GLINT_VERTEX = /* glsl */ `
  attribute float size;
  attribute vec3 tint;
  uniform float dpr;
  varying vec3 vTint;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * dpr;
    vTint = tint;
  }
`;

const GLINT_FRAGMENT = /* glsl */ `
  varying vec3 vTint;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = exp(-d * d * 5.0) * (1.0 - smoothstep(0.85, 1.0, d));
    if (a < 0.01) discard;
    gl_FragColor = vec4(vTint * a, 1.0);
  }
`;

const POINT_FRAGMENT = /* glsl */ `
  varying vec3 vTint;
  varying float vSolid;
  varying float vDim;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float disc = 1.0 - smoothstep(0.7, 1.0, d);
    float ring = disc * smoothstep(0.4, 0.6, d);
    float a = mix(ring, disc, vSolid) * vDim;
    if (a < 0.02) discard;
    gl_FragColor = vec4(vTint * a, 1.0);
  }
`;

/**
 * The catalogues' answers, kept by field for as long as the page is open: the
 * mode switched off and on again, or another visit, does not ask again.
 */
const answers = new Map();

/** The page's colour tokens, as three.js colours. */
function readLook(el) {
  const css = getComputedStyle(el);
  const pick = (token, fallback) => {
    try {
      const [r, g, b] = resolveColor(css.getPropertyValue(token).trim());
      return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    } catch {
      return new THREE.Color(fallback);
    }
  };
  return {
    well: pick('--color-well', '#05070d'),
    rule: pick('--color-rule', '#3a4658'),
    ruleStrong: pick('--color-rule-strong', '#6d7d92'),
    neutral: pick('--color-neutral', '#93a1b3'),
    ink: pick('--color-ink', '#eef2f6'),
    accent: pick('--color-accent', '#5fc3f0'),
    accentDim: pick('--color-accent-dim', '#3c8fbd'),
    counter: pick('--color-counter', '#f2b56b'),
  };
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const day = (mjd) => formatDay(new Date((mjd - MJD_UNIX) * 86400000), { year: true });
const pcText = (pc) => fmt(pc, pc < 10 ? 2 : pc < 100 ? 1 : 0);
const lyText = (pc) => t('indepth.lightYears', { ly: fmt(pc * 3.2616, pc < 30 ? 1 : 0) });

/**
 * Lay the view over `plate` (the figure that holds the sky canvas). `sky` is
 * the page's Sky; `field()` says what the page has open: `{ ra, dec, key,
 * target }`, key a demonstration field's name for its kept answers.
 * Returns `{ update, relabel, unmount }`.
 */
export function mountInDepth(plate, { sky, field }) {
  const root = el('div', 'indepth');
  const canvas = el('canvas', 'indepth__gl');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  const tags = el('div', 'indepth__tags');
  const legend = el('details', 'indepth__legend');
  const summary = el('summary', 'indepth__sum');
  const legendBody = el('div', 'indepth__body');
  legend.append(summary, legendBody);
  // Top right: the way back to the opening view, and how to hold it (on a narrow plate the panel says that).
  const corner = el('div', 'indepth__corner');
  const reset = el('button', 'btn btn--quiet indepth__reset');
  reset.type = 'button';
  const how = el('p', 'indepth__how');
  how.setAttribute('aria-hidden', 'true');
  // How many of the rays are drawn, when not all of them are: at the end of the switches along the foot.
  const raysNote = el('p', 'indepth__rays num');
  raysNote.hidden = true;
  corner.append(reset, how);
  // Along the foot: a switch for each kind, with its count.
  const kinds = el('div', 'indepth__kinds');
  const tip = el('div', 'tip indepth__tip');
  tip.hidden = true;
  const note = el('p', 'indepth__note');
  note.hidden = true;
  root.append(canvas, tags, legend, corner, kinds, tip, note);
  plate.append(root);
  // The corridor is the picture: the account of what is placed by what opens by itself only on a large plate.
  legend.open = plate.clientWidth >= 720 && plate.clientHeight >= 560;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch {
    note.textContent = t('indepth.noWebgl');
    note.hidden = false;
    return { update() {}, relabel() {}, unmount() { root.remove(); } };
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  const look = readLook(plate);
  renderer.setClearColor(look.well, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
  const view = { ...HOME };
  const shown = { stars: true, bodies: true, galaxies: true, unknown: true };

  /* ---- drawing on demand ------------------------------------------------ */
  let visible = true;
  let frame = 0;
  let dirty = true;
  // The rays grow out of the plate once, when there is first something to send out; still for
  // anyone who asked the system for less motion. Past that, a frame only when something changed.
  const grow = { value: matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0 };
  let introAt = null;
  function startIntro() {
    if (grow.value >= 1 || introAt != null) return;
    introAt = performance.now();
    invalidate();
  }
  function invalidate() {
    dirty = true;
    if (!visible || document.hidden || frame) return;
    frame = requestAnimationFrame(render);
  }
  function render() {
    frame = 0;
    if (!dirty) return;
    dirty = false;
    if (introAt != null) {
      const k = Math.min(1, (performance.now() - introAt) / INTRO_MS);
      grow.value = 1 - (1 - k) ** 3;
      if (k >= 1) { introAt = null; showLate(); }
    }
    tags.classList.toggle('indepth__tags--wait', grow.value < 1);
    placeCamera();
    renderer.render(scene, camera);
    placeTags();
    if (introAt != null) invalidate();
  }
  const seen = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible && dirty) invalidate();
  });
  seen.observe(root);
  // Listened to only now: with no WebGL the view returned above, before the
  // state invalidate() reads, and an opened legend would have thrown.
  legend.addEventListener('toggle', invalidate);
  const onVisibility = () => { if (!document.hidden && dirty) invalidate(); };
  document.addEventListener('visibilitychange', onVisibility);
  const sized = new ResizeObserver(() => {
    const w = Math.max(1, root.clientWidth);
    const h = Math.max(1, root.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate();
  });
  sized.observe(root);

  function placeCamera() {
    // A tall screen sees less of the corridor's length: stand further back.
    const back = view.dist * Math.max(1, 1.25 / camera.aspect);
    const target = new THREE.Vector3(0, 0, -view.along);
    camera.position.set(
      target.x + back * Math.sin(view.yaw) * Math.cos(view.pitch),
      target.y + back * Math.sin(view.pitch),
      target.z + back * Math.cos(view.yaw) * Math.cos(view.pitch),
    );
    camera.lookAt(target);
  }

  /* ---- the field's geometry: plate, rings, Planet X, the far shell ------ */
  const statics = new THREE.Group();
  const objects = new THREE.Group();
  // The one thing pointed at: its ray whole, a ring on its pixel, a ring where it stands.
  const focus = new THREE.Group();
  focus.renderOrder = 9;
  scene.add(statics, objects, focus);
  const plateMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide });
  let plateTex = null;
  /** The plate's corners in the corridor: bottom-left, bottom-right, top-right, top-left as seen from its front. */
  let plateCorners = null;
  /** What a tap or a hover can land on: `{ key, pos, start, kind, color, known, card() }`. */
  let pickables = [];

  function disposeGroup(g) {
    g.traverse((o) => {
      o.geometry?.dispose();
      if (o.material && o.material !== plateMat) o.material.dispose();
    });
    g.clear();
  }

  function lines(points, color, opacity, { dashed = false } = {}) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, depthWrite: false, dashSize: 0.06, gapSize: 0.05 })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    const obj = new THREE.LineSegments(geo, mat);
    if (dashed) obj.computeLineDistances();
    return obj;
  }

  /** A circle across the corridor `r` metres from its mouth, as segments. */
  function circle(r, out, N = 72) {
    const R = cone(r);
    for (let k = 0; k < N; k++) {
      for (const kk of [k, k + 1]) {
        const a = (kk / N) * Math.PI * 2;
        out.push(R * Math.cos(a), R * Math.sin(a), -r);
      }
    }
    return out;
  }

  let spread = 1;
  let built = null;
  let dirOf = () => [0, 0, -1];

  function buildStatics(grid, radiusDeg, beta) {
    disposeGroup(statics);
    spread = D.coneDeg / Math.max(0.02, radiusDeg);
    const f = field();
    dirOf = (ra, dec) => fieldDirection(deltaRA(ra, f.ra) * Math.cos(f.dec * D2R), dec - f.dec, FRAME, spread);
    const unit = (d) => { const l = Math.hypot(...d); return [d[0] / l, d[1] / l, d[2] / l]; };

    // The plate: the visit at the corridor's mouth, east on the left and north up, as on the page.
    const hw = grid.fovDeg / 2;
    const hh = grid.fovHeightDeg / 2;
    const corner = (e, n) => unit(fieldDirection(e, n, FRAME, spread)).map((x) => x * D.nearM);
    const pts = [corner(hw, -hh), corner(-hw, -hh), corner(-hw, hh), corner(hw, hh)];
    plateCorners = pts;
    const plateGeo = new THREE.BufferGeometry();
    plateGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
    plateGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    plateGeo.setIndex([0, 1, 2, 0, 2, 3]);
    const plateMesh = new THREE.Mesh(plateGeo, plateMat);
    plateMesh.renderOrder = 1;
    statics.add(plateMesh);
    statics.add(lines([...pts[0], ...pts[1], ...pts[1], ...pts[2], ...pts[2], ...pts[3], ...pts[3], ...pts[0]], look.ruleStrong, 0.9));

    // A ring for every power of ten, and the named distances a little stronger.
    const rings = [];
    for (const au of decadeRings()) circle(depthMetres(au), rings);
    statics.add(lines(rings, look.ruleStrong, 0.16));
    const named = [];
    for (const tk of DEPTH_TICKS) for (const au of [tk.au, tk.to].filter(Boolean)) circle(depthMetres(au), named);
    statics.add(lines(named, look.neutral, 0.32));
    // The corridor's floor line, mouth to the far shell, that the milestones are read along.
    statics.add(lines([0, -cone(D.nearM), -D.nearM, 0, -cone(D.unknownM), -D.unknownM], look.neutral, 0.4));

    // Planet X: where it is predicted, a faint band between two circles, left empty.
    const [r0, r1] = PLANET_X_AU.map((au) => depthMetres(au));
    const bandGeo = new THREE.CylinderGeometry(cone(r1), cone(r0), r1 - r0, 72, 1, true);
    bandGeo.rotateX(-Math.PI / 2);
    bandGeo.translate(0, 0, -(r0 + r1) / 2);
    const here = Math.abs(beta) <= PLANET_X_MAX_BETA;
    const band = new THREE.Mesh(bandGeo, new THREE.MeshBasicMaterial({
      color: look.counter, transparent: true, opacity: here ? 0.13 : 0.05, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    }));
    statics.add(band);
    statics.add(lines([...circle(r0, []), ...circle(r1, [])], look.counter, here ? 0.7 : 0.3));

    // The far shell, for what has no measured distance: dashed, as a place set aside rather than a distance.
    statics.add(lines(circle(unknownShell(), []), look.ruleStrong, 0.55, { dashed: true }));
  }

  /* ---- the catalogues ---------------------------------------------------- */
  let ctrl = new AbortController();
  /** The field's answers and how each stands: 'asking', 'ok' or 'failed'. */
  let got = null;

  function ask(kind) {
    const f = field();
    const grid = sky.grid;
    if (!grid || !got) return;
    const radiusDeg = searchRadius(grid.fovDeg, grid.fovHeightDeg);
    const where = { ra: f.ra, dec: f.dec, radiusDeg };
    const mine = got;
    const signal = ctrl.signal;
    mine.status[kind] = 'asking';
    mine.baked ??= bakedAnswers(f.key, signal);
    const asked = (async () => {
      const baked = await mine.baked;
      if (kind === 'gaia') {
        const have = sky.surveys?.gaia;
        return baked?.gaia ?? (have?.rows ? have : await surveySources('gaia', { ...where, limit: magLimit(grid.fovHeightDeg) }, { signal }));
      }
      if (kind === 'bj') {
        return baked?.bj ? new Map(baked.bj.map(([id, r, lo, hi]) => [id, { r, lo, hi }])) : geometricDistances(where, signal);
      }
      return baked?.galaxies ?? galaxiesWithRedshift(where, signal);
    })();
    asked.then((value) => {
      mine[kind] = value;
      mine.status[kind] = 'ok';
    }, () => {
      // A field closed or the mode left: asked again next time, not counted as failed.
      if (signal.aborted) delete mine.status[kind];
      else mine.status[kind] = 'failed';
    }).finally(() => {
      if (got === mine && !signal.aborted) { placeObjects(); drawLegend(); invalidate(); }
    });
  }

  /* ---- the things in the field ------------------------------------------ */
  let counts = {};

  /** The bodies SkyBoT or JPL named in the field, each once, at the answered visit nearest the plate's, with its season's path. */
  function bodiesNow(current) {
    const answered = sky.visits.filter((v) => sky.knownObjects.has(v.frame.obsId));
    if (!answered.length) return { list: [], asked: false };
    const ref = current?.frame.mjd ?? answered[answered.length >> 1].frame.mjd;
    const byName = new Map();
    for (const v of answered) {
      for (const o of sky.knownObjects.get(v.frame.obsId) ?? []) {
        if (!(Number.isFinite(o.dGeo) && o.dGeo > 0)) continue;
        if (!byName.has(o.name)) byName.set(o.name, []);
        byName.get(o.name).push({ o, v });
      }
    }
    const list = [];
    for (const seenAt of byName.values()) {
      seenAt.sort((p, q) => Math.abs(p.v.frame.mjd - ref) - Math.abs(q.v.frame.mjd - ref));
      const { o, v } = seenAt[0];
      const track = seenAt.filter((p) => Math.abs(p.v.frame.mjd - v.frame.mjd) <= SEASON_DAYS)
        .map((p) => ({ ra: p.o.ra, dec: p.o.dec, au: p.o.dGeo, mjd: p.v.frame.mjd }))
        .sort((p, q) => p.mjd - q.mjd);
      const onPlate = current && v === current;
      list.push({ ...o, mjd: v.frame.mjd, track, seen: Boolean(onPlate) && detected(current, o.ra, o.dec) });
    }
    return { list, asked: true };
  }

  function detected(v, ra, dec) {
    if (!v || !sky.grid) return false;
    const m = sky.measure(v, ra, dec, { minSnr: 5 });
    return Boolean(m && (m.saturated || m.snr >= 5));
  }

  function points(items) {
    const n = items.length;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const tint = new Float32Array(n * 3);
    const solid = new Float32Array(n);
    const c = new THREE.Color();
    items.forEach((it, i) => {
      pos.set(it.pos, i * 3);
      size[i] = it.size;
      // The shader writes its colour straight to the screen: the token's own sRGB numbers.
      it.color.getRGB(c, THREE.SRGBColorSpace);
      tint.set([c.r, c.g, c.b], i * 3);
      solid[i] = it.solid ? 1 : 0;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
    geo.setAttribute('solid', new THREE.BufferAttribute(solid, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { dpr: { value: dpr }, nearM: { value: D.nearM }, farM: { value: D.unknownM }, grow },
      vertexShader: POINT_VERTEX, fragmentShader: POINT_FRAGMENT,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    p.renderOrder = 5;
    return p;
  }

  /** Where a thing's ray leaves the plate: its own pixel in the picture, else (off the picture) its direction at the plate's distance. */
  function startOf(ra, dec, dir) {
    const uv = plateCorners ? plateUV(sky.grid, ra, dec) : null;
    if (uv) return platePoint(plateCorners, uv.u, uv.v);
    const l = Math.hypot(...dir);
    return [(dir[0] / l) * D.nearM, (dir[1] / l) * D.nearM, (dir[2] / l) * D.nearM];
  }

  /** Drawn only once the rays have grown out to them (paths, ±1σ): the intro sends out the rays alone. */
  function late(obj) {
    obj.userData.late = true;
    obj.visible = grow.value >= 1;
    return obj;
  }
  function showLate() {
    objects.traverse((o) => { if (o.userData.late) o.visible = true; });
  }

  /**
   * Rays `{ start, pos, color, strength, tail }`, additive and thin: bright
   * where they leave the photo, down to `tail` of that at the far end. Drawn
   * twice: in full where nothing stands in front, and faintly where the
   * plate does, so a ray is followed back through the picture to its pixel.
   */
  function rayLines(list) {
    const n = list.length;
    const position = new Float32Array(n * 6);
    const start = new Float32Array(n * 6);
    const along = new Float32Array(n * 2);
    const tint = new Float32Array(n * 6);
    const tint0 = new Float32Array(n * 6);
    const c = new THREE.Color();
    list.forEach((r, i) => {
      position.set(r.start, i * 6);
      position.set(r.pos, i * 6 + 3);
      start.set(r.start, i * 6);
      start.set(r.start, i * 6 + 3);
      along[i * 2 + 1] = 1;
      r.color.getRGB(c, THREE.SRGBColorSpace);
      const near = [c.r * r.strength, c.g * r.strength, c.b * r.strength];
      const far = near.map((x) => x * r.tail);
      tint.set(near, i * 6);
      tint.set(far, i * 6 + 3);
      tint0.set(near, i * 6);
      tint0.set(near, i * 6 + 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('start', new THREE.BufferAttribute(start, 3));
    geo.setAttribute('along', new THREE.BufferAttribute(along, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
    geo.setAttribute('tint0', new THREE.BufferAttribute(tint0, 3));
    const pass = (dim, depthFunc) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { grow, dim: { value: dim } },
        vertexShader: RAY_VERTEX, fragmentShader: RAY_FRAGMENT,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, depthFunc,
      });
      const obj = new THREE.LineSegments(geo, mat);
      obj.frustumCulled = false;
      obj.renderOrder = 4;
      return obj;
    };
    // The second pass shares the geometry; disposing it twice is harmless.
    return [pass(1, THREE.LessEqualDepth), pass(0.3, THREE.GreaterDepth)];
  }

  /** A soft glint on the photo at each ray's pixel. */
  function glints(list) {
    const pos = new Float32Array(list.length * 3);
    const size = new Float32Array(list.length);
    const tint = new Float32Array(list.length * 3);
    const c = new THREE.Color();
    list.forEach((r, i) => {
      pos.set(r.start, i * 3);
      size[i] = 5 + 7 * r.strength;
      r.color.getRGB(c, THREE.SRGBColorSpace);
      tint.set([c.r * r.strength * 0.7, c.g * r.strength * 0.7, c.b * r.strength * 0.7], i * 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { dpr: { value: dpr } },
      vertexShader: GLINT_VERTEX, fragmentShader: GLINT_FRAGMENT,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
    });
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    p.renderOrder = 3;
    return p;
  }

  /** How strongly a ray is drawn, by kind and, for a star, by its brightness and whether SPHEREx sees it. */
  const starStrength = (mag, seen) => Math.max(0.16, Math.min(0.7, 0.7 - 0.06 * ((mag ?? 18) - 9))) * (seen ? 1 : 0.55);
  /** How much of a ray's light is left at its far end: a near one stays bright, a far one fades out. */
  const tailAt = (pos) => 0.75 - 0.63 * Math.max(0, Math.min(1, (Math.hypot(...pos) - D.nearM) / (D.farM - D.nearM)));

  /** Is this body the field's own, the one the field is named for (by its name, or a demonstration field's)? */
  function ownBody(b, f) {
    const label = String(f.label || (f.key ? t(`preset.${f.key}`) : '')).toLowerCase();
    if (!label) return false;
    return Boolean(b.num && label.includes(`(${b.num})`)) || label.split(/[\s·,()]+/).includes(String(b.name).toLowerCase());
  }

  function placeObjects() {
    disposeGroup(objects);
    const current = sky.current;
    const epoch = current ? epochOfMjd(current.frame.mjd) : 2026;
    const f = field();
    const layer = Object.fromEntries(KINDS.map((k) => [k, new THREE.Group()]));
    for (const k of KINDS) { layer[k].visible = shown[k]; objects.add(layer[k]); }
    const objTags = [];
    pickables = [];
    counts = { bj: 0, plx: 0, stars: 0, unknown: 0, bodies: 0, galaxies: 0, galaxiesAll: 0, bodiesAsked: false };
    /** Every ray there could be, `{ kind, start, pos, color, strength, tail, score, bar }`; capped below. */
    const rays = [];
    const stubs = [];
    const pick = (p) => { pickables.push(p); return p; };

    // Stars: Gaia DR3, carried to the visit's epoch, by geometric distance or parallax.
    const rows = got?.gaia?.rows ?? [];
    const stars = rows.map((r) => {
      const at = propagate(r, epoch, GAIA_EPOCH);
      const d = starDistance(r, got?.bj instanceof Map ? got.bj : null);
      return { r, at, d, dir: dirOf(at.ra, at.dec), au: d.pc ? d.pc * AU_PER_PC : null };
    });
    const placed = placeByDistance(stars.map((s) => ({ id: s.r.id, dir: s.dir, au: s.au })));
    const known = [];
    const unknown = [];
    placed.forEach((p, i) => {
      const s = stars[i];
      const seenHere = detected(current, s.at.ra, s.at.dec);
      const start = startOf(s.at.ra, s.at.dec, s.dir);
      const it = {
        pos: p.pos, solid: seenHere,
        // Brighter is larger; one without a distance is a dim speck on the far shell.
        size: Math.max(3, Math.min(9, 9 - 0.45 * ((s.r.mag ?? 18) - 8))) * (p.known ? 1 : 0.75),
        color: p.known ? look.ink : look.ruleStrong,
      };
      (p.known ? known : unknown).push(it);
      const strength = starStrength(s.r.mag, seenHere);
      // Seen by SPHEREx first, then the brighter.
      const score = (seenHere ? 1000 : 0) + 30 - (s.r.mag ?? 25);
      if (p.known) {
        counts[s.d.src] += 1;
        let bar = null;
        if (s.d.lo && s.d.hi) {
          const a = placeByDistance([{ dir: s.dir, au: s.d.lo * AU_PER_PC }, { dir: s.dir, au: s.d.hi * AU_PER_PC }]);
          bar = [...a[0].pos, ...a[1].pos];
        }
        rays.push({ kind: 'stars', start, pos: p.pos, color: look.ink, strength, tail: tailAt(p.pos), score, bar });
      } else {
        // No distance: a short stub along its line of sight, no further than anything can be said.
        const l = Math.hypot(...start);
        const end = start.map((x) => x * (1 + STUB_M / l));
        stubs.push({ kind: 'unknown', start, pos: end, color: look.neutral, strength: strength * 0.8, tail: 0, score });
      }
      pick({ key: `star:${s.r.id}`, pos: p.pos, start, kind: p.known ? 'stars' : 'unknown', color: p.known ? look.ink : look.neutral, known: p.known, card: () => starCard(s, seenHere) });
    });
    counts.stars = known.length;
    counts.unknown = unknown.length;
    if (known.length) layer.stars.add(points(known));
    if (unknown.length) layer.unknown.add(points(unknown));

    // The field's own target, where its distance comes from: the Gaia source it is, else a published parallax, else none.
    const target = f.target;
    if (target && (rows.length || got?.status.gaia === 'failed')) {
      const hit = rows.length ? matchTarget(target, rows, epoch) : null;
      const s = hit ? stars[rows.indexOf(hit)] : null;
      const at = propagate(target, epoch, target.epoch ?? GAIA_EPOCH);
      const lit = !s?.d.pc && target.plx > 0 ? 1000 / target.plx : null;
      const pc = s?.d.pc ?? lit;
      const dir = dirOf(at.ra, at.dec);
      const [p] = placeByDistance([{ dir, au: pc ? pc * AU_PER_PC : null }]);
      const words = s?.d.pc
        ? tv(s.d.src === 'bj' ? 'vr.distBJ' : 'vr.distPlx', { pc: pcText(pc) })
        : lit ? tv('vr.distLit', { pc: pcText(lit), ref: target.ref ?? '' }) : tv('vr.notMeasured');
      const it = { pos: p.pos, size: 12, color: look.accent, solid: detected(current, at.ra, at.dec) };
      layer.stars.add(points([it]));
      const start = startOf(at.ra, at.dec, dir);
      if (p.known) rays.push({ kind: 'stars', start, pos: p.pos, color: look.accent, strength: 1, tail: Math.max(0.35, tailAt(p.pos)), score: 1e6 });
      // On the corridor only how far, in light-years; the card says by what.
      const short = pc ? lyText(pc) : tv('vr.notMeasured');
      // The field's own object is named first of all, before the plate itself.
      objTags.push({ pos: p.pos, kind: 'stars', priority: 12, tone: 'accent', title: target.label ?? '', sub: short });
      pick({ key: 'target', pos: p.pos, start, kind: 'stars', color: look.accent, known: p.known, card: () => ({ title: target.label ?? '', rows: [words, `${formatRA(at.ra)}  ${formatDec(at.dec)}`] }) });
    }

    // Asteroids and comets: where SkyBoT or JPL put them at the visit, with the season's path.
    const bodies = bodiesNow(current);
    counts.bodiesAsked = bodies.asked;
    counts.bodies = bodies.list.length;
    if (bodies.list.length) {
      const items = bodies.list.map((b) => {
        const dir = dirOf(b.ra, b.dec);
        return { pos: placeByDistance([{ dir, au: b.dGeo }])[0].pos, start: startOf(b.ra, b.dec, dir), size: 10, color: look.counter, solid: b.seen };
      });
      layer.bodies.add(points(items));
      const path = [];
      for (const b of bodies.list) {
        const pts = b.track.map((p) => placeByDistance([{ dir: dirOf(p.ra, p.dec), au: p.au }])[0].pos);
        for (let k = 1; k < pts.length; k++) path.push(...pts[k - 1], ...pts[k]);
      }
      if (path.length) layer.bodies.add(late(lines(path, look.counter, 0.8)));
      const order = bodies.list.map((b, i) => i).sort((p, q) => bodies.list[p].dGeo - bodies.list[q].dGeo);
      let named = 0;
      order.forEach((i) => {
        const b = bodies.list[i];
        const own = ownBody(b, f);
        const name = b.num ? `(${b.num}) ${b.name}` : b.name;
        const sub = current && b.mjd === current.frame.mjd ? tv('vr.bodyAt', { au: fmt(b.dGeo, 2) }) : tv('vr.bodyAtDate', { au: fmt(b.dGeo, 2), date: day(b.mjd) });
        rays.push({
          kind: 'bodies', start: items[i].start, pos: items[i].pos, color: look.counter,
          strength: own ? 1 : b.seen ? 0.85 : 0.6, tail: Math.max(0.4, tailAt(items[i].pos)), score: own ? 1e6 : 1e5 + (b.seen ? 1e3 : 0) - b.dGeo,
        });
        // The field's own body is named before anything else; then the nearest few.
        if (own) objTags.push({ pos: items[i].pos, kind: 'bodies', priority: 12, tone: 'counter', title: name, sub });
        else if (named < 4) { named += 1; objTags.push({ pos: items[i].pos, kind: 'bodies', priority: 9 - named * 0.1, tone: 'counter', title: name, sub }); }
        pick({
          key: `body:${b.name}`, pos: items[i].pos, start: items[i].start, kind: 'bodies', color: look.counter, known: true,
          card: () => ({
            title: name,
            rows: [
              `${tv('vr.cardBody')}${b.cls ? ` · ${b.cls}` : ''}${Number.isFinite(b.mag) ? ` · V ${fmt(b.mag, 1)}` : ''}`,
              tv('vr.cardBodyAt', { au: fmt(b.dGeo, 3) }),
              t(b.seen ? 'indepth.seen' : 'indepth.notSeen'),
            ],
          }),
        });
      });
    }

    // Galaxies with a spectroscopic redshift, at their comoving distance.
    const galaxies = Array.isArray(got?.galaxies) ? got.galaxies : [];
    counts.galaxiesAll = galaxies.length;
    const gal = galaxies.map((g) => ({ g, ...galaxyDistance(g.z) }));
    const galKnown = gal.filter((o) => o.au);
    counts.galaxies = galKnown.length;
    if (gal.length) {
      const items = gal.map((o) => {
        const dir = dirOf(o.g.ra, o.g.dec);
        const [p] = placeByDistance([{ dir, au: o.au }]);
        return { pos: p.pos, start: startOf(o.g.ra, o.g.dec, dir), size: 8, color: o.au ? look.accent : look.ruleStrong, solid: false, known: p.known };
      });
      layer.galaxies.add(points(items));
      gal.forEach((o, i) => {
        const it = items[i];
        if (it.known) rays.push({ kind: 'galaxies', start: it.start, pos: it.pos, color: look.accent, strength: 0.45, tail: tailAt(it.pos), score: 15 });
        const sub = o.au ? tv('vr.galaxyAt', { z: fmt(o.g.z, 4), mpc: fmt(o.mpc, 0) }) : `z ${fmt(o.g.z, 4)} · ${tv('vr.unknown')}`;
        if (o.au && objTags.filter((x) => x.kind === 'galaxies').length < 2) {
          objTags.push({ pos: it.pos, kind: 'galaxies', priority: 7, tone: 'accent', title: o.g.name, sub });
        }
        pick({
          key: `galaxy:${o.g.name}`, pos: it.pos, start: it.start, kind: o.au ? 'galaxies' : 'unknown', color: look.accent, known: it.known,
          card: () => ({
            title: o.g.name,
            rows: [tv('vr.cardGalaxy'), o.au ? tv('vr.cardGalaxyAt', { z: fmt(o.g.z, 4), mpc: fmt(o.mpc, 0) }) : sub, `${formatRA(o.g.ra)}  ${formatDec(o.g.dec)}`],
          }),
        });
      });
    }

    // The rays: as many as stay readable, the rest said in a line; each kind on its own switch.
    const narrow = root.clientWidth < 440;
    const { drawn, total } = capRays(rays, narrow ? MAX_RAYS.narrow : MAX_RAYS.wide);
    for (const kind of ['stars', 'bodies', 'galaxies']) {
      const mine = drawn.filter((r) => r.kind === kind);
      if (!mine.length) continue;
      layer[kind].add(...rayLines(mine), glints(mine));
      // A star's ±1σ along its ray, for the rays drawn.
      const bars = mine.flatMap((r) => r.bar ?? []);
      if (bars.length) layer[kind].add(late(lines(bars, look.ink, 0.5)));
    }
    raysNote.hidden = drawn.length >= total;
    raysNote.textContent = t('indepth.raysShown', { n: drawn.length, m: total });
    raysNote.title = t('indepth.raysWhy');

    // What has no distance: stubs only, and one name saying how many.
    const stubCut = capRays(stubs, narrow ? MAX_STUBS.narrow : MAX_STUBS.wide).drawn;
    if (stubCut.length && plateCorners) {
      layer.unknown.add(...rayLines(stubCut));
      const br = plateCorners[1];
      const l = Math.hypot(...br);
      objTags.push({
        pos: br.map((x) => x * (1 + STUB_M / l)), kind: 'unknown', priority: 6.5, tone: 'neutral',
        title: t('indepth.stubs', { n: unknown.length }),
      });
    }
    // The growth waits for the stars, the bulk of it, so it is seen once and whole.
    if ((rays.length || stubs.length) && got?.status.gaia !== 'asking') startIntro();

    setObjectTags(objTags);
    refocus();
    drawLegend();
  }

  function starCard(s, seenHere) {
    const { d } = s;
    return {
      title: `Gaia DR3 ${s.r.id}`,
      rows: [
        `${tv('vr.cardStar')} · G ${fmt(s.r.mag, 1)}`,
        d.pc ? tv(d.src === 'bj' ? 'vr.cardBJ' : 'vr.cardPlx', { pc: pcText(d.pc), lo: pcText(d.lo), hi: pcText(d.hi) }) : tv('vr.cardStarNoDist'),
        ...(d.pc ? [lyText(d.pc)] : []),
        t(seenHere ? 'indepth.seen' : 'indepth.notSeen'),
        `${formatRA(s.at.ra)}  ${formatDec(s.at.dec)}`,
      ],
    };
  }

  /* ---- labels over the canvas -------------------------------------------- */
  let fixedTags = [];
  function makeTag({ pos, kind = null, priority = 1, tone = 'neutral', title, sub = '', cls = '' }) {
    const node = el('div', `indepth__tag indepth__tag--${tone} ${cls}`.trim());
    node.append(el('span', 'indepth__tag-t', title));
    if (sub) node.append(el('span', 'indepth__tag-s num', sub));
    tags.append(node);
    return { node, pos: new THREE.Vector3(...pos), kind, priority, w: 0, h: 0 };
  }
  function measure(list) {
    for (const g of list) { g.w = g.node.offsetWidth; g.h = g.node.offsetHeight; }
  }
  let objectTags = [];
  let plateG = null;
  const allTags = () => [...fixedTags, ...(plateG ? [plateG] : []), ...objectTags];
  function setObjectTags(list) {
    for (const g of objectTags) g.node.remove();
    objectTags = list.map(makeTag);
    measure(objectTags);
  }
  function buildFixedTags(beta) {
    for (const g of fixedTags) g.node.remove();
    const here = Math.abs(beta) <= PLANET_X_MAX_BETA;
    const list = DEPTH_TICKS.map((tk, k) => {
      const r = depthMetres(tk.to ? Math.sqrt(tk.au * tk.to) : tk.au);
      // The few a reader steers by stand above the rest when the corridor is crowded.
      const major = ['au1', 'neptune', 'pc1', 'gc', 'mpc1'].includes(tk.key);
      return { pos: [0, -cone(r), -r], priority: major ? 5 : 4 - k * 0.01, tone: 'neutral', title: tv(`vr.tick.${tk.key}`), cls: 'indepth__tag--tick' };
    });
    const [r0, r1] = PLANET_X_AU.map((au) => depthMetres(au));
    const rm = (r0 + r1) / 2;
    list.push({
      pos: [0, cone(rm), -rm], priority: 8, tone: 'counter',
      title: tv(here ? 'vr.planetX' : 'vr.planetXAway'),
      sub: here
        ? t('indepth.planetXAt', { near: PLANET_X_AU[0], far: PLANET_X_AU[1] })
        : t('indepth.planetXBeta', { beta: `${beta >= 0 ? '+' : '−'}${fmt(Math.abs(beta), 0)}`, max: PLANET_X_MAX_BETA }),
    });
    list.push({ pos: [cone(unknownShell()) * 0.7, cone(unknownShell()) * 0.72, -unknownShell()], priority: 6, tone: 'neutral', title: t('indepth.farShell'), kind: 'unknown' });
    fixedTags = list.map(makeTag);
    measure(fixedTags);
  }
  function plateTag() {
    const v = sky.current;
    const g = sky.grid;
    if (!v || !g) return null;
    const hw = g.fovDeg / 2;
    const hh = g.fovHeightDeg / 2;
    const d = fieldDirection(hw, hh, FRAME, spread);
    const l = Math.hypot(...d);
    return { pos: [(d[0] / l) * D.nearM, (d[1] / l) * D.nearM, (d[2] / l) * D.nearM], priority: 11, tone: 'ink', title: t('indepth.plate'), sub: `${day(v.frame.mjd)} · ${v.frame.band ?? ''}`.trim(), cls: 'indepth__tag--plate' };
  }

  const tmp = new THREE.Vector3();
  /** Each label where its point is on screen, by priority, hidden if it would cover one already placed. */
  function placeTags() {
    const W = root.clientWidth;
    const H = root.clientHeight;
    const boxes = [];
    const box0 = root.getBoundingClientRect();
    // The open panel stops short of the switches along the foot, and of the button in the corner.
    legend.style.maxBlockSize = `${Math.max(80, kinds.offsetTop - legend.offsetTop - 6)}px`;
    legend.style.setProperty('--room', `${Math.max(160, corner.offsetLeft + reset.offsetLeft - legend.offsetLeft - 6)}px`);
    // The corner panels are room no name may take.
    for (const panel of [legend, kinds, reset, how, raysNote]) {
      if (panel.hidden || !panel.offsetWidth) continue;
      const r = panel.getBoundingClientRect();
      boxes.push({ x: r.left - box0.left, y: r.top - box0.top, w: r.width, h: r.height });
    }
    const order = allTags().sort((a, b) => b.priority - a.priority);
    for (const g of order) {
      const on = !g.kind || shown[g.kind];
      tmp.copy(g.pos).project(camera);
      const px = (tmp.x * 0.5 + 0.5) * W;
      const py = (-tmp.y * 0.5 + 0.5) * H;
      // Right of its point, else left of it where the right edge is near. The field's own
      // object and the plate may also go above or below, held inside the plate: on a narrow
      // or crowded one they are the names that must not drop out.
      const mid = Math.max(2, Math.min(W - g.w - 2, px - g.w / 2));
      const spots = [[px + 7, py - g.h / 2], [px - 7 - g.w, py - g.h / 2]];
      if (g.priority >= 11) spots.push([mid, py - g.h - 6], [mid, py + 6]);
      let spot = null;
      for (const [x, y] of on && tmp.z < 1 ? spots : []) {
        const box = { x: x - 2, y: y - 2, w: g.w + 4, h: g.h + 4 };
        const inside = x > 0 && y > 0 && x + g.w < W && y + g.h < H;
        const hit = boxes.some((b) => b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h);
        if (inside && !hit) { spot = { x, y, box }; break; }
      }
      g.node.style.visibility = spot ? 'visible' : 'hidden';
      if (spot) {
        g.node.style.transform = `translate(${Math.round(spot.x)}px, ${Math.round(spot.y)}px)`;
        boxes.push(spot.box);
      }
    }
  }

  /* ---- the legend: what is placed by what, and what waits ---------------- */
  const SWATCH = { stars: 'star', bodies: 'body', galaxies: 'galaxy', unknown: 'none' };
  const CHIP = { stars: 'indepth.chipStars', bodies: 'indepth.chipBodies', galaxies: 'indepth.chipGalaxies', unknown: 'indepth.chipUnknown' };
  function drawLegend() {
    const st = got?.status ?? {};
    const asking = ['gaia', 'bj', 'galaxies'].some((k) => st[k] === 'asking');
    const gLimit = fmt(got?.gaia?.reached ?? magLimit(sky.grid?.fovHeightDeg ?? 0.3), 1);
    const count = {
      stars: st.gaia === 'failed' ? t('indepth.starsFailed') : st.gaia === 'ok' ? t('indepth.stars', { n: counts.stars }) : t('indepth.starsAsking'),
      bodies: counts.bodies ? t('indepth.bodies', { n: counts.bodies }) : t(counts.bodiesAsked ? 'indepth.bodiesNone' : 'indepth.bodiesWaiting'),
      galaxies: st.galaxies === 'failed' ? t('indepth.galaxiesFailed')
        : st.galaxies === 'ok' ? t('indepth.galaxies', { n: counts.galaxies, m: counts.galaxiesAll }) : t('indepth.galaxiesAsking'),
      unknown: t('indepth.unknown', { n: counts.unknown ?? 0 }),
    };
    const waiting = (k) => (st[k] === 'failed' ? '—' : st[k] === 'ok' ? null : '…');
    const short = {
      stars: waiting('gaia') ?? String(counts.stars),
      bodies: counts.bodiesAsked || counts.bodies ? String(counts.bodies) : '…',
      galaxies: waiting('galaxies') ?? String(counts.galaxies),
      unknown: waiting('gaia') ?? String(counts.unknown),
    };
    const byWhat = {
      stars: t('indepth.starsHow', { bj: counts.bj ?? 0, plx: counts.plx ?? 0 }),
      bodies: t('indepth.bodiesHow'),
      galaxies: t('indepth.galaxiesHow'),
      unknown: t('indepth.unknownHow', { g: gLimit }),
    };

    // The switches: each kind shown or set aside, its count on its face.
    kinds.replaceChildren(...KINDS.map((kind) => {
      const chip = el('button', 'indepth__kind');
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(shown[kind]));
      // The face is short, so four fit a phone's plate; the full count and its source are the chip's title.
      chip.title = `${count[kind]}. ${byWhat[kind]}`;
      chip.append(
        el('span', `indepth__dot indepth__dot--${SWATCH[kind]}`),
        el('span', null, t(CHIP[kind])),
        el('span', 'indepth__kind-n num', short[kind]),
      );
      chip.addEventListener('click', () => {
        shown[kind] = !shown[kind];
        chip.setAttribute('aria-pressed', String(shown[kind]));
        objects.children.forEach((g, i) => { g.visible = shown[KINDS[i]]; });
        tip.hidden = true;
        refocus();
      });
      return chip;
    }), raysNote);

    // The account behind them: the scale, and where every distance comes from.
    summary.textContent = t('indepth.title');
    legendBody.replaceChildren(
      el('p', 'indepth__fine indepth__fine--how', how.textContent),
      el('p', 'indepth__scale', t('indepth.scale', { n: Math.round(spread) })),
    );
    for (const kind of KINDS) {
      const line = el('p', 'indepth__row');
      line.append(el('span', `indepth__dot indepth__dot--${SWATCH[kind]}`), el('span', null, byWhat[kind]));
      legendBody.append(line);
    }
    legendBody.append(el('p', 'indepth__fine', t('indepth.filled')));
    if (st.bj === 'failed') legendBody.append(el('p', 'indepth__fine indepth__fine--warn', t('indepth.noBJ')));
    const failed = ['gaia', 'bj', 'galaxies'].filter((k) => st[k] === 'failed');
    if (failed.length) {
      const again = el('button', 'btn btn--quiet indepth__again', t('indepth.retry'));
      again.type = 'button';
      again.addEventListener('click', () => { for (const k of failed) ask(k); drawLegend(); });
      legendBody.append(again);
    }
    if (asking) legendBody.append(el('p', 'indepth__fine', t('indepth.asking')));
    // The names over the corridor step round the panels, which have just changed size.
    queueMicrotask(() => { dirty = true; invalidate(); });
  }

  /* ---- the plate's picture ----------------------------------------------- */
  let plateOf = null;
  function updatePlate() {
    const v = sky.current;
    const canvasNow = v?.canvas ?? null;
    if (!canvasNow) {
      plateMat.map = null;
      plateMat.color.copy(look.well);
      plateMat.needsUpdate = true;
      plateOf = null;
      return;
    }
    sky.fresh(v);
    const key = `${v.frame.obsId}|${v.canvasVersion ?? 0}`;
    if (plateOf === key) return;
    plateOf = key;
    if (plateTex?.image !== canvasNow) {
      plateTex?.dispose();
      plateTex = new THREE.CanvasTexture(canvasNow);
      plateTex.colorSpace = THREE.SRGBColorSpace;
      plateMat.map = plateTex;
    }
    plateTex.needsUpdate = true;
    plateMat.color.set(0xffffff);
    plateMat.needsUpdate = true;
  }

  /* ---- the hand ---------------------------------------------------------- */
  const pointers = new Map();
  let press = null;
  let pinch = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) press = { x: e.clientX, y: e.clientY, moved: 0 };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), along: view.along };
      press = null;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const was = pointers.get(e.pointerId);
    if (!was) {
      if (e.pointerType === 'mouse' && !pointers.size) hover(e);
      return;
    }
    const dx = e.clientX - was.x;
    const dy = e.clientY - was.y;
    was.x = e.clientX;
    was.y = e.clientY;
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      // Fingers apart walks into the corridor, together walks back out.
      setAlong(pinch.along + (d - pinch.d) * 0.012);
      return;
    }
    if (!press) return;
    press.moved += Math.hypot(dx, dy);
    if (press.moved < TAP_PX) return;
    turn(dx * -0.006, dy * 0.006);
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (press && press.moved < TAP_PX && e.type === 'pointerup') pick(e);
    if (!pointers.size) press = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse' || pointers.size || hot == null) return;
    hot = null;
    tip.hidden = true;
    refocus();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    setAlong(view.along - px * 0.004);
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: [0.08, 0], ArrowRight: [-0.08, 0], ArrowUp: [0, 0.06], ArrowDown: [0, -0.06] }[e.key];
    if (step) { e.preventDefault(); turn(...step); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setAlong(view.along + 0.3); }
    else if (e.key === '-') { e.preventDefault(); setAlong(view.along - 0.3); }
    else if (e.key === 'Escape') { tip.hidden = true; picked = null; refocus(); }
  });
  reset.addEventListener('click', () => { Object.assign(view, HOME); tip.hidden = true; invalidate(); });

  function turn(dYaw, dPitch) {
    view.yaw += dYaw;
    view.pitch = Math.max(-1.2, Math.min(1.25, view.pitch + dPitch));
    tip.hidden = true;
    invalidate();
  }
  function setAlong(a) {
    view.along = Math.max(0.2, Math.min(D.unknownM, a));
    tip.hidden = true;
    invalidate();
  }

  /** The nearest thing to a point on the canvas, by where it stands or by its pixel on the photo, within `reach` pixels. */
  function nearest(x, y, reach) {
    const W = root.clientWidth;
    const H = root.clientHeight;
    let best = null;
    let bestD = reach;
    placeCamera();
    for (const p of pickables) {
      if (!shown[p.kind]) continue;
      for (const at of [p.pos, p.start]) {
        tmp.set(...at).project(camera);
        if (tmp.z >= 1) continue;
        const d = Math.hypot((tmp.x * 0.5 + 0.5) * W - x, (-tmp.y * 0.5 + 0.5) * H - y);
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    return best;
  }

  /** Where a thing is on the canvas, in CSS pixels. */
  function onScreen(at) {
    placeCamera();
    tmp.set(...at).project(camera);
    return { x: (tmp.x * 0.5 + 0.5) * root.clientWidth, y: (-tmp.y * 0.5 + 0.5) * root.clientHeight };
  }

  /** A thing's card, beside the point (x, y). */
  function showCard(p, x, y) {
    const card = p.card();
    tip.replaceChildren(el('span', 'tip__title', card.title), ...card.rows.map((text) => el('span', 'tip__row', text)));
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = `${Math.max(6, Math.min(root.clientWidth - w - 6, x + 12))}px`;
    tip.style.top = `${Math.max(6, Math.min(root.clientHeight - h - 6, y - h - 10))}px`;
  }

  /** What the hand is over (`hot`) and what was tapped (`picked`), by key: the first wins the highlight. */
  let hot = null;
  let picked = null;
  const byKey = (key) => (key ? pickables.find((p) => p.key === key) ?? null : null);

  /** Draw the highlight for the thing pointed at: its whole ray, a ring on its pixel, a ring where it stands. */
  function refocus() {
    disposeGroup(focus);
    const p = byKey(hot) ?? byKey(picked);
    if (p && shown[p.kind] && plateCorners) {
      // A thing with no distance has only a direction: its line is dashed, to the far shell.
      const ray = lines([...p.start, ...p.pos], p.color, p.known ? 0.95 : 0.6, { dashed: !p.known });
      ray.material.depthTest = false;
      ray.renderOrder = 9;
      // The ring lies on the plate, a little wider than a bright star's image there.
      const [bl, br, , tl] = plateCorners;
      const ex = new THREE.Vector3(...br).sub(new THREE.Vector3(...bl));
      const ey = new THREE.Vector3(...tl).sub(new THREE.Vector3(...bl));
      const radius = 0.035 * Math.max(ex.length(), ey.length());
      ex.normalize();
      ey.normalize();
      const ring = [];
      const N = 40;
      for (let k = 0; k < N; k++) {
        for (const kk of [k, k + 1]) {
          const a = (kk / N) * Math.PI * 2;
          ring.push(...[0, 1, 2].map((i) => p.start[i] + radius * (Math.cos(a) * ex.getComponent(i) + Math.sin(a) * ey.getComponent(i))));
        }
      }
      const onPhoto = lines(ring, p.color, 1);
      onPhoto.material.depthTest = false;
      onPhoto.renderOrder = 10;
      const there = points([{ pos: p.pos, size: 22, color: p.color, solid: false }]);
      there.material.depthTest = false;
      there.renderOrder = 10;
      focus.add(ray, onPhoto, there);
    }
    invalidate();
  }

  /** The mouse over the canvas: what it is near lights up, with its card. */
  function hover(e) {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const best = nearest(x, y, PICK_PX);
    const key = best?.key ?? null;
    if (key === hot) return;
    hot = key;
    refocus();
    if (best) { showCard(best, x, y); return; }
    // Off everything: back to what was tapped, if anything.
    const was = byKey(picked);
    if (was && shown[was.kind]) { const at = onScreen(was.pos); showCard(was, at.x, at.y); } else tip.hidden = true;
  }

  /** A tap: the nearest thing under the hand, highlighted, its card beside it; a tap on nothing lets go. */
  function pick(e) {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const best = nearest(x, y, (e.pointerType === 'touch' ? 1.5 : 1) * PICK_PX);
    picked = best?.key ?? null;
    refocus();
    if (best) showCard(best, x, y);
    else tip.hidden = true;
  }

  /* ---- keeping up with the page ------------------------------------------ */
  let fieldKey = '';
  let visitKey = '';
  function update() {
    const grid = sky.grid;
    const f = field();
    if (!grid || f.ra == null) return;
    const radiusDeg = searchRadius(grid.fovDeg, grid.fovHeightDeg);
    const key = `${f.ra.toFixed(5)},${f.dec.toFixed(5)},${radiusDeg.toFixed(4)}`;
    if (key !== fieldKey) {
      fieldKey = key;
      ctrl.abort();
      ctrl = new AbortController();
      const beta = eclipticLatitude(f.ra, f.dec);
      buildStatics(grid, radiusDeg, beta);
      built = { beta };
      buildFixedTags(beta);
      if (!answers.has(key)) answers.set(key, { status: {} });
      got = answers.get(key);
      for (const kind of ['gaia', 'bj', 'galaxies']) if (!got.status[kind] || got.status[kind] === 'failed') ask(kind);
      visitKey = '';
      tip.hidden = true;
      hot = null;
      picked = null;
    }
    updatePlate();
    // Another visit on the plate, or another answer from SkyBoT: the things move with it.
    const v = sky.current;
    const answered = sky.visits.reduce((n, x) => n + (sky.knownObjects.has(x.frame.obsId) ? 1 : 0), 0);
    const vk = `${v?.frame.obsId ?? ''}|${answered}`;
    if (vk !== visitKey) {
      visitKey = vk;
      placeObjects();
    }
    plateG?.node.remove();
    const pt = plateTag();
    plateG = pt ? makeTag(pt) : null;
    if (plateG) measure([plateG]);
    canvas.setAttribute('aria-label', t('indepth.aria', { n: counts.stars ?? 0, b: counts.bodies ?? 0, g: counts.galaxies ?? 0, u: counts.unknown ?? 0 }));
    invalidate();
  }

  function relabel() {
    how.textContent = t(matchMedia('(pointer: coarse)').matches ? 'indepth.howTouch' : 'indepth.how');
    reset.textContent = t('indepth.reset');
    if (built) buildFixedTags(built.beta);
    visitKey = '';
    update();
    drawLegend();
  }

  relabel();

  return {
    update,
    relabel,
    unmount() {
      ctrl.abort();
      cancelAnimationFrame(frame);
      seen.disconnect();
      sized.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      disposeGroup(statics);
      disposeGroup(objects);
      disposeGroup(focus);
      plateTex?.dispose();
      plateMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      root.remove();
    },
  };
}

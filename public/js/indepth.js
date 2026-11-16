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
 * Loaded only when the mode is chosen (app.js), so the page does not carry
 * three.js until someone asks for depth. It draws when something changed —
 * a turn, an answer, another visit — and not at all while it is off screen.
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
  decadeRings, viewFrame, fieldDirection,
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
/** The corridor, looked along from its mouth: −z ahead, x to the right, y up. */
const FRAME = viewFrame([0, 0, -1]);
const TAN_CONE = Math.tan(D.coneDeg * D2R);
const cone = (r) => r * TAN_CONE;

/** The view as it opens: a little above and to the side of the plate, the corridor running away three-quarter. */
const HOME = { yaw: 0.5, pitch: 0.2, dist: 4.4, along: 2.6 };

/** Each kind of thing, the token it is drawn in, and whether the "No distance" switch holds it. */
const KINDS = ['stars', 'bodies', 'galaxies', 'unknown'];

const POINT_VERTEX = /* glsl */ `
  attribute float size;
  attribute vec3 tint;
  attribute float solid;
  uniform float dpr;
  uniform float nearM;
  uniform float farM;
  varying vec3 vTint;
  varying float vSolid;
  varying float vDim;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(3.0, size * dpr);
    vTint = tint;
    vSolid = solid;
    // A little dimmer toward the far end, so the near reads as near (a depth cue, not a brightness).
    vDim = mix(1.0, 0.65, clamp((length(position) - nearM) / (farM - nearM), 0.0, 1.0));
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
  legend.addEventListener('toggle', invalidate);

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
  function invalidate() {
    dirty = true;
    if (!visible || document.hidden || frame) return;
    frame = requestAnimationFrame(render);
  }
  function render() {
    frame = 0;
    if (!dirty) return;
    dirty = false;
    placeCamera();
    renderer.render(scene, camera);
    placeTags();
  }
  const seen = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible && dirty) invalidate();
  });
  seen.observe(root);
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
  scene.add(statics, objects);
  const plateMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide });
  let plateTex = null;
  /** What a tap can land on: `{ pos, kind, card() }`. */
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
      uniforms: { dpr: { value: dpr }, nearM: { value: D.nearM }, farM: { value: D.unknownM } },
      vertexShader: POINT_VERTEX, fragmentShader: POINT_FRAGMENT,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    p.renderOrder = 5;
    return p;
  }

  /** From each placed thing's own pixel on the plate out to where it stands. */
  function sightLines(items, color, opacity) {
    const out = [];
    for (const it of items) {
      const l = Math.hypot(...it.pos);
      out.push((it.pos[0] / l) * D.nearM, (it.pos[1] / l) * D.nearM, (it.pos[2] / l) * D.nearM, ...it.pos);
    }
    return lines(out, color, opacity);
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
    const bars = [];
    placed.forEach((p, i) => {
      const s = stars[i];
      const seenHere = detected(current, s.at.ra, s.at.dec);
      const it = {
        pos: p.pos, solid: seenHere,
        // Brighter is larger; one without a distance is a dim speck on the far shell.
        size: Math.max(3, Math.min(9, 9 - 0.45 * ((s.r.mag ?? 18) - 8))) * (p.known ? 1 : 0.75),
        color: p.known ? look.ink : look.ruleStrong,
      };
      (p.known ? known : unknown).push(it);
      if (p.known) {
        counts[s.d.src] += 1;
        if (s.d.lo && s.d.hi) {
          const a = placeByDistance([{ dir: s.dir, au: s.d.lo * AU_PER_PC }, { dir: s.dir, au: s.d.hi * AU_PER_PC }]);
          bars.push(...a[0].pos, ...a[1].pos);
        }
      }
      pickables.push({ pos: p.pos, kind: p.known ? 'stars' : 'unknown', card: () => starCard(s, seenHere) });
    });
    counts.stars = known.length;
    counts.unknown = unknown.length;
    if (known.length) {
      layer.stars.add(points(known), sightLines(known, look.neutral, 0.07));
      if (bars.length) layer.stars.add(lines(bars, look.ink, 0.45));
    }
    if (unknown.length) layer.unknown.add(points(unknown));

    // The field's own target, where its distance comes from: the Gaia source it is, else a published parallax, else none.
    const target = f.target;
    if (target && (rows.length || got?.status.gaia === 'failed')) {
      const hit = rows.length ? matchTarget(target, rows, epoch) : null;
      const s = hit ? stars[rows.indexOf(hit)] : null;
      const at = propagate(target, epoch, target.epoch ?? GAIA_EPOCH);
      const lit = !s?.d.pc && target.plx > 0 ? 1000 / target.plx : null;
      const pc = s?.d.pc ?? lit;
      const [p] = placeByDistance([{ dir: dirOf(at.ra, at.dec), au: pc ? pc * AU_PER_PC : null }]);
      const words = s?.d.pc
        ? tv(s.d.src === 'bj' ? 'vr.distBJ' : 'vr.distPlx', { pc: pcText(pc) })
        : lit ? tv('vr.distLit', { pc: pcText(lit), ref: target.ref ?? '' }) : tv('vr.notMeasured');
      const it = { pos: p.pos, size: 12, color: look.accent, solid: detected(current, at.ra, at.dec) };
      layer.stars.add(points([it]));
      if (p.known) layer.stars.add(sightLines([it], look.accent, 0.6));
      // On the corridor only how far, in light-years; the card says by what.
      const short = pc ? lyText(pc) : tv('vr.notMeasured');
      objTags.push({ pos: p.pos, kind: 'stars', priority: 10, tone: 'accent', title: target.label ?? '', sub: short });
      pickables.push({ pos: p.pos, kind: 'stars', card: () => ({ title: target.label ?? '', rows: [words, `${formatRA(at.ra)}  ${formatDec(at.dec)}`] }) });
    }

    // Asteroids and comets: where SkyBoT or JPL put them at the visit, with the season's path.
    const bodies = bodiesNow(current);
    counts.bodiesAsked = bodies.asked;
    counts.bodies = bodies.list.length;
    if (bodies.list.length) {
      const items = bodies.list.map((b) => ({
        pos: placeByDistance([{ dir: dirOf(b.ra, b.dec), au: b.dGeo }])[0].pos, size: 10, color: look.counter, solid: b.seen,
      }));
      layer.bodies.add(points(items), sightLines(items, look.counter, 0.4));
      const path = [];
      for (const b of bodies.list) {
        const pts = b.track.map((p) => placeByDistance([{ dir: dirOf(p.ra, p.dec), au: p.au }])[0].pos);
        for (let k = 1; k < pts.length; k++) path.push(...pts[k - 1], ...pts[k]);
      }
      if (path.length) layer.bodies.add(lines(path, look.counter, 0.8));
      const order = bodies.list.map((b, i) => i).sort((p, q) => bodies.list[p].dGeo - bodies.list[q].dGeo);
      order.forEach((i, rank) => {
        const b = bodies.list[i];
        const name = b.num ? `(${b.num}) ${b.name}` : b.name;
        const sub = current && b.mjd === current.frame.mjd ? tv('vr.bodyAt', { au: fmt(b.dGeo, 2) }) : tv('vr.bodyAtDate', { au: fmt(b.dGeo, 2), date: day(b.mjd) });
        if (rank < 4) objTags.push({ pos: items[i].pos, kind: 'bodies', priority: 9 - rank * 0.1, tone: 'counter', title: name, sub });
        pickables.push({
          pos: items[i].pos, kind: 'bodies',
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
        const [p] = placeByDistance([{ dir: dirOf(o.g.ra, o.g.dec), au: o.au }]);
        return { pos: p.pos, size: 8, color: o.au ? look.accent : look.ruleStrong, solid: false, known: p.known };
      });
      const near = items.filter((it) => it.known);
      layer.galaxies.add(points(items));
      if (near.length) layer.galaxies.add(sightLines(near, look.accentDim, 0.1));
      gal.forEach((o, i) => {
        const sub = o.au ? tv('vr.galaxyAt', { z: fmt(o.g.z, 4), mpc: fmt(o.mpc, 0) }) : `z ${fmt(o.g.z, 4)} · ${tv('vr.unknown')}`;
        if (o.au && objTags.filter((x) => x.kind === 'galaxies').length < 2) {
          objTags.push({ pos: items[i].pos, kind: 'galaxies', priority: 7, tone: 'accent', title: o.g.name, sub });
        }
        pickables.push({
          pos: items[i].pos, kind: o.au ? 'galaxies' : 'unknown',
          card: () => ({
            title: o.g.name,
            rows: [tv('vr.cardGalaxy'), o.au ? tv('vr.cardGalaxyAt', { z: fmt(o.g.z, 4), mpc: fmt(o.mpc, 0) }) : sub, `${formatRA(o.g.ra)}  ${formatDec(o.g.dec)}`],
          }),
        });
      });
    }
    setObjectTags(objTags);
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
    for (const panel of [legend, kinds, reset, how]) {
      if (panel.hidden || !panel.offsetWidth) continue;
      const r = panel.getBoundingClientRect();
      boxes.push({ x: r.left - box0.left, y: r.top - box0.top, w: r.width, h: r.height });
    }
    const order = allTags().sort((a, b) => b.priority - a.priority);
    for (const g of order) {
      const on = !g.kind || shown[g.kind];
      tmp.copy(g.pos).project(camera);
      const px = (tmp.x * 0.5 + 0.5) * W;
      const y = (-tmp.y * 0.5 + 0.5) * H - g.h / 2;
      // Right of its point, else left of it where the right edge is near.
      let spot = null;
      for (const x of on && tmp.z < 1 ? [px + 7, px - 7 - g.w] : []) {
        const box = { x: x - 2, y: y - 2, w: g.w + 4, h: g.h + 4 };
        const inside = x > 0 && y > 0 && x + g.w < W && y + g.h < H;
        const hit = boxes.some((b) => b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h);
        if (inside && !hit) { spot = { x, box }; break; }
      }
      g.node.style.visibility = spot ? 'visible' : 'hidden';
      if (spot) {
        g.node.style.transform = `translate(${Math.round(spot.x)}px, ${Math.round(y)}px)`;
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
        invalidate();
      });
      return chip;
    }));

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
    if (!was) return;
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
    else if (e.key === 'Escape') tip.hidden = true;
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

  /** A tap: the nearest point under the hand, its card beside it. */
  function pick(e) {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = null;
    let bestD = (e.pointerType === 'touch' ? 1.5 : 1) * PICK_PX;
    placeCamera();
    for (const p of pickables) {
      if (!shown[p.kind]) continue;
      tmp.set(...p.pos).project(camera);
      if (tmp.z >= 1) continue;
      const d = Math.hypot((tmp.x * 0.5 + 0.5) * r.width - x, (-tmp.y * 0.5 + 0.5) * r.height - y);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) { tip.hidden = true; return; }
    const card = best.card();
    tip.replaceChildren(el('span', 'tip__title', card.title), ...card.rows.map((text) => el('span', 'tip__row', text)));
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = `${Math.max(6, Math.min(r.width - w - 6, x + 12))}px`;
    tip.style.top = `${Math.max(6, Math.min(r.height - h - 6, y - h - 10))}px`;
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
      plateTex?.dispose();
      plateMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      root.remove();
    },
  };
}

/**
 * main.js — Muninn in a headset.
 *
 * The real sky around the viewer, the fields this tool can open marked on it,
 * and a chosen field unfolded on screens around them (field.js). The same
 * scene runs on a flat screen when there is no headset, looked round with the
 * mouse or a finger, so it can be shown and tested anywhere.
 *
 * The headset is asked for the way its makers recommend: whether
 * `navigator.xr` exists and says `immersive-vr` is supported; floor height,
 * room bounds and hand tracking only as optional features, so a headset
 * without one of them still starts. The session's end and its visibility are
 * followed: the blink holds while the headset is off the face.
 *
 * Nothing here moves the viewer's own view: no flight, no turning sky. Once,
 * before the first frame, the sky is turned about the vertical so the first
 * challenge target stands a little above straight ahead.
 */

import * as THREE from '../vendor/three.module.js';
import { setLanguage, getLanguage } from '../i18n.js';
import { loadStars } from '../gate.js';
import { planetsNow } from '../ephemeris.js';
import { createSky } from './sky3d.js';
import { createCard } from './card.js';
import { formatRA, formatDec } from '../catalog.js';
import { fmt } from '../i18n.js';
import { radecToVec, vecToRadec, angleBetween } from './skydata.js';
import { createMarkers } from './targets3d.js';
import { createPointers } from './input.js';
import { openFieldVR } from './field.js';
import { readLook, loadFonts, createPanel, FONTS, wrapText, fitText, wrapLines } from './panel.js';
import { LAYOUT, yawOf, minTextPx } from './layout.js';
import { navigate } from './nav.js';
import { tv } from './strings.js';

const D2R = Math.PI / 180;
const EYE_HEIGHT = 1.6;
const OPTIONAL_FEATURES = ['local-floor', 'bounded-floor', 'hand-tracking'];
/** The target put ahead at the start: the first challenge target near the equator. */
const AHEAD = 'barnard';
const HAPTIC = { hover: [0.15, 12], select: [0.6, 35] };

/** The page's language: ?lang=, else the site's stored choice, else the browser's. */
export function pageLanguage() {
  const asked = new URLSearchParams(location.search).get('lang');
  if (asked) return asked;
  try {
    const stored = localStorage.getItem('muninn.lang');
    if (stored) return stored;
  } catch { /* private window */ }
  return (navigator.language ?? '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Whether this device can run an immersive VR session, the recommended way. */
export async function xrSupported() {
  if (!navigator.xr) return false;
  try { return await navigator.xr.isSessionSupported('immersive-vr'); } catch { return false; }
}

/**
 * The scene on `canvas`. `session`, when given, is an immersive session (or
 * a promise of one) already asked for in the visitor's own tap, and the scene
 * enters it as soon as it is built; `context` opens a field at once:
 * `{ key }` for one of the marked fields, or `{ ra, dec, fov, band, name }`.
 * Returns `{ stop() }`, which ends the session and frees everything.
 */
export async function startVR({ canvas, lang, ui, session: asked = null, context = null }) {
  setLanguage(lang);
  await loadFonts();
  const look = readLook();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.setClearColor(new THREE.Color(look.well), 1);
  renderer.xr.enabled = true;
  // Fewer pixels at the edge of the lens, where the eye cannot use them.
  renderer.xr.setFoveation(1);
  renderer.xr.setReferenceSpaceType('local-floor');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, canvas.clientWidth / Math.max(1, canvas.clientHeight), 0.05, 2000);
  camera.position.set(0, EYE_HEIGHT, 0);
  scene.add(camera);

  /* ---- the sky ----------------------------------------------------- */
  ui.status(tv('vr.loadingSky'));
  const [stars, targets] = await Promise.all([
    loadStars().catch(() => null),
    fetch('data/targets.json').then((r) => (r.ok ? r.json() : { targets: [] })).catch(() => ({ targets: [] })),
  ]);
  const sky = createSky(stars);
  scene.add(sky.group);
  const markers = createMarkers({ fields: targets.targets ?? [], planets: planetsNow(), look, lang: getLanguage() });
  sky.group.add(markers.group);
  ui.status(stars ? '' : tv('vr.skyFailed'));

  // Once, before anything is drawn: the first challenge target ahead.
  const ahead = markers.markers.find((m) => m.key === AHEAD) ?? markers.markers.find((m) => m.kind === 'challenge');
  const skyYaw = ahead ? -yawOf(ahead.v) * D2R : 0;
  sky.group.rotation.y = skyYaw;
  const toWorld = (v) => new THREE.Vector3(v[0], v[1], v[2]).applyAxisAngle(new THREE.Vector3(0, 1, 0), skyYaw);
  const toSky = (d) => d.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -skyYaw);
  markers.setFirst(ahead ?? null);

  // A faint disc on the floor, so there is a floor.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(0.7, 48),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(look.ink), transparent: true, opacity: 0.08, depthWrite: false }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.002;
  scene.add(floor);

  /** Shared by everything drawn in angular sizes. */
  const pxPerDeg = { value: 20 };

  /* ---- the first sign ----------------------------------------------- */
  const F = LAYOUT.first;
  const firstSign = createPanel({ widthM: F.w, heightM: F.h, pxPerM: F.pxPerM, name: 'first', opaque: true });
  function drawFirst() {
    const px = minTextPx(F.pxPerM, F.dist, 2.0);
    firstSign.draw((ctx, W, H) => {
      ctx.fillStyle = look.paper;
      ctx.beginPath();
      ctx.roundRect(2, 2, W - 4, H - 4, 30);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = look.counter;
      ctx.stroke();
      // A Quest controller from the side: its ring, its grip, and the trigger lit.
      const cx = 70;
      const cy = H / 2;
      ctx.lineWidth = 6;
      ctx.strokeStyle = look.muted;
      ctx.beginPath();
      ctx.ellipse(cx, cy - 34, 30, 18, -0.3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(cx - 16, cy - 20, 32, 82, 14);
      ctx.stroke();
      ctx.fillStyle = look.counter;
      ctx.beginPath();
      ctx.roundRect(cx + 14, cy - 6, 16, 30, 6);
      ctx.fill();
      // And the ray it casts, to a gold ring.
      ctx.strokeStyle = look.accent;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx + 22, cy - 46);
      ctx.lineTo(cx + 74, cy - 70);
      ctx.stroke();
      ctx.strokeStyle = look.counter;
      ctx.beginPath();
      ctx.arc(cx + 88, cy - 74, 12, 0, Math.PI * 2);
      ctx.stroke();
      const x = 190;
      const w = W - x - 30;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = look.ink;
      ctx.font = `500 ${px}px ${FONTS.body}`;
      // Every word, on up to three lines: a size smaller if the words need it.
      const text = renderer.xr.isPresenting ? `${tv('vr.first')} ${tv('vr.firstHand')}` : tv('vr.firstFlat');
      let size = px;
      let lines = wrapLines(`500 ${size}px ${FONTS.body}`, text, w, 9);
      while (size > px * 0.75 && (lines.length > 3 || lines.length * size * 1.2 > H - 30)) {
        size -= 2;
        lines = wrapLines(`500 ${size}px ${FONTS.body}`, text, w, 9);
      }
      ctx.font = `500 ${size}px ${FONTS.body}`;
      lines.forEach((l, k) => ctx.fillText(l, x, cy + (k - (lines.length - 1) / 2) * size * 1.2));
    });
  }
  drawFirst();
  {
    const yaw = 0;
    const pitch = F.pitchDeg * D2R;
    firstSign.mesh.position.set(-Math.sin(yaw) * F.dist * Math.cos(pitch), EYE_HEIGHT + Math.sin(pitch) * F.dist, -Math.cos(yaw) * F.dist * Math.cos(pitch));
    firstSign.mesh.rotation.set(pitch, yaw, 0, 'YXZ');
    scene.add(firstSign.mesh);
  }

  /* ---- the way back to the screens ---------------------------------- */
  const chevron = createPanel({ widthM: 0.22, heightM: 0.08, pxPerM: 1200, name: 'chevron', opaque: true });
  chevron.mesh.position.set(0, -0.32, -1.1);
  chevron.mesh.visible = false;
  chevron.mesh.renderOrder = 70;
  chevron.mesh.material.depthTest = false;
  camera.add(chevron.mesh);
  let lostSince = null;
  let chevronSide = 0;
  // Pressed, the chevron brings the screens round.
  chevron.mesh.userData.pick = () => returnToScreens();
  function drawChevron(sideSign) {
    if (sideSign === chevronSide) return;
    chevronSide = sideSign;
    chevron.draw((ctx, W, H) => {
      ctx.fillStyle = look.paper2;
      ctx.beginPath();
      ctx.roundRect(2, 2, W - 4, H - 4, H / 2);
      ctx.fill();
      ctx.fillStyle = look.accent;
      ctx.font = `500 ${Math.round(H * 0.45)}px ${FONTS.body}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const word = tv('vr.screensAway');
      ctx.fillText(sideSign > 0 ? `‹ ${word}` : `${word} ›`, W / 2, H / 2);
    });
  }

  // A dark veil before the eyes, for the flip's fade (field.js says how dark).
  const veil = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
  );
  veil.position.set(0, 0, -0.3);
  veil.renderOrder = 90;
  veil.visible = false;
  camera.add(veil);

  /* ---- a card for whatever was chosen, and any star on the sky -------- */
  const card = createCard({ look });
  scene.add(card.mesh);
  const showCard = (content, at) => {
    const { head: h, dir: d } = headPose();
    card.show(content, at ?? h.clone().addScaledVector(d, 2), h);
  };

  // The star under the ray is ringed; any star, or any point, can be opened.
  const starRing = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1, 40),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(look.ink), transparent: true, opacity: 0.9, depthWrite: false }),
  );
  starRing.scale.setScalar(300 * Math.tan(0.6 * D2R));
  starRing.visible = false;
  starRing.renderOrder = 6;
  sky.group.add(starRing);
  const named = new Map((stars?.named ?? []).map((x) => [x.i, x]));
  let starHeld = -1;
  /** The catalogue star a direction (in the sky's frame) points at: caught within 1.2°, held to 1.8°. */
  function starAt(d) {
    const pos = sky.positions;
    if (!pos) return -1;
    const v = [d.x, d.y, d.z];
    if (starHeld >= 0 && angleBetween(v, [pos[starHeld * 3], pos[starHeld * 3 + 1], pos[starHeld * 3 + 2]]) < 1.8) return starHeld;
    let best = -1;
    let bestDot = Math.cos(1.2 * D2R);
    for (let i = 0, n = pos.length / 3; i < n; i++) {
      const dot = v[0] * pos[i * 3] + v[1] * pos[i * 3 + 1] + v[2] * pos[i * 3 + 2];
      if (dot > bestDot) { bestDot = dot; best = i; }
    }
    return best;
  }
  function skyCard(d, star) {
    let [ra, dec] = vecToRadec([d.x, d.y, d.z]);
    let title = tv('vr.skyPoint');
    const lines = [];
    if (star >= 0) {
      ra = stars.ra[star];
      dec = stars.dec[star];
      const n = named.get(star);
      title = n ? [n.name, n.bayer].filter(Boolean).join(' · ') : tv('vr.skyStarTitle');
      lines.push({ text: tv('vr.skyStar', { mag: fmt(stars.mag[star], 2), bv: fmt(stars.bv[star], 2) }), tone: 'muted' });
    }
    lines.push({ text: tv('vr.skyWhere', { ra: formatRA(ra), dec: formatDec(dec) }), mono: true, tone: 'neutral' });
    lines.push({ text: tv('vr.skyOpenNote'), tone: 'muted' });
    const name = star >= 0 ? (named.get(star)?.name ?? '') : '';
    return {
      title,
      lines,
      actions: [{
        id: 'open', label: tv('vr.openHere'), primary: true,
        run: () => { card.hide(); openTarget({ v: radecToVec(ra, dec), target: { ra, dec, fov: 0.3, band: 'all', name } }); },
      }],
    };
  }

  /* ---- what is open ------------------------------------------------- */
  let field = null;
  let firstPicked = false;
  /** Where the viewer is: sky, field, or the field's depth turned to the front (nav.js). */
  let view = 'sky';
  /** The way back to the screens: a short fade, everything put back, then the screens brought round. */
  let home = null;
  const headQuat = new THREE.Quaternion();
  let fade = { from: 1, to: 1, t0: 0, ms: 0 };
  let currentDim = 1;
  const head = new THREE.Vector3();
  const dir = new THREE.Vector3();

  function headPose() {
    const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    cam.updateMatrixWorld?.();
    head.setFromMatrixPosition(cam.matrixWorld);
    cam.getWorldDirection(dir);
    cam.getWorldQuaternion(headQuat);
    return { head: head.clone(), dir: dir.clone() };
  }

  function dimTo(k, ms = LAYOUT.dive.ms) {
    fade = { from: currentDim, to: k, t0: performance.now(), ms: Math.max(1, ms) };
  }

  let lastRay = null;
  function haptic(kind) {
    if (lastRay && HAPTIC[kind]) pointers.pulse(lastRay, ...HAPTIC[kind]);
  }

  function openTarget(marker) {
    closeField(false);
    firstPicked = true;
    const { head: h } = headPose();
    const world = toWorld(marker.v);
    // The screens go where the target is, at eye level.
    const yawDeg = yawOf([world.x, world.y, world.z]);
    // On a flat screen the view is set to face them at once; in the headset
    // nothing turns. A tall narrow screen opens wide enough to see the side
    // screens: 110° across, no more than 100° up and down.
    if (!renderer.xr.isPresenting) {
      const aspect = camera.aspect || 1;
      const wide = 2 * Math.atan(Math.tan((110 / 2) * D2R) / aspect) / D2R;
      pointers.setFlatView({ yaw: yawDeg * D2R, pitch: -0.06, fov: Math.min(100, Math.max(80, wide)) });
    }
    markers.burst(marker);
    card.hide();
    field = openFieldVR(marker.target, {
      scene, head: h, baseYawDeg: yawDeg, fromDir: world.clone().normalize(), lang: getLanguage(), pxPerDeg, haptic, showCard,
      onBack: () => closeField(true),
      onBring: returnToScreens,
      onFlipped: (flipped) => { view = flipped ? 'depth' : 'field'; },
      onReopen: (next) => openTarget({ ...marker, target: next }),
    });
    dimTo(LAYOUT.dive.skyDim);
    markers.setDim(0.45);
    markers.setFirst(null);
    firstSign.mesh.visible = false;
    view = navigate(view, 'open');
    ui.field(field.label);
  }

  function closeField(animate = true) {
    if (!field) return;
    field.close();
    field = null;
    markers.setDim(1);
    dimTo(1, animate ? 500 : 1);
    chevron.mesh.visible = false;
    view = navigate(view, 'sky');
    home = null;
    ui.field(null);
  }

  /**
   * Back to the field's screens from wherever the viewer went: the view fades,
   * the depth view goes back behind at its own size, the walk is undone, and
   * the screens come round to where the head then points. The blink goes on.
   */
  function returnToScreens() {
    if (!field) return;
    view = navigate(view, 'screens');
    home = { t0: performance.now(), stage: 0 };
  }

  /** B: from the depth view back to the screens; from the screens back to the sky. */
  function goBack() {
    if (!field) return;
    if (navigate(view, 'back') === 'field') returnToScreens();
    else closeField(true);
  }

  /** The screens come round to where the head points, and to where it stands. */
  function bring() {
    if (!field) return;
    const { head: h, dir: d } = headPose();
    field.bring(h, Math.atan2(-d.x, -d.z));
  }

  /* ---- pointing ----------------------------------------------------- */
  const raycaster = new THREE.Raycaster();
  const hovered = new Map();
  let pressed = null;

  function hitOf(ray) {
    raycaster.set(ray.origin, ray.dir);
    raycaster.far = 40;
    for (const own of [chevron.mesh, card.mesh]) {
      if (!own.visible) continue;
      const c = raycaster.intersectObject(own, false)[0];
      if (c) return { kind: 'mesh', object: own, uv: c.uv, distance: c.distance, hit: c };
    }
    if (field) {
      const hits = raycaster.intersectObjects([...field.interactive], false).filter((h) => h.object.visible);
      if (hits.length) return { kind: 'mesh', object: hits[0].object, uv: hits[0].uv, distance: hits[0].distance, hit: hits[0] };
      const d = field.depthPick(ray.origin, ray.dir);
      if (d) return { kind: 'depth', depth: d, distance: d.distance };
      // While a field is open the sky behind it cannot be chosen: a stray
      // press must not swap the field. "⟵ Sky" or B first.
      return null;
    }
    const local = toSky(ray.dir);
    const m = markers.pick(local);
    if (m) return { kind: 'marker', marker: m, distance: null };
    const star = starAt(local);
    return { kind: star >= 0 ? 'star' : 'sky', star, dir: local, distance: null };
  }

  function setHover(id, hit) {
    const was = hovered.get(id);
    const wasObj = was?.object ?? was?.marker ?? null;
    const now = hit?.object ?? hit?.marker ?? null;
    if (wasObj && wasObj !== now && was.object) was.object.userData.hover?.(null, null);
    if (hit?.object) hit.object.userData.hover?.(hit.uv, hit.hit);
    if (hit?.marker && wasObj !== hit.marker && id !== 'mouse') pointers.pulse(id, ...HAPTIC.hover);
    hovered.set(id, hit);
  }

  const pointers = createPointers({
    renderer, scene, camera, dom: canvas, look, bringMs: LAYOUT.bringMs,
    onPress(ray) {
      lastRay = ray.id;
      const hit = hitOf(ray);
      pressed = hit;
      return Boolean(hit?.object?.userData.drag && hit.object.userData.press?.());
    },
    onDrag(ray) {
      if (!pressed?.object) return;
      raycaster.set(ray.origin, ray.dir);
      const h = raycaster.intersectObject(pressed.object, false)[0];
      if (h) pressed.object.userData.drag(h.uv);
    },
    onRelease(ray, moved) {
      const was = pressed;
      pressed = null;
      if (moved || !ray) return;
      lastRay = ray.id;
      const hit = hitOf(ray);
      if (!hit) return;
      if (hit.kind === 'marker') { haptic('select'); openTarget(hit.marker); return; }
      if (hit.kind === 'depth') { haptic('select'); showCard(hit.depth.card, hit.depth.at); return; }
      if (hit.kind === 'star' || hit.kind === 'sky') {
        haptic('select');
        showCard(skyCard(hit.dir, hit.star), toWorld([hit.dir.x, hit.dir.y, hit.dir.z]).multiplyScalar(10).add(headPose().head));
        return;
      }
      if (was?.object && was.object !== hit.object) return;
      hit.object.userData.pick?.(hit.uv, hit.hit);
    },
    onBack: goBack,
    onBring: returnToScreens,
    onStep: (d) => field?.step(d),
    onToggle: () => field?.toggle(),
    onTurn: (d) => turnBy(d * LAYOUT.move.snapDeg * D2R),
  });

  /* ---- moving about: walking, flying, turning ----------------------- */
  // In the headset the viewer is moved by offsetting the reference space
  // (the content stays where it is, so every parallax is real); on a flat
  // screen the camera moves. No roll, ever; turns are snaps, not glides.
  const offset = new THREE.Matrix4();
  let baseSpace = null;
  const vignette = new THREE.Mesh(
    new THREE.RingGeometry(0.16, 0.6, 48),
    new THREE.ShaderMaterial({
      uniforms: { k: { value: 0 } },
      vertexShader: 'varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float k; varying vec2 vP; void main() { float r = length(vP); float a = smoothstep(0.18, 0.42, r) * k; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }',
      transparent: true, depthTest: false, depthWrite: false,
    }),
  );
  vignette.position.set(0, 0, -0.3);
  vignette.renderOrder = 95;
  camera.add(vignette);

  function applyOffset() {
    if (!renderer.xr.isPresenting || !baseSpace) return;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    offset.decompose(p, q, new THREE.Vector3());
    renderer.xr.setReferenceSpace(baseSpace.getOffsetReferenceSpace(new XRRigidTransform(
      { x: p.x, y: p.y, z: p.z, w: 1 }, { x: q.x, y: q.y, z: q.z, w: q.w },
    )));
  }

  /** Move the viewer by `v` (world metres). */
  function moveBy(v) {
    if (renderer.xr.isPresenting) {
      // The viewer at offset⁻¹·pose: moving it by v is offset·T(−v).
      offset.multiply(new THREE.Matrix4().makeTranslation(-v.x, -v.y, -v.z));
      applyOffset();
    } else {
      camera.position.add(v);
    }
  }

  /** Turn the viewer by `a` radians about the vertical through the head. */
  function turnBy(a) {
    if (renderer.xr.isPresenting) {
      const { head: h } = headPose();
      // The world turns the other way about the head: the viewer turns.
      const m = new THREE.Matrix4().makeTranslation(h.x, 0, h.z)
        .multiply(new THREE.Matrix4().makeRotationY(-a))
        .multiply(new THREE.Matrix4().makeTranslation(-h.x, 0, -h.z));
      offset.multiply(m);
      applyOffset();
    } else {
      const v = pointers.flatView;
      pointers.setFlatView({ ...v, yaw: v.yaw + a });
    }
  }

  function locomote(dt) {
    const { walk, fly } = pointers.sticks();
    const { dir: d } = headPose();
    const flat = new THREE.Vector3(d.x, 0, d.z).normalize();
    const side = new THREE.Vector3(-flat.z, 0, flat.x);
    const v = new THREE.Vector3()
      .addScaledVector(flat, -walk[1] * LAYOUT.move.walkMps)
      .addScaledVector(side, walk[0] * LAYOUT.move.walkMps)
      .addScaledVector(d, -fly * LAYOUT.move.flyMps);
    const speed = v.length();
    // The vignette closes in while moving, the commonest remedy for its sickness.
    const target = speed > 0.01 ? LAYOUT.move.vignette : 0;
    vignette.material.uniforms.k.value += (target - vignette.material.uniforms.k.value) * Math.min(1, dt * 8);
    vignette.visible = vignette.material.uniforms.k.value > 0.01;
    if (speed > 0.01) moveBy(v.multiplyScalar(dt));
  }

  /* ---- grabbing the field in depth: one hand moves it, two scale it ---- */
  let grab = null;
  function grabDepth() {
    const node = field?.depthNode;
    if (!node) { grab = null; return; }
    const g = pointers.grips();
    const key = g.map((x) => x.id).join('+');
    if (!g.length) { grab = null; return; }
    if (!grab || grab.key !== key) {
      grab = {
        key,
        start: g.map((x) => x.pos.clone()),
        pos: node.position.clone(),
        scale: node.scale.x,
        mid: g.length > 1 ? g[0].pos.clone().lerp(g[1].pos, 0.5) : g[0].pos.clone(),
        span: g.length > 1 ? g[0].pos.distanceTo(g[1].pos) : 1,
      };
      return;
    }
    if (g.length === 1) {
      node.position.copy(grab.pos).add(g[0].pos.clone().sub(grab.start[0]));
    } else {
      const mid = g[0].pos.clone().lerp(g[1].pos, 0.5);
      const s = Math.max(LAYOUT.move.minScale, Math.min(LAYOUT.move.maxScale, grab.scale * (g[0].pos.distanceTo(g[1].pos) / Math.max(0.02, grab.span))));
      // About the hands' midpoint: what is between the hands stays between them.
      node.position.copy(mid).add(grab.pos.clone().sub(grab.mid).multiplyScalar(s / grab.scale));
      node.scale.setScalar(s);
    }
    field.depthScaled?.(node.scale.x);
  }

  /* ---- the headset --------------------------------------------------- */
  let session = null;
  const diag = { fps: 0, features: [], frameRate: null, refSpace: null, supported: false, cpuMs: null };
  const cpu = [];
  let rateChosen = false;

  async function enterXR(given = null) {
    if (session) { session.end(); return; }
    try {
      const s = await (given ?? navigator.xr.requestSession('immersive-vr', { optionalFeatures: OPTIONAL_FEATURES }));
      session = s;
      s.addEventListener('end', onSessionEnd);
      s.addEventListener('visibilitychange', () => field?.pause(s.visibilityState !== 'visible'));
      const granted = s.enabledFeatures ? [...s.enabledFeatures] : null;
      diag.features = granted ?? ['(not reported)'];
      const floorSpace = !granted || granted.includes('local-floor');
      renderer.xr.setReferenceSpaceType(floorSpace ? 'local-floor' : 'local');
      diag.refSpace = floorSpace ? 'local-floor' : 'local';
      await renderer.xr.setSession(s);
      baseSpace = renderer.xr.getReferenceSpace();
      offset.identity();
      // The headset recentred: the screens come round to where the head now points.
      renderer.xr.getReferenceSpace()?.addEventListener?.('reset', () => bring());
      cpu.length = 0;
      rateChosen = false;
      diag.frameRate = s.frameRate ?? null;
      drawFirst();
      ui.inXR(true);
    } catch (err) {
      session = null;
      ui.status(tv('vr.failed', { why: err?.message ?? String(err) }));
    }
  }

  /**
   * 90 Hz only if a frame's own work leaves room for it: the median of the
   * first two seconds at or under 9 ms. Otherwise the headset's steady 72.
   */
  function chooseRate() {
    if (rateChosen || !session || cpu.length < 120) return;
    rateChosen = true;
    const sorted = cpu.slice().sort((a, b) => a - b);
    diag.cpuMs = sorted[Math.floor(sorted.length / 2)];
    const rates = session.supportedFrameRates ? [...session.supportedFrameRates] : [];
    if (!rates.length || !session.updateTargetFrameRate) return;
    const want = diag.cpuMs <= 9 && rates.includes(90) ? 90 : rates.includes(72) ? 72 : null;
    if (want) session.updateTargetFrameRate(want).then(() => { diag.frameRate = session?.frameRate ?? want; }).catch(() => {});
  }

  function onSessionEnd() {
    session = null;
    ui.ended?.();
    renderer.xr.setReferenceSpaceType('local-floor');
    ui.inXR(false);
    drawFirst();
    resize();
  }

  document.addEventListener('visibilitychange', () => {
    if (!session) field?.pause(document.hidden);
  });

  /* ---- diagnostics, in the headset too ------------------------------ */
  let diagOn = ui.diagOn();
  const diagPanel = createPanel({ widthM: 0.5, heightM: 0.3, pxPerM: 900, name: 'diagnostics', opaque: true });
  diagPanel.mesh.position.set(-0.32, -0.26, -1.0);
  diagPanel.mesh.material.depthTest = false;
  diagPanel.mesh.renderOrder = 70;
  diagPanel.mesh.visible = diagOn;
  camera.add(diagPanel.mesh);
  ui.onDiag((on) => { diagOn = on; diagPanel.mesh.visible = on; });

  function diagLines() {
    const src = session ? [...session.inputSources] : [];
    return [
      `fps ${diag.fps}${diag.frameRate ? ` · target ${diag.frameRate} Hz` : ''}${diag.cpuMs != null ? ` · cpu ${diag.cpuMs.toFixed(1)} ms` : ''} · ${renderer.xr.isPresenting ? 'XR' : 'flat'}`,
      `features: ${diag.features.join(', ') || '—'} · space ${diag.refSpace ?? '—'}`,
      `inputs: ${src.length ? src.map((s) => `${s.handedness}/${s.targetRayMode}${s.hand ? '/hand' : ''}${s.gamepad ? '/pad' : ''} ${s.profiles?.[0] ?? ''}`).join('; ') : '—'}`,
      `draw calls ${renderer.info.render.calls} · tris ${renderer.info.render.triangles} · textures ${renderer.info.memory.textures} · geometries ${renderer.info.memory.geometries}`,
      field ? `field ${JSON.stringify(field.stats)}` : 'sky',
    ];
  }

  function drawDiag() {
    diagPanel.draw((ctx, W, H) => {
      ctx.fillStyle = 'rgb(12, 12, 20)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = look.ink;
      ctx.font = `500 22px ${FONTS.mono}`;
      let y = 34;
      for (const l of diagLines()) y = wrapText(ctx, fitText(ctx, l, (W - 40) * 2), 20, y, W - 40, 28, 2);
    });
  }

  /* ---- the loop ----------------------------------------------------- */
  function resize() {
    if (renderer.xr.isPresenting) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  let frames = 0;
  let since = performance.now();
  let last = performance.now();
  // The last thousand frame intervals, for the diagnostics' percentiles.
  const stats = { fps: 0, frames: 0, worst: 0, calls: 0, intervals: new Float32Array(1024) };
  const bufSize = new THREE.Vector2();
  let pendingOpen = null;
  const api = {
    stats,
    open: (key) => { const m = markers.markers.find((x) => x.key === key); if (m) openTarget(m); return Boolean(m); },
    close: () => closeField(true),
    get field() { return field; },
    get view() { return view; },
    back: () => goBack(),
    flip: () => field?.flipView(),
    screens: () => returnToScreens(),
    pointers,
    diagLines,
    info: () => ({ calls: renderer.info.render.calls, textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries }),
    /** Frame intervals over the last `n` frames: median, 95th percentile and worst, in ms. */
    frameTimes(n = 600) {
      const k = Math.min(n, stats.frames, stats.intervals.length);
      const a = [];
      for (let i = 1; i <= k; i++) a.push(stats.intervals[(stats.frames - i + stats.intervals.length * 4) % stats.intervals.length]);
      a.sort((x, y) => x - y);
      return { n: k, median: a[Math.floor(k / 2)], p95: a[Math.floor(k * 0.95)], worst: a[k - 1] };
    },
  };
  window.muninnVR = api;

  renderer.setAnimationLoop((now) => {
    const t0 = performance.now();
    if (pendingOpen && renderer.xr.isPresenting) { const m = pendingOpen; pendingOpen = null; openTarget(m); }
    const dt = Math.min(0.1, (now - last) / 1000);
    stats.worst = Math.max(stats.worst, now - last);
    stats.intervals[stats.frames % stats.intervals.length] = now - last;
    last = now;
    frames++;
    stats.frames++;
    if (now - since >= 1000) {
      diag.fps = Math.round((frames * 1000) / (now - since));
      stats.fps = diag.fps;
      frames = 0;
      since = now;
      if (diagOn) { drawDiag(); ui.diag(diag, diagLines()); }
    }

    const { head: h, dir: d } = headPose();
    const gazeYaw = Math.atan2(-d.x, -d.z);
    // The sky is at infinity: it travels with the head.
    sky.group.position.copy(h);

    // Pixels per degree of the eye being drawn, for everything sized as an angle.
    if (renderer.xr.isPresenting) {
      const eye = renderer.xr.getCamera().cameras?.[0];
      if (eye?.viewport?.w) pxPerDeg.value = (eye.viewport.w / 2) * eye.projectionMatrix.elements[5] * D2R;
    } else {
      renderer.getDrawingBufferSize(bufSize);
      pxPerDeg.value = (bufSize.y / 2) / Math.tan((camera.fov / 2) * D2R) * D2R;
    }
    sky.update(pxPerDeg.value);

    if (fade.ms) {
      const k = Math.min(1, (now - fade.t0) / fade.ms);
      const e = 1 - (1 - k) ** 3;
      currentDim = fade.from + (fade.to - fade.from) * e;
      if (k >= 1) fade.ms = 0;
    }
    // Until the first choice the Milky Way is quieter, so the gold rings are what is seen.
    sky.setDim(currentDim, firstPicked ? 1 : LAYOUT.bandFirst);
    if (home && field) {
      const k = Math.min(1, (now - home.t0) / 260);
      home.veil = k < 0.5 ? k * 2 : 2 - k * 2;
      if (k >= 0.5 && home.stage === 0) {
        // In the dark: the depth view back behind, the walk undone.
        home.stage = 1;
        field.resetView();
        offset.identity();
        applyOffset();
        if (!renderer.xr.isPresenting) camera.position.set(0, EYE_HEIGHT, 0);
      } else if (home.stage === 1) {
        // A frame later, the head is where the undone walk put it: bring the screens to it.
        home.stage = 2;
        bring();
      }
      if (k >= 1) home = null;
    }
    const dark = Math.max(field?.veil ?? 0, home?.veil ?? 0);
    veil.visible = dark > 0.001;
    veil.material.opacity = dark;
    if (field) {
      const y = field.mainYaw();
      markers.setDim(0.45, toSky(field.depthAxis()), LAYOUT.depth.clearDeg, 0.12, toSky(new THREE.Vector3(-Math.sin(y), 0, -Math.cos(y))));
    }
    markers.tick(now, { growMs: LAYOUT.dive.ms, grow: LAYOUT.dive.markerGrow });

    locomote(dt);
    grabDepth();
    if (field) {
      field.update(dt, { head: h, gazeYaw });
      // Lost the screens: after a while, a chevron toward them.
      const off = Math.atan2(Math.sin(field.mainYaw() - gazeYaw), Math.cos(field.mainYaw() - gazeYaw));
      if (Math.abs(off) > LAYOUT.lost.deg * D2R) {
        lostSince ??= now;
        if (now - lostSince > LAYOUT.lost.ms) { drawChevron(Math.sign(off)); chevron.mesh.visible = true; }
      } else {
        lostSince = null;
        chevron.mesh.visible = false;
      }
    }

    const rays = pointers.update(h, headQuat);
    const seen = new Set();
    let markerHover = null;
    let starHover = -1;
    for (const ray of rays) {
      seen.add(ray.id);
      const hit = hitOf(ray);
      setHover(ray.id, hit);
      if (hit?.kind === 'marker') markerHover = hit.marker;
      if (hit?.kind === 'star') starHover = hit.star;
      const pickable = hit ? (hit.kind === 'sky' ? false : hit.kind !== 'mesh' || (hit.object.userData.pickable?.(hit.uv) ?? Boolean(hit.object.userData.pick))) : false;
      pointers.setHit(ray.id, hit?.distance ?? null, pickable);
    }
    for (const id of [...hovered.keys()]) if (!seen.has(id)) { setHover(id, null); hovered.delete(id); }
    markers.setHover(markerHover);
    if (starHover !== starHeld) {
      if (starHover >= 0 && rays.length && rays[0].id !== 'mouse') pointers.pulse(rays[0].id, ...HAPTIC.hover);
      starHeld = starHover;
      starRing.visible = starHover >= 0;
      if (starHover >= 0) {
        const p = sky.positions;
        starRing.position.set(p[starHover * 3] * 300, p[starHover * 3 + 1] * 300, p[starHover * 3 + 2] * 300);
        starRing.lookAt(0, 0, 0);
      }
    }

    renderer.render(scene, camera);
    stats.calls = renderer.info.render.calls;
    if (session) { cpu.push(performance.now() - t0); chooseRate(); }
  });

  // A field asked for by the page that sent the visitor here.
  if (context) {
    const preset = context.key ? markers.markers.find((m) => m.key === context.key) : null;
    const marker = preset ?? (Number.isFinite(context.ra) && Number.isFinite(context.dec) ? {
      v: radecToVec(context.ra, context.dec),
      target: { ra: context.ra, dec: context.dec, fov: context.fov ?? 0.3, band: context.band ?? 'all', name: context.name ?? '' },
    } : null);
    if (marker) {
      // In a session it opens once the headset's own pose is known, so it stands where the viewer is.
      if (asked) pendingOpen = marker;
      else openTarget(marker);
    }
  }

  // The headset, if there is one; and if the session was asked for already, into it.
  const supported = asked ? true : await xrSupported();
  diag.supported = supported;
  ui.xr(supported, () => enterXR());
  ui.diag(diag, diagLines());
  if (asked) await enterXR(asked);

  return {
    renderer, scene, camera, sky, markers,
    /** End the session if there is one, and free the scene. */
    stop() {
      renderer.setAnimationLoop(null);
      session?.end().catch(() => {});
      closeField(false);
      markers.dispose();
      sky.dispose();
      renderer.dispose();
      window.removeEventListener('resize', resize);
      if (window.muninnVR === api) delete window.muninnVR;
    },
  };
}

/* ---------------------------------------------- inside the site's own page */

/**
 * The scene mounted over the site's page, for a visitor who tapped Enter VR
 * there: `session` is the immersive session the tap asked for (a promise),
 * `context` the field on the screen, if one was. The page under it is left
 * as it was and comes back when the session ends.
 */
export async function mountVR({ session, context = null, lang, onEnd }) {
  let granted;
  try {
    granted = await session;
  } catch (err) {
    onEnd?.();
    throw err;
  }
  const root = document.documentElement;
  // The headset is always the night side: the page's own theme comes back after.
  const theme = root.dataset.theme;
  delete root.dataset.theme;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#000';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  host.append(canvas);
  document.body.append(host);
  let vr = null;
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    vr?.stop();
    host.remove();
    if (theme) root.dataset.theme = theme;
    onEnd?.();
  };
  const quiet = () => {};
  const ui = {
    status: quiet, field: quiet, inXR: quiet, xr: quiet, diag: quiet, onDiag: quiet,
    diagOn: () => false,
    ended: () => setTimeout(end, 0),
  };
  try {
    vr = await startVR({ canvas, lang, ui, session: granted, context });
  } catch (err) {
    end();
    throw err;
  }
  return { stop: end };
}

/** A field named in the page's address: ?key=barnard, or ?ra=…&dec=…&fov=…&band=…&name=… */
function contextFromUrl() {
  const q = new URLSearchParams(location.search);
  if (q.get('key')) return { key: q.get('key') };
  const ra = Number(q.get('ra'));
  const dec = Number(q.get('dec'));
  if (!q.has('ra') || !Number.isFinite(ra) || !Number.isFinite(dec)) return null;
  return { ra, dec, fov: Number(q.get('fov')) || 0.3, band: q.get('band') || 'all', name: q.get('name') || '' };
}

/* ------------------------------------------------------------- the page */

function bootPage() {
  const canvas = document.getElementById('vr-canvas');
  if (!canvas) return;
  const lang = pageLanguage();
  const $ = (id) => document.getElementById(id);
  const say = (el, text) => { if (el) { el.textContent = text; el.hidden = !text; } };
  const apply = () => {
    for (const el of document.querySelectorAll('[data-vr]')) el.textContent = tv(el.dataset.vr);
  };
  let diagHook = null;
  const diagStored = () => {
    try { return new URLSearchParams(location.search).has('diag') || localStorage.getItem('muninn.vrDiag') === '1'; } catch { return false; }
  };
  const ui = {
    status: (text) => say($('vr-status'), text),
    field: (name) => { document.body.dataset.field = name ? 'open' : ''; },
    inXR: (on) => {
      document.body.dataset.xr = String(on);
      const b = $('vr-enter');
      if (b) b.textContent = tv(on ? 'vr.exit' : 'vr.enter');
    },
    xr: (supported, enter) => {
      const b = $('vr-enter');
      say($('vr-hint'), supported ? tv('vr.pick') : (window.isSecureContext ? tv('vr.noXR') : `${tv('vr.noXR')} ${tv('vr.insecure')}`));
      if (!b) return;
      b.hidden = !supported;
      b.onclick = enter;
    },
    diagOn: diagStored,
    onDiag: (fn) => { diagHook = fn; },
    diag: (d, lines) => {
      const box = $('vr-diag-out');
      if (box && lines) box.textContent = lines.join('\n');
    },
  };
  setLanguage(lang);
  apply();
  const toggle = $('vr-diag');
  const out = $('vr-diag-out');
  if (toggle && out) {
    const set = (on) => {
      out.hidden = !on;
      toggle.setAttribute('aria-pressed', String(on));
      try { localStorage.setItem('muninn.vrDiag', on ? '1' : '0'); } catch { /* private window */ }
      diagHook?.(on);
    };
    set(diagStored());
    toggle.addEventListener('click', () => set(out.hidden));
  }
  startVR({ canvas, lang, ui, context: contextFromUrl() }).catch((err) => {
    ui.status(tv('vr.failed', { why: err?.message ?? String(err) }));
    console.error(err);
  });
}

bootPage();

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
import { createMarkers } from './targets3d.js';
import { createPointers } from './input.js';
import { openFieldVR } from './field.js';
import { readLook, loadFonts, createPanel, FONTS, wrapText, fitText } from './panel.js';
import { LAYOUT, yawOf, minTextPx } from './layout.js';
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

export async function startVR({ canvas, lang, ui }) {
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
      ctx.roundRect(2, 2, W - 4, H - 4, H / 2);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = look.counter;
      ctx.stroke();
      // The icon: a ray to a ring.
      const cy = H / 2;
      ctx.strokeStyle = look.accent;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(30, cy + 22);
      ctx.lineTo(78, cy - 6);
      ctx.stroke();
      ctx.strokeStyle = look.counter;
      ctx.beginPath();
      ctx.arc(92, cy - 14, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = look.ink;
      ctx.font = `500 ${px}px ${FONTS.body}`;
      ctx.textBaseline = 'middle';
      const text = renderer.xr.isPresenting ? tv('vr.first') : tv('vr.firstFlat');
      wrapText(ctx, text, 130, H / 2 - (ctx.measureText(text).width > W - 160 ? px * 0.6 : 0), W - 160, px * 1.2, 2);
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

  /* ---- what is open ------------------------------------------------- */
  let field = null;
  let fade = { from: 1, to: 1, t0: 0, ms: 0 };
  let currentDim = 1;
  const head = new THREE.Vector3();
  const dir = new THREE.Vector3();

  function headPose() {
    const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    cam.updateMatrixWorld?.();
    head.setFromMatrixPosition(cam.matrixWorld);
    cam.getWorldDirection(dir);
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
    const { head: h } = headPose();
    const world = toWorld(marker.v);
    // The screens go where the target is, at eye level.
    const yawDeg = yawOf([world.x, world.y, world.z]);
    // On a flat screen the view is set to face them at once; in the headset nothing turns.
    if (!renderer.xr.isPresenting) pointers.setFlatView({ yaw: yawDeg * D2R, pitch: -0.06, fov: 80 });
    markers.burst(marker);
    field = openFieldVR(marker.target, {
      scene, head: h, baseYawDeg: yawDeg, fromDir: world.clone().normalize(), lang: getLanguage(), pxPerDeg, haptic,
      onBack: () => closeField(true),
      onBring: bring,
    });
    dimTo(LAYOUT.dive.skyDim);
    markers.setDim(0.45);
    markers.setFirst(null);
    firstSign.mesh.visible = false;
    ui.field(field.label);
  }

  function closeField(animate = true) {
    if (!field) return;
    field.close();
    field = null;
    markers.setDim(1);
    dimTo(1, animate ? 500 : 1);
    chevron.mesh.visible = false;
    ui.field(null);
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
    if (field) {
      const hits = raycaster.intersectObjects([...field.interactive], false).filter((h) => h.object.visible);
      if (hits.length) return { kind: 'mesh', object: hits[0].object, uv: hits[0].uv, distance: hits[0].distance, hit: hits[0] };
    }
    const m = markers.pick(toSky(ray.dir));
    if (m) return { kind: 'marker', marker: m, distance: null };
    return null;
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
      if (was?.object && was.object !== hit.object) return;
      hit.object.userData.pick?.(hit.uv, hit.hit);
    },
    onBack: () => closeField(true),
    onBring: bring,
    onStep: (d) => field?.step(d),
    onToggle: () => field?.toggle(),
  });

  /* ---- the headset --------------------------------------------------- */
  let session = null;
  const diag = { fps: 0, features: [], frameRate: null, refSpace: null, supported: false, cpuMs: null };
  const cpu = [];
  let rateChosen = false;

  async function enterXR() {
    if (session) { session.end(); return; }
    try {
      const s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: OPTIONAL_FEATURES });
      session = s;
      s.addEventListener('end', onSessionEnd);
      s.addEventListener('visibilitychange', () => field?.pause(s.visibilityState !== 'visible'));
      const granted = s.enabledFeatures ? [...s.enabledFeatures] : null;
      diag.features = granted ?? ['(not reported)'];
      const floorSpace = !granted || granted.includes('local-floor');
      renderer.xr.setReferenceSpaceType(floorSpace ? 'local-floor' : 'local');
      diag.refSpace = floorSpace ? 'local-floor' : 'local';
      await renderer.xr.setSession(s);
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
  window.muninnVR = {
    stats,
    open: (key) => { const m = markers.markers.find((x) => x.key === key); if (m) openTarget(m); return Boolean(m); },
    close: () => closeField(true),
    get field() { return field; },
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

  renderer.setAnimationLoop((now) => {
    const t0 = performance.now();
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
      sky.setDim(currentDim);
      if (k >= 1) fade.ms = 0;
    }
    markers.tick(now, { growMs: LAYOUT.dive.ms, grow: LAYOUT.dive.markerGrow });

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

    const rays = pointers.update();
    const seen = new Set();
    let markerHover = null;
    for (const ray of rays) {
      seen.add(ray.id);
      const hit = hitOf(ray);
      setHover(ray.id, hit);
      if (hit?.kind === 'marker') markerHover = hit.marker;
      const pickable = hit ? (hit.kind === 'marker' || (hit.object.userData.pickable?.(hit.uv) ?? Boolean(hit.object.userData.pick))) : false;
      pointers.setHit(ray.id, hit?.distance ?? null, pickable);
    }
    for (const id of [...hovered.keys()]) if (!seen.has(id)) { setHover(id, null); hovered.delete(id); }
    markers.setHover(markerHover);

    renderer.render(scene, camera);
    stats.calls = renderer.info.render.calls;
    if (session) { cpu.push(performance.now() - t0); chooseRate(); }
  });

  // The headset, if there is one.
  const supported = await xrSupported();
  diag.supported = supported;
  ui.xr(supported, enterXR);
  ui.diag(diag, diagLines());
  return { renderer, scene, camera, sky, markers };
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
  startVR({ canvas, lang, ui }).catch((err) => {
    ui.status(tv('vr.failed', { why: err?.message ?? String(err) }));
    console.error(err);
  });
}

bootPage();

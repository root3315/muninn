/**
 * input.js — pointing and choosing, with whatever the viewer has.
 *
 * In the headset: each controller, or each hand when the controllers are put
 * down, casts a ray; the trigger or a pinch chooses what the ray is on, and
 * held down and moved (or the grip squeezed and moved) it drags. The rays and
 * the reticle are drawn here, a thin line and a small ring, rather than loaded
 * as controller models from somewhere else.
 *
 * On a flat screen the mouse or a finger is the ray: drag to look round (or
 * to scroll whatever the press began on), a click to choose, the wheel or a
 * pinch to zoom.
 *
 * Every frame `update()` returns the rays as `{ id, origin, dir }`; the page
 * finds what each is on and answers with `setHit(id, distance)` so the line
 * stops where it lands.
 *
 * The page's hooks:
 *   onPress(ray)          a press began; return true to drag with it
 *   onDrag(ray)           the dragging ray, every frame it is held
 *   onRelease(ray, moved) the press ended; `moved` false is a choice
 *   onBack, onStep(±1), onToggle   the controller's other buttons and the keys
 */

import * as THREE from '../vendor/three.module.js';

const RAY_LENGTH = 8;
const DRAG_PX = 6;
/** How far a held ray may turn, in degrees, and still be a press rather than a drag. */
const DRAG_DEG = 4.5;

export function createPointers({ renderer, scene, camera, dom, look, onPress, onDrag, onRelease, onBack, onBring, onStep, onToggle, bringMs = 800 }) {
  const rays = new Map();
  const tmpQ = new THREE.Quaternion();

  /* ------------------------------------------------------------ headset */

  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const reticleGeo = new THREE.RingGeometry(0.009, 0.014, 32);
  const reticleMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(look.ink), transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide });

  const controllers = [];
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    // Faint over nothing, bright over something that can be chosen.
    const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(look.accent), transparent: true, opacity: 0.3, depthTest: false });
    const line = new THREE.Line(lineGeo, lineMat);
    line.scale.z = RAY_LENGTH;
    line.renderOrder = 50;
    line.visible = false;
    c.add(line);
    const reticle = new THREE.Mesh(reticleGeo, reticleMat);
    reticle.renderOrder = 51;
    reticle.visible = false;
    scene.add(reticle);
    const entry = { c, line, reticle, source: null, pressed: [], stickArmed: true, id: `xr${i}`, hold: null };
    c.addEventListener('connected', (e) => {
      entry.source = e.data;
      // A gaze ray comes from between the eyes; a line from there is in the way.
      line.visible = e.data.targetRayMode === 'tracked-pointer';
    });
    c.addEventListener('disconnected', () => {
      entry.source = null;
      entry.hold = null;
      line.visible = false;
      reticle.visible = false;
    });
    const begin = (kind) => {
      const ray = rayOf(entry);
      if (!ray || entry.hold) return;
      const drags = onPress?.(ray, kind) === true;
      entry.hold = { kind, dir: ray.dir.clone(), moved: false, drags };
    };
    const end = (kind) => {
      const hold = entry.hold;
      if (!hold || hold.kind !== kind) return;
      entry.hold = null;
      const ray = rayOf(entry);
      // A squeeze only ever drags; it never chooses.
      onRelease?.(ray, hold.moved || kind === 'squeeze', hold.drags);
    };
    c.addEventListener('selectstart', () => begin('select'));
    c.addEventListener('selectend', () => end('select'));
    c.addEventListener('squeezestart', () => begin('squeeze'));
    c.addEventListener('squeezeend', () => end('squeeze'));
    scene.add(c);
    controllers.push(entry);
  }

  function rayOf(entry) {
    if (!entry.source) return null;
    const origin = new THREE.Vector3().setFromMatrixPosition(entry.c.matrixWorld);
    entry.c.getWorldQuaternion(tmpQ);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(tmpQ).normalize();
    return { id: entry.id, origin, dir };
  }

  /**
   * The buttons a Quest controller has besides the trigger: B/Y back to the
   * sky (held, the screens come round to where the head points), A/X play or
   * hold, the stick steps through the visits.
   */
  function readPads(entry, now) {
    const pad = entry.source?.gamepad;
    if (!pad) return;
    const edge = (k) => {
      const down = Boolean(pad.buttons[k]?.pressed);
      const was = entry.pressed[k] ?? false;
      entry.pressed[k] = down;
      return down && !was ? 'down' : !down && was ? 'up' : null;
    };
    const b = edge(5);
    if (b === 'down') entry.heldSince = now;
    if (entry.heldSince != null && pad.buttons[5]?.pressed && now - entry.heldSince >= bringMs) {
      entry.heldSince = null;
      onBring?.();
    }
    if (b === 'up' && entry.heldSince != null) { entry.heldSince = null; onBack?.(); }
    if (edge(4) === 'down') onToggle?.();
    const x = pad.axes[2] ?? 0;
    if (Math.abs(x) > 0.7 && entry.stickArmed) { entry.stickArmed = false; onStep?.(x > 0 ? 1 : -1); }
    if (Math.abs(x) < 0.3) entry.stickArmed = true;
  }

  /* ------------------------------------------------------- flat screen */

  const flat = { yaw: 0, pitch: 0, fov: camera.fov, mouse: null, down: null, pinch: null, touches: new Map() };
  const raycaster = new THREE.Raycaster();

  function flatRay() {
    if (!flat.mouse) return null;
    const rect = dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((flat.mouse[0] - rect.left) / rect.width) * 2 - 1,
      -((flat.mouse[1] - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    return { id: 'mouse', origin: raycaster.ray.origin.clone(), dir: raycaster.ray.direction.clone() };
  }

  function applyLook() {
    flat.pitch = Math.max(-1.45, Math.min(1.45, flat.pitch));
    camera.rotation.set(flat.pitch, flat.yaw, 0, 'YXZ');
    if (Math.abs(camera.fov - flat.fov) > 1e-3) {
      camera.fov = flat.fov;
      camera.updateProjectionMatrix();
    }
  }

  dom.addEventListener('pointerdown', (e) => {
    if (renderer.xr.isPresenting) return;
    dom.setPointerCapture?.(e.pointerId);
    flat.touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (flat.touches.size === 2) {
      const [a, b] = [...flat.touches.values()];
      flat.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), fov: flat.fov };
      flat.down = null;
      return;
    }
    flat.mouse = [e.clientX, e.clientY];
    const ray = flatRay();
    const drags = ray ? onPress?.(ray, 'select') === true : false;
    flat.down = { x: e.clientX, y: e.clientY, yaw: flat.yaw, pitch: flat.pitch, moved: false, drags };
  });
  dom.addEventListener('pointermove', (e) => {
    if (renderer.xr.isPresenting) return;
    if (flat.touches.has(e.pointerId)) flat.touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (flat.pinch && flat.touches.size === 2) {
      const [a, b] = [...flat.touches.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      flat.fov = Math.max(15, Math.min(100, flat.pinch.fov * (flat.pinch.d / Math.max(1, d))));
      applyLook();
      return;
    }
    flat.mouse = [e.clientX, e.clientY];
    const d = flat.down;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) > DRAG_PX) d.moved = true;
    if (!d.moved) return;
    if (d.drags) {
      const ray = flatRay();
      if (ray) onDrag?.(ray);
      return;
    }
    // A pixel of drag turns the sky by a pixel's worth of view, so what is
    // under the pointer stays under it.
    const perPx = ((camera.fov * Math.PI) / 180) / dom.clientHeight;
    flat.yaw = d.yaw + dx * perPx;
    flat.pitch = d.pitch + dy * perPx;
    applyLook();
  });
  const release = (e) => {
    if (renderer.xr.isPresenting) return;
    flat.touches.delete(e.pointerId);
    if (flat.touches.size < 2) flat.pinch = null;
    const d = flat.down;
    flat.down = null;
    if (d) {
      flat.mouse = [e.clientX, e.clientY];
      const ray = flatRay();
      onRelease?.(ray, d.moved || e.type !== 'pointerup', d.drags);
    }
    if (e.pointerType !== 'mouse') flat.mouse = null;
  };
  dom.addEventListener('pointerup', release);
  dom.addEventListener('pointercancel', release);
  dom.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !flat.down) flat.mouse = null; });
  dom.addEventListener('wheel', (e) => {
    if (renderer.xr.isPresenting) return;
    e.preventDefault();
    flat.fov = Math.max(15, Math.min(100, flat.fov * Math.exp(e.deltaY * 0.001)));
    applyLook();
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (renderer.xr.isPresenting) return;
    if (e.target?.closest?.('button, a, input')) return;
    if (e.key === 'Escape' || e.key === 'Backspace') onBack?.();
    else if (e.key === 'ArrowRight') onStep?.(1);
    else if (e.key === 'ArrowLeft') onStep?.(-1);
    else if (e.key === ' ') { e.preventDefault(); onToggle?.(); }
  });

  /* ------------------------------------------------------------- frame */

  return {
    /** The rays this frame; a held one that drags is reported to onDrag. */
    update() {
      rays.clear();
      if (renderer.xr.isPresenting) {
        const now = performance.now();
        for (const entry of controllers) {
          readPads(entry, now);
          const ray = rayOf(entry);
          if (!ray) { entry.reticle.visible = false; continue; }
          rays.set(ray.id, { ...ray, entry });
          const hold = entry.hold;
          if (hold) {
            if (!hold.moved && hold.dir.angleTo(ray.dir) * (180 / Math.PI) > DRAG_DEG) hold.moved = true;
            if (hold.moved && hold.drags) onDrag?.(ray);
          }
        }
      } else {
        const ray = flatRay();
        if (ray) rays.set(ray.id, ray);
      }
      return [...rays.values()];
    },
    /** Where a ray landed: the line stops there and the reticle sits on it. Null for nothing. */
    setHit(id, distance, pickable = distance != null) {
      const ray = rays.get(id);
      if (!ray?.entry) return;
      const { line, reticle } = ray.entry;
      line.material.opacity = pickable ? 0.9 : 0.3;
      line.scale.z = distance ?? RAY_LENGTH;
      if (distance == null) { reticle.visible = false; return; }
      reticle.visible = true;
      reticle.position.copy(ray.origin).addScaledVector(ray.dir, distance * 0.995);
      reticle.lookAt(ray.origin);
      reticle.scale.setScalar(Math.max(1, distance / 1.5));
    },
    /** A short buzz in the hand that holds this ray: `strength` 0–1 for `ms`. */
    pulse(id, strength, ms) {
      const entry = controllers.find((e) => e.id === id);
      const pad = entry?.source?.gamepad;
      const act = pad?.hapticActuators?.[0];
      try {
        if (act?.pulse) act.pulse(strength, ms);
        else pad?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength });
      } catch { /* a controller without a motor */ }
    },
    /** The input sources the session has, for the diagnostics. */
    sources() {
      return controllers.filter((e) => e.source).map((e) => e.source);
    },
    /** Turn the flat view to face a direction (a dive on the screen). */
    lookToward(dir, fov = null) {
      flat.yaw = Math.atan2(-dir.x, -dir.z);
      flat.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
      if (fov) flat.fov = fov;
      applyLook();
    },
    get flatView() { return { yaw: flat.yaw, pitch: flat.pitch, fov: flat.fov }; },
    setFlatView({ yaw, pitch, fov }) {
      flat.yaw = yaw; flat.pitch = pitch; if (fov) flat.fov = fov;
      applyLook();
    },
  };
}

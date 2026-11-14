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
 *   onTurn(±1)            a snap turn: the right stick pushed aside
 *
 * The sticks: the left one walks where the head looks, the right one turns
 * by steps aside and flies along the line of sight up and down (`sticks()`).
 * The grips: `grips()` says which hands are squeezing, and where they are.
 */

import * as THREE from '../vendor/three.module.js';

const RAY_LENGTH = 8;
const DRAG_PX = 6;
/** How far a held ray may turn, in degrees, and still be a press rather than a drag. */
const DRAG_DEG = 4.5;

export function createPointers({ renderer, scene, camera, dom, look, onPress, onDrag, onRelease, onBack, onBring, onStep, onToggle, onTurn, onTeleport, bringMs = 800, skyRadius = 600 }) {
  const rays = new Map();
  const tmpQ = new THREE.Quaternion();

  /* ------------------------------------------------------------ headset */

  // Every pointer shows where it lands: a ray that fades toward its end, and
  // at the end a reticle — a ring with a dot, the same size to the eye at any
  // distance, turned to the head, bright over something that can be pressed,
  // an open ring while the trigger or the pinch is held. The two hands are
  // tinted apart. Nothing here is made anew per frame.
  const RAY_VERTEX = 'attribute float fade; varying float vF; void main() { vF = fade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const RAY_FRAGMENT = 'uniform vec3 tint; uniform float k; varying float vF; void main() { gl_FragColor = vec4(tint, vF * k); }';
  const RETICLE_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const RETICLE_FRAGMENT = `uniform vec3 tint; uniform float glow; uniform float held; varying vec2 vUv;
    void main() {
      float r = length(vUv * 2.0 - 1.0);
      float w = fwidth(r) * 1.5;
      float ring = smoothstep(0.62 - w, 0.62, r) * (1.0 - smoothstep(0.9, 0.9 + w, r));
      float dot = (1.0 - smoothstep(0.2, 0.2 + w, r)) * (1.0 - held);
      float a = max(ring, dot) * mix(0.75, 1.0, glow);
      if (a < 0.01) discard;
      gl_FragColor = vec4(mix(tint, vec3(1.0), glow * 0.35), a);
    }`;
  const TINTS = [look.accent, look.counter];
  const RETICLE_DEG = 1.3;
  // Over the sky the ray runs out to the sky's sphere, and the reticle sits on it.
  const AIM_DEFAULT_M = skyRadius * 0.97;
  const headPos = new THREE.Vector3();
  const headQuat = new THREE.Quaternion();
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();

  const controllers = [];
  const walk = [0, 0];
  let fly = 0;
  const keys = new Set();
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    const hand = renderer.xr.getHand(i);
    scene.add(hand);
    const tint = new THREE.Color(TINTS[i]);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    lineGeo.setAttribute('fade', new THREE.BufferAttribute(new Float32Array([0.9, 0]), 1));
    const lineMat = new THREE.ShaderMaterial({
      uniforms: { tint: { value: tint }, k: { value: 0.35 } },
      vertexShader: RAY_VERTEX, fragmentShader: RAY_FRAGMENT, transparent: true, depthTest: false, depthWrite: false,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    line.frustumCulled = false;
    line.renderOrder = 50;
    line.visible = false;
    scene.add(line);
    const reticleMat = new THREE.ShaderMaterial({
      uniforms: { tint: { value: tint }, glow: { value: 0 }, held: { value: 0 } },
      vertexShader: RETICLE_VERTEX, fragmentShader: RETICLE_FRAGMENT, transparent: true, depthTest: false, depthWrite: false,
    });
    reticleMat.extensions = { derivatives: true };
    const reticle = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), reticleMat);
    reticle.renderOrder = 51;
    reticle.visible = false;
    scene.add(reticle);
    const entry = {
      c, hand, line, reticle, source: null, pressed: [], stickArmed: true, id: `xr${i}`, hold: null, handed: i ? 1 : -1,
      steady: oneEuro(),
      ray: { id: `xr${i}`, origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), entry: null }, aimed: false,
    };
    entry.ray.entry = entry;
    c.addEventListener('connected', (e) => {
      entry.source = e.data;
      entry.aimed = false;
      entry.steady = oneEuro();
      entry.handed = e.data.handedness === 'left' ? -1 : 1;
      // A gaze ray comes from between the eyes; a line from there is in the way.
      line.visible = e.data.targetRayMode !== 'gaze';
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

  /**
   * A one-euro filter on a direction (Casiez, Roussel & Vogel 2012): heavy
   * smoothing while the hand is still, almost none while it moves, so the
   * reticle neither trembles nor lags.
   */
  function oneEuro({ minCutoff = 1.0, beta = 6.0, dCutoff = 1.0 } = {}) {
    const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    let prev = null;
    let dPrev = new THREE.Vector3();
    let t0 = 0;
    return (v, now) => {
      if (!prev) { prev = v.clone(); t0 = now; return prev; }
      const dt = Math.max(1e-3, (now - t0) / 1000);
      t0 = now;
      const d = v.clone().sub(prev).divideScalar(dt);
      dPrev = dPrev.lerp(d, alpha(dCutoff, dt));
      const cutoff = minCutoff + beta * dPrev.length();
      prev.lerp(v, alpha(cutoff, dt)).normalize();
      return prev;
    };
  }

  /**
   * Where a pointer is aimed. A controller's own target ray, exactly as the
   * headset gives it. A hand's: from an estimate of the shoulder through the
   * wrist, which shakes far less than the fingers, through a light one-euro
   * filter.
   */
  function aim(entry) {
    if (!entry.source) return false;
    const wrist = entry.source.hand ? entry.hand.joints?.wrist : null;
    if (wrist && wrist.visible !== false) {
      wrist.getWorldPosition(vA);
      // The shoulder: under and beside the head, on the hand's own side.
      vB.set(entry.handed * 0.17, -0.22, 0.02).applyQuaternion(headQuat);
      vB.y = -0.22;
      vB.add(headPos);
      const dir = vA.clone().sub(vB).normalize();
      entry.ray.dir.copy(entry.steady(dir, performance.now()));
      entry.ray.origin.copy(vA);
    } else {
      entry.ray.origin.setFromMatrixPosition(entry.c.matrixWorld);
      entry.c.getWorldQuaternion(tmpQ);
      entry.ray.dir.set(0, 0, -1).applyQuaternion(tmpQ).normalize();
    }
    entry.aimed = true;
    return true;
  }

  function rayOf(entry) {
    if (!entry.source) return null;
    if (!entry.aimed) aim(entry);
    // A copy for whoever keeps it past this frame.
    return { id: entry.id, origin: entry.ray.origin.clone(), dir: entry.ray.dir.clone() };
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
    // The stick pressed in: an arc to the floor while held, a step there on letting go.
    const stick = edge(3);
    entry.aiming = Boolean(pad.buttons[3]?.pressed);
    if (stick === 'up') onTeleport?.(entry.id);
    const x = pad.axes[2] ?? 0;
    const y = pad.axes[3] ?? 0;
    const dead = (v) => (Math.abs(v) < 0.15 ? 0 : v);
    if (entry.source.handedness === 'left') {
      walk[0] = dead(x);
      walk[1] = dead(y);
    } else {
      // Aside: a snap turn, once per push. Up and down: along the line of sight.
      if (Math.abs(x) > 0.7 && entry.stickArmed) { entry.stickArmed = false; onTurn?.(x > 0 ? -1 : 1); }
      if (Math.abs(x) < 0.3) entry.stickArmed = true;
      fly = Math.abs(x) < 0.5 ? dead(y) : 0;
    }
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
  // On a flat screen, W A S D walk, Q and E turn, R and F fly; G held is a grip on what the mouse points at,
  // T held aims a step to the floor where the mouse points.
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 't' && keys.has('t')) onTeleport?.('mouse');
    keys.delete(k);
  });
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('keydown', (e) => {
    if (!renderer.xr.isPresenting && !e.target?.closest?.('input')) {
      const k = e.key.toLowerCase();
      if ('wasdrfgt'.includes(k) && k.length === 1) keys.add(k);
      if (k === 'q') onTurn?.(1);
      if (k === 'e') onTurn?.(-1);
    }
  });
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
    /** The rays this frame; a held one that drags is reported to onDrag. `head` and `quat` place the reticles. */
    update(head = null, quat = null) {
      if (head) headPos.copy(head);
      if (quat) headQuat.copy(quat);
      rays.clear();
      if (renderer.xr.isPresenting) {
        const now = performance.now();
        for (const entry of controllers) {
          readPads(entry, now);
          if (!aim(entry)) { entry.reticle.visible = false; entry.line.visible = false; continue; }
          const ray = entry.ray;
          rays.set(ray.id, ray);
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
      // The ray ends where it lands, or a few metres out on the sky.
      const d = distance ?? AIM_DEFAULT_M;
      const pos = line.geometry.attributes.position;
      pos.setXYZ(0, ray.origin.x, ray.origin.y, ray.origin.z);
      pos.setXYZ(1, ray.origin.x + ray.dir.x * d, ray.origin.y + ray.dir.y * d, ray.origin.z + ray.dir.z * d);
      pos.needsUpdate = true;
      line.visible = ray.entry.source?.targetRayMode !== 'gaze';
      line.material.uniforms.k.value = pickable ? 0.9 : 0.4;
      // The reticle: on whatever the ray landed on, the same size to the eye, turned to the head.
      reticle.visible = line.visible;
      reticle.position.copy(ray.origin).addScaledVector(ray.dir, d);
      reticle.quaternion.copy(headQuat);
      const toEye = reticle.position.distanceTo(headPos);
      reticle.scale.setScalar(2 * Math.tan((RETICLE_DEG / 2) * Math.PI / 180) * Math.max(0.2, toEye));
      reticle.material.uniforms.glow.value = pickable ? 1 : 0;
      reticle.material.uniforms.held.value = ray.entry.hold?.kind === 'select' ? 1 : 0;
    },
    /** Where a pointer's reticle is now, or null: for a word beside it. */
    reticleAt(id) {
      const ray = rays.get(id);
      if (ray?.entry) return ray.entry.reticle.visible ? ray.entry.reticle.position : null;
      return ray ? ray.origin.clone().addScaledVector(ray.dir, AIM_DEFAULT_M) : null;
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
    /** The sticks this frame: `walk` [x, y] (left stick or W A S D), `fly` (right stick up/down, or R F). */
    sticks() {
      if (renderer.xr.isPresenting) return { walk: walk.slice(), fly };
      const kx = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
      const ky = (keys.has('s') ? 1 : 0) - (keys.has('w') ? 1 : 0);
      const kf = (keys.has('f') ? 1 : 0) - (keys.has('r') ? 1 : 0);
      return { walk: [kx, ky], fly: kf };
    },
    /** The pointers aiming a step to the floor now: their ids. */
    aiming() {
      if (!renderer.xr.isPresenting) return keys.has('t') && flat.mouse ? ['mouse'] : [];
      return controllers.filter((e) => e.aiming).map((e) => e.id);
    },
    /** The hands squeezing their grips: [{ id, pos (world) }]. */
    grips() {
      const out = [];
      if (!renderer.xr.isPresenting && keys.has('g') && flat.mouse) {
        const ray = flatRay();
        if (ray) out.push({ id: 'mouse', pos: ray.origin.clone().addScaledVector(ray.dir, 0.5) });
      }
      for (const e of controllers) {
        if (!e.source?.gamepad?.buttons?.[1]?.pressed && !(e.hold?.kind === 'squeeze')) continue;
        out.push({ id: e.id, pos: new THREE.Vector3().setFromMatrixPosition(e.c.matrixWorld) });
      }
      return out;
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

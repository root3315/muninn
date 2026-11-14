/**
 * windows.js — the field's screens as windows: taken by the grip and carried
 * on the ray, pushed away or pulled near with the stick, made bigger or
 * smaller with both hands, and never left over one another. Where each was
 * put is kept for the rest of the page's life, so the next field opens the
 * way the viewer arranged the last; "Reset layout" puts them back.
 *
 *   createWindows({ group, minGapDeg })
 *     -> { add(mesh), grab(id, mesh, ray, point), carry(id, ray, push, dt, head),
 *          scale(mesh, k, head), drop(id, head), held(mesh), reset(), settle(mesh, head),
 *          windowOf(object) }
 *
 * Poses are kept in `group`'s frame (the screens' group, stood at the head),
 * so "Screens to me" brings them round as they are.
 */
import * as THREE from '../vendor/three.module.js';

/** Where the viewer put each window, by name, for as long as the page is open. */
const KEPT = new Map();

const NEAR_M = 0.7;
const FAR_M = 4.5;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const PUSH_MPS = 1.6;

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function createWindows({ group, minGapDeg = 1.2, onMoved = () => {} }) {
  const gap = (minGapDeg * Math.PI) / 180;
  const windows = new Map();
  const grabs = new Map();
  const tmp = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();

  function pose(mesh) {
    return { position: mesh.position.clone(), quaternion: mesh.quaternion.clone(), scale: mesh.scale.x };
  }
  function apply(mesh, p) {
    mesh.position.copy(p.position);
    mesh.quaternion.copy(p.quaternion);
    mesh.scale.setScalar(p.scale);
  }

  /** Turn a window to face the head, upright. */
  function face(mesh, head) {
    mesh.updateMatrixWorld();
    const at = mesh.getWorldPosition(new THREE.Vector3());
    const look = new THREE.Object3D();
    look.position.copy(at);
    look.lookAt(head);
    group.updateMatrixWorld();
    group.getWorldQuaternion(tmpQ).invert();
    mesh.quaternion.copy(tmpQ.multiply(look.quaternion));
  }

  /** A window's box as seen from the head: centre yaw and pitch, half sizes, all in radians. */
  function boxOf(mesh, head) {
    mesh.updateMatrixWorld();
    const c = mesh.getWorldPosition(new THREE.Vector3()).sub(head);
    const d = c.length();
    const g = mesh.geometry.parameters;
    const s = mesh.getWorldScale(tmp).x;
    return {
      yaw: Math.atan2(-c.x, -c.z),
      pitch: Math.asin(Math.max(-1, Math.min(1, c.y / d))),
      hw: Math.atan((g.width * s) / 2 / d),
      hh: Math.atan((g.height * s * (mesh.userData.panel?.used ?? 1)) / 2 / d),
      // A card drawn from its top: its box sits that much higher.
      lift: Math.atan((g.height * s * (1 - (mesh.userData.panel?.used ?? 1))) / 2 / d),
      d,
    };
  }

  /** Stand a window at a yaw and pitch from the head, `d` metres out, facing it. */
  function standAt(mesh, head, yaw, pitch, d) {
    const world = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch),
    ).multiplyScalar(d).add(head);
    group.updateMatrixWorld();
    mesh.position.copy(group.worldToLocal(world));
    face(mesh, head);
  }

  /**
   * Move `mesh` the least way out of every other window it overlaps, as seen
   * from the head, with `minGapDeg` between: the one in hand gives way, the
   * others stay where they were put.
   */
  function clear(mesh, head) {
    for (let pass = 0; pass < 8; pass++) {
      const m = boxOf(mesh, head);
      const my = m.pitch + m.lift;
      let moved = false;
      for (const other of windows.keys()) {
        if (other === mesh || !other.visible) continue;
        const o = boxOf(other, head);
        const oy = o.pitch + o.lift;
        const dyaw = wrap(m.yaw - o.yaw);
        const dp = my - oy;
        const ox = m.hw + o.hw + gap - Math.abs(dyaw);
        const oyv = m.hh + o.hh + gap - Math.abs(dp);
        if (ox <= 0 || oyv <= 0) continue;
        if (ox < oyv) m.yaw += (dyaw >= 0 ? 1 : -1) * ox;
        else m.pitch += (dp >= 0 ? 1 : -1) * oyv;
        standAt(mesh, head, m.yaw, m.pitch, m.d);
        moved = true;
        break;
      }
      if (!moved) return;
    }
  }

  return {
    /** A window to manage; it takes the pose the viewer last gave a window of its name. */
    add(mesh) {
      windows.set(mesh, pose(mesh));
      const kept = KEPT.get(mesh.name);
      if (kept) apply(mesh, kept);
    },
    /** Whether a window is in a hand now. */
    held(mesh) { for (const g of grabs.values()) if (g.mesh === mesh) return true; return false; },
    get holding() { return grabs.size > 0; },
    /** Take `mesh` by the point of it the ray `id` met. */
    grab(id, mesh, ray, point) {
      mesh.updateMatrixWorld();
      grabs.set(id, {
        mesh,
        dist: point.distanceTo(ray.origin),
        offset: mesh.getWorldPosition(new THREE.Vector3()).sub(point),
      });
    },
    /**
     * Carry what ray `id` holds along with the ray, `push` (−1…1, a stick)
     * sending it away or bringing it near over `dt` seconds, turned to face
     * `head` and kept clear of the others.
     */
    carry(id, ray, push, dt, head) {
      const g = grabs.get(id);
      if (!g) return;
      g.dist = Math.max(NEAR_M, Math.min(FAR_M, g.dist + push * PUSH_MPS * dt));
      const world = ray.origin.clone().addScaledVector(ray.dir, g.dist).add(g.offset);
      group.updateMatrixWorld();
      g.mesh.position.copy(group.worldToLocal(world));
      face(g.mesh, head);
      clear(g.mesh, head);
    },
    /** Both hands on one window: its size by how far apart they are now against when taken. */
    scale(mesh, k, head) {
      const base = windows.get(mesh);
      if (!base) return;
      mesh.userData.scale0 ??= mesh.scale.x;
      mesh.scale.setScalar(Math.max(MIN_SCALE, Math.min(MAX_SCALE, mesh.userData.scale0 * k)));
      clear(mesh, head);
    },
    /** Let go: the window stays, clear of the others, and is remembered. */
    drop(id, head) {
      const g = grabs.get(id);
      grabs.delete(id);
      if (!g) return;
      delete g.mesh.userData.scale0;
      clear(g.mesh, head);
      KEPT.set(g.mesh.name, pose(g.mesh));
      onMoved();
    },
    /** Whether any window stands elsewhere than it first did. */
    get moved() { return KEPT.size > 0; },
    /** Every window back where it first stood, and nothing remembered. */
    reset() {
      KEPT.clear();
      grabs.clear();
      for (const [mesh, p] of windows) apply(mesh, p);
    },
    /** Keep a window that has just appeared clear of the others, as seen from `head`. */
    settle(mesh, head) {
      if (windows.has(mesh) && mesh.visible) clear(mesh, head);
    },
    /** The window `mesh` belongs to, or null: a window or anything inside one. */
    windowOf(object) {
      for (let o = object; o; o = o.parent) if (windows.has(o)) return o;
      return null;
    },
  };
}

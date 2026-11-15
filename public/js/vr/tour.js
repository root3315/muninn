/**
 * tour.js — the walk-through: a welcome on entering, then eleven things to
 * do, each with the real control lit and waited for, then the controls in
 * one card.
 *
 * Nothing waits on it: a step can be done, skipped (Next), gone back to, or
 * the whole tour put away, at any moment, and the room works the same with
 * it open or shut. Each step knows two things from the room (main.js hands
 * them over every frame as `facts`): whether it has been done since it began,
 * and where its control stands, for the ring.
 */
import * as THREE from '../vendor/three.module.js';
import { createPanel, FONTS, wrapText, button, chipWidth, roundRect } from './panel.js';
import { tv } from './strings.js';

/** Remembered once the tour has been seen or put away: it opens by itself only the first time. */
export const TOUR_SEEN = 'muninn.vrTour';

/**
 * The steps, in order. `done(f, at)` is given this frame's facts and those
 * when the step began; `where(f)` the world position of its control, or null.
 */
export const TOUR_STEPS = [
  { key: 'look', done: (f, at) => Math.abs(turned(at.yaw, f.yaw)) > 1.2 || f.fieldOpen, where: () => null },
  { key: 'point', done: (f) => f.snapped || f.fieldOpen, where: (f) => f.marker },
  { key: 'open', done: (f) => f.fieldOpen, where: (f) => f.marker },
  { key: 'blink', done: (f, at) => f.fieldOpen && f.steps > at.steps, where: (f) => f.control('bar', 'next') },
  { key: 'mark', done: (f, at) => f.marks > at.marks, where: (f) => f.control('main') },
  { key: 'grab', done: (f, at) => f.drops > at.drops, where: (f) => f.control('card') },
  { key: 'depth', done: (f) => f.flipped, where: (f) => f.control('bar', 'flip') },
  { key: 'fly', done: (f, at) => f.flights > at.flights, where: (f) => f.depthThing },
  { key: 'tape', done: (f, at) => f.tapes > at.tapes, where: (f) => f.cardAt ?? f.depthThing },
  { key: 'time', done: (f) => f.clockPlaying, where: (f) => f.control('depthControls', 'play') },
  { key: 'back', done: (f, at) => f.backs > at.backs, where: () => null },
];

/** The signed turn between two yaws, in radians. */
const turned = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Which step a tour started from inside an open field begins at: the field is already open. */
export const firstStepFor = ({ fieldOpen }) => (fieldOpen ? TOUR_STEPS.findIndex((s) => s.key === 'blink') : 0);

const W_M = 0.74;
const H_M = 0.5;
const PX = 1000;
/** Drawn at nine tenths of its canvas size, 1.3 m ahead, its middle about 24° above the eyes. */
const PANEL_SCALE = 0.9;
const PANEL_M = 1.3;
const PANEL_UP = 0.58;

export function createTour({ look, sound = null, flat = () => false }) {
  const panel = createPanel({ widthM: W_M, heightM: H_M, pxPerM: PX, name: 'tour', opaque: true });
  panel.mesh.visible = false;
  panel.mesh.renderOrder = 60;
  panel.mesh.material.depthTest = false;
  panel.mesh.scale.setScalar(PANEL_SCALE);

  // The ring round the real control: turned to the eye, pulsing, the same size to the eye at any distance.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1, 64),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(look.counter), transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  ring.renderOrder = 61;
  ring.visible = false;
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.25, 64),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false }),
  );
  halo.renderOrder = 60;
  ring.add(halo);

  const st = { phase: null, i: 0, at: null, hover: null, doneAt: 0, yaw: null };

  function draw() {
    panel.draw((ctx, W, H, hits) => {
      roundRect(ctx, 2, 2, W - 4, H - 4, 28);
      ctx.fillStyle = look.paper;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = look.counterDim;
      ctx.stroke();
      const x = 30;
      const w = W - 60;
      const n = TOUR_STEPS.length;
      // Progress: a bar of the steps, the done ones lit.
      if (st.phase === 'step') {
        const gap = 6;
        const seg = (w - gap * (n - 1)) / n;
        for (let k = 0; k < n; k++) {
          roundRect(ctx, x + k * (seg + gap), 24, seg, 8, 4);
          ctx.fillStyle = k < st.i ? look.counter : k === st.i ? look.accent : look.paper3;
          ctx.fill();
        }
        ctx.font = `500 22px ${FONTS.mono}`;
        ctx.fillStyle = look.neutral;
        ctx.fillText(tv('vr.tourCount', { n: st.i + 1, total: n }), x, 66);
      }
      const key = st.phase === 'step' ? TOUR_STEPS[st.i].key : st.phase;
      let y = st.phase === 'step' ? 112 : 70;
      ctx.font = `600 34px ${FONTS.display}`;
      ctx.fillStyle = st.phase === 'step' && st.doneAt ? look.counter : look.ink;
      y = wrapText(ctx, `${st.phase === 'step' && st.doneAt ? '✓ ' : ''}${tv(`vr.tour.${key}H`)}`, x, y, w, 40, 2) + 4;
      ctx.font = `400 25px ${FONTS.body}`;
      ctx.fillStyle = look.muted;
      y = wrapText(ctx, tv(`vr.tour.${key}P`), x, y, w, 32, st.phase === 'step' ? 4 : 8);
      // How, with the hands in a headset or the mouse on a screen.
      const how = tv(`vr.tour.${key}${flat() ? 'Flat' : 'Xr'}`);
      if (how && !how.startsWith('vr.tour.')) {
        ctx.font = `500 22px ${FONTS.mono}`;
        ctx.fillStyle = look.counter;
        y = wrapText(ctx, how, x, y + 4, w, 28, 2);
      }
      // The ways on, at the foot: back, skip the tour, and on.
      const font = `500 24px ${FONTS.body}`;
      const bh = 50;
      const by = H - bh - 22;
      const ways = st.phase === 'welcome' ? [['skip', tv('vr.tourSkip')], ['next', tv('vr.tourStart')]]
        : st.phase === 'finish' ? [['back', `‹ ${tv('vr.tourBack')}`], ['close', tv('vr.tourDone')]]
          : [['back', `‹ ${tv('vr.tourBack')}`], ['skip', tv('vr.tourSkip')], ['next', `${tv('vr.tourNext')} ›`]];
      const widths = ways.map(([, label]) => chipWidth(ctx, font, label, bh, 110));
      let bx = W - x - widths.reduce((s, v) => s + v + 12, -12);
      ways.forEach(([id, label], k) => {
        button(ctx, hits, look, { x: bx, y: by, w: widths[k], h: bh, label, id, font, on: id === 'next' && st.phase !== 'step', hover: st.hover === id });
        bx += widths[k] + 12;
      });
    });
  }

  function go(phase, i = st.i) {
    st.phase = phase;
    st.i = i;
    st.doneAt = 0;
    st.at = null;
    st.backed = false;
    panel.mesh.visible = Boolean(phase);
    ring.visible = false;
    if (phase) draw();
  }
  let lastFacts = null;
  const remember = () => { try { localStorage.setItem(TOUR_SEEN, '1'); } catch { /* storage refused */ } };

  function press(id) {
    if (id === 'skip' || id === 'close') { remember(); go(null); return; }
    if (id === 'next') {
      if (st.phase === 'welcome') go('step', firstStepFor(lastFacts ?? {}));
      else if (st.phase === 'step') advance();
      return;
    }
    if (id === 'back') {
      if (st.phase === 'finish') go('step', TOUR_STEPS.length - 1);
      else if (st.phase === 'step' && st.i > 0) go('step', st.i - 1);
      else go('welcome', 0);
      // A step gone back to is shown, even if it is already done.
      st.backed = true;
    }
  }

  function advance() {
    if (st.i + 1 >= TOUR_STEPS.length) { remember(); go('finish'); } else go('step', st.i + 1);
  }

  panel.mesh.userData.pick = (uv) => { const h = panel.hitAt(uv); if (h) press(h.id); };
  panel.mesh.userData.pickable = (uv) => Boolean(panel.hitAt(uv));
  panel.mesh.userData.hover = (uv) => {
    const id = uv ? panel.hitAt(uv)?.id ?? null : null;
    if (id !== st.hover) { st.hover = id; draw(); }
  };

  const tmp = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  return {
    mesh: panel.mesh,
    ring,
    get active() { return Boolean(st.phase); },
    get state() { return { phase: st.phase, step: st.phase === 'step' ? TOUR_STEPS[st.i].key : null, i: st.i, done: Boolean(st.doneAt) }; },
    /** Open the tour: at the welcome, or (from inside a field) at the field's own steps. */
    start({ welcome = true } = {}) {
      st.yaw = null;
      if (welcome) go('welcome', 0);
      else go('step', firstStepFor(lastFacts ?? {}));
    },
    press,
    /**
     * Once a frame: `facts` from the room, the head's place and turn. The
     * panel follows the gaze lazily, a little below it; the ring sits on the
     * step's control; a step done is ticked, chimed, and passed a moment later.
     */
    update(facts, head, quat, gazeYaw) {
      lastFacts = facts;
      if (!st.phase) return;
      if (st.phase === 'step') {
        const step = TOUR_STEPS[st.i];
        // A step already done as it begins (the field was open before "open a field") is passed quietly.
        if (!st.at) {
          st.at = { ...facts };
          if (!st.backed && step.done(facts, st.at)) { advance(); return; }
        }
        if (!st.doneAt && !st.backed && step.done(facts, st.at)) {
          st.doneAt = performance.now();
          sound?.chime?.();
          draw();
        }
        if (st.doneAt && performance.now() - st.doneAt > 900) advance();
        const where = st.phase === 'step' ? TOUR_STEPS[st.i].where(facts) : null;
        ring.visible = Boolean(where);
        if (where) {
          const d = Math.max(0.3, where.distanceTo(head));
          const k = 1 + 0.12 * Math.sin(performance.now() / 220);
          ring.position.copy(where);
          ring.quaternion.copy(quat);
          ring.scale.setScalar(d * Math.tan((2.6 * Math.PI) / 180) * k);
        }
      }
      // The panel: ahead and above the eyes, over the field's screen and clear
      // of its bar, cards and controls below; it comes round when the gaze
      // leaves it by much.
      if (st.yaw == null || Math.abs(turned(st.yaw, gazeYaw)) > 0.7) st.yaw = gazeYaw;
      fwd.set(-Math.sin(st.yaw), 0, -Math.cos(st.yaw));
      tmp.copy(head).addScaledVector(fwd, PANEL_M);
      tmp.y = head.y + PANEL_UP;
      panel.mesh.position.copy(tmp);
      panel.mesh.lookAt(head);
    },
    dispose() { panel.dispose(); ring.removeFromParent(); ring.geometry.dispose(); ring.material.dispose(); halo.geometry.dispose(); halo.material.dispose(); },
  };
}

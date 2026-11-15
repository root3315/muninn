/**
 * sound.js — the headset's sounds, every one made here with the Web Audio
 * API: no recordings, nothing fetched. Restrained and instrument-like, quiet
 * by default, silent at rest.
 *
 * One graph, built once (and built the same way into an offline context for
 * a recording of the audition):
 *
 *   voices ─┬──────────────────────────────► master ─► limiter ─► out
 *           └─ send ─► one reverb (an impulse response made in code) ─┘
 *
 *   clicks   short noise transients through a bright and a soft band, a
 *            little different each time
 *   bells    three partials (1, 2.76, 5.4) with an exponential decay: windows
 *            opening and closing, marks and their verdicts
 *   air      pink noise through two moving band-passes, panned apart and
 *            slowly wandering, its level and pitch following the speed
 *   room     a few detuned low sines, slowly swelling, low-passed, barely there
 *   star     a sine and its octave, a slow tremolo, from the star's place
 *   clock    a wooden tick: a noise burst through a resonant band
 *
 * Every voice is made once and kept; an event only schedules its parameters,
 * so nothing is created frame by frame.
 */

/** Where the choice of sound and its level is kept between visits. */
const KEPT = 'muninn.vrSound';
/** A modest level: the room's own quiet, not a soundtrack. */
const DEFAULT_VOLUME = 0.35;
/** The partials of a small bell or glass, as ratios of the first. */
const BELL = [1, 2.76, 5.4];

/**
 * A star's tone from its colour: B−V to a temperature (Ballesteros 2012),
 * the temperature to a pitch on a log scale, 3000 K at 196 Hz to 30 000 K at
 * 784 Hz (two octaves). A sonification, not a sound of the star.
 */
export function toneOfColour(bv) {
  if (!Number.isFinite(bv)) return 330;
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const k = Math.max(0, Math.min(1, Math.log(Math.max(3000, Math.min(30000, t)) / 3000) / Math.log(10)));
  return 196 * 2 ** (2 * k);
}

/** Within ±3 %, so a repeat never sounds quite the same. */
const wobble = (x) => x * (1 + (Math.random() * 2 - 1) * 0.03);

/** Hold a parameter where it is at `t`, so whatever is scheduled next starts there: no clicks. */
function hold(param, t) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else { const v = param.value; param.cancelScheduledValues(t); param.setValueAtTime(v, t); }
}

/**
 * The whole graph in `ctx` (a live or an offline context), at level `gain`:
 * an engine whose every sound takes the time it starts at.
 */
function buildEngine(ctx, gain) {
  const sr = ctx.sampleRate;
  const master = ctx.createGain();
  master.gain.value = gain;
  // A gentle limiter: several sounds at once never clip.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -16;
  limiter.knee.value = 10;
  limiter.ratio.value = 6;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  master.connect(limiter).connect(ctx.destination);

  // Noise, made once: white, and pink (Kellet's filter) for air.
  const white = ctx.createBuffer(1, sr * 2, sr);
  const pink = ctx.createBuffer(1, sr * 4, sr);
  {
    const w = white.getChannelData(0);
    for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;
    const p = pink.getChannelData(0);
    let b0 = 0; let b1 = 0; let b2 = 0; let b3 = 0; let b4 = 0; let b5 = 0; let b6 = 0;
    for (let i = 0; i < p.length; i++) {
      const x = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + x * 0.0555179; b1 = 0.99332 * b1 + x * 0.0750759; b2 = 0.969 * b2 + x * 0.153852;
      b3 = 0.8665 * b3 + x * 0.3104856; b4 = 0.55 * b4 + x * 0.5329522; b5 = -0.7616 * b5 - x * 0.016898;
      p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11;
      b6 = x * 0.115926;
    }
  }
  const loop = (buffer) => { const s = ctx.createBufferSource(); s.buffer = buffer; s.loop = true; s.start(); return s; };

  // One reverb for everything: a stereo impulse of decaying noise, about 1.2 s, darker as it fades.
  const reverb = ctx.createConvolver();
  {
    const len = Math.round(sr * 1.2);
    const ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const k = i / len;
        lp += (Math.random() * 2 - 1 - lp) * (0.6 - 0.45 * k);
        d[i] = lp * (1 - k) ** 2.4 * Math.exp(-3 * k);
      }
    }
    reverb.buffer = ir;
  }
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  reverb.connect(wet).connect(master);
  /** A voice's way out: dry to the master, and a little to the reverb. */
  const out = (node, send) => {
    node.connect(master);
    if (send) { const g = ctx.createGain(); g.gain.value = send; node.connect(g).connect(reverb); }
  };

  // Clicks: noise through a bright band and a soft one, enveloped together.
  const clicks = [];
  for (let i = 0; i < 4; i++) {
    const src = loop(white);
    const hi = ctx.createBiquadFilter(); hi.type = 'bandpass'; hi.Q.value = 1.4;
    const lo = ctx.createBiquadFilter(); lo.type = 'bandpass'; lo.Q.value = 2.2;
    const gHi = ctx.createGain(); const gLo = ctx.createGain();
    const env = ctx.createGain(); env.gain.value = 0;
    src.connect(hi).connect(gHi).connect(env);
    src.connect(lo).connect(gLo).connect(env);
    out(env, 0.08);
    clicks.push({ hi, lo, gHi, gLo, env });
  }
  let nextClick = 0;
  function click(t, { hiHz, loHz, body, level, ms }) {
    const v = clicks[nextClick];
    nextClick = (nextClick + 1) % clicks.length;
    v.hi.frequency.setValueAtTime(wobble(hiHz), t);
    v.lo.frequency.setValueAtTime(wobble(loHz), t);
    v.gHi.gain.setValueAtTime(1 - body, t);
    v.gLo.gain.setValueAtTime(body * 1.6, t);
    hold(v.env.gain, t);
    v.env.gain.linearRampToValueAtTime(0.0001, t + 0.002);
    v.env.gain.linearRampToValueAtTime(wobble(level), t + 0.0035);
    v.env.gain.exponentialRampToValueAtTime(0.0001, t + 0.0035 + ms / 1000);
  }

  // Bells: three partials each, decaying at their own pace.
  const bells = [];
  for (let i = 0; i < 4; i++) {
    const partials = BELL.map(() => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g);
      osc.start();
      return { osc, g };
    });
    const sum = ctx.createGain();
    for (const p of partials) p.g.connect(sum);
    out(sum, 0.32);
    bells.push(partials);
  }
  let nextBell = 0;
  function bell(t, freq, level, decay) {
    const v = bells[nextBell];
    nextBell = (nextBell + 1) % bells.length;
    const f = wobble(freq);
    const l = wobble(level);
    v.forEach((p, k) => {
      hold(p.g.gain, t);
      p.g.gain.linearRampToValueAtTime(0.0001, t + 0.004);
      // A hair of detune on the upper partials: glass, not a synth.
      p.osc.frequency.setValueAtTime(f * BELL[k] * (1 + (k ? (Math.random() - 0.5) * 0.004 : 0)), t + 0.004);
      p.g.gain.linearRampToValueAtTime(l / (1 + k * 1.6), t + 0.012);
      p.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012 + decay / (1 + k * 0.9));
    });
  }

  // Air: pink noise with body, through two wandering bands panned apart.
  let air;
  {
    const src = loop(pink);
    const shelf = ctx.createBiquadFilter(); shelf.type = 'lowshelf'; shelf.frequency.value = 220; shelf.gain.value = 6;
    const level = ctx.createGain(); level.gain.value = 0;
    src.connect(shelf);
    const bands = [-0.55, 0.55].map((pan, k) => {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8; bp.frequency.value = 400;
      // A slow random-feeling drift of the centre: two slow sines of unrelated rates.
      for (const [hz, depth] of [[0.11 + k * 0.03, 70], [0.047 + k * 0.021, 50]]) {
        const lfo = ctx.createOscillator(); lfo.frequency.value = hz;
        const d = ctx.createGain(); d.gain.value = depth;
        lfo.connect(d).connect(bp.frequency);
        lfo.start();
      }
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (p) p.pan.value = pan;
      shelf.connect(bp);
      if (p) bp.connect(p).connect(level); else bp.connect(level);
      return bp;
    });
    out(level, 0.12);
    air = { level, bands, target: 0 };
  }
  function airTo(t, mps, tau = 0.15) {
    const s = Math.max(0, mps);
    const g = s < 0.05 ? 0 : Math.min(0.5, 0.06 + s * 0.07);
    hold(air.level.gain, t);
    air.level.gain.setTargetAtTime(g, t, tau);
    air.bands.forEach((bp, k) => { hold(bp.frequency, t); bp.frequency.setTargetAtTime((300 + Math.min(2400, s * 300)) * (k ? 1.18 : 0.86), t, tau); });
    air.target = g;
  }

  // Swishes and dives: pink noise through a sweeping band.
  const sweeps = [];
  for (let i = 0; i < 2; i++) {
    const src = loop(pink);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
    const env = ctx.createGain(); env.gain.value = 0;
    src.connect(bp).connect(env);
    out(env, 0.18);
    sweeps.push({ bp, env });
  }
  let nextSweep = 0;
  function sweep(t, from, to, level, ms) {
    const v = sweeps[nextSweep];
    nextSweep = (nextSweep + 1) % sweeps.length;
    hold(v.bp.frequency, t);
    v.bp.frequency.setValueAtTime(from, t + 0.004);
    v.bp.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
    hold(v.env.gain, t);
    v.env.gain.linearRampToValueAtTime(0.0001, t + 0.004);
    v.env.gain.linearRampToValueAtTime(level, t + (ms / 1000) * 0.4);
    v.env.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  }

  // The room: a soft pad, a few low sines a hair apart, each swelling slowly.
  let room;
  {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.3;
    const level = ctx.createGain(); level.gain.value = 0;
    const base = [55, 82.4, 110.2, 164.9];
    const oscs = base.map((f, k) => {
      const o = ctx.createOscillator(); o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.5 / (1 + k * 0.6);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05 + k * 0.017;
      const depth = ctx.createGain(); depth.gain.value = 0.22 / (1 + k * 0.6);
      lfo.connect(depth).connect(g.gain);
      const drift = ctx.createOscillator(); drift.frequency.value = 0.031 + k * 0.009;
      const cents = ctx.createGain(); cents.gain.value = 3;
      drift.connect(cents).connect(o.detune);
      o.connect(g).connect(lp);
      o.start(); lfo.start(); drift.start();
      return { o, f };
    });
    lp.connect(level);
    out(level, 0.35);
    room = { level, oscs };
  }
  function roomTo(t, which) {
    const k = which === 'depth' ? 0.75 : 1;
    for (const r of room.oscs) { hold(r.o.frequency, t); r.o.frequency.setTargetAtTime(r.f * k, t, 1.2); }
    hold(room.level.gain, t);
    room.level.gain.setTargetAtTime(which === 'sky' || which === 'depth' ? 0.05 : 0, t, 1.5);
  }

  // Spatial voices: placed in the room, HRTF where there is one, equal power where not.
  const placed = (send) => {
    const panner = ctx.createPanner();
    try { panner.panningModel = 'HRTF'; } catch { /* below */ }
    if (panner.panningModel !== 'HRTF') panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.5;
    panner.rolloffFactor = 0.6;
    const g = ctx.createGain(); g.gain.value = 0;
    g.connect(panner);
    out(panner, send);
    return { panner, g };
  };
  function place(v, pos, t) {
    if (v.panner.positionX) {
      v.panner.positionX.setValueAtTime(pos.x, t);
      v.panner.positionY.setValueAtTime(pos.y, t);
      v.panner.positionZ.setValueAtTime(pos.z, t);
    } else v.panner.setPosition(pos.x, pos.y, pos.z);
  }

  // The star: a sine and its octave, a slow tremolo, from where the star is.
  let star;
  {
    const v = placed(0.4);
    const a = ctx.createOscillator(); const b = ctx.createOscillator();
    const gb = ctx.createGain(); gb.gain.value = 0.28;
    const trem = ctx.createGain(); trem.gain.value = 0.85;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.6;
    const depth = ctx.createGain(); depth.gain.value = 0.15;
    lfo.connect(depth).connect(trem.gain);
    a.connect(trem); b.connect(gb).connect(trem);
    trem.connect(v.g);
    a.start(); b.start(); lfo.start();
    star = { ...v, a, b };
  }
  function starOn(t, freq, pos) {
    place(star, pos, t);
    hold(star.a.frequency, t); hold(star.b.frequency, t);
    star.a.frequency.setTargetAtTime(freq, t, 0.04);
    star.b.frequency.setTargetAtTime(freq * 2, t, 0.04);
    hold(star.g.gain, t);
    star.g.gain.setTargetAtTime(0.05, t, 0.3);
  }
  function starOff(t) { hold(star.g.gain, t); star.g.gain.setTargetAtTime(0, t, 0.45); }

  // A known body's tick, from its place: a short bright knock.
  let knock;
  {
    const v = placed(0.15);
    const src = loop(white);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 5;
    src.connect(bp).connect(v.g);
    knock = v;
  }
  function knockAt(t, pos) {
    place(knock, pos, t);
    hold(knock.g.gain, t);
    knock.g.gain.linearRampToValueAtTime(0.0001, t + 0.003);
    knock.g.gain.linearRampToValueAtTime(wobble(0.35), t + 0.005);
    knock.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  }

  // The clock: a wooden tick, a noise burst through a resonant band.
  let wood;
  {
    const src = loop(white);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 14; bp.frequency.value = 1400;
    const env = ctx.createGain(); env.gain.value = 0;
    src.connect(bp).connect(env);
    out(env, 0.1);
    wood = { bp, env };
  }
  function woodAt(t, dir, level = 0.5) {
    wood.bp.frequency.setValueAtTime(wobble(dir > 0 ? 1560 : 1260), t);
    wood.env.gain.setValueAtTime(0.0001, t);
    wood.env.gain.linearRampToValueAtTime(wobble(level), t + 0.002);
    wood.env.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
  }

  return {
    ctx, master, air, star,
    voices: clicks.length + bells.length + sweeps.length + 6,
    panning: star.panner.panningModel,
    click: (t) => click(t, { hiHz: 3600, loHz: 950, body: 0.45, level: 0.22, ms: 22 }),
    tick: (t) => click(t, { hiHz: 6200, loHz: 2200, body: 0.2, level: 0.09, ms: 9 }),
    open: (t) => bell(t, 1046, 0.06, 0.9),
    close: (t) => bell(t, 784, 0.05, 0.7),
    mark: (t) => { click(t, { hiHz: 2800, loHz: 700, body: 0.6, level: 0.2, ms: 26 }); },
    verdict(t, kind) {
      if (kind === 'moving' || kind === 'transient') { bell(t, 784, 0.05, 0.8); bell(t + 0.12, 1175, 0.05, 1.0); } else if (kind === 'fixed' || kind === 'saturated' || kind === 'intermittent') bell(t, 659, 0.055, 1.1);
      else bell(t, 392, 0.045, 0.6);
    },
    swish: (t) => sweep(t, 2000, 450, 0.35, 280),
    dive: (t) => sweep(t, 260, 2400, 0.4, 700),
    airTo, roomTo, starOn, starOff, knockAt, woodAt,
    step: (t, dir) => woodAt(t, dir, 0.35),
  };
}

function readKept() {
  try {
    const k = JSON.parse(localStorage.getItem(KEPT) ?? 'null');
    if (k && typeof k.on === 'boolean' && Number.isFinite(k.volume)) return k;
  } catch { /* nothing kept */ }
  return { on: true, volume: DEFAULT_VOLUME };
}

/** The page's one sound: a field or a session entered again reuses it, never a second context. */
let shared = null;
export function pageSound() {
  shared ??= createSound();
  return shared;
}

/**
 * The audition: every sound in turn, at times from `t0`, on `e`. The same
 * list plays live (Shift+S on a flat screen) and is rendered to a WAV.
 */
function audition(e, t0) {
  let t = t0 + 0.2;
  const at = (dt) => { t += dt; return t; };
  const front = { x: 0, y: 1.6, z: -2 };
  e.click(at(0)); e.click(at(0.35)); e.tick(at(0.35)); e.tick(at(0.18)); e.tick(at(0.18));
  e.open(at(0.5)); e.close(at(1.0));
  e.mark(at(1.0)); e.verdict(at(0.25), 'moving');
  e.mark(at(1.4)); e.verdict(at(0.25), 'fixed');
  e.mark(at(1.4)); e.verdict(at(0.25), 'none');
  e.swish(at(1.4));
  e.dive(at(0.9));
  // A flight: a swell, a cruise, a settle.
  const f = at(1.3);
  e.airTo(f, 0.5, 0.25); e.airTo(f + 0.4, 3, 0.3); e.airTo(f + 1.4, 5, 0.3); e.airTo(f + 2.4, 0, 0.35);
  // A blue star from the left, a red one from the right.
  const s = at(3.6);
  e.starOn(s, toneOfColour(-0.1), { x: -2, y: 1.6, z: -1.5 }); e.starOff(s + 1.6);
  e.starOn(s + 2.2, toneOfColour(1.6), { x: 2, y: 1.6, z: -1.5 }); e.starOff(s + 3.8);
  e.knockAt(s + 4.4, front); e.knockAt(s + 4.9, { x: 1.5, y: 1.6, z: -1 });
  // The clock forward, then back, then a step each way.
  const c = at(5.6);
  for (let k = 0; k < 8; k++) e.woodAt(c + k * 0.25, 1);
  for (let k = 0; k < 12; k++) e.woodAt(c + 2.2 + k * 0.09, -1);
  e.step(c + 3.6, 1); e.step(c + 3.9, -1);
  // The room: the sky's tone, then the depth's, then gone.
  const r = at(4.4);
  e.roomTo(r, 'sky'); e.roomTo(r + 3.5, 'depth'); e.roomTo(r + 6.5, null);
  return r + 8.5 - t0;
}

/** A WAV file of `buffer` (16-bit PCM). */
function wavOf(buffer) {
  const ch = buffer.numberOfChannels;
  const n = buffer.length;
  const bytes = 44 + n * ch * 2;
  const v = new DataView(new ArrayBuffer(bytes));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, buffer.sampleRate, true); v.setUint32(28, buffer.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch).keys()].map((c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) { v.setInt16(o, Math.max(-1, Math.min(1, data[c][i])) * 0x7fff, true); o += 2; }
  }
  return v.buffer;
}

export function createSound() {
  const kept = readKept();
  let e = null;
  let view = null;
  const clockState = { playing: false, next: 0 };
  const level = () => (kept.on ? kept.volume : 0);
  const now = () => e.ctx.currentTime;
  const save = () => { try { localStorage.setItem(KEPT, JSON.stringify(kept)); } catch { /* not kept */ } };
  const ramp = (param, value, tau) => { const t = now(); hold(param, t); param.setTargetAtTime(value, t, tau); };
  const live = () => e && kept.on;

  const api = {
    /** On a gesture (the session's start, a first press or key): the context made, or woken. */
    start() {
      if (!e) {
        try { e = buildEngine(new (window.AudioContext || window.webkitAudioContext)(), level()); } catch { e = null; return; }
      }
      if (e.ctx.state === 'suspended') e.ctx.resume();
    },
    suspend() { if (e && e.ctx.state === 'running') e.ctx.suspend(); },
    resume() { if (e && e.ctx.state === 'suspended') e.ctx.resume(); },
    /** Every voice let down and the context asleep: leaving VR, or the page going away. */
    quiet() {
      if (!e) return;
      api.motion(0);
      clockState.playing = false;
      e.starOff(now());
      view = null;
      e.roomTo(now(), null);
      setTimeout(() => api.suspend(), 300);
    },
    get started() { return Boolean(e); },
    get running() { return e?.ctx.state === 'running'; },
    get enabled() { return kept.on; },
    get volume() { return kept.volume; },
    setEnabled(on) { kept.on = on; save(); if (e) ramp(e.master.gain, level(), 0.05); },
    setVolume(v) { kept.volume = Math.max(0, Math.min(1, v)); save(); if (e) ramp(e.master.gain, level(), 0.05); },

    /** The listener at the head: position and the way it faces, every frame, no allocation. */
    listen(pos, quat) {
      if (!e) return;
      const l = e.ctx.listener;
      const { x, y, z, w } = quat;
      const fx = -(2 * (x * z + w * y));
      const fy = -(2 * (y * z - w * x));
      const fz = -(1 - 2 * (x * x + y * y));
      const ux = 2 * (x * y - w * z);
      const uy = 1 - 2 * (x * x + z * z);
      const uz = 2 * (y * z + w * x);
      if (l.positionX) {
        l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
        l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
        l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
      } else {
        l.setPosition(pos.x, pos.y, pos.z);
        l.setOrientation(fx, fy, fz, ux, uy, uz);
      }
    },

    /** How fast the viewer moves, m/s: air past the ears, silent at rest. Re-aimed only on a real change. */
    motion(mps) {
      if (!e) return;
      const s = Number.isFinite(mps) ? Math.max(0, mps) : 0;
      const g = s < 0.05 ? 0 : Math.min(0.5, 0.06 + s * 0.07);
      if (Math.abs(g - e.air.target) < 0.008) return;
      e.airTo(now(), s);
    },
    /** The room's tone for a view: in the sky, deeper in the depth view, gone otherwise. */
    ambience(next) {
      if (!e || next === view) return;
      view = next;
      e.roomTo(now(), next);
    },
    click() { if (live()) e.click(now()); },
    tick() { if (live()) e.tick(now()); },
    open() { if (live()) e.open(now()); },
    close() { if (live()) e.close(now()); },
    mark() { if (live()) e.mark(now()); },
    verdict(kind) { if (live()) e.verdict(now(), kind); },
    swish() { if (live()) e.swish(now()); },
    dive() { if (live()) e.dive(now()); },
    /** A faint tone from where the chosen thing is, pitched by its colour (a plain middle tone without one). */
    tone(pos, bv = null) { if (live()) e.starOn(now(), toneOfColour(bv), pos); },
    toneOff() { if (e) e.starOff(now()); },
    tick3d(pos) { if (live()) e.knockAt(now(), pos); },
    step(dir) { if (live()) e.step(now(), dir); },
    /** While the clock plays: a soft wooden tick, faster at ×10, a touch higher toward the future. */
    clock(playing, fast, dir) {
      if (!e) return;
      clockState.playing = playing && kept.on;
      if (!clockState.playing) return;
      const t = now();
      if (clockState.next < t) clockState.next = t;
      while (clockState.next < t + 0.1) {
        e.woodAt(clockState.next, dir);
        clockState.next += fast ? 0.09 : 0.25;
      }
    },
    /** Every sound in turn, live: for listening on a flat screen (Shift+S). */
    audition() { if (!e) api.start(); if (e) return audition(e, now()); return 0; },
    /** The same audition rendered offline, as a WAV file (an ArrayBuffer). */
    async record() {
      const probe = new OfflineAudioContext(2, 44100, 44100);
      const len = Math.ceil((audition(buildEngine(probe, DEFAULT_VOLUME), 0) + 0.5) * 44100);
      const off = new OfflineAudioContext(2, len, 44100);
      const eng = buildEngine(off, DEFAULT_VOLUME * 1.6);
      // The listener at a standing head, looking ahead.
      if (off.listener.positionY) off.listener.positionY.value = 1.6;
      audition(eng, 0);
      return wavOf(await off.startRendering());
    },
    /** For the checks: the voices made (once), whether the air is still, the context and the panning. */
    get voices() { return e ? e.voices : 0; },
    get still() { return !e || e.air.target === 0; },
    get contextState() { return e?.ctx.state ?? 'none'; },
    get panning() { return e?.panning ?? null; },
  };
  return api;
}

/**
 * sound.js — the headset's sounds, every one made here with the Web Audio
 * API: no recordings, nothing fetched. Restrained and instrument-like, quiet
 * by default, silent at rest.
 *
 * The voices are made once and kept: a motion voice (filtered noise whose
 * pitch and level follow how fast the viewer moves), a room tone, a pool of
 * short blips and noise swishes, two spatial voices placed in the room
 * (HRTF) and a clock voice. Each event only moves their parameters, so
 * nothing is allocated frame by frame.
 *
 *   createSound() -> { start(), suspend(), resume(), listen(pos, quat),
 *     motion(mps), ambience(view), click(), tick(), open(), close(),
 *     mark(), verdict(kind), swish(), dive(), tone(pos, bv), toneOff(),
 *     tick3d(pos), step(dir), clock(playing, fast, dir),
 *     enabled, volume, setEnabled(on), setVolume(v) }
 */

/** Where the choice of sound and its level is kept between visits. */
const KEPT = 'muninn.vrSound';
/** A modest level: the room's own quiet, not a soundtrack. */
const DEFAULT_VOLUME = 0.35;

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

function readKept() {
  try {
    const k = JSON.parse(localStorage.getItem(KEPT) ?? 'null');
    if (k && typeof k.on === 'boolean' && Number.isFinite(k.volume)) return k;
  } catch { /* nothing kept */ }
  return { on: true, volume: DEFAULT_VOLUME };
}

export function createSound() {
  const kept = readKept();
  let ctx = null;
  let master = null;
  let noise = null;
  let motionV = null;
  let room = null;
  let clockV = null;
  const blips = [];
  const swishes = [];
  const spatial = [];
  let nextBlip = 0;
  let nextSwish = 0;
  let nextSpatial = 0;
  let toneV = null;
  let view = null;
  const clockState = { playing: false, next: 0, fast: false, dir: 1 };

  const now = () => ctx.currentTime;
  const level = () => (kept.on ? kept.volume : 0);
  const ramp = (param, value, tau = 0.08) => { param.cancelScheduledValues(now()); param.setTargetAtTime(value, now(), tau); };

  /** A looping noise source, to share: one buffer, two seconds. */
  function noiseSource() {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.start();
    return src;
  }

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = level();
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Motion: band-passed noise, its centre and level following the speed.
    {
      const src = noiseSource();
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 300;
      filter.Q.value = 0.9;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(master);
      motionV = { filter, gain };
    }
    // The room: two low sines a little apart, so it breathes; silent until a view asks.
    {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 180;
      const a = ctx.createOscillator();
      const b = ctx.createOscillator();
      a.frequency.value = 55;
      b.frequency.value = 55.6;
      a.connect(lp);
      b.connect(lp);
      lp.connect(gain).connect(master);
      a.start();
      b.start();
      room = { gain, a, b };
    }
    // Blips: short sine tones, enveloped on a gain that rests at zero.
    for (let i = 0; i < 6; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(master);
      osc.start();
      blips.push({ osc, gain });
    }
    // Swishes: noise through a filter whose sweep is scheduled per event.
    for (let i = 0; i < 3; i++) {
      const src = noiseSource();
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 1.2;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(master);
      swishes.push({ filter, gain });
    }
    // Spatial: a tone and a tick that come from a place in the room.
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const panner = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1.5, rolloffFactor: 0.6 });
      osc.connect(gain).connect(panner).connect(master);
      osc.start();
      spatial.push({ osc, gain, panner });
    }
    toneV = spatial[0];
    // The clock: a soft tick, a high-passed click.
    {
      const src = noiseSource();
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 2400;
      filter.Q.value = 6;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(master);
      clockV = { filter, gain };
    }
  }

  /** A short tone: `freq` Hz, `peak` level, `ms` long, optionally gliding to `to` Hz. */
  function blip(freq, peak, ms, to = freq) {
    if (!ctx || !kept.on) return;
    const v = blips[nextBlip];
    nextBlip = (nextBlip + 1) % blips.length;
    const t = now();
    v.osc.frequency.cancelScheduledValues(t);
    v.osc.frequency.setValueAtTime(freq, t);
    v.osc.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(0, t);
    v.gain.gain.linearRampToValueAtTime(peak, t + 0.006);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  }

  /** A breath of filtered noise sweeping `from` → `to` Hz over `ms`. */
  function sweep(from, to, peak, ms) {
    if (!ctx || !kept.on) return;
    const v = swishes[nextSwish];
    nextSwish = (nextSwish + 1) % swishes.length;
    const t = now();
    v.filter.frequency.cancelScheduledValues(t);
    v.filter.frequency.setValueAtTime(from, t);
    v.filter.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(0, t);
    v.gain.gain.linearRampToValueAtTime(peak, t + (ms / 1000) * 0.35);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  }

  /** Place a spatial voice at `pos` (world, metres). */
  function place(v, pos) {
    const t = now();
    v.panner.positionX.setValueAtTime(pos.x, t);
    v.panner.positionY.setValueAtTime(pos.y, t);
    v.panner.positionZ.setValueAtTime(pos.z, t);
  }

  function save() {
    try { localStorage.setItem(KEPT, JSON.stringify(kept)); } catch { /* not kept */ }
  }

  const api = {
    /** On a gesture (the session's start, a first click): the context made, or woken. */
    start() {
      if (!ctx) {
        try { build(); } catch { ctx = null; return; }
      }
      if (ctx.state === 'suspended') ctx.resume();
    },
    suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); },
    resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); },
    get started() { return Boolean(ctx); },
    get running() { return ctx?.state === 'running'; },
    get enabled() { return kept.on; },
    get volume() { return kept.volume; },
    setEnabled(on) { kept.on = on; save(); if (master) ramp(master.gain, level(), 0.05); },
    setVolume(v) { kept.volume = Math.max(0, Math.min(1, v)); save(); if (master) ramp(master.gain, level(), 0.05); },

    /** The listener at the head: position and the way it faces, every frame, no allocation. */
    listen(pos, quat) {
      if (!ctx) return;
      const l = ctx.listener;
      // Forward −z and up +y, turned by the head.
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

    /** How fast the viewer moves, m/s: air past the ears, silent at rest. */
    motion(mps) {
      if (!ctx) return;
      const s = Math.max(0, mps);
      ramp(motionV.gain.gain, s < 0.05 ? 0 : Math.min(0.22, 0.03 + s * 0.035), 0.12);
      ramp(motionV.filter.frequency, 260 + Math.min(2800, s * 320), 0.12);
    },

    /** The room's tone for a view: low in the sky, lower in the depth view, gone otherwise. */
    ambience(next) {
      if (!ctx || next === view) return;
      view = next;
      const base = next === 'depth' ? 41 : 55;
      ramp(room.a.frequency, base, 0.6);
      ramp(room.b.frequency, base * 1.011, 0.6);
      ramp(room.gain.gain, next === 'sky' || next === 'depth' ? 0.018 : 0, 1.2);
    },

    /** A button pressed. */
    click() { blip(1320, 0.05, 45, 990); },
    /** The pointer snapped onto something. */
    tick() { blip(2200, 0.018, 25); },
    /** A window opened, or put away. */
    open() { blip(440, 0.035, 160, 660); },
    close() { blip(660, 0.03, 160, 440); },
    /** A mark placed on the field. */
    mark() { blip(880, 0.045, 60, 700); },
    /** What the mark turned out to be: a rising pair for a mover, one steady note for a fixed source, a low soft one for nothing. */
    verdict(kind) {
      if (!ctx || !kept.on) return;
      if (kind === 'moving' || kind === 'transient') {
        blip(660, 0.035, 140);
        setTimeout(() => blip(990, 0.035, 180), 110);
      } else if (kind === 'fixed' || kind === 'saturated' || kind === 'intermittent') blip(523, 0.03, 220);
      else blip(262, 0.025, 200);
    },
    /** A step to the floor. */
    swish() { sweep(1800, 500, 0.06, 260); },
    /** The dive into a field: a swell of air. */
    dive() { sweep(300, 2200, 0.08, 620); },
    /** A faint tone from where the chosen thing is, pitched by its colour (or a plain middle tone without one). */
    tone(pos, bv = null) {
      if (!ctx || !kept.on) return;
      place(toneV, pos);
      ramp(toneV.osc.frequency, toneOfColour(bv), 0.05);
      ramp(toneV.gain.gain, 0.03, 0.25);
    },
    toneOff() { if (ctx) ramp(toneV.gain.gain, 0, 0.4); },
    /** A soft tick from where a known body is, as its path is shown. */
    tick3d(pos) {
      if (!ctx || !kept.on) return;
      nextSpatial = (nextSpatial % (spatial.length - 1)) + 1;
      const v = spatial[nextSpatial];
      place(v, pos);
      const t = now();
      v.osc.frequency.setValueAtTime(1760, t);
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(0, t);
      v.gain.gain.linearRampToValueAtTime(0.05, t + 0.004);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    },
    /** A step of the clock: a little higher toward the future. */
    step(dir) { blip(dir > 0 ? 1568 : 1319, 0.025, 50); },
    /** While the clock plays: a soft tick, faster at ×10, a touch higher toward the future. */
    clock(playing, fast, dir) {
      if (!ctx) return;
      clockState.playing = playing && kept.on;
      clockState.fast = fast;
      clockState.dir = dir;
      if (!clockState.playing) return;
      const t = now();
      if (clockState.next < t) clockState.next = t;
      // Scheduled a little ahead, so a slow frame does not stutter it.
      while (clockState.next < t + 0.1) {
        const at = clockState.next;
        clockV.filter.frequency.setValueAtTime(dir > 0 ? 2600 : 2200, at);
        clockV.gain.gain.setValueAtTime(0, at);
        clockV.gain.gain.linearRampToValueAtTime(0.04, at + 0.003);
        clockV.gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
        clockState.next += fast ? 0.09 : 0.25;
      }
    },
  };
  return api;
}

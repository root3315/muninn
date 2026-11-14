/**
 * field.js — a chosen field, unfolded around the viewer.
 *
 * In front: the field itself, the site's own instrument face (sky.js), the
 * same grid, the same paint, the same rings on known asteroids, with its
 * buttons just under it. To the left the field's card, to the right what it
 * measured (how deep one visit goes, Hunter X, the known bodies), below the
 * visits on the Earth's orbit (timeline.js), and behind the viewer the same
 * field in depth (depthview.js).
 *
 * The data come the site's way and through the site's modules: the frame
 * index (catalog.js searchFrames, answered from the baked file for these
 * fields), one frame per visit spread across the baseline (groupVisits,
 * spread), each read by byte range and resampled in a worker (stamp-worker.js),
 * scored and searched (sectors.js, huntcore.js), its depth from the detector's
 * own noise (depth.js). SkyBoT is asked straight from the browser; JPL, which
 * goes through the box, only for a visit SkyBoT could not answer. For the
 * demonstration fields the catalogue answers are read from files kept with
 * the site first (distances.js).
 */

import * as THREE from '../vendor/three.module.js';
import { t, fmt } from '../i18n.js';
import { searchFrames, groupVisits, toS3, skybotCone, knownBodies, surveySources, nearestHost } from '../catalog.js';
import { spread, VISITS_PER_BATCH } from '../visits.js';
import { TangentGrid, deltaRA } from '../wcs.js';
import { SkyView } from '../sky.js';
import { scoreSectors } from '../sectors.js';
import { searchField } from '../huntcore.js';
import { rankCandidates } from '../hunt.js';
import { stackDepth, shortfall } from '../depth.js';
import { magLimit, searchRadius, epochOfMjd, properMotion } from '../overlay.js';
import { loadWise } from '../wise.js';
import { readStamp, inPool } from './stamps.js';
import { createPanel, placePanel, readLook, FONTS, wrapText, fitText, button, roundRect } from './panel.js';
import { LAYOUT, SCREENS, screenPose, typeFor } from './layout.js';
import { createTimeline } from './timeline.js';
import { createDepthView } from './depthview.js';
import { geometricDistances, galaxiesWithRedshift, bakedAnswers } from './distances.js';
import { tv } from './strings.js';

const D2R = Math.PI / 180;
/** The texture the field is drawn into: as sharp as the screen can show at 2 m, no sharper. */
const MAIN_TEX_W = 1280;
/** The field's CSS size inside SkyView: its 12-pixel labels then stand 1.5° tall on the screen. */
const MAIN_CSS_W = 320;
const ASPECT = SCREENS.main.w / SCREENS.main.h;
/** Visits read for the headset: the site's first batch. */
const VISITS = VISITS_PER_BATCH;
const READERS = 3;
const SKYBOT_AT_ONCE = 2;
/** SkyBoT's position and SPHEREx's agree within two detector pixels for the same body. */
const SAME_BODY_ARCSEC = 12.3;
const SEASON_DAYS = 45;

/* The grid as the site cuts it: ~2.5 samples per 6.15″ detector pixel. */
const gridHeightFor = (fovDeg) => Math.min(768, Math.max(360, Math.round(((fovDeg * 3600) / 6.15) * 2.5)));

let planetHosts = null;
async function hostNear(ra, dec) {
  planetHosts ??= fetch('data/planet-hosts.json').then((r) => (r.ok ? r.json() : { hosts: [] }))
    .then((b) => b.hosts ?? []).catch(() => { planetHosts = null; return []; });
  return nearestHost(await planetHosts, ra, dec, 90);
}

const midExposure = (frame) => (frame.exptime > 0
  ? new Date((frame.mjd + frame.exptime / 2 / 86400 - 40587) * 86400000).toISOString().replace('Z', '')
  : frame.iso);

/**
 * Open `target` (an entry of targets.json, or a planet) around the viewer.
 * `env`: { scene, head (Vector3), baseYawDeg, fromDir (Vector3, the marker's
 * direction), lang, pxPerDeg (uniform), onBack, haptic }.
 */
export function openFieldVR(target, env) {
  const { scene, lang } = env;
  const ctrl = new AbortController();
  const { signal } = ctrl;
  const root = new THREE.Group();
  root.name = 'field';
  scene.add(root);
  const interactive = new Set();
  const disposers = [];

  // The band in the beam colours the chrome, as on the site.
  const band = target.band ?? 'all';
  document.documentElement.dataset.band = band;
  const look = readLook();

  const label = target.planet ? t(`planet.${target.key}`) : (target.key ? t(`preset.${target.key}`) : target.name);
  const fov = target.fov ?? 0.3;
  const { ra, dec } = target;

  const st = {
    status: 'searching', all: [], entries: [], done: 0,
    playing: false, clock: 0, mode: 'blink', more: false, hoverBtn: null,
    sectors: null, hunt: null, hunting: false, depth: null,
    bodiesFailed: new Set(), host: null, closed: false, mainDirty: true,
    depthVisit: null, wise: null, flipped: false, anim: null,
    head: env.head.clone(), yaw: env.baseYawDeg * D2R,
  };

  /* ---- two groups that stand at the head: the screens, the depth ---- */
  const screens = new THREE.Group();
  screens.name = 'screens';
  root.add(screens);

  /* ---- the field itself, through SkyView ---------------------------- */
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  const cssH = Math.round(MAIN_CSS_W / ASPECT);
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${MAIN_CSS_W}px;height:${cssH}px;overflow:hidden;pointer-events:none`;
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  const sky = new SkyView(canvas, {});
  // Sized for the screen in the room, not for a window.
  sky.resize = function resize() {
    this.cssW = MAIN_CSS_W;
    this.cssH = cssH;
    this.dpr = MAIN_TEX_W / MAIN_CSS_W;
    if (canvas.width !== MAIN_TEX_W) canvas.width = MAIN_TEX_W;
    const h = Math.round(cssH * this.dpr);
    if (canvas.height !== h) canvas.height = h;
    this.draw();
  };
  const drawSky = sky.draw.bind(sky);
  sky.draw = () => { drawSky(); st.mainDirty = true; };
  sky.overlays.catalog = false;
  sky.readTheme();
  sky.resize();
  const gh = gridHeightFor(fov);
  const gw = Math.round(gh * ASPECT);
  const grid = new TangentGrid(ra, dec, (fov * gw) / gh, gw, gh);
  sky.reset(grid);
  if (target.target) sky.target = { ...target.target, key: target.key, label };
  sky.setMode('blink');

  /* ---- the screens -------------------------------------------------- */
  const pose = (spec) => screenPose(spec, [0, 0, 0], 0);

  // The field's own texture: one per visit, made once and swapped while the
  // blink runs, so the blink sends nothing to the GPU; a live one for the
  // modes that draw two visits at once.
  const main = createPanel({ widthM: SCREENS.main.w, heightM: SCREENS.main.h, canvas, transparent: false, mipmaps: false, name: 'main' });
  const liveTex = main.mesh.material.map;
  const visitTex = new Map();
  placePanel(main, pose(SCREENS.main));
  const wipeAt = (uv) => { if (st.mode === 'wipe') { sky.wipe = Math.max(0, Math.min(1, uv.x)); sky.draw(); } };
  main.mesh.userData.hover = (uv) => { if (uv) wipeAt(uv); };
  main.mesh.userData.press = () => st.mode === 'wipe';
  main.mesh.userData.drag = wipeAt;
  screens.add(main.mesh);
  interactive.add(main.mesh);

  function showOnMain() {
    const v = sky.current;
    const indexed = st.mode === 'blink' || st.mode === 'single';
    if (!indexed || !v) {
      if (main.mesh.material.map !== liveTex) { main.mesh.material.map = liveTex; main.mesh.material.needsUpdate = true; }
      liveTex.needsUpdate = true;
      depthView?.setPlate(liveTex);
      return;
    }
    const key = `${v.canvasVersion ?? 0}|${sky.knownObjects.get(v.frame.obsId)?.length ?? -1}|${sky.render.palette}`;
    let kept = visitTex.get(v.frame.obsId);
    if (!kept || kept.key !== key) {
      const c = kept?.canvas ?? document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      c.getContext('2d').drawImage(canvas, 0, 0);
      const tex = kept?.tex ?? new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      kept = { canvas: c, tex, key };
      visitTex.set(v.frame.obsId, kept);
    }
    if (main.mesh.material.map !== kept.tex) { main.mesh.material.map = kept.tex; main.mesh.material.needsUpdate = true; }
    depthView?.setPlate(kept.tex);
  }

  // A notice over the field while it has nothing to show.
  const notice = createPanel({ widthM: 1.1, heightM: 0.24, pxPerM: 700, name: 'notice', opaque: true });
  placePanel(notice, pose({ ...SCREENS.main, dist: SCREENS.main.dist - 0.03 }));
  screens.add(notice.mesh);

  const bar = createPanel({ widthM: SCREENS.bar.w, heightM: SCREENS.bar.h, pxPerM: SCREENS.bar.pxPerM, name: 'bar', opaque: true });
  placePanel(bar, pose(SCREENS.bar));
  const card = createPanel({ widthM: SCREENS.card.w, heightM: SCREENS.card.h, pxPerM: SCREENS.card.pxPerM, name: 'card', opaque: true });
  placePanel(card, pose(SCREENS.card));
  const side = createPanel({ widthM: SCREENS.side.w, heightM: SCREENS.side.h, pxPerM: SCREENS.side.pxPerM, name: 'side', opaque: true });
  placePanel(side, pose(SCREENS.side));
  for (const p of [bar, card, side]) {
    screens.add(p.mesh);
    interactive.add(p.mesh);
    p.mesh.userData.hover = (uv) => {
      const h = uv ? p.hitAt(uv) : null;
      const id = h ? `${p.mesh.name}:${h.id}:${h.data ?? ''}` : null;
      if (id !== st.hoverBtn) {
        if (id) env.haptic?.('hover');
        st.hoverBtn = id;
        drawBar();
        drawCard();
      }
    };
    // Only what is drawn as a button can be chosen; the text cannot.
    p.mesh.userData.pick = (uv) => { const h = p.hitAt(uv); if (h) { env.haptic?.('select'); act(h.id, h.data); } };
    p.mesh.userData.pickable = (uv) => Boolean(p.hitAt(uv));
  }
  disposers.push(main, notice, bar, card, side);

  /* ---- the visits on the Earth's orbit ------------------------------ */
  const slots = () => st.entries.map((e) => ({
    frame: e.frame, status: e.status, visit: sky.visits.find((v) => v.frame === e.frame) ?? null,
  }));
  let timeline = null;
  function ensureTimeline() {
    if (timeline || !st.entries.length) return;
    timeline = createTimeline({ visits: slots(), look, lang, onPick: (i) => { env.haptic?.('select'); pickVisit(i); } });
    screens.add(timeline.object3d);
    syncRingPicks();
  }
  function syncRingPicks() {
    for (const m of [...interactive]) if (m.name === 'visits') interactive.delete(m);
    timeline?.object3d.traverse((o) => { if (o.name === 'visits') interactive.add(o); });
  }
  function refreshTimeline() {
    if (!timeline) return;
    timeline.update(slots());
    syncRingPicks();
    timeline.setCurrent(currentSlot());
  }
  function currentSlot() {
    const v = st.mode === 'wipe' || st.mode === 'difference' ? sky.visits[sky.b] : sky.visits[sky.index];
    return v ? st.entries.findIndex((e) => e.frame === v.frame) : -1;
  }

  /* ---- the field in depth, behind ------------------------------------ */
  const radiusDeg = searchRadius(grid.fovDeg, grid.fovHeightDeg);
  const depthView = createDepthView({
    head: new THREE.Vector3(0, env.head.y, 0),
    behind: new THREE.Vector3(0, 0, 1),
    look,
    pxPerDeg: env.pxPerDeg,
    field: {
      ra, dec, radiusDeg, widthDeg: grid.fovDeg, heightDeg: grid.fovHeightDeg,
      target: target.target ? { ...target.target, label } : null,
    },
  });
  // The corridor is built around the head; its holder stands on the floor under it.
  const depthHolder = new THREE.Group();
  depthHolder.add(depthView.group);
  root.add(depthHolder);

  /** Stand both groups at the head, turned to `yaw` (radians), the depth behind or, flipped, in front. */
  function stand() {
    screens.position.copy(st.head);
    screens.rotation.set(0, st.yaw + (st.flipped ? Math.PI : 0), 0);
    depthHolder.position.set(st.head.x, 0, st.head.z);
    depthHolder.rotation.set(0, st.yaw + (st.flipped ? Math.PI : 0), 0);
  }
  stand();

  // The dive: everything grows out of the marker the viewer chose.
  st.anim = { t0: performance.now(), ms: LAYOUT.dive.ms, from: env.fromDir?.clone() ?? new THREE.Vector3(0, 0, -1) };

  /* ---- what the controls do ----------------------------------------- */
  function act(id, data) {
    if (id === 'mode') setMode(data);
    else if (id === 'prev') step(-1);
    else if (id === 'next') step(1);
    else if (id === 'back') env.onBack?.();
    else if (id === 'more') { st.more = !st.more; drawBar(); }
    else if (id === 'flip') flip();
    else if (id === 'bring') env.onBring?.();
    else if (id === 'wise') showWise();
  }

  function setMode(mode) {
    if (mode !== 'wipe') sky.setUseRef(false);
    st.mode = mode;
    sky.setMode(mode);
    play(mode === 'blink');
    afterVisitChange(true);
  }

  function play(on) {
    st.playing = on && sky.visits.length > 1;
    st.clock = 0;
  }

  function step(d) {
    if (!sky.visits.length) return;
    if (st.mode === 'wipe' || st.mode === 'difference') {
      sky.setAB(null, ((sky.b + d) % sky.visits.length + sky.visits.length) % sky.visits.length);
    } else {
      if (st.mode === 'blink') { st.mode = 'single'; sky.setMode('single'); play(false); }
      sky.setIndex(sky.index + d);
    }
    afterVisitChange(true);
  }

  function pickVisit(slot) {
    const e = st.entries[slot];
    const at = e ? sky.visits.findIndex((v) => v.frame === e.frame) : -1;
    if (at < 0) return;
    if (st.mode === 'wipe' || st.mode === 'difference') {
      if (at !== sky.a) sky.setAB(null, at);
    } else {
      if (st.mode === 'blink') { st.mode = 'single'; sky.setMode('single'); play(false); }
      sky.setIndex(at);
    }
    afterVisitChange(true);
  }

  let lastShown = null;
  function afterVisitChange(force = false) {
    const v = sky.current;
    timeline?.setCurrent(currentSlot());
    if (v !== lastShown || force) {
      lastShown = v;
      drawSide();
      if (!st.playing) updateDepthBodies();
    }
    if (force) drawBar();
  }

  /** The depth view flips to the front (for a viewer who cannot turn round), and back. */
  function flip() {
    st.flipAnim = { t0: performance.now(), swapped: false };
  }

  /** The AllWISE picture of the field, fifteen years older, as B of the wipe. */
  async function showWise() {
    if (!st.wise) {
      st.wise = { state: 'asking' };
      drawSide();
      try {
        const ref = await loadWise(grid, 1, { signal });
        if (signal.aborted) return;
        sky.setReference({ stamp: ref.stamp, band: ref.band, epoch: ref.epoch });
        st.wise = { state: 'ready' };
      } catch {
        if (signal.aborted) return;
        st.wise = { state: 'failed' };
        drawSide();
        return;
      }
    }
    if (st.wise.state !== 'ready') return;
    st.mode = 'wipe';
    sky.setMode('wipe');
    sky.setUseRef(true);
    play(false);
    afterVisitChange(true);
  }

  /* ---- drawing the screens ------------------------------------------ */
  const TYPE = { bar: typeFor(SCREENS.bar), card: typeFor(SCREENS.card), side: typeFor(SCREENS.side) };

  function panelGround(ctx, W, H) {
    roundRect(ctx, 2, 2, W - 4, H - 4, 30);
    ctx.fillStyle = look.paper;
    ctx.fill();
    // A light edge, so the screen holds its shape against the sky.
    ctx.lineWidth = 3;
    ctx.strokeStyle = look.ruleStrong;
    ctx.stroke();
  }

  const hov = (p, id, data = '') => st.hoverBtn === `${p}:${id}:${data}`;

  function drawBar() {
    bar.draw((ctx, W, H, hits) => {
      roundRect(ctx, 0, 0, W, H, H / 2);
      ctx.fillStyle = look.paper;
      ctx.fill();
      const pad = 8;
      const bh = H - pad * 2;
      const y = pad;
      const font = `500 ${TYPE.bar.body}px ${FONTS.body}`;
      let x = pad;
      const chip = (id, label, w, opts = {}) => {
        button(ctx, hits, look, { x, y, w, h: bh, label, id, font, hover: hov('bar', id, opts.data ?? ''), ...opts });
        x += w + 10;
      };
      chip('mode', t('mode.blink'), 170, { data: 'blink', on: st.mode === 'blink' });
      chip('mode', t('mode.single'), 170, { data: 'single', on: st.mode === 'single' });
      chip('prev', '‹', bh * 1.2);
      chip('next', '›', bh * 1.2);
      if (st.more) {
        chip('mode', t('mode.wipe'), 150, { data: 'wipe', on: st.mode === 'wipe' && !sky.useRef });
        chip('mode', t('mode.diff'), 190, { data: 'difference', on: st.mode === 'difference' });
        if (target.target?.pmRA != null) chip('wise', tv('vr.wise'), 150, { on: st.mode === 'wipe' && sky.useRef });
        chip('more', tv('vr.less'), 140);
      } else {
        chip('more', tv('vr.more'), 140);
      }
      x = W - pad - 200;
      button(ctx, hits, look, { x, y, w: 200, h: bh, label: st.flipped ? tv('vr.screensFront') : tv('vr.depthFront'), id: 'flip', font, hover: hov('bar', 'flip') });
    });
  }

  function drawCard() {
    card.draw((ctx, W, H, hits) => {
      panelGround(ctx, W, H);
      const x = 34;
      const w = W - 68;
      const T = TYPE.card;
      // The way back, always at the top.
      button(ctx, hits, look, { x, y: 26, w: 220, h: T.body * 1.9, label: tv('vr.backSky'), id: 'back', font: `500 ${T.body}px ${FONTS.body}`, hover: hov('card', 'back') });
      button(ctx, hits, look, { x: x + 236, y: 26, w: 300, h: T.body * 1.9, label: tv('vr.bring'), id: 'bring', font: `500 ${T.body}px ${FONTS.body}`, hover: hov('card', 'bring') });
      let y = 26 + T.body * 1.9 + 30 + T.heading;
      ctx.font = `600 ${T.heading}px ${FONTS.display}`;
      ctx.fillStyle = look.ink;
      y = wrapText(ctx, label, x, y, w, T.heading * 1.15, 2) + 6;
      const why = target.why?.[lang] ?? target.why?.en ?? (target.planet ? tv('vr.planet') : '');
      if (why) {
        ctx.font = `400 ${T.body}px ${FONTS.body}`;
        ctx.fillStyle = look.muted;
        y = wrapText(ctx, why, x, y, w, T.body * 1.3, 4) + 10;
      }
      ctx.font = `500 ${T.body}px ${FONTS.mono}`;
      ctx.fillStyle = target.group === 'challenge' ? look.counter : look.accent;
      if (st.all.length) {
        const days = Math.round(st.all.at(-1).mjd - st.all[0].mjd);
        y = wrapText(ctx, tv('vr.visits', { n: st.all.length, d: days }), x, y, w, T.body * 1.3, 2);
      }
      if (st.host) {
        ctx.fillStyle = look.neutral;
        ctx.font = `400 ${T.body}px ${FONTS.body}`;
        wrapText(ctx, tv('vr.planetsValue', { n: st.host[2] }), x, y + 6, w, T.body * 1.3, 1);
      }
      ctx.font = `500 ${T.body}px ${FONTS.body}`;
      ctx.fillStyle = look.accent;
      ctx.fillText(fitText(ctx, `↻ ${tv('vr.turn')}`, w), x, H - 34);
    });
  }

  function heading(ctx, x, y, text) {
    ctx.font = `600 ${TYPE.side.heading}px ${FONTS.display}`;
    ctx.fillStyle = look.ink;
    ctx.fillText(text, x, y);
    return y + TYPE.side.heading * 0.6 + TYPE.side.body;
  }

  function drawSide() {
    side.draw((ctx, W, H) => {
      panelGround(ctx, W, H);
      const x = 34;
      const w = W - 68;
      const T = TYPE.side;
      const lh = Math.round(T.body * 1.3);
      const body = `400 ${T.body}px ${FONTS.body}`;
      let y = 34 + T.body;

      // How deep one visit goes: the key number.
      ctx.font = body;
      ctx.fillStyle = look.muted;
      ctx.fillText(tv('vr.reaches'), x, y);
      y += T.key + 8;
      const d = st.depth;
      ctx.font = `600 ${T.key}px ${FONTS.display}`;
      ctx.fillStyle = look.accent;
      const big = d ? `${fmt(d.single, 1)} AB` : '—';
      ctx.fillText(big, x, y);
      if (d) {
        const bw = ctx.measureText(big).width;
        ctx.font = `500 ${T.body}px ${FONTS.mono}`;
        ctx.fillStyle = look.neutral;
        ctx.fillText(d.band, x + bw + 16, y);
        const s = shortfall(d.single);
        y += lh + 4;
        ctx.font = body;
        ctx.fillStyle = look.muted;
        y = wrapText(ctx, s && s.magnitudes > 0 ? tv('vr.short', { gap: fmt(s.magnitudes, 1) }) : tv('vr.deep'), x, y, w, lh, 2);
      } else {
        y += lh + 4;
        ctx.font = body;
        ctx.fillStyle = look.muted;
        y = wrapText(ctx, tv('vr.depthWait'), x, y, w, lh, 2);
      }
      y += 16;

      // The AllWISE comparison, when it is on the screen.
      if (st.wise && target.target?.pmRA != null) {
        ctx.font = body;
        ctx.fillStyle = look.counter;
        const v = sky.current;
        const years = v ? epochOfMjd(v.frame.mjd) - 2010.5 : 15;
        const shift = (properMotion(target.target) ?? 0) * years;
        const say = st.wise.state === 'asking' ? tv('vr.wiseWait') : st.wise.state === 'failed' ? tv('vr.wiseFail')
          : tv('vr.wiseNote', { shift: fmt(shift, 0), years: fmt(years, 0) });
        y = wrapText(ctx, say, x, y, w, lh, 3) + 16;
      }

      // Hunter X, and what it is.
      y = heading(ctx, x, y + T.heading * 0.4, tv('vr.hunt'));
      ctx.font = body;
      ctx.fillStyle = look.ink;
      const h = st.hunt;
      const say = !h ? (st.hunting ? t('hunt.running') : tv('vr.depthWait'))
        : h.error ? t('hunt.failed', { why: h.error })
          : h.list.length ? tv('vr.huntFound', { n: h.list.length, checked: h.checked }) : tv('vr.huntNone', { checked: h.checked });
      y = wrapText(ctx, say, x, y, w, lh, 2);
      ctx.fillStyle = look.neutral;
      y = wrapText(ctx, tv('vr.huntHonest'), x, y + 4, w, lh, 5) + 14;

      // The known bodies at the visit on the screen.
      y = heading(ctx, x, y + T.heading * 0.4, tv('vr.known'));
      const v = sky.current;
      const objs = v ? sky.knownObjects.get(v.frame.obsId) : null;
      ctx.font = body;
      if (!v || (!objs && !st.bodiesFailed.has(v.frame.obsId))) {
        ctx.fillStyle = look.muted;
        wrapText(ctx, tv('vr.knownWait'), x, y, w, lh, 1);
      } else if (!objs) {
        ctx.fillStyle = look.counter;
        wrapText(ctx, tv('vr.knownFail'), x, y, w, lh, 1);
      } else if (!objs.length) {
        ctx.fillStyle = look.muted;
        wrapText(ctx, tv('vr.knownNone'), x, y, w, lh, 2);
      } else {
        for (const o of objs.slice(0, Math.max(1, Math.floor((H - y - 20) / (lh + 2))))) {
          ctx.font = `500 ${T.body}px ${FONTS.body}`;
          ctx.fillStyle = look.counter;
          ctx.fillText(fitText(ctx, o.num ? `(${o.num}) ${o.name}` : o.name, w * 0.55), x, y);
          ctx.font = `400 ${T.body}px ${FONTS.mono}`;
          ctx.fillStyle = look.muted;
          ctx.textAlign = 'right';
          ctx.fillText(Number.isFinite(o.dGeo) ? `${fmt(o.dGeo, 2)} AU` : `V ${fmt(o.mag, 1)}`, x + w, y);
          ctx.textAlign = 'left';
          y += lh + 2;
        }
      }
    });
  }

  function drawNotice() {
    const say = st.status === 'searching' ? tv('vr.searching')
      : st.status === 'reading' && !sky.visits.length ? tv('vr.reading', { done: st.done, total: st.entries.length })
        : st.status === 'none' ? tv('vr.none')
          : st.status === 'failed' ? tv('vr.searchFailed') : null;
    notice.mesh.visible = Boolean(say);
    if (!say) return;
    notice.draw((ctx, W, H) => {
      roundRect(ctx, 2, 2, W - 4, H - 4, 26);
      ctx.fillStyle = look.paper2;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = look.ruleStrong;
      ctx.stroke();
      ctx.font = `500 38px ${FONTS.body}`;
      ctx.fillStyle = st.status === 'failed' || st.status === 'none' ? look.counter : look.ink;
      ctx.textAlign = 'center';
      wrapText(ctx, say, W / 2, H / 2 - 4, W - 60, 46, 2);
    });
  }

  function drawAll() { drawBar(); drawCard(); drawSide(); drawNotice(); }
  drawAll();

  /* ---- reading the field -------------------------------------------- */
  let baked = null;
  async function load() {
    hostNear(ra, dec).then((h) => { if (!st.closed && h) { st.host = h; drawCard(); } });
    const bakedAsk = bakedAnswers(target.key, signal);
    let frames;
    try {
      ({ frames } = await searchFrames({ ra, dec }, { signal }));
    } catch {
      if (signal.aborted) return;
      st.status = 'failed';
      drawAll();
      return;
    }
    if (signal.aborted) return;
    st.all = groupVisits(frames, { ra, dec, band });
    const chosen = spread(st.all, VISITS).sort((p, q) => p.mjd - q.mjd);
    st.entries = chosen.map((frame) => ({ frame, status: 'pending' }));
    if (!chosen.length) { st.status = 'none'; drawAll(); return; }
    st.status = 'reading';
    ensureTimeline();
    drawAll();
    baked = await bakedAsk;
    askBodies(chosen);
    loadDepthData(chosen);

    await inPool(st.entries, READERS, async (entry) => {
      if (signal.aborted) return;
      entry.status = 'reading';
      try {
        const stamp = await readStamp(toS3(entry.frame.url), grid, { signal });
        if (signal.aborted) return;
        if (!stamp) { entry.status = 'dropped'; return; }
        entry.status = 'ready';
        sky.addVisit(entry.frame, stamp);
        if (sky.visits.length === 2 && st.mode === 'blink') play(true);
      } catch {
        if (!signal.aborted) entry.status = 'failed';
      } finally {
        st.done += 1;
        if (!signal.aborted) { refreshTimeline(); drawNotice(); afterVisitChange(); }
      }
    });
    if (signal.aborted) return;
    st.status = sky.visits.length ? 'ready' : 'none';
    sky.setAB(0, Math.max(0, sky.visits.length - 1));
    if (st.mode === 'blink') play(true);
    measure();
    drawAll();
    refreshTimeline();
    await hunt();
    updateDepthBodies(true);
  }

  function measure() {
    const per = [];
    const sigmas = [];
    for (const v of sky.visits) {
      if (v.sigma === undefined) v.sigma = v.stamp.sigma ?? null;
      sigmas.push(v.sigma ?? 0);
      const detector = v.stamp.meta?.detectorSigma;
      if (detector > 0) per.push({ band: v.frame.band, sigma: detector });
    }
    st.depth = per.length ? stackDepth(per) : null;
    st.sectors = sky.visits.length >= 3 ? scoreSectors(sky.visits, { sigmas }) : null;
    if (st.depth) depthView.setDepth(st.depth.single);
  }

  async function hunt() {
    if (!st.sectors) { drawSide(); return; }
    st.hunting = true;
    drawSide();
    try {
      const found = await searchField({
        sectors: st.sectors,
        visits: sky.visits.slice(),
        grid,
        track: (r, d) => sky.trackMark(r, d),
        dec,
        // A breath between candidates, so the headset keeps its frame rate.
        pause: async () => { await new Promise((r) => { setTimeout(r, 0); }); return !st.closed; },
      });
      if (found) st.hunt = { ...found, list: rankCandidates(found.all) };
    } catch (err) {
      st.hunt = { error: err.message, list: [], checked: 0 };
    }
    st.hunting = false;
    if (st.closed) return;
    drawSide();
    // Movers no catalogued body explains go on the far shell, as candidates.
    const unexplained = (st.hunt?.list ?? []).filter((c) => {
      const bodies = sky.knownObjects.get(c.obsId) ?? [];
      const cos = Math.cos(c.dec * D2R);
      return !bodies.some((b) => Math.hypot(deltaRA(b.ra, c.ra) * cos, b.dec - c.dec) * 3600 < SAME_BODY_ARCSEC);
    });
    depthView.setCandidates(unexplained);
  }

  /** SkyBoT for every planned visit, two at a time; JPL (through the box) only where SkyBoT failed. */
  async function askBodies(chosen) {
    await inPool(chosen.slice(), SKYBOT_AT_ONCE, async (frame) => {
      if (signal.aborted) return;
      let objects = baked?.bodies?.[frame.obsId] ?? null;
      if (!objects) {
        const field = { ra, dec, radiusDeg: Math.max(0.03, grid.spanDeg * 0.8), iso: midExposure(frame) };
        try {
          objects = await skybotCone(field, { signal });
        } catch {
          try { objects = await knownBodies(field, { signal }); } catch { objects = null; }
        }
      }
      if (signal.aborted) return;
      if (objects) sky.setKnownObjects(frame.obsId, objects);
      else st.bodiesFailed.add(frame.obsId);
      if (sky.current?.frame === frame) drawSide();
      if (!st.depthVisit || sky.current?.frame === frame) updateDepthBodies();
    });
  }

  /** Whether SPHEREx sees a source at (ra, dec) in the visit on the screen. */
  function detected(r, d) {
    const v = sky.current;
    if (!v) return false;
    const m = sky.measure(v, r, d, { minSnr: 5 });
    return Boolean(m && (m.saturated || m.snr >= 5));
  }

  /** The bodies in the depth view: those at the visit on the screen, with their paths over its season. */
  function updateDepthBodies(force = false) {
    let v = sky.current?.frame ?? null;
    let objs = v ? sky.knownObjects.get(v.obsId) : null;
    if (!objs) {
      // Until the visit on the screen has its answer, the visit with the most known bodies.
      let best = null;
      for (const e of st.entries) {
        const list = sky.knownObjects.get(e.frame.obsId);
        if (list && (!best || list.length > best.list.length)) best = { frame: e.frame, list };
      }
      if (best) { v = best.frame; objs = best.list; }
    }
    if (!objs || (!force && st.depthVisit === v.obsId)) return;
    st.depthVisit = v.obsId;
    const tracks = new Map();
    for (const e of st.entries) {
      if (Math.abs(e.frame.mjd - v.mjd) > SEASON_DAYS) continue;
      for (const o of sky.knownObjects.get(e.frame.obsId) ?? []) {
        if (!Number.isFinite(o.dGeo)) continue;
        if (!tracks.has(o.name)) tracks.set(o.name, []);
        tracks.get(o.name).push({ ra: o.ra, dec: o.dec, au: o.dGeo, mjd: e.frame.mjd });
      }
    }
    for (const list of tracks.values()) list.sort((a, b) => a.mjd - b.mjd);
    const shown = sky.current?.frame === v;
    depthView.setBodies(objs.map((o) => ({ ...o, seen: shown && detected(o.ra, o.dec) })), tracks);
  }

  async function loadDepthData(chosen) {
    const epoch = epochOfMjd(chosen[Math.floor(chosen.length / 2)].mjd);
    const gaiaAsk = baked?.gaia ? Promise.resolve(baked.gaia)
      : surveySources('gaia', { ra, dec, radiusDeg, limit: magLimit(grid.fovHeightDeg) }, { signal });
    const bjAsk = baked?.bj ? Promise.resolve(new Map(baked.bj.map(([id, r, lo, hi]) => [id, { r, lo, hi }])))
      : geometricDistances({ ra, dec, radiusDeg }, signal).catch(() => null);
    Promise.all([gaiaAsk, bjAsk])
      .then(([g, bj]) => { if (!signal.aborted) depthView.setGaia(g.rows, { bj, epoch, detected }); })
      .catch((err) => { if (!signal.aborted) depthView.setGaia(err instanceof Error ? err : new Error(String(err))); });
    (baked?.galaxies ? Promise.resolve(baked.galaxies) : galaxiesWithRedshift({ ra, dec, radiusDeg }, signal))
      .then((list) => { if (!signal.aborted) depthView.setGalaxies(list); })
      .catch((err) => { if (!signal.aborted) depthView.setGalaxies(err instanceof Error ? err : new Error(String(err))); });
  }

  load();

  /* ---- the open field ----------------------------------------------- */
  const blinkStep = 1 / LAYOUT.blinkHz;
  const tmp = new THREE.Vector3();
  return {
    root,
    interactive,
    label,
    /** Once a frame: the dive, the blink on the frame clock, textures only when something changed. */
    update(dt, { head, gazeYaw }) {
      const now = performance.now();
      if (st.anim) {
        const k = Math.min(1, (now - st.anim.t0) / st.anim.ms);
        const e = 1 - (1 - k) ** 3;
        // From the marker's direction, three metres out, to where everything stands.
        const s = 0.05 + 0.95 * e;
        for (const g of [screens, depthHolder]) g.scale.setScalar(s);
        tmp.copy(st.anim.from).multiplyScalar(3 * (1 - e));
        screens.position.copy(st.head).add(tmp);
        depthHolder.position.set(st.head.x + tmp.x, tmp.y, st.head.z + tmp.z);
        if (k >= 1) { st.anim = null; stand(); }
      }
      if (st.flipAnim) {
        const k = Math.min(1, (now - st.flipAnim.t0) / 250);
        const s = k < 0.5 ? 1 - k * 2 : (k - 0.5) * 2;
        if (k >= 0.5 && !st.flipAnim.swapped) { st.flipAnim.swapped = true; st.flipped = !st.flipped; stand(); drawBar(); }
        for (const g of [screens, depthHolder]) g.scale.setScalar(Math.max(0.02, s));
        if (k >= 1) { st.flipAnim = null; for (const g of [screens, depthHolder]) g.scale.setScalar(1); }
      }
      if (st.playing && !st.paused) {
        st.clock += dt;
        if (st.clock >= blinkStep) {
          st.clock -= blinkStep;
          sky.setIndex(sky.index + 1);
          afterVisitChange();
        }
      }
      if (st.mainDirty) { st.mainDirty = false; showOnMain(); }
      timeline?.tick(dt, gazeYaw - st.yaw - (st.flipped ? Math.PI : 0));
      depthView.tick(head);
    },
    step,
    toggle() { setMode(st.mode === 'blink' ? 'single' : 'blink'); },
    /** Bring the screens round to where the head points, and to where it stands. */
    bring(head, yaw) {
      st.head.copy(head);
      st.yaw = yaw;
      stand();
    },
    /** Where the main screen is, as a world direction from the head, for the way back to it. */
    mainYaw() { return st.yaw + (st.flipped ? Math.PI : 0); },
    /** Hold the blink while the headset is not being looked through. */
    pause(on) { st.paused = on; },
    get stats() {
      return { status: st.status, read: sky.visits.length, planned: st.entries.length, mode: st.mode, depth: st.depth?.single ?? null, hunt: st.hunt ? (st.hunt.list?.length ?? 0) : null, baked: Boolean(baked) };
    },
    close() {
      st.closed = true;
      ctrl.abort();
      play(false);
      sky.ro?.disconnect();
      timeline?.dispose();
      depthView.dispose();
      for (const d of disposers) d.dispose();
      for (const { tex, canvas: c } of visitTex.values()) { tex.dispose(); c.width = 0; c.height = 0; }
      visitTex.clear();
      for (const v of sky.visits) { v.canvas.width = 0; v.canvas.height = 0; }
      sky.visits = [];
      canvas.width = 0;
      canvas.height = 0;
      host.remove();
      root.removeFromParent();
      interactive.clear();
      delete document.documentElement.dataset.band;
    },
  };
}

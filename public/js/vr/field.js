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
import { seasonChunks, chunkAt, forStack } from '../stack.js';
import { searchFrames, groupVisits, bandsPresent, toS3, skybotCone, knownBodies, surveySources } from '../catalog.js';
import { planetHostNear, systemUrl } from '../exovision.js';
import { spread, VISITS_PER_BATCH } from '../visits.js';
import { TangentGrid, deltaRA } from '../wcs.js';
import { SkyView } from '../sky.js';
import { scoreSectors } from '../sectors.js';
import { searchField } from '../huntcore.js';
import { rankCandidates } from '../hunt.js';
import { stackDepth } from '../depth.js';
import { magLimit, searchRadius, epochOfMjd, properMotion } from '../overlay.js';
import { loadWise } from '../wise.js';
import { readStamp, inPool } from './stamps.js';
import { createPanel, placePanel, readLook, FONTS, wrapText, button, roundRect, chipWidth } from './panel.js';
import { LAYOUT, SCREENS, screenPose, typeFor, minTextPx } from './layout.js';
import { eclipticLatitude, PLANET_X_V, PLANET_X_MAX_BETA } from './depth3d.js';
import { createTimeline } from './timeline.js';
import { createDepthView } from './depthview.js';
import { createSpectrumPanel } from './spectrumpanel.js';
import { createMarksPanel } from './markspanel.js';
import { createWindows } from './windows.js';
import { createPagesPanel } from './pagespanel.js';
import { encodeHash } from '../hash.js';
import {
  skybotVerdict, seenAt, identifyMark, tagOf, planLink, measureLink, linkArc,
} from '../marks.js';
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
/** As many marks as the site keeps in its link. */
const MAX_MARKS = 40;
/** How long cleared marks can be taken back. */
const MARKS_UNDO_MS = 5000;
/** A breath between visits of a long measurement, so the headset keeps its frame rate. */
const breathe = () => new Promise((r) => { setTimeout(r, 0); });
/** The field sizes offered in the headset, from the site's own (hash.js FOV_CHOICES). */
const FOV_SIZES = [0.15, 0.3, 0.6];
/** The guide's five steps, by their strings' names. */
const GUIDE = ['Point', 'Field', 'Mark', 'Depth', 'Move'];
/** The site's "How to read this" cards that hold in the headset, in its order. */
const READ = ['sky', 'blink', 'modes', 'north', 'mark', 'verdicts', 'ring', 'spec', 'wise', 'depth', 'hunt', 'seasons'];
/** Remembered once the guide has been seen, so it opens by itself only the first time. */
const GUIDE_SEEN = 'muninn.vrGuide';

/* The grid as the site cuts it: ~2.5 samples per 6.15″ detector pixel. */
const gridHeightFor = (fovDeg) => Math.min(768, Math.max(360, Math.round(((fovDeg * 3600) / 6.15) * 2.5)));

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
  // The page's own band comes back when the field closes (the headset may be over the site).
  const bandBefore = document.documentElement.dataset.band;
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

  /** The answers kept with the site for a demonstration field (distances.js), once read. */
  let baked = null;

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
  // Anywhere else, a press on the field drops a mark and measures it, as on the site.
  main.mesh.userData.pick = (uv, hit) => { if (st.mode !== 'wipe' && sky.visits.length) markAt(uv, hit); };
  main.mesh.userData.pickable = () => st.mode !== 'wipe' && sky.visits.length > 0;
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
    // What is drawn over the picture is part of it: the marks, their words, the arc.
    const over = sky.marks.map((m) => `${m.ra},${m.dec},${m.tag ?? ''},${m.analysis?.kind ?? ''}`).join(';');
    const key = `${v.canvasVersion ?? 0}|${sky.knownObjects.get(v.frame.obsId)?.length ?? -1}|${sky.render.palette}|${over}|${sky.link ? sky.link.mark?.ra ?? 1 : 0}`;
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
  // It rides on the field, a little in front, wherever the field is moved.
  const notice = createPanel({ widthM: 1.1, heightM: 0.24, pxPerM: 700, name: 'notice', opaque: true });
  notice.mesh.position.set(0, 0, 0.03);
  main.mesh.add(notice.mesh);

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

  // The marks, as on the site: numbered, the newest open, every word from marks.js.
  const marksPanel = createMarksPanel({
    look, widthM: SCREENS.marks.w, heightM: SCREENS.marks.h, pxPerM: SCREENS.marks.pxPerM, dist: SCREENS.marks.dist,
    onAct: (id, i) => { env.haptic?.('select'); markAct(id, i); },
  });
  placePanel({ mesh: marksPanel.mesh }, pose(SCREENS.marks));
  marksPanel.mesh.visible = false;
  screens.add(marksPanel.mesh);
  interactive.add(marksPanel.mesh);
  disposers.push(marksPanel);

  // A mark's spectrum, beside the findings: shown when a mark's "Spectrum" is pressed.
  const spectrum = createSpectrumPanel({ look });
  placePanel({ mesh: spectrum.mesh }, pose(SCREENS.spectrum));
  screens.add(spectrum.mesh);
  interactive.add(spectrum.mesh);
  disposers.push(spectrum);

  // The guide and "How to read this", in the card's place while open.
  const pages = createPagesPanel({
    look, widthM: SCREENS.card.w, heightM: SCREENS.card.h, pxPerM: SCREENS.card.pxPerM, dist: SCREENS.card.dist,
    onClose: () => { card.mesh.visible = true; },
  });
  screens.add(pages.mesh);
  interactive.add(pages.mesh);
  disposers.push(pages);
  function showPages(title, list) {
    pages.mesh.position.copy(card.mesh.position);
    pages.mesh.quaternion.copy(card.mesh.quaternion);
    pages.mesh.scale.copy(card.mesh.scale);
    card.mesh.visible = false;
    pages.show(title, list);
  }

  /** The same field on the site: its place, size, band, mode, visit and marks, in the site's own link. */
  function siteUrl() {
    const url = new URL('./', location.href);
    const tg = target.target;
    url.hash = encodeHash({
      ra, dec, fov, band, lang, name: label, mode: st.mode, visit: sky.index, marks: sky.marks,
      pm: Number.isFinite(tg?.pmRA) && Number.isFinite(tg?.pmDE) ? [tg.pmRA, tg.pmDE] : null,
    });
    return url.href;
  }

  // Every screen can be taken by the grip and put elsewhere (windows.js).
  const windows = createWindows({ group: screens, onMoved: () => drawCard() });
  for (const m of [main.mesh, bar.mesh, card.mesh, side.mesh, marksPanel.mesh, spectrum.mesh]) windows.add(m);

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
    onAction: (id, data) => {
      if (id === 'back') env.onBack?.();
      else if (id === 'fly') env.onFly?.(data);
      else if (id === 'screens') env.onBring?.();
      else if (id === 'flip') flip();
      // The view as it was opened: where it stood, at its own size.
      else if (id === 'reset') { depthHolder.scale.setScalar(1); stand(); depthView.setScale(1); }
    },
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
  interactive.add(depthView.controls);

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
    else if (id === 'layout') { windows.reset(); drawCard(); }
    else if (id === 'planets' && st.host) env.onLeave?.(systemUrl(st.host, label, lang));
    else if (id === 'site') env.onLeave?.(siteUrl());
    else if (id === 'guide') showPages(tv('vr.guide'), GUIDE.map((k) => ({ heading: tv(`vr.guide${k}H`), text: tv(`vr.guide${k}P`) })));
    else if (id === 'read') showPages(t('about.title'), READ.map((k) => ({ heading: t(`about.${k}H`), text: t(`about.${k}P`) })));
    // Another band or another size is another field: opened again, the site's way.
    else if (id === 'band' && data !== band) env.onReopen?.({ ...target, band: data });
    else if (id === 'fov' && Number(data) !== fov) env.onReopen?.({ ...target, fov: Number(data) });
  }

  function setMode(mode) {
    if (mode !== 'wipe') sky.setUseRef(false);
    st.mode = mode;
    sky.setMode(mode);
    play(mode === 'blink');
    if (mode === 'stack') refreshStack();
    afterVisitChange(true);
  }

  /*
   * Stack: the season of the visit on the screen, in its band, added up as
   * the site adds it (stack.js): the visits nearest it in that season, those
   * not read yet read now, for the stack alone.
   */
  const stackAsked = new Set();
  function refreshStack() {
    const v = sky.current;
    if (!v || st.mode !== 'stack') return;
    const chunks = seasonChunks(groupVisits(st.frames, { ra, dec, band: v.frame.band }));
    const at = chunkAt(chunks, v.frame.mjd);
    const planned = at >= 0 ? forStack(chunks[at], v.frame) : [v.frame];
    sky.setStack(planned.map((f) => f.url));
    st.stackN = planned.length;
    const have = new Set([...sky.visits, ...sky.extra.values()].map((x) => x.frame.url));
    const missing = planned.filter((f) => !have.has(f.url) && !stackAsked.has(f.url));
    for (const f of missing) stackAsked.add(f.url);
    inPool(missing, 2, async (frame) => {
      if (signal.aborted) return;
      try {
        const stamp = await readStamp(toS3(frame.url), grid, { signal });
        if (stamp && !signal.aborted) sky.addExtra(frame, stamp);
      } catch { /* one visit fewer is still a stack */ }
      if (!signal.aborted && st.mode === 'stack') { sky.draw(); drawSide(); }
    });
    drawSide();
  }

  /** In the stack a step is a season: the first read visit of the next season each way. */
  function stackStep(d) {
    const v = sky.current;
    if (!v) return sky.index;
    const chunks = seasonChunks(groupVisits(st.frames, { ra, dec, band: v.frame.band }));
    const at = chunkAt(chunks, v.frame.mjd);
    for (let c = at + d; at >= 0 && c >= 0 && c < chunks.length; c += d) {
      const k = sky.visits.findIndex((x) => x.frame.band === v.frame.band && chunkAt(chunks, x.frame.mjd) === c);
      if (k >= 0) return k;
    }
    return sky.index;
  }

  function play(on) {
    st.playing = on && sky.visits.length > 1;
    st.clock = 0;
  }

  function step(d) {
    if (!sky.visits.length) return;
    if (st.mode === 'wipe' || st.mode === 'difference') {
      sky.setAB(null, ((sky.b + d) % sky.visits.length + sky.visits.length) % sky.visits.length);
    } else if (st.mode === 'stack') {
      sky.setIndex(stackStep(d));
      refreshStack();
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
  const slotOf = (v) => (v ? st.entries.findIndex((e) => e.frame === v.frame) : -1);
  function afterVisitChange(force = false) {
    const v = sky.current;
    timeline?.setCurrent(currentSlot());
    const comparing = st.mode === 'wipe' || st.mode === 'difference';
    timeline?.setAB(comparing ? slotOf(sky.visits[sky.a]) : -1, comparing && !sky.useRef ? slotOf(sky.visits[sky.b]) : -1);
    if (v !== lastShown || force) {
      lastShown = v;
      drawSide();
      if (!st.playing) updateDepthBodies();
    }
    if (force) drawBar();
  }

  /** The depth view flips to the front (for a viewer who cannot turn round), and back, through a short fade. */
  function flip() {
    st.flipAnim = { t0: performance.now(), swapped: false };
  }

  /**
   * A mark where the field was pressed, kept and measured as the site keeps
   * it (sky.js trackMark across every visit read), and asked about as the
   * site asks (marks.js): SkyBoT, then the star catalogues.
   */
  function markAt(uv) {
    const [gi, gj] = sky.toGrid(uv.x * sky.cssW, (1 - uv.y) * sky.cssH);
    const at = grid.indexToWorld(gi, gj);
    if (!at) return;
    const v = sky.current;
    const m = { ra: at[0], dec: at[1], obsId: v?.frame.obsId ?? null, track: [], analysis: null, known: null };
    sky.marks.push(m);
    while (sky.marks.length > MAX_MARKS) sky.marks.shift();
    // The newest mark opens; the ones before it fold to a line.
    for (const k of sky.marks) k.open = k === m;
    dropUndo();
    marksPanel.reveal();
    retrackMarks();
    // A detection in the visit on the screen is felt in the hand.
    if (v && m.track.some((p) => p.obsId === v.frame.obsId && (p.saturated || p.snr >= 5))) env.haptic?.('select');
  }

  /** Every mark measured again over the visits now read, and asked about again. */
  function retrackMarks() {
    for (const m of sky.marks) {
      const a = sky.trackMark(m.ra, m.dec);
      m.analysis = a;
      m.track = a.track;
    }
    nameMarks();
    sky.draw();
    drawMarks();
  }

  /** SkyBoT's answers so far against every mark, and the catalogues asked who the still ones are. */
  function nameMarks() {
    for (const m of sky.marks) {
      m.catalog = skybotVerdict(seenAt(m.analysis, { ra: m.ra, dec: m.dec, obsId: m.obsId }), {
        knownObjects: sky.knownObjects, failed: st.bodiesFailed, on: true,
      });
      m.known = m.catalog.state === 'match' && !m.catalog.unmatched?.length ? m.catalog.name : null;
      askWho(m);
      m.tag = tagOf(m);
    }
  }

  function askWho(m) {
    identifyMark(m, {
      loading: st.status === 'reading',
      fieldSignal: signal,
      visits: sky.visits,
      live: () => !st.closed && sky.marks.includes(m),
      onChange: () => { sky.draw(); drawMarks(); },
    });
  }

  /** The marks just cleared, kept a few seconds so the press can be taken back. */
  let undo = null;
  function dropUndo() {
    if (!undo) return;
    clearTimeout(undo.timer);
    undo = null;
  }

  function drawMarks() {
    if (st.closed) return;
    const was = marksPanel.mesh.visible;
    marksPanel.mesh.visible = sky.marks.length > 0 || Boolean(undo);
    if (!was && marksPanel.mesh.visible) windows.settle(marksPanel.mesh, st.head);
    if (marksPanel.mesh.visible) marksPanel.render({ marks: sky.marks, visits: sky.visits, undo: Boolean(undo), target: sky.target ?? null, bright: env.brightList ?? [] });
  }

  function markAct(id, i) {
    const m = sky.marks[i];
    if (id === 'fold' && m) m.open = m.open === false;
    else if (id === 'remove' && m) {
      sky.marks.splice(i, 1);
      m.whoStop?.abort();
      if (sky.link?.mark === m) sky.link = null;
      sky.draw();
    } else if (id === 'clear') {
      undo = { marks: sky.marks.splice(0), link: sky.link, timer: setTimeout(() => { undo = null; drawMarks(); }, MARKS_UNDO_MS) };
      sky.link = null;
      sky.draw();
    } else if (id === 'undo' && undo) {
      sky.marks.push(...undo.marks);
      sky.link = undo.link;
      dropUndo();
      sky.draw();
    } else if (id === 'link' && m) { linkMark(m); return; }
    else if (id === 'arc' && m?.link) { m.link.shown = !m.link.shown; showLink(m.link.shown ? m : null); }
    else if (id === 'jump' && m?.link?.loadedB) {
      const k = sky.visits.indexOf(m.link.loadedB);
      if (k >= 0) {
        m.link.shown = true;
        showLink(m);
        act('mode', 'single');
        sky.setIndex(k);
        afterVisitChange();
      }
    } else if (id === 'spectrum' && m) {
      spectrum.show({ ra: m.ra, dec: m.dec, visits: sky.visits.slice(), sky, signal });
      windows.settle(spectrum.mesh, st.head);
    }
    else if (id === 'retry' && m) {
      m.whoStop?.abort();
      m.who = null;
      askWho(m);
    }
    drawMarks();
  }

  /** One mark's arc on the field (marks.js linkArc), or none. */
  function showLink(m) {
    const arc = linkArc(m);
    if (arc) for (const other of sky.marks) if (other !== m && other.link) other.link.shown = false;
    sky.link = arc;
    sky.draw();
  }

  /**
   * Follow a mark into the next season at every trial distance from 30 to
   * 2000 AU, as the site does (marks.js planLink, measureLink): every visit
   * of both seasons up to a stack's worth is read, season A's too, since a
   * detection on the arc counts only where season A shows nothing.
   */
  async function linkMark(m) {
    if (m.link?.state === 'reading') return;
    const ref = sky.visits.find((v) => v.frame.obsId === m.obsId)?.frame ?? sky.current?.frame;
    if (!ref) return;
    const plan = planLink(seasonChunks(groupVisits(st.frames, { ra, dec, band: ref.band })), ref, sky.visits);
    if (!plan) {
      m.link = { state: 'single', band: ref.band };
      if (sky.link?.mark === m) showLink(null);
      drawMarks();
      return;
    }
    const link = { state: 'reading', band: ref.band, n: 0, total: plan.framesA.length + plan.framesB.length, shown: true };
    m.link = link;
    drawMarks();
    try {
      const [visitsA, visitsB] = await Promise.all([plan.framesA, plan.framesB].map((list) => linkStamps(list, () => {
        link.n += 1;
        if (m.link === link) drawMarks();
      })));
      if (st.closed || m.link !== link) return;
      if (!visitsA.length || !visitsB.length) throw new Error(tv('link.unread'));
      Object.assign(link, await measureLink(sky, m, visitsA, visitsB, { breathe }));
      if (st.closed || m.link !== link) return;
      link.state = 'done';
      link.loadedB = plan.loadedB ?? null;
    } catch (err) {
      if (st.closed || m.link !== link) return;
      link.state = 'failed';
      link.why = err.message;
    }
    if (link.state === 'done') showLink(m);
    else if (sky.link?.mark === m) showLink(null);
    drawMarks();
  }

  /** Pixels for a list of frames: read already, kept from an earlier read, or read now. */
  async function linkStamps(frames, onEach) {
    const out = [];
    await inPool(frames.slice(), 2, async (frame) => {
      let item = sky.visits.find((v) => v.frame.url === frame.url) ?? sky.extra.get(frame.url);
      if (!item && !signal.aborted) {
        try {
          const stamp = await readStamp(toS3(frame.url), grid, { signal });
          if (stamp && !signal.aborted) {
            sky.addExtra(frame, stamp);
            item = sky.extra.get(frame.url);
          }
        } catch { /* one visit fewer */ }
      }
      if (item) out.push(item);
      onEach();
    });
    return out.sort((x, y) => x.frame.mjd - y.frame.mjd);
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
  const SMALL = minTextPx(SCREENS.card.pxPerM, Math.hypot(SCREENS.card.dist, SCREENS.card.dy), 1.2);

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
      const rowH = Math.round(SCREENS.bar.rowH * SCREENS.bar.pxPerM);
      const pad = 8;
      const bh = rowH - pad * 2;
      const font = `500 ${TYPE.bar.body}px ${FONTS.body}`;
      const minW = LAYOUT.minChipM * SCREENS.bar.pxPerM;
      // Every chip as wide as its word needs: nothing is cut. What does not fit
      // in the first row goes to a second; the row's backing is drawn to fit.
      const size = (label) => chipWidth(ctx, font, label, bh, minW);
      const chips = [
        ['mode', t('mode.blink'), { data: 'blink', on: st.mode === 'blink' }],
        ['mode', t('mode.single'), { data: 'single', on: st.mode === 'single' }],
        ['prev', '‹', {}],
        ['next', '›', {}],
        ...(st.more ? [] : [['more', tv('vr.more'), {}]]),
        ['flip', st.flipped ? tv('vr.screensFront') : tv('vr.depthFront'), {}],
        // "More": the other modes on a second row, the band and the field's size on a third.
        ...(st.more ? [
          ['break'],
          ['mode', t('mode.wipe'), { data: 'wipe', on: st.mode === 'wipe' && !sky.useRef }],
          ['mode', t('mode.diff'), { data: 'difference', on: st.mode === 'difference' }],
          ['mode', t('mode.stack'), { data: 'stack', on: st.mode === 'stack' }],
          ...(target.target?.pmRA != null ? [['wise', tv('vr.wise'), { on: st.mode === 'wipe' && sky.useRef }]] : []),
          ['more', tv('vr.less'), {}],
          ['break'],
          ...['all', ...bandsPresent(st.frames)].map((b) => ['band', b === 'all' ? t('field.bandAll') : b, { data: b, on: band === b }]),
          ...FOV_SIZES.map((f) => ['fov', `${fmt(f * 60, 0)}′`, { data: String(f), on: Math.abs(fov - f) < 1e-6 }]),
        ] : []),
      ].map(([id, label, opts]) => ({ id, label, opts: opts ?? {}, w: id === 'break' ? 0 : size(label) }));
      const rows = [[]];
      let used = pad;
      for (const c of chips) {
        if (c.id === 'break') { if (rows.at(-1).length) rows.push([]); used = pad; continue; }
        if (used + c.w + pad > W && rows.at(-1).length) { rows.push([]); used = pad; }
        rows.at(-1).push(c);
        used += c.w + 10;
      }
      rows.forEach((row, r) => {
        const width = row.reduce((sum, c) => sum + c.w + 10, pad * 2 - 10);
        const x0 = (W - width) / 2;
        roundRect(ctx, x0, r * rowH, width, rowH, rowH / 2);
        ctx.fillStyle = look.paper;
        ctx.fill();
        let x = x0 + pad;
        for (const c of row) {
          button(ctx, hits, look, { x, y: r * rowH + pad, w: c.w, h: bh, label: c.label, id: c.id, font, hover: hov('bar', c.id, c.opts.data ?? ''), ...c.opts });
          x += c.w + 10;
        }
      });
    });
  }

  function drawCard() {
    card.draw((ctx, W, H, hits) => {
      panelGround(ctx, W, H);
      const x = 34;
      const w = W - 68;
      const T = TYPE.card;
      const font = `500 ${T.body}px ${FONTS.body}`;
      const bh = T.body * 1.9;
      const minW = LAYOUT.minChipM * SCREENS.card.pxPerM;
      // The way back, always at the top, and the way to bring the screens round.
      const backW = chipWidth(ctx, font, tv('vr.backSky'), bh, minW);
      button(ctx, hits, look, { x, y: 26, w: backW, h: bh, label: tv('vr.backSky'), id: 'back', font, hover: hov('card', 'back') });
      const bringW = Math.min(w - backW - 16, chipWidth(ctx, font, tv('vr.bring'), bh, minW));
      button(ctx, hits, look, { x: x + backW + 16, y: 26, w: bringW, h: bh, label: tv('vr.bring'), id: 'bring', font, hover: hov('card', 'bring') });
      // Once a screen has been moved, the way to put them all back.
      let top = 26 + bh;
      if (windows.moved) {
        const resetW = Math.min(w, chipWidth(ctx, font, tv('vr.resetLayout'), bh, minW));
        button(ctx, hits, look, { x, y: top + 14, w: resetW, h: bh, label: tv('vr.resetLayout'), id: 'layout', font, hover: hov('card', 'layout') });
        top += 14 + bh;
      }
      // What the controller's buttons do, under the buttons that do the same by hand.
      ctx.font = `400 ${SMALL}px ${FONTS.mono}`;
      ctx.fillStyle = look.neutral;
      // Its own row, clear of the buttons above and the name below.
      let y = top + 40 + SMALL;
      y = wrapText(ctx, tv('vr.returnHint'), x, y, w, SMALL * 1.3, 2) - SMALL * 1.3 + 30 + T.heading;
      ctx.font = `600 ${T.heading}px ${FONTS.display}`;
      ctx.fillStyle = look.ink;
      y = wrapText(ctx, label, x, y, w, T.heading * 1.15, 3) + 6;
      const why = target.why?.[lang] ?? target.why?.en ?? (target.planet ? tv('vr.planet') : '');
      if (why) {
        ctx.font = `400 ${T.body}px ${FONTS.body}`;
        ctx.fillStyle = look.muted;
        y = wrapText(ctx, why, x, y, w, T.body * 1.3, 8) + 10;
      }
      ctx.font = `500 ${T.body}px ${FONTS.mono}`;
      ctx.fillStyle = target.group === 'challenge' ? look.counter : look.accent;
      if (st.all.length) {
        const days = Math.round(st.all.at(-1).mjd - st.all[0].mjd);
        y = wrapText(ctx, tv('vr.visits', { n: st.all.length, d: days }), x, y, w, T.body * 1.3, 2);
      }
      // The way on: the guide, the site's "How to read this", the same field on
      // the site, and a host's planets in ExoVision; the headset is left first.
      const ways = [
        ['guide', tv('vr.guide')],
        ['read', t('about.title')],
        ['site', `${tv('vr.onSite')} →`],
        ...(st.host ? [['planets', `${t('card.planets', { n: st.host[2] })} →`]] : []),
      ];
      let bx = x;
      let by = y + 14;
      for (const [id, words] of ways) {
        const bw = Math.min(w, chipWidth(ctx, font, words, bh, minW));
        if (bx > x && bx + bw > x + w) { bx = x; by += bh + 12; }
        button(ctx, hits, look, { x: bx, y: by, w: bw, h: bh, label: words, id, font, hover: hov('card', id) });
        bx += bw + 12;
      }
      ctx.font = `500 ${T.body}px ${FONTS.body}`;
      ctx.fillStyle = look.accent;
      wrapText(ctx, `↻ ${tv('vr.turn')}`, x, H - 34 - T.body * 1.3, w, T.body * 1.3, 2);
    });
  }

  function heading(ctx, x, y, text) {
    ctx.font = `600 ${TYPE.side.heading}px ${FONTS.display}`;
    ctx.fillStyle = look.ink;
    ctx.fillText(text, x, y);
    return y + TYPE.side.heading * 0.6 + TYPE.side.body;
  }

  /** "Frames: 5 of 10", and a bar in the band's hue. */
  function framesRead(ctx, x, y, w, lh) {
    const T = TYPE.side;
    ctx.font = `500 ${T.body}px ${FONTS.mono}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = look.muted;
    const total = st.entries.length;
    y = wrapText(ctx, total ? tv('vr.framesRead', { done: st.done, total }) : tv('vr.searching'), x, y, w, lh, 3) - lh;
    const by = y + 16;
    roundRect(ctx, x, by, w, 12, 6);
    ctx.fillStyle = look.paper3;
    ctx.fill();
    if (total) {
      roundRect(ctx, x, by, Math.max(12, (w * st.done) / total), 12, 6);
      ctx.fillStyle = look.accent;
      ctx.fill();
    }
    return by + 12 + lh;
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
      const reading = st.status === 'searching' || st.status === 'reading';

      // How deep one visit goes: the key number, measured here or, for a
      // demonstration field, as measured when its answers were kept.
      const d = st.depth ?? (baked?.depth ? { ...baked.depth, baked: true } : null);
      ctx.font = body;
      ctx.fillStyle = look.muted;
      y = wrapText(ctx, d?.baked ? tv('vr.reachesBaked', { date: baked.made }) : tv('vr.reaches'), x, y, w, lh, 3) - lh + 14;
      if (d) {
        y += T.key;
        ctx.font = `600 ${T.key}px ${FONTS.display}`;
        ctx.fillStyle = look.accent;
        const big = `${fmt(d.single, 1)} AB`;
        ctx.fillText(big, x, y);
        const bw = ctx.measureText(big).width;
        ctx.font = `500 ${T.body}px ${FONTS.mono}`;
        ctx.fillStyle = look.neutral;
        ctx.fillText(d.band, x + bw + 16, y);
        y += lh + 4;
        ctx.font = body;
        ctx.fillStyle = look.muted;
        const beta = eclipticLatitude(ra, dec);
        const say = Math.abs(beta) > PLANET_X_MAX_BETA
          ? tv('vr.cannotX', { beta: `${beta >= 0 ? '+' : '−'}${fmt(Math.abs(beta), 0)}` })
          : tv('vr.shortX', { bright: fmt(PLANET_X_V.bright, 1), faint: fmt(PLANET_X_V.faint, 1), nominal: fmt(PLANET_X_V.nominal, 1), a: fmt(PLANET_X_V.bright - d.single, 1), b: fmt(PLANET_X_V.faint - d.single, 1) });
        y = wrapText(ctx, say, x, y, w, lh, 3);
        if (reading) y = framesRead(ctx, x, y + 6, w, lh);
      } else if (reading) {
        y = framesRead(ctx, x, y + lh + 6, w, lh);
      } else {
        y += T.body;
        ctx.font = body;
        ctx.fillStyle = look.muted;
        y = wrapText(ctx, tv('vr.depthNone'), x, y, w, lh, 2);
      }
      y += 12;

      // The stack: how many visits of the season are added.
      if (st.mode === 'stack') {
        ctx.font = body;
        ctx.fillStyle = look.accent;
        const v = sky.current;
        const n = sky.stackMembers().length;
        y = wrapText(ctx, t('mode.stackHintNoDepth', { n, band: v?.frame.band ?? '' }), x, y, w, lh, 4) + 12;
      }

      // The AllWISE comparison, when it is on the screen.
      if (st.wise && target.target?.pmRA != null) {
        ctx.font = body;
        ctx.fillStyle = look.counter;
        const v = sky.current;
        const years = v ? epochOfMjd(v.frame.mjd) - 2010.5 : 15;
        const shift = (properMotion(target.target) ?? 0) * years;
        const ref = /^Gaia DR3/.test(target.target.ref ?? '') ? 'Gaia DR3' : (target.target.ref ?? '');
        const at = v ? sky.measure(v, sky.target?.ra ?? ra, sky.target?.dec ?? dec) : null;
        const say = st.wise.state === 'asking' ? tv('vr.wiseWait') : st.wise.state === 'failed' ? tv('vr.wiseFail')
          : `${tv('vr.wiseNote', { shift: fmt(shift, 0), years: fmt(years, 0), ref })}${at?.saturated ? ` ${tv('vr.wiseSat')}` : ''}`;
        y = wrapText(ctx, say, x, y, w, lh, 4) + 12;
      }

      // The known bodies at the visit on the screen.
      y = heading(ctx, x, y + T.heading * 0.4, tv('vr.known'));
      const v = sky.current;
      const objs = v ? sky.knownObjects.get(v.frame.obsId) : null;
      ctx.font = body;
      if (!v || (!objs && !st.bodiesFailed.has(v.frame.obsId))) {
        ctx.fillStyle = look.muted;
        y = wrapText(ctx, tv('vr.knownWait'), x, y, w, lh, 2);
      } else if (!objs) {
        ctx.fillStyle = look.counter;
        y = wrapText(ctx, tv('vr.knownFail'), x, y, w, lh, 2);
      } else if (!objs.length) {
        ctx.fillStyle = look.muted;
        y = wrapText(ctx, tv('vr.knownNone'), x, y, w, lh, 3);
      } else {
        // Each name whole; its distance beside it if there is room, under it if not.
        for (const o of objs) {
          if (y > H * 0.62) break;
          const name = o.num ? `(${o.num}) ${o.name}` : o.name;
          const far = Number.isFinite(o.dGeo) ? `${fmt(o.dGeo, 2)} AU` : `V ${fmt(o.mag, 1)}`;
          ctx.font = `400 ${T.body}px ${FONTS.mono}`;
          const farW = ctx.measureText(far).width;
          ctx.font = `500 ${T.body}px ${FONTS.body}`;
          const nameW = ctx.measureText(name).width;
          ctx.fillStyle = look.counter;
          ctx.fillText(name, x, y);
          if (nameW + farW + 20 > w) y += lh;
          ctx.font = `400 ${T.body}px ${FONTS.mono}`;
          ctx.fillStyle = look.muted;
          ctx.textAlign = 'right';
          ctx.fillText(far, x + w, y);
          ctx.textAlign = 'left';
          y += lh + 2;
        }
      }
      y += 12;

      // Hunter X, and what it is.
      y = heading(ctx, x, y + T.heading * 0.4, tv('vr.hunt'));
      ctx.font = body;
      ctx.fillStyle = look.ink;
      const h = st.hunt;
      const say = h?.error ? t('hunt.failed', { why: h.error })
        : h ? (h.list.length ? tv('vr.huntFound', { n: h.list.length, checked: h.checked }) : tv('vr.huntNone', { checked: h.checked }))
          : st.hunting ? t('hunt.running')
            : sky.visits.length < 3 ? (reading ? tv('vr.huntStarts') : tv('vr.tooFew', { n: sky.visits.length }))
              : t('hunt.running');
      y = wrapText(ctx, say, x, y, w, lh, 2);
      ctx.fillStyle = look.neutral;
      y = wrapText(ctx, tv('vr.huntHonest'), x, y + 4, w, lh, 5) + 12;
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
  // The first field ever opened in the headset starts with the guide.
  try {
    if (!localStorage.getItem(GUIDE_SEEN)) {
      localStorage.setItem(GUIDE_SEEN, '1');
      act('guide');
    }
  } catch { /* storage refused: no guide by itself */ }

  /* ---- reading the field -------------------------------------------- */
  async function load() {
    // A field is centred where its target is best seen: the target's own position is the one to look up, as on the site.
    planetHostNear(target.target?.ra ?? ra, target.target?.dec ?? dec).then((h) => { if (!st.closed && h) { st.host = h; drawCard(); } });
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
    st.frames = frames;
    st.all = groupVisits(frames, { ra, dec, band });
    const chosen = spread(st.all, VISITS).sort((p, q) => p.mjd - q.mjd);
    st.entries = chosen.map((frame) => ({ frame, status: 'pending' }));
    if (!chosen.length) { st.status = 'none'; drawAll(); return; }
    st.status = 'reading';
    ensureTimeline();
    drawAll();
    baked = await bakedAsk;
    if (baked?.depth && !st.depth) { depthView.setDepth(baked.depth.single); drawSide(); }
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
        if (sky.visits.length === 3) { measure(); hunt(); }
        if (sky.marks.length && sky.visits.length >= 3) retrackMarks();
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
    if (sky.marks.length) retrackMarks();
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
    // One search at a time; one asked for meanwhile runs when it ends, on the visits then in.
    if (st.hunting) { st.huntAgain = true; return; }
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
    if (st.huntAgain) { st.huntAgain = false; measure(); hunt(); return; }
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
      if (sky.marks.length) { nameMarks(); sky.draw(); drawMarks(); }
      if (sky.current?.frame === frame) drawSide();
      updateDepthBodies();
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
  /**
   * Every known body of the field in the depth view: each named body once,
   * where it was at the answered visit nearest the one on the screen, with
   * its path over that visit's season.
   */
  function updateDepthBodies(force = false) {
    const answered = st.entries.filter((e) => sky.knownObjects.has(e.frame.obsId));
    const at = sky.current?.frame ?? null;
    const key = `${at?.obsId ?? ''}|${answered.length}|${st.bodiesFailed.size}`;
    if (!answered.length || (!force && st.depthVisit === key)) {
      if (!answered.length && st.entries.length && st.bodiesFailed.size >= st.entries.length) depthView.setBodies([], new Map(), { failed: true });
      return;
    }
    st.depthVisit = key;
    const refMjd = at?.mjd ?? answered[Math.floor(answered.length / 2)].frame.mjd;
    const byName = new Map();
    for (const e of answered) {
      for (const o of sky.knownObjects.get(e.frame.obsId) ?? []) {
        if (!Number.isFinite(o.dGeo)) continue;
        if (!byName.has(o.name)) byName.set(o.name, []);
        byName.get(o.name).push({ o, frame: e.frame });
      }
    }
    const bodies = [];
    const tracks = new Map();
    for (const [name, list] of byName) {
      list.sort((p, q) => Math.abs(p.frame.mjd - refMjd) - Math.abs(q.frame.mjd - refMjd));
      const { o, frame } = list[0];
      const onScreen = at && frame.obsId === at.obsId;
      bodies.push({ ...o, mjd: frame.mjd, seen: Boolean(onScreen) && detected(o.ra, o.dec) });
      const season = list.filter((p) => Math.abs(p.frame.mjd - frame.mjd) <= SEASON_DAYS)
        .map((p) => ({ ra: p.o.ra, dec: p.o.dec, au: p.o.dGeo, mjd: p.frame.mjd }))
        .sort((p, q) => p.mjd - q.mjd);
      tracks.set(name, season);
    }
    depthView.setBodies(bodies, tracks);
  }

  async function loadDepthData(chosen) {
    const epoch = epochOfMjd(chosen[Math.floor(chosen.length / 2)].mjd);
    const gaiaAsk = baked?.gaia ? Promise.resolve(baked.gaia)
      : surveySources('gaia', { ra, dec, radiusDeg, limit: magLimit(grid.fovHeightDeg) }, { signal });
    const bjAsk = baked?.bj ? Promise.resolve(new Map(baked.bj.map(([id, r, lo, hi]) => [id, { r, lo, hi }])))
      : geometricDistances({ ra, dec, radiusDeg }, signal).catch(() => null);
    Promise.all([gaiaAsk, bjAsk])
      .then(([g, bj]) => { if (!signal.aborted) depthView.setGaia(g.rows, { bj, epoch, detected, limit: g.reached }); })
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
      // The asking dot pulses: a redraw a few times a second, not every frame.
      if (marksPanel.animated && now - (st.marksBeat ?? 0) > 120) { st.marksBeat = now; drawMarks(); }
      if (st.anim) {
        const k = Math.min(1, (now - st.anim.t0) / st.anim.ms);
        const e = 1 - (1 - k) ** 3;
        // From the marker's direction, a little way out, to where everything stands.
        const s = 0.05 + 0.95 * e;
        for (const g of [screens, depthHolder]) g.scale.setScalar(s);
        tmp.copy(st.anim.from).multiplyScalar(LAYOUT.dive.fromM * (1 - e));
        screens.position.copy(st.head).add(tmp);
        depthHolder.position.set(st.head.x + tmp.x, tmp.y, st.head.z + tmp.z);
        if (k >= 1) { st.anim = null; stand(); }
      }
      // The flip: the view fades to dark, the two swap, and it fades back (main.js draws the veil).
      if (st.flipAnim) {
        const k = Math.min(1, (now - st.flipAnim.t0) / 200);
        st.veil = k < 0.5 ? k * 2 : 2 - k * 2;
        if (k >= 0.5 && !st.flipAnim.swapped) { st.flipAnim.swapped = true; st.flipped = !st.flipped; stand(); drawBar(); env.onFlipped?.(st.flipped); }
        if (k >= 1) { st.flipAnim = null; st.veil = 0; }
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
    /** The node the field in depth hangs from, for grabbing and scaling it. */
    get depthNode() { return depthHolder; },
    /** The picture on the field's screen now, for the sky to show at the field's place. */
    get picture() { return main.mesh.material.map; },
    /** The depth scene was scaled by hand: the controls say what a metre is now. */
    depthScaled(s) { depthView.setScale(s); },
    /** What in the field's depth a world ray points at: { card, at, distance } or null. */
    depthPick(origin, dir) { return depthView.pick(origin, dir); },
    /** How dark the view should be (0–1): only during a flip. */
    get veil() { return st.veil ?? 0; },
    /** The world direction of the corridor's axis, for dimming the sky's markers along it. */
    depthAxis() {
      const yaw = st.yaw + (st.flipped ? 0 : Math.PI) + LAYOUT.depth.axisYawDeg * D2R;
      const p = LAYOUT.depth.axisPitchDeg * D2R;
      return new THREE.Vector3(-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p));
    },
    step,
    toggle() { setMode(st.mode === 'blink' ? 'single' : 'blink'); },
    /** Bring the screens round to where the head points, and to where it stands. */
    bring(head, yaw) {
      st.head.copy(head);
      st.yaw = yaw;
      stand();
    },
    /** The screens in front again: the depth view turned back behind, at its own size. */
    resetView() {
      st.flipped = false;
      st.flipAnim = null;
      st.veil = 0;
      depthHolder.scale.setScalar(1);
      depthView.setScale(1);
      stand();
      drawBar();
    },
    get flipped() { return st.flipped; },
    /** "Depth ↻", from outside (the bar has the same). */
    flipView() { flip(); },
    /** Where the main screen is, as a world direction from the head, for the way back to it. */
    mainYaw() { return st.yaw + (st.flipped ? Math.PI : 0); },
    /** Hold the blink while the headset is not being looked through. */
    pause(on) { st.paused = on; },
    /** For the checks: press the field at a texture point, list the marks, press a mark's button. */
    markAt: (u, v) => markAt({ x: u, y: v }),
    /** The screens as windows, for the hands to take (windows.js). */
    windows,
    /** Every panel standing round the viewer now, for a card to keep off. */
    panels: () => [...windows.list, pages.mesh, ...depthView.panels].filter((m) => m.visible),
    get marks() { return sky.marks; },
    markAct: (id, i) => markAct(id, i),
    /** For the checks: how bright the field’s screen is around a texture point (0–255, a 121 × 121 mean). */
    shade(u, v) {
      showOnMain();
      const img = main.mesh.material.map.image;
      const ctx = img.getContext('2d');
      const x = Math.round(u * img.width);
      const y = Math.round((1 - v) * img.height);
      const d = ctx.getImageData(x - 60, y - 60, 121, 121).data;
      let s = 0;
      for (let k = 0; k < d.length; k += 4) s += Math.max(d[k], d[k + 1], d[k + 2]);
      return s / (d.length / 4);
    },
    depthPlace: (kind, i) => depthView.placeOf(kind, i),
    clockTo: (years, play) => depthView.clockTo(years, play),
    depthFilter: (kind, on) => depthView.filter(kind, on),
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
      if (bandBefore) document.documentElement.dataset.band = bandBefore;
      else delete document.documentElement.dataset.band;
    },
  };
}

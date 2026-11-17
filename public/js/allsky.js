/**
 * allsky.js — the whole-sky page: the SPHEREx DR1 cube to turn, zoom and read
 * by wavelength, and a way from any point of it into the tool's own frames.
 *
 * It opens inside the sphere, facing where the front page faces, at the
 * front page's width. A link with map=1 opens on the whole sky at once, the
 * Mollweide map; a click on the map goes in at that point.
 *
 * The page keeps its place in the address — #ra=…&dec=…&fov=…&view=…, and
 * map=1 on the map — so a link opens the same sky. `view` is `colour` or a
 * frame number of the cube.
 */

import { setLanguage, getLanguage, t, applyTranslations, fmt } from './i18n.js';
import { parseCoordinates, resolveSesame, formatRA, formatDec } from './catalog.js';
import { encodeHash } from './hash.js';
import { openInTool, embedded, goTo } from './embed.js';
import { createSkyView, FOV_MIN, FOV_MAX } from './allsky/view.js';
import { galacticOf } from './allsky/maps.js';
import {
  FRAMES, WAVELENGTHS, COLOUR_FRAMES, HIPS_BASE, bandOf, channelOf, bandFrame,
} from './allsky/hips.js';
import { DEEP_GAPS, CORE_STAR_COUNT } from './allsky/fills.js';

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const touch = matchMedia('(pointer: coarse)').matches;
const narrow = matchMedia('(max-width: 640px)');

/** Where the sphere opens when nothing says otherwise: where the front page's sky does. */
const OPENING = { ra: 266, dec: -12, fov: 78 };
/** The field a click on the map goes in to. */
const DIVE_FOV = 40;
/** The field the tool opens with, degrees. */
const TOOL_FOV = 0.3;

/* ---- language ---------------------------------------------------------- */

function pickLanguage() {
  const asked = new URLSearchParams(location.search).get('lang');
  let saved = null;
  try { saved = localStorage.getItem('muninn.lang'); } catch { /* private window */ }
  return asked ?? saved ?? (navigator.language?.startsWith('ru') ? 'ru' : 'en');
}

setLanguage(pickLanguage());

/* ---- state in the address ---------------------------------------------- */

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const num = (k) => (p.has(k) ? Number(p.get(k)) : NaN);
  const ra = num('ra');
  const dec = num('dec');
  const fov = num('fov');
  const view = p.get('view');
  const frame = Number(view);
  const placed = Number.isFinite(ra) && Number.isFinite(dec) && Math.abs(dec) <= 90;
  return {
    ra: placed ? ra : OPENING.ra,
    dec: placed ? dec : OPENING.dec,
    fov: Number.isFinite(fov) ? Math.min(FOV_MAX, Math.max(FOV_MIN, fov)) : OPENING.fov,
    view: view !== null && view !== 'colour' && FRAMES.includes(frame) ? frame : 'colour',
    map: p.get('map') === '1' ? 1 : 0,
  };
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    if (!view) return;
    const s = view.state;
    const p = new URLSearchParams({ ra: s.ra.toFixed(4), dec: s.dec.toFixed(4), fov: s.fov.toPrecision(3), view: String(current) });
    if (s.map >= 0.5) p.set('map', '1');
    history.replaceState(null, '', `#${p}`);
  }, 250);
}

/* ---- the view ---------------------------------------------------------- */

const canvas = $('canvas');
const style = getComputedStyle(document.documentElement);
const ramp = style.getPropertyValue('--cmap-deep').split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
const view = createSkyView(canvas, {
  ramp,
  // The grid barely there; the ecliptic in the page's amber.
  ink: { grid: [0.86, 0.88, 1, 0.14], ecliptic: [1, 0.76, 0.42, 0.7] },
  // The site's relay keeps the cube's tiles on disk; IRSA has slow spells.
  relay: (url) => url.replace(`${HIPS_BASE}/`, 'api/hips/'),
  onChange: afterDraw,
});

if (!view) {
  $('nogl').hidden = false;
  $('hint').hidden = true;
}

const start = readHash();
/** `colour`, or the frame on screen. */
let current = start.view;
const inMap = () => (view?.state.map ?? 0) >= 0.5;

/* ---- wavelength -------------------------------------------------------- */

const lambda = $('lambda');
lambda.max = String(FRAMES.length - 1);
const um = (w) => fmt(w, 2);

function sayFrame(frame) {
  return t('allsky.lambdaValue', { w: um(WAVELENGTHS[frame]), band: `D${bandOf(frame)}`, ch: channelOf(frame) });
}

/** Chips, slider and words for the view in `current`, without touching the sky. */
function showControls() {
  const colour = current === 'colour';
  const frame = colour ? COLOUR_FRAMES[1] : current;
  const band = bandOf(frame);
  // The colour view wears the front page's own chrome; a single band, its band's hue.
  if (colour) delete document.documentElement.dataset.band;
  else document.documentElement.dataset.band = `D${band}`;
  for (const input of document.querySelectorAll('input[name="view"]')) {
    input.checked = colour ? input.value === 'colour' : Number(input.value) === band;
  }
  lambda.value = String(FRAMES.indexOf(frame));
  lambda.closest('.as-dock__row').dataset.colour = String(colour);
  $('lambda-value').textContent = colour
    ? t('allsky.colourNote', { b: um(WAVELENGTHS[COLOUR_FRAMES[2]]), g: um(WAVELENGTHS[COLOUR_FRAMES[1]]), r: um(WAVELENGTHS[COLOUR_FRAMES[0]]) })
    : sayFrame(frame);
  lambda.setAttribute('aria-valuetext', $('lambda-value').textContent);
}

function showView() {
  showControls();
  view?.setFrames(current === 'colour' ? COLOUR_FRAMES : [current]);
  writeHash();
}

let lambdaTimer = 0;
lambda.addEventListener('input', () => {
  current = FRAMES[Number(lambda.value)];
  // The words follow the slider at once; the sky once the hand rests, so a
  // sweep across the range does not ask IRSA for every frame on the way.
  showControls();
  clearTimeout(lambdaTimer);
  lambdaTimer = setTimeout(showView, 200);
});

$('bands').addEventListener('change', (e) => {
  const v = e.target.value;
  current = v === 'colour' ? 'colour' : bandFrame(Number(v));
  showView();
});

$('grid').addEventListener('change', (e) => view?.setGrid(e.target.checked));

/* ---- moving about ------------------------------------------------------ */

let motion = 0;
/** Stop whatever is moving the view: an animation, a fling still coasting, a wheel still gliding. */
function stopMotion() {
  cancelAnimationFrame(motion);
  motion = 0;
  cancelAnimationFrame(coast);
  coast = 0;
  cancelAnimationFrame(zoomLoop);
  zoomLoop = 0;
  pendingZoom = 0;
}

/** Animate from the view now to `to` (any of ra, dec, fov, map) over `ms`. */
function animate(to, ms = 1300, { arc = true } = {}) {
  stopMotion();
  const from = view.state;
  const goal = { ...from, ...to };
  if (reduceMotion) {
    view.set(goal);
    writeHash();
    return;
  }
  let dra = goal.ra - from.ra;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  const t0 = performance.now();
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  // Out wide and back in on a long trip, so the eye sees where on the sky it went.
  const trip = Math.abs(dra) * Math.cos((from.dec * Math.PI) / 180) + Math.abs(goal.dec - from.dec);
  const wide = arc ? Math.min(FOV_MAX, Math.max(from.fov, goal.fov, trip * 0.9)) : 0;
  const step = (now) => {
    const x = Math.min(1, (now - t0) / ms);
    const e = ease(x);
    const logFov = Math.log(from.fov) * (1 - e) + Math.log(goal.fov) * e;
    const lift = wide ? (Math.log(wide) - logFov) * Math.sin(Math.PI * x) * 0.7 : 0;
    view.set({
      ra: from.ra + dra * e,
      dec: from.dec + (goal.dec - from.dec) * e,
      fov: Math.exp(logFov + Math.max(0, lift)),
      map: from.map + (goal.map - from.map) * e,
    });
    if (x < 1) {
      motion = requestAnimationFrame(step);
    } else {
      motion = 0;
      writeHash();
    }
  };
  motion = requestAnimationFrame(step);
}

/** From the map into the sphere at a point. */
function dive(at, fov = DIVE_FOV) {
  // The sphere is set to the point while the map is still in front of it, so
  // what comes through the map as it fades is the place that was chosen.
  view.set({ ra: at.ra, dec: at.dec, fov: Math.min(FOV_MAX, fov * 2.5) });
  animate({ ra: at.ra, dec: at.dec, fov, map: 0 }, 1100, { arc: false });
}

/** Zoom by a factor, keeping the sky under (px, py) where it is. */
function zoomAt(factor, px, py) {
  if (inMap()) return;
  const s = view.state;
  // Opened from the front page and zoomed out past its widest: back to it.
  if (embedded && factor > 1 && s.fov >= FOV_MAX - 1e-6) {
    goTo('sky', { ra: s.ra, dec: s.dec });
    return;
  }
  const before = view.skyAt(px, py);
  view.set({ fov: s.fov * factor });
  const after = view.skyAt(px, py);
  let dra = before.ra - after.ra;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  const now = view.state;
  view.set({ ra: now.ra + dra, dec: now.dec + (before.dec - after.dec) });
  writeHash();
}

/* The wheel: each notch adds to a zoom still to be made, and a little of it
   is made every frame, so a spin of the wheel glides instead of jumping. */
let pendingZoom = 0;
let zoomAnchor = [0, 0];
let zoomLoop = 0;
function glideZoom() {
  if (inMap()) {
    pendingZoom = 0;
    zoomLoop = 0;
    return;
  }
  const part = Math.abs(pendingZoom) < 0.002 ? pendingZoom : pendingZoom * 0.22;
  pendingZoom -= part;
  zoomAt(Math.exp(part), ...zoomAnchor);
  zoomLoop = pendingZoom !== 0 ? requestAnimationFrame(glideZoom) : 0;
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!view) return;
  hideHint();
  if (inMap()) {
    const at = view.skyAt(e.offsetX, e.offsetY);
    if (e.deltaY < 0 && at && !motion) dive(at);
    return;
  }
  if (motion) return;
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
  pendingZoom += (e.deltaY * unit) / 400;
  zoomAnchor = [e.offsetX, e.offsetY];
  if (!zoomLoop) zoomLoop = requestAnimationFrame(glideZoom);
}, { passive: false });

/* Dragging: the point under the finger stays under it, and a flick carries
   on and slows, as a globe does. */
const pointers = new Map();
let dragged = false;
let pinchFrom = 0;
let velocity = { ra: 0, dec: 0, at: 0 };
let coast = 0;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  dragged = false;
  velocity = { ra: 0, dec: 0, at: performance.now() };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchFrom = Math.hypot(a.x - b.x, a.y - b.y);
  }
  stopMotion();
  hideHint();
});

canvas.addEventListener('pointermove', (e) => {
  showRead(e.offsetX, e.offsetY);
  const last = pointers.get(e.pointerId);
  if (!last || !view) return;
  const now = { x: e.offsetX, y: e.offsetY };
  if (Math.hypot(now.x - last.x, now.y - last.y) > 3) dragged = true;
  if (inMap()) return;
  if (pointers.size === 2) {
    pointers.set(e.pointerId, now);
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchFrom > 0 && d > 0) zoomAt(pinchFrom / d, (a.x + b.x) / 2, (a.y + b.y) / 2);
    pinchFrom = d;
    dragged = true;
    return;
  }
  const before = view.skyAt(last.x, last.y);
  const after = view.skyAt(now.x, now.y);
  let dra = before.ra - after.ra;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  const ddec = before.dec - after.dec;
  const s = view.state;
  view.set({ ra: s.ra + dra, dec: s.dec + ddec });
  const t = performance.now();
  const dt = Math.max(1, t - velocity.at);
  // Smoothed, so one jittery sample does not throw the sky.
  velocity = { ra: velocity.ra * 0.6 + (dra / dt) * 0.4, dec: velocity.dec * 0.6 + (ddec / dt) * 0.4, at: t };
  pointers.set(e.pointerId, now);
  writeHash();
});

function release(e) {
  const wasDrag = dragged && pointers.size === 1;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchFrom = 0;
  if (!view) return;
  if (inMap()) {
    if (!dragged && e.type === 'pointerup') {
      const at = view.skyAt(e.offsetX, e.offsetY);
      if (at) dive(at);
    }
    return;
  }
  if (!wasDrag || reduceMotion || performance.now() - velocity.at > 60) return;
  let v = { ...velocity };
  let prev = performance.now();
  const glide = (now) => {
    const dt = now - prev;
    prev = now;
    const s = view.state;
    view.set({ ra: s.ra + v.ra * dt, dec: s.dec + v.dec * dt });
    const k = Math.exp(-dt / 200);
    v = { ra: v.ra * k, dec: v.dec * k };
    if (Math.hypot(v.ra, v.dec) * 16 > s.fov / 4000) coast = requestAnimationFrame(glide);
    else writeHash();
  };
  coast = requestAnimationFrame(glide);
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', () => { if (!pointers.size) showRead(null); });

canvas.addEventListener('dblclick', (e) => {
  if (!view || inMap()) return;
  const at = view.skyAt(e.offsetX, e.offsetY);
  animate({ ra: at.ra, dec: at.dec, fov: view.state.fov / 3 }, 900, { arc: false });
});

canvas.addEventListener('keydown', (e) => {
  if (!view) return;
  if (inMap()) {
    if (e.key === 'Enter' || e.key === '+' || e.key === '=') dive(view.state, 60);
    return;
  }
  const s = view.state;
  const nudge = s.fov / 10;
  const cosd = Math.max(0.1, Math.cos((s.dec * Math.PI) / 180));
  const moves = {
    ArrowLeft: { ra: s.ra + nudge / cosd }, ArrowRight: { ra: s.ra - nudge / cosd },
    ArrowUp: { dec: s.dec + nudge }, ArrowDown: { dec: s.dec - nudge },
    '+': { fov: s.fov / 1.4 }, '=': { fov: s.fov / 1.4 }, '-': { fov: s.fov * 1.4 },
  };
  if (!moves[e.key]) return;
  e.preventDefault();
  view.set(moves[e.key]);
  writeHash();
});

$('zoom-in').addEventListener('click', () => {
  if (!view) return;
  if (inMap()) dive(view.state, 60);
  else animate({ fov: view.state.fov / 2 }, 450, { arc: false });
});
$('zoom-out').addEventListener('click', () => {
  if (!view || inMap()) return;
  animate({ fov: Math.min(FOV_MAX, view.state.fov * 2) }, 450, { arc: false });
});

/* ---- the hint ---------------------------------------------------------- */

function sayHint() {
  const map = inMap() ? 'Map' : '';
  $('hint').textContent = t(`allsky.hint${map}${touch ? 'Touch' : ''}`);
}

function hideHint() {
  $('hint').dataset.gone = 'true';
}

/* ---- reading the sky --------------------------------------------------- */

/**
 * Writes that happen after every frame, made only when the value is new: an
 * attribute set to what it already was still makes the browser work out the
 * page's style again, and on the body that is the whole page.
 */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
function setData(el, key, value) {
  if (el.dataset[key] !== value) el.dataset[key] = value;
}

let lastRead = null;
function showRead(px, py) {
  lastRead = px === null || px === undefined ? null : [px, py];
  if (!view) return;
  const s = view.state;
  const map = inMap();
  const at = lastRead ? view.skyAt(px, py) : (map ? null : { ra: s.ra, dec: s.dec });
  if (!at) {
    if (map) setText($('read'), '');
    return;
  }
  const g = galacticOf(at.ra, at.dec);
  // On a phone the line keeps to one row: minutes, not seconds.
  const where = narrow.matches
    ? `${formatRA(at.ra).slice(0, 8)} ${formatDec(at.dec).slice(0, 8)} · ${t('allsky.gal', { l: fmt(g.l, 0), b: fmt(g.b, 0) })}`
    : `${formatRA(at.ra)}  ${formatDec(at.dec)}  ·  ${t('allsky.gal', { l: fmt(g.l, 1), b: fmt(g.b, 1) })}`;
  setText($('read'), map ? where : `${where}  ·  ${t('allsky.fov')} ${fovText(s.fov)}`);
}

function fovText(fov) {
  if (fov >= 1) return `${fmt(fov, fov >= 10 ? 0 : 1)}°`;
  return `${fmt(fov * 60, 0)}′`;
}

/* ---- the ready fields, as rings ---------------------------------------- */

let fields = [];
fetch('data/fields/index.json').then((r) => (r.ok ? r.json() : [])).then((list) => {
  fields = list.map((f) => {
    const a = document.createElement('a');
    a.className = 'as-ring';
    a.dataset.key = f.key;
    a.innerHTML = '<span class="as-ring__dot"></span><span class="as-ring__name"></span>';
    // A deep field is blank in the cube, hatched on the sky: its ring says why, and opens its frames.
    if (DEEP_GAPS.some((g) => g.key === f.key)) {
      a.classList.add('as-ring--gap');
      a.insertAdjacentHTML('beforeend', '<span class="as-ring__note"></span>');
    }
    $('rings').append(a);
    return { ...f, el: a };
  });
  nameRings();
  view?.redraw();
}).catch(() => {});

function nameRings() {
  for (const f of fields) {
    const name = t(`preset.${f.key}`);
    f.el.querySelector('.as-ring__name').textContent = name;
    const note = f.el.querySelector('.as-ring__note');
    if (note) note.textContent = t('sky.gapNote');
    f.el.href = toolUrl({ ra: f.ra, dec: f.dec, name });
    f.el.title = t('allsky.openWhen');
  }
}

function placeRings() {
  if (!view) return;
  const { w, h } = view.size;
  for (const f of fields) {
    const p = view.screenOf(f.ra, f.dec);
    const inside = p && p.x > -40 && p.y > -40 && p.x < w + 40 && p.y < h + 40;
    if (f.el.hidden !== !inside) f.el.hidden = !inside;
    if (!inside) continue;
    const move = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    if (f.move !== move) {
      f.move = move;
      f.el.style.transform = move;
    }
  }
}

/* ---- into the tool ----------------------------------------------------- */

/** The tool's address for a point, in the band on screen (D2, its home band, for colour). */
function toolUrl({ ra, dec, name = '' }) {
  const band = current === 'colour' ? 'D2' : `D${bandOf(current)}`;
  const url = new URL('./', location.href);
  url.hash = encodeHash({ ra, dec, fov: TOOL_FOV, band, lang: getLanguage(), name });
  return url.href;
}

$('open').addEventListener('click', () => {
  if (!view || inMap()) return;
  const s = view.state;
  openInTool(toolUrl({ ra: s.ra, dec: s.dec }));
});

/* ---- after every redraw ------------------------------------------------ */

let wasMap = null;
function afterDraw({ wanted, have, failed }) {
  placeRings();
  const s = view.state;
  const map = s.map >= 0.5;
  setData($('reticle'), 'on', String(!map && s.fov <= 20));
  setData(document.body, 'map', String(map));
  if (map !== wasMap) {
    wasMap = map;
    $('open').disabled = map;
    $('open').title = t(map ? 'allsky.openMap' : 'allsky.openWhen');
    sayHint();
  }
  const status = $('status');
  if (failed) setText(status, t('allsky.failed', { n: failed }));
  else if (have < wanted) setText(status, t('allsky.loading', { n: have, m: wanted }));
  else setText(status, '');
  setData(status, 'bad', String(failed > 0));
  if (lastRead) showRead(...lastRead);
  else showRead(null);
}

/* ---- room for the map -------------------------------------------------- */

/** Keep the map's ellipse between the search box and the dock. */
function fitMap() {
  if (!view) return;
  const sky = $('sky').getBoundingClientRect();
  const top = $('find').getBoundingClientRect().bottom - sky.top + 8;
  const bottom = sky.bottom - $('dock').getBoundingClientRect().top + 8;
  view.setInsets({ top, bottom });
  // The hint stands just above the dock, not over the middle of the sky.
  $('hint').style.insetBlockEnd = `${bottom + 4}px`;
}
new ResizeObserver(fitMap).observe($('dock'));
window.addEventListener('resize', fitMap);

/* ---- finding a place --------------------------------------------------- */

let asking = null;
$('find').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('find-input').value.trim();
  const note = $('find-note');
  if (!text || !view) return;
  const go = ({ ra, dec }) => {
    if (inMap()) dive({ ra, dec }, 6);
    else animate({ ra, dec, fov: Math.min(view.state.fov, 6) }, 1500);
  };
  const coords = parseCoordinates(text);
  if (coords) {
    note.textContent = '';
    go(coords);
    return;
  }
  asking?.abort();
  asking = new AbortController();
  note.textContent = t('allsky.finding');
  try {
    const hit = await resolveSesame(text, { signal: asking.signal });
    if (!hit) {
      note.textContent = t('allsky.notFound');
      return;
    }
    note.textContent = hit.name;
    go(hit);
  } catch (err) {
    if (err?.name !== 'AbortError') note.textContent = t('allsky.offline');
  }
});

/* ---- language switch --------------------------------------------------- */

function applyLanguage() {
  applyTranslations();
  document.title = t('allsky.doc');
  $('fills').textContent = t('sky.fills', { n: CORE_STAR_COUNT });
  $('lang').textContent = getLanguage() === 'ru' ? 'EN' : 'RU';
  $('to-tool').href = `./?lang=${getLanguage()}`;
  nameRings();
  sayHint();
  showView();
}

$('lang').addEventListener('click', () => {
  setLanguage(getLanguage() === 'en' ? 'ru' : 'en');
  try { localStorage.setItem('muninn.lang', getLanguage()); } catch { /* private window */ }
  applyLanguage();
});

/* ---- start ------------------------------------------------------------- */

if (view) {
  view.set({ ra: start.ra, dec: start.dec, fov: start.map ? FOV_MAX : start.fov, map: start.map });
  fitMap();
}
applyLanguage();
// The hint says how to hold the sky once; it does not stay in front of it.
setTimeout(hideHint, 9000);
// Inside the front page: pointed where it faces, at the width it had.
addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'muninn:look' || !view) return;
  const { ra, dec, fov } = e.data;
  if (![ra, dec].every(Number.isFinite)) return;
  view.set({ ra, dec, fov: Number.isFinite(fov) ? Math.min(FOV_MAX, fov) : view.state.fov, map: 0 });
  writeHash();
});
if (embedded) hideHint();

window.addEventListener('hashchange', () => {
  const s = readHash();
  view?.set(s.map ? { ...s, fov: FOV_MAX } : s);
  if (s.view !== current) {
    current = s.view;
    showView();
  }
});


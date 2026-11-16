/**
 * allsky.js — the whole-sky page: the SPHEREx DR1 cube to turn, zoom and read
 * by wavelength, and a way from any point of it into the tool's own frames.
 *
 * The page keeps its place in the address — #ra=…&dec=…&fov=…&view=… — so a
 * link opens the same sky. `view` is `colour` or a frame number of the cube.
 */

import { setLanguage, getLanguage, t, applyTranslations, fmt } from './i18n.js';
import { parseCoordinates, resolveSesame, formatRA, formatDec } from './catalog.js';
import { encodeHash } from './hash.js';
import { createSkyView, FOV_MIN, FOV_MAX } from './allsky/view.js';
import {
  FRAMES, WAVELENGTHS, COLOUR_FRAMES, bandOf, channelOf, bandFrame,
} from './allsky/hips.js';

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The galactic centre, wide: the Milky Way across the screen. */
const OPENING = { ra: 266.4, dec: -29.0, fov: 120 };
/** The field the tool opens with, in degrees: its own middle size. */
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
  return {
    ra: Number.isFinite(ra) ? ra : OPENING.ra,
    dec: Number.isFinite(dec) && Math.abs(dec) <= 90 ? dec : OPENING.dec,
    fov: Number.isFinite(fov) ? Math.min(FOV_MAX, Math.max(FOV_MIN, fov)) : OPENING.fov,
    view: view !== null && view !== 'colour' && FRAMES.includes(frame) ? frame : 'colour',
  };
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const s = view.state;
    const p = new URLSearchParams({ ra: s.ra.toFixed(4), dec: s.dec.toFixed(4), fov: s.fov.toPrecision(3), view: String(current) });
    history.replaceState(null, '', `#${p}`);
  }, 250);
}

/* ---- the view ---------------------------------------------------------- */

const canvas = $('canvas');
const ramp = getComputedStyle(document.documentElement).getPropertyValue('--cmap-deep')
  .split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
const view = createSkyView(canvas, { ramp, onChange: afterDraw });

if (!view) {
  $('nogl').hidden = false;
  $('hint').hidden = true;
}

const start = readHash();
/** `colour`, or the frame on screen. */
let current = start.view;

/* ---- wavelength -------------------------------------------------------- */

const lambda = $('lambda');
lambda.max = String(FRAMES.length - 1);

const um = (w) => fmt(w, 2);

function showView() {
  const colour = current === 'colour';
  const frame = colour ? COLOUR_FRAMES[1] : current;
  const band = bandOf(frame);
  document.documentElement.dataset.band = `D${band}`;
  for (const input of document.querySelectorAll('input[name="view"]')) {
    input.checked = colour ? input.value === 'colour' : Number(input.value) === band;
  }
  lambda.value = String(FRAMES.indexOf(frame));
  lambda.closest('.as-dock__row').dataset.colour = String(colour);
  $('lambda-value').textContent = colour
    ? t('allsky.colourNote', { b: um(WAVELENGTHS[COLOUR_FRAMES[2]]), g: um(WAVELENGTHS[COLOUR_FRAMES[1]]), r: um(WAVELENGTHS[COLOUR_FRAMES[0]]) })
    : t('allsky.lambdaValue', { w: um(WAVELENGTHS[frame]), band: `D${band}`, ch: channelOf(frame) });
  lambda.setAttribute('aria-valuetext', $('lambda-value').textContent);
  view?.setFrames(colour ? COLOUR_FRAMES : [frame]);
  writeHash();
}

let lambdaTimer = 0;
lambda.addEventListener('input', () => {
  current = FRAMES[Number(lambda.value)];
  // The words follow the slider at once; the sky only once the hand rests, so
  // a sweep across the range does not ask IRSA for every frame on the way.
  const frame = current;
  $('lambda-value').textContent = t('allsky.lambdaValue', { w: um(WAVELENGTHS[frame]), band: `D${bandOf(frame)}`, ch: channelOf(frame) });
  document.documentElement.dataset.band = `D${bandOf(frame)}`;
  for (const input of document.querySelectorAll('input[name="view"]')) input.checked = Number(input.value) === bandOf(frame);
  lambda.closest('.as-dock__row').dataset.colour = 'false';
  clearTimeout(lambdaTimer);
  lambdaTimer = setTimeout(showView, 220);
});

$('bands').addEventListener('change', (e) => {
  const v = e.target.value;
  current = v === 'colour' ? 'colour' : bandFrame(Number(v));
  showView();
});

$('grid').addEventListener('change', (e) => view?.setGrid(e.target.checked));

/* ---- moving about ------------------------------------------------------ */

let flight = 0;

/** Glide to a place; a jump where motion is unwelcome. */
function flyTo({ ra, dec, fov }) {
  cancelAnimationFrame(flight);
  const from = view.state;
  if (reduceMotion) {
    view.set({ ra, dec, fov });
    writeHash();
    return;
  }
  // The short way round in RA.
  let dra = ra - from.ra;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  const t0 = performance.now();
  const ms = 1400;
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  // Out wide and back in, so the eye sees where on the sky it went.
  const wide = Math.max(from.fov, fov, Math.min(90, Math.abs(dra) + Math.abs(dec - from.dec)));
  const step = (now) => {
    const x = Math.min(1, (now - t0) / ms);
    const e = ease(x);
    const arc = Math.sin(Math.PI * x);
    const logFov = Math.log(from.fov) * (1 - e) + Math.log(fov) * e;
    const f = Math.exp(logFov + (Math.log(wide) - logFov) * arc * 0.6);
    view.set({ ra: from.ra + dra * e, dec: from.dec + (dec - from.dec) * e, fov: f });
    if (x < 1) flight = requestAnimationFrame(step);
    else writeHash();
  };
  flight = requestAnimationFrame(step);
}

/** Zoom by a factor, keeping the sky under (px, py) where it is. */
function zoomAt(factor, px, py) {
  cancelAnimationFrame(flight);
  const before = view.skyAt(px, py);
  const s = view.state;
  view.set({ fov: s.fov * factor });
  const after = view.skyAt(px, py);
  let dra = before.ra - after.ra;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  const now = view.state;
  view.set({ ra: now.ra + dra, dec: now.dec + (before.dec - after.dec) });
  writeHash();
}

const pointers = new Map();
let dragged = false;
let pinchFrom = 0;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  dragged = false;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchFrom = Math.hypot(a.x - b.x, a.y - b.y);
  }
  cancelAnimationFrame(flight);
  $('hint').dataset.gone = 'true';
});

canvas.addEventListener('pointermove', (e) => {
  showRead(e.offsetX, e.offsetY);
  const last = pointers.get(e.pointerId);
  if (!last || !view) return;
  const now = { x: e.offsetX, y: e.offsetY };
  if (pointers.size === 2) {
    pointers.set(e.pointerId, now);
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchFrom > 0 && d > 0) zoomAt(pinchFrom / d, (a.x + b.x) / 2, (a.y + b.y) / 2);
    pinchFrom = d;
    dragged = true;
    return;
  }
  if (Math.hypot(now.x - last.x, now.y - last.y) > 2) dragged = true;
  // Drag the sky itself: the point under the finger stays under it.
  const before = view.skyAt(last.x, last.y);
  const after = view.skyAt(now.x, now.y);
  let dra = before.ra - after.ra;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  const s = view.state;
  view.set({ ra: s.ra + dra, dec: s.dec + (before.dec - after.dec) });
  pointers.set(e.pointerId, now);
  writeHash();
});

const release = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchFrom = 0;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', () => { if (!pointers.size) showRead(null); });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!view) return;
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
  zoomAt(Math.exp((e.deltaY * unit) / 500), e.offsetX, e.offsetY);
}, { passive: false });

canvas.addEventListener('dblclick', (e) => {
  if (!view) return;
  const at = view.skyAt(e.offsetX, e.offsetY);
  flyTo({ ra: at.ra, dec: at.dec, fov: view.state.fov / 3 });
});

canvas.addEventListener('keydown', (e) => {
  if (!view) return;
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

const zoomCentre = (factor) => zoomAt(factor, canvas.clientWidth / 2, canvas.clientHeight / 2);
$('zoom-in').addEventListener('click', () => view && zoomCentre(1 / 1.8));
$('zoom-out').addEventListener('click', () => view && zoomCentre(1.8));

/* ---- reading the sky --------------------------------------------------- */

let lastRead = null;
function showRead(px, py) {
  if (px !== null) lastRead = [px, py];
  if (!view) return;
  const s = view.state;
  const at = px === null || px === undefined ? { ra: s.ra, dec: s.dec } : view.skyAt(px, py);
  $('read').textContent = `${formatRA(at.ra)}  ${formatDec(at.dec)}  ·  ${t('allsky.fov')} ${fovText(s.fov)}`;
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
    f.el.href = toolUrl({ ra: f.ra, dec: f.dec, name });
    f.el.title = t('allsky.openWhen');
  }
}

function placeRings() {
  if (!view) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  for (const f of fields) {
    const p = view.screenOf(f.ra, f.dec);
    const inside = p && p.x > -40 && p.y > -40 && p.x < w + 40 && p.y < h + 40;
    f.el.hidden = !inside;
    if (inside) f.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
  }
}

/* ---- into the tool ----------------------------------------------------- */

/** The tool's address for a point, in the band now on screen (D2, its home band, for colour). */
function toolUrl({ ra, dec, name = '' }) {
  const band = current === 'colour' ? 'D2' : `D${bandOf(current)}`;
  const url = new URL('./', location.href);
  url.hash = encodeHash({ ra, dec, fov: TOOL_FOV, band, lang: getLanguage(), name });
  return url.href;
}

$('open').addEventListener('click', () => {
  const s = view?.state ?? start;
  location.href = toolUrl({ ra: s.ra, dec: s.dec });
});

/* ---- after every redraw ------------------------------------------------ */

function afterDraw({ wanted, have, failed }) {
  placeRings();
  const s = view.state;
  $('reticle').dataset.on = String(s.fov <= 20);
  const status = $('status');
  if (failed) status.textContent = t('allsky.failed', { n: failed });
  else if (have < wanted) status.textContent = t('allsky.loading', { n: have, m: wanted });
  else status.textContent = '';
  status.dataset.bad = String(failed > 0);
  if (lastRead) showRead(...lastRead);
  else showRead(null);
}

/* ---- finding a place --------------------------------------------------- */

let asking = null;
$('find').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('find-input').value.trim();
  const note = $('find-note');
  if (!text || !view) return;
  const fov = Math.min(view.state.fov, 6);
  const coords = parseCoordinates(text);
  if (coords) {
    note.textContent = '';
    flyTo({ ra: coords.ra, dec: coords.dec, fov });
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
    flyTo({ ra: hit.ra, dec: hit.dec, fov });
  } catch (err) {
    if (err?.name !== 'AbortError') note.textContent = t('allsky.offline');
  }
});

/* ---- language switch --------------------------------------------------- */

function applyLanguage() {
  applyTranslations();
  document.title = t('allsky.doc');
  $('lang').textContent = getLanguage() === 'ru' ? 'EN' : 'RU';
  $('to-tool').href = `./?lang=${getLanguage()}`;
  nameRings();
  showView();
}

$('lang').addEventListener('click', () => {
  setLanguage(getLanguage() === 'en' ? 'ru' : 'en');
  try { localStorage.setItem('muninn.lang', getLanguage()); } catch { /* private window */ }
  applyLanguage();
});

/* ---- start ------------------------------------------------------------- */

applyLanguage();
view?.set(start);
// The hint says how to hold the sky once; it does not stay in front of it.
setTimeout(() => { $('hint').dataset.gone = 'true'; }, 8000);
window.addEventListener('hashchange', () => {
  const s = readHash();
  view?.set(s);
  if (s.view !== current) {
    current = s.view;
    showView();
  }
});

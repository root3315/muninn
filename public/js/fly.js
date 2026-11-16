/**
 * fly.js — a flight through the Sun's neighbourhood.
 *
 * The camera starts at the Sun, facing where the front page faces. Drag to
 * look about, W/S or the arrows to fly, the wheel to change speed; or pick a
 * star and the autopilot takes you there and stops short of it. The readout
 * says how far from the Sun you are, how fast you are going, and which named
 * star is nearest.
 *
 * The address keeps where you are: #x=…&y=…&z=… in parsecs.
 */

import { setLanguage, getLanguage, t, applyTranslations, fmt } from './i18n.js';
import { starColour, direction } from './gate.js';
import { createSpace, screenOf } from './fly/space.js';

const $ = (id) => document.getElementById(id);
const LY_PER_PC = 3.26156;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The field of view, vertical, degrees: the front page's opening width. */
const FOV = 70;
/** Speed bounds, parsecs a second: from a few AU a second to a kiloparsec in ten seconds. */
const SPEED_MIN = 0.00005;
const SPEED_MAX = 100;

function pickLanguage() {
  const asked = new URLSearchParams(location.search).get('lang');
  let saved = null;
  try { saved = localStorage.getItem('muninn.lang'); } catch { /* private window */ }
  return asked ?? saved ?? (navigator.language?.startsWith('ru') ? 'ru' : 'en');
}
setLanguage(pickLanguage());

/* ---- vectors ----------------------------------------------------------- */

const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(...a);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Rotate v about a unit axis by an angle (Rodrigues). */
function rotate(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}

/* ---- the camera -------------------------------------------------------- */

/*
 * A forward and an up; right is their cross product, which puts east on the
 * left when looking out with north up, as on any sky chart.
 */
const cam = {
  eye: [0, 0, 0],
  F: direction(266, -12),
  U: [0, 0, 1],
  speed: 1,
};
function orthonormal() {
  cam.F = norm(cam.F);
  cam.U = norm(sub(cam.U, cam.F.map((c) => c * dot(cam.U, cam.F))));
}
orthonormal();
const basis = () => ({ eye: cam.eye, F: cam.F, U: cam.U, R: cross(cam.F, cam.U) });

/* ---- data -------------------------------------------------------------- */

async function loadStars() {
  const [first, named] = await Promise.all([
    fetch('data/fly/stars.bin').then((r) => r.arrayBuffer()),
    fetch('data/fly/named.json', { cache: 'no-cache' }).then((r) => r.json()),
  ]);
  // Sixteen bytes a star. A file of another size is an older build still in
  // the browser's cache: read as this one it would scatter the stars, so it
  // is fetched again past the cache.
  const bin = first.byteLength === named.count * 16
    ? first
    : await fetch('data/fly/stars.bin', { cache: 'reload' }).then((r) => r.arrayBuffer());
  // Float32 x, y, z for every star, then Int16 magnitude and colour for every star.
  const stored = bin.byteLength / 16;
  const xyz = new Float32Array(bin, 0, stored * 3);
  const look = new Int16Array(bin, stored * 12, stored * 2);
  // The catalogue, and the Sun, which a catalogue of stars seen from it lacks.
  const n = stored + 1;
  const pos = new Float32Array(n * 3);
  const mag = new Float32Array(n);
  const col = new Float32Array(n * 3);
  const put = (i, xyz, m, bv) => {
    pos.set(xyz, i * 3);
    mag[i] = m;
    col.set(starColour(bv).map((c) => c / 255), i * 3);
  };
  for (let i = 0; i < n - 1; i++) {
    put(i, xyz.subarray(i * 3, i * 3 + 3), look[i * 2] / 100, look[i * 2 + 1] / 1000);
  }
  put(n - 1, [0, 0, 0], 4.83, 0.65);
  return { stars: { pos, mag, col }, named: named.named, count: named.count };
}

async function loadSky() {
  try {
    const res = await fetch('data/sky/milkyway.png');
    return res.ok ? await createImageBitmap(await res.blob()) : null;
  } catch {
    return null;
  }
}

/* ---- words ------------------------------------------------------------- */

const ly = (pc) => pc * LY_PER_PC;
function distanceText(pc) {
  const l = ly(pc);
  if (l < 0.01) return t('fly.au', { n: fmt(pc * 206265, 0) });
  return t('fly.ly', { n: fmt(l, l < 10 ? 2 : l < 100 ? 1 : 0) });
}
const nameOf = (s) => (getLanguage() === 'ru' ? s.ru : s.en);

/* ---- the page ---------------------------------------------------------- */

const canvas = $('canvas');
let space = null;
let named = [];
let labels = [];
let autopilot = null;
let starCount = 0;
let last = performance.now();
const keys = new Set();
const hold = { forward: false, back: false };

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const xyz = ['x', 'y', 'z'].map((k) => Number(p.get(k)));
  if (xyz.every(Number.isFinite)) cam.eye = xyz;
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = new URLSearchParams({ x: cam.eye[0].toFixed(3), y: cam.eye[1].toFixed(3), z: cam.eye[2].toFixed(3) });
    history.replaceState(null, '', `#${p}`);
  }, 300);
}

function buildLabels() {
  $('labels').replaceChildren();
  labels = named.map((s) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `fly-label${s.target ? ' fly-label--target' : ''}`;
    el.innerHTML = '<span class="fly-label__dot"></span><span class="fly-label__name"></span><span class="fly-label__far num"></span>';
    el.addEventListener('click', () => flyTo(s));
    $('labels').append(el);
    return { s, el };
  });
  nameLabels();
}

function nameLabels() {
  for (const { s, el } of labels) {
    el.querySelector('.fly-label__name').textContent = nameOf(s);
    // A brown dwarf gives almost no visible light: its ring marks a place the eye sees nothing.
    el.title = s.key === 'wise0855' ? t('fly.dark') : '';
  }
  const chips = $('dest');
  chips.replaceChildren();
  // The trip worth taking first: the challenge's own target, then the nearest stars.
  const order = ['wise0855', 'hip70890', 'hip87937', 'hip32349', 'hip108870', 'hip91262', 'hip27989', 'hip17702', 'hip11767', 'sun'];
  for (const key of order) {
    const s = named.find((n) => n.key === key);
    if (!s) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `as-band${s.target ? ' fly-chip--target' : ''}`;
    b.textContent = nameOf(s);
    b.addEventListener('click', () => flyTo(s));
    chips.append(b);
  }
}

/** Fly to a star, stopping where it fills a little of the sky. */
function flyTo(s) {
  const to = s.pos;
  const away = len(sub(cam.eye, to));
  // Stop short: far enough to see the star as a star, near enough that it
  // is the brightest thing in the sky. The Sun: a few AU, as from Jupiter.
  const stop = Math.max(0.00003, Math.min(0.05, away * 0.02));
  const dir = norm(sub(to, cam.eye));
  const end = away > stop ? add(to, dir, -stop) : cam.eye;
  autopilot = { from: cam.eye, to: end, look: to, t0: performance.now(), ms: reduceMotion ? 1 : 2600 + 600 * Math.log10(1 + away), name: s };
  $('hint').dataset.gone = 'true';
}

function steer(dt) {
  if (autopilot) {
    const x = Math.min(1, (performance.now() - autopilot.t0) / autopilot.ms);
    // Logarithmic in distance: the long cruise is quick, the arrival slow.
    const e = 1 - (1 - x) ** 3;
    const span = sub(autopilot.to, autopilot.from);
    cam.eye = add(autopilot.from, span, e);
    const want = norm(sub(autopilot.look, cam.eye));
    cam.F = norm(add(cam.F, sub(want, cam.F), Math.min(1, dt / 0.25)));
    orthonormal();
    if (x >= 1) {
      autopilot = null;
      writeHash();
    }
    return;
  }
  let move = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp') || hold.forward) move += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown') || hold.back) move -= 1;
  let side = 0;
  if (keys.has('KeyD') || keys.has('ArrowRight')) side += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) side -= 1;
  if (move || side) {
    const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5 : 1;
    const R = cross(cam.F, cam.U);
    cam.eye = add(add(cam.eye, cam.F, move * cam.speed * boost * dt), R, side * cam.speed * boost * dt);
    writeHash();
  }
}

function readout() {
  const fromSun = len(cam.eye);
  let near = null;
  let nearD = Infinity;
  for (const s of named) {
    const d = len(sub(s.pos, cam.eye));
    if (d < nearD && d > 1e-9) { nearD = d; near = s; }
  }
  $('read').textContent = [
    t('fly.fromSun', { d: distanceText(fromSun) }),
    t('fly.speed', { v: fmt(ly(cam.speed), cam.speed < 0.3 ? 3 : 1) }),
    near && t('fly.nearest', { name: nameOf(near), d: distanceText(nearD) }),
  ].filter(Boolean).join('  ·  ');
}

function placeLabels(proj) {
  const b = basis();
  for (const { s, el } of labels) {
    const at = screenOf(s.pos, b, proj);
    el.hidden = !at;
    if (!at) continue;
    el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
    el.querySelector('.fly-label__far').textContent = distanceText(len(sub(s.pos, cam.eye)));
  }
}

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  steer(dt);
  const proj = space.draw({ ...basis(), fov: FOV });
  placeLabels(proj);
  readout();
  requestAnimationFrame(frame);
}

/* ---- input ------------------------------------------------------------- */

const pointers = new Map();
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  autopilot = null;
  $('hint').dataset.gone = 'true';
});
canvas.addEventListener('pointermove', (e) => {
  const last = pointers.get(e.pointerId);
  if (!last) return;
  const dx = e.clientX - last[0];
  const dy = e.clientY - last[1];
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  // Drag the sky: it follows the hand, as on the front page.
  const perPx = (FOV * Math.PI / 180) / canvas.clientHeight;
  cam.F = rotate(cam.F, cam.U, dx * perPx);
  const R = cross(cam.F, cam.U);
  cam.F = rotate(cam.F, R, dy * perPx);
  cam.U = rotate(cam.U, R, dy * perPx);
  orthonormal();
});
const release = (e) => pointers.delete(e.pointerId);
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  setSpeed(cam.speed * Math.exp(-e.deltaY / 500));
}, { passive: false });

function setSpeed(v) {
  cam.speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, v));
}

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input')) return;
  keys.add(e.code);
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setSpeed(cam.speed * 2);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') setSpeed(cam.speed / 2);
  if (e.code.startsWith('Arrow')) e.preventDefault();
  if (keys.size) autopilot = null;
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

for (const [id, k] of [['go-forward', 'forward'], ['go-back', 'back']]) {
  const b = $(id);
  const on = (v) => (e) => { e.preventDefault(); hold[k] = v; if (v) autopilot = null; };
  b.addEventListener('pointerdown', on(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, on(false));
}
$('faster').addEventListener('click', () => setSpeed(cam.speed * 4));
$('slower').addEventListener('click', () => setSpeed(cam.speed / 4));

/* ---- language and start ----------------------------------------------- */

function applyLanguage() {
  applyTranslations();
  document.title = t('fly.doc');
  $('lang').textContent = getLanguage() === 'ru' ? 'EN' : 'RU';
  $('hint').textContent = t(matchMedia('(pointer: coarse)').matches ? 'fly.hintTouch' : 'fly.hint');
  if (named.length) nameLabels();
  if (starCount) $('source').textContent = t('fly.source', { n: fmt(starCount, 0) });
}
$('lang').addEventListener('click', () => {
  setLanguage(getLanguage() === 'en' ? 'ru' : 'en');
  try { localStorage.setItem('muninn.lang', getLanguage()); } catch { /* private window */ }
  applyLanguage();
});

applyLanguage();
readHash();
const [data, sky] = await Promise.all([loadStars(), loadSky()]);
space = createSpace(canvas, { stars: data.stars, sky });
if (!space) {
  $('nogl').hidden = false;
} else {
  named = data.named;
  starCount = data.count;
  buildLabels();
  applyLanguage();
  setTimeout(() => { $('hint').dataset.gone = 'true'; }, 9000);
  requestAnimationFrame(frame);
}

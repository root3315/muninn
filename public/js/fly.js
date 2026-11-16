/**
 * fly.js — a flight through the Sun's neighbourhood.
 *
 * The camera starts at the Sun, facing where the front page faces. Drag to
 * look about, W/S or the arrows to fly, the wheel to change speed; or pick a
 * star and the autopilot takes you to a few of its own radii from it, where
 * it is a disc at its real size. Any star can be pressed: its card says what
 * the catalogue knows of it, and opens SPHEREx's frames of it in the tool.
 *
 * The address keeps where you are: #x=…&y=…&z=… in parsecs.
 */

import { setLanguage, getLanguage, t, applyTranslations, fmt } from './i18n.js';
import { starColour, direction } from './gate.js';
import { encodeHash } from './hash.js';
import { radecOf } from './allsky/healpix.js';
import { createSpace, screenOf } from './fly/space.js';
import { temperatureOf, luminosityOf, radiusOf, R_SUN_PC } from './fly/stars.js';

const $ = (id) => document.getElementById(id);
const LY_PER_PC = 3.26156;
const AU_PER_PC = 206264.806;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The field of view, vertical, degrees: the front page's opening width. */
const FOV = 70;
/** Speed bounds, parsecs a second: from a few AU a second to a kiloparsec in ten seconds. */
const SPEED_MIN = 0.00005;
const SPEED_MAX = 100;
/** The autopilot stops this many of a star's radii from its centre: a disc a fifth of the sky across. */
const STOP_RADII = 6;
/** Bytes a star in stars.bin: float x, y, z; int16 magnitude, colour; int32 Hipparcos number. */
const STAR_BYTES = 20;

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
const cam = { eye: [0, 0, 0], F: direction(266, -12), U: [0, 0, 1], speed: 1 };
function orthonormal() {
  cam.F = norm(cam.F);
  cam.U = norm(sub(cam.U, cam.F.map((c) => c * dot(cam.U, cam.F))));
}
orthonormal();
const basis = () => ({ eye: cam.eye, F: cam.F, U: cam.U, R: cross(cam.F, cam.U) });

/* ---- data -------------------------------------------------------------- */

/**
 * Every star: position (pc), absolute magnitude, colour, radius (R☉) and
 * Hipparcos number; the Sun last. Named stars carry their measured radii.
 */
async function loadStars() {
  const [first, info] = await Promise.all([
    fetch('data/fly/stars.bin').then((r) => r.arrayBuffer()),
    fetch('data/fly/named.json', { cache: 'no-cache' }).then((r) => r.json()),
  ]);
  // A file of another size is an older build still in the browser's cache:
  // read as this one it would scatter the stars, so it is fetched again.
  const bin = first.byteLength === info.count * STAR_BYTES
    ? first
    : await fetch('data/fly/stars.bin', { cache: 'reload' }).then((r) => r.arrayBuffer());
  const stored = bin.byteLength / STAR_BYTES;
  const xyz = new Float32Array(bin, 0, stored * 3);
  const look = new Int16Array(bin, stored * 12, stored * 2);
  const hipOf = new Int32Array(bin, stored * 16, stored);
  const measured = new Map(info.named.filter((s) => s.hip).map((s) => [s.hip, s.radius]));

  const n = stored + 1;
  const stars = {
    pos: new Float32Array(n * 3), mag: new Float32Array(n), col: new Float32Array(n * 3),
    rad: new Float32Array(n), bv: new Float32Array(n), hip: new Int32Array(n), measured: new Uint8Array(n),
  };
  const put = (i, p, m, bv, hip) => {
    stars.pos.set(p, i * 3);
    stars.mag[i] = m;
    stars.bv[i] = bv;
    stars.hip[i] = hip;
    stars.col.set(starColour(bv).map((c) => c / 255), i * 3);
    const r = measured.get(hip);
    stars.measured[i] = r ? 1 : 0;
    stars.rad[i] = r ?? radiusOf(m, bv);
  };
  for (let i = 0; i < stored; i++) put(i, xyz.subarray(i * 3, i * 3 + 3), look[i * 2] / 100, look[i * 2 + 1] / 1000, hipOf[i]);
  // The Sun, which a catalogue of stars seen from it lacks.
  put(stored, [0, 0, 0], 4.83, 0.65, 0);
  stars.rad[stored] = 1;
  stars.measured[stored] = 1;
  const indexOfHip = new Map();
  for (let i = 0; i < stored; i++) indexOfHip.set(hipOf[i], i);
  const named = info.named.map((s) => ({ ...s, index: s.key === 'sun' ? stored : indexOfHip.get(s.hip) ?? -1 }));
  return { stars, named, count: info.count, sun: stored };
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
  if (l < 0.01) return t('fly.au', { n: fmt(pc * AU_PER_PC, pc * AU_PER_PC < 10 ? 2 : 0) });
  return t('fly.ly', { n: fmt(l, l < 10 ? 2 : l < 100 ? 1 : 0) });
}
const nameOf = (s) => (getLanguage() === 'ru' ? s.ru : s.en);
const sig = (v) => (v >= 100 ? fmt(v, 0) : v >= 10 ? fmt(v, 1) : v >= 1 ? fmt(v, 2) : fmt(v, 3));

/* ---- the page ---------------------------------------------------------- */

const canvas = $('canvas');
let space = null;
let stars = null;
let sunIndex = -1;
let named = [];
let labels = [];
let autopilot = null;
let starCount = 0;
let proj = null;
let card = null;
let lastNear = null;
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
    const p = new URLSearchParams({ x: cam.eye[0].toFixed(6), y: cam.eye[1].toFixed(6), z: cam.eye[2].toFixed(6) });
    history.replaceState(null, '', `#${p}`);
  }, 300);
}

const posOf = (i) => [stars.pos[i * 3], stars.pos[i * 3 + 1], stars.pos[i * 3 + 2]];
/**
 * Where something is. A catalogue star from the catalogue itself, never from
 * named.json, whose positions are rounded to 0.0001 pc — twenty AU, a hundred
 * times the distance the autopilot stops from a star.
 */
const placeOf = (s) => (s.index >= 0 ? posOf(s.index) : s.pos);

function buildLabels() {
  $('labels').replaceChildren();
  labels = named.map((s) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `fly-label${s.target ? ' fly-label--target' : ''}`;
    el.innerHTML = '<span class="fly-label__dot"></span><span class="fly-label__name"></span><span class="fly-label__far num"></span>';
    el.addEventListener('click', () => openCard(s));
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
    const s = named.find((x) => x.key === key);
    if (!s) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `as-band${s.target ? ' fly-chip--target' : ''}`;
    b.textContent = nameOf(s);
    b.addEventListener('click', () => flyTo(s));
    chips.append(b);
  }
}

/* ---- the autopilot ----------------------------------------------------- */

/** The radius of a destination in parsecs. */
const radiusPc = (s) => (s.index >= 0 ? stars.rad[s.index] : s.radius ?? 1) * R_SUN_PC;

/** Fly to a star, stopping a few of its own radii from it. */
function flyTo(s) {
  closeCard();
  const to = placeOf(s);
  const away = len(sub(cam.eye, to));
  // A star with no light to see (WISE 0855) is approached less closely: a
  // disc the eye could not see would be a black hole in the stars.
  const stop = radiusPc(s) * (s.index >= 0 ? STOP_RADII : 600);
  const dir = norm(sub(to, cam.eye));
  const end = away > stop ? add(to, dir, -stop) : cam.eye;
  autopilot = {
    from: cam.eye, to: end, look: to, stop, t0: performance.now(),
    ms: reduceMotion ? 1 : 3000 + 400 * Math.log10(1 + away / Math.max(stop, 1e-12)),
  };
  $('hint').dataset.gone = 'true';
}

function steer(dt) {
  if (autopilot) {
    const x = Math.min(1, (performance.now() - autopilot.t0) / autopilot.ms);
    // Most of the way quickly, the last of it slowly: the distance closes
    // geometrically, so the arrival at a few radii is seen, not jumped.
    const span = sub(autopilot.to, autopilot.from);
    const left = len(span) * (1 - x) ** 4;
    cam.eye = add(autopilot.to, norm(span), -left);
    const want = norm(sub(autopilot.look, cam.eye));
    cam.F = norm(add(cam.F, sub(want, cam.F), Math.min(1, dt / 0.25)));
    orthonormal();
    if (x >= 1) {
      // Arrived: slow enough to fly round the star rather than past it.
      setSpeed(autopilot.stop);
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

/* ---- the near star ----------------------------------------------------- */

/** The star whose disc is largest from here: the one drawn as a sphere. */
function nearestStar() {
  const [ex, ey, ez] = cam.eye;
  const p = stars.pos;
  let best = -1;
  let bestK = 0;
  for (let i = 0; i < stars.mag.length; i++) {
    const dx = p[i * 3] - ex;
    const dy = p[i * 3 + 1] - ey;
    const dz = p[i * 3 + 2] - ez;
    const k = stars.rad[i] / Math.sqrt(dx * dx + dy * dy + dz * dz + 1e-30);
    if (k > bestK) { bestK = k; best = i; }
  }
  if (best < 0) return null;
  return {
    index: best,
    // In double precision: the GPU's single precision is a few AU at a few
    // hundred parsecs, and a star seen from a few of its radii needs better.
    pos: posOf(best),
    rpc: stars.rad[best] * R_SUN_PC,
    col: [stars.col[best * 3], stars.col[best * 3 + 1], stars.col[best * 3 + 2]],
  };
}

/* ---- the readout and labels ------------------------------------------- */

function readout() {
  const fromSun = len(cam.eye);
  let nearName = null;
  let nearD = Infinity;
  for (const s of named) {
    const d = len(sub(placeOf(s), cam.eye));
    if (d < nearD && d > 1e-12) { nearD = d; nearName = s; }
  }
  $('read').textContent = [
    t('fly.fromSun', { d: distanceText(fromSun) }),
    t('fly.speed', { v: fmt(ly(cam.speed), cam.speed < 0.3 ? 3 : 1) }),
    nearName && t('fly.nearest', { name: nameOf(nearName), d: distanceText(nearD) }),
  ].filter(Boolean).join('  ·  ');
}

function placeLabels() {
  const b = basis();
  for (const { s, el } of labels) {
    const at = screenOf(placeOf(s), b, proj);
    el.hidden = !at;
    if (!at) continue;
    el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
    el.querySelector('.fly-label__far').textContent = distanceText(len(sub(placeOf(s), cam.eye)));
  }
}

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  steer(dt);
  lastNear = nearestStar();
  proj = space.draw({ ...basis(), fov: FOV, near: lastNear });
  placeLabels();
  readout();
  requestAnimationFrame(frame);
}

/* ---- a star's card ----------------------------------------------------- */

/** The star under a point of the canvas: the brightest-looking within a few pixels. */
function pickAt(px, py) {
  const b = basis();
  // On the near star's disc: that star.
  if (lastNear) {
    const c = screenOf(lastNear.pos, b, proj);
    const d = len(sub(lastNear.pos, cam.eye));
    const rPx = (lastNear.rpc / d) * proj.focal[1] * (proj.h / proj.dpr) / 2;
    if (c && Math.hypot(c.x - px, c.y - py) <= Math.max(rPx, 0)) return lastNear.index;
  }
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < stars.mag.length; i++) {
    const p = posOf(i);
    const at = screenOf(p, b, proj);
    if (!at) continue;
    const dpx = Math.hypot(at.x - px, at.y - py);
    if (dpx > 16) continue;
    const m = stars.mag[i] + 5 * Math.log10(Math.max(len(sub(p, cam.eye)), 1e-12) / 10);
    // Nearness on screen first, then brightness: a bright star a few pixels
    // off is meant before a faint one under the finger.
    const score = dpx + 2 * m;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

function cardRow(k, v) {
  const div = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = k;
  dd.textContent = v;
  dd.className = 'num';
  div.append(dt, dd);
  return div;
}

/** What is known of a star, or of a named place; `entry` is a named entry or { index }. */
function openCard(entry) {
  const i = entry.index ?? -1;
  const s = entry.en ? entry : named.find((x) => x.index === i) ?? entry;
  const p = i >= 0 ? posOf(i) : s.pos;
  const fromSun = len(p);
  let title = s.en ? nameOf(s) : `HIP ${stars.hip[i]}`;
  if (i === sunIndex) title = nameOf(named.find((x) => x.key === 'sun'));
  const rows = [];
  if (i !== sunIndex) rows.push([t('fly.cardSun'), distanceText(fromSun)]);
  rows.push([t('fly.cardHere'), distanceText(len(sub(p, cam.eye)))]);
  if (i >= 0) {
    const m = stars.mag[i];
    const bv = stars.bv[i];
    rows.push([t('fly.cardTemp'), t('fly.kelvin', { n: fmt(Math.round(temperatureOf(bv) / 10) * 10, 0) })]);
    rows.push([t('fly.cardRadius'), t(stars.measured[i] ? 'fly.radiusMeasured' : 'fly.radiusEstimated', { n: sig(stars.rad[i]) })]);
    rows.push([t('fly.cardLum'), t('fly.solar', { n: sig(luminosityOf(m, bv)) })]);
    if (i !== sunIndex) rows.push([t('fly.cardMag'), fmt(m + 5 * Math.log10(fromSun / 10), 2)]);
  } else if (s.radius) {
    rows.push([t('fly.cardRadius'), t('fly.radiusModel', { n: sig(s.radius) })]);
  }
  $('card-title').textContent = title;
  $('card-note').textContent = s.key === 'wise0855'
    ? t('fly.dark')
    : i >= 0 && i !== sunIndex ? `HIP ${stars.hip[i]} · ${t('fly.cardSource')}` : '';
  $('card-rows').replaceChildren(...rows.map(([k, v]) => cardRow(k, v)));
  // SPHEREx looks from beside the Earth: a star's place on its sky is its
  // direction from the Sun. The Sun itself has none.
  const sky = fromSun > 0 ? radecOf(p) : null;
  const frames = $('card-frames');
  frames.hidden = !sky;
  if (sky) {
    const url = new URL('./', location.href);
    url.hash = encodeHash({ ra: sky.ra, dec: sky.dec, fov: 0.3, band: s.key === 'wise0855' ? 'D6' : 'D2', lang: getLanguage(), name: title });
    frames.href = url.href;
  }
  card = { s: { ...s, index: i } };
  $('card').hidden = false;
}

function closeCard() {
  card = null;
  $('card').hidden = true;
}

$('card-fly').addEventListener('click', () => card && flyTo(card.s));
$('card-close').addEventListener('click', closeCard);

/* ---- input ------------------------------------------------------------- */

const pointers = new Map();
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, moved: 0, ox: e.offsetX, oy: e.offsetY });
  autopilot = null;
  $('hint').dataset.gone = 'true';
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;
  p.moved += Math.hypot(dx, dy);
  // Drag the sky: it follows the hand, as on the front page.
  const perPx = (FOV * Math.PI / 180) / canvas.clientHeight;
  cam.F = rotate(cam.F, cam.U, dx * perPx);
  const R = cross(cam.F, cam.U);
  cam.F = rotate(cam.F, R, dy * perPx);
  cam.U = rotate(cam.U, R, dy * perPx);
  orthonormal();
});
canvas.addEventListener('pointerup', (e) => {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  // A press that did not drag is a choice of star.
  if (p && p.moved < 5 && stars && proj) {
    const i = pickAt(p.ox, p.oy);
    if (i >= 0) openCard({ index: i });
    else closeCard();
  }
});
canvas.addEventListener('pointercancel', (e) => pointers.delete(e.pointerId));

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  setSpeed(cam.speed * Math.exp(-e.deltaY / 500));
}, { passive: false });

function setSpeed(v) {
  cam.speed = Math.max(SPEED_MIN * 1e-3, Math.min(SPEED_MAX, v));
}

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input')) return;
  if (e.code === 'Escape') closeCard();
  keys.add(e.code);
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setSpeed(cam.speed * 2);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') setSpeed(cam.speed / 2);
  if (e.code.startsWith('Arrow')) e.preventDefault();
  if (['KeyW', 'KeyS', 'KeyA', 'KeyD'].includes(e.code) || e.code.startsWith('Arrow')) autopilot = null;
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
  if (card) openCard(card.s);
}
$('lang').addEventListener('click', () => {
  setLanguage(getLanguage() === 'en' ? 'ru' : 'en');
  try { localStorage.setItem('muninn.lang', getLanguage()); } catch { /* private window */ }
  applyLanguage();
});

applyLanguage();
readHash();
const [data, skyImage] = await Promise.all([loadStars(), loadSky()]);
space = createSpace(canvas, { stars: data.stars, sky: skyImage });
if (!space) {
  $('nogl').hidden = false;
} else {
  stars = data.stars;
  sunIndex = data.sun;
  named = data.named;
  starCount = data.count;
  buildLabels();
  applyLanguage();
  setTimeout(() => { $('hint').dataset.gone = 'true'; }, 9000);
  requestAnimationFrame(frame);
}

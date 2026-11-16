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
import { embedded, goTo } from './embed.js';
import { systemUrl } from './exovision.js';
import { radecOf } from './allsky/healpix.js';
import { createSpace, screenOf } from './fly/space.js';
import { temperatureOf, luminosityOf, radiusOf, vMinusW2, R_SUN_PC, T_SUN } from './fly/stars.js';
import { solarSystem, AU_PC } from './fly/solar.js';
import { shells, planetNineShortfall, WISE0855_AB, WISE0855_PC, D6_ONE_VISIT_AB, PLANET_NINE_V, PLANET_NINE_AU, PLANET_NINE_MAX_BETA } from './fly/reach.js';

const $ = (id) => document.getElementById(id);
const LY_PER_PC = 3.26156;
const AU_PER_PC = 206264.806;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The field of view, vertical, degrees: the front page's opening width. */
const FOV = 70;
/** Speed bounds, parsecs a second: from a few AU a second to a kiloparsec in ten seconds. */
const SPEED_MIN = 0.00005;
const SPEED_MAX = 100;
/**
 * How fast "forward" is: this many times the distance to the nearest surface,
 * each second. Beside the Moon that is kilometres a second, among the stars
 * light years: the speed suits the scale wherever the camera is.
 */
const FACTOR_MIN = 0.02;
const FACTOR_MAX = 20;
let factor = 0.5;
/** Distance from the camera to the nearest body's surface, parsecs; worked out each frame. */
let gap = 1;
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

  // The catalogue, the Sun, WISE 0855 (a body the eye cannot see at all), and
  // the planets and the Moon where they are today.
  const bodies = solarSystem();
  const n = stored + 2 + bodies.length;
  const stars = {
    pos: new Float32Array(n * 3), mag: new Float32Array(n), col: new Float32Array(n * 3),
    rad: new Float32Array(n), bv: new Float32Array(n), hip: new Int32Array(n), measured: new Uint8Array(n),
    ir: new Float32Array(n),
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
    // Absolute brightness at 4.6 µm, from the colour as a blackbody: an estimate.
    stars.ir[i] = m - vMinusW2(temperatureOf(bv));
  };
  for (let i = 0; i < stored; i++) put(i, xyz.subarray(i * 3, i * 3 + 3), look[i * 2] / 100, look[i * 2 + 1] / 1000, hipOf[i]);
  // The Sun, which a catalogue of stars seen from it lacks.
  put(stored, [0, 0, 0], 4.83, 0.65, 0);
  stars.rad[stored] = 1;
  stars.measured[stored] = 1;
  // WISE 0855 at its parallax: invisible in V, and at 4.6 µm as measured,
  // W2 ≈ 13.9 at 2.28 pc, which is an absolute W2 of about 17.1.
  const wise = info.named.find((s) => s.key === 'wise0855');
  const wiseIndex = stored + 1;
  if (wise) {
    stars.pos.set(wise.pos, wiseIndex * 3);
    stars.mag[wiseIndex] = 40;
    stars.ir[wiseIndex] = 13.9 - 5 * Math.log10(WISE0855_PC / 10);
    stars.col.set([1, 0.35, 0.25], wiseIndex * 3);
    stars.rad[wiseIndex] = 0.1;
    stars.bv[wiseIndex] = NaN;
  }
  stars.dark = wise ? wiseIndex : -1;
  const lit = new Uint8Array(n);
  stars.firstBody = stored + 2;
  bodies.forEach((b, k) => {
    const i = stored + 2 + k;
    stars.pos.set(b.pos, i * 3);
    stars.mag[i] = b.absMag;
    stars.ir[i] = b.absMag;
    stars.col.set(b.col, i * 3);
    stars.rad[i] = b.radius;
    stars.bv[i] = NaN;
    stars.measured[i] = 1;
    lit[i] = 1;
  });
  stars.lit = lit;
  stars.ringed = stored + 2 + bodies.findIndex((b) => b.key === 'saturn');
  const indexOfHip = new Map();
  for (let i = 0; i < stored; i++) indexOfHip.set(hipOf[i], i);
  const named = info.named.map((s) => ({
    ...s,
    index: s.key === 'sun' ? stored : s.key === 'wise0855' ? wiseIndex : indexOfHip.get(s.hip) ?? -1,
  }));
  bodies.forEach((b, k) => named.push({ key: b.key, en: b.en, ru: b.ru, planet: true, km: b.km, index: stored + 2 + k }));
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
const KM_PER_PC = 3.0856775814913673e13;
function distanceText(pc) {
  const l = ly(pc);
  // Beside a planet AU are too coarse: kilometres, as a spacecraft would say.
  if (pc * AU_PER_PC < 0.01) return t('fly.km', { n: fmt(pc * KM_PER_PC, 0) });
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
/** Whether the address said where the camera is. */
let hashPlaced = false;
/** The reach shells and Planet Nine's region on screen; the sky at 4.6 µm instead of in V. */
const view = { reach: false, ir: false };
let last = performance.now();
const keys = new Set();
const hold = { forward: false, back: false };

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const xyz = ['x', 'y', 'z'].map((k) => Number(p.get(k)));
  if (xyz.every(Number.isFinite)) {
    cam.eye = xyz;
    hashPlaced = true;
  }
  // Opened from the front page: facing where its sky faced.
  const look = (p.get('look') ?? '').split(',').map(Number);
  if (look.length === 2 && look.every(Number.isFinite)) {
    cam.F = direction(look[0], look[1]);
    cam.U = [0, 0, 1];
    orthonormal();
  }
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    // Exponent form: beside the Moon a millionth of a parsec is too coarse.
    const p = new URLSearchParams({ x: cam.eye[0].toExponential(10), y: cam.eye[1].toExponential(10), z: cam.eye[2].toExponential(10) });
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
  const p9 = document.createElement('button');
  p9.type = 'button';
  p9.className = 'as-band fly-chip--target';
  p9.textContent = nameOf(P9);
  p9.addEventListener('click', () => { flyToPlanetNine(); openCardLater(P9); });
  chips.append(p9);
  const order = ['earth', 'moon', 'mars', 'jupiter', 'saturn', 'wise0855', 'hip70890', 'hip87937', 'hip32349', 'hip108870', 'hip91262', 'hip27989', 'hip17702', 'hip11767', 'sun'];
  for (const key of order) {
    const s = named.find((x) => x.key === key);
    if (!s) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `as-band${s.target ? ' fly-chip--target' : ''}`;
    b.textContent = nameOf(s);
    b.addEventListener('click', () => { flyTo(s); openCardLater(s); });
    chips.append(b);
  }
}

/* ---- the autopilot ----------------------------------------------------- */

/** The radius of a destination in parsecs. */
const radiusPc = (s) => (s.index >= 0 ? stars.rad[s.index] : s.radius ?? 1) * R_SUN_PC;

/** Fly to a star, stopping a few of its own radii from it. */
function flyTo(s) {
  closeCard();
  carried = null;
  const to = placeOf(s);
  const away = len(sub(cam.eye, to));
  // A star with no light to see (WISE 0855) is approached less closely: a
  // disc the eye could not see would be a black hole in the stars.
  // WISE 0855 gives no light to see: the autopilot stops a thousand AU
  // out, near enough that at 4.6 µm it is one of the brightest things in the
  // sky, far enough that in visible light the ring shows a place, not a disc.
  // Every star is approached to the same distance, five AU (Jupiter's from
  // the Sun), or six of its radii if it is bigger than that: arriving at a
  // fixed number of radii made a supergiant and a dwarf look the same size.
  // A planet or the Moon, six radii.
  const stop = s.key === 'wise0855' ? 0.005
    : s.planet ? radiusPc(s) * STOP_RADII
      : Math.max(radiusPc(s) * STOP_RADII, 5 * AU_PC);
  const dir = norm(sub(to, cam.eye));
  let end = away > stop ? add(to, dir, -stop) : cam.eye;
  // A planet or the Moon is approached from sixty degrees off the Sun's side:
  // its day side, its terminator and a sliver of night all show.
  let offset = null;
  if (s.planet) {
    const toSun = norm(sub([0, 0, 0], to));
    let across = cross(toSun, [0, 0, 1]);
    if (len(across) < 1e-6) across = [1, 0, 0];
    across = norm(across);
    offset = norm(add(toSun.map((c) => c * 0.5), across, 0.866)).map((c) => c * stop);
    // Saturn a little from above its rings, so they open out.
    if (s.key === 'saturn') offset = norm(add(offset, SATURN_RINGS.pole, 0.45 * stop)).map((c) => c * stop * 1.6);
    end = add(to, offset);
  }
  if (s.key === 'wise0855') showReach();
  autopilot = {
    home: s.key === 'earth',
    offset,
    // A planet moves while the camera flies to it: the end is followed.
    body: s.planet ? s.index : -1,
    from: cam.eye, to: end, look: to, stop, t0: performance.now(),
    ms: reduceMotion ? 1 : 3000 + 400 * Math.log10(1 + away / Math.max(stop, 1e-12)),
  };
  $('hint').dataset.gone = 'true';
}

function steer(dt) {
  if (stepPullOut()) return;
  if (autopilot?.follow) {
    const to = autopilot.follow();
    if (to) {
      autopilot.to = add(to, norm(sub(autopilot.to, autopilot.look)), autopilot.stop);
      autopilot.look = to;
    }
  }
  if (autopilot && autopilot.body >= 0) {
    const to = posOf(autopilot.body);
    if (autopilot.offset) {
      autopilot.to = add(to, autopilot.offset);
    } else {
      const dir = norm(sub(to, autopilot.from));
      autopilot.to = add(to, dir, -autopilot.stop);
    }
    autopilot.look = to;
  }
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
      // Home: arriving at the Earth puts you back on its sky.
      if (autopilot.home && embedded) {
        autopilot = null;
        landOnEarth();
        return;
      }
      // Arrived: slow enough to fly round the star rather than past it.
      factor = 0.5;
      if (autopilot.body >= 0) carried = { index: autopilot.body, offset: sub(cam.eye, posOf(autopilot.body)) };
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
    carried = null;
    const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5 : 1;
    const R = cross(cam.F, cam.U);
    const v = currentSpeed() * boost * dt;
    cam.eye = add(add(cam.eye, cam.F, move * v), R, side * v);
    writeHash();
  }
}

/* ---- the near star ----------------------------------------------------- */

/**
 * The bodies drawn as spheres at their real size: every one whose disc is at
 * least half a pixel across from here (the Sun from anywhere in the Solar
 * System, a planet from near it), and always the two largest, up to twelve.
 * The rest are too small to have a size on the screen and are points.
 */
/**
 * Saturn's rings, in units of its mean radius (58,232 km): the C ring's inner
 * edge at 74,500 km to the A ring's outer edge at 136,780 km, with the
 * Cassini division, 117,580–122,170 km, as a gap; in the plane of its
 * equator, whose pole is at RA 40.589°, Dec 83.537° (IAU).
 */
const SATURN_RINGS = (() => {
  const r = 58232;
  const ra = 40.589 * Math.PI / 180;
  const dec = 83.537 * Math.PI / 180;
  return {
    ring: [74500 / r, 136780 / r, 117580 / r, 122170 / r],
    pole: [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)],
  };
})();

const TOP = 12;
const topK = new Float64Array(TOP);
const topI = new Int32Array(TOP);

function nearestStar() {
  const [ex, ey, ez] = cam.eye;
  const p = stars.pos;
  const rad = stars.rad;
  // The same pixel density the sky is drawn at (space.js), so "half a pixel" means it.
  const dpr = Math.min(devicePixelRatio || 1, matchMedia('(pointer: coarse)').matches ? 1.5 : 2);
  const focalPx = (canvas.clientHeight * dpr / 2) / Math.tan((FOV * Math.PI) / 360);
  // The twelve largest discs, kept in place in typed arrays: no array per
  // star, no sort per frame (this ran at 15 ms a frame on a desktop).
  topK.fill(0);
  topI.fill(-1);
  let nearestGap = Infinity;
  const n = stars.mag.length;
  for (let i = 0; i < n; i++) {
    // WISE 0855 has no light to see: it is never a disc.
    if (i === stars.dark) continue;
    const dx = p[i * 3] - ex;
    const dy = p[i * 3 + 1] - ey;
    const dz = p[i * 3 + 2] - ez;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz + 1e-40);
    const r = rad[i] * R_SUN_PC;
    const surface = dist - r;
    if (surface < nearestGap) nearestGap = surface;
    // The camera inside a body (a flight can pass through one): not drawn round it.
    if (dist < r) continue;
    const k = rad[i] / dist;
    if (k <= topK[TOP - 1]) continue;
    let at = TOP - 1;
    while (at > 0 && topK[at - 1] < k) {
      topK[at] = topK[at - 1];
      topI[at] = topI[at - 1];
      at--;
    }
    topK[at] = k;
    topI[at] = i;
  }
  gap = Number.isFinite(nearestGap) ? Math.max(nearestGap, 1e-12) : 1;
  const chosen = [];
  const F = cam.F;
  for (let s = 0; s < TOP; s++) {
    const i = topI[s];
    if (i < 0) break;
    const discPx = topK[s] * R_SUN_PC * focalPx;
    if (s >= 2 && discPx < 0.5) break;
    // Behind the eye a sphere would cost a full-screen pass for nothing.
    const dx = p[i * 3] - ex;
    const dy = p[i * 3 + 1] - ey;
    const dz = p[i * 3 + 2] - ez;
    const dist = Math.hypot(dx, dy, dz);
    if ((dx * F[0] + dy * F[1] + dz * F[2]) < -rad[i] * R_SUN_PC && dist > 0) continue;
    chosen.push(i);
  }
  return chosen.map((i) => ({
    index: i,
    pos: posOf(i),
    rpc: stars.rad[i] * R_SUN_PC,
    col: [stars.col[i * 3], stars.col[i * 3 + 1], stars.col[i * 3 + 2]],
    lit: Boolean(stars.lit[i]),
    ...(i === stars.ringed ? SATURN_RINGS : {}),
  }));
}

/* ---- the readout and labels ------------------------------------------- */

/** Speed in the unit that suits it: km/s near planets, AU/s in the Solar System, ly/s among the stars. */
function speedText(pcPerS) {
  if (pcPerS * AU_PER_PC < 0.01) return t('fly.speedKm', { v: fmt(pcPerS * KM_PER_PC, 0) });
  if (ly(pcPerS) < 0.01) return t('fly.speedAu', { v: fmt(pcPerS * AU_PER_PC, 2) });
  return t('fly.speed', { v: fmt(ly(pcPerS), ly(pcPerS) < 1 ? 2 : 1) });
}

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
    speedText(currentSpeed()),
    nearName && t('fly.nearest', { name: nameOf(nearName), d: distanceText(nearD) }),
  ].filter(Boolean).join('  ·  ');
}

function placeLabels() {
  const b = basis();
  const kept = [];
  for (const { s, el } of labels) {
    const at = screenOf(placeOf(s), b, proj);
    // A star seen as a large disc needs no ring and name on top of it.
    const ln = (lastNear ?? []).find((x) => x.index === s.index);
    const big = ln && (ln.rpc / len(sub(ln.pos, cam.eye))) * proj.focal[1] * (proj.h / proj.dpr) / 2 > 24;
    // A planet's name only near the Sun: from the stars the planets are one point.
    const far = s.planet && len(cam.eye) > 0.01;
    // Behind a nearer disc: hidden by it.
    const behind = at && (lastNear ?? []).some((n) => {
      if (n.index === s.index) return false;
      const dn = len(sub(n.pos, cam.eye));
      if (dn >= len(sub(placeOf(s), cam.eye))) return false;
      const c = screenOf(n.pos, b, proj);
      const r = (n.rpc / dn) * proj.focal[1] * (proj.h / proj.dpr) / 2;
      return c && Math.hypot(c.x - at.x, c.y - at.y) < r;
    });
    el.hidden = !at || big || far || behind;
    if (!at) continue;
    el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
    el.dataset.x = at.x;
    el.dataset.y = at.y;
    el.querySelector('.fly-label__far').textContent = distanceText(len(sub(placeOf(s), cam.eye)));
    kept.push({ el, at, d: len(sub(placeOf(s), cam.eye)) });
  }
  // Two names on one spot are read as neither: the nearer body keeps its own.
  kept.sort((p, q) => p.d - q.d);
  const shown = [];
  for (const k of kept) {
    if (shown.some((o) => Math.abs(o.at.x - k.at.x) < 150 && Math.abs(o.at.y - k.at.y) < 16)) k.el.hidden = true;
    else shown.push(k);
  }
}

/* ---- time ------------------------------------------------------------ */

/*
 * The planets and the Moon move as they do, now: their positions are worked
 * out for this moment, every frame, from the same orbital elements. Time runs
 * at its own pace and no other; the stars' own motions are too slow to see.
 */
function moveBodies() {
  const bodies = solarSystem(new Date());
  const first = stars.firstBody;
  const xyz = new Float32Array(bodies.length * 3);
  bodies.forEach((b, k) => {
    xyz.set(b.pos, k * 3);
    stars.pos.set(b.pos, (first + k) * 3);
  });
  space.movePositions(first, xyz);
  // A camera riding with the Earth or the Moon is carried with it, near it.
  if (carried) {
    const now = posOf(carried.index);
    cam.eye = add(now, carried.offset);
  }
}

/** The body the camera stopped beside, so time moving it does not leave the camera behind. */
let carried = null;

/**
 * Inside the front page this layer is hidden most of the time, and a hidden
 * frame loop cost the front page nine tenths of its frame time: it stops
 * while hidden and starts again when shown.
 */
let paused = embedded;
let looping = false;
addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.type === 'muninn:pause') paused = true;
  if (e.data?.type === 'muninn:resume' && paused) {
    paused = false;
    last = performance.now();
    if (!looping) requestAnimationFrame(frame);
  }
});

let movedAt = 0;
function frame(now) {
  if (paused) {
    looping = false;
    return;
  }
  looping = true;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  // The planets move slowly enough that four times a second is real time.
  if (now - movedAt > 250) {
    movedAt = now;
    moveBodies();
  }
  steer(dt);
  lastNear = nearestStar();
  const extra = drawSystem();
  const near = view.ir ? null : [...extra, ...lastNear].slice(0, 12);
  proj = space.draw({ ...basis(), fov: FOV, near, ir: view.ir, show: () => view.reach });
  placeLabels();
  placeExoLabels();
  placeSystemLabels();
  placeMarks();
  readout();
  requestAnimationFrame(frame);
}

/* ---- a star's card ----------------------------------------------------- */

/** The star under a point of the canvas: the brightest-looking within a few pixels. */
function pickAt(px, py) {
  const b = basis();
  // On the near star's disc: that star.
  for (const ln of lastNear ?? []) {
    const c = screenOf(ln.pos, b, proj);
    const d = len(sub(ln.pos, cam.eye));
    const rPx = (ln.rpc / d) * proj.focal[1] * (proj.h / proj.dpr) / 2;
    if (c && Math.hypot(c.x - px, c.y - py) <= Math.max(rPx, 0)) return ln.index;
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
  if (s.key === 'wise0855') {
    const seenTo = shells();
    rows.unshift([t('fly.cardVerdict'), t('fly.verdict', { n: seenTo[1].visits })]);
    rows.push([t('fly.cardW2'), t('fly.w2', { ab: fmt(WISE0855_AB, 1) })]);
    rows.push([t('fly.cardOne'), t('fly.limitOne', { ab: fmt(D6_ONE_VISIT_AB, 1), d: distanceText(seenTo[0].pc) })]);
    rows.push([t('fly.cardStack'), t('fly.limitStack', { n: seenTo[1].visits, ab: fmt(seenTo[1].limit, 1), d: distanceText(seenTo[1].pc) })]);
  } else if (s.key === 'p9') {
    rows.length = 0;
    rows.push([t('fly.cardP9Where'), t('fly.p9Where', { a: PLANET_NINE_AU[0], b: PLANET_NINE_AU[1], beta: PLANET_NINE_MAX_BETA })]);
    rows.push([t('fly.cardP9Bright'), t('fly.p9Bright', { lo: fmt(PLANET_NINE_V.bright, 1), hi: fmt(PLANET_NINE_V.faint, 1) })]);
    rows.push([t('fly.cardP9Gap'), t('fly.p9Gap', { x: fmt(planetNineShortfall(17.6), 0) })]);
  } else if (s.planet) {
    rows.push([t('fly.cardRadius'), t('fly.planetRadius', { km: fmt(s.km, 0), e: sig(s.km / 6371.0) })]);
    rows.push([t('fly.cardSunAU'), t('fly.au', { n: fmt(fromSun / AU_PC, 2) })]);
  } else if (i >= 0) {
    const m = stars.mag[i];
    const bv = stars.bv[i];
    rows.push([t('fly.cardTemp'), t('fly.kelvin', { n: fmt(Math.round(temperatureOf(bv) / 10) * 10, 0) })]);
    rows.push([t('fly.cardRadius'), t(stars.measured[i] ? 'fly.radiusMeasured' : 'fly.radiusEstimated', { n: sig(stars.rad[i]) })]);
    // With a measured radius, the luminosity follows from it and the
    // temperature; the magnitude's bolometric correction is weakest for the
    // coolest stars, which are the largest.
    const lum = stars.measured[i] ? stars.rad[i] ** 2 * (temperatureOf(bv) / T_SUN) ** 4 : luminosityOf(m, bv);
    rows.push([t('fly.cardLum'), t('fly.solar', { n: sig(lum) })]);
    if (i !== sunIndex) rows.push([t('fly.cardMag'), fmt(m + 5 * Math.log10(fromSun / 10), 2)]);
  } else if (s.radius) {
    rows.push([t('fly.cardRadius'), t('fly.radiusModel', { n: sig(s.radius) })]);
  }
  $('card-title').textContent = title;
  if (s.planet) rows.splice(0, 1);
  $('card-note').textContent = s.planet ? t('fly.planetNote') : s.key === 'wise0855'
    ? t('fly.dark')
    : s.key === 'p9' ? t('fly.p9Note')
    : i >= 0 && i !== sunIndex ? `HIP ${stars.hip[i]} · ${t('fly.cardSource')}` : '';
  $('card-rows').replaceChildren(...rows.map(([k, v]) => cardRow(k, v)));
  // SPHEREx looks from beside the Earth: a star's place on its sky is its
  // direction from the Sun. The Sun itself has none.
  // A planet moves across the sky: there is no one field of it to open.
  const sky = fromSun > 0 && s.key !== 'p9' && !s.planet ? radecOf(p) : null;
  const frames = $('card-frames');
  frames.hidden = !sky;
  if (sky) {
    const url = new URL('./', location.href);
    url.hash = encodeHash({ ra: sky.ra, dec: sky.dec, fov: 0.3, band: s.key === 'wise0855' ? 'D6' : 'D2', lang: getLanguage(), name: title });
    frames.href = url.href;
  }
  const host = i >= 0 ? exo.find((x) => x.index === i) : null;
  // A star with planets is shown as the system it is.
  if (host && !entry.starOnly) {
    openSystemCard(host);
    return;
  }
  const ev = $('card-exo');
  ev.hidden = !host;
  if (host) {
    rows.push([t('exo.has'), host.planets.map((pl) => pl.name).join(', ')]);
    $('card-rows').replaceChildren(...rows.map(([k, v]) => cardRow(k, v)));
    ev.href = systemUrl([host.ra, host.dec, host.planets.length, host.host], host.host, getLanguage());
  }
  card = { s: { ...s, index: i } };
  $('card').hidden = false;
}

/** The card for a place that is not a star, shown once the autopilot has arrived. */
function openCardLater(entry) {
  const wait = () => (autopilot ? requestAnimationFrame(wait) : openCard(entry));
  requestAnimationFrame(wait);
}

function closeCard() {
  card = null;
  $('card-exo').hidden = true;
  $('card').hidden = true;
}

$('card-fly').addEventListener('click', () => card && (card.s.sys ? flyToSystem(card.s.sys) : flyTo(card.s)));
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
  setFactor(factor * Math.exp(-e.deltaY / 500));
}, { passive: false });

/** Parsecs a second, now. */
function currentSpeed() {
  return Math.max(1e-12, Math.min(SPEED_MAX, factor * gap));
}

function setFactor(v) {
  factor = Math.max(FACTOR_MIN, Math.min(FACTOR_MAX, v));
}

function setSpeed(v) {
  cam.speed = Math.max(SPEED_MIN * 1e-3, Math.min(SPEED_MAX, v));
}

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input')) return;
  if (e.code === 'Escape') closeCard();
  keys.add(e.code);
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setFactor(factor * 2);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') setFactor(factor / 2);
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
$('faster').addEventListener('click', () => setFactor(factor * 3));
$('slower').addEventListener('click', () => setFactor(factor / 3));

/* ---- what SPHEREx can reach, and where Planet Nine would be --------- */

const AU = 1 / 206264.806;
/** The ecliptic's pole in ICRS, for the planets' plane. */
const ECL = 23.4393 * Math.PI / 180;
const eclipticPoint = (r, lonDeg, latDeg = 0) => {
  const l = (lonDeg * Math.PI) / 180;
  const b = (latDeg * Math.PI) / 180;
  const x = Math.cos(b) * Math.cos(l);
  const y = Math.cos(b) * Math.sin(l);
  const z = Math.sin(b);
  return [r * x, r * (y * Math.cos(ECL) - z * Math.sin(ECL)), r * (y * Math.sin(ECL) + z * Math.cos(ECL))];
};

/** A circle as segment ends, from a function of angle in degrees. */
function ring(at, steps = 120) {
  const out = [];
  for (let k = 0; k < steps; k++) out.push(...at((k * 360) / steps), ...at(((k + 1) * 360) / steps));
  return out;
}

/** A wire sphere round the Sun, in the ecliptic's frame: latitudes every 30°, longitudes every 45°. */
function wireSphere(r) {
  const out = [];
  for (const lat of [-60, -30, 0, 30, 60]) out.push(...ring((lon) => eclipticPoint(r, lon, lat)));
  for (let lon = 0; lon < 180; lon += 45) out.push(...ring((a) => eclipticPoint(r, lon + (a > 180 ? 180 : 0), a > 180 ? 360 - a - 90 : a - 90)));
  return out;
}

/** The marks that go with the lines: places with words, not stars. */
let marks = [];
function buildReach() {
  const [one, stack] = shells();
  space.setLines([
    { data: new Float32Array(wireSphere(one.pc)), ink: [0.55, 0.8, 1, 0.22], key: 'reach' },
    { data: new Float32Array(wireSphere(stack.pc)), ink: [1, 0.72, 0.4, 0.22], key: 'reach' },
    { data: new Float32Array(ring((l) => eclipticPoint(30 * AU, l))), ink: [0.7, 0.8, 1, 0.5], key: 'reach' },
    { data: new Float32Array([
      ...ring((l) => eclipticPoint(PLANET_NINE_AU[0] * AU, l)),
      ...ring((l) => eclipticPoint(PLANET_NINE_AU[1] * AU, l)),
      ...ring((l) => eclipticPoint(PLANET_NINE_AU[0] * AU, l, PLANET_NINE_MAX_BETA)),
      ...ring((l) => eclipticPoint(PLANET_NINE_AU[0] * AU, l, -PLANET_NINE_MAX_BETA)),
    ]), ink: [1, 0.72, 0.4, 0.55], key: 'reach' },
  ]);
  marks = [
    { at: () => onSphere(one.pc), text: () => t('fly.shellOne', { d: distanceText(one.pc) }) },
    { at: () => onSphere(stack.pc), text: () => t('fly.shellStack', { n: stack.visits, d: distanceText(stack.pc) }) },
    { at: () => onRing(30 * AU), text: () => t('fly.neptune') },
    { at: () => onRing(PLANET_NINE_AU[1] * AU), text: () => t('fly.p9Ring') },
  ];
  $('marks').replaceChildren(...marks.map((m) => {
    const el = document.createElement('span');
    el.className = 'fly-mark';
    m.el = el;
    return el;
  }));
}

/**
 * Where a word for a sphere round the Sun goes: the point of it a little
 * above the middle of the view, so the eye finds it whichever way it looks.
 */
function onSphere(r) {
  const d = norm(add(cam.F, cam.U, 0.35));
  // |eye + d t| = r, the far crossing.
  const bq = dot(cam.eye, d);
  const disc = bq * bq - (dot(cam.eye, cam.eye) - r * r);
  if (disc < 0) return null;
  return add(cam.eye, d, -bq + Math.sqrt(disc));
}

/** Where a word for a ring in the planets' plane goes: its point nearest the middle of the view. */
function onRing(r) {
  let best = null;
  let bestK = -Infinity;
  for (let l = 0; l < 360; l += 5) {
    const p = eclipticPoint(r, l);
    const k = dot(norm(sub(p, cam.eye)), cam.F);
    if (k > bestK) { bestK = k; best = p; }
  }
  return best;
}

function placeMarks() {
  const b = basis();
  const placedMarks = [];
  for (const m of marks) {
    const pos = view.reach ? m.at() : null;
    const at = pos ? screenOf(pos, b, proj) : null;
    // A mark on top of a star's label would be read as neither.
    const crowded = at && labels.some(({ s, el }) => {
      if (el.hidden) return false;
      const p = screenOf(placeOf(s), b, proj);
      return p && Math.abs(p.x - at.x) < 60 && Math.abs(p.y - at.y) < 14;
    });
    // Nor on a disc, nor on another mark.
    const onDisc = at && (lastNear ?? []).some((n) => {
      const c = screenOf(n.pos, b, proj);
      const r = (n.rpc / len(sub(n.pos, cam.eye))) * proj.focal[1] * (proj.h / proj.dpr) / 2;
      return c && Math.hypot(c.x - at.x, c.y - at.y) < r + 12;
    });
    const stacked = at && placedMarks.some((o) => Math.abs(o.x - at.x) < 220 && Math.abs(o.y - at.y) < 18);
    m.el.hidden = !at || crowded || onDisc || stacked;
    if (m.el.hidden) continue;
    placedMarks.push(at);
    m.el.textContent = m.text();
    m.el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
  }
}

/** Planet Nine's region as a destination: above the Sun's plane, looking down on it. */
const P9 = { key: 'p9', index: -1, pos: eclipticPoint(1, 0, 0).map(() => 0), en: 'Planet Nine (region)', ru: 'Планета Девять (зона)' };
function showReach() {
  view.reach = true;
  $('reach').setAttribute('aria-pressed', 'true');
}

function flyToPlanetNine() {
  closeCard();
  const above = eclipticPoint(2400 * AU, 200, 55);
  autopilot = { from: cam.eye, to: above, look: [0, 0, 0], stop: 300 * AU, t0: performance.now(), ms: reduceMotion ? 1 : 3600 };
  view.reach = true;
  $('reach').setAttribute('aria-pressed', 'true');
}

$('reach').addEventListener('click', () => {
  view.reach = !view.reach;
  $('reach').setAttribute('aria-pressed', String(view.reach));
});
$('ir').addEventListener('click', () => {
  view.ir = !view.ir;
  $('ir').setAttribute('aria-pressed', String(view.ir));
  $('read-note').textContent = view.ir ? t('fly.irNote') : '';
});

// Inside the front page: out from the Earth, facing where its sky faced.
/** A direction asked for before the stars had loaded: applied once they have. */
let pendingLook = null;
addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'muninn:look') return;
  const { ra, dec } = e.data;
  if (![ra, dec].every(Number.isFinite)) return;
  if (!stars) {
    pendingLook = { ra, dec };
    return;
  }
  lookFromEarth(ra, dec);
});

function lookFromEarth(ra, dec) {
  autopilot = null;
  closeCard();
  cam.F = direction(ra, dec);
  cam.U = [0, 0, 1];
  orthonormal();
  const earth = named.find((x) => x.key === 'earth');
  if (earth) {
    const at = posOf(earth.index);
    const r = stars.rad[earth.index] * R_SUN_PC;
    cam.eye = add(at, cam.F, 1.2 * r);
    carried = { index: earth.index, offset: sub(cam.eye, at) };
    // Leaving the Earth's sky: the camera backs away along the way it was
    // looking and turns round, so the Earth it left comes into view, with the
    // Moon if it is near that side, and the flight starts from there.
    if (!reduceMotion) pullOut = { earth: earth.index, r, F0: cam.F, t0: performance.now(), ms: 3200 };
  }
  factor = 0.5;
}

/** The leaving of the Earth, while it runs. */
let pullOut = null;

function stepPullOut() {
  if (!pullOut) return false;
  const x = Math.min(1, (performance.now() - pullOut.t0) / pullOut.ms);
  const e = x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
  const at = posOf(pullOut.earth);
  // Out to seven Earth radii, a little to the side: the Earth fills a third of the view.
  const side = norm(cross(pullOut.F0, [0, 0, 1]));
  const out = add(add(at, pullOut.F0, pullOut.r * (1.2 + 5.8 * e)), side, pullOut.r * 1.6 * e);
  cam.eye = out;
  // Turning round over the second half: from the sky ahead to the Earth behind.
  const turn = Math.max(0, (x - 0.25) / 0.75);
  const te = turn < 0.5 ? 2 * turn * turn : 1 - (-2 * turn + 2) ** 2 / 2;
  const toEarth = norm(sub(at, cam.eye));
  cam.F = norm(add(pullOut.F0, sub(toEarth, pullOut.F0), te));
  if (len(cam.F) < 0.5) cam.F = toEarth;
  orthonormal();
  carried = { index: pullOut.earth, offset: sub(cam.eye, at) };
  if (x >= 1) pullOut = null;
  return true;
}

/** On the Earth again: its sky, facing where the camera faces. */
function landOnEarth() {
  const { ra, dec } = radecOf(cam.F);
  goTo('sky', { ra, dec });
}

/* ---- other stars' planets --------------------------------------------- */

/*
 * Every confirmed exoplanet system with a known distance (NASA Exoplanet
 * Archive, pscomppars), native here: the stars that have planets are marked,
 * and near one its planets are drawn at their real sizes on their real
 * orbits. Where a transit time was measured the planet is where it is now
 * (circular orbit, edge-on to the Sun, as a transit requires); elsewhere only
 * the orbit is drawn, with no planet put at a guessed place.
 */
const R_EARTH_PC = 6371 / 3.0856775814913673e13;
let exo = [];
/** The system the camera is in, and what was drawn for it this frame. */
let inSystem = null;

async function loadSystems() {
  try {
    const res = await fetch('data/fly/exoplanets.json');
    if (!res.ok) return;
    const body = await res.json();
    exo = body.systems ?? [];
    // A host that is a Hipparcos star is centred on the catalogue's star, so
    // its planets circle the disc drawn for it.
    for (const sys of exo) {
      sys.index = matchHost(sys);
      sys.center = sys.index >= 0 ? posOf(sys.index) : sys.pos;
    }
    buildExoLabels();
  } catch { /* the flight goes on without them */ }
}

/**
 * The Hipparcos stars by whole degree of RA and Dec, built once: matching
 * five thousand hosts against sixty thousand stars one by one was three
 * hundred million tests.
 */
let starCells = null;
function cellKey(ra, dec) { return `${Math.floor(ra)}:${Math.floor(dec + 90)}`; }
function buildCells() {
  starCells = new Map();
  const p = stars.pos;
  for (let i = 0; i < stars.firstBody - 2; i++) {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    const d = Math.hypot(x, y, z);
    if (!(d > 0)) continue;
    let ra = Math.atan2(y, x) * 180 / Math.PI;
    if (ra < 0) ra += 360;
    const dec = Math.asin(z / d) * 180 / Math.PI;
    const key = cellKey(ra, dec);
    if (!starCells.has(key)) starCells.set(key, []);
    starCells.get(key).push(i);
  }
}

/**
 * The Hipparcos star that is this host: within three arcminutes on the sky
 * (Hipparcos positions are for 1991, and the nearest stars have moved that
 * far since) and a fifth in distance.
 */
function matchHost(sys) {
  if (!starCells) buildCells();
  const u = norm(sys.pos);
  let best = -1;
  let bestCos = Math.cos((180 / 3600) * Math.PI / 180);
  const p = stars.pos;
  for (const dra of [-1, 0, 1]) {
    for (const ddec of [-1, 0, 1]) {
      const list = starCells.get(cellKey(((sys.ra + dra) % 360 + 360) % 360, sys.dec + ddec));
      if (!list) continue;
      for (const i of list) {
        const x = p[i * 3];
        const y = p[i * 3 + 1];
        const z = p[i * 3 + 2];
        const d = Math.hypot(x, y, z);
        if (Math.abs(d - sys.pc) > 0.2 * sys.pc) continue;
        const c = (x * u[0] + y * u[1] + z * u[2]) / d;
        if (c > bestCos) { bestCos = c; best = i; }
      }
    }
  }
  return best;
}

let exoLabels = [];
function buildExoLabels() {
  // Rings for the nearest few systems in view; placed each frame.
  exoLabels = Array.from({ length: 10 }, () => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'fly-label fly-label--exo';
    el.hidden = true;
    el.innerHTML = '<span class="fly-label__dot"></span><span class="fly-label__name"></span><span class="fly-label__far num"></span>';
    el.addEventListener('click', () => { if (el.sys) openSystemCard(el.sys); });
    $('labels').append(el);
    return el;
  });
}

function placeExoLabels() {
  if (!exo.length) return;
  const b = basis();
  const near = [];
  for (const sys of exo) {
    const d = len(sub(sys.center, cam.eye));
    if (d > 60) continue;
    const at = screenOf(sys.center, b, proj);
    if (!at) continue;
    // Behind a nearer disc (a planet beside the camera): hidden by it.
    if ((lastNear ?? []).some((n) => {
      const dn = len(sub(n.pos, cam.eye));
      if (dn >= d) return false;
      const c = screenOf(n.pos, b, proj);
      return c && Math.hypot(c.x - at.x, c.y - at.y) < (n.rpc / dn) * proj.focal[1] * (proj.h / proj.dpr) / 2 + 8;
    })) continue;
    near.push({ sys, d, at });
  }
  near.sort((x, y) => x.d - y.d);
  const shown = [];
  let k = 0;
  for (const n of near) {
    if (k >= exoLabels.length) break;
    if (shown.some((o) => Math.abs(o.x - n.at.x) < 150 && Math.abs(o.y - n.at.y) < 16)) continue;
    if (labels.some(({ el }) => !el.hidden && Math.abs(parseFloat(el.dataset.x) - n.at.x) < 60 && Math.abs(parseFloat(el.dataset.y) - n.at.y) < 14)) continue;
    const el = exoLabels[k++];
    el.sys = n.sys;
    el.hidden = false;
    el.querySelector('.fly-label__name').textContent = t('exo.label', { host: n.sys.host, n: n.sys.planets.length });
    el.querySelector('.fly-label__far').textContent = distanceText(n.d);
    el.style.transform = `translate(${n.at.x.toFixed(1)}px, ${n.at.y.toFixed(1)}px)`;
    shown.push(n.at);
  }
  for (; k < exoLabels.length; k++) exoLabels[k].hidden = true;
}

const JD = () => Date.now() / 86400000 + 2440587.5;

/**
 * The system's planets now: on a circle of their semi-major axis, in the
 * plane that holds the line of sight from the Sun (a transit needs it edge-on)
 * and the celestial north as near as it can, at the phase of their measured
 * transit time; [] places for those without one.
 */
function systemNow(sys) {
  const c = sys.center;
  const toSun = norm(sub([0, 0, 0], c));
  let side = cross(toSun, [0, 0, 1]);
  if (len(side) < 1e-6) side = cross(toSun, [1, 0, 0]);
  side = norm(side);
  const jd = JD();
  return sys.planets.map((pl) => {
    if (!(pl.a > 0)) return { pl, pos: null };
    const r = pl.a * AU;
    let pos = null;
    if (pl.tc && pl.p > 0) {
      // At transit the planet is between its star and the Sun.
      const phase = (((jd - pl.tc) / pl.p) % 1 + 1) % 1;
      const ang = 2 * Math.PI * phase;
      pos = add(add(c, toSun, r * Math.cos(ang)), side, r * Math.sin(ang));
    }
    return { pl, pos, r, toSun, side };
  });
}

/** The system the camera is in: the nearest within a thousand AU of its star. */
function systemHere() {
  let best = null;
  let bestD = 1000 * AU;
  for (const sys of exo) {
    const d = len(sub(sys.center, cam.eye));
    if (d < bestD) { bestD = d; best = sys; }
  }
  return best;
}

/** Orbits and planets of the system the camera is in, every frame. */
function drawSystem() {
  const sys = exo.length ? systemHere() : null;
  inSystem = null;
  if (!sys) {
    space.setLiveLines(null);
    return [];
  }
  const now = systemNow(sys);
  const segs = [];
  for (const o of now) {
    if (!o.r) continue;
    for (let k = 0; k < 96; k++) {
      const a0 = (k / 96) * 2 * Math.PI;
      const a1 = ((k + 1) / 96) * 2 * Math.PI;
      // Relative to the eye, in double precision, before they become single.
      segs.push(...sub(add(add(sys.center, o.toSun, o.r * Math.cos(a0)), o.side, o.r * Math.sin(a0)), cam.eye));
      segs.push(...sub(add(add(sys.center, o.toSun, o.r * Math.cos(a1)), o.side, o.r * Math.sin(a1)), cam.eye));
    }
  }
  space.setLiveLines(new Float32Array(segs), [0.55, 0.9, 0.75, 0.45]);
  const starCol = sys.index >= 0 ? [stars.col[sys.index * 3], stars.col[sys.index * 3 + 1], stars.col[sys.index * 3 + 2]] : starColour(0.65).map((c) => c / 255);
  const spheres = [];
  // A host the catalogue lacks is drawn here, at its archive radius.
  if (sys.index < 0 && sys.starR) {
    spheres.push({ index: -1, pos: sys.center, rpc: sys.starR * R_SUN_PC, col: starCol, lit: false });
  }
  for (const o of now) {
    if (!o.pos || !(o.pl.r > 0)) continue;
    spheres.push({
      index: -1, pos: o.pos, rpc: o.pl.r * R_EARTH_PC, lit: true, light: sys.center,
      // Grey, tinted by the light of its star: its true colour is not known.
      col: starCol.map((c) => 0.35 + 0.45 * c),
      planet: o.pl,
    });
  }
  inSystem = { sys, now, spheres };
  return spheres;
}

function placeSystemLabels() {
  const box = $('sys-labels');
  if (!inSystem) {
    if (box.childElementCount) box.replaceChildren();
    return;
  }
  const b = basis();
  const items = inSystem.now.filter((o) => o.pos);
  while (box.childElementCount < items.length) {
    const el = document.createElement('span');
    el.className = 'fly-mark fly-mark--planet';
    box.append(el);
  }
  [...box.children].forEach((el, k) => {
    const o = items[k];
    const at = o ? screenOf(o.pos, b, proj) : null;
    el.hidden = !at;
    if (!at) return;
    el.textContent = o.pl.name;
    el.style.transform = `translate(${at.x.toFixed(1)}px, ${(at.y + 10).toFixed(1)}px)`;
  });
}

/**
 * The habitable zone of a star, AU: where a planet like the Earth could keep
 * liquid water on its surface. Kopparapu et al. (2013), the conservative
 * limits (runaway greenhouse inside, maximum greenhouse outside), with the
 * effective fluxes' temperature dependence; L from the star's radius and
 * temperature.
 */
export function habitableZone(rSun, teff) {
  if (!(rSun > 0) || !(teff > 2600 && teff < 7200)) return null;
  const L = rSun ** 2 * (teff / T_SUN) ** 4;
  const t = teff - 5780;
  const seff = (s0, a, b, c, d) => s0 + a * t + b * t ** 2 + c * t ** 3 + d * t ** 4;
  const inner = seff(1.0385, 1.2456e-4, 1.4612e-8, -7.6345e-12, -1.7511e-15);
  const outer = seff(0.3507, 5.9578e-5, 1.6707e-9, -3.0058e-12, -5.1925e-16);
  return { inner: Math.sqrt(L / inner), outer: Math.sqrt(L / outer), L };
}

/** The system seen from above: its orbits to scale, its habitable zone, and where each planet is now. */
function systemDiagram(sys) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const svg = el('svg', { viewBox: '-110 -110 220 220', class: 'fly-system', role: 'img' });
  const hz = habitableZone(sys.starR, sys.teff);
  const widest = Math.max(...sys.planets.map((pl) => pl.a || 0), hz ? hz.outer * 0.6 : 0, 0.01);
  const scale = 100 / widest;
  if (hz && hz.inner * scale < 105) {
    svg.append(el('circle', { r: Math.min(hz.outer * scale, 104), class: 'fly-system__hz' }));
    svg.append(el('circle', { r: hz.inner * scale, class: 'fly-system__hz-in' }));
  }
  svg.append(el('circle', { r: 3.5, class: 'fly-system__star' }));
  const jd = JD();
  for (const pl of sys.planets) {
    if (!(pl.a > 0)) continue;
    const r = pl.a * scale;
    svg.append(el('circle', { r, class: 'fly-system__orbit' }));
    if (pl.tc && pl.p > 0) {
      // At transit the planet is between its star and the Sun: the bottom of the drawing.
      const ang = 2 * Math.PI * ((((jd - pl.tc) / pl.p) % 1 + 1) % 1);
      const x = r * Math.sin(ang);
      const y = r * Math.cos(ang);
      const dot = el('circle', { cx: x.toFixed(2), cy: y.toFixed(2), r: Math.max(2, Math.min(6, Math.sqrt(pl.r || 1) * 1.5)), class: 'fly-system__planet' });
      const title = el('title', {});
      title.textContent = pl.name;
      dot.append(title);
      svg.append(dot);
    }
  }
  const scaleNote = document.createElement('p');
  scaleNote.className = 'fly-system__note';
  scaleNote.textContent = hz
    ? t('exo.diagramHz', { a: fmt(widest, widest < 1 ? 2 : 1), i: fmt(hz.inner, 2), o: fmt(hz.outer, 2) })
    : t('exo.diagram', { a: fmt(widest, widest < 1 ? 2 : 1) });
  const box = document.createElement('figure');
  box.className = 'fly-system__box';
  box.append(svg, scaleNote);
  return box;
}

/** A system's card: its planets, and the way to ExoVision for the rest. */
function openSystemCard(sys) {
  closeCard();
  $('card-title').textContent = sys.host;
  $('card-note').textContent = t('exo.note');
  const rows = [[t('fly.cardSun'), distanceText(sys.pc)]];
  if (sys.teff) rows.push([t('fly.cardTemp'), t('fly.kelvin', { n: fmt(sys.teff, 0) })]);
  const planetRows = [];
  for (const pl of sys.planets) {
    const bits = [];
    if (pl.r) bits.push(t('exo.radius', { r: fmt(pl.r, pl.r < 10 ? 1 : 0) }));
    if (pl.a) bits.push(t('exo.orbit', { a: fmt(pl.a, pl.a < 1 ? 3 : 2) }));
    if (pl.p) bits.push(t('exo.period', { p: fmt(pl.p, pl.p < 10 ? 2 : 0) }));
    if (pl.t) bits.push(t('exo.teq', { t: fmt(pl.t, 0) }));
    bits.push(t('exo.found', { method: pl.method ?? '—', year: pl.year ?? '—' }));
    planetRows.push([pl, bits.join(' · ')]);
  }
  const planetRow = ([pl, text]) => {
    const row = cardRow(pl.name, text);
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'fly-planet-go';
    go.textContent = t('exo.goPlanet');
    go.addEventListener('click', () => flyToExoPlanet(sys, pl));
    row.querySelector('dt').append(' ', go);
    return row;
  };
  $('card-rows').replaceChildren(systemDiagram(sys), ...rows.map(([k, v]) => cardRow(k, v)), ...planetRows.map(planetRow));
  const frames = $('card-frames');
  frames.hidden = false;
  const url = new URL('./', location.href);
  url.hash = encodeHash({ ra: sys.ra, dec: sys.dec, fov: 0.3, band: 'D2', lang: getLanguage(), name: sys.host });
  frames.href = url.href;
  const ev = $('card-exo');
  ev.hidden = false;
  ev.href = systemUrl([sys.ra, sys.dec, sys.planets.length, sys.host], sys.host, getLanguage());
  card = { s: { key: `sys:${sys.host}`, sys, index: sys.index } };
  $('card').hidden = false;
}

/** The plane a system's orbits are drawn in: towards the Sun, and across. */
function systemFrame(sys) {
  const toSun = norm(sub([0, 0, 0], sys.center));
  let side = cross(toSun, [0, 0, 1]);
  if (len(side) < 1e-6) side = cross(toSun, [1, 0, 0]);
  side = norm(side);
  return { toSun, side, up: norm(cross(toSun, side)) };
}

/**
 * Fly into a system: to a point above the plane of its orbits, high enough
 * that the widest is whole on the screen, looking down at the star, so the
 * star and every planet are seen together.
 */
function flyToSystem(sys) {
  closeCard();
  carried = null;
  const widest = Math.max(...sys.planets.map((pl) => pl.a || 0), 0.02) * AU;
  const height = Math.max(widest / Math.tan((FOV * Math.PI) / 360) * 1.35, (sys.starR || 1) * R_SUN_PC * 10);
  const { up, toSun } = systemFrame(sys);
  // From above and a little to the Sun's side, so the orbits are ellipses, not lines.
  const to = add(add(sys.center, up, height * 0.92), toSun, height * 0.4);
  autopilot = {
    from: cam.eye, to, look: sys.center, stop: height, t0: performance.now(), body: -1,
    ms: reduceMotion ? 1 : 3400 + 400 * Math.log10(1 + len(sub(sys.center, cam.eye)) / height),
  };
  const wait = () => (autopilot ? requestAnimationFrame(wait) : openSystemCard(sys));
  requestAnimationFrame(wait);
}

/** One of a system's planets: the camera goes to it, and its card is shown. */
function flyToExoPlanet(sys, pl) {
  const now = systemNow(sys).find((o) => o.pl === pl);
  if (!now?.pos || !(pl.r > 0)) {
    flyToSystem(sys);
    return;
  }
  closeCard();
  carried = null;
  const rp = pl.r * R_EARTH_PC;
  // Lit from its star: approached from the star's side, a little off it, so its day side shows with a phase.
  const fromStar = norm(sub(now.pos, sys.center));
  const { up } = systemFrame(sys);
  const dir = norm(add(add(fromStar.map((c) => -c), up, 0.6), now.side ?? [0, 0, 1], 0.5));
  const to = add(now.pos, dir, rp * 7);
  autopilot = {
    from: cam.eye, to, look: now.pos, stop: rp * 7, t0: performance.now(), body: -1,
    ms: reduceMotion ? 1 : 3000 + 400 * Math.log10(1 + len(sub(now.pos, cam.eye)) / (rp * 7)),
    follow: () => systemNow(sys).find((o) => o.pl === pl)?.pos,
  };
  const wait = () => (autopilot ? requestAnimationFrame(wait) : openPlanetCard(sys, pl));
  requestAnimationFrame(wait);
}

/** A planet of another star: what is known of it. */
function openPlanetCard(sys, pl) {
  closeCard();
  $('card-title').textContent = pl.name;
  $('card-note').textContent = t('exo.planetNote', { host: sys.host });
  const rows = [];
  if (pl.r) rows.push([t('fly.cardRadius'), t('exo.radiusLong', { r: fmt(pl.r, pl.r < 10 ? 2 : 1), j: fmt(pl.r / 11.21, 2) })]);
  if (pl.a) rows.push([t('exo.orbitH'), t('exo.orbitLong', { a: fmt(pl.a, 3) })]);
  if (pl.p) rows.push([t('exo.periodH'), t('exo.periodLong', { p: fmt(pl.p, pl.p < 10 ? 3 : 1) })]);
  if (pl.e != null) rows.push([t('exo.eccH'), fmt(pl.e, 2)]);
  if (pl.t) rows.push([t('exo.teqH'), t('fly.kelvin', { n: fmt(pl.t, 0) })]);
  const hz = habitableZone(sys.starR, sys.teff);
  if (hz && pl.a) rows.push([t('exo.hzH'), t(pl.a < hz.inner ? 'exo.hzIn' : pl.a > hz.outer ? 'exo.hzOut' : 'exo.hzYes')]);
  rows.push([t('exo.foundH'), t('exo.found', { method: pl.method ?? '—', year: pl.year ?? '—' })]);
  $('card-rows').replaceChildren(...rows.map(([k, v]) => cardRow(k, v)));
  $('card-frames').hidden = true;
  const ev = $('card-exo');
  ev.hidden = false;
  ev.href = systemUrl([sys.ra, sys.dec, sys.planets.length, sys.host], sys.host, getLanguage());
  card = { s: { key: `sys:${sys.host}`, sys, index: sys.index } };
  $('card').hidden = false;
}

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
  // Out from the Earth's sky, the camera is where the Earth is: three Earth
  // radii out, the Earth behind it, the same sky ahead, carried with it.
  if (!hashPlaced) {
    const earth = named.find((x) => x.key === 'earth');
    if (earth) {
      const at = posOf(earth.index);
      const r = stars.rad[earth.index] * R_SUN_PC;
      cam.eye = add(at, cam.F, 3 * r);
      carried = { index: earth.index, offset: sub(cam.eye, at) };
    }
  }
  starCount = data.count;
  buildLabels();
  buildReach();
  if (pendingLook) lookFromEarth(pendingLook.ra, pendingLook.dec);
  loadSystems();
  applyLanguage();
  setTimeout(() => { $('hint').dataset.gone = 'true'; }, 9000);
  moveBodies();
  if (!paused) requestAnimationFrame(frame);
}


// Inside the front page: the way back to its sky, facing where this faces.
if (embedded) {
  $('back-sky').hidden = false;
  $('back-sky').addEventListener('click', () => { pullOut = null; landOnEarth(); });
}

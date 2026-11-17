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

import { setLanguage, getLanguage, t, applyTranslations, fmt, formatDay } from './i18n.js';
import { starColour, direction } from './gate.js';
import { encodeHash } from './hash.js';
import { embedded, goTo } from './embed.js';
import { systemUrl } from './exovision.js';
import { radecOf } from './allsky/healpix.js';
import { createSpace, screenOf } from './fly/space.js';
import { RELIEF, reliefScale } from './fly/relief.js';
import { createSkyView } from './allsky/view.js';
import { DEEP_GAPS, CORE_STAR_COUNT } from './allsky/fills.js';
import { HIPS_BASE, COLOUR_FRAMES } from './allsky/hips.js';
import { temperatureOf, luminosityOf, radiusOf, vMinusW2, vFromHp, R_SUN_PC, T_SUN } from './fly/stars.js';
import { solarSystem, orbits as solarOrbits, moonOrbit, bodyAxes, FACTS, MOONS_AS_OF, AU_PC } from './fly/solar.js';
import { orbitOf, offsetAt, anomalyAt, ellipseEnds, skyFrame, habitableZone, zoneOf, matchHosts, skyVelocity } from './fly/orbits.js';
import { drawable, orbitPath, positionAt } from './orbit.js';
import { shells, planetNineShortfall, WISE0855_AB, WISE0855_PC, D6_ONE_VISIT_AB, PLANET_NINE_V, PLANET_NINE_AU, PLANET_NINE_MAX_BETA } from './fly/reach.js';

const $ = (id) => document.getElementById(id);
const LY_PER_PC = 3.26156;
const AU_PER_PC = 206264.806;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The field of view, vertical, degrees: the front page's opening width. */
/** The field of view, vertical, degrees: the wheel narrows and widens it. */
let FOV = 70;
const FOV_RANGE = [2, 108];
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
  // A first visit opens in English, whatever the browser's language.
  return asked ?? saved ?? 'en';
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
  // The named stars' V as measured from the ground: the brightest saturated Hipparcos.
  const measuredV = new Map(info.named.filter((s) => s.hip && Number.isFinite(s.v)).map((s) => [s.hip, s.v]));

  // The catalogue, the Sun, WISE 0855 (a body the eye cannot see at all), and
  // the planets and the Moon where they are today.
  const bodies = solarSystem();
  const n = stored + 2 + bodies.length;
  const stars = {
    pos: new Float32Array(n * 3), mag: new Float32Array(n), col: new Float32Array(n * 3),
    rad: new Float32Array(n), bv: new Float32Array(n), hip: new Int32Array(n), measured: new Uint8Array(n),
    ir: new Float32Array(n),
  };
  /** One star: its place, its absolute V, colour and Hipparcos number. */
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
  // stars.bin holds Hipparcos's own magnitude, Hp: in V by the star's colour,
  // or by its measured V where the page names it.
  for (let i = 0; i < stored; i++) {
    const p = xyz.subarray(i * 3, i * 3 + 3);
    const bv = look[i * 2 + 1] / 1000;
    const v = measuredV.get(hipOf[i]);
    const absV = v == null ? vFromHp(look[i * 2] / 100, bv) : v - 5 * Math.log10(Math.hypot(p[0], p[1], p[2]) / 10);
    put(i, p, absV, bv, hipOf[i]);
  }
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
  stars.bodyKey = new Map(bodies.map((b, k) => [stored + 2 + k, b.key]));
  const indexOfHip = new Map();
  for (let i = 0; i < stored; i++) indexOfHip.set(hipOf[i], i);
  const named = info.named.map((s) => ({
    ...s,
    index: s.key === 'sun' ? stored : s.key === 'wise0855' ? wiseIndex : indexOfHip.get(s.hip) ?? -1,
  }));
  bodies.forEach((b, k) => named.push({ key: b.key, en: b.en, ru: b.ru, planet: true, km: b.km, index: stored + 2 + k }));
  return { stars, named, count: info.count, sun: stored };
}

/* ---- the SPHEREx sky behind ----------------------------------------------- */

/*
 * The front page's sky is SPHEREx's all-sky cube; flown out of, this page
 * starts with the same sky, drawn by the same renderer from the same camera,
 * so leaving the sky changes nothing on screen. The survey is the sky seen
 * from the Sun: within the Solar System it is the sky, the stars being far
 * enough not to have moved. Further out the nearer stars shift against it,
 * so it gives way to the catalogue's stars in 3-D, which come up as it goes:
 * all of it inside 2,000 AU, none of it past a light-year.
 */
const SURVEY_FULL_PC = 0.01;
const SURVEY_NONE_PC = 0.3;
let survey = null;
let surveyLayer = null;
/** The camera the survey was last drawn for. */
let surveyDrawnFor = '';

function makeSurvey() {
  surveyLayer = document.createElement('canvas');
  surveyLayer.className = 'as-sky__canvas fly-survey';
  surveyLayer.setAttribute('aria-hidden', 'true');
  canvas.before(surveyLayer);
  const ramp = getComputedStyle(document.documentElement).getPropertyValue('--cmap-deep')
    .split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);
  survey = createSkyView(surveyLayer, {
    ramp,
    ink: { grid: [0, 0, 0, 0], ecliptic: [0, 0, 0, 0] },
    relay: (url) => url.replace(`${HIPS_BASE}/`, 'api/hips/'),
  });
  if (!survey) {
    surveyLayer.remove();
    surveyLayer = null;
    return;
  }
  survey.setFrames(COLOUR_FRAMES);
  buildGapLabels();
}

/** How much of the survey shows from here: 1 near the Sun, 0 a light-year out; none in the 4.6 µm view. */
function surveyShare() {
  if (!survey || view.ir) return 0;
  const d = len(cam.eye);
  if (d <= SURVEY_FULL_PC) return 1;
  if (d >= SURVEY_NONE_PC) return 0;
  const x = Math.log(d / SURVEY_FULL_PC) / Math.log(SURVEY_NONE_PC / SURVEY_FULL_PC);
  return 1 - x * x * (3 - 2 * x);
}

/** The survey from the flight's camera, now, so it and the stars over it agree in this frame. */
function drawSurvey(share) {
  if (!survey) return;
  const visibility = share > 0 ? '' : 'hidden';
  if (surveyLayer.style.visibility !== visibility) surveyLayer.style.visibility = visibility;
  if (share <= 0) {
    surveyDrawnFor = '';
    for (const g of gapLabels) setHidden(g.el, true);
    return;
  }
  // The survey is the sky seen from the Sun: it changes only when the camera
  // turns, zooms or is resized, and loads its own images as they arrive.
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const seen = [...cam.F, ...cam.U, FOV, w, h].join();
  if (seen === surveyDrawnFor) return;
  surveyDrawnFor = seen;
  const R = cross(cam.F, cam.U);
  // Vertical field here; across the shorter side there.
  const across = (2 * Math.atan(Math.tan((FOV * Math.PI) / 360) * (Math.min(w, h) / h)) * 180) / Math.PI;
  survey.set({ basis: { C: cam.F, E: R.map((c) => -c), N: cam.U }, fov: across });
  survey.drawNow();
  placeGapLabels(w, h);
}

/*
 * The survey's two deep fields are blank in the cube and hatched on the sky
 * (allsky/fills.js): each is named where it is, and opens its frames in the
 * tool, as the ready fields do on the front page.
 */
let gapLabels = [];
function buildGapLabels() {
  gapLabels = DEEP_GAPS.map((g) => {
    const el = document.createElement('a');
    el.className = 'fly-label fly-label--gap';
    el.hidden = true;
    el.innerHTML = '<span class="fly-label__dot"></span><span class="fly-label__name"></span>';
    $('labels').append(el);
    return { g, el };
  });
  nameGapLabels();
}

function nameGapLabels() {
  for (const { g, el } of gapLabels) {
    const name = t(`preset.${g.key}`);
    el.querySelector('.fly-label__name').textContent = `${name} · ${t('sky.gapNote')}`;
    const url = new URL('./', location.href);
    url.hash = encodeHash({ ra: g.field.ra, dec: g.field.dec, fov: 0.3, band: 'all', lang: getLanguage(), name });
    el.href = url.href;
  }
}

function placeGapLabels(w, h) {
  for (const { g, el } of gapLabels) {
    const at = survey.screenOf(g.ra, g.dec);
    const inside = Boolean(at) && at.x > -20 && at.y > -20 && at.x < w + 20 && at.y < h + 20;
    setHidden(el, !inside);
    if (inside) setPlace(el, at);
  }
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

/*
 * Numbers for the readout and the labels, which are written again whenever
 * the camera moves: fmt builds a formatter on every call, which was the
 * largest single cost of a frame. One formatter per language and number of
 * digits, made once, writes the same digits.
 */
const numberFormats = new Map();
function num(n, digits) {
  if (n == null || !Number.isFinite(n)) return '—';
  const key = `${getLanguage()}:${digits}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(getLanguage() === 'ru' ? 'ru-RU' : 'en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    numberFormats.set(key, f);
  }
  return f.format(n);
}

const ly = (pc) => pc * LY_PER_PC;
const KM_PER_PC = 3.0856775814913673e13;
function distanceText(pc) {
  const l = ly(pc);
  // Beside a planet AU are too coarse: kilometres, as a spacecraft would say.
  if (pc * AU_PER_PC < 0.01) return t('fly.km', { n: num(pc * KM_PER_PC, 0) });
  if (l < 0.01) return t('fly.au', { n: num(pc * AU_PER_PC, pc * AU_PER_PC < 10 ? 2 : 0) });
  return t('fly.ly', { n: num(l, l < 10 ? 2 : l < 100 ? 1 : 0) });
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
  // Only an address that says all three: Number(null) is 0, and an address
  // with none put the camera in the middle of the Sun.
  const xyz = ['x', 'y', 'z'].map((k) => (p.has(k) ? Number(p.get(k)) : NaN));
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

/*
 * The address is written once the camera has rested for 300 ms. Flying asks
 * for it every frame: a timer is set once and, when it fires early, set again
 * for the rest of the wait, instead of a timer cleared and made each frame.
 */
let hashTimer = 0;
let hashAskedAt = 0;
function writeHash() {
  hashAskedAt = performance.now();
  if (!hashTimer) hashTimer = setTimeout(hashDue, 300);
}
function hashDue() {
  const waited = performance.now() - hashAskedAt;
  if (waited < 300) {
    hashTimer = setTimeout(hashDue, 300 - waited);
    return;
  }
  hashTimer = 0;
  // Exponent form: beside the Moon a millionth of a parsec is too coarse.
  const p = new URLSearchParams({ x: cam.eye[0].toExponential(10), y: cam.eye[1].toExponential(10), z: cam.eye[2].toExponential(10) });
  history.replaceState(null, '', `#${p}`);
}

const posOf = (i) => [stars.pos[i * 3], stars.pos[i * 3 + 1], stars.pos[i * 3 + 2]];
/**
 * Where something is. A catalogue star from the catalogue itself, never from
 * named.json, whose positions are rounded to 0.0001 pc — twenty AU, a hundred
 * times the distance the autopilot stops from a star.
 */
const placeOf = (s) => (s.index >= 0 ? posOf(s.index) : s.pos);

function buildLabels() {
  // The deep fields' names stay: they belong to the survey, not to the stars.
  $('labels').replaceChildren(...gapLabels.map((g) => g.el));
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
  buildDestinations();
}

/*
 * The destinations: the challenge's two targets first, then the nearest
 * stars worth the trip (ε Indi has a brown dwarf, ε Indi B, going round it),
 * then home, and the Moon and the planets behind one chip. The bright stars
 * a chip once took to are still on the sky, a press away.
 */
const DESTINATIONS = ['wise0855', 'hip70890', 'hip87937', 'hip108870', 'earth'];
const PLANET_CHIPS = ['moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

function chip(text, className, go) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `as-band${className ? ` ${className}` : ''}`;
  b.textContent = text;
  b.addEventListener('click', go);
  return b;
}

function buildDestinations() {
  const go = (s) => () => { closePops(); flyTo(s); openCardLater(s); };
  const chips = [chip(nameOf(P9), 'fly-chip--target', () => { closePops(); flyToPlanetNine(); openCardLater(P9); })];
  for (const key of DESTINATIONS) {
    const s = named.find((x) => x.key === key);
    if (s) chips.push(chip(nameOf(s), s.target ? 'fly-chip--target' : '', go(s)));
  }
  const planets = chip(t('fly.planets'), 'fly-chip--more', () => togglePop('planets'));
  planets.id = 'planets';
  planets.title = t('fly.planetsWhen');
  planets.setAttribute('aria-haspopup', 'true');
  planets.setAttribute('aria-expanded', 'false');
  chips.push(planets);
  $('dest').replaceChildren(...chips);
  $('planets-pop').replaceChildren(...PLANET_CHIPS.map((key) => named.find((x) => x.key === key)).filter(Boolean)
    .map((s) => {
      const b = chip(nameOf(s), '', go(s));
      b.setAttribute('role', 'menuitem');
      return b;
    }));
}

/*
 * The two small panels over the dock: the planets, and the sources. One is
 * open at a time, above the button that opened it; a press anywhere else or
 * Esc puts it away.
 */
const POPS = { planets: ['planets', 'planets-pop'], sources: ['sources', 'sources-pop'] };
function togglePop(name) {
  const open = $(POPS[name][1]).hidden;
  closePops();
  if (!open) return;
  const [buttonId, popId] = POPS[name];
  const button = $(buttonId);
  const pop = $(popId);
  pop.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  // Above its button, inside the sky's edges.
  const sky = $('sky').getBoundingClientRect();
  const at = button.getBoundingClientRect();
  const left = Math.max(8, Math.min(at.left - sky.left, sky.width - pop.offsetWidth - 8));
  pop.style.left = `${left}px`;
  pop.style.bottom = `${sky.bottom - at.top + 6}px`;
}
function closePops() {
  for (const [buttonId, popId] of Object.values(POPS)) {
    if ($(popId).hidden) continue;
    $(popId).hidden = true;
    $(buttonId)?.setAttribute('aria-expanded', 'false');
  }
}
$('sources').addEventListener('click', () => togglePop('sources'));
addEventListener('pointerdown', (e) => {
  if (!e.target.closest?.('.fly-pop, #planets, #sources')) closePops();
});

/* ---- the autopilot ----------------------------------------------------- */

/** The radius of a destination in parsecs. */
const radiusPc = (s) => (s.index >= 0 ? stars.rad[s.index] : s.radius ?? 1) * R_SUN_PC;

/** Fly to a star, stopping a few of its own radii from it. */
function flyTo(s) {
  hideCard();
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
  setTrip(s.key);
  autopilot = {
    home: s.key === 'earth',
    offset,
    // A planet moves while the camera flies to it: the end is followed.
    body: s.planet ? s.index : -1,
    from: cam.eye, to: end, look: to, stop, t0: performance.now(),
    ms: reduceMotion ? 1 : 3000 + 400 * Math.log10(1 + away / Math.max(stop, 1e-12)),
  };
  $('hint').dataset.gone = 'true';
  wake();
}

/** The field of view the flight rests at, degrees, and the easing back to it after a wide step out. */
const FOV_REST = 70;
let fovEase = null;

function stepFov() {
  if (!fovEase) return;
  const x = Math.min(1, (performance.now() - fovEase.t0) / fovEase.ms);
  const e = 1 - (1 - x) ** 3;
  FOV = fovEase.from + (FOV_REST - fovEase.from) * e;
  if (x >= 1) fovEase = null;
}

function steer(dt) {
  stepFov();
  if (stepPullOut()) return;
  if (autopilot?.follow) {
    const to = autopilot.follow();
    if (to) {
      // The end keeps its side of the body as the body moves; the camera
      // looks at the body, or where `aim` says from it.
      autopilot.to = add(to, norm(sub(autopilot.to, autopilot.anchor ?? autopilot.look)), autopilot.stop);
      autopilot.anchor = [...to];
      autopilot.look = autopilot.aim ? autopilot.aim(to) : to;
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
    // An orbit is framed with its pole up the screen: the camera rolls to it on the way.
    if (autopilot.up) {
      const U = add(cam.U, sub(autopilot.up, cam.U), Math.min(1, dt / 0.4));
      if (len(U) > 1e-6) cam.U = norm(U);
    }
    orthonormal();
    if (x >= 1) {
      // Arrived facing what it came for: the easing above, a quarter second
      // behind a target still moving across the view, left it off centre.
      cam.F = norm(sub(autopilot.look, cam.eye));
      if (autopilot.up) cam.U = autopilot.up;
      orthonormal();
      // Home: arriving at the Earth puts you back on its sky.
      if (autopilot.home && embedded) {
        autopilot = null;
        landOnEarth();
        return;
      }
      // Arrived: slow enough to fly round the star rather than past it.
      factor = 0.5;
      if (autopilot.body >= 0) carried = { index: autopilot.body, offset: sub(cam.eye, posOf(autopilot.body)) };
      // Another star's planet goes on moving too: the camera keeps beside it.
      const beside = autopilot.follow?.();
      if (beside) carried = { at: autopilot.follow, offset: sub(cam.eye, beside) };
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
    if (hold.forward || hold.back) factor = holdFactor();
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

/* ---- surfaces ------------------------------------------------------------ */

/**
 * Real global maps of the bodies that have one (public/data/fly/tex,
 * maps.json says whose and what each shows); Saturn, Uranus and Neptune have
 * none worth the name and keep their plain colour. Loaded once the flight is
 * up, a few hundred kilobytes in all.
 */
/** What each map shows: Mercury's colours are stretched filters, Venus's surface is radar under its clouds. */
const MAP_KIND = { mercury: 'fly.mapFalse', venus: 'fly.mapRadar' };

let surfaceInfo = {};
/** The height maps' sources and ranges (maps.json `heights`), for the bodies with one. */
let heightInfo = {};
let axesAt = 0;
const axesOf = new Map();

async function loadSurfaces() {
  try {
    const res = await fetch('data/fly/tex/maps.json');
    if (!res.ok) return;
    const info = await res.json();
    surfaceInfo = info.maps ?? {};
    heightInfo = info.heights ?? {};
  } catch { return; }
  for (const [key, m] of Object.entries(surfaceInfo)) {
    const img = new Image();
    img.decoding = 'async';
    img.src = `data/fly/tex/${m.file}`;
    img.decode().then(() => { space.setMap(key, img); wake(); }).catch(() => {});
  }
}

/** The bodies whose heights have been asked for. */
const reliefAsked = new Set();
let reliefWorker = null;

/**
 * A body's height map, read at its full 16 bits and turned into slopes once
 * (relief.js), beside the page, the first time the body is seen large
 * enough for its ground to show. The Earth's oceans are flat: the map holds
 * the sea floor too, and the sea over it is what is seen.
 */
function loadRelief(key) {
  reliefAsked.add(key);
  if (!reliefWorker) {
    try {
      reliefWorker = new Worker(new URL('./fly/relief-worker.js', import.meta.url), { type: 'module' });
    } catch { return; }
    reliefWorker.addEventListener('message', (e) => {
      if (!e.data.levels) return;
      space.setRelief(e.data.key, e.data.levels);
      wake();
    });
  }
  const meta = heightInfo[key];
  const url = new URL(`data/fly/tex/${meta.file}`, location.href).href;
  reliefWorker.postMessage({ url, meta, key, seaLevel: key === 'earth' ? 0 : null });
}

/** A body's map key and its axes at the moment shown. */
function surfaceOf(i) {
  const key = stars.bodyKey?.get(i);
  if (!key || !surfaceInfo[key]) return {};
  // Worked out again for each second the clock moves on: every frame when it races.
  const at = simMs();
  if (Math.abs(at - axesAt) > 1000) {
    axesOf.clear();
    axesAt = at;
  }
  if (!axesOf.has(key)) axesOf.set(key, bodyAxes(key, new Date(at)));
  return { map: key, axes: axesOf.get(key), ...(key === 'earth' ? { air: [0.05, 0.11, 0.3] } : {}) };
}

const TOP = 12;
const topK = new Float64Array(TOP);
const topI = new Int32Array(TOP);
const coarsePointer = matchMedia('(pointer: coarse)');
/** Counts every change to where the bodies are or how large: the planets moving, a star's radius corrected. */
let bodiesChanged = 0;
/** The eye and the bodies the last pass over every star was made for. */
let scannedFor = null;

/**
 * One pass over every star: the distance to the nearest surface, which sets
 * the speed, and the twelve that look largest. It depends only on where the
 * eye and the bodies are, so turning the camera, or a frame with nothing
 * moved, reuses the last pass instead of reading sixty thousand stars again.
 */
function scanBodies() {
  const [ex, ey, ez] = cam.eye;
  if (scannedFor && scannedFor[0] === ex && scannedFor[1] === ey && scannedFor[2] === ez && scannedFor[3] === bodiesChanged) return;
  scannedFor = [ex, ey, ez, bodiesChanged];
  const p = stars.pos;
  const rad = stars.rad;
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
    const d2 = dx * dx + dy * dy + dz * dz + 1e-40;
    const r = rad[i] * R_SUN_PC;
    // Nearly every star is neither nearer than the nearest surface so far
    // nor larger than the twelfth disc: both are asked in squares first, and
    // the square root is taken only for the few that might be.
    const reach = nearestGap + r;
    const kMin = topK[TOP - 1];
    if (reach > 0 && d2 >= reach * reach && rad[i] * rad[i] <= kMin * kMin * d2) continue;
    const dist = Math.sqrt(d2);
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
}

function nearestStar() {
  scanBodies();
  const [ex, ey, ez] = cam.eye;
  const p = stars.pos;
  const rad = stars.rad;
  // The same pixel density the sky is drawn at (space.js), so "half a pixel" means it.
  const dpr = Math.min(devicePixelRatio || 1, coarsePointer.matches ? 1.5 : 2);
  const focalPx = (canvas.clientHeight * dpr / 2) / Math.tan((FOV * Math.PI) / 360);
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
    ...surfaceOf(i),
    relief: reliefFrom(i, focalPx),
  }));
}

/**
 * How many times steeper than true a body's ground is drawn from here; 0 for
 * a body with no heights, or one too small on the screen for its ground to
 * show, whose heights are then not even read.
 */
function reliefFrom(i, focalPx) {
  const key = stars.bodyKey?.get(i);
  if (!key || !heightInfo[key]?.file || !RELIEF[key]) return 0;
  const r = stars.rad[i] * R_SUN_PC;
  const d = len(sub(posOf(i), cam.eye));
  if ((r / d) * focalPx < 12) return 0;
  if (!reliefAsked.has(key)) loadRelief(key);
  return reliefScale(key, d / r - 1);
}

/* ---- the readout and labels ------------------------------------------- */

/*
 * The speed shown is the camera's own, as it moves this frame: none when it
 * rests (riding beside a planet as the planet goes round is resting), and
 * the autopilot's or the keys' when it flies. The keys fly at a share of the
 * distance to the nearest surface, so that light years go by in seconds
 * among the stars: that is far faster than light, by design, and is written
 * as what it is, so many times the speed of light, never as km/s no body
 * could reach.
 */
const C_KM_S = 299792.458;
const compact = new Map();
function speedText(pcPerS) {
  if (!(pcPerS > 0)) return t('fly.speedStill');
  const km = pcPerS * KM_PER_PC;
  if (km < C_KM_S) return t('fly.speedKm', { v: num(km, 0) });
  const key = getLanguage();
  if (!compact.has(key)) {
    compact.set(key, new Intl.NumberFormat(key === 'ru' ? 'ru-RU' : 'en-GB', { notation: 'compact', maximumSignificantDigits: 2 }));
  }
  return t('fly.speedC', { n: compact.get(key).format(km / C_KM_S) });
}

/** The camera's own speed, parsecs a second: measured over each frame's steering, smoothed a little. */
let shownSpeed = 0;
function measureSpeed(before, dt) {
  const moved = len(sub(cam.eye, before));
  if (!(moved > 0) || !(dt > 0)) {
    shownSpeed = 0;
    return;
  }
  const v = moved / dt;
  shownSpeed = shownSpeed > 0 ? shownSpeed + (v - shownSpeed) * 0.3 : v;
}

/*
 * The page's words over the canvas are written only when they change: a
 * style or text written each frame with what it already says still costs
 * the browser a fresh layout of the labels.
 */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
function setHidden(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden;
}
/** Put an element at a point of the canvas, CSS pixels, with dy below it. */
function setPlace(el, at, dy = 0) {
  const transform = `translate(${at.x.toFixed(1)}px, ${(at.y + dy).toFixed(1)}px)`;
  if (el.placed !== transform) {
    el.style.transform = transform;
    el.placed = transform;
  }
}

const NEAREST_SAID_PC = 1 / LY_PER_PC;
function readout() {
  const fromSun = len(cam.eye);
  let nearName = null;
  let nearD = Infinity;
  for (const s of named) {
    const d = len(sub(placeOf(s), cam.eye));
    if (d < nearD && d > 1e-12) { nearD = d; nearName = s; }
  }
  // The nearest named place only while it is near: a light year out, among
  // the stars, it is a name from across the room and says nothing of here.
  setText($('read'), [
    t('fly.fromSun', { d: distanceText(fromSun) }),
    speedText(shownSpeed),
    nearName && nearD < NEAREST_SAID_PC && t('fly.nearest', { name: nameOf(nearName), d: distanceText(nearD) }),
  ].filter(Boolean).join('  ·  '));
}

/**
 * The bodies drawn as spheres this frame, where each is on the screen and how
 * many pixels its radius is: worked out once a frame for every label that
 * asks whether a disc covers it.
 */
let discs = [];
function measureDiscs(b) {
  const pxPerRad = proj.focal[1] * (proj.h / proj.dpr) / 2;
  discs = (lastNear ?? []).map((n) => {
    const d = len(sub(n.pos, cam.eye));
    return { index: n.index, d, c: screenOf(n.pos, b, proj), r: (n.rpc / d) * pxPerRad };
  });
}

/*
 * Where a label stands on the screen, as a box: its ring, its name and its
 * distance run right from the point. The width is told from the words, about
 * 6.5 px a letter at the labels' size, without asking the page to lay them
 * out each frame. Two labels whose boxes meet are read as neither: the one
 * that comes second is left out until the view moves. Nor is a label left
 * under the card, or cut by the canvas's right edge.
 */
const labelBox = (at, letters, into = {}) => {
  into.x0 = at.x - 9;
  into.y0 = at.y - 15;
  into.x1 = at.x + 26 + letters * 6.5;
  into.y1 = at.y + 6;
  return into;
};
const meet = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/*
 * The card's box and the dock's on the canvas, measured again only when
 * either is shown, hidden or changes size: a name under them is cut.
 */
const covers = [];
let coversFresh = false;
const coverObserver = new ResizeObserver(() => { coversFresh = false; });
coverObserver.observe($('card'));
coverObserver.observe($('dock'));
/*
 * The dock's top, as a distance from the sky's foot, in --dock-space: the ▲▼
 * pad, the hint, the 4.6 µm note and, on a phone, the card stand on it, so
 * nothing sits under the dock whatever its height in either language.
 */
// Written at the next frame, not inside the observer: what stands on it
// changes size in turn, and the observers would see their own loop.
const dockObserver = new ResizeObserver(() => requestAnimationFrame(() => {
  const sky = $('sky').getBoundingClientRect();
  const top = $('dock').getBoundingClientRect().top;
  $('sky').style.setProperty('--dock-space', `${Math.round(sky.bottom - top)}px`);
}));
dockObserver.observe($('dock'));
dockObserver.observe($('sky'));

function coverRects() {
  if (!coversFresh) {
    covers.length = 0;
    const c = canvas.getBoundingClientRect();
    for (const el of [$('card'), $('dock')]) {
      if (el.hidden) continue;
      const r = el.getBoundingClientRect();
      covers.push({ x0: r.left - c.left - 6, y0: r.top - c.top - 6, x1: r.right - c.left + 6, y1: r.bottom - c.top + 6 });
    }
    coversFresh = true;
  }
  return covers;
}
/** Whether a label's box is under the card or the dock, or past the canvas's right edge. */
function offLimits(box) {
  if (box.x1 > proj.w / proj.dpr) return true;
  for (const r of coverRects()) if (meet(box, r)) return true;
  return false;
}

/** The boxes of the labels shown this frame, kept in place: named stars first, then the planet hosts. */
const shownBoxes = [];
let shownCount = 0;
function takeBox(box) {
  const kept = shownBoxes[shownCount] ?? (shownBoxes[shownCount] = {});
  Object.assign(kept, box);
  shownCount++;
}
const crowded = (box) => {
  for (let k = 0; k < shownCount; k++) if (meet(box, shownBoxes[k])) return true;
  return false;
};
const probe = {};

/** The picked thing's ring and name, where drawPicked will put them: no label may take that place. */
function reservePicked(b) {
  const point = picked?.point && picked.kind !== 'exo' ? picked.point() : null;
  const at = point ? screenOf(point, b, proj) : null;
  if (!at) return;
  takeBox(labelBox(at, 0, probe));
  if (picked.name) takeBox(labelBox({ x: at.x, y: at.y + 20 }, picked.name.length, probe));
}

function placeLabels() {
  const b = basis();
  const kept = [];
  shownCount = 0;
  reservePicked(b);
  const quiet = quietLabels();
  // A planet's name only near the Sun: from the stars the planets are one point.
  const outOfSystem = len(cam.eye) > 0.01;
  for (const label of labels) {
    const { s, el } = label;
    const p = placeOf(s);
    const d = len(sub(p, cam.eye));
    const at = screenOf(p, b, proj);
    label.at = at;
    if (!at) {
      setHidden(el, true);
      continue;
    }
    // A star seen as a large disc needs no ring and name on top of it.
    const own = discs.find((x) => x.index === s.index);
    const big = own && own.r > 24;
    const far = s.planet && outOfSystem;
    // Behind a nearer disc: hidden by it.
    const behind = discs.some((n) => n.index !== s.index && n.d < d && n.c && Math.hypot(n.c.x - at.x, n.c.y - at.y) < n.r);
    const kin = quiet && (s.index === kinBody || s.index === kinCentre);
    if (label.kin !== kin) {
      el.classList.toggle('fly-label--kin', kin);
      el.classList.toggle('fly-label--picked', kin && s.index === kinBody);
      label.kin = kin;
    }
    kept.push({ label, at, d, kin, hidden: Boolean(big || far || behind) });
  }
  // Two names on one spot are read as neither: the nearer body keeps its own.
  // A name hidden by its disc still keeps the spot, as it always has. The
  // picked body and what it goes round are placed first.
  kept.sort((p, q) => (q.kin - p.kin) || (p.d - q.d));
  for (const k of kept) {
    const far = distanceText(k.d);
    labelBox(k.at, nameOf(k.label.s).length + far.length, probe);
    if (crowded(probe) || offLimits(probe)) k.hidden = true;
    else takeBox(probe);
    const { el } = k.label;
    setHidden(el, k.hidden);
    k.label.shown = !k.hidden;
    if (k.hidden) continue;
    setPlace(el, k.at);
    if (!k.label.farEl) k.label.farEl = el.querySelector('.fly-label__far');
    setText(k.label.farEl, far);
  }
  for (const label of labels) if (!label.at) label.shown = false;
}

/* ---- time ------------------------------------------------------------ */

/*
 * The planets and the Moon move as they do: their positions are worked out
 * for the moment shown, from the same orbital elements. That moment is now,
 * unless the clock is asked for another pace: ❚❚ stops it, ▶ runs it again,
 * the pace button steps through a day, a week, a month and a year a second,
 * and "Now" brings it back. The planets, the Moon, other stars' planets and
 * the orbit picked all go by it. The stars' own motions are too slow to see
 * even at a year a second.
 *
 * JPL's elements hold from 1800 to 2050: the clock stops at either end and
 * says why, rather than run the planets on to places they were never at.
 * Out among the stars, with no planets near, there is nothing for it to
 * move: it is put away and stopped, and is as it was on the way back.
 */
const RATES = [['fly.rateDay', 86400], ['fly.rateWeek', 7 * 86400], ['fly.rateMonth', 30.436875 * 86400], ['fly.rateYear', 365.25 * 86400]];
const CLOCK_FIRST = Date.UTC(1800, 0, 1);
const CLOCK_LAST = Date.UTC(2050, 11, 31, 23, 59);
/** live: the real now; otherwise `at` (ms since 1970) when the clock was last set, at `from` (page ms), running at `rate` while playing. */
const clock = { live: true, playing: true, rate: 1, at: 0, from: 0, clamped: false };
/** The moment shown, milliseconds since 1970. */
function simMs() {
  if (clock.live) return Date.now();
  return clock.playing ? clock.at + (performance.now() - clock.from) * clock.rate : clock.at;
}
/** The moment shown as a Julian date. */
const JD = () => simMs() / 86400000 + 2440587.5;
/** Whether the clock runs faster than real time: then every frame moves the bodies, not four a second. */
const racing = () => !clock.live && clock.playing && clock.rate > 1;

function setClock(change) {
  clock.at = simMs();
  clock.from = performance.now();
  clock.clamped = false;
  Object.assign(clock, change);
  if (clock.live) clock.rate = 1;
  showClock();
  if (stars && space) moveBodies();
  wake();
}

/** A racing clock past JPL's years stops at the edge of them. */
function clampClock() {
  if (clock.live) return;
  const ms = simMs();
  if (ms > CLOCK_LAST) setClock({ playing: false, at: CLOCK_LAST, clamped: true });
  else if (ms < CLOCK_FIRST) setClock({ playing: false, at: CLOCK_FIRST, clamped: true });
}

/** The clock's buttons as they are, and the moment shown whenever it is not now. */
function showClock() {
  const play = $('time-play');
  play.textContent = clock.playing ? '❚❚' : '▶';
  play.setAttribute('aria-label', t(clock.playing ? 'fly.timePause' : 'fly.timePlay'));
  play.title = play.getAttribute('aria-label');
  // The pace it runs at, lit while it is faster than real time.
  const rate = $('time-rate');
  rate.textContent = t(RATES.find(([, r]) => r === clock.rate)?.[0] ?? 'fly.rateReal');
  rate.setAttribute('aria-pressed', String(!clock.live && clock.rate > 1));
  setHidden($('time-now'), clock.live);
  showDate();
}

function showDate() {
  const el = $('time-date');
  if (clock.live || timeAway) {
    setText(el, '');
    return;
  }
  const d = new Date(simMs());
  const stopped = clock.clamped ? ` · ${t('fly.timeClamped', { y: d.getUTCFullYear() })}` : '';
  setText(el, `${formatDay(d, { year: true })} ${d.toISOString().slice(11, 16)} UT${stopped}  ·  `);
  el.title = stopped ? t('fly.timeClamped', { y: d.getUTCFullYear() }) : '';
}

/** The next pace: from real time a day a second, then on to a year a second and round again. */
function nextRate() {
  const k = clock.live ? -1 : RATES.findIndex(([, r]) => r === clock.rate);
  return RATES[(k + 1) % RATES.length][1];
}
$('time-play').addEventListener('click', () => setClock(clock.playing ? { live: false, playing: false } : { playing: true }));
$('time-rate').addEventListener('click', () => setClock({ live: false, playing: true, rate: nextRate() }));
$('time-now').addEventListener('click', () => setClock({ live: true, playing: true }));

/*
 * Whether there are planets near to move: within a thousand AU of the Sun,
 * or inside another star's system. Leaving, the clock is put away and
 * stopped; coming back, it is as it was.
 */
let timeAway = null;
function clockWhereItMatters() {
  const here = len(cam.eye) < 1000 * AU || Boolean(inSystem);
  if (here === !timeAway) return;
  setHidden($('time'), !here);
  if (!here) {
    timeAway = { live: clock.live, playing: clock.playing, rate: clock.rate };
    if (clock.live || clock.playing) setClock({ live: false, playing: false });
    else showDate();
    return;
  }
  const was = timeAway;
  timeAway = null;
  setClock(was.live ? { live: true, playing: true } : { playing: was.playing, rate: was.rate });
}

/** The bodies' positions as sent to the renderer, one array kept for it. */
let bodiesXyz = null;
function moveBodies() {
  const bodies = solarSystem(new Date(simMs()));
  const first = stars.firstBody;
  if (bodiesXyz?.length !== bodies.length * 3) bodiesXyz = new Float32Array(bodies.length * 3);
  const xyz = bodiesXyz;
  bodies.forEach((b, k) => {
    xyz.set(b.pos, k * 3);
    stars.pos.set(b.pos, (first + k) * 3);
  });
  space.movePositions(first, xyz);
  bodiesChanged++;
  carry();
}

/**
 * The body the camera stopped beside, so time moving it does not leave the
 * camera behind: { index } for a planet or the Moon, { at() } for another
 * star's planet, and the camera's offset from it.
 */
let carried = null;
function carry() {
  if (!carried) return;
  const now = carried.at ? carried.at() : posOf(carried.index);
  if (now) cam.eye = add(now, carried.offset);
}

/**
 * Inside the front page this layer is hidden most of the time, and a hidden
 * frame loop cost the front page nine tenths of its frame time: it stops
 * while hidden and starts again when shown.
 *
 * Shown, it draws only while something changes: a key or a finger flying,
 * the autopilot, a drag, the wheel, a button. A camera at rest is drawn
 * again four times a second, as the planets move, and otherwise left alone.
 */
let paused = embedded;
let looping = false;
addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.type === 'muninn:pause') paused = true;
  if (e.data?.type === 'muninn:resume' && paused) {
    paused = false;
    wake();
  }
});

/** Draw at the next frame, and go on drawing for as long as anything moves. */
function wake() {
  if (paused || looping || !space || !stars) return;
  looping = true;
  // The time since the last frame drawn is not time flown: the first step is a frame's.
  last = performance.now();
  requestAnimationFrame(frame);
}

/** Whether a key or a held button is flying the camera. */
function flying() {
  return keys.has('KeyW') || keys.has('ArrowUp') || keys.has('KeyS') || keys.has('ArrowDown')
    || keys.has('KeyA') || keys.has('ArrowLeft') || keys.has('KeyD') || keys.has('ArrowRight')
    || hold.forward || hold.back;
}

// The planets move slowly enough that four times a second is real time.
// A stopped clock moves nothing; a racing one moves them every frame.
setInterval(() => {
  if (paused || !space || !stars || racing() || (!clock.live && !clock.playing)) return;
  moveBodies();
  wake();
}, 250);

function frame(now) {
  if (paused) {
    looping = false;
    return;
  }
  const dt = Math.min(0.1, Math.max(0, now - last) / 1000);
  last = now;
  // The speed is a share of the distance to the nearest surface, so it is
  // measured from where the camera is before it moves. Measured only after,
  // a camera put somewhere new kept the distance from where it was before:
  // in the front page's flight, loaded out of sight and never drawn, that was
  // the parsec it starts with, and a W held from the sky flew the first frame
  // at half a parsec a second, out past Neptune. From beside the Earth the
  // first step is a few hundred km/s.
  if (racing()) {
    clampClock();
    moveBodies();
    showDate();
  }
  carry();
  scanBodies();
  const before = cam.eye;
  steer(dt);
  // After carry(): riding along with a planet is not flying.
  measureSpeed(before, dt);
  lastNear = nearestStar();
  const extra = drawSystem();
  clockWhereItMatters();
  const near = view.ir ? null : [...extra, ...lastNear].slice(0, 12);
  const share = surveyShare();
  drawSurvey(share);
  proj = space.draw({ ...basis(), fov: FOV, near, ir: view.ir, show: () => view.reach, survey: share });
  measureDiscs(basis());
  placeLabels();
  placeExoLabels();
  placeSystemLabels();
  drawScale(near);
  drawSolarOrbits();
  drawPicked();
  placeMarks();
  readout();
  refreshCard(now);
  if (autopilot || pullOut || fovEase || flying() || racing()) requestAnimationFrame(frame);
  else looping = false;
}

/* ---- a star's card ----------------------------------------------------- */

/**
 * What is under a point of the canvas. A disc drawn there first, the nearest;
 * then a body within a few pixels (the Sun, a planet or the Moon from inside
 * the Solar System, WISE 0855, another star's planet or a host drawn from
 * the Archive), the nearest on the screen; and only then a star, the
 * brightest-looking within a few pixels. A body is what a press near it
 * means, not the background star beside it.
 * Returns { index } for a catalogue star or body, { sys, pl } for another
 * star's planet, { sys } for a host, or null.
 */
const PICK_PX = 14;
function pickAt(px, py) {
  const b = basis();
  const pxPerRad = proj.focal[1] * (proj.h / proj.dpr) / 2;
  const discsHere = [
    ...(lastNear ?? []).map((n) => ({ pos: n.pos, rpc: n.rpc, got: { index: n.index } })),
    ...(inSystem?.spheres ?? []).map((n) => ({ pos: n.pos, rpc: n.rpc, got: n.planet ? { sys: inSystem.sys, pl: n.planet } : { sys: n.host } })),
  ].map((n) => ({ ...n, d: len(sub(n.pos, cam.eye)) })).sort((p, q) => p.d - q.d);
  for (const n of discsHere) {
    const c = screenOf(n.pos, b, proj);
    if (c && Math.hypot(c.x - px, c.y - py) <= (n.rpc / n.d) * pxPerRad) return n.got;
  }
  let near = null;
  let nearPx = PICK_PX;
  const consider = (pos, got) => {
    const at = screenOf(pos, b, proj);
    const dpx = at ? Math.hypot(at.x - px, at.y - py) : Infinity;
    if (dpx < nearPx) { nearPx = dpx; near = got; }
  };
  // From among the stars the planets are one point with the Sun: the Sun is meant.
  const inside = len(cam.eye) < 0.01;
  for (let i = stars.firstBody; inside && i < stars.mag.length; i++) consider(posOf(i), { index: i });
  consider(posOf(sunIndex), { index: sunIndex });
  if (stars.dark >= 0) consider(posOf(stars.dark), { index: stars.dark });
  for (const o of inSystem?.now ?? []) if (o.pos) consider(o.pos, { sys: inSystem.sys, pl: o.pl });
  if (inSystem && inSystem.sys.index < 0) consider(inSystem.sys.center, { sys: inSystem.sys });
  if (near) return near;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < stars.firstBody; i++) {
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
  return best >= 0 ? { index: best } : null;
}

/** Open what was pressed: a planet of another star, a host, or a catalogue star or body. */
function openPick(got) {
  if (got.pl) openPlanetCard(got.sys, got.pl);
  else if (got.sys) openSystemCard(got.sys);
  else openCard({ index: got.index });
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

/**
 * The small bodies known to go round the Sun (family.json, counted by JPL's
 * Small-Body Database on the day it says), loaded with the flight.
 */
let family = null;
async function loadFamily() {
  try {
    const res = await fetch('data/fly/family.json');
    if (res.ok) family = await res.json();
  } catch { /* the cards say the planets alone */ }
}
const familyDate = () => formatDay(new Date(`${family.counted}T00:00:00Z`), { year: true });

/**
 * What is known of a star, or of a named place; `entry` is a named entry or
 * { index }. With `keep` the body picked before stays picked, its orbit
 * drawn: the card is of what that body goes round.
 */
function openCard(entry, { keep = false } = {}) {
  const i = entry.index ?? -1;
  const s = entry.en ? entry : named.find((x) => x.index === i) ?? entry;
  const p = i >= 0 ? posOf(i) : s.pos;
  const fromSun = len(p);
  let title = s.en ? nameOf(s) : `HIP ${stars.hip[i]}`;
  if (i === sunIndex) title = nameOf(named.find((x) => x.key === 'sun'));
  $('card-fly').hidden = false;
  clearRound();
  const rows = [];
  /** The drift drawn for a star: a row after the rest. */
  const kin = [];
  // A planet moves with the clock, and the camera with the keys: the rows
  // with a third member are written again as they do (refreshCard).
  const at = () => (i >= 0 ? posOf(i) : s.pos);
  if (i !== sunIndex) rows.push([t('fly.cardSun'), distanceText(fromSun), () => distanceText(len(at()))]);
  rows.push([t('fly.cardHere'), distanceText(len(sub(p, cam.eye))), () => distanceText(len(sub(at(), cam.eye)))]);
  if (s.key === 'wise0855') {
    showRound({ centre: galCentre(p), note: `${t('fly.galHow')} ${t('fly.wiseAlone')}` });
    const seenTo = shells();
    rows.unshift([t('fly.cardVerdict'), t('fly.verdict', { n: seenTo[1].visits })]);
    rows.push([t('fly.cardW2'), t('fly.w2', { ab: fmt(WISE0855_AB, 1) })]);
    rows.push([t('fly.cardOne'), t('fly.limitOne', { ab: fmt(D6_ONE_VISIT_AB, 1), d: distanceText(seenTo[0].pc) })]);
    rows.push([t('fly.cardStack'), t('fly.limitStack', { n: seenTo[1].visits, ab: fmt(seenTo[1].limit, 1), d: distanceText(seenTo[1].pc) })]);
  } else if (s.key === 'p9') {
    rows.length = 0;
    // Already looking down on the region: there is nowhere nearer to fly.
    $('card-fly').hidden = atPlanetNine();
    rows.push([t('fly.cardP9Where'), t('fly.p9Where', { a: PLANET_NINE_AU[0], b: PLANET_NINE_AU[1], beta: PLANET_NINE_MAX_BETA })]);
    rows.push([t('fly.cardP9Bright'), t('fly.p9Bright', { lo: fmt(PLANET_NINE_V.bright, 1), hi: fmt(PLANET_NINE_V.faint, 1) })]);
    rows.push([t('fly.cardP9Gap'), t('fly.p9Gap', { x: fmt(planetNineShortfall(17.6), 0) })]);
  } else if (s.planet) {
    showRound(s.key === 'moon' ? moonRound(s) : planetRound(s));
    rows.push([t('fly.cardRadius'), t('fly.planetRadius', { km: fmt(s.km, 0), e: sig(s.km / 6371.0) })]);
    const f = FACTS[s.key];
    if (f) {
      rows.push([t('exo.periodH'), t('exo.periodLong', { p: fmt(f.year, f.year < 1000 ? 2 : 0) })]);
      rows.push([t('fly.cardDay'), t(f.day < 0 ? 'fly.dayRetro' : 'fly.dayLen', { d: fmt(Math.abs(f.day), Math.abs(f.day) < 2 ? 3 : 1) })]);
      rows.push([t('fly.cardGravity'), t('fly.gravity', { g: fmt(f.g, 2) })]);
      rows.push([t('fly.cardSurfaceT'), f.t]);
      if (s.key !== 'moon') rows.push([t('fly.cardMoons'), t('fly.moonsAsOf', { n: f.moons, date: formatDay(new Date(MOONS_AS_OF), { year: true }) })]);
      const m = surfaceInfo[s.key];
      if (m) rows.push([t('fly.cardMap'), `${t(MAP_KIND[s.key] ?? 'fly.mapTrue')} · ${m.credit}`]);
      const hm = heightInfo[s.key];
      if (hm && RELIEF[s.key]) rows.push([t('fly.cardRelief'), `${t('fly.relief', { n: fmt(RELIEF[s.key], RELIEF[s.key] % 1 ? 1 : 0) })} · ${hm.credit}`]);
    }
    rows.push([t('fly.cardSunAU'), t('fly.au', { n: fmt(fromSun / AU_PC, 2) }), () => t('fly.au', { n: num(len(at()) / AU_PC, 2) })]);
  } else if (i >= 0) {
    const m = stars.mag[i];
    const bv = stars.bv[i];
    rows.push([t('fly.cardTemp'), t('fly.kelvin', { n: fmt(Math.round(temperatureOf(bv) / 10) * 10, 0) })]);
    rows.push([t('fly.cardRadius'), t(stars.measured[i] ? 'fly.radiusMeasured' : 'fly.radiusEstimated', { n: sig(stars.rad[i]) })]);
    // In the Sun's place: how far out its surface would reach.
    const reachAU = stars.rad[i] * R_SUN_PC / AU;
    if (i !== sunIndex && reachAU > 0.3) {
      const past = [['fly.pastMercury', 0.387], ['fly.pastVenus', 0.723], ['fly.pastEarth', 1], ['fly.pastMars', 1.524], ['fly.pastJupiter', 5.203], ['fly.pastSaturn', 9.537]]
        .filter(([, au]) => reachAU > au).pop();
      rows.push([t('fly.cardInPlace'), past ? t(past[0], { au: fmt(reachAU, 2) }) : t('fly.inPlaceShort', { au: fmt(reachAU, 2) })]);
    }
    // With a measured radius, the luminosity follows from it and the
    // temperature; the magnitude's bolometric correction is weakest for the
    // coolest stars, which are the largest.
    const lum = stars.measured[i] ? stars.rad[i] ** 2 * (temperatureOf(bv) / T_SUN) ** 4 : luminosityOf(m, bv);
    rows.push([t('fly.cardLum'), t('fly.solar', { n: sig(lum) })]);
    if (i !== sunIndex) rows.push([t('fly.cardMag'), fmt(m + 5 * Math.log10(fromSun / 10), 2)]);
    showRound({ centre: galCentre(p), note: t(i === sunIndex ? 'fly.galHowSun' : 'fly.galHow') });
    if (i !== sunIndex) {
      if (motion && i < motion.length / 2) {
        const mu = Math.hypot(motion[i * 2], motion[i * 2 + 1]) / 1000;
        kin.push(cardRow(t('fly.driftH'), t('fly.drift', { mu: fmt(mu, mu < 0.1 ? 3 : 2), y: fmt(DRIFT_YEARS, 0) })));
      }
    }
  } else if (s.radius) {
    rows.push([t('fly.cardRadius'), t('fly.radiusModel', { n: sig(s.radius) })]);
  }
  $('card-title').textContent = title;
  if (s.planet) rows.splice(0, 1);
  // The Moon is placed by its own series, not by JPL's orbital elements.
  const bodyNote = s.key === 'moon' ? 'fly.moonNoteMap' : surfaceInfo[s.key] ? 'fly.planetNoteMap' : 'fly.planetNote';
  $('card-note').textContent = s.planet ? t(bodyNote) : s.key === 'wise0855'
    ? t('fly.dark')
    : s.key === 'p9' ? t('fly.p9Note')
    : i >= 0 && i !== sunIndex ? `HIP ${stars.hip[i]} · ${t('fly.cardSource')}` : '';
  const live = [];
  const liveRow = ([k, v, again]) => {
    const row = cardRow(k, v);
    if (again) live.push({ dd: row.querySelector('dd'), again });
    return row;
  };
  const drawRows = () => {
    live.length = 0;
    $('card-rows').replaceChildren(...rows.map(liveRow), ...kin);
  };
  drawRows();
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
    openSystemCard(host, { keep });
    return;
  }
  if (i === sunIndex && !entry.starOnly) {
    openSolarCard({ keep });
    return;
  }
  const ev = $('card-exo');
  ev.hidden = !host;
  if (host) {
    rows.push([t('exo.has'), host.planets.map((pl) => pl.name).join(', ')]);
    drawRows();
    ev.href = systemUrl([host.ra, host.dec, host.planets.length, host.host], host.host, getLanguage());
  }
  // What it goes round, drawn: a planet's orbit, the Moon's, a star's drift;
  // with `keep`, the orbit picked before stays instead.
  if (!keep) {
    if (s.planet) pick({ kind: s.key === 'moon' ? 'moon' : 'planet', key: s.key, index: i });
    else if (i >= 0 && i < stars.firstBody && i !== sunIndex && i !== stars.dark) pick({ kind: 'star', index: i });
    else pick(null);
  }
  card = { s: { ...s, index: i }, live, keep };
  showOrbitButton();
  $('card').hidden = false;
}

/**
 * The card's distances, written again a few times a second while it is
 * open: the planets move with the clock and the camera with the keys, and a
 * card left as it was opened said where things had been.
 */
let cardWrittenAt = 0;
function refreshCard(now) {
  if (!card?.live?.length || now - cardWrittenAt < 250) return;
  cardWrittenAt = now;
  for (const { dd, again } of card.live) setText(dd, again());
}

/** The card for a place that is not a star, shown once the autopilot has arrived. */
function openCardLater(entry) {
  // Drawn once more when it opens: the words over the sky make way for it.
  const wait = () => {
    if (autopilot) return requestAnimationFrame(wait);
    openCard(entry);
    wake();
  };
  requestAnimationFrame(wait);
}

/** Put the card away, keeping what was picked drawn: a flight to it hides the card until it arrives. */
function hideCard() {
  card = null;
  clearRound();
  facingCentre = false;
  $('card-fly').hidden = false;
  $('card-orbit').hidden = true;
  $('card-exo').hidden = true;
  $('card').hidden = true;
}

/** Close the card, and what was picked with it. */
function closeCard() {
  hideCard();
  pick(null);
}

$('card-fly').addEventListener('click', () => {
  if (!card) return;
  const { s } = card;
  if (s.sb) flyToSmallBody(s.sb);
  else if (s.pl) flyToExoPlanet(s.sys, s.pl);
  else if (s.sys) flyToSystem(s.sys);
  else if (s.key === 'p9') flyToPlanetNine();
  else flyTo(s);
});
$('card-close').addEventListener('click', closeCard);
$('card-orbit').addEventListener('click', () => framePicked());

/* ---- input ------------------------------------------------------------- */

const pointers = new Map();
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, moved: 0, ox: e.offsetX, oy: e.offsetY });
  autopilot = null;
  // On a touch screen the hint has often faded before the screen is touched:
  // the first touch brings it back for a few seconds, when it can be read.
  if (e.pointerType === 'touch' && !hintRetold) {
    hintRetold = true;
    $('hint').dataset.gone = 'false';
    setTimeout(() => { $('hint').dataset.gone = 'true'; }, 5000);
  } else {
    $('hint').dataset.gone = 'true';
  }
});
let hintRetold = false;
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
  wake();
});
canvas.addEventListener('pointerup', (e) => {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  // A press that did not drag is a choice of star.
  if (p && p.moved < 5 && stars && proj) {
    const got = pickAt(p.ox, p.oy);
    if (got) openPick(got);
    else closeCard();
  }
});
canvas.addEventListener('pointercancel', (e) => pointers.delete(e.pointerId));

// The wheel zooms, as everywhere on the site; speed is Shift, + and − on the keys, or ▲ held.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  FOV = Math.max(FOV_RANGE[0], Math.min(FOV_RANGE[1], FOV * Math.exp(e.deltaY / 600)));
  wake();
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
  if (e.code === 'Escape') { closePops(); closeCard(); }
  // With a card's list open, ← and → step through it rather than fly sideways (A and D still do).
  if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && card && roundList.length > 1) {
    e.preventDefault();
    if (!e.repeat) stepRound(e.code === 'ArrowRight' ? 1 : -1);
    return;
  }
  keys.add(e.code);
  if (heldFromSky === e.code) heldFromSky = null;
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setFactor(factor * 2);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') setFactor(factor / 2);
  if (e.code.startsWith('Arrow')) e.preventDefault();
  if (['KeyW', 'KeyS', 'KeyA', 'KeyD'].includes(e.code) || e.code.startsWith('Arrow')) autopilot = null;
  wake();
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (heldFromSky === e.code) heldFromSky = null;
});
addEventListener('blur', () => keys.clear());

/*
 * ▲ and ▼ fly while held. Held longer than a moment, they go faster: the
 * pace triples each second after the first half, up to the keys' fastest,
 * and is back where it was when let go. This is the touch screen's −/+.
 */
for (const [id, k] of [['go-forward', 'forward'], ['go-back', 'back']]) {
  const b = $(id);
  const on = (v) => (e) => {
    e.preventDefault();
    if (v === hold[k]) return;
    hold[k] = v;
    if (v) {
      hold.since = performance.now();
      hold.base = factor;
      autopilot = null;
      wake();
    } else if (!hold.forward && !hold.back) {
      setFactor(hold.base ?? factor);
    }
  };
  b.addEventListener('pointerdown', on(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, on(false));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}

/** While ▲ or ▼ is held: the pace for how long it has been. */
function holdFactor() {
  const held = (performance.now() - hold.since) / 1000;
  return Math.min(FACTOR_MAX, hold.base * 3 ** Math.max(0, held - 0.5));
}

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
    // The two shells' words at two heights: on the same line of sight they fell on one spot.
    { at: () => onSphere(one.pc, 0.42), text: () => t('fly.shellOne', { d: distanceText(one.pc) }) },
    { at: () => onSphere(stack.pc, 0.2), text: () => t('fly.shellStack', { n: stack.visits, d: distanceText(stack.pc) }) },
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
function onSphere(r, lift = 0.35) {
  const d = norm(add(cam.F, cam.U, lift));
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
    let at = pos ? screenOf(pos, b, proj) : null;
    // A mark on top of a label would be read as neither; nor one on a disc,
    // on another mark, under the card or cut by the edge.
    const text = at ? m.text() : '';
    if (at) labelBox(at, text.length * 0.9, probe);
    // Running into the card or the edge, it ends at its point instead of starting there.
    if (at && offLimits(probe)) {
      at.x -= probe.x1 - probe.x0 - 18;
      labelBox(at, text.length * 0.9, probe);
    }
    const onDisc = at && discs.some((n) => n.c && Math.hypot(n.c.x - at.x, n.c.y - at.y) < n.r + 12);
    const stacked = at && placedMarks.some((o) => Math.abs(o.x - at.x) < 220 && Math.abs(o.y - at.y) < 18);
    const hidden = Boolean(!at || crowded(probe) || offLimits(probe) || onDisc || stacked);
    setHidden(m.el, hidden);
    if (hidden) continue;
    placedMarks.push(at);
    setText(m.el, text);
    setPlace(m.el, at);
  }
}

/** Planet Nine's region as a destination: above the Sun's plane, looking down on it. */
const P9 = { key: 'p9', index: -1, pos: eclipticPoint(1, 0, 0).map(() => 0), en: 'Planet Nine (region)', ru: 'Планета Девять (зона)' };
/** The point Planet Nine's region is looked at from, and how near it counts as there. */
const P9_VIEW = eclipticPoint(2400 * AU, 200, 55);
const P9_THERE = 300 * AU;
const atPlanetNine = () => len(sub(cam.eye, P9_VIEW)) < P9_THERE;

function flyToPlanetNine() {
  closeCard();
  setTrip('p9');
  // Not carried along with the planet the camera was beside: it would be taken back to it.
  carried = null;
  autopilot = { from: cam.eye, to: P9_VIEW, look: [0, 0, 0], stop: 300 * AU, t0: performance.now(), ms: reduceMotion ? 1 : 3600 };
  wake();
}

/*
 * The trip: the destination last chosen. A trip to either of the challenge's
 * targets turns SPHEREx's reach on, where it says what it is for; the next
 * trip elsewhere turns it off again, unless it was turned on by hand. The
 * 4.6 µm view is offered only on the way to WISE 0855 and there, the one
 * place it shows something the eye cannot: a body that gives no visible light.
 */
let trip = null;
function setTrip(key) {
  trip = key;
  const target = key === 'p9' || key === 'wise0855';
  if (target && !view.reach) {
    setReach(true);
    view.reachAuto = true;
  } else if (!target && view.reachAuto) {
    setReach(false);
  }
  const offered = key === 'wise0855';
  setHidden($('ir'), !offered);
  if (!offered && view.ir) setIr(false);
}

function setReach(on) {
  view.reach = on;
  view.reachAuto = false;
  $('reach').setAttribute('aria-pressed', String(on));
  wake();
}

function setIr(on) {
  view.ir = on;
  $('ir').setAttribute('aria-pressed', String(on));
  setText($('read-note'), on ? t('fly.irNote') : '');
  setHidden($('read-note'), !on);
  wake();
}

$('reach').addEventListener('click', () => setReach(!view.reach));
$('ir').addEventListener('click', () => setIr(!view.ir));

// Inside the front page: out from the Earth, facing where its sky faced.
/** A key pressed on the front page's sky, held into the flight. */
let heldFromSky = null;
addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'muninn:keyup') return;
  keys.delete(e.data.key);
  if (heldFromSky === e.data.key) heldFromSky = null;
});

/** A direction asked for before the stars had loaded: applied once they have. */
let pendingLook = null;
addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'muninn:look') return;
  const { ra, dec, key, fov, mark } = e.data;
  // The front page's field, so the sky stays as it was on screen.
  if (Number.isFinite(fov)) {
    FOV = Math.max(FOV_RANGE[0], Math.min(FOV_RANGE[1], fov));
    // Wider than a view of space can stand without stretching what is near
    // the edges (the Earth came out an oval): taken over to keep the step out
    // seamless, then eased back over the first two seconds.
    fovEase = FOV > FOV_REST ? { from: FOV, t0: performance.now(), ms: 2000 } : null;
  }
  wake();
  if (![ra, dec].every(Number.isFinite)) return;
  // A key pressed on the sky goes on flying here until it is let go: here,
  // or on the page around, which says so; and if neither is heard, a moment.
  if (key) {
    keys.add(key);
    heldFromSky = key;
    setTimeout(() => { if (heldFromSky === key) { keys.delete(key); heldFromSky = null; } }, 1500);
  }
  if (!stars) {
    pendingLook = { ra, dec, mark };
    return;
  }
  if (mark) showMark(ra, dec, mark);
  else lookFromEarth(ra, dec);
});

/**
 * Out from the Earth's sky, facing `ra`, `dec`. The camera backs away and
 * turns round to the Earth it left; with `turn: false` it backs away still
 * facing the sky, and with `pullOut: false` it stays where it starts.
 */
function lookFromEarth(ra, dec, { turn = true, pullOut: leave = true } = {}) {
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
    if (leave && !reduceMotion && !keys.size) pullOut = { earth: earth.index, r, F0: cam.F, turn, t0: performance.now(), ms: 3200 };
  }
  factor = 0.5;
  wake();
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
  const turn = pullOut.turn ? Math.max(0, (x - 0.25) / 0.75) : 0;
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

/* ---- the Sun's own system ----------------------------------------------- */

/** Polylines as the two ends of each segment, one after the other, in double precision. */
function segmentEnds(lines) {
  let n = 0;
  for (const pts of lines) n += Math.max(0, pts.length - 1) * 6;
  const out = new Float64Array(n);
  let o = 0;
  for (const pts of lines) {
    for (let k = 0; k + 1 < pts.length; k++) {
      out.set(pts[k], o);
      out.set(pts[k + 1], o + 3);
      o += 6;
    }
  }
  return out;
}

/**
 * Segment ends moved by `base` and seen from the eye, into a single-precision
 * array kept for the purpose: the subtraction is made in double precision
 * first, so lines millionths of a parsec from the camera stay where they are.
 */
function fromEye(ends, base, into) {
  const [ex, ey, ez] = cam.eye;
  const [bx, by, bz] = base;
  for (let i = 0; i < ends.length; i += 3) {
    into[i] = ends[i] + bx - ex;
    into[i + 1] = ends[i + 1] + by - ey;
    into[i + 2] = ends[i + 2] + bz - ez;
  }
  return into;
}

/** Null if `was` was kept for this eye and these bodies (and `more`); otherwise the key to keep now. */
function sameView(was, ...more) {
  const now = [...cam.eye, bodiesChanged, ...more];
  return was && was.length === now.length && was.every((v, i) => v === now[i]) ? null : now;
}

const ORIGIN = [0, 0, 0];
let solarPaths = null;
/** The moments shown the planets' orbits and the Moon's were traced for, and a count of tracings. */
let solarPathsAt = 0;
let moonPathAt = 0;
let pathsTraced = 0;
/** The orbits' segment ends, from the Sun, and the Moon's, from the Earth. */
let solarEnds = null;
let moonEnds = null;
/** The same from the eye, rewritten only when the eye or the planets have moved. */
let solarFromEye = null;
let moonFromEye = null;
let solarDrawnFor = null;

/**
 * The orbits for the moment shown. The planets' barely change in a month of
 * it, and are traced again then; the Moon's is traced from the day shown
 * through one month, so the Moon is on it, and again for each day the clock
 * moves on: its orbit turns, a full turn of its perigee in nine years.
 */
function tracePaths() {
  const at = simMs();
  if (!solarPaths || Math.abs(at - solarPathsAt) > 30 * 86400000) {
    solarPaths = solarOrbits(new Date(at));
    solarPathsAt = at;
    moonPathAt = at;
    solarEnds = segmentEnds(Object.entries(solarPaths).filter(([key]) => key !== 'moon').map(([, pts]) => pts));
    moonEnds = segmentEnds([solarPaths.moon]);
    solarFromEye = new Float32Array(solarEnds.length);
    moonFromEye = new Float32Array(moonEnds.length);
    pathsTraced++;
  } else if (Math.abs(at - moonPathAt) > 86400000) {
    solarPaths.moon = moonOrbit(new Date(at));
    moonPathAt = at;
    moonEnds = segmentEnds([solarPaths.moon]);
    pathsTraced++;
  }
}

/** The planets' orbits within a few hundred AU of the Sun, the Moon's near the Earth: relative to the eye. */
function drawSolarOrbits() {
  const fromSun = len(cam.eye);
  if (fromSun > 400 * AU) {
    space.setLiveLines(null, null, 'solar');
    space.setLiveLines(null, null, 'moon');
    solarDrawnFor = null;
    return;
  }
  tracePaths();
  const next = sameView(solarDrawnFor, pathsTraced);
  if (!next) return;
  solarDrawnFor = next;
  space.setLiveLines(fromEye(solarEnds, ORIGIN, solarFromEye), [0.75, 0.82, 1, 0.28], 'solar');
  const earth = named.find((x) => x.key === 'earth');
  const earthPos = earth ? posOf(earth.index) : null;
  if (earthPos && len(sub(cam.eye, earthPos)) < 0.05 * AU) {
    space.setLiveLines(fromEye(moonEnds, earthPos, moonFromEye), [0.75, 0.82, 1, 0.35], 'moon');
  } else {
    space.setLiveLines(null, null, 'moon');
  }
}

/** The Sun's card as a system: its planets from above, and a way to each; `keep` as for openCard. */
function openSolarCard({ keep = false } = {}) {
  const planets = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'].map((key) => {
    const s = named.find((x) => x.key === key);
    const p = posOf(s.index);
    // The angle in the drawing: the planet's place on its orbit now, seen from the ecliptic's north.
    const ecl = [p[0], p[1] * Math.cos(23.4393 * Math.PI / 180) + p[2] * Math.sin(23.4393 * Math.PI / 180)];
    return { s, f: FACTS[key], angle: Math.atan2(ecl[1], ecl[0]) };
  });
  const sys = {
    host: nameOf(named.find((x) => x.key === 'sun')), starR: 1, teff: 5772, solar: true,
    planets: planets.map(({ s, f, angle }) => ({ name: nameOf(s), a: f.a, r: s.km / 6371, angle })),
  };
  hideCard();
  if (!keep) pick(null);
  $('card-title').textContent = sys.host;
  $('card-note').textContent = t('fly.solarNote');
  const pickedKey = picked?.kind === 'planet' || picked?.kind === 'moon' ? picked.key : null;
  showRound({
    centre: galCentre(ORIGIN), note: t('fly.galHowSun'),
    also: { title: t('fly.roundSunIt'), items: planetItems(pickedKey) },
  });
  const rows = [
    [t('fly.cardTemp'), t('fly.kelvin', { n: fmt(5772, 0) })],
    [t('fly.cardRadius'), t('fly.radiusMeasured', { n: fmt(1, 2) })],
  ];
  if (family) {
    const c = family.counts;
    rows.push([t('fly.roundItH'), t('fly.sunFamily', {
      neo: fmt(c.neo, 0), main: fmt(c.main, 0), trojan: fmt(c.trojan, 0), centaur: fmt(c.centaur, 0), tno: fmt(c.tno, 0), comet: fmt(c.comet, 0), date: familyDate(),
    })]);
  }
  $('card-rows').replaceChildren(systemDiagram(sys), ...rows.map(([k, v]) => cardRow(k, v)));
  $('card-frames').hidden = true;
  $('card-exo').hidden = true;
  card = { s: { key: 'sun', index: sunIndex }, keep };
  showOrbitButton();
  $('card').hidden = false;
}

/* ---- the Sun's planets for scale ---------------------------------------- */

/*
 * A star seen close is a sphere filling the view, and one sphere looks much
 * like another: Betelgeuse from ten AU and the Sun from a thousandth of that
 * fill the screen alike. Round a star seen large, the orbits of the Earth and
 * of Jupiter are drawn as if the Sun's planets went round it, in the plane
 * facing the camera: inside Betelgeuse, the Earth's orbit is lost in the star.
 */
const SCALE_ORBITS = [[1, 'fly.orbitEarth'], [5.203, 'fly.orbitJupiter'], [30.07, 'fly.orbitNeptune']];

const SCALE_STEPS = 128;
const scaleFromEye = new Float32Array(SCALE_ORBITS.length * SCALE_STEPS * 6);
let scaleDrawnFor = null;

function drawScale(nears) {
  const box = $('scale-labels');
  const star = (nears ?? []).find((n) => !n.lit && n.index >= 0);
  const d = star ? len(sub(star.pos, cam.eye)) : Infinity;
  // Only for a star filling a good part of the view, and an orbit that would show.
  const discFrac = star ? (star.rpc / d) / Math.tan((FOV * Math.PI) / 360) : 0;
  if (!star || discFrac < 0.08) {
    space.setLiveLines(null, null, 'scale');
    scaleDrawnFor = null;
    if (box.childElementCount) box.replaceChildren();
    return;
  }
  const toCam = norm(sub(cam.eye, star.pos));
  let a = cross(toCam, cam.U);
  if (len(a) < 1e-6) a = cross(toCam, [1, 0, 0]);
  a = norm(a);
  const bvec = norm(cross(toCam, a));
  const marks = [];
  // The circles face the camera: traced again when it moves or rolls, not otherwise.
  const next = sameView(scaleDrawnFor, star.index, ...cam.U);
  let o = 0;
  for (const [au, key] of SCALE_ORBITS) {
    const r = au * AU;
    // An orbit far wider than the view, or far smaller than the star, says nothing.
    if (r / d > 3 || r < star.rpc * 0.05) continue;
    for (let k = 0; next && k < SCALE_STEPS; k++) {
      for (const step of [k, k + 1]) {
        const ang = (step / SCALE_STEPS) * 2 * Math.PI;
        const rc = r * Math.cos(ang);
        const rs = r * Math.sin(ang);
        for (let j = 0; j < 3; j++) scaleFromEye[o++] = star.pos[j] + a[j] * rc + bvec[j] * rs - cam.eye[j];
      }
    }
    marks.push({ pos: add(star.pos, bvec, r * 0.96), text: t(key), inside: r < star.rpc });
  }
  if (next) {
    scaleDrawnFor = next;
    space.setLiveLines(o ? scaleFromEye.subarray(0, o) : null, [0.75, 0.85, 1, 0.55], 'scale');
  }
  while (box.childElementCount < marks.length) {
    const el = document.createElement('span');
    el.className = 'fly-mark fly-mark--scale';
    box.append(el);
  }
  const b = basis();
  [...box.children].forEach((el, k) => {
    const m = marks[k];
    const at = m ? screenOf(m.pos, b, proj) : null;
    setHidden(el, !at);
    if (!at) return;
    setText(el, m.inside ? t('fly.orbitInside', { orbit: m.text }) : m.text);
    setPlace(el, at);
  });
}

/* ---- other stars' planets --------------------------------------------- */

/*
 * Every confirmed exoplanet system with a known distance (NASA Exoplanet
 * Archive, pscomppars), native here: the stars that have planets are marked,
 * and near one its planets are drawn at their real sizes on their measured
 * orbits (orbits.js: the eccentricity and periastron where the Archive has
 * them, the tilt where it has it, edge-on to the Sun where it does not).
 * Where a transit or conjunction time was measured the planet is where it is
 * at the moment shown; elsewhere only the orbit is drawn, with no planet put
 * at a guessed place.
 */
const R_EARTH_PC = 6371 / 3.0856775814913673e13;
let exo = [];
/** The system the camera is in, and what was drawn for it this frame. */
let inSystem = null;
/** The hosts matched by Hipparcos number and by place: how many of each, for the curious (window.flyHosts). */
let hostMatch = null;

async function loadSystems() {
  try {
    const res = await fetch('data/fly/exoplanets.json');
    if (!res.ok) return;
    const body = await res.json();
    exo = body.systems ?? [];
    loadSurfaces();
    // A host that is a Hipparcos star is centred on the catalogue's star, so
    // its planets circle the disc drawn for it.
    if (!starCells) buildCells();
    const hipIndex = new Map();
    for (let i = 0; i < stars.firstBody - 2; i++) hipIndex.set(stars.hip[i], i);
    const matched = matchHosts(exo, hipIndex, cellsNear, posOf);
    hostMatch = { byHip: 0, byPlace: 0, none: 0 };
    exo.forEach((sys, k) => {
      sys.index = matched[k];
      sys.center = sys.index >= 0 ? posOf(sys.index) : sys.pos;
      hostMatch[sys.index < 0 ? 'none' : sys.hip && hipIndex.get(sys.hip) === sys.index ? 'byHip' : 'byPlace']++;
      // The archive's radius is measured (or modelled from a spectrum); the
      // catalogue star's was estimated from its colour: the archive's is used.
      if (sys.index >= 0 && sys.starR > 0 && !stars.measured[sys.index]) {
        stars.rad[sys.index] = sys.starR;
        stars.measured[sys.index] = 1;
        bodiesChanged++;
      }
    });
    buildExoLabels();
    wake();
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

/** The catalogue stars in the degree cells round a system's place. */
function cellsNear(sys) {
  const out = [];
  for (const dra of [-1, 0, 1]) {
    for (const ddec of [-1, 0, 1]) {
      const list = starCells.get(cellKey(((sys.ra + dra) % 360 + 360) % 360, sys.dec + ddec));
      if (list) out.push(...list);
    }
  }
  return out;
}

/* ---- a star's drift ------------------------------------------------------ */

/**
 * The Hipparcos proper motions (motion.bin, built by build-fly-motion.mjs):
 * µα·cos δ and µδ, mas a year, per catalogue star in stars.bin's order.
 * Loaded after the flight is up; a star picked before has its drift drawn
 * once they arrive.
 */
let motion = null;
async function loadMotion() {
  try {
    const res = await fetch('data/fly/motion.bin');
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== (stars.firstBody - 2) * 4) return;
    motion = new Int16Array(buf);
    if (picked?.kind === 'star' && !picked.ends) pick(picked);
    if (card && !card.s.sys && card.s.index >= 0 && !card.s.planet) openCard(card.s);
  } catch { /* the drift is left out */ }
}

/** How many years each way a star's drift is drawn. */
const DRIFT_YEARS = 10000;

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
    el.nameEl = el.querySelector('.fly-label__name');
    el.farEl = el.querySelector('.fly-label__far');
    $('labels').append(el);
    return el;
  });
}

/*
 * Which hosts are named: those within twenty light years of the camera, the
 * neighbourhood a trip is through; all of them out to sixty parsecs with
 * "Planets around stars" on. The system picked, or the one the camera is
 * in, is named wherever it is.
 */
const EXO_NEAR_PC2 = (20 / LY_PER_PC) ** 2;
const EXO_ALL_PC2 = 60 ** 2;
let exoAll = false;
$('exo-all').addEventListener('click', () => {
  exoAll = !exoAll;
  $('exo-all').setAttribute('aria-pressed', String(exoAll));
  wake();
});

function placeExoLabels() {
  if (!exo.length) return;
  const b = basis();
  const near = [];
  const [ex, ey, ez] = cam.eye;
  const reach2 = exoAll ? EXO_ALL_PC2 : EXO_NEAR_PC2;
  const own = picked?.sys ?? card?.s?.sys ?? inSystem?.sys ?? null;
  for (const sys of exo) {
    // Five thousand systems a frame: their distances without an array for each.
    const c = sys.center;
    const d2 = (c[0] - ex) ** 2 + (c[1] - ey) ** 2 + (c[2] - ez) ** 2;
    if (d2 > reach2 && sys !== own) continue;
    const d = Math.sqrt(d2);
    const at = screenOf(c, b, proj);
    if (!at) continue;
    // Behind a nearer disc (a planet beside the camera): hidden by it.
    if (discs.some((n) => n.d < d && n.c && Math.hypot(n.c.x - at.x, n.c.y - at.y) < n.r + 8)) continue;
    near.push({ sys, d, at });
  }
  near.sort((x, y) => x.d - y.d);
  let k = 0;
  // After the named stars' labels, which keep their places: a host's label
  // that would run into one ("HD 180617 · 1 planet" over Barnard's Star) waits.
  for (const n of near) {
    if (k >= exoLabels.length) break;
    const name = t('exo.label', { host: hostName(n.sys), n: n.sys.planets.length });
    const far = distanceText(n.d);
    labelBox(n.at, name.length + far.length, probe);
    if (crowded(probe) || offLimits(probe)) continue;
    takeBox(probe);
    const el = exoLabels[k++];
    el.sys = n.sys;
    const kin = labelsQuiet && picked?.sys === n.sys;
    if (el.kin !== kin) {
      el.classList.toggle('fly-label--kin', kin);
      el.kin = kin;
    }
    setHidden(el, false);
    setText(el.nameEl, name);
    setText(el.farEl, far);
    setPlace(el, n.at);
  }
  for (; k < exoLabels.length; k++) setHidden(exoLabels[k], true);
}

/**
 * The system's planets at the moment shown: each with its orbit (orbits.js)
 * and, where a transit or conjunction time is known, where it is on it. The
 * array and the places are kept on the system and written over in place.
 */
function systemNow(sys) {
  if (!sys.now) {
    sys.frame = skyFrame(sys.center);
    sys.now = sys.planets.map((pl) => ({ pl, orbit: pl.a > 0 ? orbitOf(pl) : null, pos: null, at: [0, 0, 0] }));
  }
  const jd = JD();
  for (const o of sys.now) {
    o.pos = null;
    if (!o.orbit) continue;
    const f = anomalyAt(o.orbit, o.pl.tc, o.pl.p, jd);
    if (f == null) continue;
    offsetAt(o.orbit, f, sys.frame, o.at);
    for (let k = 0; k < 3; k++) o.at[k] = sys.center[k] + o.at[k] * AU;
    o.pos = o.at;
  }
  return sys.now;
}

/** The frame a system's orbits are drawn in: towards the Sun, and across. */
function frameOf(sys) {
  if (!sys.frame) systemNow(sys);
  return sys.frame;
}

/** The system the camera is in: the nearest within a thousand AU of its star. */
function systemHere() {
  let best = null;
  let bestD2 = (1000 * AU) ** 2;
  const [ex, ey, ez] = cam.eye;
  for (const sys of exo) {
    const c = sys.center;
    const d2 = (c[0] - ex) ** 2 + (c[1] - ey) ** 2 + (c[2] - ez) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = sys; }
  }
  return best;
}

const ORBIT_STEPS = 128;

/** A system's orbits as segment ends, parsecs from the Sun: ellipses, traced once. */
function orbitEnds(sys) {
  const drawn = systemNow(sys).filter((o) => o.orbit);
  const per = ORBIT_STEPS * 6;
  const out = new Float64Array(drawn.length * per);
  drawn.forEach((o, k) => ellipseEnds(o.orbit, sys.frame, sys.center, AU, ORBIT_STEPS, out.subarray(k * per, (k + 1) * per)));
  return out;
}

/** The eye and the system the orbits were last moved to. */
let systemDrawnFor = null;

/** Orbits and planets of the system the camera is in, every frame. */
function drawSystem() {
  const sys = exo.length ? systemHere() : null;
  inSystem = null;
  if (!sys) {
    space.setLiveLines(null);
    systemDrawnFor = null;
    return [];
  }
  const now = systemNow(sys);
  // The orbits stay as they are: traced once for a system, and moved to the
  // eye (in double precision, before they become single) only when the eye
  // has moved.
  if (!sys.orbitEnds) {
    sys.orbitEnds = orbitEnds(sys);
    sys.orbitFromEye = new Float32Array(sys.orbitEnds.length);
  }
  const next = sameView(systemDrawnFor, sys.host);
  if (next) {
    systemDrawnFor = next;
    space.setLiveLines(fromEye(sys.orbitEnds, ORIGIN, sys.orbitFromEye), [0.55, 0.9, 0.75, 0.45]);
  }
  const starCol = sys.index >= 0 ? [stars.col[sys.index * 3], stars.col[sys.index * 3 + 1], stars.col[sys.index * 3 + 2]] : starColour(0.65).map((c) => c / 255);
  const spheres = [];
  // A host the catalogue lacks is drawn here, at its archive radius.
  if (sys.index < 0 && sys.starR) {
    spheres.push({ index: -1, pos: sys.center, rpc: sys.starR * R_SUN_PC, col: starCol, lit: false, host: sys });
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
  const pxPerRad = proj.focal[1] * (proj.h / proj.dpr) / 2;
  [...box.children].forEach((el, k) => {
    const o = items[k];
    const at = o ? screenOf(o.pos, b, proj) : null;
    setHidden(el, !at);
    if (!at) return;
    // The planet picked is named in the colour of its orbit, under its disc however large.
    const chosen = picked?.kind === 'exo' && picked.pl === o.pl;
    if (el.chosen !== chosen) {
      el.classList.toggle('fly-mark--picked', chosen);
      el.chosen = chosen;
    }
    const discPx = ((o.pl.r * R_EARTH_PC) / Math.max(len(sub(o.pos, cam.eye)), 1e-30)) * pxPerRad;
    setText(el, planetName(inSystem.sys, o.pl));
    setPlace(el, at, Math.max(12, discPx + 8));
  });
}

/** The habitable zone's words under a diagram, with the star's temperature when it lay outside the fit. */
function zoneNote(hz, teff) {
  if (!hz) return '';
  const words = t('fly.diagramHz', { i: fmt(hz.inner, 2), o: fmt(hz.outer, 2), oi: fmt(hz.optInner, 2), oo: fmt(hz.optOuter, 2) });
  return hz.clamped ? `${words} ${t('fly.hzClamped', { t: fmt(teff, 0) })}` : words;
}

/**
 * The system seen from above: its orbits to scale (ellipses where the
 * eccentricity is measured, with the star at a focus), its habitable zone,
 * conservative and optimistic, and where each planet is at the moment shown.
 */
function systemDiagram(sys) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const svg = el('svg', { viewBox: '-110 -110 220 220', class: 'fly-system', role: 'img' });
  const hz = habitableZone(sys.starR, sys.teff);
  const widest = Math.max(...sys.planets.map((pl) => (pl.a || 0) * (1 + (pl.e > 0 ? Math.min(pl.e, 0.97) : 0))), hz ? hz.outer * 0.6 : 0, 0.01);
  const scale = 100 / widest;
  if (hz && hz.optInner * scale < 105) {
    // Each zone a ring, from its inner edge to its outer one: the conservative
    // zone, and the optimistic one paler on either side of it.
    const band = (from, to, cls) => {
      const r0 = Math.min(from * scale, 104);
      const r1 = Math.min(to * scale, 104);
      if (r1 > r0) svg.append(el('circle', { r: ((r0 + r1) / 2).toFixed(2), 'stroke-width': (r1 - r0).toFixed(2), class: cls }));
    };
    band(hz.optInner, hz.inner, 'fly-system__hz-opt');
    band(hz.inner, hz.outer, 'fly-system__hz');
    band(hz.outer, hz.optOuter, 'fly-system__hz-opt');
  }
  svg.append(el('circle', { r: 3.5, class: 'fly-system__star' }));
  const jd = JD();
  for (const pl of sys.planets) {
    if (!(pl.a > 0)) continue;
    const orbit = pl.angle == null ? orbitOf(pl) : null;
    const a = pl.a * scale;
    // Seen from above the planets' plane: the periastron at ω from the node,
    // the star at the focus; the Sun's planets come as circles.
    if (orbit && orbit.e > 0) {
      const b = a * Math.sqrt(1 - orbit.e * orbit.e);
      const cx = -a * orbit.e * Math.cos(orbit.w);
      const cy = -a * orbit.e * Math.sin(orbit.w);
      svg.append(el('ellipse', { cx: cx.toFixed(2), cy: cy.toFixed(2), rx: a.toFixed(2), ry: b.toFixed(2), transform: `rotate(${(orbit.w * 180 / Math.PI).toFixed(1)} ${cx.toFixed(2)} ${cy.toFixed(2)})`, class: 'fly-system__orbit' }));
    } else {
      svg.append(el('circle', { r: a, class: 'fly-system__orbit' }));
    }
    let x = null;
    let y = null;
    if (pl.angle != null) {
      x = a * Math.cos(pl.angle);
      y = a * Math.sin(pl.angle);
    } else {
      // At conjunction the planet is between its star and the Sun: the bottom of the drawing.
      const f = anomalyAt(orbit, pl.tc, pl.p, jd);
      if (f != null) {
        const r = (a * (1 - orbit.e * orbit.e)) / (1 + orbit.e * Math.cos(f));
        x = r * Math.cos(orbit.w + f);
        y = r * Math.sin(orbit.w + f);
      }
    }
    if (x != null) {
      const dot = el('circle', { cx: x.toFixed(2), cy: y.toFixed(2), r: Math.max(2, Math.min(6, Math.sqrt(pl.r || 1) * 1.5)), class: 'fly-system__planet' });
      const title = el('title', {});
      title.textContent = pl.name;
      dot.append(title);
      svg.append(dot);
    }
  }
  const scaleNote = document.createElement('p');
  scaleNote.className = 'fly-system__note';
  scaleNote.textContent = [
    t('fly.diagram', { a: fmt(widest, widest < 1 ? 2 : 1) }),
    zoneNote(hz, sys.teff),
    sys.solar ? '' : t('fly.diagramWhere'),
  ].filter(Boolean).join(' ');
  const box = document.createElement('figure');
  box.className = 'fly-system__box';
  box.append(svg, scaleNote);
  return box;
}

/** A row whose value ends in buttons: each opens that body's card. */
function chipsRow(k, v, chips) {
  const row = cardRow(k, v);
  if (!chips.length) return row;
  const box = document.createElement('span');
  box.className = 'fly-kin';
  for (const { name, open } of chips) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fly-planet-go fly-kin__go';
    b.textContent = name;
    b.addEventListener('click', open);
    box.append(b);
  }
  row.querySelector('dd').append(box);
  return row;
}

/**
 * The other stars of a planet host's system that have planets of their own
 * (55 Cnc and 55 Cnc B): hosts within half a degree on the sky and a tenth
 * in distance. The Archive gives only how many stars a system has.
 */
function companionsOf(sys) {
  if (!(sys.stars > 1)) return [];
  const u = norm(sys.pos);
  const cos = Math.cos(0.5 * Math.PI / 180);
  return exo.filter((o) => o !== sys && Math.abs(o.pc - sys.pc) < 0.1 * sys.pc && dot(norm(o.pos), u) > cos);
}

/** The row for a host's companions, where it has any. */
function companionsRow(sys) {
  if (!(sys.stars > 1)) return null;
  const others = companionsOf(sys);
  return chipsRow(t('fly.companionsH'), t(others.length ? 'fly.companions' : 'fly.companionsNone', { n: sys.stars }),
    others.map((o) => ({ name: hostName(o), open: () => openSystemCard(o) })));
}

/** A planet's radius as the card says it: measured, or the Archive's estimate from its mass. */
function exoRadius(pl, long) {
  if (pl.rEst) return t(long ? 'fly.radiusEstLong' : 'fly.radiusEst', { r: fmt(pl.r, pl.r < 10 ? 1 : 0) });
  return long ? t('exo.radiusLong', { r: fmt(pl.r, pl.r < 10 ? 2 : 1), j: fmt(pl.r / 11.21, 2) }) : t('exo.radius', { r: fmt(pl.r, pl.r < 10 ? 1 : 0) });
}

/**
 * A host as the page names it: the Archive's name ("Proxima Cen"), or the
 * star's own name in the page's language where the page names that star
 * ("Проксима Центавра"), so the card says what the chips and labels say.
 */
function hostName(sys) {
  const s = sys.index >= 0 ? named.find((x) => x.index === sys.index && x.hip) : null;
  return s ? nameOf(s) : sys.host;
}

/** A planet's name with its host's name as the page gives it: "Proxima Centauri b". */
function planetName(sys, pl) {
  return pl.name.startsWith(sys.host) ? hostName(sys) + pl.name.slice(sys.host.length) : pl.name;
}

/** How a planet was found, in words: the Archive's discovery method, translated. */
function methodText(pl) {
  if (!pl.method) return '—';
  const key = `exo.m.${pl.method.replace(/\W/g, '')}`;
  const words = t(key);
  return words === key ? pl.method : words;
}

/**
 * A system's card: what its star goes round, its planets as a list to pick
 * from, and the way to ExoVision for the rest; `keep` as for openCard.
 */
function openSystemCard(sys, { keep = false } = {}) {
  hideCard();
  if (!keep) pick(null);
  $('card-title').textContent = hostName(sys);
  $('card-note').textContent = t('fly.exoNote');
  const current = picked?.kind === 'exo' && picked.sys === sys ? picked.pl : null;
  showRound({
    centre: galCentre(sys.center), note: t('fly.galHow'), beside: companionsRow(sys),
    also: { title: t('fly.roundIt', { host: hostName(sys) }), items: exoItems(sys, current) },
  });
  const rows = [[t('fly.cardSun'), distanceText(sys.pc)]];
  if (sys.teff) rows.push([t('fly.cardTemp'), t('fly.kelvin', { n: fmt(sys.teff, 0) })]);
  if (sys.starR) rows.push([t('fly.cardRadius'), t('fly.starArchive', { n: sig(sys.starR), ref: sys.starRef ?? t('fly.starComposite') })]);
  $('card-rows').replaceChildren(systemDiagram(sys), ...rows.map(([k, v]) => cardRow(k, v)));
  const frames = $('card-frames');
  frames.hidden = false;
  const url = new URL('./', location.href);
  url.hash = encodeHash({ ra: sys.ra, dec: sys.dec, fov: 0.3, band: 'D2', lang: getLanguage(), name: sys.host });
  frames.href = url.href;
  const ev = $('card-exo');
  ev.hidden = false;
  ev.href = systemUrl([sys.ra, sys.dec, sys.planets.length, sys.host], sys.host, getLanguage());
  card = { s: { key: `sys:${sys.host}`, sys, index: sys.index }, keep };
  showOrbitButton();
  $('card').hidden = false;
}

/**
 * Fly into a system: to a point above the plane of its orbits, high enough
 * that the widest is whole on the screen, looking down at the star, so the
 * star and every planet are seen together.
 */
function flyToSystem(sys) {
  setTrip(null);
  hideCard();
  carried = null;
  const widest = Math.max(...sys.planets.map((pl) => (pl.a || 0) * (1 + (pl.e > 0 ? Math.min(pl.e, 0.97) : 0))), 0.02) * AU;
  const height = Math.max(widest / Math.tan((FOV * Math.PI) / 360) * 1.35, (sys.starR || 1) * R_SUN_PC * 10);
  const { up, toSun } = frameOf(sys);
  // From above and a little to the Sun's side, so the orbits are ellipses, not lines.
  const to = add(add(sys.center, up, height * 0.92), toSun, height * 0.4);
  autopilot = {
    from: cam.eye, to, look: sys.center, stop: height, t0: performance.now(), body: -1,
    ms: reduceMotion ? 1 : 3400 + 400 * Math.log10(1 + len(sub(sys.center, cam.eye)) / height),
  };
  wake();
  const wait = () => (autopilot ? requestAnimationFrame(wait) : openSystemCard(sys));
  requestAnimationFrame(wait);
}

/** Where one of a system's planets is at the moment shown; null where that is not known. */
const exoPlace = (sys, pl) => systemNow(sys).find((o) => o.pl === pl)?.pos ?? null;

/**
 * The pole of a planet's orbit: the orbit lies along `node` and along `up`
 * tipped towards the Sun by the inclination (orbits.js, offsetAt).
 */
function orbitPole(orbit, { node, up, toSun }) {
  const inPlane = add(up.map((c) => c * Math.cos(orbit.i)), toSun, Math.sin(orbit.i));
  const pole = norm(cross(node, inPlane));
  // Of its two sides, the one facing the Sun: the orbit is seen as it is drawn on the card.
  return dot(pole, toSun) < 0 ? pole.map((c) => -c) : pole;
}

/** How far above its orbit's plane the camera comes to a planet, as seen from its star. */
const EXO_ARRIVE_TILT = 30 * Math.PI / 180;

/**
 * One of a system's planets: the camera goes to it, and its card is shown.
 * From beside the planet its orbit, thousands of its radii round, is a
 * straight line through it, edge-on whatever the angle; so the camera stops
 * outside the orbit and 30° above its plane, as seen from the star, nearly
 * three times as far from the star as the planet is: the whole orbit is an
 * ellipse in the view, the star inside it, and the planet, ringed and named,
 * on it. W flies on in.
 */
function flyToExoPlanet(sys, pl) {
  setTrip(null);
  const at = exoPlace(sys, pl);
  if (!at || !(pl.r > 0)) {
    flyToSystem(sys);
    const wait = () => (autopilot ? requestAnimationFrame(wait) : openPlanetCard(sys, pl));
    requestAnimationFrame(wait);
    return;
  }
  hideCard();
  carried = null;
  const rp = pl.r * R_EARTH_PC;
  const o = systemNow(sys).find((x) => x.pl === pl);
  const fromStar = sub(at, sys.center);
  const outward = norm(fromStar);
  const pole = orbitPole(o.orbit, frameOf(sys));
  const eye = add(sys.center, add(outward.map((c) => c * Math.cos(EXO_ARRIVE_TILT)), pole, Math.sin(EXO_ARRIVE_TILT)), 2.8 * len(fromStar));
  const stop = Math.max(len(sub(eye, at)), rp * 7);
  const to = add(at, norm(sub(eye, at)), stop);
  autopilot = {
    from: cam.eye, to, look: [...at], stop, t0: performance.now(), body: -1,
    ms: reduceMotion ? 1 : 3000 + 400 * Math.log10(1 + len(sub(at, cam.eye)) / stop),
    follow: () => exoPlace(sys, pl),
    // Looking most of the way from the planet to its star: the ellipse round the star fills the middle.
    aim: (p) => add(p, sub(sys.center, p), 0.6),
  };
  wake();
  const wait = () => (autopilot ? requestAnimationFrame(wait) : openPlanetCard(sys, pl));
  requestAnimationFrame(wait);
}

/** The words for how a planet's orbit is drawn: what was measured, and what was not. */
function orbitWords(pl) {
  const o = orbitOf(pl);
  return [
    o.eKnown ? t('fly.shapeE', { e: fmt(o.e, 2) }) : t('fly.shapeENone'),
    o.e > 0 ? (o.wKnown ? t('fly.shapeW', { w: fmt(pl.w, 0) }) : t('fly.shapeWNone')) : '',
    o.iKnown ? t('fly.shapeI', { i: fmt(pl.i, 1) }) : t('fly.shapeINone'),
  ].filter(Boolean).join(' · ');
}

/** A planet of another star: what is known of it, what it goes round, and with what. */
function openPlanetCard(sys, pl) {
  hideCard();
  pick({ kind: 'exo', sys, pl });
  $('card-title').textContent = planetName(sys, pl);
  const transit = pl.method === 'Transit';
  const timed = Number.isFinite(pl.tc) && pl.p > 0;
  $('card-note').textContent = t(!timed ? 'fly.exoNoteNoTime' : transit ? 'fly.exoNoteTransit' : 'fly.exoNoteConj', { host: hostName(sys), method: methodText(pl) });
  const rows = [];
  showRound({
    centre: {
      name: t('fly.centreHost', { host: hostName(sys) }), title: t('fly.centreGo'),
      words: pl.a ? orbitLine(pl.a, pl.p) : t('fly.exoNoOrbit'),
      go: () => { framePicked({ onCentre: true }); openSystemCard(sys, { keep: true }); },
    },
    also: { title: t('fly.alsoHost', { host: hostName(sys) }), items: exoItems(sys, pl) },
  });
  if (pl.r) rows.push([t('fly.cardRadius'), exoRadius(pl, true)]);
  if (pl.a) rows.push([t('exo.orbitH'), t('exo.orbitLong', { a: fmt(pl.a, 3) })]);
  if (pl.a) rows.push([t('fly.shapeH'), orbitWords(pl)]);
  if (pl.p) rows.push([t('exo.periodH'), t('exo.periodLong', { p: fmt(pl.p, pl.p < 10 ? 3 : 1) })]);
  if (timed) rows.push([t(transit ? 'fly.tcTransit' : 'fly.tcConj'), formatDay(new Date((pl.tc - 2440587.5) * 86400000), { year: true })]);
  if (pl.t) rows.push([t('exo.teqH'), t('fly.kelvin', { n: fmt(pl.t, 0) })]);
  const zone = zoneOf(habitableZone(sys.starR, sys.teff), pl.a);
  if (zone) rows.push([t('exo.hzH'), t({ hot: 'exo.hzIn', cold: 'exo.hzOut', in: 'fly.hzIn', opt: 'fly.hzOpt' }[zone])]);
  rows.push([t('exo.foundH'), t('exo.found', { method: methodText(pl), year: pl.year ?? '—' })]);
  $('card-rows').replaceChildren(...rows.map(([k, v]) => cardRow(k, v)), ...[companionsRow(sys)].filter(Boolean));
  $('card-frames').hidden = true;
  const ev = $('card-exo');
  ev.hidden = false;
  ev.href = systemUrl([sys.ra, sys.dec, sys.planets.length, sys.host], sys.host, getLanguage());
  card = { s: { key: `sys:${sys.host}`, sys, pl, index: sys.index } };
  showOrbitButton();
  $('card').hidden = false;
}

/* ---- what goes round what -------------------------------------------- */

/*
 * The body picked last, and what its card says it goes round, drawn in space
 * until the card is closed: a planet's orbit round the Sun, the Moon's round
 * the Earth, another star's planet's round its star, each with the body it
 * goes round ringed; and a star, whose turn round the Galaxy takes hundreds
 * of millions of years, its drift across the sky ten thousand years each way.
 * The lines are traced once for the pick and moved to the eye when it moves.
 */
let picked = null;
let pickedDrawnFor = null;
let pickedShown = false;
const PICK_INK = [1, 0.74, 0.3, 0.95];
const DRIFT_INK = [1, 0.66, 0.38, 0.8];

/**
 * Pick a body, or none: { kind: 'planet' | 'moon', index, key } |
 * { kind: 'exo', sys, pl } | { kind: 'star', index } | { kind: 'small', sb }
 * (an asteroid or comet from a mark) | { kind: 'dir', at, name } (a mark's
 * direction on the sky).
 */
function pick(next) {
  picked = next;
  pickedDrawnFor = null;
  wasPick = null;
  if (!next) return;
  if (next.kind === 'exo') {
    const o = systemNow(next.sys).find((x) => x.pl === next.pl);
    next.ends = o?.orbit ? ellipseEnds(o.orbit, next.sys.frame, next.sys.center, AU, ORBIT_STEPS * 2) : null;
    next.base = () => ORIGIN;
    next.centre = () => next.sys.center;
    next.point = () => inSystem?.now.find((x) => x.pl === next.pl)?.pos ?? null;
    next.ink = PICK_INK;
  } else if (next.kind === 'planet' || next.kind === 'moon') {
    next.traced = -1;
    next.ink = PICK_INK;
    const earth = named.find((x) => x.key === 'earth');
    next.base = next.kind === 'moon' ? () => posOf(earth.index) : () => ORIGIN;
    next.centre = next.base;
  } else if (next.kind === 'small') {
    next.ends = smallOrbitEnds(next.sb.k);
    next.ink = PICK_INK;
    next.base = () => ORIGIN;
    next.centre = () => ORIGIN;
    next.point = () => smallBodyAt(next.sb);
    next.name = next.sb.name;
  } else if (next.kind === 'dir') {
    next.ends = null;
    next.centre = null;
    next.point = () => next.at;
  } else if (next.kind === 'star') {
    next.ends = null;
    next.ink = DRIFT_INK;
    next.base = () => ORIGIN;
    next.centre = null;
    if (motion && next.index < motion.length / 2) {
      const p = posOf(next.index);
      const v = skyVelocity(p, motion[next.index * 2], motion[next.index * 2 + 1]);
      next.ends = Float64Array.from([...add(p, v, -DRIFT_YEARS), ...add(p, v, DRIFT_YEARS)]);
      next.mu = Math.hypot(motion[next.index * 2], motion[next.index * 2 + 1]) / 1000;
    }
  }
  if (next.ends) next.fromEye = new Float32Array(next.ends.length);
  wake();
}

/**
 * The ring on the body the picked one goes round (its name is on its own
 * label and in the card); the drift's two ends; and a ring and a name on the
 * picked thing itself where it has no label of its own: an asteroid from a
 * mark, a point at any distance, or the direction of a mark on a star.
 */
let pickedEls = null;
function pickedLabels() {
  if (pickedEls) return pickedEls;
  const box = $('pick-labels');
  const make = (cls) => {
    const el = document.createElement('span');
    el.className = cls;
    el.hidden = true;
    box.append(el);
    return el;
  };
  pickedEls = {
    centre: make('fly-centre'), from: make('fly-mark fly-mark--drift'), to: make('fly-mark fly-mark--drift'),
    point: make('fly-centre fly-centre--point'), name: make('fly-mark fly-mark--picked'),
    gc: make('fly-centre'), gcName: make('fly-mark fly-mark--picked'),
  };
  return pickedEls;
}

/**
 * The picked thing's orbit as segment ends from its base, or null: a planet's
 * and the Moon's are taken from the orbits traced for the moment shown, and
 * again whenever those are traced again.
 */
function pickedEnds(p) {
  if (p && (p.kind === 'planet' || p.kind === 'moon')) {
    tracePaths();
    if (p.traced !== pathsTraced) {
      p.ends = segmentEnds([solarPaths[p.kind === 'moon' ? 'moon' : p.key]]);
      p.fromEye = new Float32Array(p.ends.length);
      p.traced = pathsTraced;
      if (p === picked) pickedDrawnFor = null;
    }
  }
  return p?.ends ?? null;
}

function drawPicked() {
  const p = picked;
  const els = pickedLabels();
  pickedEnds(p);
  if (wasPick?.ends) {
    const base = wasPick.base();
    const next = sameView(wasDrawnFor, ...base);
    if (next) {
      wasDrawnFor = next;
      space.setLiveLines(fromEye(wasPick.ends, base, wasPick.fromEye), WAS_INK, 'was');
      wasShown = true;
    }
  } else if (wasShown) {
    space.setLiveLines(null, null, 'was');
    wasShown = false;
    wasDrawnFor = null;
  }
  // The Galactic Centre, once the camera has turned to it from a star's card.
  const gc = facingCentre ? screenOf(galacticAhead(), basis(), proj) : null;
  setHidden(els.gc, !gc);
  setHidden(els.gcName, !gc);
  if (gc) {
    setPlace(els.gc, gc);
    setText(els.gcName, t('fly.galMark'));
    setPlace(els.gcName, gc, 22);
  }
  if (p?.ends) {
    const base = p.base();
    const next = sameView(pickedDrawnFor, ...base);
    if (next) {
      pickedDrawnFor = next;
      space.setLiveLines(fromEye(p.ends, base, p.fromEye), p.ink, 'picked');
      pickedShown = true;
    }
  } else {
    if (pickedShown) {
      space.setLiveLines(null, null, 'picked');
      pickedShown = false;
    }
    pickedDrawnFor = null;
  }
  const b = basis();
  const centre = p?.centre && p.ends ? screenOf(p.centre(), b, proj) : null;
  setHidden(els.centre, !centre);
  if (centre) setPlace(els.centre, centre);
  const point = p?.point ? p.point() : null;
  const here = point ? screenOf(point, b, proj) : null;
  setHidden(els.point, !here);
  if (here) setPlace(els.point, here);
  // A planet of another star is named by its system's labels; the rest here.
  const nameIt = Boolean(here && p.kind !== 'exo' && p.name);
  setHidden(els.name, !nameIt);
  if (nameIt) {
    setText(els.name, p.name);
    setPlace(els.name, here, 20);
  }
  const ends = p?.kind === 'star' && p.ends ? [[els.from, -DRIFT_YEARS, 0], [els.to, DRIFT_YEARS, 3]] : [[els.from], [els.to]];
  for (const [el, years, o] of ends) {
    const at = years ? screenOf([p.ends[o], p.ends[o + 1], p.ends[o + 2]], b, proj) : null;
    setHidden(el, !at);
    if (!at) continue;
    setText(el, t('fly.driftEnd', { y: `${years < 0 ? '−' : '+'}${fmt(Math.abs(years), 0)}` }));
    setPlace(el, at);
  }
}

/* ---- a mark from the sky ------------------------------------------------- */

/*
 * "Show in space" on a mark opens the flight beside the Earth, facing the
 * mark. An asteroid or comet whose orbit JPL gave the mark's card comes with
 * that orbit: drawn round the Sun, the body ringed and named where the same
 * elements put it at the moment shown, and the camera flies out to where its
 * orbit is seen whole. Anything else is a direction: the camera backs away
 * from the Earth still facing it, and the direction is ringed.
 */

/** JPL's ecliptic axes (J2000) to the flight's ICRS axes, AU to parsecs, into `out`. */
function eclipticPc({ x, y, z }, out = [0, 0, 0]) {
  out[0] = x * AU_PC;
  out[1] = (y * Math.cos(ECL) - z * Math.sin(ECL)) * AU_PC;
  out[2] = (y * Math.sin(ECL) + z * Math.cos(ECL)) * AU_PC;
  return out;
}

/** A small body's orbit as segment ends, parsecs from the Sun: traced once, from its elements. */
function smallOrbitEnds(k) {
  const pts = orbitPath(k, 360).map((q) => eclipticPc(q));
  return segmentEnds([[...pts, pts[0]]]);
}

/**
 * Where a small body is at the moment shown, parsecs: worked out again only
 * when the clock has moved a second or more, into the array kept for it.
 */
function smallBodyAt(sb) {
  const ms = simMs();
  if (sb.pos && Math.abs(ms - sb.atMs) < 1000) return sb.pos;
  const q = positionAt(sb.k, ms / 86400000 + 2440587.5);
  sb.atMs = ms;
  sb.pos = q ? eclipticPc(q, sb.pos ?? [0, 0, 0]) : null;
  return sb.pos;
}

/**
 * To a small body: out to where its whole orbit and the Sun are in view,
 * from above the orbit's plane (framePicked). Its size is not drawn: from
 * anywhere it is a point, ringed.
 */
function flyToSmallBody(sb) {
  setTrip(null);
  if (picked?.sb !== sb) pick({ kind: 'small', sb });
  hideCard();
  carried = null;
  framePicked();
  const wait = () => (autopilot ? requestAnimationFrame(wait) : openSmallCard(sb));
  requestAnimationFrame(wait);
}

/**
 * A small body's card: what JPL's elements say, and that its size is not
 * drawn. An orbit-neighbour from the field's card has elements but no
 * moment they hold for: its orbit is drawn, its place is not.
 */
function openSmallCard(sb) {
  hideCard();
  if (picked?.sb !== sb) pick({ kind: 'small', sb });
  const { k } = sb;
  const placed = Boolean(smallBodyAt(sb));
  $('card-title').textContent = sb.name;
  $('card-note').textContent = sb.of
    ? t('fly.nearNote', { name: sb.of.name, d: fmt(sb.d, 3) })
    : t('fly.smallNote');
  const main = sb.of ?? sb;
  const group = [main, ...main.near];
  showRound({
    centre: {
      name: t('fly.centreSun'), title: t('fly.centreGo'), words: orbitLine(k.a, k.years * 365.25),
      go: () => { framePicked({ onCentre: true }); openSolarCard({ keep: true }); },
    },
    also: {
      title: t('fly.alsoNear'),
      items: group.map((x) => ({
        name: x.name,
        nums: x.of
          ? t('fly.nearNums', { a: fmt(x.k.a, 2), e: fmt(x.k.e, 2), d: fmt(x.d, 3) })
          : t('fly.smallNums', { a: fmt(x.k.a, 2), e: fmt(x.k.e, 2) }),
        current: x === sb,
        go: () => selectAnd(() => openSmallCard(x)),
      })),
      more: group.length > 1 ? '' : t('fly.nearNoneSent'),
    },
  });
  const earth = named.find((x) => x.key === 'earth');
  const where = () => smallBodyAt(sb) ?? ORIGIN;
  const live = [];
  const rows = [
    ...(placed ? [
      [t('fly.cardSun'), () => t('fly.au', { n: num(len(where()) / AU_PC, 2) })],
      [t('fly.cardFromEarth'), () => t('fly.au', { n: num(len(sub(where(), posOf(earth.index))) / AU_PC, 2) })],
      [t('fly.cardHere'), () => distanceText(len(sub(where(), cam.eye)))],
    ] : []),
    [t('exo.orbitH'), () => t('fly.smallOrbit', { a: fmt(k.a, 2), e: fmt(k.e, 3), i: fmt(k.i, 1) })],
    [t('exo.periodH'), () => t('fly.smallYear', { y: fmt(k.years, k.years < 10 ? 2 : 1) })],
  ];
  $('card-rows').replaceChildren(...rows.map(([key, again]) => {
    const row = cardRow(key, again());
    live.push({ dd: row.querySelector('dd'), again });
    return row;
  }));
  // A neighbour has no place to fly to: its whole orbit is what can be shown.
  $('card-fly').hidden = !placed;
  $('card-frames').hidden = true;
  $('card-exo').hidden = true;
  card = { s: { key: 'small', sb }, live };
  showOrbitButton();
  $('card').hidden = false;
}

/** A mark that is not a small body: its direction, ringed, and what is known of where it is. */
function openDirectionCard(mark) {
  hideCard();
  $('card-title').textContent = mark.name || t('fly.markTitle');
  $('card-note').textContent = t('fly.markNote');
  $('card-rows').replaceChildren(cardRow(t('fly.markSky'), t('fly.markRaDec', { ra: fmt(mark.ra, 4), dec: fmt(mark.dec, 4) })));
  $('card-fly').hidden = true;
  $('card-frames').hidden = true;
  $('card-exo').hidden = true;
  card = { s: { key: 'dir', mark } };
  $('card').hidden = false;
}

/** The flight from a mark: beside the Earth, facing it; to its orbit, if it is a small body with one. */
function showMark(ra, dec, mark) {
  const k = mark.body;
  if (k && drawable(k) && positionAt(k, JD())) {
    lookFromEarth(ra, dec, { pullOut: false });
    const sb = { k, name: mark.name || k.name, atMs: 0, pos: null, near: [] };
    sb.near = neighboursOf(mark.near, sb);
    flyToSmallBody(sb);
    return;
  }
  lookFromEarth(ra, dec, { turn: false });
  const name = mark.name || t('fly.markTitle');
  pick({ kind: 'dir', at: direction(ra, dec).map((c) => c * 1e9), name });
  openDirectionCard({ ...mark, ra, dec, name });
}

/* ---- what it goes round, in the card --------------------------------- */

/*
 * At the top of every card: what the body goes round, as a button, and what
 * else goes round the same centre, as a list. The centre's button takes the
 * camera out to where the body's whole orbit and the centre are seen, the
 * orbit still drawn, and opens the centre's card; each name in the list
 * picks that body, draws its orbit (the one picked before stays, faint) and
 * frames it the same way. ← and → step through the list; Esc puts the card
 * and the pick away.
 */

/** The list in the card that ← and → step through: [{ go, current }]. */
let roundList = [];

function clearRound() {
  roundList = [];
  const box = $('card-round');
  box.hidden = true;
  if (box.childElementCount) box.replaceChildren();
}

function roundPara(className, text) {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

/**
 * Fill the card's "goes round" section. `centre`: { name, words, title, go };
 * `note`: how its words were come by; `beside`: a row under the centre (a
 * star's companions); `also`: { title, items: [{ name, nums, current, under,
 * go }], more }.
 */
function showRound({ centre, note = '', beside = null, also = null }) {
  const nodes = [roundPara('fly-round__h', t('fly.roundH'))];
  const row = document.createElement('div');
  row.className = 'fly-round__centre';
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'fly-round__go';
  go.textContent = centre.name;
  if (centre.title) go.title = centre.title;
  go.addEventListener('click', centre.go);
  row.append(go);
  if (centre.words) {
    const words = document.createElement('span');
    words.className = 'fly-round__words';
    words.textContent = centre.words;
    row.append(words);
  }
  nodes.push(row);
  if (note) nodes.push(roundPara('fly-round__note', note));
  if (beside) {
    const rows = document.createElement('dl');
    rows.className = 'fly-card__rows';
    rows.append(beside);
    nodes.push(rows);
  }
  roundList = [];
  if (also) {
    nodes.push(roundPara('fly-round__h', also.title));
    if (also.items.length) {
      const list = document.createElement('ol');
      list.className = 'fly-round__list';
      for (const item of also.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `fly-round__item${item.under ? ' fly-round__item--under' : ''}`;
        if (item.current) b.setAttribute('aria-current', 'true');
        const name = document.createElement('span');
        name.textContent = item.name;
        const nums = document.createElement('span');
        nums.className = 'fly-round__nums';
        nums.textContent = item.nums;
        b.append(name, nums);
        b.addEventListener('click', item.go);
        const li = document.createElement('li');
        li.append(b);
        list.append(li);
        roundList.push(item);
      }
      nodes.push(list);
    }
    if (also.more) nodes.push(roundPara('fly-round__more', also.more));
    if (roundList.length > 1 && !coarsePointer.matches) nodes.push(roundPara('fly-round__keys', t('fly.roundKeys')));
  }
  const box = $('card-round');
  box.replaceChildren(...nodes);
  box.hidden = false;
}

/** The next or the one before in the card's list, round from the end to the start. */
function stepRound(dir) {
  const n = roundList.length;
  const at = roundList.findIndex((x) => x.current);
  const next = at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n;
  roundList[next].go();
}

/** A period in the unit it reads best in: days up to a thousand, years past that. */
function periodText(days) {
  if (!(days > 0)) return '—';
  if (days < 1000) return t('fly.days', { n: fmt(days, days < 10 ? 2 : days < 100 ? 1 : 0) });
  const years = days / 365.25;
  return t('fly.years', { n: fmt(years, years < 10 ? 2 : years < 100 ? 1 : 0) });
}

/** How far out an orbit is and how long a turn of it takes. */
const orbitLine = (a, days) => t('fly.roundOrbit', { a: fmt(a, a < 1 ? 3 : 2), p: periodText(days) });

/** The small bodies counted round the Sun, in words; empty until family.json has come. */
const smallCount = () => (family
  ? t('fly.smallMore', { ast: fmt(family.counts.asteroids, 0), comet: fmt(family.counts.comet, 0), date: familyDate() })
  : '');

const PLANET_KEYS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

/** The Sun's planets as a list, the Moon under the Earth, `current` (a key) marked. */
function planetItems(current) {
  const items = [];
  for (const key of PLANET_KEYS) {
    const s = named.find((x) => x.key === key);
    const f = FACTS[key];
    if (!s || !f) continue;
    items.push({
      name: nameOf(s), nums: `${t('fly.au', { n: fmt(f.a, f.a < 1 ? 3 : 2) })} · ${periodText(f.year)}`,
      current: key === current, go: () => selectAnd(() => openCard(s)),
    });
    const moon = key === 'earth' ? named.find((x) => x.key === 'moon') : null;
    if (moon) {
      items.push({
        name: nameOf(moon), nums: t('fly.underEarth', { p: periodText(FACTS.moon.year) }), under: true,
        current: current === 'moon', go: () => selectAnd(() => openCard(moon)),
      });
    }
  }
  return items;
}

/**
 * The body a card is about, picked if it is not: a card opened for a centre
 * keeps the body picked before, and its own centre's button is about itself.
 */
function pickBody(s) {
  if (picked?.key !== s.key) pick({ kind: s.key === 'moon' ? 'moon' : 'planet', key: s.key, index: s.index });
}

/** A planet's section: the Sun, and the other planets. */
function planetRound(s) {
  const f = FACTS[s.key];
  return {
    centre: {
      name: t('fly.centreSun'), title: t('fly.centreGo'), words: f ? orbitLine(f.a, f.year) : '',
      go: () => { pickBody(s); framePicked({ onCentre: true }); openSolarCard({ keep: true }); },
    },
    also: { title: t('fly.alsoSun'), items: planetItems(s.key), more: smallCount() },
  };
}

/** The Moon's section: the Earth, and nothing else natural round it. */
function moonRound(s) {
  const earth = named.find((x) => x.key === 'earth');
  return {
    centre: {
      name: t('fly.centreEarth'), title: t('fly.centreGo'),
      words: t('fly.roundMoonOrbit', { km: fmt(384400, 0), p: periodText(FACTS.moon.year) }),
      go: () => { pickBody(s); framePicked({ onCentre: true }); openCard(earth, { keep: true }); },
    },
    also: { title: t('fly.alsoEarth'), items: [], more: t('fly.moonOnly') },
  };
}

/** A system's planets as a list: radius, orbit and year where the Archive has them; `current` marked. */
function exoItems(sys, current) {
  return sys.planets.map((pl) => ({
    name: planetName(sys, pl),
    nums: [
      pl.r ? exoRadius(pl, false) : '',
      pl.a ? t('exo.orbit', { a: fmt(pl.a, pl.a < 1 ? 3 : 2) }) : t('fly.exoNoOrbit'),
      pl.p ? periodText(pl.p) : '',
    ].filter(Boolean).join(' · '),
    current: pl === current,
    go: () => selectAnd(() => openPlanetCard(sys, pl)),
  }));
}

/**
 * An orbit-neighbour sent with a mark from the field's card (bodycard.js:
 * JPL's closest orbits by D_SH), as a small body of its own. Its elements
 * have no moment they hold for, so it has an orbit and no place.
 */
function neighboursOf(list, of) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 5).map((r) => {
    const k = {
      des: String(r?.des ?? ''), a: Number(r?.a), e: Number(r?.e), q: Number(r?.q),
      i: Number(r?.i), om: Number(r?.om), w: Number(r?.w),
    };
    k.years = k.a ** 1.5;
    const name = String(r?.name ?? '').trim().replace(/^\((.+)\)$/, '$1') || k.des;
    return { k, name, d: Number(r?.d), of, atMs: 0, pos: null, near: [] };
  }).filter((x) => x.name && drawable(x.k));
}

/* The Milky Way's centre: Sgr A*, and the Galaxy's north pole (IAU 1958). */
const GC_DIR = direction(266.405, -28.936);
const GAL_POLE = direction(192.8595, 27.1283);
/** The Sun's distance from the centre, pc, and a flat rotation curve's speed, km/s. */
const R0_PC = 8200;
const V_CIRC = 230;
const S_PER_MYR = 3.15576e13;

/**
 * How far from the Milky Way's centre a place is, across the Galaxy's plane,
 * and how long one turn would take on a circular orbit at that distance on a
 * flat rotation curve: a statement about where it is, not a measured orbit.
 */
function galacticTurn(p) {
  const g = sub(GC_DIR.map((c) => c * R0_PC), p);
  const R = len(sub(g, GAL_POLE.map((c) => c * dot(g, GAL_POLE))));
  return { kpc: R / 1000, myr: (2 * Math.PI * R * KM_PER_PC) / V_CIRC / S_PER_MYR };
}

/** A star's centre: the Milky Way's, which the camera turns to face. */
function galCentre(p) {
  const { kpc, myr } = galacticTurn(p);
  return {
    name: t('fly.centreGal'), title: t('fly.centreGalGo'),
    words: t('fly.galWords', { kpc: fmt(kpc, 2), myr: fmt(Math.round(myr), 0) }),
    go: faceGalacticCentre,
  };
}

/** Whether the camera was turned to the Galactic Centre from the card shown: it is ringed and named. */
let facingCentre = false;
const gcAhead = [0, 0, 0];
/** A point far off towards the Galactic Centre from the eye, written into one array. */
function galacticAhead() {
  for (let j = 0; j < 3; j++) gcAhead[j] = cam.eye[j] + GC_DIR[j] * 1e6;
  return gcAhead;
}

/** Turn where the camera stands to face the Milky Way's centre, eight kiloparsecs off: too far to fly to. */
function faceGalacticCentre() {
  carried = null;
  autopilot = {
    from: cam.eye, to: cam.eye, look: add(cam.eye, GC_DIR, 1e6), stop: 1, t0: performance.now(), body: -1,
    ms: reduceMotion ? 1 : 1400,
  };
  facingCentre = true;
  wake();
}

/* The orbit picked before the one picked from a list, drawn faint until the next pick. */
let wasPick = null;
let wasDrawnFor = null;
let wasShown = false;
const WAS_INK = [1, 0.74, 0.3, 0.45];

const samePick = (a, b) => Boolean(a && b) && a.kind === b.kind && a.key === b.key && a.pl === b.pl && a.sb === b.sb;

/** Open a body's card from a list, which picks it; keep the orbit picked before, faint; and frame the new one. */
function selectAnd(open) {
  const before = picked?.ends && picked.kind !== 'star' && picked.kind !== 'dir' ? picked : null;
  open();
  if (before && !samePick(before, picked)) {
    wasPick = before;
    wasDrawnFor = null;
  }
  framePicked();
}

/** Whether the picked thing has an orbit to frame: the card's "whole orbit" is shown for it. */
function showOrbitButton() {
  $('card-orbit').hidden = !(picked && picked.kind !== 'star' && picked.kind !== 'dir' && pickedEnds(picked));
}

/** How far above an orbit's plane, seen from its middle, the camera comes to see it whole. */
const ORBIT_VIEW_TILT = 32 * Math.PI / 180;

/**
 * The part of the canvas the card and the dock leave free, px from the
 * canvas's middle: { cx, cy } its middle, { hw, hh } its half-size. On a wide
 * screen the card stands at the right; on a phone it is over the dock.
 */
function freeView() {
  const c = canvas.getBoundingClientRect();
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const wide = c.width > 640;
  const right = wide ? c.width - Math.min(22 * rem, c.width) - 2 * rem : c.width;
  const dockTop = $('dock').getBoundingClientRect().top - c.top;
  const bottom = Math.max(c.height * 0.3, Math.min(dockTop, wide ? c.height : c.height * 0.45));
  return { cx: right / 2 - c.width / 2, cy: bottom / 2 - c.height / 2, hw: right / 2, hh: bottom / 2 };
}

/**
 * Frame the picked thing's orbit: out to where all of it, and what it goes
 * round, fit the part of the view the card leaves free with a margin, 32°
 * above its plane on the side the camera is (from beside the body, its orbit
 * is a line through it), with the orbit's pole up the screen. The body is
 * seen at the side of the ellipse away from the card, not at its near edge
 * against the dock; with `onCentre` the view is centred on what it goes
 * round, otherwise on the orbit's middle.
 */
function framePicked({ onCentre = false } = {}) {
  const p = picked;
  const ends = pickedEnds(p);
  if (!ends || !p.centre) return;
  const body = p.kind === 'exo' ? exoPlace(p.sys, p.pl)
    : p.kind === 'small' ? smallBodyAt(p.sb)
      : p.index >= 0 ? posOf(p.index) : null;
  const base = p.base();
  const centre = p.centre();
  const n = ends.length / 3;
  const mid = [0, 0, 0];
  for (let o = 0; o < ends.length; o += 3) for (let j = 0; j < 3; j++) mid[j] += ends[o + j];
  for (let j = 0; j < 3; j++) mid[j] = mid[j] / n + base[j];
  const target = onCentre ? [...centre] : mid;
  let reach = len(sub(centre, target));
  let pole = [0, 0, 0];
  for (let o = 0; o + 5 < ends.length; o += 6) {
    const a = [ends[o] + base[0] - mid[0], ends[o + 1] + base[1] - mid[1], ends[o + 2] + base[2] - mid[2]];
    const b = [ends[o + 3] + base[0] - mid[0], ends[o + 4] + base[1] - mid[1], ends[o + 5] + base[2] - mid[2]];
    pole = add(pole, cross(a, b));
    reach = Math.max(reach, len(sub(add(mid, a), target)));
  }
  pole = norm(pole);
  if (dot(pole, sub(cam.eye, target)) < 0) pole = pole.map((c) => -c);
  // The side seen from: a quarter turn round the pole from the body, so it
  // stands at the ellipse's left or right; with no body, the camera's side.
  const toward = sub(body ?? cam.eye, mid);
  let across = sub(toward, pole.map((c) => c * dot(toward, pole)));
  if (len(across) < 1e-9 * reach) across = cross(pole, Math.abs(pole[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  across = norm(across);
  if (body) across = norm(cross(pole, across));
  const view = (side) => {
    const back = add(side.map((c) => c * Math.cos(ORBIT_VIEW_TILT)), pole, Math.sin(ORBIT_VIEW_TILT));
    const F = back.map((c) => -c);
    const up = norm(sub(pole, F.map((c) => c * dot(pole, F))));
    return { back, F, up, right: cross(F, up) };
  };
  let { back, F, up, right } = view(across);
  if (body && dot(sub(body, target), right) > 0) ({ back, F, up, right } = view(across.map((c) => -c)));
  // Near enough that the orbit and its centre just fit the free part, with a
  // tenth to spare: each point seen from `dist` back along F stands x / (dist + z)
  // across the view, which may not pass the free part's edge.
  const free = freeView();
  const focalPx = (canvas.clientHeight / 2) / Math.tan((FOV * Math.PI) / 360);
  const tanX = free.hw / focalPx;
  // A little short of the dock: the body's ring and name stand below it.
  const tanY = Math.max(free.hh - 18, free.hh * 0.7) / focalPx;
  let dist = 0;
  const fit = (x, y, z) => {
    const v = [x - target[0], y - target[1], z - target[2]];
    const along = dot(v, F);
    dist = Math.max(dist, Math.abs(dot(v, right)) / tanX - along, Math.abs(dot(v, up)) / tanY - along);
  };
  fit(...centre);
  for (let o = 0; o < ends.length; o += 3) fit(ends[o] + base[0], ends[o + 1] + base[1], ends[o + 2] + base[2]);
  dist = Math.max(dist * 1.12, reach);
  const eye = add(target, back, dist);
  // Looking a little to the side of the target, so it stands in the middle of the free part.
  const look = add(add(target, right, (-free.cx / focalPx) * dist), up, (free.cy / focalPx) * dist);
  // The Moon's orbit goes with the Earth: the camera follows it; the rest stand still.
  const follow = p.kind === 'moon' ? p.centre : () => target;
  const anchor = follow();
  const lookOff = sub(look, anchor);
  carried = null;
  autopilot = {
    from: cam.eye, to: eye, look, stop: len(sub(eye, anchor)), anchor: [...anchor], up, t0: performance.now(), body: -1,
    ms: reduceMotion ? 1 : 2600 + 400 * Math.log10(1 + len(sub(eye, cam.eye)) / dist),
    follow,
    aim: (q) => add(q, lookOff),
  };
  $('hint').dataset.gone = 'true';
  wake();
}

/*
 * While an orbit is picked, the names of what has nothing to do with it are
 * quieter: the picked body's and its centre's stay as they are, and are
 * placed first.
 */
let labelsQuiet = false;
let kinBody = -2;
let kinCentre = -2;
let earthIndex = -2;
function quietLabels() {
  const p = picked;
  const quiet = Boolean(p?.ends) && p.kind !== 'star' && p.kind !== 'dir';
  if (earthIndex === -2) earthIndex = named.find((x) => x.key === 'earth')?.index ?? -3;
  kinBody = quiet && (p.kind === 'planet' || p.kind === 'moon') ? p.index : -2;
  kinCentre = !quiet ? -2
    : p.kind === 'moon' ? earthIndex
      : p.kind === 'exo' ? (p.sys.index >= 0 ? p.sys.index : -2)
        : sunIndex;
  if (quiet !== labelsQuiet) {
    labelsQuiet = quiet;
    $('labels').toggleAttribute('data-quiet', quiet);
  }
  return quiet;
}

/* ---- language and start ----------------------------------------------- */

function applyLanguage() {
  applyTranslations();
  document.title = t('fly.doc');
  $('lang').textContent = getLanguage() === 'ru' ? 'EN' : 'RU';
  $('hint').textContent = t(matchMedia('(pointer: coarse)').matches ? 'fly.hintHold' : 'fly.hint');
  if (named.length) nameLabels();
  if (starCount) $('source').textContent = t('fly.source', { n: fmt(starCount, 0) }) + (survey ? ` · ${t('sky.fills', { n: CORE_STAR_COUNT })}` : '');
  nameGapLabels();
  showClock();
  closePops();
  if (view.ir) setText($('read-note'), t('fly.irNote'));
  if (card) {
    const { s } = card;
    if (s.sb) openSmallCard(s.sb);
    else if (s.mark) openDirectionCard(s.mark);
    else if (s.pl) openPlanetCard(s.sys, s.pl);
    else if (s.sys) openSystemCard(s.sys, { keep: card.keep });
    else openCard(s, { keep: card.keep });
  }
  wake();
}
$('lang').addEventListener('click', () => {
  setLanguage(getLanguage() === 'en' ? 'ru' : 'en');
  try { localStorage.setItem('muninn.lang', getLanguage()); } catch { /* private window */ }
  applyLanguage();
});

applyLanguage();
readHash();
const [data, skyImage] = await Promise.all([loadStars(), loadSky()]);
makeSurvey();
// The catalogue's stars come first; the Sun, WISE 0855 and the planets after.
space = createSpace(canvas, { stars: data.stars, sky: skyImage, stored: data.sun });
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
  if (pendingLook?.mark) showMark(pendingLook.ra, pendingLook.dec, pendingLook.mark);
  else if (pendingLook) lookFromEarth(pendingLook.ra, pendingLook.dec);
  loadSystems();
  loadFamily();
  loadMotion();
  applyLanguage();
  setTimeout(() => { $('hint').dataset.gone = 'true'; }, 9000);
  moveBodies();
  scanBodies();
  // Whatever changes the canvas's size changes what is drawn on it.
  new ResizeObserver(wake).observe(canvas);
  wake();
}


// Inside the front page: the way back to its sky, facing where this faces.
if (embedded) {
  $('back-sky').hidden = false;
  $('back-sky').addEventListener('click', () => { pullOut = null; landOnEarth(); });
}

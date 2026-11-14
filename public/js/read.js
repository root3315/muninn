/**
 * read.js — "How to read this": opening it, the small things each card's
 * picture does when pressed or dragged, and the cue on the opening sky's
 * button until the sheet has been opened in this page load.
 *
 * A picture plays once, the first time its card is shown in an opening:
 * an IntersectionObserver sets `.is-seen`, and the CSS transitions out of
 * the card's unseen state. Only the blink loops, and only while its card is
 * on screen (`.is-on`). Nothing here runs a frame loop: a press changes an
 * attribute or a custom property and the compositor does the rest.
 */

import { t, fmt, getLanguage, applyTranslations } from './i18n.js';

/** The cue is only for the opening sky: in a field the tour does that job. */
const CUED = ['gate-about'];

const $ = (id) => document.getElementById(id);
const STILL = window.matchMedia('(prefers-reduced-motion: reduce)');

let watcher = null;
let hooks = { onTour() {}, onOpen() {}, onClose() {} };
// Lit on every page load until the sheet is opened in that load: a reload,
// Ctrl+Shift+R included, lights it again.
let sessionSeen = false;
/** Each card's behaviour, by the id of its step: { seen?, relabel? }. */
const cards = new Map();

/** Put the cue on the buttons, or take it off, in the current language. */
export function relabelCue() {
  const on = !sessionSeen;
  for (const id of CUED) {
    const button = $(id);
    if (!button) continue;
    if (on) button.dataset.cue = t('about.start');
    else delete button.dataset.cue;
  }
  for (const card of cards.values()) card.relabel?.();
}

function markSeen() {
  sessionSeen = true;
  relabelCue();
}

/** Run `fn` after `ms` unless the card has been touched by then. */
function later(fig, ms, fn) {
  setTimeout(() => { if (!fig.classList.contains('is-touched')) fn(); }, STILL.matches ? 0 : ms);
}

const touched = (fig) => fig.classList.add('is-touched');

/** A press on any of `buttons` sets aria-pressed on that one only. */
function pressOne(buttons, chosen) {
  for (const b of buttons) b.setAttribute('aria-pressed', String(b === chosen));
}

/* ------------------------------------------------------------ the wipe */

/**
 * A divider dragged across a plate: the plate's --x, as a percentage.
 * @param {HTMLElement} plate
 * @param {() => boolean} [active] whether the wipe is the picture shown now
 */
function wipe(plate, active = () => true) {
  const divider = plate.querySelector('.art-wipe__divider');
  const set = (pct) => {
    const x = Math.max(0, Math.min(100, pct));
    plate.style.setProperty('--x', `${x}%`);
    divider.setAttribute('aria-valuenow', String(Math.round(x)));
  };
  const at = (e) => {
    const r = plate.getBoundingClientRect();
    set(((e.clientX - r.left) / r.width) * 100);
  };
  plate.addEventListener('pointerdown', (e) => {
    if (!active()) return;
    e.preventDefault();
    plate.setPointerCapture(e.pointerId);
    plate.classList.add('is-dragging');
    at(e);
  });
  plate.addEventListener('pointermove', (e) => { if (plate.classList.contains('is-dragging')) at(e); });
  const end = () => plate.classList.remove('is-dragging');
  plate.addEventListener('pointerup', end);
  plate.addEventListener('pointercancel', end);
  divider.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, Home: -100, End: 100 }[e.key];
    if (step == null) return;
    e.preventDefault();
    set(Number(divider.getAttribute('aria-valuenow')) + step);
  });
}

/* ------------------------------------------------------- 01 · the sky */

/** The six detectors' ranges, µm: 17 channels each, 102 in all. */
const BANDS = [[0.75, 1.09], [1.10, 1.62], [1.63, 2.41], [2.42, 3.82], [3.82, 4.42], [4.42, 5.00]];
const PER = 17;
const RULER = { x0: 14, x1: 226, lo: 0.75, hi: 5.0 };
const rulerX = (l) => RULER.x0 + ((l - RULER.lo) / (RULER.hi - RULER.lo)) * (RULER.x1 - RULER.x0);

/** The wavelength at the centre of channel n (1–102): it climbs geometrically across a detector. */
function channel(n) {
  const d = Math.ceil(n / PER);
  const k = (n - 1) % PER;
  const [lo, hi] = BANDS[d - 1];
  return { d, k, lambda: lo * (hi / lo) ** ((k + 0.5) / PER) };
}

/** The channel a wavelength falls in. */
function channelAt(lambda) {
  const l = Math.max(RULER.lo, Math.min(RULER.hi - 1e-6, lambda));
  let d = BANDS.findIndex(([, hi]) => l < hi);
  if (d < 0) d = BANDS.length - 1;
  const [lo, hi] = BANDS[d];
  const k = Math.max(0, Math.min(PER - 1, Math.floor((Math.log(Math.max(l, lo) / lo) / Math.log(hi / lo)) * PER)));
  return d * PER + k + 1;
}

function initSky(fig) {
  const ruler = fig.querySelector('.art-sky__ruler');
  const svg = ruler.querySelector('svg');
  const cursor = svg.querySelector('.art-sky__cursor');
  const chan = svg.querySelector('.art-sky__chan');
  const read = fig.querySelector('.art-sky__read');
  const brackets = svg.querySelector('.art-sky__brackets');
  brackets.innerHTML = BANDS.map(([lo, hi], i) => {
    const a = rulerX(lo) + 0.4;
    const b = rulerX(hi) - 0.4;
    return `<g data-d="${i + 1}"><path d="M${a.toFixed(1)} 112v-4h${(b - a).toFixed(1)}v4"/>`
      + `<text x="${((a + b) / 2).toFixed(1)}" y="104" text-anchor="middle">D${i + 1}</text></g>`;
  }).join('');
  let ticks = '';
  for (let n = 1; n <= BANDS.length * PER; n++) ticks += `M${rulerX(channel(n).lambda).toFixed(2)} 116v8`;
  svg.querySelector('.art-sky__ticks').setAttribute('d', ticks);

  let now = 1;
  const relabel = () => {
    const { d, lambda } = channel(now);
    const text = t('about.skyRead', { l: fmt(lambda, 2), d: `D${d}`, n: now });
    read.textContent = text;
    ruler.setAttribute('aria-valuetext', text);
  };
  const set = (n) => {
    now = Math.max(1, Math.min(BANDS.length * PER, n));
    const { d, k, lambda } = channel(now);
    fig.dataset.d = String(d);
    cursor.style.setProperty('--cx', `${rulerX(lambda).toFixed(2)}px`);
    const x = [14, 50, 86][(d - 1) % 3] + ((k + 0.5) / PER) * 32;
    chan.style.transform = `translate(${x.toFixed(2)}px, ${d <= 3 ? 8 : 44}px)`;
    for (const g of brackets.children) g.classList.toggle('is-on', g.dataset.d === String(d));
    ruler.setAttribute('aria-valuenow', String(now));
    relabel();
  };
  const fromPointer = (e) => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 240;
    set(channelAt(RULER.lo + ((x - RULER.x0) / (RULER.x1 - RULER.x0)) * (RULER.hi - RULER.lo)));
  };
  ruler.addEventListener('pointerdown', (e) => {
    touched(fig);
    // A drag along the ruler must not select the text around the sheet.
    e.preventDefault();
    const det = e.target.closest?.('.art-sky__det');
    if (det) { set((Number(det.dataset.d) - 1) * PER + 9); return; }
    const r = svg.getBoundingClientRect();
    if ((e.clientY - r.top) / r.height * 150 < 90) return;
    ruler.setPointerCapture(e.pointerId);
    fig.classList.add('is-dragging');
    fromPointer(e);
  });
  ruler.addEventListener('pointermove', (e) => { if (fig.classList.contains('is-dragging')) fromPointer(e); });
  const end = () => fig.classList.remove('is-dragging');
  ruler.addEventListener('pointerup', end);
  ruler.addEventListener('pointercancel', end);
  ruler.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -PER, PageUp: PER, Home: -999, End: 999 }[e.key];
    if (step == null) return;
    e.preventDefault();
    touched(fig);
    set(now + step);
  });
  set(1);
  return { relabel, seen: () => later(fig, 350, () => set(41)) };
}

/* ------------------------------------------------------ 02 · the blink */

function initBlink(fig) {
  const plate = fig.querySelector('.art-blink__plate');
  const hold = (on) => {
    fig.classList.toggle('is-held', on);
    plate.setAttribute('aria-pressed', String(on));
  };
  plate.addEventListener('pointerdown', (e) => { touched(fig); plate.setPointerCapture(e.pointerId); hold(true); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) plate.addEventListener(type, () => hold(false));
  plate.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); touched(fig); hold(true); }
  });
  plate.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') hold(false); });
  plate.addEventListener('contextmenu', (e) => e.preventDefault());
  return {};
}

/* ------------------------------------------------------ 03 · north up */

function initNorth(fig) {
  const chips = fig.querySelectorAll('.art__chip');
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      pressOne(chips, chip);
      fig.toggleAttribute('data-raw', chip.classList.contains('art-north__raw'));
    });
  }
  return {};
}

/* ----------------------------------------------------- 04 · five modes */

/** The card's mode values, and the field's words for each. */
const MODE_WORD = { blink: 'blink', wipe: 'wipe', diff: 'diff', single: 'single', stack: 'stack' };

function initModes(fig) {
  const what = fig.querySelector('.art-modes__what');
  const relabel = () => {
    const key = MODE_WORD[fig.dataset.mode];
    what.textContent = `${t(`mode.${key}`)} · ${t(`mode.${key}When`)}`;
  };
  const choose = (mode) => {
    fig.dataset.mode = mode;
    const radio = fig.querySelector(`input[value="${mode}"]`);
    if (radio) radio.checked = true;
    relabel();
  };
  for (const radio of fig.querySelectorAll('input[name^="art-mode"]')) {
    radio.addEventListener('change', () => { if (radio.checked) choose(radio.value); });
  }
  wipe(fig.querySelector('.art-wipe'), () => fig.dataset.mode === 'wipe');
  relabel();
  return { relabel, choose };
}

/* ------------------------------------------------------- 05 · the run */

// Real D2 dates of the Atala field. The thumbnails are that field; the
// sector scores are drawn to show what the strip says, not measured here:
// 6 Jul is the flash card 09 is about, 24–25 Dec is (152) Atala crossing.
const RUN = [
  { date: '06.07', thumb: 'a', hot: { 12: 2 } },
  { date: '09.07', thumb: 'a', hot: { 13: 1 } },
  { date: '19.07', thumb: 'a', hot: {} },
  { date: '24.12', thumb: 'a', hot: { 11: 2, 6: 1 } },
  { date: '25.12', thumb: 'a', hot: { 12: 2, 7: 1 } },
  { date: '01.01', thumb: 'b', hot: { 2: 1 } },
];

function initRun(fig) {
  const strip = fig.querySelector('.art-run__strip');
  strip.innerHTML = RUN.map((f, i) => `<li><button type="button" class="art-run__f" aria-pressed="${i === 0}">`
    + `<img class="art-run__thumb" src="img/talk/read-thumb-${f.thumb}.webp" width="96" height="67" alt="" decoding="async" loading="lazy">`
    + `<span class="art-run__cells" aria-hidden="true">${Array.from({ length: 20 }, (_, c) => `<i data-q="${f.hot[c] ?? 0}"></i>`).join('')}</span>`
    + `<span class="art-run__date">${f.date}</span></button></li>`).join('');
  const frames = [...strip.querySelectorAll('.art-run__f')];
  const relabel = () => frames.forEach((b, i) => b.setAttribute('aria-label', t('about.runFrame', { date: RUN[i].date })));
  for (const b of frames) b.addEventListener('click', () => { touched(fig); pressOne(frames, b); });
  const walk = (i) => later(fig, 420, () => {
    pressOne(frames, frames[i]);
    if (i < 4) walk(i + 1);
  });
  relabel();
  return { relabel, seen: () => { pressOne(frames, frames[0]); walk(1); } };
}

/* ------------------------------------------------------ 06 · a mark */

/**
 * The stars of the mark frame, in per cent of it. The first is the one the
 * talk marked, and its card is the real one; the others get a card that says
 * it is an illustration, with a word their look would plausibly earn.
 */
const STARS = [
  { x: 50.5, y: 49.5, v: 'Fixed', real: true },
  { x: 80.6, y: 17.4, v: 'Saturated' },
  { x: 94.7, y: 10.6, v: 'Fixed' },
  { x: 91.0, y: 34.4, v: 'Fixed' },
  { x: 57.7, y: 63.1, v: 'Fixed' },
  { x: 12.1, y: 74.7, v: 'Fixed' },
];

function initMark(fig) {
  const plate = fig.querySelector('.art-mark__plate');
  const img = fig.querySelector('.art-mark__card-img');
  const label = fig.querySelector('.art-mark__label');
  const word = fig.querySelector('.art-mark__note-v');
  const buttons = STARS.map((star) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'art-mark__star';
    b.style.setProperty('--sx', `${star.x}%`);
    b.style.setProperty('--sy', `${star.y}%`);
    b.setAttribute('aria-pressed', 'false');
    plate.append(b);
    return b;
  });
  let at = -1;
  const relabel = () => {
    img.src = img.dataset.srcLang.replace('{lang}', getLanguage());
    for (const b of buttons) b.setAttribute('aria-label', t('about.markTap'));
    if (at < 0) return;
    label.textContent = `1 ${t(`mark.call${STARS[at].v}`)}`;
    word.textContent = t(`mark.call${STARS[at].v}`);
  };
  const mark = (i) => {
    at = i;
    fig.classList.toggle('is-marked', i >= 0);
    pressOne(buttons, buttons[i]);
    if (i < 0) return;
    const star = STARS[i];
    fig.classList.toggle('is-real', Boolean(star.real));
    fig.style.setProperty('--sx', `${star.x}%`);
    fig.style.setProperty('--sy', `${star.y}%`);
    fig.dataset.side = star.x > 40 ? 'left' : 'right';
    relabel();
  };
  buttons.forEach((b, i) => b.addEventListener('click', () => { touched(fig); mark(at === i ? -1 : i); }));
  relabel();
  return { relabel, seen: () => later(fig, 1600, () => mark(0)) };
}

/* -------------------------------------------- 07 · words, 08 · rings */

function initVerdicts(fig) {
  const buttons = fig.querySelectorAll('.art-verdicts__list button');
  for (const b of buttons) b.addEventListener('click', () => { pressOne(buttons, b); fig.dataset.v = b.dataset.v; });
  return {};
}

function initRing(fig) {
  const chips = [...fig.querySelectorAll('.art__chip')];
  const show = (on) => { fig.dataset.on = on; pressOne(chips, chips.find((c) => c.dataset.on === on)); };
  fig.querySelector('.art-ring__plate').addEventListener('click', () => show(fig.dataset.on === 'a' ? 'b' : 'a'));
  for (const chip of chips) chip.addEventListener('click', () => show(chip.dataset.on));
  return {};
}

/* ------------------------------------------------------- 09 · flags */

function initFlags(fig) {
  const button = fig.querySelector('.art-flags__read');
  const state = fig.querySelector('.art-flags__state');
  const relabel = () => { state.textContent = t(fig.dataset.flags === 'on' ? 'about.flagsOn' : 'about.flagsOff'); };
  const set = (on) => {
    fig.dataset.flags = on ? 'on' : 'off';
    button.setAttribute('aria-pressed', String(on));
    relabel();
  };
  button.addEventListener('click', () => { touched(fig); set(fig.dataset.flags !== 'on'); });
  relabel();
  return { relabel, seen: () => later(fig, 1400, () => set(true)) };
}

/* ---------------------------------------------------- 10 · spectrum */

/** The wavelength each band's exposure saw the spot at, µm (the chart's points). */
const SPEC_AT = [0.95, 1.35, 2.05, 3.10, 4.10, 4.70];

function initSpectrum(fig) {
  const buttons = fig.querySelectorAll('.art-spec__bands button');
  const probe = fig.querySelector('.art-spec__probe');
  const read = fig.querySelector('.art-spec__read');
  const relabel = () => {
    const d = Number(fig.dataset.d);
    const [lo, hi] = BANDS[d - 1];
    read.textContent = t('about.specRead', { d: `D${d}`, lo: fmt(lo, 2), hi: fmt(hi, 2), l: fmt(SPEC_AT[d - 1], 2) });
  };
  const set = (d) => {
    fig.dataset.d = String(d);
    pressOne(buttons, buttons[d - 1]);
    const x = 18 + (SPEC_AT[d - 1] - 0.75) * 48;
    probe.style.setProperty('--px', `${((x / 240) * 100).toFixed(2)}%`);
    relabel();
  };
  for (const b of buttons) b.addEventListener('click', () => set(Number(b.dataset.d)));
  set(4);
  return { relabel };
}

/* ------------------------------------------- 11 · Gaia and WISE, 13 · depth */

// Where the talk's overlay drew each source on this frame, in its pixels.
// A Gaia circle carries its DR3 id and G where it matches, within 4 px, a
// star of the field's own Gaia list (data/vr/barnard.json, carried to the
// visit by proper motion); the fainter ones are not in that list. The one
// diamond named is Barnard's Star where WISE saw it in 2010, 15 years of its
// motion south of its Gaia circle.
const BARNARD = '4472832130942575872';
const GAIA = [[471, 187], [544, 200, '4472836327118455552', 13.45], [284, 206], [299, 232, '4472837495349546240', 13.47],
  [483, 253, '4472836047939582592', 13.60], [674, 276, '4472836189681423488', 13.71], [359, 276], [421, 306], [402, 312],
  [672, 313], [694, 318, '4472835807421415680', 12.03], [210, 319], [369, 320], [314, 328], [640, 330],
  [448, 340, BARNARD, 8.19], [268, 362], [592, 396], [285, 409], [558, 412], [706, 416],
  [240, 442, '4472832788065380224', 14.18], [507, 473, '4472832513187484544', 14.49], [469, 492],
  [567, 503, '4472832508888391168', 13.03]];
const WISE = [[210, 319], [695, 362], [285, 434], [471, 187], [592, 396], [268, 361], [408, 290], [477, 275], [313, 327],
  [671, 313], [402, 312], [705, 416], [239, 442], [285, 409], [507, 473], [560, 411], [567, 503], [421, 306], [544, 199],
  [296, 232], [483, 253], [708, 338], [673, 277], [431, 360, BARNARD]];
const NS = 'http://www.w3.org/2000/svg';

function initOverlay(fig) {
  const plate = fig.querySelector('.art-ov__plate');
  const tip = fig.querySelector('.art-ov__tip');
  const draw = (layer, points, shape) => {
    const svg = fig.querySelector(`.art-ov__${layer}`);
    for (const [x, y, id, mag] of points) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'art-ov__src');
      g.dataset.layer = layer;
      if (id) g.dataset.id = id;
      if (mag) g.dataset.mag = String(mag);
      g.innerHTML = shape(x, y) + `<circle class="art-ov__hit" cx="${x}" cy="${y}" r="13"/>`;
      svg.append(g);
    }
  };
  draw('gaia', GAIA, (x, y) => `<circle cx="${x}" cy="${y}" r="7"/>`);
  draw('wise', WISE, (x, y) => `<path d="M${x} ${y - 8}l8 8-8 8-8-8z"/>`);

  let shown = null;
  const hide = () => { tip.hidden = true; shown?.classList.remove('is-on'); shown = null; };
  const show = (src) => {
    shown?.classList.remove('is-on');
    shown = src;
    src.classList.add('is-on');
    const { layer, id, mag } = src.dataset;
    const named = id === BARNARD ? 'Barnard' : '';
    tip.textContent = layer === 'gaia' && id
      ? t(`about.gaiaKnown${named}`, { id, g: fmt(Number(mag), 2) })
      : t(`about.${layer}${named || 'Tip'}`);
    tip.dataset.layer = layer;
    tip.hidden = false;
    const p = plate.getBoundingClientRect();
    const r = src.getBoundingClientRect();
    const x = r.left + r.width / 2 - p.left;
    tip.style.setProperty('--tx', `${Math.round(Math.min(Math.max(x, 70), p.width - 70))}px`);
    tip.style.setProperty('--ty', `${Math.round(r.top - p.top)}px`);
    tip.dataset.below = String(r.top - p.top < 44);
    if (tip.dataset.below === 'true') tip.style.setProperty('--ty', `${Math.round(r.bottom - p.top)}px`);
  };
  plate.addEventListener('pointerover', (e) => {
    const src = e.target.closest?.('.art-ov__src');
    if (src && e.pointerType === 'mouse') show(src);
  });
  plate.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  plate.addEventListener('click', (e) => {
    const src = e.target.closest?.('.art-ov__src');
    if (src && src !== shown) show(src); else hide();
  });
  for (const chip of fig.querySelectorAll('.art__chip')) {
    chip.addEventListener('click', () => {
      const on = chip.getAttribute('aria-pressed') !== 'true';
      chip.setAttribute('aria-pressed', String(on));
      fig.dataset[chip.dataset.layer] = on ? 'on' : 'off';
      if (!on && shown?.dataset.layer === chip.dataset.layer) hide();
    });
  }
  return { relabel: () => { if (shown) show(shown); } };
}

function initWise(fig) {
  wipe(fig.querySelector('.art-wipe'));
  return {};
}

/** One visit's 5σ limit in the Atala field, AB, as the depth panel measured it. */
const ONE_VISIT = 17.6;

function initDepth(fig) {
  const input = fig.querySelector('.art-depth__mag');
  const probe = fig.querySelector('.art-depth__probe');
  const read = fig.querySelector('.art-depth__read');
  const relabel = () => {
    const m = Number(input.value);
    const gap = m - ONE_VISIT;
    const text = gap <= 0
      ? t('about.depthSeen', { m: fmt(m, 1) })
      : t('about.depthShort', { m: fmt(m, 1), g: fmt(gap, 1), f: Math.round(10 ** (0.4 * gap)).toLocaleString(getLanguage()) });
    read.textContent = text;
    input.setAttribute('aria-valuetext', text);
  };
  const set = () => {
    probe.style.setProperty('--mx', `${(12 + (Number(input.value) - 14) * 18).toFixed(1)}px`);
    relabel();
  };
  input.addEventListener('input', set);
  set();
  return { relabel };
}

/* -------------------------------------------------- 15 · across seasons */

/** Where on the drawn arc a body at d AU lands, viewBox units. */
const ARC = { 1000: [44.5, 85.9], 500: [60.1, 70.8], 200: [113, 43.5], 100: [222, 58] };

function initSeasons(fig) {
  const chips = [...fig.querySelectorAll('.art__chip')];
  const b = fig.querySelector('.art-seasons__b');
  const read = fig.querySelector('.art-seasons__read');
  // Half a year moves the Earth up to 2 AU across: a body d AU away shifts by about 2/d radians.
  const relabel = () => {
    const d = Number(fig.dataset.au);
    read.textContent = t('about.seasonsRead', { d, a: fmt((2 / d) * (180 / Math.PI) * 60, 1) });
  };
  const set = (d) => {
    fig.dataset.au = String(d);
    pressOne(chips, chips.find((c) => c.dataset.au === String(d)));
    b.style.setProperty('--bx', `${ARC[d][0]}px`);
    b.style.setProperty('--by', `${ARC[d][1]}px`);
    relabel();
  };
  for (const chip of chips) chip.addEventListener('click', () => set(Number(chip.dataset.au)));
  set(500);
  return { relabel };
}

const INIT = {
  'read-sky': initSky, 'read-blink': initBlink, 'read-north': initNorth, 'read-modes': initModes,
  'read-run': initRun, 'read-mark': initMark, 'read-verdicts': initVerdicts, 'read-ring': initRing,
  'read-flags': initFlags, 'read-spectrum': initSpectrum, 'read-overlay': initOverlay, 'read-wise': initWise,
  'read-depth': initDepth, 'read-seasons': initSeasons,
};

/**
 * A copy of one card's picture, live, put into `into`: the tour's "Not
 * clear" shows the same small demo the sheet does.
 * @param {string} id the card's step id
 * @param {HTMLElement} into
 * @returns {{ relabel: () => void } | null}
 */
export function mountDemo(id, into, { mode } = {}) {
  into.replaceChildren();
  const source = $(id)?.querySelector('.read__art');
  if (!source) return null;
  const fig = source.cloneNode(true);
  fig.classList.remove('is-touched');
  for (const radio of fig.querySelectorAll('input[type="radio"]')) radio.name = `${radio.name}-demo`;
  for (const img of fig.querySelectorAll('img[loading="lazy"]')) img.loading = 'eager';
  into.append(fig);
  const card = INIT[id]?.(fig) ?? {};
  if (mode) card.choose?.(mode);
  card.seen?.();
  return { relabel: () => { applyTranslations(fig); card.relabel?.(); } };
}

/* ------------------------------------------------------ the sheet */

/** Start fetching and decoding the pictures of a card and the two after it. */
function warm(step) {
  for (let s = step, i = 0; s && i < 3; s = s.nextElementSibling, i++) {
    for (const img of s.querySelectorAll('img[loading="lazy"]')) {
      img.loading = 'eager';
      img.decode?.().catch(() => {});
    }
  }
}

/** Watch the cards inside the open sheet: on while visible, seen once shown. */
function watch(sheet) {
  if (!('IntersectionObserver' in window)) {
    for (const step of sheet.querySelectorAll('.read__step')) step.classList.add('is-seen');
    return;
  }
  sheet.classList.add('is-watching');
  watcher = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const step = e.target;
      step.classList.toggle('is-on', e.isIntersecting);
      if (!e.isIntersecting) continue;
      warm(step);
      if (step.classList.contains('is-seen')) continue;
      // The unseen frame has to be drawn once before the change, or there is nothing to play from.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        step.classList.add('is-seen');
        cards.get(step.id)?.seen?.();
      }));
    }
  }, { root: sheet, threshold: 0.3 });
  for (const step of sheet.querySelectorAll('.read__step')) watcher.observe(step);
}

function unwatch(sheet) {
  watcher?.disconnect();
  watcher = null;
  // Each opening plays the pictures once again.
  for (const step of sheet.querySelectorAll('.read__step')) step.classList.remove('is-on', 'is-seen');
  for (const fig of sheet.querySelectorAll('.is-touched')) fig.classList.remove('is-touched');
}

/** Tab and Shift+Tab go round inside the sheet. */
function trapFocus(sheet, e) {
  if (e.key !== 'Tab') return;
  const stops = [...sheet.querySelectorAll('button, a[href], input, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.getClientRects().length);
  if (!stops.length) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet.querySelector('.read__title'))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
}

/** Scroll the sheet to a card. Cards off screen have a placeholder height
 *  until drawn, so the place is taken again once the ones above are. */
function scrollToCard(sheet, card) {
  const bar = sheet.querySelector('.read__bar');
  const go = () => { sheet.scrollTop = card.offsetTop - (bar?.offsetHeight ?? 0) - 12; };
  go();
  requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
}

/**
 * Open the sheet, at the top or at one card (by its id).
 * @param {string} [at]
 */
export function openRead(at) {
  const sheet = $('about');
  if (sheet.open) return;
  // The tour walks the field screen, so it is offered only from there.
  $('tour-replay').hidden = !$('gate')?.hidden;
  hooks.onOpen();
  sheet.showModal();
  markSeen();
  const card = at ? $(at) : null;
  if (card) scrollToCard(sheet, card);
  // Without this the sheet focuses its last button and opens scrolled to the end.
  else sheet.scrollTop = 0;
  watch(sheet);
}

/** @param {{ onTour: () => void, onOpen?: () => void, onClose?: () => void }} given */
export function initRead(given) {
  hooks = { ...hooks, ...given };
  const sheet = $('about');
  for (const [id, init] of Object.entries(INIT)) {
    const step = $(id);
    const fig = step?.querySelector('.read__art');
    if (fig) cards.set(id, init(fig));
  }
  relabelCue();
  $('about-open').addEventListener('click', () => openRead());
  $('gate-about').addEventListener('click', () => openRead());
  $('about-close').addEventListener('click', () => sheet.close());
  $('about-x').addEventListener('click', () => sheet.close());
  $('tour-replay').addEventListener('click', () => { sheet.close(); hooks.onTour(); });
  sheet.addEventListener('keydown', (e) => trapFocus(sheet, e));
  sheet.addEventListener('close', () => { unwatch(sheet); hooks.onClose(); });
  // A press on the backdrop, outside the sheet's own box, closes it.
  sheet.addEventListener('click', (e) => {
    if (e.target !== sheet) return;
    const r = sheet.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) sheet.close();
  });
}

/**
 * app.js — state, wiring, and the loading choreography.
 *
 * Two things are worth reading carefully.
 *
 * `openField` asks which frames cover a position, thins them to one frame per
 * visit, spreads the selection across the whole time baseline rather than taking
 * the first N, and pulls the pixels in parallel so the blink can start before the
 * last frame has landed.
 *
 * `drawAxis` draws the survey's own cadence to a real date scale. The visits are
 * not a list of rows — they are clusters on a timeline, and the six-month rhythm
 * the mission was built around is something you should be able to see.
 */

import { t, setLanguage, getLanguage, applyTranslations, fmt, fmtDate, fmtDay, fmtTime } from './i18n.js';
import { skySigma, stackDepth, shortfall, limitAB, PLANET_NINE_V } from './depth.js';
import { scoreSectors, standouts, peakIndex, sectorBounds, SECTOR_COUNT } from './sectors.js';
import { Gate, loadStars } from './gate.js';
import { drawStrip } from './strip.js';
import { themeTransition } from './twilight.js';
import { planetsNow } from './ephemeris.js';
import { rankCandidates } from './hunt.js';
import { seasonChunks, chunkAt, forStack, averaged } from './stack.js';
import { TangentGrid, separation, deltaRA } from './wcs.js';
import { loadStamp } from './stamp.js';
import { SkyView, shortName } from './sky.js';
import {
  searchFrames, NoRelayError, UpstreamError, groupVisits, bandsPresent, bandRange, parseCoordinates,
  resolveName, formatRA, formatDec, skybotCone, identifySource, fieldObjects, toS3,
} from './catalog.js';

/* The reprojected grid is shaped like the viewport so the sky can fill it. 640
   across is already four times finer than SPHEREx's 6.15" pixel, so the canvas
   upscales smoothly without resampling more than it needs to. */
/* SPHEREx's detectors sample the sky at 6.15" per pixel, so a 20' field holds
   about 200 real pixels across however wide the screen is. Resampling far past
   that invents nothing and turns every bright star into a square plateau, so the
   grid is cut to ~2.5 samples per detector pixel and the browser's own high
   quality resampler takes it the rest of the way to the glass. */
const DETECTOR_ARCSEC = 6.15;
const SAMPLES_PER_PIXEL = 2.5;
const GRID_MIN_W = 360;
const GRID_MAX_W = 1024;

const gridWidthFor = (fovDeg) => Math.min(GRID_MAX_W, Math.max(GRID_MIN_W,
  Math.round(((fovDeg * 3600) / DETECTOR_ARCSEC) * SAMPLES_PER_PIXEL)));
const MAX_VISITS = 10;
const FETCH_CONCURRENCY = 4;
const SKYBOT_CONCURRENCY = 2;
const FOV_CHOICES = [0.1, 0.15, 0.2, 0.3, 0.45, 0.6];
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Snap any field width to the nearest one the selector offers. */
const nearestFov = (deg) => FOV_CHOICES.reduce((a, b) => (Math.abs(b - deg) < Math.abs(a - deg) ? b : a));

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mjdToDate = (mjd) => new Date((mjd - 40587) * 86400000);

const state = {
  ra: null, dec: null, fov: 0.3, band: 'all', label: '',
  frames: [], visits: [], truncated: false,
  playing: false, rate: 2, timer: null, abort: null, presets: [], bytes: 0, bare: false,
  depth: null, examined: [], sectors: null, candidates: null, hunting: false, loading: false, failed: false, view: 'sky',
  facts: null, bodies: 0,
  skyCredit: '',
};

let sky;

/* ------------------------------------------------------------------ helpers */

/** Run tasks with a ceiling on how many are in flight at once. */
async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/*
 * One visit's pixels, fetched and resampled in a worker.
 *
 * The resampling is a third of a second of arithmetic per visit; on this thread
 * it stalled the blink and the pointer for as long as a field took to load. The
 * workers are kept and reused, one per fetch slot. Where a worker cannot start —
 * an old browser, a strict policy — the same function runs here instead.
 */
const stampWorkers = { idle: [], count: 0, broken: false, seq: 0 };

function takeWorker() {
  if (stampWorkers.idle.length) return stampWorkers.idle.pop();
  if (stampWorkers.broken || stampWorkers.count >= FETCH_CONCURRENCY) return null;
  try {
    const w = new Worker(new URL('./stamp-worker.js', import.meta.url), { type: 'module' });
    stampWorkers.count++;
    return w;
  } catch {
    stampWorkers.broken = true;
    return null;
  }
}

function readStamp(url, grid, { signal } = {}) {
  const worker = takeWorker();
  if (!worker) return loadStamp(url, grid, { signal });
  const id = ++stampWorkers.seq;
  return new Promise((resolve, reject) => {
    const settle = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      settle();
      stampWorkers.idle.push(worker);
      if (data.error) {
        const err = new Error(data.error);
        if (data.error === 'AbortError') err.name = 'AbortError';
        reject(err);
      } else {
        resolve(data.stamp);
      }
    };
    // A worker that fails to load says so once, here; from then on the page
    // does the work itself rather than failing every visit the same way.
    const onError = (e) => {
      e.preventDefault?.();
      settle();
      worker.terminate();
      stampWorkers.count--;
      stampWorkers.broken = true;
      loadStamp(url, grid, { signal }).then(resolve, reject);
    };
    const onAbort = () => worker.postMessage({ type: 'abort', id });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.postMessage({
      id, url,
      grid: { ra: grid.ra, dec: grid.dec, fovDeg: grid.fovDeg, width: grid.width, height: grid.height },
    });
  });
}

/** Keep the ends, spread the rest — a sample that still spans the full baseline. */
function spread(list, max) {
  if (list.length <= max) return list.slice();
  const out = [];
  for (let k = 0; k < max; k++) out.push(list[Math.round((k * (list.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

const fovLabel = (deg) => (deg >= 1 / 60 ? `${fmt(deg * 60, 1)}′` : `${fmt(deg * 3600, 0)}″`);
/** Both sides of the field, because the shorter one is what crops an object. */
const fieldLabel = () => {
  const g = sky?.grid;
  if (!g?.height) return fovLabel(state.fov);
  return `${fovLabel(g.fovDeg)} × ${fovLabel(g.fovHeightDeg)}`;
};

/* -------------------------------------------------------------------- state */

function writeHash() {
  if (state.ra == null) return;
  const p = new URLSearchParams({
    ra: state.ra.toFixed(5), dec: state.dec.toFixed(5),
    fov: String(state.fov), band: state.band, lang: getLanguage(),
  });
  if (state.label) p.set('name', state.label);
  history.replaceState(null, '', `#${p}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  // Number(null) is 0, which would read an empty hash as a valid position at the
  // vernal equinox. Absent means absent.
  const ra = p.has('ra') ? Number(p.get('ra')) : NaN;
  const dec = p.has('dec') ? Number(p.get('dec')) : NaN;
  return {
    lang: p.get('lang'),
    band: p.get('band') ?? 'all',
    fov: FOV_CHOICES.includes(Number(p.get('fov'))) ? Number(p.get('fov')) : null,
    name: p.get('name') ?? '',
    position: Number.isFinite(ra) && Number.isFinite(dec) && ra >= 0 && ra < 360 && Math.abs(dec) <= 90
      ? { ra, dec } : null,
  };
}

/* ------------------------------------------------------------------ chrome */

/**
 * The wait, shown as what it is: the visits being read, one line each, with
 * the date, the band, and how many megabytes of that file it took. A field
 * whose frames come slowly used to be a black plate and one sentence; this is
 * the same wait with the archive's own work on it.
 */
function renderPlateLog() {
  const log = $('plate-log');
  const show = !$('plate-state').hidden && state.visits.length > 0 && !sky?.visits.length;
  log.hidden = !show;
  if (!show) return;
  log.replaceChildren(...state.visits.map(({ frame, status, bytes }) => {
    const li = document.createElement('li');
    li.className = 'plate__log-row';
    li.dataset.status = status;
    const date = document.createElement('span');
    date.className = 'plate__log-date';
    date.textContent = fmtDate(frame.iso);
    const band = document.createElement('span');
    band.className = 'plate__log-band';
    band.textContent = frame.band;
    const what = document.createElement('span');
    what.className = 'plate__log-what';
    what.textContent = status === 'ready'
      ? t('log.ready', { mb: fmt((bytes ?? 0) / 1048576, 1) })
      : t(`log.${status}`);
    li.append(date, band, what);
    return li;
  }));
}

function setPlateState(message, { progress = null, hidden = false, retry = false } = {}) {
  $('plate-state').hidden = hidden;
  $('plate-message').textContent = message ?? '';
  // A failure someone else can fix by waiting gets a way to ask again in
  // place, rather than a sentence telling them to retype the field.
  $('plate-retry').hidden = !retry;
  const meter = $('plate-meter');
  meter.hidden = progress == null;
  if (progress != null) $('plate-meter-fill').style.transform = `scaleX(${clamp(progress, 0, 1)})`;
  renderPlateLog();
}

/**
 * The canvas is the page's primary content, so it needs a name that says what is
 * currently on it — not a decorative `aria-hidden`.
 */
function describeCanvas() {
  const v = sky?.current;
  $('sky').setAttribute('aria-label', v
    ? t('readout.canvas', {
      date: fmtDate(v.frame.iso), time: fmtTime(v.frame.iso), band: v.frame.band,
      ra: formatRA(state.ra), dec: formatDec(state.dec),
    })
    : t('readout.canvasIdle'));
}

/* ------------------------------------------------------------- watching */

/**
 * The expanded view: the picture leaves the document and takes the window,
 * and the rest of the page goes with it. Nothing was ever drawn over the
 * picture, so this is a change of size rather than a hiding of overlays.
 */
function setBare(on) {
  state.bare = on;
  document.body.dataset.bare = String(on);
  const btn = $('bare');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = t(on ? 'view.chrome' : 'view.bare');
}

/** The headline: who is on screen, and what the archive holds for them. */
function updateIdentity() {
  // A preset name carries its qualifier after an interpunct - "(152) Atala -
  // 25 Dec 2025". The qualifier becomes the eyebrow so the name itself keeps
  // the display size and stays on one line.
  // Что открыто — написано там же, где вводят следующее. Строка поиска на
  // этой странице работает как адресная: в ней стоит имя поля, клик выделяет
  // его целиком, набранное поверх уходит в поиск.
  const whole = state.label || (state.ra == null ? '' : t('field.untitled'));
  const box = $('target');
  if (document.activeElement !== box) box.value = whole;
  document.title = whole ? `${whole} · Muninn` : 'Muninn';
  // Three lines at the foot of the label column: where, and how much of it.
  $('field-pos').textContent = state.ra == null
    ? '—'
    : `${formatRA(state.ra)}\n${formatDec(state.dec)}\n${fieldLabel()}`;

  const ready = state.visits.filter((v) => v.status === 'ready');
  const cue = $('field-cue');
  if (!ready.length) {
    // Say what is actually happening. This line claimed to be asking IRSA for
    // the frame index long after the index had arrived and the pixels were
    // being read, which reads as a page that has hung — and on a field with
    // forty-seven visits it says it for a minute.
    const total = state.visits.length;
    const settled = state.visits.filter((v) => v.status === 'ready' || v.status === 'dropped').length;
    cue.hidden = false;
    if (!total) {
      cue.textContent = state.ra == null ? t('app.lede')
        : state.failed ? t('epochs.cueFailed')
        : state.frames.length ? t('epochs.none') : t('epochs.searching');
    } else {
      cue.textContent = settled >= total
        ? t('epochs.none')
        : t('epochs.loading', { done: settled, total });
    }
    state.facts = null;
    $('stat-line').replaceChildren();
    return;
  }
  cue.hidden = true;

  // One quiet line of monospace instead of five figures at headline size. The
  // numbers still read; they no longer compete with the finding above them.
  const mjds = ready.map((v) => v.frame.mjd);
  const bands = [...new Set(ready.map((v) => v.frame.band))];
  const span = `${fmt(Math.min(...ready.map((v) => v.frame.emMin)), 2)}–${fmt(Math.max(...ready.map((v) => v.frame.emMax)), 2)} µm`;
  state.facts = {
    visits: ready.length,
    days: Math.round(Math.max(...mjds) - Math.min(...mjds)),
    band: bands.length === 1 ? `${bands[0]} ${span}` : span,
  };
  renderFacts();
}

/**
 * The figures the finding rests on, as a ledger under it.
 *
 * Всё, на чём стоит вывод: сколько заходов и за сколько дней, какие полосы,
 * сколько мест выделилось, до какой яркости дошли и сколько тел каталога прошло
 * через поле. В колонке это столбец «название — число», а не строка через
 * точки: числа встают друг под другом и читаются сверху вниз.
 */
function renderFacts() {
  const f = state.facts;
  const box = $('stat-line');
  box.replaceChildren();
  if (!f) return;
  const rows = [[t('facts.visits'), t('facts.visitsV', { n: f.visits, days: f.days })], [t('facts.band'), f.band]];
  // The same count the run's headline gives: every cell at 4σ or more, not
  // the twelve the hunt goes on to check or the eight the headline used to
  // stop at — two caps side by side read as two answers to one question.
  if (state.candidates && state.sectors) {
    rows.push([t('facts.standout'), String(standouts(state.sectors, { limit: Infinity }).length)]);
  }
  if (state.depth) rows.push([t('facts.depth'), `${fmt(state.depth.single, 1)} AB`, 'accent']);
  // The count grows as SkyBoT answers visit by visit; while it is still
  // answering, the row says how far it has got, so "caught 3" at fifteen
  // seconds and "caught 11" at forty-five do not read as two different fields.
  const visits = sky?.visits.length ?? 0;
  const answered = sky ? sky.visits.filter((v) => sky.knownObjects.has(v.frame.obsId) || skybot.failed.has(v.frame.obsId)).length : 0;
  const asking = skybotOn() && visits > 0 && answered < visits;
  if (state.bodies || asking) {
    rows.push([t('facts.bodies'), asking
      ? t('facts.bodiesAsking', { n: state.bodies ?? 0, done: answered, total: visits })
      : String(state.bodies)]);
  }
  for (const [name, value, tone] of rows) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = name;
    dd.textContent = value;
    if (tone) dd.dataset.tone = tone;
    row.append(dt, dd);
    box.append(row);
  }
}

/* ----------------------------------------------------------------- presets */

async function loadPresets() {
  for (const url of ['data/targets.json', 'api/targets']) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const body = await res.json();
      if (Array.isArray(body.targets) && body.targets.length) { state.presets = body.targets; break; }
    } catch {
      /* try the next source */
    }
  }
  renderPresets();
}

/** The presets live on the sky now; this keeps the sky's own list current. */
function renderPresets() {
  renderGateJump();
}



/* ------------------------------------------------------------------- hunt */

/**
 * Run the search the whole project is named for, over the whole field.
 *
 * The sector matrix has already said which cells stopped looking like
 * themselves. This takes the brightest pixel of each of those cells, asks the
 * same photometry the marks use what is at that sky position in every visit,
 * and keeps whatever turns out to be moving.
 *
 * Then it sorts by slowness, because slowness is depth: an asteroid streaks at
 * tens of arcseconds an hour, and anything out where the Planet X predictions
 * live crawls at a fraction of one.
 */
async function huntField() {
  // Tracking needs every visit it will ever have: a mover found in six frames
  // and re-found in ten is one search done twice.
  if (!sky?.visits.length || !state.sectors || state.loading) return;
  state.hunting = true;
  renderHunt();
  try {
    await runHunt();
  } catch (err) {
    // A search that fell over has to say so; leaving the button spinning for
    // ever is the one outcome that tells the user nothing.
    console.error('hunt failed', err);
    state.candidates = { checked: 0, list: [], all: [], error: err.message };
  } finally {
    state.hunting = false;
    renderHunt();
  }
}

/**
 * Hand control back without stalling.
 *
 * `setTimeout(0)` is clamped to a full second in a background tab, so yielding
 * once per candidate turned a two-second search into a twelve-second one for no
 * reason at all. `scheduler.yield` is not clamped; where it is missing the
 * fallback yields every few items rather than every one.
 */
const breathe = (() => {
  const native = globalThis.scheduler?.yield?.bind(globalThis.scheduler);
  let since = 0;
  return async () => {
    if (native) return native();
    if ((since += 1) % 4) return undefined;
    return new Promise((r) => { setTimeout(r, 0); });
  };
})();

/**
 * Bumped by every field that opens. Anything that awaited across that change
 * holds a stale number and drops its answer instead of writing it over the new
 * field. Names sent off to be resolved are counted separately (askSeq, see
 * submitTarget), so a name that turns out not to exist cancels nothing.
 */
let fieldSeq = 0;
let askSeq = 0;

async function runHunt() {
  const gen = fieldSeq;
  const hits = standouts(state.sectors, { minScore: 4, limit: 12 });
  const seen = [];
  const cos = Math.cos((state.dec * Math.PI) / 180);

  for (const hit of hits) {
    const visit = sky.visits[hit.visit];
    if (!visit) continue;
    const at = peakIndex(
      visit.stamp.data, visit.stamp.width, visit.stamp.height, sectorBounds(hit.sector),
    );
    if (!at) continue;
    const world = sky.grid.indexToWorld(at[0], at[1]);
    if (!world) continue;
    const [ra, dec] = world;
    // The same peak found in two neighbouring cells is one object, not two.
    if (seen.some((c) => Math.hypot(deltaRA(c.ra, ra) * cos, c.dec - dec) * 3600 < 30)) continue;

    const analysis = sky.trackMark(ra, dec);
    seen.push({ ra, dec, sector: hit.sector, visit: hit.visit, obsId: visit.frame.obsId, analysis });
    // Yield so a dozen tracks do not freeze the frame the user is watching.
    await breathe();
    if (gen !== fieldSeq) return;
  }

  state.candidates = { checked: hits.length, all: seen, list: rankCandidates(seen), flashes: flashesOf(seen) };
  renderVerdict();
}

/**
 * What stood out in one visit and is gone in the rest.
 *
 * The hunt ranks movers, and a mover needs positions in several visits to have
 * a rate. A main-belt asteroid never gives it that: at twenty arcsec an hour it
 * crosses the field in hours, and SPHEREx comes back days later. It shows up as
 * a bright spot in exactly one visit — which is what the Atala field is for —
 * and the hunt used to answer "nothing moved" over the top of it. These are
 * kept as a list of their own and checked against SkyBoT for that one visit.
 *
 * "One visit" allows a second, weaker detection, because a star or a noise
 * peak inside the measuring box in another visit is common; more than a fifth
 * of the visits and it is something that sits there and flickers, not a flash.
 */
function flashesOf(seen) {
  return seen
    .filter((c) => {
      const a = c.analysis;
      if (a?.kind === 'transient') return true;
      return a?.kind === 'intermittent' && a.seen <= Math.max(2, Math.round(a.total * 0.2));
    })
    .map((c) => {
      // Where it was in the visit it stood out in, measured, not the peak cell.
      const at = c.analysis.track.find((p) => p.obsId === c.obsId) ?? { ra: c.ra, dec: c.dec };
      return { ...c, at };
    });
}

/** SkyBoT's word on a hunt result: a mover over every visit it was seen in, a flash over its own. */
const huntVerdict = (c, flash = false) => skybotVerdict(flash
  ? [{ ra: c.at.ra, dec: c.at.dec, obsId: c.obsId }]
  : seenAt(c.analysis, { ra: c.ra, dec: c.dec, obsId: c.obsId }));

function renderHunt() {
  state.caught = caughtAsteroids();
  renderVerdict();
  const btn = $('hunt-run');
  btn.disabled = state.hunting || !state.sectors || state.loading;
  btn.dataset.busy = String(state.hunting);
  btn.textContent = t(state.hunting ? 'hunt.running' : state.candidates ? 'hunt.rerun' : 'hunt.run');
  // Waiting for visits, the button has nothing it could do; the note says why.
  btn.hidden = state.loading;

  const out = $('hunt-list');
  out.replaceChildren();
  const found = state.candidates;
  const count = $('hunt-count');
  count.textContent = found && !found.error
    ? t('hunt.count', { n: found.list.length, checked: found.checked })
    : '';
  count.dataset.tone = found?.list?.length ? 'counter' : '';
  $('hunt-note').textContent = state.loading
    ? t('hunt.waiting')
    : !found
    ? t('hunt.idle')
    : found.error
      ? t('hunt.failed', { why: found.error })
      : found.list.length
      ? t('hunt.found', { n: found.list.length, checked: found.checked })
      : t('hunt.none', { checked: found.checked });

  // Named at drawing time, not at hunting time: SkyBoT's answers keep arriving
  // after the hunt has finished, and a name that came late still counts.
  const movers = found?.all
    ? rankCandidates(found.all.map((c) => {
      const catalog = huntVerdict(c);
      // Known only if the name explains every visit it was seen in.
      const explained = catalog.state === 'match' && !catalog.unmatched?.length;
      return { ...c, catalog, known: explained ? catalog.name : null };
    }))
    : [];

  for (const c of movers) {
    const li = document.createElement('li');
    li.className = 'cand';

    const head = document.createElement('p');
    head.className = 'cand__where';
    head.dataset.known = String(Boolean(c.known));
    head.textContent = c.where ? t(`hunt.where.${c.where.key}`) : '—';

    const rate = document.createElement('p');
    rate.className = 'cand__rate num';
    // Past a couple of thousand astronomical units the arithmetic still returns
    // a number, but the baseline no longer earns it. Say so instead.
    // Slow movers are the point, so the rate keeps its digits where it matters.
    const shown = fmt(c.analysis.ratePerHour, c.analysis.ratePerHour < 1 ? 3 : 2);
    rate.textContent = c.au != null && c.au <= 2000
      ? t('hunt.rate', { rate: shown, au: fmt(c.au, 0) })
      : t('hunt.rateVague', { rate: shown });

    const id = document.createElement('p');
    id.className = 'cand__id';
    id.textContent = skybotLine(c.catalog, { none: 'hunt.unknown' });

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'link cand__go';
    go.textContent = t('hunt.show');
    go.setAttribute('aria-label', `${t('hunt.show')}: ${formatRA(c.ra)} ${formatDec(c.dec)}`);
    go.addEventListener('click', () => {
      addMark(c.ra, c.dec);
      sky.sector = c.sector;
      retrackMarks();
      renderMatrix();
    });

    li.append(head, rate, id, go);
    out.append(li);
  }
  renderFlashes(found);
  $('hunt').hidden = !sky?.visits.length;
}

/**
 * Known asteroids SPHEREx actually caught.
 *
 * Not found by the hunt: the hunt looks at the dozen places that stood out
 * most, and a 14th-magnitude asteroid loses that contest to cosmic-ray hits.
 * This works from the other end — for every visit SkyBoT has answered, each
 * body's predicted spot is measured. A detection there, close to the
 * prediction, that is absent from the same spot in the other visits is the
 * body itself, and not a star it happened to pass in front of.
 */
function caughtAsteroids() {
  if (!sky?.grid || sky.visits.length < 2 || state.loading) return [];
  const { width, height } = sky.grid;
  const out = [];
  for (const v of sky.visits) {
    const objects = sky.knownObjects.get(v.frame.obsId);
    if (!objects?.length) continue;
    for (const o of objects) {
      const g = sky.grid.worldToIndex(o.ra, o.dec);
      if (!g || g[0] < 0 || g[1] < 0 || g[0] > width - 1 || g[1] > height - 1) continue;
      const hit = sky.measure(v, o.ra, o.dec);
      if (!hit || separation(hit.ra, hit.dec, o.ra, o.dec) * 3600 > matchArcsec(o)) continue;
      // A star under the spot shows in the other visits as well. One other
      // detection is allowed for a noise peak or another body passing.
      let elsewhere = 0;
      for (const w of sky.visits) {
        if (w === v) continue;
        const m = sky.measure(w, hit.ra, hit.dec, { boxPx: 2 });
        if (m && m.peak > hit.peak * 0.3) elsewhere += 1;
      }
      if (elsewhere > 1) continue;
      out.push({
        obsId: v.frame.obsId, at: hit, object: o, snr: hit.snr,
        catalog: { state: 'match', name: o.num ? `(${o.num}) ${o.name}` : o.name, object: o, obsId: v.frame.obsId },
      });
    }
  }
  return out.sort((a, b) => b.snr - a.snr);
}

/**
 * The flashes: known asteroids caught in one visit, then the flashes nothing
 * accounts for. The caught ones are the field doing what it should and the
 * fastest way to see the check working, so they come first, one card each.
 * The unnamed ones are mostly cosmic-ray hits and noise, and five full cards
 * of "probably nothing" drowned the one that mattered; they share one card,
 * one explanation, and a date to go and look at each.
 */
function renderFlashes(found) {
  const list = $('flash-list');
  const head = $('flash-head');
  list.replaceChildren();
  const caught = state.caught ?? [];
  const near = (c, k) => c.obsId === k.obsId
    && separation(c.at.ra, c.at.dec, k.at.ra, k.at.dec) * 3600 <= 2 * DETECTOR_ARCSEC;
  const unnamed = (found?.flashes ?? [])
    .map((c) => ({ ...c, catalog: huntVerdict(c, true) }))
    .filter((c) => c.catalog.state !== 'match' && !caught.some((k) => near(c, k)));

  const total = caught.length + unnamed.length;
  head.hidden = !total;
  $('flash-note').hidden = !caught.length;
  if (!total) return;
  head.textContent = t('hunt.flashes', { n: total });
  // What a caught asteroid is, said once for all of them.
  $('flash-note').textContent = t('hunt.flashKnown');

  const dateOf = (c) => {
    const v = sky.visits.find((x) => x.frame.obsId === c.obsId);
    return v ? dateLabel(v.frame.iso) : '';
  };

  // The brightest few get a card; a busy field can catch a dozen, and a
  // dozen cards push everything else off the panel.
  const CARDS = 4;
  for (const c of caught.slice(0, CARDS)) {
    const v = sky.visits.find((x) => x.frame.obsId === c.obsId);
    const o = c.object;
    const li = document.createElement('li');
    li.className = 'cand';

    const title = document.createElement('p');
    title.className = 'cand__where';
    title.dataset.known = 'true';
    title.textContent = c.catalog.name;

    // When and in what light; how bright SkyBoT expects it; and how fast it
    // was going, which is why it is gone by the next visit.
    const when = document.createElement('p');
    when.className = 'cand__rate num';
    const bits = [dateOf(c), v?.frame.band ?? ''];
    if (Number.isFinite(o.mag)) bits.push(`V ${fmt(o.mag, 1)}ᵐ`);
    const speed = Math.hypot(o.dRA, o.dDec);
    if (Number.isFinite(speed) && speed > 0) bits.push(t('overlay.rate', { rate: fmt(speed, speed < 10 ? 1 : 0) }));
    bits.push(`${fmt(c.snr, 0)}σ`);
    when.textContent = bits.filter(Boolean).join(' · ');

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'link cand__go';
    go.textContent = t('hunt.flashShow');
    // Four buttons all called "Show" are one name to a screen reader.
    go.setAttribute('aria-label', `${t('hunt.flashShow')}: ${c.catalog.name}`);
    go.addEventListener('click', () => showFlash(c));

    li.append(title, when, go);
    list.append(li);
  }

  const rest = caught.slice(CARDS);
  if (rest.length) {
    const li = document.createElement('li');
    li.className = 'cand';
    const title = document.createElement('p');
    title.className = 'cand__where';
    title.dataset.known = 'true';
    title.textContent = t('hunt.caughtMore', { n: rest.length });
    const names = document.createElement('p');
    names.className = 'cand__dates';
    for (const c of rest) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'link cand__go';
      go.textContent = c.catalog.name;
      go.title = dateOf(c);
      go.addEventListener('click', () => showFlash(c));
      names.append(go);
    }
    li.append(title, names);
    list.append(li);
  }

  if (unnamed.length) {
    const li = document.createElement('li');
    li.className = 'cand';

    const title = document.createElement('p');
    title.className = 'cand__where';
    title.dataset.known = 'false';
    title.textContent = t('hunt.flashUnknown', { n: unnamed.length });

    // Say "no match" only when SkyBoT was asked about every one of them.
    const states = new Set(unnamed.map((c) => c.catalog.state));
    const id = document.createElement('p');
    id.className = 'cand__id';
    id.textContent = states.size === 1 && states.has('none')
      ? t('hunt.flashNone')
      : skybotLine({ state: [...states].find((s) => s !== 'none') });

    const dates = document.createElement('p');
    dates.className = 'cand__dates';
    for (const c of unnamed) {
      const v = sky.visits.find((x) => x.frame.obsId === c.obsId);
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'link cand__go';
      go.textContent = v ? dateLabel(v.frame.iso) : '—';
      go.addEventListener('click', () => showFlash(c));
      dates.append(go);
    }

    li.append(title, id, dates);
    list.append(li);
  }
}

/** Go to the visit a flash was in, and mark it there. */
function showFlash(c) {
  const idx = sky.visits.findIndex((x) => x.frame.obsId === c.obsId);
  if (idx < 0) return;
  stopPlayback();
  selectMode('single');
  sky.setIndex(idx);
  const cos = Math.cos((c.at.dec * Math.PI) / 180);
  const already = sky.marks.some((m) => Math.hypot(deltaRA(m.ra, c.at.ra) * cos, m.dec - c.at.dec) * 3600 < DETECTOR_ARCSEC);
  if (!already) addMark(c.at.ra, c.at.dec);
  sky.sector = c.sector ?? null;
  syncScrub();
  retrackMarks();
  renderMatrix();
  refreshKnownObjects();
}

/* ----------------------------------------------------------------- matrix */

/** The score at which a cell is drawn as fully lit. Above this it saturates. */
const MATRIX_TOP = 12;

/**
 * Sector against visit, lit where a sector stopped looking like itself.
 *
 * The row order follows the numbering on the frame, so cell and picture read
 * the same way round. Pressing a cell goes to that visit and lights that sector
 * on the picture, which is the only reason the matrix is worth drawing: it has
 * to hand you somewhere to look.
 */
/** A visit's date, short enough to stack ten of them down a margin. */
const dateLabel = (iso) => fmtDate(iso).replace(/\s*г\.?$/, '');

/**
 * Draw the grid into a target at a given cell size.
 *
 * The cell size is a parameter rather than a constant so the grid can be
 * drawn to whatever width the band has, without the labels growing with it.
 */
/**
 * What the run has to say about the sectors, in words.
 *
 * The grid itself is drawn inside the strip, under the frame each column
 * belongs to; all that is left here is the sentence above it and the note about
 * what its axes are.
 */
function renderMatrix() {
  const visits = sky?.visits ?? [];
  const ready = !!state.sectors && visits.length >= 3;
  $('matrix-found').hidden = !ready;
  $('matrix-lead').hidden = !ready;
  drawAxis();
  if (!ready) return;

  $('matrix-lead').textContent = t('matrix.lead', { n: SECTOR_COUNT });
  const hits = standouts(state.sectors, { limit: Infinity });
  const said = hits.length
    ? t('matrix.found', { n: hits.length, sector: hits[0].sector })
    : t('matrix.calm');
  // Scored from the visits in hand; the norm each sector is judged against can
  // still move when the rest arrive, so the line says it is provisional.
  const total = state.visits.filter((v) => v.status !== 'dropped').length;
  // The sentence's own full stop comes off before the qualifier, or it reads
  // "sector 14. · so far".
  $('matrix-found').textContent = state.loading
    ? `${said.replace(/\.$/, '')} · ${t('matrix.partial', { done: visits.length, total })}`
    : said;
  $('matrix-found').dataset.calm = String(hits.length === 0);
}

/** Go to that visit, and light that sector on the picture. */
function pickCell(sector, visit) {
  stopPlayback();
  selectMode('single');
  sky.sector = sector;
  sky.setIndex(visit);
  syncScrub();
  renderMatrix();
}

function measureSectors(sigmas, { final = true } = {}) {
  const visits = sky?.visits ?? [];
  state.sectors = visits.length >= 3 ? scoreSectors(visits, { sigmas }) : null;
  state.candidates = null;
  renderMatrix();
  renderHunt();
  renderVerdict();
  // The search the project is named for ran only when pressed, which left the
  // findings column empty on arrival and made the headline feature a button
  // with no reason to press it. It runs once the last visit is in, because
  // that is when it can.
  if (final && state.sectors) huntField();
}

/* ------------------------------------------------------------------ depth */

const EXAMINED_KEY = 'muninn.examined';

/** Fields looked at before, so the coverage is a record and not a session. */
function loadExamined() {
  try {
    const raw = JSON.parse(localStorage.getItem(EXAMINED_KEY) ?? '[]');
    state.examined = Array.isArray(raw) ? raw.filter((f) => Number.isFinite(f?.ra)) : [];
  } catch {
    state.examined = [];
  }
}

function rememberExamined(entry) {
  const cos = Math.cos((entry.dec * Math.PI) / 180);
  const near = state.examined.findIndex(
    (f) => Math.hypot(deltaRA(f.ra, entry.ra) * cos, f.dec - entry.dec) < 0.05,
  );
  // Looking at the same field again replaces the record rather than counting
  // the area twice; the deeper look is the one that stands.
  if (near >= 0) {
    if ((state.examined[near].depth ?? -99) >= (entry.depth ?? -99)) return;
    state.examined[near] = entry;
  } else {
    state.examined.push(entry);
  }
  try { localStorage.setItem(EXAMINED_KEY, JSON.stringify(state.examined.slice(-500))); } catch { /* private window */ }
}

/**
 * How faint this field could have shown a point source, measured from the sky
 * noise of the frames actually on screen.
 */
function measureDepth({ final = true } = {}) {
  const per = [];
  const sigmas = [];
  for (const v of sky?.visits ?? []) {
    // Measured once per visit: this now runs every time another visit lands.
    if (v.sigma === undefined) v.sigma = v.stamp.sigma !== undefined ? v.stamp.sigma : skySigma(v.stamp.data);
    const { sigma } = v;
    sigmas.push(sigma ?? 0);
    // The depth is quoted from the detector's own pixels (see stamp.js); the
    // grid's noise stays the floor for the sector scores, which live on the grid.
    // No fallback to the grid's noise: it reads about a third low and would
    // pull the median deep. A visit without a detector figure is left out.
    const detector = v.stamp.meta?.detectorSigma;
    if (detector > 0) per.push({ band: v.frame.band, sigma: detector });
  }
  state.depth = per.length ? stackDepth(per) : null;
  measureSectors(sigmas, { final });
  if (final && state.depth && sky?.grid) {
    // Recorded at the depth the search actually worked at — one visit — since
    // nothing here coadds the visits before looking.
    rememberExamined({
      ra: state.ra, dec: state.dec,
      depth: Number(state.depth.single.toFixed(2)),
      n: state.depth.n, band: state.depth.band,
      area: Number((sky.grid.fovDeg * sky.grid.fovHeightDeg).toFixed(4)),
      at: new Date().toISOString().slice(0, 10),
    });
  }
  renderDepth();
}

function renderDepth() {
  const box = $('depth');
  const d = state.depth;
  box.hidden = !d;
  renderFacts();
  renderVerdict();
  if (d) {
    // One visit is what every detection here is made in — marks, sectors,
    // flashes and Hunter X all measure visit by visit — so that is the depth
    // the search reached. The √N stack is what coadding would buy, and is
    // said as that, not as a reach.
    $('depth-mag').textContent = fmt(d.single, 1);
    $('depth-band').textContent = t('depth.singleShort', { band: d.band });
    $('depth-said').textContent = t('depth.said');

    const s = shortfall(d.single);
    const reach = s && s.magnitudes > 0
      ? t('depth.reach', { gap: fmt(s.magnitudes, 1), factor: Math.round(s.fluxFactor) })
      : '';
    const stack = d.n > 1 ? t('depth.stackNote', { n: d.n, band: d.band, mag: fmt(d.stacked, 1) }) : '';
    $('depth-reach').textContent = [reach, stack].filter(Boolean).join(' ');
    drawDepthScale($('depth-scale'), d.single);
    renderCovered();
  }

}

/**
 * The record the search keeps: every field examined in this browser and the
 * sky they cover. A null result over a stated area at a stated depth is a
 * constraint; kept in localStorage and never shown, it was not one.
 */
function renderCovered() {
  const el = $('depth-covered');
  const list = state.examined ?? [];
  el.hidden = !list.length;
  const area = list.reduce((sum, f) => sum + (Number(f.area) || 0), 0);
  el.textContent = list.length ? t('depth.covered', { n: list.length, area: fmt(area, 2) }) : '';
}

/**
 * How deep the field went, on the magnitude line, against where Planet X is
 * predicted to be. Brighter is to the left, as it is on every magnitude axis
 * an astronomer reads. The scale starts a little above the reach so the bar is
 * never a sliver, and ends past the faint edge of the prediction.
 */
function drawDepthScale(svg, reached) {
  const W = 260;
  const H = 54;
  const lo = Math.min(14, Math.floor(reached) - 2);
  const hi = PLANET_NINE_V.faint + 1;
  const x = (m) => 1 + ((m - lo) / (hi - lo)) * (W - 2);
  const barY = 22;
  const barH = 6;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const add = (tag, attrs, text) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    svg.append(el);
    return el;
  };
  const title = t('depth.scale', {
    mag: fmt(reached, 1), lo: fmt(PLANET_NINE_V.bright, 0), hi: fmt(PLANET_NINE_V.faint, 0),
  });
  add('title', {}, title);
  svg.setAttribute('aria-label', title);

  // The line, and how far along it this field saw.
  add('rect', { x: x(lo), y: barY, width: x(hi) - x(lo), height: barH, rx: 3, class: 'depth__track' });
  add('rect', { x: x(lo), y: barY, width: Math.max(0, x(reached) - x(lo)), height: barH, rx: 3, class: 'depth__reached' });
  add('line', { x1: x(reached), x2: x(reached), y1: barY - 5, y2: barY + barH + 5, class: 'depth__pin' });

  // Where the prediction sits: a band, edged at its bright end, which is the
  // end a search has to reach first.
  const tx0 = x(PLANET_NINE_V.bright);
  const tx1 = x(PLANET_NINE_V.faint);
  add('rect', { x: tx0, y: barY, width: tx1 - tx0, height: barH, rx: 3, class: 'depth__target' });
  add('line', { x1: tx0, x2: tx0, y1: barY - 5, y2: barY + barH + 5, class: 'depth__target-edge' });

  // Labels over the two things being compared, and the magnitudes under them.
  const here = add('text', { x: x(reached), y: barY - 9, 'text-anchor': 'middle', class: 'depth__label depth__label--here' }, t('depth.here'));
  const there = add('text', { x: (tx0 + tx1) / 2, y: barY - 9, 'text-anchor': 'middle', class: 'depth__label depth__label--target' }, t('depth.target'));
  // Kept apart when the reach is close to the prediction.
  if (Math.abs(x(reached) - (tx0 + tx1) / 2) < 70) {
    here.setAttribute('text-anchor', 'end');
    here.setAttribute('x', x(reached) - 4);
    there.setAttribute('text-anchor', 'start');
    there.setAttribute('x', tx0 + 4);
  }
  for (let m = Math.ceil(lo / 2) * 2; m <= hi; m += 2) {
    add('line', { x1: x(m), x2: x(m), y1: barY + barH + 2, y2: barY + barH + 6, class: 'depth__tick' });
    add('text', { x: x(m), y: H - 4, 'text-anchor': 'middle', class: 'depth__axis' }, String(m));
  }
}

/* ====================================================================== run */

/**
 * The whole run, drawn as one object.
 *
 * Replaces four controls — the timeline, the two step arrows' captions, the
 * visit counter and the column of sector cells — with a single strip in which
 * each of those jobs is done next to the others. The map of what changed now
 * sits directly under the frame it changed in.
 */
let runHits = [];
/** The run's height the last time it was on screen, for a room measured while it is not. */
let runHeight = 230;
let runHover = -1;

/** The palette the strip draws with. Read when the theme could have moved. */
let runPaint = null;

function readRunPaint() {
  const css = getComputedStyle(document.documentElement);
  const get = (token, fallback) => css.getPropertyValue(token).trim() || fallback;
  runPaint = {
    well: get('--color-well', '#05080e'),
    rule: get('--color-rule', '#2a3a4e'),
    ruleSoft: get('--rec-tick', '#3a4a5e'),
    accent: get('--color-accent', '#6cc4f0'),
    ink: get('--color-ink', '#e9f1f7'),
    faint: get('--color-rule-strong', '#5a6a7e'),
    // Text on the run is read, so it takes the text token (6.3:1), not the
    // boundary one the lines use (3.2:1).
    label: get('--color-neutral', '#8a9aae'),
  };
}

function drawAxis() {
  const box = $('run');
  const visits = sky?.visits ?? [];
  // Every visit the field will have, from the moment the index says so: its
  // date is known before its pixels are, so the lane is drawn whole at once
  // and the frames fill their places as they land, instead of the row
  // reshuffling each time one arrives.
  let slots = state.visits
    .filter((e) => e.status !== 'dropped')
    .map((e) => {
      const at = visits.findIndex((v) => v.frame === e.frame);
      return { frame: e.frame, visit: visits[at] ?? null, at, status: e.status, landedAt: e.landedAt };
    })
    .sort((p, q) => p.frame.mjd - q.frame.mjd);
  // While the archive is still being asked, the run is already there, as
  // empty places: it used to vanish at every new field, and on the way in
  // from the sky it was missing until the index answered, and either way it
  // arrived a second late and moved the whole page.
  if (slots.length < 2 && state.loading) {
    slots = Array.from({ length: runSlots || MAX_VISITS }, () => ({ frame: null, visit: null, at: -1, status: 'pending' }));
  }
  // Shown as soon as there is a run to show, before any of its pixels: the page
  // takes its final shape once, instead of again when the first frame lands.
  box.hidden = slots.length < 2;
  if (box.hidden) { runHits = []; return; }
  if (slots.some((s) => s.frame)) runSlots = slots.length;
  if (!runPaint) readRunPaint();

  const shown = sky.indexed ? sky.index : sky.a;
  runHits = drawStrip($('run-canvas'), {
    slots,
    sectors: state.sectors,
    index: shown,
    hover: runHover,
    lang: getLanguage(),
    paint: runPaint,
    now: performance.now(),
    motion: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
  runHeight = box.offsetHeight || runHeight;
  animateRun(slots);
}

/** How many places the last run had, so the empty one keeps its width. */
let runSlots = 0;
let runFrame = 0;

/**
 * Keeps the run moving while it has something in flight: frames being read
 * (their read line) or frames just landed (laid in from the top). Thirty
 * frames a second, and nothing at all once the field is in.
 */
function animateRun(slots) {
  if (runFrame || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const now = performance.now();
  const busy = slots.some((s) => s.status === 'reading' || !s.frame)
    || slots.some((s) => s.landedAt && now - s.landedAt < 460);
  if (!busy) return;
  runFrame = setTimeout(() => {
    runFrame = 0;
    requestAnimationFrame(() => { if (!$('run').hidden) drawAxis(); });
  }, 33);
}

/**
 * What a point on the run lands on: a lit sector cell if there is one there,
 * otherwise the frame whose column it is in, otherwise null.
 */
function runHitAt(ev) {
  const c = $('run-canvas');
  const r = c.getBoundingClientRect();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top;
  const inside = (h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
  return runHits.find((h) => h.sector && inside(h))
    ?? runHits.find((h) => !h.sector && inside(h))
    ?? null;
}

/** Which frame of the run a point lands on, or -1. */
function runAt(ev) {
  return runHitAt(ev)?.i ?? -1;
}


function syncScrub() {
  const el = $('scrub');
  const list = sky?.visits ?? [];
  el.disabled = list.length < 2;
  if (list.length) {
    const lo = list[0].frame.mjd;
    const hi = list[list.length - 1].frame.mjd;
    el.min = String(lo);
    el.max = String(hi === lo ? lo + 1 : hi);
    el.step = String(Math.max((hi - lo) / 2000, 1e-6));
    const shown = sky.indexed ? sky.index : sky.a;
    if (list[shown]) el.value = String(list[shown].frame.mjd);
  }
  drawAxis();
  renderWhen();
  updateReadout();
  describeCanvas();
  updateIdentity();
  fillSlots();
  // The stack's line carries the season's own numbers, which change with it.
  if (sky?.mode === 'stack') refreshStack();
}

/** The A/B pickers — one line, instead of two buttons on every visit. */
function fillSlots() {
  const list = sky?.visits ?? [];
  for (const [id, current] of [['slot-a', sky?.a ?? 0], ['slot-b', sky?.b ?? 0]]) {
    const sel = $(id);
    const signature = list.map((v) => v.frame.obsId).join('|') + getLanguage();
    if (sel.dataset.signature !== signature) {
      sel.replaceChildren();
      list.forEach((v, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `${fmtDate(v.frame.iso)} · ${v.frame.band}`;
        sel.append(opt);
      });
      sel.dataset.signature = signature;
    }
    sel.value = String(current);
    sel.disabled = list.length < 2;
  }
}

/* ------------------------------------------------------------------ playback */

function stopPlayback() {
  state.playing = false;
  clearInterval(state.timer);
  state.timer = null;
  document.body.dataset.playing = 'false';
  $('play').setAttribute('aria-label', t('play.play'));
}

function startPlayback() {
  if (!sky || sky.visits.length < 2) return;
  state.playing = true;
  document.body.dataset.playing = 'true';
  $('play').setAttribute('aria-label', t('play.pause'));
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    sky.setIndex(sky.index + 1);
    syncScrub();
    refreshKnownObjects();
  }, 1000 / state.rate);
}

/*
 * Blink and single frame are one switch with two positions: the visits running,
 * or one visit held still. They used to be separate from the play key, so
 * "single frame" could be playing and "blink" could be standing still — two
 * names for the same picture, and nobody could say what the difference was.
 * Now whatever the user does to one moves the other: play is blink, a step or a
 * pause is a single frame. stopPlayback and startPlayback stay bare for the
 * code's own pauses (a theme change, a new field), which should leave the
 * choice alone.
 */
function selectMode(mode) {
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (radio && !radio.checked) radio.checked = true;
  if (sky.mode !== mode) applyMode(mode);
}

/** The user wants the visits to run. */
function playBlink() {
  if (!sky || sky.visits.length < 2) return;
  selectMode('blink');
  if (!state.playing) startPlayback();
}

/** The user stopped on one visit: that is the single frame. */
function holdStill() {
  stopPlayback();
  if (sky.mode === 'blink') selectMode('single');
}

const togglePlayback = () => (state.playing ? holdStill() : playBlink());

/**
 * The date above the frame, the waveband beside it, and where each step goes.
 *
 * A step button that says only "previous" is a guess; one that says "previous ·
 * 19 Jul 2025" is an answer, and at the ends of the run it can say that there
 * is nothing there by going quiet rather than by doing nothing when pressed.
 */
function renderWhen() {
  const list = sky?.visits ?? [];
  const shown = sky?.current;
  const frame = shown?.frame;
  const i = list.indexOf(shown);

  // A stack is a season, so it is dated as one, and the steps go by season.
  if (sky?.mode === 'stack' && frame) {
    const season = sky.stackMembers().map((m) => m.frame);
    const first = season[0];
    const last = season[season.length - 1];
    // Days on the big line, the year or years on the small one where a
    // single visit keeps its time: the range fits the column without breaking.
    const y0 = first.iso.slice(0, 4);
    const y1 = last.iso.slice(0, 4);
    const sameMonth = first.iso.slice(0, 7) === last.iso.slice(0, 7);
    $('when-date').textContent = first === last ? fmtDay(first.iso)
      : sameMonth ? `${fmtDay(first.iso).split(' ')[0]}–${fmtDay(last.iso)}`
        : `${fmtDay(first.iso)} – ${fmtDay(last.iso)}`;
    // Two months do not fit the column at the date's own size; one line, smaller.
    $('when-date').dataset.range = String(!sameMonth);
    $('when-time').textContent = y0 === y1 ? y0 : `${y0} – ${y1}`;
    $('when-band').textContent = `${frame.band} · ${fmt(frame.emMin, 2)}–${fmt(frame.emMax, 2)} µm`;
    $('when-of').textContent = t('frame.stack', { n: season.length });
    for (const [id, dir] of [['prev', -1], ['next', 1]]) {
      const k = stackStep(dir);
      $(id).disabled = k === i;
      $(`${id}-date`).textContent = k === i ? '' : fmtDay(list[k].frame.iso);
    }
    return;
  }

  $('when-date').textContent = frame ? fmtDate(frame.iso).replace(/\s*г\.?$/, '') : '—';
  $('when-date').dataset.range = 'false';
  $('when-time').textContent = frame ? fmtTime(frame.iso) : '';
  $('when-band').textContent = frame ? `${frame.band} · ${fmt(frame.emMin, 2)}–${fmt(frame.emMax, 2)} µm` : '';
  $('when-of').textContent = i >= 0 && list.length
    ? t('frame.visit', { i: i + 1, n: list.length })
    : '';

  for (const [id, at] of [['prev', i - 1], ['next', i + 1]]) {
    $(id).disabled = !list[at];
    $(`${id}-date`).textContent = list[at] ? fmtDay(list[at].frame.iso) : '';
  }
}

/* ------------------------------------------------------------------- readout */

function updateReadout(sample) {
  const shown = sky?.current;
  const frame = shown?.frame;
  $('ro-lambda').textContent = frame ? `${fmt(frame.emMin, 2)}–${fmt(frame.emMax, 2)} µm` : '—';
  $('ro-obs').textContent = frame ? `${fmtDate(frame.iso)} ${fmtTime(frame.iso)}` : '—';

  if (sample) {
    $('cursor-hint').hidden = true;
    $('ro-cursor').textContent = `${formatRA(sample.ra)} ${formatDec(sample.dec)}`;
    $('ro-value').textContent = sample.value == null ? t('readout.noValue') : `${fmt(sample.value, 3)} MJy/sr`;
  } else if (!sky?.hover) {
    $('cursor-hint').hidden = false;
    $('ro-cursor').textContent = '—';
    $('ro-value').textContent = '—';
  }

  const link = $('open-irsa');
  if (frame) { link.href = frame.url; link.removeAttribute('aria-disabled'); }
  else { link.href = '#'; link.setAttribute('aria-disabled', 'true'); }
}

/* -------------------------------------------------------------- solar system */

/*
 * What SkyBoT has been asked, visit by visit (by obsId). The answers themselves
 * live in sky.knownObjects; these hold the questions still out and the ones that
 * failed. Without them "no match" was said wherever no answer had arrived yet —
 * for the first minute of every field, and for good wherever SkyBoT timed out.
 */
let skybot = { asking: new Set(), failed: new Set() };

const skybotOn = () => $('ov-skybot').checked;

/** How many distinct catalogued objects pass through the field across all visits. */
function reportKnownObjects() {
  const names = new Set();
  for (const objects of sky.knownObjects.values()) {
    for (const o of objects) names.add(o.num ? `(${o.num})` : o.name);
  }
  const v = sky.current;
  $('skybot-note').textContent = !skybotOn()
    ? ''
    : v && skybot.failed.has(v.frame.obsId)
      ? t('overlay.skybotFail')
      : names.size
        ? t('overlay.skybotCount', { n: names.size })
        : skybot.asking.size ? t('overlay.skybotBusy') : t('overlay.skybotNone');
  state.bodies = names.size;
  renderFacts();
}

/** Ask SkyBoT about one visit, once; a failure is remembered, not retried in a loop. */
async function askSkybot(v, signal) {
  const id = v.frame.obsId;
  if (sky.knownObjects.has(id) || skybot.asking.has(id)) return;
  const asked = skybot;
  asked.asking.add(id);
  asked.failed.delete(id);
  try {
    // Asked for the middle of the exposure, where the photons were on average;
    // the index's time is its start, a minute earlier.
    const { mjd, exptime } = v.frame;
    const mid = exptime > 0
      ? new Date((mjd + exptime / 2 / 86400 - 40587) * 86400000).toISOString().replace('Z', '')
      : v.frame.iso;
    const objects = await skybotCone({
      ra: state.ra, dec: state.dec,
      radiusDeg: Math.max(0.03, (sky.grid?.spanDeg ?? state.fov) * 0.8), iso: mid,
    }, { signal });
    if (!signal?.aborted && asked === skybot) sky.setKnownObjects(id, objects);
  } catch {
    if (!signal?.aborted) asked.failed.add(id);
  } finally {
    asked.asking.delete(id);
  }
  if (!signal?.aborted && asked === skybot) catalogChanged();
}

/**
 * Ask SkyBoT about every loaded visit, not just the one on screen, so a mark can
 * be matched in whichever visit it was actually detected. Two at a time; SkyBoT
 * is somebody else's courtesy service. The visit on screen goes first.
 */
async function prefetchKnownObjects(signal) {
  if (!skybotOn()) return;
  const shown = sky.current;
  const pending = sky.visits
    .filter((v) => !sky.knownObjects.has(v.frame.obsId))
    .sort((a, b) => (b === shown) - (a === shown));
  await pool(pending, SKYBOT_CONCURRENCY, (v) => (signal?.aborted ? null : askSkybot(v, signal)));
}

async function refreshKnownObjects() {
  if (!skybotOn()) { reportKnownObjects(); return; }
  const v = sky.current;
  if (!v) return;
  reportKnownObjects();
  if (!sky.knownObjects.has(v.frame.obsId)) await askSkybot(v, state.abort?.signal);
}

/** An answer came in, or failed to: everything that quotes SkyBoT says so again. */
function catalogChanged() {
  reportKnownObjects();
  nameMarks();
  renderMarks();
  renderHunt();
  sky.draw();
}

/**
 * How far a SkyBoT position may sit from a measured one and still be the same
 * body: two detector pixels, since that is how well a SPHEREx position is
 * known, plus whatever SkyBoT says its own position may be off by.
 */
const matchArcsec = (o) => 2 * DETECTOR_ARCSEC + (Number.isFinite(o.err) ? Math.min(o.err, 60) : 0);

/**
 * What SkyBoT says about something seen at these places, in these visits.
 * `seen` is [{ ra, dec, obsId }] — where it was measured and when. Only visits
 * where it was actually measured are asked about: a known asteroid passing the
 * same spot on another night is not this thing.
 *
 * `match` when any answered visit has a body there; otherwise `waiting`
 * while any is still out, `none` once they have answered, `failed` or `off`
 * when none could be asked.
 *
 * A match names the visit it was made in, and `unmatched` lists the answered
 * visits where the same spot had nothing catalogued. The Atala field is the
 * case: the centre flashes on 6 Jul and on 25 Dec, the asteroid explains only
 * the second, and a bare "In SkyBoT: Atala" quietly explained away the first.
 */
function skybotVerdict(seen) {
  let waiting = 0;
  let asked = 0;
  let off = 0;
  let match = null;
  const unmatched = [];
  for (const p of seen) {
    const objects = sky.knownObjects.get(p.obsId);
    if (!objects) {
      if (skybot.failed.has(p.obsId)) continue;
      if (skybotOn()) waiting += 1; else off += 1;
      continue;
    }
    asked += 1;
    const o = objects.find((x) => separation(p.ra, p.dec, x.ra, x.dec) * 3600 <= matchArcsec(x));
    if (!o) { unmatched.push(p.obsId); continue; }
    match ??= { state: 'match', name: o.num ? `(${o.num}) ${o.name}` : o.name, object: o, obsId: p.obsId };
  }
  if (match) return { ...match, unmatched };
  if (waiting) return { state: 'waiting' };
  if (asked) return { state: 'none' };
  return { state: off ? 'off' : 'failed' };
}

/** The date of a loaded visit, by its observation id. */
const visitDate = (obsId) => {
  const v = sky.visits.find((x) => x.frame.obsId === obsId);
  return v ? fmtDate(v.frame.iso) : '—';
};

/** The places a tracked thing was seen, as skybotVerdict wants them. */
function seenAt(analysis, fallback) {
  const track = analysis?.track ?? [];
  if (track.length) return track.map((p) => ({ ra: p.ra, dec: p.dec, obsId: p.obsId }));
  return fallback?.obsId ? [fallback] : [];
}

/** The line a mark or a candidate shows for its SkyBoT check. */
function skybotLine(verdict, { none = 'mark.unknown' } = {}) {
  switch (verdict?.state) {
    case 'match':
      return verdict.unmatched?.length
        ? t('mark.knownPartly', {
          name: verdict.name,
          when: visitDate(verdict.obsId),
          others: verdict.unmatched.map(visitDate).join(', '),
        })
        : t('mark.known', { name: verdict.name });
    case 'none': return t(none);
    case 'failed': return t('mark.skybotFailed');
    case 'off': return t('mark.skybotOff');
    default: return t('mark.skybotWaiting');
  }
}

/**
 * For styling: a name is quiet, "none" is the interesting case, the rest are
 * pending. A name that explains only some of the visits is still interesting.
 */
const skybotTone = (verdict) => {
  if (verdict?.state === 'match') return verdict.unmatched?.length ? 'false' : 'true';
  return verdict?.state === 'none' ? 'false' : 'wait';
};

/* ------------------------------------------------------------------- marks */

/** A new mark, remembering which visit was on screen when it was dropped. */
function addMark(ra, dec) {
  sky.marks.push({ ra, dec, obsId: sky.current?.frame.obsId ?? null, track: [], analysis: null, known: null });
}

function retrackMarks() {
  for (const m of sky.marks) {
    const analysis = sky.trackMark(m.ra, m.dec);
    m.analysis = analysis;
    m.track = analysis.track;
  }
  nameMarks();
  sky.draw();
  renderMarks();
}

/** Match every mark against SkyBoT's answers so far, and ask who the still ones are. */
function nameMarks() {
  for (const m of sky.marks) {
    m.catalog = skybotVerdict(seenAt(m.analysis, { ra: m.ra, dec: m.dec, obsId: m.obsId }));
    // A body that explains some of the visits leaves the others unexplained,
    // and the picture must not draw the mark as accounted for.
    m.known = m.catalog.state === 'match' && !m.catalog.unmatched?.length ? m.catalog.name : null;
    identifyMark(m);
    m.tag = tagOf(m);
  }
}

/**
 * The few words a mark carries on the picture beside its number: the body's
 * name if SkyBoT has one, the catalogue name of a star if one was found, and
 * otherwise what the measurement says it is.
 */
function tagOf(m) {
  if (m.known) return m.known;
  const r = m.who?.state === 'done' ? m.who.result : null;
  if (r?.simbad) return shortName(r.simbad.name);
  if (r?.vsx) return r.vsx.name;
  if (r?.gaia && Number.isFinite(r.gaia.mag)) return `G ${fmt(r.gaia.mag, 1)}ᵐ`;
  return m.analysis ? callOf(m.analysis) : null;
}

/**
 * Who a mark is, when it is not an asteroid.
 *
 * A source that sits still in every visit cannot be a solar-system body, so it
 * is asked about at once. One that comes and goes might still be an asteroid,
 * and asking a star catalogue about it first would name whatever faint star
 * happens to lie near its path — so it waits until SkyBoT has said no.
 */
const IDENTIFY = new Set(['fixed', 'intermittent', 'transient']);

function identifyMark(m) {
  const a = m.analysis;
  const ready = a && IDENTIFY.has(a.kind)
    && (a.kind === 'fixed' || ['none', 'failed', 'off'].includes(m.catalog?.state));
  if (!ready) { m.who = null; return; }

  // The measured centre, not the click: that is what a catalogue should be asked about.
  const pts = a.track.length ? a.track : [{ ra: m.ra, dec: m.dec }];
  // Averaged as offsets from the first point, so a spot on the 0h meridian
  // (359.999° and 0.001°) averages to itself and not to 180°.
  const ra0 = pts[0].ra;
  const meanRA = ra0 + pts.reduce((s, p) => s + deltaRA(p.ra, ra0), 0) / pts.length;
  const at = {
    ra: ((meanRA % 360) + 360) % 360,
    dec: pts.reduce((s, p) => s + p.dec, 0) / pts.length,
  };
  const key = `${at.ra.toFixed(5)} ${at.dec.toFixed(5)}`;
  if (m.who?.key === key) return;
  m.who = { key, state: 'asking' };
  const signal = state.abort?.signal;
  identifySource(at, { signal })
    .then((result) => { if (m.who?.key === key) m.who = { key, state: 'done', result }; })
    .catch(() => { if (m.who?.key === key && !signal?.aborted) m.who = { key, state: 'failed' }; })
    .finally(() => {
      if (!sky.marks.includes(m)) return;
      m.tag = tagOf(m);
      sky.draw();
      renderMarks();
    });
}

const CATALOGUE_NAMES = { simbad: 'SIMBAD', gaia: 'Gaia', tmass: '2MASS', wise: 'AllWISE', vsx: 'VSX' };

function link(text, href) {
  const a = document.createElement('a');
  a.className = 'mark__who-name';
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  a.href = href;
  return a;
}

function whoP(...parts) {
  const p = document.createElement('p');
  p.className = 'mark__who';
  p.append(...parts);
  return p;
}

/** What Gaia's classifier makes of a source, when it is sure enough to say. */
function gaiaKind(g) {
  if (g.pGalaxy >= 0.5) return t('kind.galaxy');
  if (g.pQuasar >= 0.5) return t('kind.quasar');
  if (g.pStar >= 0.9) return t('kind.star');
  return t('kind.gaia');
}

/**
 * What the catalogues said about a mark, a line per question: who it is, does
 * it vary, what it looks like in the near infrared SPHEREx sees, how far away.
 * A line appears only when a catalogue had something to say.
 */
function whoLines(who, kind) {
  if (who.state === 'asking') return [whoP(t('mark.whoAsking'))];
  if (who.state === 'failed') return [whoP(t('mark.whoFailed'))];
  const r = who.result;
  const lines = [];
  // Beyond a couple of arcsec the name is a neighbour's, and it should say so.
  const off = (sep) => (sep > 2 ? `, ${t('mark.whoSep', { sep: fmt(sep, 1) })}` : '');

  if (r.simbad) {
    const s = r.simbad;
    const what = s.family ? t(`kind.${s.family}`) : t('kind.other', { code: s.otype });
    const mag = Number.isFinite(s.mag) ? `, ${s.magBand} ${fmt(s.mag, 1)}ᵐ` : '';
    lines.push(whoP(`${t('mark.whoSimbad')} `,
      link(s.name, `https://simbad.cds.unistra.fr/simbad/sim-id?Ident=${encodeURIComponent(s.name)}`),
      ` — ${what}${mag}${off(s.sep)}`));
  } else if (r.gaia) {
    const g = r.gaia;
    const mag = Number.isFinite(g.mag) ? `, G ${fmt(g.mag, 1)}ᵐ` : '';
    lines.push(whoP(`${t('mark.whoGaia')} `,
      link(g.id, `https://vizier.cds.unistra.fr/viz-bin/VizieR-4?-source=I/355/gaiadr3&Source=${encodeURIComponent(g.id)}`),
      ` — ${gaiaKind(g)}${mag}${off(g.sep)}`));
  }

  // Does it vary? For something that comes and goes, the first question.
  if (r.vsx) {
    const v = r.vsx;
    const bits = [v.type ? `${t('kind.variable')} ${v.type}` : t('kind.variable')];
    if (Number.isFinite(v.max) && Number.isFinite(v.min)) bits.push(`${fmt(v.max, 2)}–${fmt(v.min, 2)}ᵐ`);
    if (Number.isFinite(v.period)) bits.push(t('mark.whoPeriod', { p: fmt(v.period, v.period < 10 ? 3 : 1) }));
    lines.push(whoP('VSX: ',
      link(v.name, `https://www.aavso.org/vsx/index.php?view=results.get&ident=${encodeURIComponent(v.name)}`),
      ` — ${bits.join(', ')}`));
  } else if (r.gaia?.variable) {
    lines.push(whoP(t('mark.whoGaiaVar')));
  } else if ((kind === 'intermittent' || kind === 'transient') && r.any && !r.failed.includes('vsx') && !r.failed.includes('gaia')) {
    lines.push(whoP(t('mark.whoNotVar')));
  }

  // The near infrared, which is what SPHEREx itself sees.
  const phot = [];
  if (r.tmass) {
    for (const [band, v] of [['J', r.tmass.j], ['H', r.tmass.h], ['K', r.tmass.k]]) {
      if (Number.isFinite(v)) phot.push(`${band} ${fmt(v, 1)}`);
    }
  }
  if (r.wise) {
    if (Number.isFinite(r.wise.w1)) phot.push(`W1 ${fmt(r.wise.w1, 1)}`);
    if (Number.isFinite(r.wise.w2)) phot.push(`W2 ${fmt(r.wise.w2, 1)}`);
  }
  if (phot.length) {
    const p = whoP(`${[r.tmass && '2MASS', r.wise && 'AllWISE'].filter(Boolean).join(' · ')}: ${phot.join(' · ')}`);
    p.classList.add('mark__phot');
    lines.push(p);
  }

  // A distance, only where the parallax is measured and not merely returned.
  const g = r.gaia;
  if (g && g.plx > 0 && g.plxErr > 0 && g.plx / g.plxErr >= 5) {
    const pc = 1000 / g.plx;
    lines.push(whoP(t('mark.whoPlx', { plx: fmt(g.plx, 2), pc: fmt(pc, pc < 100 ? 1 : 0) })));
  }

  if (!lines.length) lines.push(whoP(t('mark.whoNone')));
  if (r.failed.length) lines.push(whoP(t('mark.whoPartial', { list: r.failed.map((k) => CATALOGUE_NAMES[k]).join(', ') })));
  return lines;
}

/* ----------------------------------------------------------- on the picture */

/** SIMBAD's notable objects in the field, once per field, for the picture. */
async function loadFieldCatalog(signal) {
  if (!$('ov-catalog').checked || !sky.grid) return;
  try {
    const list = await fieldObjects({ ra: state.ra, dec: state.dec, radiusDeg: sky.grid.spanDeg * 0.75 }, { signal });
    if (!signal?.aborted) sky.setCatalog(list);
  } catch {
    /* The picture is complete without it; nothing to say. */
  }
}

const SSO_KINDS = {
  'Mars-Crosser': 'sso.marsCrosser', Hungaria: 'sso.hungaria', Trojan: 'sso.trojan', Centaur: 'sso.centaur',
  KBO: 'sso.tno', TNO: 'sso.tno', Comet: 'sso.comet', Planet: 'sso.planet', Satellite: 'sso.moon', NEA: 'sso.nea',
};
const MB_KINDS = { Inner: 'sso.mbInner', Middle: 'sso.mbMiddle', Outer: 'sso.mbOuter', Hilda: 'sso.hilda', Cybele: 'sso.cybele' };

/** SkyBoT's orbit class ("MB>Outer", "NEA>Apollo") in words. */
function ssoKind(cls) {
  const [head, sub] = String(cls ?? '').split('>');
  if (head === 'MB') return t(MB_KINDS[sub] ?? 'sso.mb');
  const key = SSO_KINDS[head];
  return key ? t(key) : cls || null;
}

/**
 * A small card over the picture for whatever the pointer is on: a SkyBoT body,
 * a catalogued object, a mark. The labels on the picture stay short so they
 * do not bury it; the card is where the rest goes, and only while it is asked for.
 */
function showTip(hit, x = 0, y = 0) {
  const tip = $('plate-tip');
  if (!tip) return;
  if (!hit) { tip.hidden = true; return; }
  const title = document.createElement('p');
  title.className = 'tip__title';
  const rows = [];
  const o = hit.item;
  if (hit.kind === 'skybot') {
    title.textContent = o.num ? `(${o.num}) ${o.name}` : o.name;
    const kind = ssoKind(o.cls);
    if (kind) rows.push(kind);
    const speed = Math.hypot(o.dRA, o.dDec);
    rows.push([
      Number.isFinite(o.mag) ? `V ${fmt(o.mag, 1)}ᵐ` : '',
      Number.isFinite(speed) ? t('overlay.rate', { rate: fmt(speed, speed < 10 ? 1 : 0) }) : '',
      Number.isFinite(o.dGeo) ? t('tip.fromEarth', { au: fmt(o.dGeo, 2) }) : '',
    ].filter(Boolean).join(' · '));
    rows.push(t('tip.skybot'));
  } else if (hit.kind === 'catalog') {
    title.textContent = shortName(o.name);
    rows.push(o.family ? t(`kind.${o.family}`) : t('kind.other', { code: o.otype }));
    if (Number.isFinite(o.mag)) rows.push(`${o.magBand} ${fmt(o.mag, 1)}ᵐ`);
    rows.push(t('tip.simbad'));
  } else {
    const m = o;
    title.textContent = `${t('tip.mark', { n: hit.n })} · ${callOf(m.analysis)}`;
    if (m.tag && m.tag !== callOf(m.analysis)) rows.push(m.tag);
    if (m.analysis) rows.push(verdict(m.analysis));
  }
  tip.replaceChildren(title, ...rows.filter(Boolean).map((text) => {
    const p = document.createElement('p');
    p.className = 'tip__row';
    p.textContent = text;
    return p;
  }));
  tip.hidden = false;
  // Beside the pointer, and flipped to the other side near an edge.
  const box = $('plate').getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = x + 16 + w > box.width - 8 ? x - 16 - w : x + 16;
  const top = y + 16 + h > box.height - 8 ? y - 16 - h : y + 16;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

/** One honest sentence about what the pixels support at a marked position. */
const CALL = {
  none: 'mark.callNone',
  transient: 'mark.callTransient',
  moving: 'mark.callMoving',
  fixed: 'mark.callFixed',
  intermittent: 'mark.callIntermittent',
};

/** What the measurement amounts to, in the fewest words that are still true. */
const callOf = (a) => t(CALL[a?.kind ?? 'none'] ?? CALL.none);

function verdict(a) {
  if (!a || a.kind === 'none') return t('mark.undetected', { total: a?.total ?? 0 });
  if (a.kind === 'transient') {
    return t('mark.transient', {
      date: fmtDate(mjdToDate(a.at.mjd).toISOString()),
      snr: fmt(a.at.snr, 0), rest: a.total - 1,
    });
  }
  if (a.kind === 'moving') {
    return t('mark.moving', { rate: fmt(a.ratePerHour, 2), seen: a.seen, days: fmt(a.spanDays, 1), rms: fmt(a.rms, 1) });
  }
  if (a.kind === 'fixed') return t('mark.fixed', { total: a.total, rms: fmt(a.rms, 1) });
  // Two points always fit a straight line perfectly, so quoting a scatter would be
  // a number with no information in it. Name the dates instead.
  if (a.seen <= 3) {
    const dates = a.track.map((p) => fmtDate(mjdToDate(p.mjd).toISOString())).join(', ');
    return t('mark.intermittentDates', { seen: a.seen, total: a.total, dates });
  }
  return t('mark.intermittent', { seen: a.seen, total: a.total, rms: fmt(a.rms, 1) });
}

/**
 * The light curve of a marked spot: one bar per visit, height by peak brightness,
 * a bare tick where nothing rose above the noise. Two spikes in a flat row is what
 * a mover looks like, and it reads faster as a shape than as a sentence.
 */
function markCurve(analysis) {
  const visits = sky.visits;
  if (!analysis || visits.length < 2) return null;
  const W = 208;
  const H = 46;
  const base = H - 13;
  const peakOf = new Map(analysis.track.map((d) => [d.obsId, d.peak]));
  const max = Math.max(...analysis.track.map((d) => d.peak), 1e-6);

  const mjds = visits.map((v) => v.frame.mjd);
  const lo = Math.min(...mjds);
  const span = (Math.max(...mjds) - lo) || 1;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'curve');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('mark.curve'));

  const add = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
    return el;
  };

  add('line', { x1: 4, y1: base, x2: W - 4, y2: base, class: 'curve__base' });
  for (const v of visits) {
    const x = 6 + ((v.frame.mjd - lo) / span) * (W - 12);
    const peak = peakOf.get(v.frame.obsId);
    if (peak == null) {
      add('rect', { x: x - 0.5, y: base, width: 1, height: 4, class: 'curve__miss' });
      continue;
    }
    // Square root keeps a faint detection visible next to a very bright one.
    const h = Math.max(2, Math.sqrt(peak / max) * (base - 6));
    add('rect', { x: x - 2, y: base - h, width: 4, height: h, rx: 1.5, class: 'curve__bar' });
  }
  return svg;
}

function renderMarks() {
  const ul = $('marks');
  ul.replaceChildren();
  // The explanation and the invitation are an empty state: once there is a mark
  // to read, the card's room belongs to the mark.
  const empty = sky.marks.length === 0;
  const canDemo = empty && sky.visits.length > 0;
  $('marks-count').textContent = empty ? '' : String(sky.marks.length);
  $('clear-marks').hidden = empty;
  $('mark-help').hidden = !empty;
  $('mark-centre').hidden = !canDemo;

  if (empty) {
    // "Nothing marked yet" sitting next to an invitation to mark something is a
    // line that tells you what you can already see.
    if (!canDemo) {
      const li = document.createElement('li');
      li.className = 'note note--dim';
      li.textContent = t('mark.none');
      ul.append(li);
    }
    return;
  }

  sky.marks.forEach((m, i) => {
    const li = document.createElement('li');
    li.className = 'mark';

    const n = document.createElement('span');
    n.className = 'mark__n';
    n.textContent = String(i + 1);

    const body = document.createElement('div');
    body.className = 'mark__body';

    // The class first, because that is the answer; the numbers that support it
    // underneath, because that is the evidence.
    const call = document.createElement('p');
    call.className = 'mark__call';
    call.dataset.kind = m.analysis?.kind ?? 'none';
    call.textContent = callOf(m.analysis);

    const detail = document.createElement('p');
    detail.className = 'mark__detail';
    detail.textContent = verdict(m.analysis);

    const id = document.createElement('p');
    id.className = 'mark__id';
    id.dataset.known = skybotTone(m.catalog);
    id.textContent = skybotLine(m.catalog);

    // A mark dropped on a SkyBoT ring where SPHEREx measured nothing is not
    // "nothing here" next to "in the catalogue" — read together those sound
    // like a contradiction. It is one finding: the orbit puts a body here and
    // it is too faint to show in a single visit.
    if (m.catalog?.state === 'match' && (m.analysis?.kind ?? 'none') === 'none') {
      const o = m.catalog.object;
      call.textContent = t('mark.callPredicted');
      call.dataset.kind = 'predicted';
      detail.textContent = Number.isFinite(o?.mag)
        ? t('mark.predicted', { name: m.catalog.name, mag: fmt(o.mag, 1), total: m.analysis?.total ?? 0 })
        : t('mark.predictedNoMag', { name: m.catalog.name, total: m.analysis?.total ?? 0 });
      id.textContent = t('mark.predictedWhy');
      id.dataset.known = 'true';
    }

    const pos = document.createElement('p');
    pos.className = 'mark__pos';
    pos.textContent = `${formatRA(m.ra)} ${formatDec(m.dec)}`;

    // A source that sits still in every visit is not a solar-system body, and
    // "no match in SkyBoT" under it only raised the question of why anyone
    // asked. What it is comes from the star catalogues instead.
    body.append(call, detail);
    if (m.analysis?.kind !== 'fixed') body.append(id);
    if (m.who) body.append(...whoLines(m.who, m.analysis?.kind));

    const curve = m.analysis?.seen ? markCurve(m.analysis) : null;
    if (curve) body.append(curve);

    if (m.analysis?.brightness && m.analysis.seen > 1) {
      const b = document.createElement('p');
      b.className = 'mark__detail';
      b.textContent = t('mark.brightness', {
        min: fmt(m.analysis.brightness.min, 2),
        max: fmt(m.analysis.brightness.max, 2),
        band: m.analysis.brightness.band,
      });
      body.append(b);
    }
    body.append(pos);

    const kill = document.createElement('button');
    kill.type = 'button';
    kill.className = 'mark__kill';
    kill.textContent = '×';
    kill.title = t('mark.remove');
    kill.setAttribute('aria-label', `${t('mark.remove')} ${i + 1}`);
    kill.addEventListener('click', () => { sky.marks.splice(i, 1); sky.draw(); renderMarks(); });

    li.append(n, body, kill);
    ul.append(li);
  });
}

/* ------------------------------------------------------------- opening a field */

/** A field wider than twice its height is a strip, and a strip hides what moves out of it. */
const MAX_ASPECT = 2;

/**
 * The shape the field should have: the room the plate has, once the label,
 * the steps and the filter wheel have taken their widths.
 *
 * A square field on a wide screen left a band of empty board either side of
 * the picture. More board around it could only be decoration; more sky is
 * more of the thing being searched. Stacked on a narrow screen there is no
 * spare width, and the field stays square.
 */
function roomAspect() {
  if (matchMedia('(max-width: 68rem), (max-height: 34rem)').matches) return 1;
  const room = document.querySelector('.room');
  const mount = document.querySelector('.mount');
  const cell = document.querySelector('.stage__cell');
  if (!room || !mount || !cell) return 1;
  const r = room.getBoundingClientRect();
  const chrome = mount.getBoundingClientRect().width - cell.getBoundingClientRect().width;
  const cs = getComputedStyle(mount);
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  // With the run folded away the room is taller than it will be once the
  // visits arrive; measure it as it will be.
  const under = $('run').hidden ? runHeight : 0;
  const w = r.width - chrome;
  const h = r.height - pad - under;
  if (!(w > 0 && h > 0)) return 1;
  return clamp(w / h, 1, MAX_ASPECT);
}

/**
 * The grid a field is resampled onto.
 *
 * The size control sets the short side — the height — and the width follows
 * the room. So "18′" still means eighteen arcminutes of sky whichever way you
 * measure the picture, and a wide screen shows more of it across, said in the
 * caption: 33′ × 18′, not a square stretched to fit. The earlier strip-shaped
 * field went wrong the other way: it kept the width and cut the height to
 * seven arcminutes, which is too little sky to follow anything through.
 */
function fieldGrid(ra, dec) {
  const h = Math.min(768, gridWidthFor(state.fov));
  const w = Math.min(GRID_MAX_W, Math.round(h * roomAspect()));
  const grid = new TangentGrid(ra, dec, (state.fov * w) / h, w, h);
  document.querySelector('.mount')?.style.setProperty('--aspect', String(w / h));
  return grid;
}

async function openField({ ra, dec, label = '', band = null }) {
  fieldSeq += 1;
  state.abort?.abort();
  const ctrl = new AbortController();
  state.abort = ctrl;

  stopPlayback();
  state.ra = ra;
  state.dec = dec;
  state.label = label;
  if (band) state.band = band;
  state.visits = [];
  state.truncated = false;
  // What the last field measured goes with it: the reading is now built up as
  // this field's visits land, and must not start from someone else's numbers.
  state.loading = true;
  state.failed = false;
  state.depth = null;
  state.sectors = null;
  state.candidates = null;
  writeHash();
  renderPresets();
  updateIdentity();

  // The field is cut to the room the plate has, and all of it is shown. See
  // fieldGrid for why its short side is the one the size control sets.
  let grid = fieldGrid(ra, dec);
  sky.reset(grid);
  // The mount names the frame on the plate; with none on it yet it must not
  // go on naming the last field's.
  renderWhen();
  sky.setCatalog([]);
  showTip(null);
  skybot = { asking: new Set(), failed: new Set() };
  stackPlanned = [];
  stackAsking = new Set();
  stackDropped = new Set();
  renderMarks();
  renderDepth();
  renderMatrix();
  renderHunt();
  $('skybot-note').textContent = '';
  state.bodies = 0;
  state.facts = null;
  renderFacts();
  renderVerdict();
  state.bytes = 0;
  renderBytes();
  setPlateState(t('epochs.searching'), { progress: 0 });
  drawAxis();

  let frames;
  let truncated = false;
  try {
    ({ frames, truncated } = await searchFrames({ ra, dec }, { signal: ctrl.signal }));
  } catch (err) {
    if (ctrl.signal.aborted) return;
    state.loading = false;
    state.failed = true;
    setPlateState(
      t(err instanceof NoRelayError ? 'epochs.noRelay' : err instanceof UpstreamError ? 'epochs.upstream' : 'epochs.failed'),
      { retry: !(err instanceof NoRelayError) },
    );
    renderVerdict();
    updateIdentity();
    drawAxis();
    return;
  }
  if (ctrl.signal.aborted) return;

  state.frames = frames;
  state.truncated = truncated;
  populateBands();

  const chosen = spread(groupVisits(frames, { ra, dec, band: state.band }), MAX_VISITS);
  state.visits = chosen.map((frame) => ({ frame, status: 'pending' }));
  drawAxis();
  // The run has just taken its place at the foot of the page, which changes the
  // room the plate has. If that changes the shape the field should be, it is cut
  // again now — before a single pixel has been read onto the old one.
  const refit = fieldGrid(ra, dec);
  if (Math.abs(refit.width / refit.height - grid.width / grid.height) > 0.03) {
    grid = refit;
    sky.reset(grid);
    skybot = { asking: new Set(), failed: new Set() };
    stackAsking = new Set();
    stackDropped = new Set();
    renderMarks();
  }
  updateIdentity();

  if (!chosen.length) { state.loading = false; setPlateState(t('epochs.none')); return; }
  setPlateState(t('epochs.loading', { done: 0, total: chosen.length }), { progress: 0 });

  let done = 0;
  let bytes = 0;
  await pool(state.visits, FETCH_CONCURRENCY, async (entry) => {
    if (ctrl.signal.aborted) return;
    entry.status = 'reading';
    drawAxis();
    renderPlateLog();
    try {
      const stamp = await readStamp(toS3(entry.frame.url), grid, { signal: ctrl.signal });
      await afterDive();
      if (ctrl.signal.aborted) return;
      if (!stamp) {
        entry.status = 'dropped';
      } else {
        entry.status = 'ready';
        entry.landedAt = performance.now();
        entry.bytes = stamp.meta.bytesRead;
        bytes += stamp.meta.bytesRead;
        sky.addVisit(entry.frame, stamp);
        if (sky.visits.length === 1) setPlateState('', { hidden: true });
        syncScrub();
        // The reading is taken as the visits land, not after the last one: with
        // three in hand the sectors can already be scored, and a field whose
        // slowest frame takes half a minute should not show nothing until then.
        measureDepth({ final: false });
      }
    } catch {
      if (!ctrl.signal.aborted) entry.status = 'dropped';
    }
    done++;
    if (ctrl.signal.aborted) return;
    if (!sky.visits.length) {
      setPlateState(t('epochs.loading', { done, total: chosen.length }), { progress: done / chosen.length });
    } else {
      renderPlateLog();
    }
    drawAxis();
    updateIdentity();
  });

  if (ctrl.signal.aborted) return;
  if (!sky.visits.length) { state.loading = false; renderVerdict(); setPlateState(t('epochs.none')); return; }

  setPlateState('', { hidden: true });
  sky.setAB(0, Math.max(0, sky.visits.length - 1));
  syncScrub();
  // The marks card offers a one-press demonstration, which only makes sense once
  // there are visits to measure — so it is re-rendered when they arrive.
  renderMarks();
  refreshKnownObjects();
  prefetchKnownObjects(ctrl.signal);
  loadFieldCatalog(ctrl.signal);

  // The headline number of this whole approach: how little of the archive we touched.
  state.bytes = bytes;
  renderBytes();
  state.loading = false;
  measureDepth({ final: true });
  if (sky.marks.length) retrackMarks();

  const stillness = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (sky.visits.length > 1 && !state.playing && !stillness && sky.mode === 'blink') startPlayback();
}

/** How little of the archive this field actually cost. */
function renderBytes() {
  $('bytes-note').textContent = state.bytes
    ? t('status.read', {
      mb: fmt(state.bytes / 1048576, 1), total: fmt(state.visits.length * 68.3, 0),
    })
    : '';
}

function populateBands() {
  const select = $('band');
  const present = bandsPresent(state.frames);
  select.replaceChildren();

  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = t('field.bandAll');
  select.append(all);

  for (const b of present) {
    const range = bandRange(state.frames, b);
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = range ? `${b} · ${fmt(range[0], 2)}–${fmt(range[1], 2)} µm` : b;
    select.append(opt);
  }
  select.value = present.includes(state.band) ? state.band : 'all';
  state.band = select.value;
  renderLambda(present);
}

/**
 * One chip per waveband, under the frame.
 *
 * SPHEREx splits 0.75 to 5 micrometres into six of these and the choice between
 * them is what the instrument is for — a dusty object and an icy one look the
 * same in one band and different in another. It does not belong in a settings
 * panel. The chips drive the same hidden select the rest of the app reads, so
 * there is still exactly one place the chosen band lives.
 */
function renderLambda(present) {
  const box = $('lambda');
  box.replaceChildren();
  if (present.length < 2) return;

  const chip = (value, label, sub) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lambda__chip';
    const name = document.createElement('span');
    name.className = 'lambda__name';
    name.textContent = label;
    b.append(name);
    if (sub) {
      const um = document.createElement('span');
      um.className = 'lambda__um';
      um.textContent = sub;
      b.append(um);
    }
    b.setAttribute('aria-pressed', String(state.band === value));
    b.addEventListener('click', () => {
      if (state.band === value) return;
      const select = $('band');
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    box.append(b);
  };

  const span = (lo, hi) => `${fmt(lo, 2)}–${fmt(hi, 2)} µm`;
  const ranges = present.map((b) => bandRange(state.frames, b)).filter(Boolean);
  chip('all', t('field.bandAll'), ranges.length
    ? span(Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))) : '');
  for (const b of present) {
    const range = bandRange(state.frames, b);
    chip(b, b, range ? span(range[0], range[1]) : '');
  }
}

/* -------------------------------------------------------------------- search */

async function submitTarget(raw) {
  const note = $('find-note');
  const text = raw.trim();
  if (!text) return;

  const coords = parseCoordinates(text);
  if (coords) { note.textContent = ''; openField({ ...coords, label: '' }); return; }
  if (/^[\d\s.+-]+$/.test(text)) { note.textContent = t('target.badCoords'); return; }

  note.textContent = t('target.resolving');
  // A name takes seconds to resolve. A second name typed meanwhile wins, and
  // its own note stands; going somewhere else on the sky meanwhile wins too,
  // and this one's "resolving" goes quietly. Changing the band or the width
  // reopens the same place, which is not going anywhere, so it cancels nothing.
  const ticket = ++askSeq;
  const from = `${state.ra}|${state.dec}`;
  const movedOn = () => `${state.ra}|${state.dec}` !== from;
  try {
    const hit = await resolveName(text);
    if (ticket !== askSeq) return;
    if (movedOn()) { note.textContent = ''; return; }
    if (!hit) { note.textContent = t('target.notFound'); return; }
    note.textContent = '';
    openField({ ra: hit.ra, dec: hit.dec, label: hit.name });
  } catch {
    if (ticket !== askSeq) return;
    note.textContent = movedOn() ? '' : t('target.offline');
  }
}

/* -------------------------------------------------------------------- export */

function savePNG() {
  const link = document.createElement('a');
  const v = sky.current;
  link.download = `muninn_${state.ra.toFixed(4)}_${state.dec.toFixed(4)}_${v ? v.frame.obsId : 'field'}.png`;
  link.href = sky.canvas.toDataURL('image/png');
  link.click();
}

async function copyLink(btn) {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    btn.dataset.state = 'done';
    btn.textContent = t('export.linkDone');
    setTimeout(() => { delete btn.dataset.state; btn.textContent = t('export.link'); }, 1800);
  } catch {
    btn.textContent = location.href;
  }
}

function recordBlink(btn) {
  if (btn.dataset.state === 'busy') return;
  const stream = sky.canvas.captureStream(30);
  const mime = ['video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const url = URL.createObjectURL(new Blob(chunks, { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `muninn_${state.ra.toFixed(4)}_${state.dec.toFixed(4)}_blink.webm`;
    a.click();
    URL.revokeObjectURL(url);
    delete btn.dataset.state;
    btn.textContent = t('export.record');
  };
  btn.dataset.state = 'busy';
  btn.textContent = t('export.recording');
  if (!state.playing) playBlink();
  rec.start();
  // Two full cycles is enough to read a movement and short enough to share.
  setTimeout(() => rec.stop(), Math.min(15000, (sky.visits.length * 2 * 1000) / state.rate));
}

/**
 * The finding, in one sentence.
 *
 * Three honest states, and they are genuinely different answers: the archive is
 * still being read; nothing in the field moved above its own noise; or this
 * many things did. A field where nothing moved is a result — it is the whole
 * point of saying how deep the search went — so it is stated rather than left
 * blank.
 */
function renderVerdict() {
  const line = $('verdict');
  const ready = state.visits.filter((v) => v.status === 'ready');
  if (!ready.length) {
    line.textContent = '';
    line.dataset.found = 'false';
    return;
  }

  line.dataset.state = '';
  if (state.loading) {
    const total = state.visits.filter((v) => v.status !== 'dropped').length;
    line.textContent = t('verdict.reading', { done: ready.length, total });
    line.dataset.found = 'false';
    line.dataset.state = 'reading';
  } else if (state.hunting || !state.candidates) {
    line.textContent = t('verdict.working');
    line.dataset.found = 'false';
    line.dataset.state = 'reading';
  } else {
    // Unnamed one-visit flashes are mostly cosmic-ray hits, and a headline is
    // no place for "probably nothing". A known asteroid caught is a finding.
    const moved = state.candidates.list?.length ?? 0;
    const caught = [...new Set((state.caught ?? []).map((c) => c.catalog.name))];
    // "Nothing moved" is only true once SkyBoT has answered for every visit:
    // said earlier, a field with a catalogued asteroid in it opens by denying it.
    const asking = skybotOn() && sky.visits.some((v) => !sky.knownObjects.has(v.frame.obsId)
      && !skybot.failed.has(v.frame.obsId));
    line.textContent = moved
      ? t('verdict.moved', { n: moved })
      : caught.length
        ? t(caught.length === 1 ? 'verdict.caught' : 'verdict.caughtMany', { name: caught[0], n: caught.length })
        : asking ? t('verdict.asking') : t('verdict.still');
    if (!moved && !caught.length && asking) line.dataset.state = 'reading';
    // The signal colour is for what nobody has catalogued; a known asteroid
    // caught is the check working, not a discovery.
    line.dataset.found = String(moved > 0);
  }

  // На чём стоит вывод — сколько мест отсмотрено и до какой яркости дошли —
  // стоит в ряду цифр под заголовком: это величины, а не проза, и дважды на
  // одном экране их называть незачем.
  renderFacts();
}

/* ----------------------------------------------------------------- the gate */

/**
 * The way in.
 *
 * The sky is the first screen, and everything marked on it is something this
 * tool can actually open: the seven planets where they are tonight, the 110
 * Messier objects where they always are, and the fields whose frame indexes
 * ship with the page. Press one and the view falls into SPHEREx's frames of it.
 *
 * The stars behind are the real naked-eye sky and are not clickable as such —
 * though the named ones can be opened too, because a position is a position.
 */
let gate = null;

/** The kind of thing a Messier object is, as a marker shape and a word. */
const DEEP_SHAPE = {
  galaxy: 'galaxy', globular: 'cluster', open: 'cluster', asterism: 'cluster',
  nebula: 'nebula', planetary: 'nebula', remnant: 'nebula',
};

/** Everything the gate offers, newest positions first. */
function gateTargets(deep) {
  const out = [];

  // Planets, computed for right now. They move, so they cannot be a catalogue.
  for (const p of planetsNow()) {
    out.push({
      kind: 'planet', key: p.key, ra: p.ra, dec: p.dec,
      label: t(`planet.${p.key}`),
      sub: t('gate.au', { au: fmt(p.distanceAU, 2) }),
      fov: 0.3, band: 'all',
    });
  }

  // The fields whose frames are already indexed here: no round trip to open.
  for (const f of state.presets) {
    if (!Number.isFinite(f.ra)) continue;
    out.push({
      kind: 'field', key: f.key, ra: f.ra, dec: f.dec,
      label: f.name, sub: t('stats.visits') + ` ${f.visits ?? '—'}`,
      fov: f.fov, band: f.band ?? 'all', ready: true,
    });
  }

  for (const o of deep?.objects ?? []) {
    out.push({
      kind: 'deep', shape: DEEP_SHAPE[o.kind] ?? 'other',
      key: o.id, ra: o.ra, dec: o.dec,
      label: o.name ? `${o.id} · ${o.name}` : o.id,
      sub: `${t(`deep.${o.kind}`)}${o.mag != null ? ` · ${fmt(o.mag, 1)} mag` : ''}`,
      fov: 0.3, band: 'all',
    });
  }
  return out;
}

/** Show the label the pointer is over, on the sky, next to the pointer. */
function nameOnSky(hit) {
  const pin = $('gate-pin');
  pin.hidden = !hit;
  if (!hit) return;
  $('gate-pin-name').textContent = hit.label;
  $('gate-pin-sub').textContent = hit.sub ?? '';
  // On a touch screen the label has nothing to follow — the finger is on top
  // of whatever it would point at — so the stylesheet parks it above the
  // poster and there is nothing to place here.
  if (gate.coarse) { pin.style.left = ''; pin.style.top = ''; return; }
  const p = gate.pointer;
  if (!p) return;
  const dpr = gate.box.dpr;
  pin.style.left = `${p[0] / dpr}px`;
  pin.style.top = `${p[1] / dpr}px`;
  // Flip to the other side near the right edge so the label stays on screen.
  pin.dataset.flip = String(p[0] / dpr > gate.box.cssW - 260);
}

/**
 * Fall through the sky into the frames.
 *
 * The flight is a real re-projection rather than a scale on a picture — see
 * gate.js — so what happens here is only the ordering: dim the type, start the
 * flight, and start fetching frames at the same moment, so the wait for the
 * archive happens during the travel rather than after it.
 */
let flying = false;
/** Visits that landed mid-dive, each waiting for a frame of its own. */
const diveWaiters = [];

/**
 * Resolves once the dive is over. A visit that lands mid-flight costs a few
 * dozen milliseconds to colour and score, which is a dropped frame of the dive
 * for something nobody can see yet; held here, they go in one per frame after
 * the sky has handed over.
 */
function afterDive() {
  if (!flying) return Promise.resolve();
  return new Promise((resolve) => { diveWaiters.push(resolve); });
}

function releaseDiveWaiters() {
  const next = diveWaiters.shift();
  if (!next) return;
  next();
  requestAnimationFrame(releaseDiveWaiters);
}

async function enterFrom(hit) {
  if (flying) return;
  flying = true;
  $('gate').dataset.entering = 'true';
  $('gate-pin').hidden = true;

  if (hit.fov) { state.fov = nearestFov(hit.fov); $('fov').value = String(state.fov); }
  // Kicked off before the flight, not after: the archive takes a second or two
  // and this is a second or two of travel. They should be the same seconds.
  openField({ ra: hit.ra, dec: hit.dec, label: hit.label ?? '', band: hit.band ?? 'all' });

  // Whatever the dive does, the gate has to end up out of the way: a failure
  // here would leave the sky over the frames with no way past it.
  try {
    await gate.fly(hit);
  } finally {
    closeGate();
    flying = false;
    releaseDiveWaiters();
  }
}

/** Back out to the sky, the same way, run backwards. */
async function leaveToSky() {
  if (flying || !gate) return;
  flying = true;
  const at = { ra: state.ra ?? gate.centreRA, dec: state.dec ?? 0 };
  // Put the sky under the field you were on, so pulling back shows you where
  // you had been standing.
  gate.centreRA = at.ra;
  document.body.dataset.gate = 'open';
  $('gate').hidden = false;
  $('gate').dataset.entering = 'false';
  gate.resize();
  try {
    await gate.fly(at, { out: true, ms: 1900 });
  } finally {
    gate.start();
    flying = false;
  }
}

function openGate() {
  document.body.dataset.gate = 'open';
  $('gate').dataset.entering = 'false';
  $('gate').hidden = false;
  gate?.resize();
  gate?.start();
}

function closeGate() {
  document.body.dataset.gate = 'closed';
  $('gate').hidden = true;
  $('gate').dataset.entering = 'false';
  gate?.stop();
  if (gate) gate.zoom = null;
  sky?.resize();
}

async function buildGate() {
  gate = new Gate($('gate-sky'), {
    onPick: (hit) => enterFrom(hit),
    onName: nameOnSky,
  });
  window.addEventListener('resize', () => { if (!$('gate').hidden) gate.resize(); });

  const [stars, deep] = await Promise.all([
    loadStars().catch(() => null),
    fetch('data/sky/deepsky.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (stars) gate.setStars(stars);
  gate.setTargets(gateTargets(deep));
  // Say which layers are measured and which are drawn from a model: that
  // difference is the whole difference between this tool and a wallpaper. It
  // goes in the colophon with the other credits rather than on the sky, where
  // it was four lines of small type over the only thing worth looking at.
  state.skyCredit = [stars?.source, deep?.source, t('gate.modelled')]
    .filter(Boolean).join(' · ');
  relabel();
  gate.resize();
  renderGateJump();
}

/** The ready fields are markers on the sky now; nothing else lists them. */
/**
 * The verified fields, as one line under the search. They live on the sky as
 * rings, but the sky opens facing the galactic centre and none of the five is
 * in that view: a first visit met a search box and nothing to put in it. Each
 * name turns the sky onto its ring and falls in, as pressing the ring does.
 */
function renderGateJump() {
  const box = $('gate-jump');
  box.replaceChildren();
  const ready = state.presets.filter((f) => Number.isFinite(f.ra) && Number.isFinite(f.dec));
  box.hidden = !ready.length;
  if (!ready.length) return;
  // Two lines: the fields this tool was proven on, and the five the challenge
  // names as the test of any tool like it.
  const groups = [
    ['gate.known', ready.filter((f) => f.group !== 'challenge')],
    ['gate.challenge', ready.filter((f) => f.group === 'challenge')],
  ];
  for (const [label, fields] of groups) {
    if (!fields.length) continue;
    const line = document.createElement('span');
    line.className = 'gate__jump-line';
    const head = document.createElement('span');
    head.className = 'gate__jump-k';
    head.textContent = t(label);
    line.append(head, ...fields.map(jumpButton));
    box.append(line);
  }
}

/** One name under the search: press it and the sky turns onto that field. */
function jumpButton(f) {
  const name = f.key ? t(`preset.${f.key}`) : f.name;
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'gate__jump-go';
  go.textContent = name;
  const why = f.why?.[getLanguage()] ?? f.why?.en;
  if (why) go.title = why;
  go.addEventListener('click', () => {
    const hit = { ra: f.ra, dec: f.dec, fov: f.fov, band: f.band ?? 'all', label: name };
    if (gate) { enterFrom(hit); return; }
    // Pressed before the sky has been built: straight in, without the flight.
    if (hit.fov) { state.fov = nearestFov(hit.fov); $('fov').value = String(state.fov); }
    closeGate();
    openField(hit);
  });
  return go;
}

/* --------------------------------------------------------------------- wiring */

const MODE_HINT = { blink: 'mode.blinkHint', wipe: 'mode.wipeHint', difference: 'mode.diffHint', single: 'mode.singleHint' };

/**
 * The line under the run for a mode. The stack's says what this season adds
 * up to: how many visits, and roughly how deep — the per-visit depth of the
 * band plus what averaging those visits buys.
 */
function modeHint(mode) {
  if (mode !== 'stack') return t(MODE_HINT[mode] ?? MODE_HINT.blink);
  const band = sky?.current?.frame.band ?? '';
  const members = sky?.current ? sky.stackMembers() : [];
  const n = members.length;
  const loaded = new Set(members.map((m) => m.frame.url));
  const pending = stackPlanned.filter((f) => !loaded.has(f.url) && !stackDropped.has(f.url)).length;
  const reading = pending ? t('mode.stackReading', { done: n, total: n + pending }) : '';
  if (n < 2 && !reading) return t('mode.stackAlone', { band });
  // The depth of this very stack: its own visits' detector noise, then what
  // averaging them buys (see averaged in stack.js).
  const sigmas = members.map((m) => m.stamp.meta?.detectorSigma).filter((x) => x > 0).sort((a, b) => a - b);
  const single = sigmas.length ? limitAB(sigmas[sigmas.length >> 1]) : null;
  const line = single == null || n < 2
    ? t('mode.stackHintNoDepth', { n, band })
    : t('mode.stackHint', { n, band, mag: fmt(single + 2.5 * Math.log10(Math.sqrt(averaged(n))), 1) });
  return reading ? `${line} ${reading}` : line;
}

/* ------------------------------------------------------------------ stack */

/** What the stack on screen is meant to add, and exposures already asked for. */
let stackPlanned = [];
let stackAsking = new Set();
/** Exposures that could not be read, or turned out not to cover the field. */
let stackDropped = new Set();

/**
 * The seasons of one band, cut from every visit the archive listed for this
 * field — not from the ten loaded for the blink, which are spread across the
 * whole baseline and usually leave one per season.
 */
function bandSeasons(band) {
  return seasonChunks(groupVisits(state.frames, { ra: state.ra, dec: state.dec, band }));
}

/** The loaded visit to show for the next season each way, or the one shown. */
function stackStep(dir) {
  const v = sky?.current;
  if (!v) return sky?.index ?? 0;
  const chunks = bandSeasons(v.frame.band);
  const at = chunkAt(chunks, v.frame.mjd);
  if (at < 0) return sky.index;
  for (let c = at + dir; c >= 0 && c < chunks.length; c += dir) {
    // Seasons with no loaded visit are passed over: there is nothing to stand
    // for them on screen, and the run would not show where they are.
    const k = sky.visits
      .map((x, idx) => ({ x, idx }))
      .filter(({ x }) => x.frame.band === v.frame.band && chunkAt(chunks, x.frame.mjd) === c)
      .sort((a, b) => a.x.frame.mjd - b.x.frame.mjd)[0];
    if (k) return k.idx;
  }
  return sky.index;
}

/**
 * Point the stack at the season of the visit on screen and read whatever of
 * it is not loaded yet. The extra exposures are the stack's alone: the run,
 * the sectors and the hunt keep to the visits they were given.
 */
function refreshStack() {
  const v = sky?.current;
  if (!v || sky.mode !== 'stack') return;
  const chunks = bandSeasons(v.frame.band);
  const at = chunkAt(chunks, v.frame.mjd);
  stackPlanned = at >= 0 ? forStack(chunks[at], v.frame) : [v.frame];
  sky.setStack(stackPlanned.map((f) => f.url));
  $('mode-hint').textContent = modeHint('stack');
  renderWhen();

  const have = new Set([...sky.visits, ...sky.extra.values()].map((x) => x.frame.url));
  const missing = stackPlanned.filter((f) => !have.has(f.url) && !stackAsking.has(f.url) && !stackDropped.has(f.url));
  if (!missing.length) return;
  const signal = state.abort?.signal;
  const grid = sky.grid;
  for (const f of missing) stackAsking.add(f.url);
  pool(missing, 2, async (frame) => {
    if (signal?.aborted || sky.grid !== grid) return;
    try {
      const stamp = await readStamp(toS3(frame.url), grid, { signal });
      if (signal?.aborted || sky.grid !== grid) return;
      // Null is a frame that does not cover enough of the field to use.
      if (!stamp) stackDropped.add(frame.url);
      else {
        sky.addExtra(frame, stamp);
        state.bytes += stamp.meta.bytesRead;
        renderBytes();
      }
    } catch {
      // A stack with one visit fewer is still a stack; not asked again.
      if (!signal?.aborted) stackDropped.add(frame.url);
    }
    if (sky.mode === 'stack') { $('mode-hint').textContent = modeHint('stack'); renderWhen(); }
  });
}

/** One step along the run: a visit, or in the stack a whole season. */
function stepBy(dir) {
  holdStill();
  sky.setIndex(sky.mode === 'stack' ? stackStep(dir) : sky.index + dir);
  syncScrub();
  refreshKnownObjects();
}

function setTools(open) {
  $('tools').hidden = !open;
  const toggle = $('tools-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = t(open ? 'tools.hide' : 'tools.toggle');
}

/* ------------------------------------------------------------------ theme */

const THEME_KEY = 'muninn.theme';
const currentTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/**
 * Put a theme on, and re-read everything that was painted from the old one.
 *
 * The page's own colours follow the tokens by themselves. What does not is
 * what was drawn into canvases: the visits (whose ramps run the other way by
 * day — the plates are negatives), the annotation over them, and the run. All
 * three read the tokens again here, inside the transition's update, so the new
 * theme's snapshot already has them right.
 */
function applyTheme(theme) {
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private window */ }
  sky.readTheme();
  readRunPaint();
  drawAxis();
  labelTheme();
}

function labelTheme() {
  const key = currentTheme() === 'light' ? 'theme.toDark' : 'theme.toLight';
  $('theme').setAttribute('aria-label', t(key));
  $('theme').title = t(key);
}

/** Keep the chips in step with whatever set the band. */
function syncLambda() {
  for (const b of $('lambda').children) {
    b.setAttribute('aria-pressed', String(b.textContent === state.band
      || (state.band === 'all' && b.textContent === t('field.bandAll'))));
  }
}

function applyMode(mode) {
  sky.setMode(mode);
  $('plate').dataset.mode = mode;
  $('mode-hint').textContent = modeHint(mode);
  const comparing = mode === 'wipe' || mode === 'difference';
  $('compare').hidden = !comparing;
  if (mode !== 'blink') stopPlayback();
  // Choosing blink is asking for the visits to run.
  else if (!state.playing && sky.visits.length > 1) startPlayback();
  syncScrub();
  refreshKnownObjects();
}

function jumpToNearest(mjd) {
  let best = 0;
  let gap = Infinity;
  sky.visits.forEach((v, i) => {
    const d = Math.abs(v.frame.mjd - mjd);
    if (d < gap) { gap = d; best = i; }
  });
  if (sky.indexed) sky.setIndex(best);
  else sky.setAB(best, null);
  syncScrub();
  refreshKnownObjects();
}

function wire() {
  $('find').addEventListener('submit', (e) => { e.preventDefault(); submitTarget($('target').value); });
  $('target').addEventListener('focus', function () { this.select(); });
  $('gate-find').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('gate-target').value;
    if (!text.trim()) return;
    $('target').value = text;
    closeGate();
    submitTarget(text);
  });
  $('to-sky').addEventListener('click', leaveToSky);

  $('random').addEventListener('click', () => {
    // Anywhere is fair, but low ecliptic latitude is where the traffic is.
    const ra = Math.random() * 360;
    const dec = clamp((Math.random() - 0.5) * 60, -88, 88);
    $('find-note').textContent = '';
    openField({ ra, dec, label: '' });
  });

  $('fov').addEventListener('change', (e) => {
    state.fov = Number(e.target.value);
    updateIdentity();
    if (state.ra != null) openField({ ra: state.ra, dec: state.dec, label: state.label });
  });
  $('band').addEventListener('change', (e) => {
    state.band = e.target.value;
    syncLambda();
    if (state.ra != null) openField({ ra: state.ra, dec: state.dec, label: state.label });
  });

  const run = $('run-canvas');
  run.addEventListener('pointermove', (e) => {
    const hit = runHitAt(e);
    const i = hit?.i ?? -1;
    run.style.cursor = i >= 0 ? 'pointer' : 'default';
    // A lit cell names itself, the way the picture's own marks do.
    run.title = hit?.sector
      ? t('matrix.cell', {
        sector: hit.sector,
        date: fmtDate(sky.visits[hit.i]?.frame.iso),
        score: fmt(hit.score, 1),
      })
      : '';
    if (i !== runHover) { runHover = i; drawAxis(); }
  });
  run.addEventListener('pointerleave', () => {
    if (runHover !== -1) { runHover = -1; drawAxis(); }
  });
  run.addEventListener('click', (e) => {
    const hit = runHitAt(e);
    if (!hit || hit.i < 0) return;
    if (hit.sector) {
      pickCell(hit.sector, hit.i);
    } else {
      holdStill();
      sky.setIndex(hit.i);
      syncScrub();
    }
    refreshKnownObjects();
  });
  window.addEventListener('resize', () => { if (!$('run').hidden) drawAxis(); });

  $('play').addEventListener('click', togglePlayback);
  $('prev').addEventListener('click', () => stepBy(-1));
  $('next').addEventListener('click', () => stepBy(1));

  $('scrub').addEventListener('input', (e) => { holdStill(); jumpToNearest(Number(e.target.value)); });

  $('slot-a').addEventListener('change', (e) => { sky.setAB(Number(e.target.value), null); syncScrub(); refreshKnownObjects(); });
  $('slot-b').addEventListener('change', (e) => { sky.setAB(null, Number(e.target.value)); syncScrub(); });

  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', (e) => applyMode(e.target.value));
  }
  for (const radio of document.querySelectorAll('input[name="scaling"]')) {
    radio.addEventListener('change', (e) => sky.setRender({ shared: e.target.value === 'shared' }));
  }

  $('rate').addEventListener('input', (e) => {
    state.rate = Number(e.target.value);
    $('rate-value').textContent = t('play.fps', { n: state.rate });
    if (state.playing) startPlayback();
  });
  $('stretch').addEventListener('change', (e) => sky.setRender({ stretch: e.target.value }));
  $('palette').addEventListener('change', (e) => sky.setRender({ palette: e.target.value }));
  // The number follows the thumb at once; the repaint of every visit happens
  // at most once a frame, with whatever value the thumb has reached by then.
  let clipFrame = 0;
  $('clip').addEventListener('input', (e) => {
    $('clip-value').textContent = Number(e.target.value).toFixed(2);
    if (clipFrame) return;
    clipFrame = requestAnimationFrame(() => {
      clipFrame = 0;
      sky.setRender({ clip: Number($('clip').value) });
    });
  });

  const overlays = {
    'ov-grid': 'grid', 'ov-compass': 'compass', 'ov-catalog': 'catalog', 'ov-skybot': 'skybot',
    'ov-marks': 'marks', 'ov-sectors': 'sectors',
  };
  for (const [id, key] of Object.entries(overlays)) {
    $(id).addEventListener('change', (e) => {
      sky.setOverlays({ [key]: e.target.checked });
      if (key === 'catalog' && e.target.checked && !sky.catalog.length) loadFieldCatalog(state.abort?.signal);
      if (key === 'skybot') {
        // Off, every "no match" becomes "not checked"; on, the questions go out again.
        catalogChanged();
        if (e.target.checked) { refreshKnownObjects(); prefetchKnownObjects(state.abort?.signal); }
      }
    });
  }

  $('clear-marks').addEventListener('click', () => { sky.marks = []; sky.draw(); renderMarks(); });
  $('mark-centre').addEventListener('click', () => {
    if (state.ra == null || !sky.visits.length) return;
    addMark(state.ra, state.dec);
    retrackMarks();
  });
  $('save-png').addEventListener('click', savePNG);
  $('copy-link').addEventListener('click', (e) => copyLink(e.currentTarget));

  const record = $('record');
  if (typeof MediaRecorder !== 'undefined' && sky.canvas.captureStream) {
    record.hidden = false;
    record.addEventListener('click', (e) => recordBlink(e.currentTarget));
  }

  $('tools-toggle').addEventListener('click', () => setTools($('tools').hidden));
  $('hunt-run').addEventListener('click', huntField);
  $('plate-retry').addEventListener('click', () => {
    if (state.ra != null) openField({ ra: state.ra, dec: state.dec, label: state.label });
  });
  $('bare').addEventListener('click', () => setBare(!state.bare));
  $('restore').addEventListener('click', () => setBare(false));

  $('about-open').addEventListener('click', () => {
    // Without this the dialog focuses its Close button and opens scrolled to the
    // end of the text.
    const sheet = $('about');
    sheet.showModal();
    sheet.scrollTop = 0;
  });
  $('about-close').addEventListener('click', () => $('about').close());

  $('theme').addEventListener('click', () => {
    const key = $('theme');
    if (key.disabled) return;
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    // The blink redraws the plate and the run twice a second; during the
    // change that is work on the thread the horizon is drawn from, and it
    // showed as stutter. It pauses for the length of the change and resumes.
    const wasPlaying = state.playing;
    stopPlayback();
    key.disabled = true;
    themeTransition(() => applyTheme(next), next, () => {
      key.disabled = false;
      if (wasPlaying) startPlayback();
    });
  });

  $('lang').addEventListener('click', () => {
    const next = getLanguage() === 'en' ? 'ru' : 'en';
    setLanguage(next);
    try { localStorage.setItem('muninn.lang', next); } catch { /* private window */ }
    relabel();
    writeHash();
  });

  // A shared link pasted while the app is already open only changes the fragment,
  // which is a same-document navigation — without this the page would sit there.
  window.addEventListener('hashchange', () => {
    const next = readHash();
    // The language is its own thing: a link that differs only in `lang` still has
    // to switch, so it is applied before the "did the field move" shortcut.
    if (next.lang && next.lang !== getLanguage()) { setLanguage(next.lang); relabel(); }
    if (!next.position) return;
    const moved = state.ra == null
      || Math.abs(deltaRA(next.position.ra, state.ra)) > 1e-4
      || Math.abs(next.position.dec - state.dec) > 1e-4
      || next.band !== state.band
      || (next.fov ?? state.fov) !== state.fov;
    if (!moved) return;
    if (next.fov) { state.fov = nearestFov(next.fov); $('fov').value = String(state.fov); }
    $('find-note').textContent = '';
    // A link pasted into the address bar of a page that is still showing the
    // sky has to get past the sky: without this the frames load underneath it
    // and nothing appears to happen.
    closeGate();
    openField({ ...next.position, label: next.name, band: next.band });
  });

  let resizeTimer = null;
  // The grid is square whatever shape the frame is, so a resize no longer
  // changes what would be fetched and there is nothing to re-fetch. Only the
  // run has to be redrawn, and that costs a blit.
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawAxis, 120);
  });

  document.addEventListener('keydown', (e) => {
    // e.target is the document itself for synthetic events, and Document has no
    // .matches — guard rather than throw.
    if (e.target instanceof Element && e.target.matches('input, select, textarea, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Space on a focused control presses that control; it only means "play"
    // when nothing that Space already operates has the focus.
    const pressable = e.target instanceof Element && e.target.closest('button, a[href], summary, [role="button"]');
    if (e.key === ' ' && !pressable) { e.preventDefault(); togglePlayback(); }
    // The same steps the ‹ › buttons take, SkyBoT included.
    if (e.key === 'ArrowLeft') stepBy(-1);
    if (e.key === 'ArrowRight') stepBy(1);
    if (e.key === 'h' || e.key === 'H' || e.key === 'р' || e.key === 'Р') setBare(!state.bare);
    if (e.key === 'Escape' && state.bare) setBare(false);
  });
}

/** The words the picture draws itself, in the reader's language. */
function labelSky() {
  sky.labels.rate = (r) => t('overlay.rate', { rate: fmt(r, r < 10 ? 1 : 0) });
}

function relabel() {
  applyTranslations();
  if (sky) { labelSky(); sky.draw(); }
  readRunPaint();
  labelTheme();
  $('lang-name').textContent = getLanguage() === 'en' ? 'RU' : 'EN';
  $('mode-hint').textContent = modeHint(document.querySelector('input[name="mode"]:checked').value);
  $('rate-value').textContent = t('play.fps', { n: state.rate });
  $('play').setAttribute('aria-label', t(state.playing ? 'play.pause' : 'play.play'));
  $('tools-toggle').textContent = t($('tools').hidden ? 'tools.toggle' : 'tools.hide');
  $('bare').textContent = t(state.bare ? 'view.chrome' : 'view.bare');
  // A touch screen has no pointer to move over anything.
  $('cursor-hint').textContent = t(matchMedia('(pointer: coarse)').matches
    ? 'readout.hintTouch' : 'readout.hint');
  renderPresets();
  // Where the sky in the entry screen comes from, with the other credits.
  $('credit').textContent = [t('foot.short'), state.skyCredit].filter(Boolean).join(String.fromCharCode(10));
  updateIdentity();
  renderBytes();
  renderDepth();
  renderMatrix();
  renderHunt();
  renderVerdict();
  renderWhen();
  if (state.frames.length) populateBands();
  if (sky) {
    renderMarks(); drawAxis(); fillSlots(); updateReadout(); describeCanvas();
    if (sky.knownObjects.size) reportKnownObjects();
  }
  if (!sky?.visits.length && state.ra == null) setPlateState(t('status.idle'));
}

async function boot() {
  const hash = readHash();
  let stored = null;
  try { stored = localStorage.getItem('muninn.lang'); } catch { /* private window */ }
  setLanguage(hash.lang ?? stored ?? (navigator.language?.startsWith('ru') ? 'ru' : 'en'));
  loadExamined();

  sky = new SkyView($('sky'), {
    onHover: (sample) => updateReadout(sample ?? undefined),
    onPick: ({ ra, dec }) => { addMark(ra, dec); retrackMarks(); },
    onItem: (hit, x, y) => showTip(hit, x, y),
  });
  labelSky();

  if (hash.fov) state.fov = nearestFov(hash.fov);
  state.band = hash.band;

  wire();
  $('fov').value = String(state.fov);
  relabel();
  sky.resize();
  await loadPresets();

  // A shared link goes straight to its field; anyone else starts at the sky.
  if (hash.position) {
    closeGate();
    openField({ ...hash.position, label: hash.name, band: hash.band });
  } else {
    openGate();
    setPlateState(t('status.idle'));
  }
  buildGate();
}

boot();

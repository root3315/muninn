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

import { t, tIn, setLanguage, getLanguage, applyTranslations, fmt, fmtDate, fmtDay, fmtTime } from './i18n.js';
import { skySigma, stackDepth, shortfall, limitAB, PLANET_NINE_V } from './depth.js';
import { scoreSectors, standouts, SECTOR_COUNT } from './sectors.js';
import { Gate, loadStars } from './gate.js';
import { drawStrip } from './strip.js';
import { themeTransition } from './twilight.js';
import { planetsNow } from './ephemeris.js';
import { rankCandidates } from './hunt.js';
import { searchField } from './huntcore.js';
import { STAR_MAX_SHARE } from './sharpness.js';
import { phoneNotHeadset } from './device.js';
import { FRAME_FILE_MB } from './release.js';
import { deadline, CATALOG_DEADLINE_MS } from './net.js';
import { paint, rampFromToken, sortedFinite, limitsFromSorted } from './render.js';
import { seasonChunks, chunkAt, forStack, averaged } from './stack.js';
import { TangentGrid, separation, deltaRA } from './wcs.js';
import { loadStamp, loadWavelength } from './stamp.js';
import { motionOf, visitPool, chooseMeasured, visitPoint, placeInBand, channelOverlap } from './spectrum.js';
import { spectrumBlock } from './spectrum-view.js';
import { trackCSV } from './export.js';
import { SkyView, shortName } from './sky.js';
import {
  measureLink, planLink, markCall, skybotVerdict as skybotVerdictOf, skybotLine as skybotLineOf, skybotTone, seenAt,
  matchArcsec, identifyMark as identifyMarkOf, tagOf, STILL, whoWords, verdict, sharpWords,
  saturatedMotion as saturatedMotionOf, linkArc, linkWords, pct, predictedWords, peaksOf, brightnessWords,
  brightNeighbourWords,
} from './marks.js';
import { brightStars } from './brightstars.js';
import { loadWise, WISE_BANDS } from './wise.js';
import { planetHostNear, systemUrl } from './exovision.js';
import { drawGaiaSky, psfFor } from './gaiasky.js';
import { fieldArchives, cadcSearchUrl } from './archives.js';
import { markFacts } from './markfacts.js';
import {
  searchFrames, searchAhead, askMissingFrames, NoRelayError, UpstreamError, groupVisits, findHeldVisit, bandsPresent, bandRange, parseCoordinates,
  resolveName, formatRA, formatDec, knownBodies, fieldObjects, toS3, surveySources,
} from './catalog.js';
import { magLimit, wiseLimit, searchRadius, properMotion, ROW_CAP } from './overlay.js';
import { spread, nextVisits, mergeFrames, mergeVisits, VISITS_PER_BATCH } from './visits.js';
import { encodeHash, decodeHash, FOV_CHOICES } from './hash.js';
import { buildIndex, suggest } from './suggest.js';
import { attachSuggest } from './suggest-box.js';
import { initRead, relabelCue } from './read.js';
import { startTour, maybeStartTour, relabelTour } from './tour.js';

/* The catalogue's stars bright enough to saturate (brightstars.js): read once, after the page is up. */
let brightList = [];

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
const MAX_VISITS = VISITS_PER_BATCH;
// Reading a frame is a few round trips to the archive, so more at once is
// faster; on a small phone each landed frame is also a resample and a paint,
// so it keeps four.
const MODEST_DEVICE = (navigator.hardwareConcurrency || 4) <= 4 || (navigator.deviceMemory ?? 8) <= 4;
const FETCH_CONCURRENCY = MODEST_DEVICE ? 4 : 6;
const SKYBOT_CONCURRENCY = 2;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Snap any field width to the nearest one the selector offers. */
const nearestFov = (deg) => FOV_CHOICES.reduce((a, b) => (Math.abs(b - deg) < Math.abs(a - deg) ? b : a));

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const state = {
  ra: null, dec: null, fov: 0.3, band: 'all', label: '',
  frames: [], visits: [], truncated: false, partial: false,
  /** Every visit the archive has for this field and band; `visits` is the part being read. */
  allVisits: [],
  /** A visit index from a link, held until that visit has landed. */
  wantVisit: null,
  /** A preset's own night, shown first as it lands; the blink starts from it. */
  leadVisit: null,
  /** Whether this field's blink has started by itself already. */
  autoPlayed: false,
  readingSince: 0, huntAgain: false,
  /** Visits being read in the background, and how many the field is meant to reach. */
  filling: false, visitGoal: 0,
  /** A drag on the picture, the run or the scrubber; background reading waits for it. */
  dragging: false,
  playing: false, rate: 2, timer: null, abort: null, presets: [], bytes: 0, bare: false,
  depth: null, examined: [], sectors: null, candidates: null, hunting: false, loading: false, failed: false, view: 'sky',
  facts: null, bodies: 0,
  survey: 'off',
  /** The object the field was opened for, marked on the plate (see fieldTarget). */
  target: null,
  /** What B of the wipe shows instead of a visit: AllWISE band 1 or 2, 'gaia' (the model), or null. */
  reference: null,
  skyLayers: { stars: false, deep: false },
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
 * workers are kept and reused, one per fetch slot; a read that finds them all
 * busy — a season link or a stack read beside the background fill — waits its
 * turn for one, rather than doing the same work on this thread. Only where a
 * worker cannot start at all — an old browser, a strict policy — does the
 * same function run here instead.
 */
const stampWorkers = { idle: [], waiting: [], count: 0, broken: false, seq: 0 };

/** A worker for one read, as soon as one is free; null where workers cannot run. */
function takeWorker(signal) {
  if (stampWorkers.idle.length) return Promise.resolve(stampWorkers.idle.pop());
  if (stampWorkers.broken) return Promise.resolve(null);
  if (stampWorkers.count < FETCH_CONCURRENCY) return Promise.resolve(spawnWorker());
  return new Promise((resolve, reject) => {
    const aborted = () => {
      stampWorkers.waiting = stampWorkers.waiting.filter((x) => x !== waiter);
      reject(new DOMException('The read was cancelled', 'AbortError'));
    };
    const waiter = { give: (w) => { signal?.removeEventListener('abort', aborted); resolve(w); } };
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    stampWorkers.waiting.push(waiter);
  });
}

/** A new worker, or null where workers cannot start. */
function spawnWorker() {
  let w;
  try {
    w = new Worker(new URL('./stamp-worker.js', import.meta.url), { type: 'module' });
  } catch {
    workersBroken();
    return null;
  }
  stampWorkers.count++;
  // One that fails to load while it waits for its first read is let go here,
  // as readStamp lets go of one that fails during a read.
  w.addEventListener('error', (e) => {
    if (!stampWorkers.idle.includes(w)) return;
    e.preventDefault?.();
    stampWorkers.idle = stampWorkers.idle.filter((x) => x !== w);
    w.terminate();
    stampWorkers.count--;
    workersBroken();
  });
  return w;
}

/**
 * Every fetch slot's worker, started before the first read needs it. A
 * worker loads its own copy of the code, a few round trips on a slow line
 * and a second of a phone's time; done while the frame list is still on its
 * way, that is off the time to the first picture.
 */
function warmWorkers() {
  while (!stampWorkers.broken && stampWorkers.count < FETCH_CONCURRENCY) {
    const w = spawnWorker();
    if (!w) return;
    releaseWorker(w);
  }
}

/** A worker done with its read goes to the next read waiting, or back to the idle ones. */
function releaseWorker(w) {
  const next = stampWorkers.waiting.shift();
  if (next) next.give(w);
  else stampWorkers.idle.push(w);
}

/** Workers cannot run here: every read waiting for one does its work on this thread. */
function workersBroken() {
  stampWorkers.broken = true;
  for (const waiter of stampWorkers.waiting.splice(0)) waiter.give(null);
}

async function readStamp(url, grid, { signal, onHeader } = {}) {
  const worker = await takeWorker(signal);
  if (!worker) return loadStamp(url, grid, { signal, onHeader });
  const id = ++stampWorkers.seq;
  return new Promise((resolve, reject) => {
    const settle = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.header) { onHeader?.(); return; }
      settle();
      releaseWorker(worker);
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
      workersBroken();
      loadStamp(url, grid, { signal, onHeader }).then(resolve, reject);
    };
    const onAbort = () => worker.postMessage({ type: 'abort', id });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.postMessage({
      id, url, header: Boolean(onHeader),
      grid: { ra: grid.ra, dec: grid.dec, fovDeg: grid.fovDeg, width: grid.width, height: grid.height },
    });
  });
}

const fovLabel = (deg) => (deg >= 1 / 60 ? `${fmt(deg * 60, 1)}′` : `${fmt(deg * 3600, 0)}″`);
/** Both sides of the field, because the shorter one is what crops an object. */
const fieldLabel = () => {
  const g = sky?.grid;
  if (!g?.height) return fovLabel(state.fov);
  return `${fovLabel(g.fovDeg)} × ${fovLabel(g.fovHeightDeg)}`;
};

/* -------------------------------------------------------------------- state */

/**
 * The link to what is on screen, kept in the address bar. The marks, the mode
 * and the visit held still go in with the field, so a copied link puts the
 * next person in front of the same picture rather than the same coordinates.
 */
function hashNow() {
  const held = heldVisit();
  return encodeHash({
    ra: state.ra, dec: state.dec, fov: state.fov, band: state.band, lang: getLanguage(),
    name: state.label, survey: state.survey, mode: sky?.mode ?? null,
    // A named object's motion, when the name came with one and is not a preset's.
    pm: state.target?.key == null && Number.isFinite(state.target?.pmRA) ? [state.target.pmRA, state.target.pmDE] : null,
    visit: state.wantVisit ?? held,
    marks: sky?.marks ?? [],
  });
}

function writeHash() {
  if (state.ra == null) return;
  // Back on the sky the address is the sky's: the field left behind is the
  // page Forward goes to, not what this one says.
  if (!$('gate').hidden && $('gate').dataset.entering !== 'true') return;
  const next = `#${hashNow()}`;
  // Playback moves the visit twice a second; the address bar is only touched
  // when what it says has actually changed.
  if (location.hash === next) return;
  // Going into a field from the sky is a step Back can undo: a new entry in
  // the history, where every later change to the view replaces its own.
  if (readHash().position) history.replaceState(null, '', next);
  else history.pushState(null, '', next);
}

const readHash = () => decodeHash(location.hash);

/**
 * The visit held on screen, as its place in the archive's own list of the
 * field's visits. Its place among the visits read so far moves as more land;
 * this does not, so a link copied mid-load opens on the same frame.
 */
function heldVisit() {
  if (!sky?.visits.length || !sky.indexed || state.playing) return null;
  const at = state.allVisits.indexOf(sky.current?.frame);
  return at >= 0 ? at : null;
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
  if (hidden) $('plate-nudge').hidden = true;
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
 * A tap on the picture while its visits are still being read used to do
 * nothing and say nothing; it now says when a mark can be placed.
 */
function wireNudge() {
  let clock = 0;
  $('plate-state').addEventListener('click', (e) => {
    if (!state.loading || e.target.closest('button')) return;
    const nudge = $('plate-nudge');
    nudge.textContent = t('plate.markWait');
    nudge.hidden = false;
    clearTimeout(clock);
    clock = setTimeout(() => { nudge.hidden = true; }, 3500);
  });
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
    const settled = state.visits.filter((v) => v.status === 'ready' || isGone(v)).length;
    cue.hidden = false;
    if (!total) {
      cue.textContent = state.ra == null ? t('app.lede')
        : state.failed ? t('epochs.cueFailed')
        : state.searched ? t('epochs.none') : t('epochs.searching');
    } else {
      cue.textContent = settled >= total
        ? t(state.visits.some((v) => v.status === 'failed') ? 'epochs.unread' : 'epochs.none')
        : t('epochs.loading', { done: settled, total });
    }
    state.facts = null;
    $('stat-line').replaceChildren();
    return;
  }
  cue.hidden = true;

  // One quiet line of monospace instead of five figures at headline size. The
  // numbers still read; they no longer compete with the finding above them.
  // The count and the baseline are the run's as planned, from the moment the
  // index answers: counted from the visits in hand they climbed while the
  // field loaded ("9 over 367 d", then "10 over 397 d"), as if it had changed.
  const planned = plannedVisits();
  const mjds = planned.map((v) => v.frame.mjd);
  const loaded = ready.length;
  const bands = [...new Set(ready.map((v) => v.frame.band))];
  const span = `${fmt(Math.min(...ready.map((v) => v.frame.emMin)), 2)}–${fmt(Math.max(...ready.map((v) => v.frame.emMax)), 2)} ${t('unit.um')}`;
  state.facts = {
    visits: planned.length,
    loaded,
    total: Math.max(planned.length, state.allVisits.length),
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
  const heldRow = box.contains(document.activeElement) ? document.activeElement.dataset.row : null;
  box.replaceChildren();
  if (!f) return;
  // The archive's count beside the count read, everywhere a count is said:
  // "10 of 55" while the field opens, "loaded 23 of 55" while the rest come
  // in, and past the cap the way to read them all.
  const rows = [[t('facts.visits'), ...visitsFact(f)], [t('facts.band'), f.band]];
  // The same count the run's headline gives: every cell at 4σ or more, not
  // the twelve the hunt goes on to check or the eight the headline used to
  // stop at — two caps side by side read as two answers to one question.
  if (state.candidates && state.sectors) {
    rows.push([t('facts.standout'), String(standouts(state.sectors, { limit: Infinity }).length)]);
  }
  if (state.depth) rows.push([t('facts.depth'), `${fmt(state.depth.single, 1)} AB`, 'accent']);
  // The archive caps a long list. Said here, or the count above reads as all
  // there is.
  if (state.truncated) rows.push([t('facts.list'), t('facts.listCapped')]);
  // One collection of the archive did not answer: the run is short, and
  // "nothing moved" would be said about visits nobody was shown.
  if (state.partial && !state.loading) {
    rows.push([t('facts.list'), t('facts.listPartial'), null, {
      label: t(listRetry.busy ? 'facts.listAsking' : 'epochs.retry'),
      run: retryPartialList,
      busy: listRetry.busy,
    }]);
  }
  const unread = state.visits.filter((v) => v.status === 'failed').length;
  // A visit that was not read can be asked for again, here, where it is said.
  // While the background reading is on, it asks again by itself at the end.
  if (unread && !state.loading && !state.filling) {
    rows.push([t('facts.unread'), String(unread), null, {
      label: t('epochs.retry'),
      run: retryUnread,
    }]);
  }
  // The count grows as SkyBoT answers visit by visit; while it is still
  // answering, the row says how far it has got, so "caught 3" at fifteen
  // seconds and "caught 11" at forty-five do not read as two different fields.
  // Past the cap it stops saying "checking" and names the visits that were
  // not answered, which is the part someone can act on.
  const bodies = bodiesLine();
  // Visits SkyBoT failed on can be asked about again, here, where they are named.
  const retryBodies = sky && skybotOn() && skybotFailedVisits().length
    ? { label: t(skybot.retrying ? 'skybot.retrying' : 'skybot.retry'), run: retrySkybot, busy: Boolean(skybot.retrying) }
    : null;
  if (bodies) rows.push([t('facts.bodies'), bodies, null, retryBodies]);
  for (const [name, value, tone, action] of rows) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = name;
    dd.textContent = value;
    if (tone) dd.dataset.tone = tone;
    if (action) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'link facts__go';
      go.dataset.row = name;
      go.textContent = action.label;
      // Busy, it says so and waits; still focusable, so the keyboard keeps its place.
      if (action.busy) go.setAttribute('aria-disabled', 'true');
      go.addEventListener('click', () => { if (!action.busy) action.run(); });
      dd.append(' · ', go);
    }
    row.append(dt, dd);
    box.append(row);
  }
  // The rows are rebuilt as answers come in; a press that had the keyboard keeps it.
  if (heldRow) [...box.querySelectorAll('.facts__go')].find((b) => b.dataset.row === heldRow)?.focus({ preventScroll: true });
}

/** The visits row: value, tone and the action offered beside it. */
function visitsFact(f) {
  if (state.filling) return [t('facts.visitsLoading', { n: f.loaded, total: f.total, days: f.days }), null, null];
  if (f.total > f.visits) {
    const all = !state.loading
      ? { label: t('visits.all', { n: f.total }), run: () => fillVisits(Infinity) } : null;
    return [t('facts.visitsOf', { n: state.loading ? f.visits : f.loaded, total: f.total, days: f.days }), null, all];
  }
  return [t('facts.visitsV', { n: state.loading ? f.visits : f.loaded, days: f.days }), null, null];
}

/** The named-bodies row: a count, how far SkyBoT has got, or which visits it left unanswered. */
function bodiesLine() {
  if (!sky || !skybotOn()) return state.bodies ? String(state.bodies) : '';
  const planned = plannedVisits();
  if (!planned.length || !state.visits.some((v) => v.status === 'ready')) return '';
  const waiting = skybotWaiting();
  const n = state.bodies ?? 0;
  if (waiting.length && !skybot.capped) {
    return t('facts.bodiesChecking', { n, done: planned.length - waiting.length, total: planned.length });
  }
  const unanswered = planned.filter((v) => skybot.failed.has(v.frame.obsId) || waiting.includes(v));
  if (unanswered.length) {
    return t('facts.bodiesUnanswered', {
      n, k: unanswered.length, dates: unanswered.map((v) => dateLabel(v.frame.iso)).join(', '),
    });
  }
  return n ? String(n) : '';
}

/* ----------------------------------------------------------------- presets */

async function loadPresets() {
  for (const url of ['data/targets.json', 'api/targets']) {
    try {
      const res = await fetch(url, { signal: deadline(null, CATALOG_DEADLINE_MS) });
      if (!res.ok) continue;
      const body = await res.json();
      if (Array.isArray(body.targets) && body.targets.length) { state.presets = body.targets; break; }
    } catch {
      /* try the next source */
    }
  }
  renderPresets();
}

/**
 * The presets live on the sky now; this keeps the sky's own list current. The
 * markers carry translated names (planets, kinds of object), so they are
 * rebuilt with it.
 */
function renderPresets() {
  renderGateJump();
  if (gate && gateDeep !== undefined) {
    gate.setTargets(gateTargets(gateDeep));
    // Before the first resize there is no canvas box to draw into yet.
    if (gate.box) gate.draw();
  }
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
async function huntField({ quiet = false } = {}) {
  if (!sky?.visits.length || !state.sectors) return;
  // Asked again while a search is out (the last visits landed mid-search):
  // it runs once more when this one is done, over everything then in hand.
  if (state.hunting) { state.huntAgain = true; return; }
  const gen = fieldSeq;
  state.hunting = true;
  // A search over more visits replaces the last one when it is ready; until
  // then the last one stays on screen, and the headline keeps its answer.
  if (!quiet) state.candidates = null;
  renderHunt();
  try {
    await runHunt();
  } catch (err) {
    // A search that fell over has to say so; leaving the button spinning for
    // ever is the one outcome that tells the user nothing.
    console.error('hunt failed', err);
    if (gen === fieldSeq) state.candidates = { checked: 0, list: [], all: [], error: err.message };
  } finally {
    state.hunting = false;
    renderHunt();
  }
  if (state.huntAgain && gen === fieldSeq) {
    state.huntAgain = false;
    huntField({ quiet: true });
  }
}

/**
 * How long Hunter X waits for every visit before it starts on the ones in
 * hand. One slow file used to hold the search back for half a minute; now the
 * search runs on what has arrived, says how many visits it used, and runs
 * again once the rest are in.
 */
const HUNT_PATIENCE_MS = 12_000;

const plannedVisits = () => state.visits.filter((v) => !isGone(v));

/** Start the search early, if the field has been loading long enough and most of it is in. */
function maybeHuntEarly() {
  if (!state.loading || state.candidates || state.hunting || !state.sectors || !sky) return;
  const inHand = sky.visits.length;
  if (inHand < 3 || inHand * 2 < plannedVisits().length) return;
  if (performance.now() - state.readingSince < HUNT_PATIENCE_MS) return;
  huntField();
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
  // The visits the sector scores were taken over. More land while visits
  // fill in, and they shift the indexes the scores are in; a search run again
  // later must read the same list the scores came from.
  const visits = state.sectors?.list ?? sky.visits.slice();
  const found = await searchField({
    sectors: state.sectors,
    visits,
    grid: sky.grid,
    track: (ra, dec) => sky.trackMark(ra, dec),
    dec: state.dec,
    // Yield so a dozen tracks do not freeze the frame the user is watching.
    pause: async () => { await breathe(); return gen === fieldSeq; },
  });
  if (!found) return;
  state.candidates = found;
  renderVerdict();
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
  const planned = plannedVisits().length;
  // A search made before every visit was in says how many it used, so its
  // answer is read as an answer about those visits.
  const coming = state.loading || state.filling;
  const whole = state.filling ? state.visitGoal : planned;
  const from = found && !found.error && found.used < whole
    ? ` ${t(coming ? 'hunt.fromSoFar' : 'hunt.from', { used: found.used, total: whole })}`
    : '';
  // Run again over newly landed visits, the last answer stays and says so.
  const updating = state.hunting && found ? ` ${t('hunt.updating')}` : '';
  $('hunt-note').textContent = !found
    ? (state.loading ? t('hunt.waiting', { s: Math.round(HUNT_PATIENCE_MS / 1000) }) : t('hunt.idle'))
    : found.error
      ? t('hunt.failed', { why: found.error })
      : (found.list.length
        ? t('hunt.found', { n: found.list.length, checked: found.checked })
        : t('hunt.none', { checked: found.checked })) + from + updating;

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
    withSkybotRetry(id, c.catalog, `mover ${c.ra} ${c.dec}`);

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

    // The same place followed into the next season, in the mark it becomes.
    const follow = document.createElement('button');
    follow.type = 'button';
    follow.className = 'link cand__go';
    follow.textContent = t('link.run');
    follow.title = t('link.what');
    follow.addEventListener('click', () => {
      const cos = Math.cos((c.dec * Math.PI) / 180);
      let m = sky.marks.find((k) => Math.hypot(deltaRA(k.ra, c.ra) * cos, k.dec - c.dec) * 3600 < DETECTOR_ARCSEC);
      if (!m) {
        addMark(c.ra, c.dec);
        m = sky.marks.at(-1);
        m.obsId = c.obsId;
        retrackMarks();
      }
      linkMark(m);
    });

    li.append(head, rate, id, go, follow);
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
  // With visits still arriving it works on those in hand, as the search does:
  // a body caught in one of them is caught whether or not the rest are in.
  if (!sky?.grid || sky.visits.length < 3) return [];
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
/** Whether the known bodies past the first three are unfolded; kept while the list is rebuilt. */
let flashesOpen = false;
let foldSeq = 0;

/**
 * Rows past the first few, folded under a press that says how many: "3 more
 * ▾" opens them with the height easing open, "Show less ▴" folds them again.
 * `outer` is the element that sits in the list ('li' in a list, 'div'
 * beside a dl), `inner` the list the rows go into, with `innerClass`.
 */
function foldBlock(items, { outer = 'li', inner = 'ul', innerClass = '', more, less, open = false, onToggle }) {
  const box = document.createElement(outer);
  box.className = 'fold';
  const body = document.createElement('div');
  body.className = 'fold__body';
  body.id = `fold-${++foldSeq}`;
  const list = document.createElement(inner);
  list.className = `fold__inner ${innerClass}`.trim();
  list.append(...items);
  body.append(list);
  const press = document.createElement('button');
  press.type = 'button';
  press.className = 'link fold__toggle';
  press.setAttribute('aria-controls', body.id);
  const set = (on) => {
    box.dataset.open = String(on);
    press.setAttribute('aria-expanded', String(on));
    press.textContent = on ? less : more;
    // Folded rows are out of the tab order and out of a screen reader's way.
    list.inert = !on;
  };
  set(open);
  press.addEventListener('click', () => {
    const on = box.dataset.open !== 'true';
    set(on);
    onToggle?.(on);
  });
  box.append(body, press);
  return box;
}

function renderFlashes(found) {
  const list = $('flash-list');
  const head = $('flash-head');
  list.replaceChildren();
  const caught = state.caught ?? [];
  const near = (c, k) => c.obsId === k.obsId
    && separation(c.at.ra, c.at.dec, k.at.ra, k.at.dec) * 3600 <= 2 * DETECTOR_ARCSEC;
  const nameless = (found?.flashes ?? [])
    .map((c) => ({ ...c, catalog: huntVerdict(c, true) }))
    .filter((c) => c.catalog.state !== 'match' && !caught.some((k) => near(c, k)));
  // Light in one detector pixel: shown on a card of its own, said for what
  // it most likely is, and kept apart from the flashes still open.
  const sharp = nameless.filter((c) => c.tooSharp);
  const unnamed = nameless.filter((c) => !c.tooSharp);

  const total = caught.length + nameless.length;
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

  // One compact row each, the brightest three in view and the rest folded
  // under "N more": a busy field catches a dozen, and a dozen tall cards
  // pushed everything else off the panel.
  const SHOWN = 3;
  const row = (c) => {
    const v = sky.visits.find((x) => x.frame.obsId === c.obsId);
    const o = c.object;
    const li = document.createElement('li');
    li.className = 'cand cand--row';

    const title = document.createElement('p');
    title.className = 'cand__where';
    title.dataset.known = 'true';
    title.textContent = c.catalog.name;

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'link cand__go';
    go.textContent = t('hunt.flashShow');
    // Buttons all called "Show" are one name to a screen reader.
    go.setAttribute('aria-label', `${t('hunt.flashShow')}: ${c.catalog.name}`);
    go.addEventListener('click', () => showFlash(c));

    // When and in what light; how bright SkyBoT expects it; and how fast it
    // was going, which is why it is gone by the next visit.
    const bits = [dateOf(c), v?.frame.band ?? ''].filter(Boolean).map((text) => ({ text }));
    if (Number.isFinite(o.mag)) bits.push({ text: `V ${fmt(o.mag, 1)}ᵐ` });
    const speed = Math.hypot(o.dRA, o.dDec);
    if (Number.isFinite(speed) && speed > 0) bits.push({ text: t('overlay.rate', { rate: fmt(speed, speed < 10 ? 1 : 0) }) });
    bits.push({ text: `${fmt(c.snr, 0)}σ`, key: true });

    li.append(title, go, factsLine(bits, 'cand__rate'));
    return li;
  };
  for (const c of caught.slice(0, SHOWN)) list.append(row(c));

  const rest = caught.slice(SHOWN);
  if (rest.length) list.append(foldBlock(rest.map(row), {
    innerClass: 'cands',
    more: t('hunt.caughtMore', { n: rest.length }), less: t('fold.less'), open: flashesOpen,
    onToggle: (open) => { flashesOpen = open; },
  }));

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
    const said = { state: states.size === 1 && states.has('none') ? 'none' : [...states].find((s) => s !== 'none') };
    id.textContent = said.state === 'none' ? t('hunt.flashNone') : skybotLine(said);
    withSkybotRetry(id, said, 'flashes');

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

  if (sharp.length) list.append(sharpCard(sharp));
}

/**
 * The flashes whose light sat in one detector pixel. Each date carries the
 * measured share of the 3 × 3 light in that pixel against the bar a star
 * could not pass at that brightness, so the call can be checked, not taken.
 */
function sharpCard(sharp) {
  const li = document.createElement('li');
  li.className = 'cand cand--sharp';

  const fold = document.createElement('details');
  fold.className = 'cand__fold';
  const title = document.createElement('summary');
  title.className = 'cand__where';
  title.dataset.known = 'sharp';
  title.textContent = t('sharp.title', { n: sharp.length });
  const hint = document.createElement('span');
  hint.className = 'cand__hint';
  hint.textContent = t('sharp.short');
  title.append(' ', hint);

  const why = document.createElement('p');
  why.className = 'cand__id';
  why.textContent = t('sharp.why', { most: pct(STAR_MAX_SHARE) });

  const dates = document.createElement('ul');
  dates.className = 'cand__sharp';
  for (const c of sharp) {
    const v = sky.visits.find((x) => x.frame.obsId === c.obsId);
    const row = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'link cand__go';
    go.textContent = v ? dateLabel(v.frame.iso) : '—';
    go.addEventListener('click', () => showFlash(c));
    const share = document.createElement('span');
    share.className = 'num';
    share.textContent = t('sharp.share', { share: pct(c.at.sharp.share), limit: pct(c.at.sharp.limit) });
    row.append(go, share);
    dates.append(row);
  }

  fold.append(title, why, dates);
  li.append(fold);
  return li;
}

/**
 * A share as a whole percentage. Neighbours a little below the background
 * can carry it past one; "all of it" is the honest reading of that.
 */

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
  const total = state.visits.filter((v) => !isGone(v)).length;
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
  // The scores name visits by index, and visits keep landing and re-sorting:
  // the list they were taken over goes with them.
  if (state.sectors) state.sectors.list = visits.slice();
  // A search already made stays on screen while more visits land; it is
  // replaced by the next one, not blanked by every arrival.
  if (!state.sectors) state.candidates = null;
  renderMatrix();
  renderHunt();
  renderVerdict();
  // The search the project is named for ran only when pressed, which left the
  // findings column empty on arrival and made the headline feature a button
  // with no reason to press it. It runs once the last visit is in, or earlier
  // on the visits in hand when the last ones are slow (see maybeHuntEarly).
  if (!state.sectors) return;
  if (final) huntField({ quiet: true });
  else maybeHuntEarly();
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

    // One sentence in view: how far short of Planet X one visit falls, and
    // what stacking them all would reach. The reasoning folds under "More".
    const s = shortfall(d.single);
    const short = s && s.magnitudes > 0;
    const stacked = d.n > 1 ? { n: d.n, mag: fmt(d.stacked, 1) } : null;
    $('depth-reach').textContent = short
      ? t(stacked ? 'depth.short' : 'depth.shortOne', { gap: fmt(s.magnitudes, 1), ...stacked })
      : stacked ? t('depth.shortStack', stacked) : '';
    const reach = short ? t('depth.reach', { gap: fmt(s.magnitudes, 1), factor: Math.round(s.fluxFactor) }) : '';
    const stack = stacked ? t('depth.stackNote', { n: d.n, band: d.band, mag: fmt(d.stacked, 1) }) : '';
    $('depth-detail').textContent = [reach, stack].filter(Boolean).join(' ');
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
    mag: fmt(reached, 1), lo: fmt(PLANET_NINE_V.bright, 1), hi: fmt(PLANET_NINE_V.faint, 1),
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
let runHeightRead = false;
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
    .filter((e) => !isGone(e))
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
  // Fitted, every frame narrows as more land; scrolling, each keeps its size
  // and the run runs off to the right, the shown frame kept in view.
  const lane = $('run-scroll');
  const room = laneWidth(lane);
  const wide = state.runScroll && slots.length * RUN_SLOT_PX > room ? slots.length * RUN_SLOT_PX : null;
  // Written only when they change: each write followed by a read of a size
  // made the browser lay the whole page out again, thirty times a second.
  const canvas = $('run-canvas');
  const cssWidth = wide ? `${wide}px` : '';
  if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
  if (lane.dataset.scroll !== String(Boolean(wide))) lane.dataset.scroll = String(Boolean(wide));
  const fits = slots.length * RUN_SLOT_PX <= room;
  if ($('run-fit').hidden !== fits) $('run-fit').hidden = fits;
  const heightBefore = canvas.height;
  runHits = drawStrip(canvas, {
    width: wide,
    slots,
    sectors: state.sectors,
    index: shown,
    hover: runHover,
    lang: getLanguage(),
    bands: state.band === 'all',
    paint: runPaint,
    now: performance.now(),
    motion: !REDUCED_MOTION.matches && !MODEST_DEVICE && !NARROW_RUN.matches,
  });
  if (canvas.height !== heightBefore || !runHeightRead) { runHeight = box.offsetHeight || runHeight; runHeightRead = true; }
  if (wide) keepInView(lane, shown, slots.length, wide);
  // The run's own name says how much of the archive it is.
  const read = visits.length;
  const total = state.allVisits.length;
  const legend = total > read && read ? t('run.legendSome', { n: read, total }) : t('run.legend');
  const name = box.querySelector('.run__k');
  if (name.textContent !== legend) name.textContent = legend;
  animateRun(slots);
}

/**
 * The run's width, kept by a ResizeObserver: asked of the layout on every
 * redraw, it made the browser lay the page out again each time.
 */
let laneRoom = 0;
let laneWatch = null;
function laneWidth(lane) {
  if (!laneWatch && 'ResizeObserver' in window) {
    laneWatch = new ResizeObserver(([entry]) => { laneRoom = entry.contentRect.width; });
    laneWatch.observe(lane);
  }
  if (!laneRoom) laneRoom = lane.clientWidth;
  return laneRoom || 1;
}

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
/** A phone's width: the run is drawn as frames land, not animated between. */
const NARROW_RUN = matchMedia('(max-width: 40rem)');

/** A frame's place in the scrolling run, wide enough to read its date. */
const RUN_SLOT_PX = 72;

/** Scroll the run so the frame on screen is in view, not chased every frame. */
function keepInView(lane, i, n, width) {
  if (i == null || i < 0) return;
  const x = 8 + ((width - 16) / n) * (i + 0.5);
  const left = lane.scrollLeft;
  const room = lane.clientWidth;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Playing, the run glides under the frame on screen, which holds its place
  // a little left of the middle: one frame's width a step, not a jump of half
  // the lane when the frame reached the edge.
  if (state.playing && !still) {
    const target = Math.max(0, Math.min(width - room, x - room * 0.4));
    if (Math.abs(target - left) > 1) lane.scrollTo({ left: target, behavior: 'smooth' });
    return;
  }
  if (x > left + 60 && x < left + room - 60) return;
  lane.scrollTo({ left: Math.max(0, x - room / 2), behavior: still ? 'auto' : 'smooth' });
}

function setRunScroll(on) {
  state.runScroll = on;
  $('run-fit').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('muninn.runScroll', on ? '1' : '0'); } catch { /* private window */ }
  drawAxis();
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
  // A modest device keeps its time for the frames being read: the run is
  // redrawn when a frame lands, not animated while it waits. So does a phone:
  // redrawing the strip thirty times a second there took the main thread the
  // frames were being decoded on.
  if (runFrame || MODEST_DEVICE || REDUCED_MOTION.matches || NARROW_RUN.matches) return;
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
  writeHash();
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
      if (id === 'slot-b') sel.append(wiseOptions());
      sel.dataset.signature = signature;
    }
    sel.value = id === 'slot-b' && state.reference ? referenceValue(state.reference) : String(current);
    sel.disabled = id === 'slot-a' ? list.length < 2 : !list.length;
    // A long choice is cut by the width of the list; its whole name is the title.
    sel.title = sel.selectedOptions[0]?.textContent ?? '';
  }
  renderCompareLambda();
}

/* -------------------------------------------------------- A and B's light */

/** Below this share of shared channel, A minus B is said to mix spectrum into time. */
const CHANNEL_SHARED_ENOUGH = 0.5;
/** Each frame's wavelength at a field's centre, by URL and centre: read once. */
const centreWaves = new Map();
let lambdaSeq = 0;
/** A search for B is its own question: visits landing redraw the line, and must not cancel it. */
let matchSeq = 0;
let matching = false;

/** The wavelength and bandwidth a frame saw at the field's centre, or null. */
function centreWave(frame, signal) {
  const key = `${frame.url}@${state.ra.toFixed(4)},${state.dec.toFixed(4)}`;
  if (!centreWaves.has(key)) {
    centreWaves.set(key, loadWavelength(toS3(frame.url), state.ra, state.dec, { signal })
      .then((w) => (w ? { lambda: w.um, width: w.width, band: frame.band } : null))
      .catch((err) => { centreWaves.delete(key); throw err; }));
  }
  return centreWaves.get(key);
}

/** The pair being compared, as two SPHEREx frames, or null when B is not a visit. */
function comparedFrames() {
  if (!sky?.visits.length || state.reference) return null;
  const a = sky.visits[sky.a]?.frame;
  const b = sky.visits[sky.b]?.frame;
  return a && b && a !== b ? [a, b] : null;
}

/** Under A and B: the wavelength each saw, and a warning when they saw different light. */
async function renderCompareLambda() {
  const line = $('compare-lambda');
  const match = $('compare-match');
  const comparing = sky && (sky.mode === 'wipe' || sky.mode === 'difference');
  const pair = comparing ? comparedFrames() : null;
  match.hidden = !pair;
  // A against itself shows nothing, and says why rather than leaving a blank.
  const same = comparing && !state.reference && sky.visits.length > 1 && sky.a === sky.b;
  if (same) {
    lambdaSeq++;
    line.hidden = false;
    line.dataset.warn = 'true';
    line.textContent = t('compare.same');
    return;
  }
  if (!pair) { line.hidden = true; return; }
  if (matching) return;
  const seq = ++lambdaSeq;
  line.hidden = false;
  line.dataset.warn = 'false';
  line.textContent = t('lambda.reading');
  let a; let b;
  try {
    [a, b] = await Promise.all(pair.map((f) => centreWave(f, state.abort?.signal)));
  } catch {
    if (seq === lambdaSeq) line.hidden = true;
    return;
  }
  if (seq !== lambdaSeq) return;
  if (!a || !b) { line.hidden = true; return; }
  const shared = channelOverlap(a, b);
  line.textContent = t('lambda.pair', { a: fmt(a.lambda, 3), b: fmt(b.lambda, 3) });
  if (shared != null && shared < CHANNEL_SHARED_ENOUGH) {
    line.dataset.warn = 'true';
    line.textContent += `. ${t('lambda.apart')}`;
  }
}

/**
 * B at A's light: of the visits on the plate in A's band, the one whose
 * channel shares most with A's at the field's centre, and of equals the
 * nearest in time. Asked for, not automatic: each wavelength is a read.
 */
async function matchB() {
  const a = sky.visits[sky.a]?.frame;
  if (!a || matching) return;
  const line = $('compare-lambda');
  const others = sky.visits.map((v, i) => ({ frame: v.frame, i })).filter((v) => v.i !== sky.a && v.frame.band === a.band);
  line.hidden = false;
  line.dataset.warn = 'false';
  line.textContent = t('lambda.matching', { n: others.length + 1 });
  const seq = ++matchSeq;
  const field = fieldSeq;
  matching = true;
  let waveA;
  const scored = [];
  try {
    waveA = await centreWave(a, state.abort?.signal);
    await pool(others, 4, async (v) => {
      const w = await centreWave(v.frame, state.abort?.signal).catch(() => null);
      const shared = waveA && w ? channelOverlap(waveA, w) : null;
      if (shared != null) scored.push({ ...v, shared });
    });
  } catch {
    matching = false;
    if (seq === matchSeq) renderCompareLambda();
    return;
  }
  matching = false;
  if (seq !== matchSeq || field !== fieldSeq) return;
  scored.sort((p, q) => (q.shared - p.shared) || (Math.abs(p.frame.mjd - a.mjd) - Math.abs(q.frame.mjd - a.mjd)));
  const best = scored[0];
  if (!best || best.shared < CHANNEL_SHARED_ENOUGH) {
    line.dataset.warn = 'true';
    line.textContent = t('lambda.none');
    return;
  }
  // Visits land and re-sort while the wavelengths are read: B is found by its frame.
  const at = sky.visits.findIndex((v) => v.frame === best.frame);
  if (at < 0 || sky.visits[sky.b]?.frame === best.frame) { renderCompareLambda(); return; }
  state.abChosen = true;
  sky.setAB(null, at);
  syncScrub();
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
    $('when-band').textContent = `${frame.band} · ${fmt(frame.emMin, 2)}–${fmt(frame.emMax, 2)} ${t('unit.um')}`;
    $('when-of').textContent = t('frame.stack', { n: season.length });
    $('when-flags').textContent = '';
    for (const [id, dir] of [['prev', -1], ['next', 1]]) {
      const k = stackStep(dir);
      $(id).disabled = k === i;
      $(`${id}-date`).textContent = k === i ? '' : fmtDay(list[k].frame.iso);
    }
    return;
  }

  writeNight(frame ? fmtDate(frame.iso).replace(/\s*г\.?$/, '') : '—');
  $('when-date').dataset.range = 'false';
  $('when-time').textContent = frame ? fmtTime(frame.iso) : '';
  $('when-band').textContent = frame ? `${frame.band} · ${fmt(frame.emMin, 2)}–${fmt(frame.emMax, 2)} ${t('unit.um')}` : '';
  // Counted in the field's whole list of visits, the one the run names
  // ("visits to this field: 6 of 17"): counted among those read so far, it
  // said "visit 1 of 1" while the field loaded and its total kept moving.
  const whole = frame ? state.allVisits.indexOf(frame) : -1;
  $('when-of').textContent = whole >= 0
    ? t('frame.visit', { i: whole + 1, n: state.allVisits.length })
    : i >= 0 && list.length ? t('frame.visit', { i: i + 1, n: list.length }) : '';
  // What the pipeline's own flags took out of this frame before anything was
  // measured: applied silently, a mask is a claim nobody can check.
  const masked = shown?.stamp?.meta?.flaggedPixels;
  $('when-flags').textContent = masked == null ? (shown ? t('frame.noFlags') : '')
    : t('frame.flagged', { n: masked });
  brightStarNotes(shown);

  for (const [id, at] of [['prev', i - 1], ['next', i + 1]]) {
    $(id).disabled = !list[at];
    $(`${id}-date`).textContent = list[at] ? fmtDay(list[at].frame.iso) : '';
  }
  renderSurveyNote();
}

/**
 * Under the mask count, when the frame holds a very bright star: why so much
 * of it is closed (the star saturated a patch too large to be a core, see
 * render.js saturatedPatches), and that its ghosts come and go with the roll.
 */
function brightStarNotes(shown) {
  const notes = [];
  if (shown?.patches?.length) notes.push(t('frame.brightStar'));
  if (shown && sky.brightInField) notes.push(t('frame.ghosts'));
  const el = $('when-flags');
  for (const note of notes) el.append(document.createElement('br'), note);
}

/* ------------------------------------------------------------------- readout */

function updateReadout(sample) {
  const shown = sky?.current;
  const frame = shown?.frame;
  $('ro-lambda').textContent = frame ? `${fmt(frame.emMin, 2)}–${fmt(frame.emMax, 2)} ${t('unit.um')}` : '—';
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
const newSkybot = () => ({ asking: new Set(), failed: new Set(), capped: false, settled: false, clock: 0 });
let skybot = newSkybot();

const skybotOn = () => $('ov-skybot').checked;

/**
 * How long the named-bodies line goes on saying "checking" before it says
 * which visits have not been answered. SkyBoT answers in seconds; JPL, asked
 * alongside, can take a minute on a field it has not seen. An answer that
 * arrives after this still counts.
 */
const SKYBOT_CAP_MS = 45_000;

/** The visits of this field SkyBoT has not answered for yet. */
const skybotWaiting = () => (sky ? plannedVisits().filter((v) => !sky.knownObjects.has(v.frame.obsId)
  && !skybot.failed.has(v.frame.obsId)) : []);

/**
 * Whether SkyBoT has had its say about the field as it opened: every visit
 * answered, or the cap reached. Once true it stays true for the field, so the
 * headline does not go back to "still checking" each time visits read in the
 * background are asked about.
 */
function skybotSettled() {
  if (!skybot.settled && (skybot.capped || (sky?.visits.length && !skybotWaiting().length))) skybot.settled = true;
  return skybot.settled;
}

/** Start (or restart, for visits added later) the clock the named-bodies line is capped by. */
function startSkybotClock() {
  const asked = skybot;
  asked.capped = false;
  clearTimeout(asked.clock);
  asked.clock = setTimeout(() => {
    if (asked !== skybot) return;
    asked.capped = true;
    renderFacts();
    renderVerdict();
  }, SKYBOT_CAP_MS);
}

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

/**
 * Ask SkyBoT about one visit, once; a failure is remembered, not retried in a
 * loop. The blink and the background fill both ask every few seconds, and a
 * failed visit was asked again each time while SkyBoT was down: now it waits
 * a minute before it is asked again.
 */
const SKYBOT_RETRY_MS = 60_000;

async function askSkybot(v, signal) {
  const id = v.frame.obsId;
  if (sky.knownObjects.has(id) || skybot.asking.has(id)) return;
  const asked = skybot;
  asked.failedAt ??= new Map();
  if (asked.failed.has(id) && Date.now() - (asked.failedAt.get(id) ?? 0) < SKYBOT_RETRY_MS) return;
  asked.asking.add(id);
  asked.failed.delete(id);
  try {
    // Asked for the middle of the exposure, where the photons were on average;
    // the index's time is its start, a minute earlier.
    const { mjd, exptime } = v.frame;
    const mid = exptime > 0
      ? new Date((mjd + exptime / 2 / 86400 - 40587) * 86400000).toISOString().replace('Z', '')
      : v.frame.iso;
    const objects = await knownBodies({
      ra: state.ra, dec: state.dec,
      radiusDeg: Math.max(0.03, (sky.grid?.spanDeg ?? state.fov) * 0.8), iso: mid,
    }, { signal });
    if (!signal?.aborted && asked === skybot) sky.setKnownObjects(id, objects);
  } catch {
    if (!signal?.aborted) { asked.failed.add(id); asked.failedAt.set(id, Date.now()); }
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
  // Every visit the field will have, not only those whose pixels are in: the
  // question needs a date and a place, and both are known from the index. Asked
  // while the frames are still being read, the answers are mostly in by the
  // time the pictures are.
  const shown = sky.current?.frame;
  const pending = plannedVisits()
    .filter((v) => !sky.knownObjects.has(v.frame.obsId) && !skybot.asking.has(v.frame.obsId))
    .sort((a, b) => (b.frame === shown) - (a.frame === shown));
  if (!pending.length) return;
  startSkybotClock();
  renderFacts();
  await pool(pending, SKYBOT_CONCURRENCY, (v) => (signal?.aborted ? null : askSkybot(v, signal)));
}

/** The visits of this field whose SkyBoT question failed. */
const skybotFailedVisits = () => plannedVisits().filter((v) => skybot.failed.has(v.frame.obsId));

/**
 * Ask again, on a press, about every visit whose question failed: only those,
 * and only once at a time. The minute's wait after a failure is for the
 * automatic askers; a person asking again is let through. JPL, asked alongside,
 * still waits its turn in its own queue.
 */
async function retrySkybot() {
  const asked = skybot;
  if (asked.retrying || !skybotOn()) return;
  const failed = skybotFailedVisits();
  if (!failed.length) return;
  asked.retrying = true;
  for (const v of failed) asked.failedAt?.delete(v.frame.obsId);
  catalogChanged();
  try {
    await pool(failed, SKYBOT_CONCURRENCY, (v) => askSkybot(v, state.abort?.signal));
  } finally {
    asked.retrying = false;
    if (asked === skybot) catalogChanged();
  }
}

/**
 * Which "Try again" had the keyboard, so the one built in its place takes it
 * back. Let go when the person moves elsewhere: a blur would not do, since
 * the rebuild that removes the press blurs it too.
 */
let skybotRetryHeld = null;
const letGoOfRetry = (e) => { if (!e.target.closest?.('.skybot-retry')) skybotRetryHeld = null; };
document.addEventListener('focusin', letGoOfRetry);
document.addEventListener('pointerdown', letGoOfRetry);

/**
 * "Try again", beside a line that says SkyBoT did not answer. `place` names
 * the line. While the question is out it says so and does nothing; it stays
 * focusable, so the keyboard keeps its place while the lists are rebuilt.
 */
function skybotRetryButton(place) {
  const busy = Boolean(skybot.retrying);
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'link skybot-retry';
  again.textContent = t(busy ? 'skybot.retrying' : 'skybot.retry');
  again.setAttribute('aria-disabled', String(busy));
  if (busy) again.setAttribute('aria-busy', 'true');
  again.addEventListener('click', () => { if (!busy) retrySkybot(); });
  again.addEventListener('focus', () => { skybotRetryHeld = place; });
  if (skybotRetryHeld === place) queueMicrotask(() => { if (again.isConnected) again.focus({ preventScroll: true }); });
  return again;
}

/** A line about SkyBoT, with "Try again" after it when it says SkyBoT failed. */
function withSkybotRetry(line, verdict, place) {
  // While the question asked again is out, the line is "waiting" and keeps
  // its press, busy, so the keyboard is not dropped mid-question.
  const asking = skybot.retrying && verdict?.state === 'waiting';
  if ((verdict?.state === 'failed' || asking) && skybotOn()) line.append(' ', skybotRetryButton(place));
  return line;
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

/** What SkyBoT says about something seen at these places (marks.js), from this page's answers. */
function skybotVerdict(seen) {
  return skybotVerdictOf(seen, { knownObjects: sky.knownObjects, failed: skybot.failed, on: skybotOn() });
}

/** The line a mark or a candidate shows for its SkyBoT check (marks.js), dated by this page's visits. */
function skybotLine(verdict, options) {
  return skybotLineOf(verdict, sky.visits, options);
}

/* ------------------------------------------------------------------- marks */

/** A new mark, remembering which visit was on screen when it was dropped. */
/** The marks just cleared, kept for a few seconds so the press can be taken back. */
let marksUndo = null;
const MARKS_UNDO_MS = 5000;

function dropMarksUndo() {
  if (!marksUndo) return;
  clearTimeout(marksUndo.timer);
  marksUndo = null;
  showMarksUndo(false);
}

/** The clear button turns into its own undo, and back. */
function showMarksUndo(on) {
  const button = $('clear-marks');
  button.dataset.undo = String(on);
  const key = on ? 'mark.undo' : 'mark.clear';
  $('clear-marks-label').dataset.i18n = key;
  $('clear-marks-label').textContent = t(key);
  button.title = on ? t('mark.cleared') : '';
}

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
  writeHash();
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

/** Ask the catalogues who a mark is (marks.js), on this page's field, redrawing as answers come. */
function identifyMark(m) {
  identifyMarkOf(m, {
    loading: state.loading,
    fieldSignal: state.abort?.signal,
    visits: sky.visits,
    live: () => sky.marks.includes(m),
    onChange: () => { sky.draw(); renderMarks(); },
    onSlow: renderMarks,
  });
}



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

/**
 * What the catalogues said about a mark (marks.js whoWords), a paragraph per
 * line, names linked to the catalogue's own page.
 */
function whoLines(who, kind) {
  return whoWords(who, kind).map((w) => {
    if (w.asking) {
      // Still waiting is a state, not a finding: set apart from what the mark
      // measured, with a dot that pulses while the catalogues are out.
      const p = document.createElement('p');
      p.className = 'mark__asking';
      p.setAttribute('role', 'status');
      const dot = document.createElement('span');
      dot.className = 'mark__asking-dot';
      dot.setAttribute('aria-hidden', 'true');
      p.append(dot, w.text);
      return p;
    }
    const p = whoP(...w.parts.map((x) => (typeof x === 'string' ? x : link(x.text, x.href))));
    if (w.phot) p.classList.add('mark__phot');
    return p;
  });
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

/* ------------------------------------------ other missions' catalogues */

const SURVEY_KINDS = ['gaia', 'wise'];
const SURVEY_NAMES = { gaia: 'Gaia DR3', wise: 'AllWISE' };
const SURVEY_BAND = { gaia: 'G', wise: 'W1' };
const surveyOn = (kind) => state.survey === kind || state.survey === 'both';

/** Where each survey's answer for the open field stands: asking, ok or failed. */
let surveyStatus = {};

/** A new field: the last one's sources and answers go with it. */
function resetSurveys() {
  surveyStatus = {};
  for (const kind of SURVEY_KINDS) sky.setSurvey(kind, null);
  renderSurveyNote();
}

/** One survey's sources for the open field. Asked once; every visit draws from it. */
async function loadSurvey(kind, signal) {
  if (!sky.grid || state.ra == null) return;
  surveyStatus[kind] = 'asking';
  renderSurveyNote();
  const limit = kind === 'gaia' ? magLimit(state.fov) : wiseLimit(state.fov);
  const radiusDeg = searchRadius(sky.grid.fovDeg, sky.grid.fovHeightDeg);
  try {
    const found = await surveySources(kind, { ra: state.ra, dec: state.dec, radiusDeg, limit }, { signal });
    if (signal?.aborted) return;
    sky.setSurvey(kind, { ...found, limit });
    surveyStatus[kind] = 'ok';
  } catch {
    // A field opened since has its own answers; this one has nothing to report.
    if (signal?.aborted) return;
    surveyStatus[kind] = 'failed';
  }
  renderSurveyNote();
}

/** Show what the switch asks for, and ask for whatever has not been asked yet. */
function applySurvey() {
  for (const kind of SURVEY_KINDS) {
    sky.setOverlays({ [kind]: surveyOn(kind) });
    if (surveyOn(kind) && !surveyStatus[kind] && sky.visits.length) loadSurvey(kind, state.abort?.signal);
  }
  renderSurveyNote();
}

function chooseSurvey(choice) {
  state.survey = choice;
  for (const radio of document.querySelectorAll('input[name="survey"]')) radio.checked = radio.value === choice;
  writeHash();
  applySurvey();
}

/** What one survey's line at the head of the plate says, or null for no line. */
function surveyLineText(kind) {
  const name = SURVEY_NAMES[kind];
  const status = surveyStatus[kind];
  if (status === 'asking') return t('survey.asking', { name });
  if (status === 'failed') return t('survey.failed', { name });
  const found = sky.surveys[kind];
  if (status !== 'ok' || !found || !sky.current) return null;
  const line = t(`survey.${kind}Line`, {
    name, n: sky.surveyShown[kind] ?? 0, band: SURVEY_BAND[kind], lim: fmt(found.reached, 1),
  });
  const via = found.via ? `${line} · ${t(`survey.via${found.via}`)}` : line;
  return found.cut ? `${via} · ${t('survey.cut', { cap: ROW_CAP })}` : via;
}

function surveyLine(kind, text) {
  const p = document.createElement('p');
  p.className = 'survey__line';
  p.dataset.kind = kind;
  const key = document.createElement('span');
  key.className = 'survey__key';
  key.setAttribute('aria-hidden', 'true');
  const words = document.createElement('span');
  words.textContent = text;
  p.append(key, words);
  if (surveyStatus[kind] === 'failed') {
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'survey__retry';
    again.textContent = t('survey.retry');
    again.addEventListener('click', () => loadSurvey(kind, state.abort?.signal));
    p.append(again);
  }
  return p;
}

/**
 * The legend for the survey marks: which catalogue, how many are on the plate,
 * how faint they go, and whether the list was cut. Rebuilt only when what it
 * says has changed, since it is asked for at every step of a blink.
 */
function renderSurveyNote() {
  const note = $('survey-note');
  if (!note || !sky) return;
  const lines = SURVEY_KINDS.filter(surveyOn)
    .map((kind) => [kind, surveyLineText(kind)])
    .filter(([, text]) => text);
  const said = JSON.stringify([lines, getLanguage()]);
  if (note.dataset.said === said) return;
  note.dataset.said = said;
  note.replaceChildren(...lines.map(([kind, text]) => surveyLine(kind, text)));
  note.hidden = !lines.length;
}

/** What a survey mark is: how bright, and for Gaia how it moves and how far it is. */
function surveyTipRows(hit) {
  const o = hit.item;
  if (hit.kind === 'wise') {
    return [
      [`W1 ${fmt(o.mag, 1)}ᵐ`, o.w2 == null ? '' : `W2 ${fmt(o.w2, 1)}ᵐ`].filter(Boolean).join(' · '),
      t('tip.wise'),
    ];
  }
  const pm = properMotion(o);
  const measured = o.plx > 0 && o.plxErr > 0 && o.plx / o.plxErr >= 5;
  const pc = 1000 / o.plx;
  return [
    [
      `G ${fmt(o.mag, 1)}ᵐ`,
      pm == null ? '' : pm >= 0.1 ? t('tip.pm', { pm: fmt(pm, 2) }) : t('tip.pmMas', { pm: fmt(pm * 1000, 1) }),
    ].filter(Boolean).join(' · '),
    o.plx == null ? ''
      : measured ? t('tip.plxPc', { plx: fmt(o.plx, 2), pc: fmt(pc, pc < 100 ? 1 : 0) })
        : t('tip.plx', { plx: fmt(o.plx, 2) }),
    t(hit.at.moved ? 'tip.gaiaMoved' : 'tip.gaiaFixed'),
  ];
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
  } else if (hit.kind === 'gaia' || hit.kind === 'wise') {
    title.textContent = `${SURVEY_NAMES[hit.kind]} ${o.id}`;
    rows.push(...surveyTipRows(hit));
  } else {
    const m = o;
    title.textContent = `${t('tip.mark', { n: hit.n })} · ${callOf(m.analysis)}`;
    if (m.tag && m.tag !== callOf(m.analysis)) rows.push(m.tag);
    if (m.analysis) rows.push(verdict(m.analysis));
    rows.push(brightNeighbourWords(m, brightList));
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

/** What the measurement amounts to, in the fewest words that are still true. */
const callOf = (a) => markCall(a, t);


/**
 * Star's shape or one pixel, for a mark seen in one visit (or two, the
 * second one weak): the measured share of the 3 × 3 light in the brightest
 * detector pixel, and the bar a star could not pass at that brightness.
 * Marks seen across many visits are stars or movers by their own record.
 */

/** The shape reading of a mark as a line of its card (marks.js sharpWords), or null. */
function sharpLine(a) {
  const w = sharpWords(a);
  if (!w) return null;
  const p = document.createElement('p');
  p.className = 'mark__detail mark__shape';
  p.dataset.verdict = w.verdict;
  p.textContent = w.text;
  return { line: p, sharp: w.verdict === 'sharp' };
}

/** How far a saturated mark's catalogued motion carried it (marks.js), the open target's included. */
const saturatedMotion = (m) => saturatedMotionOf(m, state.target);

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
  const peakOf = peaksOf(analysis);
  const max = Math.max(...peakOf.values(), 1e-6);

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

/**
 * A line of figures, "25 Dec · D2 · 403σ": each bit kept whole when the line
 * wraps, the dot staying with the bit before it, and the bits marked `key`
 * set in ink and weight, the number the reader came for.
 */
function factsLine(bits, className) {
  const p = document.createElement('p');
  p.className = `${className} num`;
  bits.forEach((bit, k) => {
    if (k) p.append(' · ');
    const span = document.createElement('span');
    span.className = bit.key ? 'facts-bit facts-bit--key' : 'facts-bit';
    span.textContent = bit.text;
    p.append(span);
  });
  return p;
}

function renderMarks() {
  const ul = $('marks');
  // A spectrum's button outlives the rebuild; so must the focus resting on it.
  const held = ul.contains(document.activeElement) ? document.activeElement : null;
  ul.replaceChildren();
  // The explanation and the invitation are an empty state: once there is a mark
  // to read, the card's room belongs to the mark.
  const empty = sky.marks.length === 0;
  const canDemo = empty && sky.visits.length > 0;
  $('marks-count').textContent = empty ? '' : String(sky.marks.length);
  // A new mark after clearing is a fresh start: the cleared ones stay gone.
  if (!empty && marksUndo) dropMarksUndo();
  $('clear-marks').hidden = empty && !marksUndo;
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

  // The newest mark opens; the ones before it fold to a line when it arrives.
  const last = sky.marks.length - 1;
  if (sky.marks[last].open === undefined) sky.marks.forEach((m, i) => { m.open = i === last; });

  sky.marks.forEach((m, i) => {
    const li = document.createElement('li');
    li.className = 'mark';
    li.dataset.open = String(m.open !== false);

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
    // A mark kept from before a reload has no measurement until the new
    // field's visits are in; it says so rather than "nothing here".
    if (!m.analysis) {
      call.textContent = t('mark.measuring');
      call.dataset.kind = 'none';
      detail.textContent = t('mark.measuringWhy');
    }

    const id = document.createElement('p');
    id.className = 'mark__id';
    id.dataset.known = skybotTone(m.catalog);
    id.textContent = skybotLine(m.catalog);
    withSkybotRetry(id, m.catalog, `mark ${m.ra} ${m.dec}`);

    // A mark dropped on a SkyBoT ring where SPHEREx measured nothing is not
    // "nothing here" next to "in the catalogue" — read together those sound
    // like a contradiction. It is one finding: the orbit puts a body here and
    // it is too faint to show in a single visit.
    const predicted = predictedWords(m);
    if (predicted) {
      call.textContent = predicted.call;
      call.dataset.kind = 'predicted';
      detail.textContent = predicted.detail;
      id.textContent = predicted.id;
      id.dataset.known = 'true';
    }

    const pos = document.createElement('p');
    pos.className = 'mark__pos';
    pos.textContent = `${formatRA(m.ra)} ${formatDec(m.dec)}`;

    // The head reads at a glance, folded or not, like a known body's card in
    // Hunter X: the verdict, a figures line under it, and what the catalogues
    // call it. The sentences and the evidence are the unfolded part.
    const facts = factsLine(markFacts(m.analysis, {
      band: m.analysis?.brightness?.band ?? m.analysis?.track?.[0]?.band ?? (state.band !== 'all' ? state.band : null),
      ra: m.ra, dec: m.dec,
    }, { t, fmt, day: dateLabel }), 'mark__facts');
    const tag = m.tag && m.tag !== call.textContent ? document.createElement('p') : null;
    if (tag) {
      tag.className = 'mark__tag';
      tag.textContent = m.tag;
    }

    // Unfolded, the evidence in groups, each under a small heading, so the
    // verdict, the catalogues, the light and the place do not run together.
    const group = (key, ...nodes) => {
      const kept = nodes.filter(Boolean);
      if (!kept.length) return null;
      const g = document.createElement('div');
      g.className = 'mark__group';
      const k = document.createElement('p');
      k.className = 'mark__k';
      k.textContent = t(key);
      g.append(k, ...kept);
      return g;
    };
    const verdictNodes = [detail];
    const shape = sharpLine(m.analysis);
    if (shape) {
      if (shape.sharp) call.dataset.kind = 'sharp';
      verdictNodes.push(shape.line);
    }
    const motion = saturatedMotion(m);
    if (motion) {
      const p = document.createElement('p');
      p.className = 'mark__detail';
      p.textContent = motion;
      verdictNodes.push(p);
    }
    const neighbour = brightNeighbourWords(m, brightList);
    if (neighbour) {
      const p = document.createElement('p');
      p.className = 'mark__detail';
      p.textContent = neighbour;
      verdictNodes.push(p);
    }
    const whoNodes = [];
    if (!STILL.has(m.analysis?.kind)) whoNodes.push(id);
    if (m.who) whoNodes.push(...whoLines(m.who, m.analysis?.kind));

    const lightNodes = [];
    const curve = m.analysis?.seen ? markCurve(m.analysis) : null;
    if (curve) lightNodes.push(curve);
    const brightness = brightnessWords(m.analysis);
    if (brightness) {
      const b = document.createElement('p');
      b.className = 'mark__detail';
      b.textContent = brightness;
      lightNodes.push(b);
    }
    // The verdict's own sentence reads as its subtitle: a heading "Verdict"
    // over it only repeated the title.
    for (const node of verdictNodes) node.classList.add('mark__lead');
    body.append(...verdictNodes, ...[
      group('mark.kWho', ...whoNodes),
      group('mark.kLight', ...lightNodes),
      group('mark.kWhere', pos),
    ].filter(Boolean));

    const kill = document.createElement('button');
    kill.type = 'button';
    kill.className = 'mark__kill';
    const cross = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    cross.setAttribute('viewBox', '0 0 24 24');
    cross.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', 'M7 7l10 10M17 7 7 17');
    cross.append(line);
    kill.append(cross);
    kill.title = t('mark.remove');
    kill.setAttribute('aria-label', `${t('mark.remove')} ${i + 1}`);
    kill.addEventListener('click', () => {
      sky.marks.splice(i, 1);
      if (sky.link?.mark === m) sky.link = null;
      sky.draw();
      renderMarks();
      writeHash();
    });

    // The card itself folds and unfolds: its head is the press for the
    // keyboard and for a screen reader, and a tap anywhere on the card that
    // is not one of its own controls does the same.
    const head = document.createElement('div');
    head.className = 'mark__head';
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.setAttribute('aria-expanded', String(m.open !== false));
    head.title = t(m.open !== false ? 'mark.fold' : 'mark.unfold');
    head.append(call, facts, ...(tag ? [tag] : []));
    const toggle = () => {
      m.open = m.open === false;
      renderMarks();
      $('marks').children[i]?.querySelector('.mark__head')?.focus({ preventScroll: true });
    };
    head.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggle();
    });
    li.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, select, summary, details, label, .spectrum, .curve')) return;
      // Selecting a figure to copy it is not a press.
      if (String(getSelection?.() ?? '')) return;
      toggle();
    });

    li.append(n, head, kill, body);
    // The numbers behind the verdict, to check or to take elsewhere.
    if (m.track?.length || measuredExposures(m).length) {
      const csv = document.createElement('button');
      csv.type = 'button';
      csv.className = 'link mark__csv';
      csv.textContent = t('mark.csv');
      csv.title = t('mark.csvWhat');
      csv.addEventListener('click', () => saveTrack(m, i + 1));
      body.append(csv);
    }
    if (sky.visits.length) body.append(...linkLines(m));
    if (sky.visits.length) li.append(spectrumBlock(m, () => readSpectrum(m)));
    ul.append(li);
  });
  if (held?.isConnected) held.focus({ preventScroll: true });
}

/* ---------------------------------------------------------------- spectrum */

/**
 * The patch read around a mark from an exposure that is not on the plate:
 * three arcminutes, cut at the field's own scale so the aperture, its
 * annulus and the detector-noise floor are the ones `measure` uses on the
 * field. About thirty detector rows instead of the field's few hundred.
 */
const SPOT_ARCSEC = 180;

function spotGrid(ra, dec) {
  const scale = sky.grid.scale;
  const side = Math.max(48, Math.ceil(SPOT_ARCSEC / (scale * 3600)));
  return new TangentGrid(ra, dec, side * scale, side, side);
}

/**
 * One exposure measured at a position: the visit on the plate if it is one,
 * else a spot read for it. The spot is measured by the plate's own
 * photometry, only on the spot's grid.
 */
async function measureExposure(item, signal) {
  const { frame, at } = item;
  const loaded = sky.visits.find((v) => v.frame.url === frame.url && v.stamp);
  if (loaded) return sky.measure(loaded, at.ra, at.dec, { orLimit: true });
  const grid = spotGrid(at.ra, at.dec);
  const stamp = await loadStamp(toS3(frame.url), grid, { signal, minCoverage: 0.3 });
  if (!stamp) return null;
  state.bytes += stamp.meta.bytesRead;
  renderBytes();
  const spot = Object.create(sky);
  spot.grid = grid;
  return spot.measure({ frame, stamp }, at.ra, at.dec, { orLimit: true });
}

/**
 * A fresh spectrum for a mark: the exposures whose wavelength will be looked
 * up, each with where the source is expected in it. A retry keeps whatever
 * the last attempt already settled.
 */
function planSpectrum(mark, previous) {
  const motion = motionOf(mark, { pixelArcsec: DETECTOR_ARCSEC });
  const loaded = new Set(sky.visits.map((v) => v.frame.url));
  const kept = new Map((previous?.items ?? [])
    .filter((i) => ['done', 'none', 'off', 'skipped'].includes(i.status))
    .map((i) => [i.frame.url, i]));
  const frames = visitPool(state.frames, { from: motion.from, to: motion.to, loaded });
  return {
    motion: motion.kind,
    busy: false,
    phase: 'waves',
    lambda: previous?.lambda ?? null,
    items: frames.map((frame) => kept.get(frame.url) ?? {
      frame, at: motion.at(frame.mjd), loaded: loaded.has(frame.url), status: 'waiting',
    }),
  };
}

/**
 * Read a mark's spectrum from every exposure there is time for. Two steps:
 * the wavelength each exposure saw the source at (a header and a small
 * table, cached per file), then the pixels of the ones chosen — every visit
 * on the plate, the wavelengths seen most often in full, the rest spread
 * across the bands. The reads share the field's abort, so opening another
 * field stops them.
 */
async function readSpectrum(mark) {
  if (mark.spectrum?.busy || !sky.visits.length) return;
  const retry = mark.spectrum?.items.some((i) => i.status === 'failed');
  const spectrum = planSpectrum(mark, retry ? mark.spectrum : null);
  mark.spectrum = spectrum;
  const signal = state.abort?.signal;
  const redraw = () => { if (mark.spectrum === spectrum) spectrumBlock(mark); };
  const settle = async (items, limit, work) => pool(items, limit, async (item) => {
    // An exposure cut short by a new field is one not read, never one left reading.
    if (signal?.aborted) { item.status = 'failed'; return; }
    try {
      await work(item);
    } catch {
      item.status = 'failed';
    }
    redraw();
  });

  spectrum.busy = true;
  redraw();
  await settle(spectrum.items.filter((i) => i.status === 'waiting'), 6, async (item) => {
    const wave = await loadWavelength(toS3(item.frame.url), item.at.ra, item.at.dec, { signal });
    // No wavelength at the position means the position is off this detector.
    item.place = wave ? placeInBand(item.frame, wave) : null;
    item.status = item.place ? 'placed' : 'off';
  });

  spectrum.phase = 'measure';
  const placed = spectrum.items.filter((i) => i.status === 'placed' || i.status === 'skipped');
  const chosen = new Set(chooseMeasured([...placed, ...spectrum.items.filter((i) => i.status === 'done')]));
  for (const item of placed) item.status = chosen.has(item) ? 'queued' : 'skipped';
  redraw();
  await settle(spectrum.items.filter((i) => i.status === 'queued'), 3, async (item) => {
    item.status = 'reading';
    const measurement = await measureExposure(item, signal);
    item.point = visitPoint(measurement);
    item.measurement = measurement;
    item.status = item.point ? 'done' : 'none';
  });
  spectrum.busy = false;
  spectrum.phase = 'done';
  redraw();
  renderMarks();
}

/* ------------------------------------------------------------ season link */

/**
 * Follow a mark from its own season into the next one, at every trial
 * distance from 30 to 2000 AU (see seasons.js for the geometry and what it
 * neglects). The season-B visits are read in full — every one the archive has
 * in that season, up to a stack's worth — and season A's are read too, because
 * a detection on the arc counts only where season A shows nothing.
 */
async function linkMark(m) {
  if (m.link?.state === 'reading') return;
  const ref = sky.visits.find((v) => v.frame.obsId === m.obsId)?.frame ?? sky.current?.frame;
  if (!ref) return;
  const plan = planLink(bandSeasons(ref.band), ref, sky.visits);
  if (!plan) {
    m.link = { state: 'single', band: ref.band };
    if (sky.link?.mark === m) showLink(null);
    renderMarks();
    return;
  }
  const { loadedB, framesA, framesB } = plan;

  const gen = fieldSeq;
  const link = { state: 'reading', band: ref.band, n: 0, total: framesA.length + framesB.length, shown: true };
  m.link = link;
  renderMarks();
  const started = performance.now();
  try {
    const [visitsA, visitsB] = await Promise.all([framesA, framesB].map((list) => linkStamps(list, () => {
      link.n += 1;
      if (m.link === link) renderMarks();
    })));
    if (gen !== fieldSeq || m.link !== link) return;
    if (!visitsA.length || !visitsB.length) throw new Error(t('link.unread'));
    Object.assign(link, await runLink(m, visitsA, visitsB));
    if (gen !== fieldSeq || m.link !== link) return;
    link.state = 'done';
    link.ms = Math.round(performance.now() - started);
    link.loadedB = loadedB ?? null;
  } catch (err) {
    if (gen !== fieldSeq || m.link !== link) return;
    console.error('season link failed', err);
    link.state = 'failed';
    link.why = err.message;
  }
  if (link.state === 'done') showLink(m);
  else if (sky.link?.mark === m) showLink(null);
  renderMarks();
}

/** Pixels for a list of frames: loaded already, kept from an earlier read, or read now. */
async function linkStamps(frames, onEach) {
  const signal = state.abort?.signal;
  const grid = sky.grid;
  const out = [];
  await pool(frames, 2, async (frame) => {
    let item = sky.visits.find((v) => v.frame.url === frame.url) ?? sky.extra.get(frame.url);
    if (!item && !stackDropped.has(frame.url)) {
      try {
        const stamp = await readStamp(toS3(frame.url), grid, { signal });
        if (stamp && sky.grid === grid) {
          sky.addExtra(frame, stamp);
          state.bytes += stamp.meta.bytesRead;
          renderBytes();
          item = sky.extra.get(frame.url);
        } else if (!stamp) stackDropped.add(frame.url);
      } catch {
        if (!signal?.aborted) stackDropped.add(frame.url);
      }
    }
    if (item) out.push(item);
    onEach();
  });
  return out.sort((x, y) => x.frame.mjd - y.frame.mjd);
}

/** The measurement half of the link (marks.js), on this page's plate. */
const runLink = (m, visitsA, visitsB) => measureLink(sky, m, visitsA, visitsB, { breathe });

/** Draw one mark's arc on the plate (marks.js linkArc), or none. */
function showLink(m) {
  const arc = linkArc(m);
  if (!arc) {
    sky.link = null;
    sky.draw();
    return;
  }
  for (const other of sky.marks) if (other !== m && other.link) other.link.shown = false;
  sky.link = arc;
  sky.draw();
}

/** The lines and buttons a mark's link puts in its card. */
function linkLines(m) {
  const out = [];
  // A body SkyBoT has named is in the solar system's inner part and moves
  // far faster than any arc of distant ones: there is no season to link.
  if (m.known) return out;
  const link = m.link;
  if (link?.state !== 'reading') {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'link mark__csv';
    go.textContent = t(link && link.state !== 'single' ? 'link.again' : 'link.run');
    go.title = t('link.what');
    go.addEventListener('click', () => linkMark(m));
    out.push(go);
  }
  if (!link) return out;

  for (const w of linkWords(link)) {
    const p = document.createElement('p');
    p.className = 'mark__detail mark__link';
    if (w.tone) p.dataset.tone = w.tone;
    p.textContent = w.text;
    out.push(p);
  }
  if (link.state !== 'done' || link.result.star) return out;

  const acts = document.createElement('p');
  acts.className = 'mark__link-acts';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'link mark__csv';
  toggle.setAttribute('aria-pressed', String(Boolean(link.shown)));
  toggle.textContent = t(link.shown ? 'link.hideArc' : 'link.showArc');
  toggle.addEventListener('click', () => {
    link.shown = !link.shown;
    showLink(link.shown ? m : null);
    renderMarks();
  });
  acts.append(toggle);
  // To the season-B visit on the run, if one is loaded; the arc stays drawn.
  const target = link.loadedB ? sky.visits.indexOf(link.loadedB) : -1;
  if (target >= 0) {
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'link mark__csv';
    jump.textContent = t('link.jump', { date: fmtDate(link.loadedB.frame.iso) });
    jump.addEventListener('click', () => {
      link.shown = true;
      showLink(m);
      stopPlayback();
      selectMode('single');
      sky.setIndex(target);
      syncScrub();
      refreshKnownObjects();
      renderMarks();
    });
    acts.append(jump);
  }
  out.push(acts);
  return out;
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
  // Layout sizes, not boxes on screen: the plate lands from slightly too big,
  // and a field cut while it was still scaled came out too wide and was shown
  // short of the room's height.
  const r = { width: room.offsetWidth, height: room.offsetHeight };
  const chrome = mount.offsetWidth - cell.offsetWidth;
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

/** The preset centred on this spot, if one is. */
function presetAt(ra, dec) {
  const cos = Math.cos((dec * Math.PI) / 180);
  return state.presets.find((p) => Number.isFinite(p.ra)
    && Math.hypot(deltaRA(p.ra, ra) * cos, p.dec - dec) < 0.01) ?? null;
}

/**
 * The object a field is opened for, to be marked on the plate: a preset's
 * catalogue position and motion; a name's, as the name service gave it (a
 * J2000 position, its motion if SIMBAD has one); the same target again when
 * the same field is reopened in another band or width. A field opened at
 * bare coordinates has none.
 */
function fieldTarget({ ra, dec, label, target, pm }) {
  if (target !== undefined) return target;
  const preset = presetAt(ra, dec);
  if (preset?.target) return { ...preset.target, key: preset.key, label: t(`preset.${preset.key}`) };
  // A preset field without a catalogue position is about something that
  // moves, like (152) Atala: a ring at its place on one date would sit on
  // empty sky in every other visit. SkyBoT rings it where it was each time.
  if (preset) return null;
  const kept = state.target;
  if (kept?.field && kept.label === label && Math.abs(kept.field.ra - ra) < 1e-6 && Math.abs(kept.field.dec - dec) < 1e-6) {
    return kept;
  }
  if (!label) return null;
  const moving = Number.isFinite(pm?.[0]) && Number.isFinite(pm?.[1]);
  return moving ? { ra, dec, epoch: 2000, pmRA: pm[0], pmDE: pm[1], label } : { ra, dec, label };
}

/**
 * Marks carried over to a field opened again — a new size, a new band, a
 * link — placed at once and measured as the visits land, instead of being
 * dropped with the old field's pixels.
 */
function placeMarks(list) {
  for (const m of list) {
    sky.marks.push({ ra: m.ra, dec: m.dec, obsId: m.obsId ?? null, track: [], analysis: null, known: null });
  }
}

/** The marks as places, for carrying across a reload. */
const markPlaces = () => (sky?.marks ?? []).map(({ ra, dec, obsId }) => ({ ra, dec, obsId }));

/** Open the same field again, as it is now: a new size or band keeps the marks and the visit held. */
function reopenField() {
  if (state.ra == null) return;
  // Held by its file, date and band, not its place in the list: another
  // band's list is another list, and its 25th visit is another night.
  const at = state.wantVisit ?? heldVisit();
  const frame = at != null ? state.allVisits[at] : null;
  const held = frame ? { url: frame.url, mjd: frame.mjd, band: frame.band } : null;
  openField({ ra: state.ra, dec: state.dec, label: state.label, marks: markPlaces(), held });
}

/**
 * Add a visit, keeping the frame on screen and the frames A and B of the wipe
 * where they were: the list is in date order, so a visit landing earlier than
 * any of them moves its index, and the index is moved with it.
 */
function addVisitInPlace(frame, stamp) {
  const a = sky.visits[sky.a];
  const b = sky.visits[sky.b];
  sky.addVisit(frame, stamp);
  // Each held by its frame, separately: when A and B were the same visit,
  // neither was moved, and the list shifted under them as visits landed.
  if (a || b) sky.setAB(a ? sky.visits.indexOf(a) : null, b ? sky.visits.indexOf(b) : null);
  // The visit a link or a reload holds goes on screen the moment it lands,
  // not after the whole first batch: the page showed whichever frame came
  // first for seconds and wrote that one into the link.
  if (state.wantVisit != null && frame === state.allVisits[state.wantVisit]) {
    stopPlayback();
    if (sky.mode === 'blink') selectMode('single');
    sky.setIndex(sky.visits.findIndex((v) => v.frame === frame));
    syncScrub();
  } else if (state.leadVisit != null && frame === state.allVisits[state.leadVisit] && !state.playing) {
    // A preset's own night goes on screen as it lands; the blink starts from it.
    sky.setIndex(sky.visits.findIndex((v) => v.frame === frame));
    syncScrub();
  }
}

/**
 * How long a preset's own night is waited for once another visit is in hand:
 * counted from that landing, not from the start, so a slow line or a slow
 * phone that takes ten seconds over every frame still opens on the right one.
 */
const LEAD_PATIENCE_MS = 8000;

/** Whether the plate should still wait for the preset's own night rather than show `frame`. */
function leadPending(frame) {
  if (state.leadVisit == null) return false;
  const lead = state.allVisits[state.leadVisit];
  return frame !== lead && !sky.visits.some((v) => v.frame === lead)
    && !(performance.now() - (state.firstLandedAt ?? Infinity) >= LEAD_PATIENCE_MS);
}

/** From the first landing, the preset's night is given its patience, then the plate shows what it has. */
function waitForLead() {
  state.firstLandedAt = performance.now();
  if (state.leadVisit == null) return;
  const gen = fieldSeq;
  setTimeout(() => {
    if (gen !== fieldSeq || !sky.visits.length || state.wantVisit != null) return;
    setPlateState('', { hidden: true });
    autoBlink();
  }, LEAD_PATIENCE_MS + 50);
}

/**
 * The blink starts as soon as there are two visits to flip between, once
 * per field: waiting for the whole first batch kept a still frame on screen
 * for ten or twenty seconds on a slow line. A link that holds a visit, a
 * mode chosen meanwhile, or a wish for less motion keep it still.
 */
function autoBlink({ final = false } = {}) {
  if (state.autoPlayed || state.wantVisit != null || state.playing || sky.visits.length < 2) return;
  if (sky.mode !== 'blink' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // The preset's own night is the first frame seen: waited for, within its patience.
  if (!final && leadPending(null)) return;
  state.autoPlayed = true;
  startPlayback();
}

/**
 * Read one visit's pixels onto the field's grid and lay it in. While the
 * field opens, the reading (sectors, depth) is taken as each visit lands;
 * while it fills in the background, that is left to fillRefresh, which runs
 * every few seconds instead of on every frame.
 */
async function readOne(entry, grid, signal, { onHeader } = {}) {
  entry.status = 'reading';
  drawAxis();
  renderPlateLog();
  try {
    const stamp = await readStamp(toS3(entry.frame.url), grid, { signal, onHeader });
    await afterDive();
    if (signal.aborted) return 0;
    if (!stamp) {
      entry.status = 'dropped';
      return 0;
    }
    entry.status = 'ready';
    entry.landedAt = performance.now();
    entry.bytes = stamp.meta.bytesRead;
    // A held visit is waited for: the plate stays on its loading note rather
    // than showing another night first and then jumping (it is uncovered at
    // the end of the batch regardless, if that visit cannot be read).
    const waiting = (state.wantVisit != null && state.allVisits[state.wantVisit] !== entry.frame) || leadPending(entry.frame);
    addVisitInPlace(entry.frame, stamp);
    if (sky.visits.length === 1) waitForLead();
    if (!waiting && (sky.visits.length === 1 || state.wantVisit == null || sky.current?.frame === entry.frame)) {
      setPlateState('', { hidden: true });
    }
    // The tour, once two visits are on screen to blink: waiting for the whole
    // first batch held it back half a minute on a slow line, and people had
    // moved on before it came.
    if (sky.visits.length >= 2 && $('plate-state').hidden) maybeStartTour();
    if (!state.filling) autoBlink();
    syncScrub();
    if (state.filling) {
      scheduleFillRefresh();
    } else {
      // With three in hand the sectors can already be scored, and a field whose
      // slowest frame takes half a minute should not show nothing until then.
      measureDepth({ final: false });
      // Marks carried over are measured as the visits come, not only at the end.
      if (sky.marks.length && sky.visits.length >= 3) retrackMarks();
    }
    return stamp.meta.bytesRead;
  } catch {
    // Not the same as a frame that misses the field: this one was never read.
    if (!signal.aborted) entry.status = 'failed';
    return 0;
  }
}

/**
 * Read a batch of visits, four at a time, each shown as it lands. Returns the
 * bytes read.
 */
async function readVisits(entries, grid, signal) {
  let done = 0;
  let bytes = 0;
  const total = entries.length;
  const step = async (entry, options) => {
    if (signal.aborted) return;
    bytes += await readOne(entry, grid, signal, options);
    done++;
    if (signal.aborted) return;
    if (!sky.visits.length) {
      setPlateState(t('epochs.loading', { done, total }), { progress: done / total });
    } else {
      renderPlateLog();
    }
    drawAxis();
    updateIdentity();
  };
  // Six visits started together split the line six ways, and the first
  // picture waited for a sixth of six visits' bytes. One visit gets a head
  // start: the rest begin once its header is in (or it has failed), so its
  // rows are well on their way before theirs. Waiting for the whole of its
  // rows was a second sooner still to the first picture but a second or two
  // later to the tenth. The one a link holds goes first, as that is the one
  // the page will show.
  const lead = entries.find((e) => e.frame === state.allVisits[state.wantVisit ?? state.leadVisit]) ?? entries[0];
  let leadIn;
  const leadStarted = new Promise((resolve) => { leadIn = resolve; });
  const first = step(lead, { onHeader: leadIn }).finally(leadIn);
  await leadStarted;
  await Promise.all([first, pool(entries.filter((e) => e !== lead), FETCH_CONCURRENCY, (e) => step(e))]);
  return bytes;
}

/* --------------------------------------------------- the rest of the visits */

/*
 * A field opens with ten visits spread across the whole baseline, so motion
 * between seasons shows at once. The rest are then read in the background,
 * a few at a time, widest gap in the baseline first: both seasons fill in
 * early, then the run gets denser. Everything that reads the run (playback,
 * the strip, the marks, Hunter X, the stack) takes them in as they land,
 * without moving the frame on screen.
 *
 * It stops at a cap, so a polar field with two hundred visits does not take
 * the tab's memory with it; past the cap the field offers to read the rest.
 * It pauses while the tab is hidden, while the view dives in from the sky,
 * and while someone is dragging on the picture, the run or the scrubber.
 */
const FILL_CAP = 60;
/** Phones and small-memory machines stop sooner. */
const FILL_CAP_SMALL = 30;
/** Pixels of visit (data and picture) the page keeps at most; a wide field reaches it before the cap. */
const FILL_PIXEL_BUDGET = 30e6;
/** The heavy readings are taken again at most this often while visits land. */
const FILL_REFRESH_MS = 4000;

const fillLimit = () => (matchMedia('(max-width: 40rem)').matches || (navigator.deviceMemory ?? 8) <= 4
  ? FILL_CAP_SMALL : FILL_CAP);

function fillCap() {
  const px = (sky.grid?.width ?? 1) * (sky.grid?.height ?? 1);
  return Math.max(MAX_VISITS, Math.min(fillLimit(), Math.floor(FILL_PIXEL_BUDGET / px)));
}

const fillWaiters = [];
const fillPaused = () => document.hidden || flying || state.dragging;

/** Resolves when background reading may go on. */
function fillMayRun() {
  return fillPaused() ? new Promise((resolve) => { fillWaiters.push(resolve); }) : Promise.resolve();
}

/** Something that paused the reading has ended: let it go on, if nothing else holds it. */
function wakeFill() {
  if (!fillPaused()) fillWaiters.splice(0).forEach((resolve) => resolve());
}

let fillTimer = 0;
let fillLast = 0;

/** At most every few seconds, the readings over the run as it now is. */
function scheduleFillRefresh() {
  if (fillTimer) return;
  const wait = Math.max(0, FILL_REFRESH_MS - (performance.now() - fillLast));
  const gen = fieldSeq;
  fillTimer = setTimeout(() => {
    fillTimer = 0;
    if (gen !== fieldSeq) return;
    fillLast = performance.now();
    fillRefresh();
  }, wait);
}

/** Sectors, depth, marks, SkyBoT, the stack and Hunter X, taken again over every visit in hand. */
function fillRefresh({ final = false } = {}) {
  measureDepth({ final });
  // The final pass hunts again by itself (measureSectors); this one has to ask.
  if (!final && state.sectors) huntField({ quiet: true });
  if (sky.marks.length) retrackMarks();
  if (sky.mode === 'stack') refreshStack();
  prefetchKnownObjects(state.abort?.signal);
  updateIdentity();
  drawAxis();
}

/**
 * Read the field's other visits in the background, up to `limit` in all.
 * Failed frames are skipped and asked for once more at the end.
 */
async function fillVisits(limit) {
  if (state.filling || state.loading || !sky?.grid || !state.abort) return;
  const { signal } = state.abort;
  const gen = fieldSeq;
  const grid = sky.grid;
  const live = () => !signal.aborted && gen === fieldSeq;
  state.visitGoal = Math.min(state.allVisits.length, limit);
  if (state.visits.length >= state.visitGoal && !state.visits.some((v) => v.status === 'failed')) {
    updateIdentity();
    return;
  }
  state.filling = true;
  updateIdentity();

  const next = () => {
    if (state.visits.length >= state.visitGoal) return null;
    const [frame] = nextVisits(state.allVisits, state.visits.map((v) => v.frame), 1);
    if (!frame) return null;
    const entry = { frame, status: 'pending' };
    state.visits.push(entry);
    return entry;
  };
  const read = async (entry) => {
    state.bytes += await readOne(entry, grid, signal);
    if (!live()) return;
    renderBytes();
    drawAxis();
    updateIdentity();
  };
  const worker = async () => {
    for (;;) {
      await fillMayRun();
      if (!live()) return;
      const entry = next();
      if (!entry) return;
      await read(entry);
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));

  // Once more for the frames that failed; a slow server often answers the
  // second time. What fails again is counted, and offered again by hand.
  const failed = state.visits.filter((v) => v.status === 'failed');
  await pool(failed, FETCH_CONCURRENCY, async (entry) => {
    await fillMayRun();
    if (live()) await read(entry);
  });
  if (!live()) return;

  state.filling = false;
  clearTimeout(fillTimer);
  fillTimer = 0;
  fillRefresh({ final: true });
}

/*
 * Part of the archive did not answer, so the frame list is short. Asking
 * again asks only for the list: what it adds is merged in, the visits in
 * hand stay the same objects (mergeVisits), and the background reading picks
 * up the new ones as it would any other. Nothing already read, on screen or
 * chosen is touched. Failing again changes nothing but the count of tries:
 * the page asks again by itself after 5, 15 and 45 seconds, and after that
 * only on a press.
 */
const LIST_RETRY_MS = [5000, 15000, 45000];
let listRetry = { busy: false, tries: 0, timer: 0 };

function resetListRetry() {
  clearTimeout(listRetry.timer);
  listRetry = { busy: false, tries: 0, timer: 0 };
}

async function retryPartialList() {
  if (listRetry.busy || !state.partial || state.ra == null) return;
  const asked = listRetry;
  clearTimeout(asked.timer);
  asked.busy = true;
  renderFacts();
  const gen = fieldSeq;
  const { ra, dec } = state;
  // Only the collections that did not answer are asked again, when the relay
  // has said which; never an error on screen, whatever comes back.
  let answer = null;
  try {
    answer = await askMissingFrames({ ra, dec, collections: state.missing ?? [] }, { signal: state.abort?.signal });
  } catch {
    // Aborted: the field has changed.
  }
  if (gen !== fieldSeq || asked !== listRetry) return;
  asked.busy = false;
  if (answer?.busy) {
    // The relay asks to be asked later: that is not a failure, and not counted as one.
    asked.timer = setTimeout(() => { if (asked === listRetry) retryPartialList(); }, answer.retryAfterS * 1000);
    renderFacts();
    return;
  }
  if (answer && !answer.failed) {
    const want = state.allVisits[state.wantVisit];
    state.frames = mergeFrames(state.frames ?? [], answer.frames);
    state.allVisits = mergeVisits(state.allVisits, groupVisits(state.frames, { ra, dec, band: state.band }));
    if (want) state.wantVisit = state.allVisits.indexOf(want);
    state.truncated = state.truncated || Boolean(answer.truncated);
    state.partial = answer.partial;
    state.missing = answer.missing;
    populateBands();
    // The new visits are read the way the rest are, in the background.
    if (!state.filling && !state.loading) fillVisits(Math.max(state.visitGoal, fillCap()));
  } else if (answer?.missing?.length) {
    state.missing = answer.missing;
  }
  asked.tries = state.partial ? asked.tries + 1 : 0;
  if (state.partial && asked.tries <= LIST_RETRY_MS.length) {
    asked.timer = setTimeout(() => { if (asked === listRetry) retryPartialList(); }, LIST_RETRY_MS[asked.tries - 1]);
  }
  updateIdentity();
  drawAxis();
  renderFacts();
}

/** Ask again, by hand, for the visits that were not read. */
function retryUnread() {
  fillVisits(Math.max(state.visitGoal, state.visits.length));
}

async function openField({ ra, dec, label = '', band = null, target, pm, marks = [], visit = null, held = null }) {
  dropMarksUndo();
  fieldSeq += 1;
  const gen = fieldSeq;
  state.abort?.abort();
  const ctrl = new AbortController();
  state.abort = ctrl;

  stopPlayback();
  state.ra = ra;
  state.dec = dec;
  state.label = label;
  state.target = fieldTarget({ ra, dec, label, target, pm });
  if (state.target) state.target.field = { ra, dec };
  if (band) state.band = band;
  state.visits = [];
  state.allVisits = [];
  state.wantVisit = visit;
  state.leadVisit = null;
  state.autoPlayed = false;
  state.firstLandedAt = null;
  // A and B the person chose stay chosen when the last visits land.
  state.abChosen = false;
  state.truncated = false;
  state.partial = false;
  state.missing = [];
  resetListRetry();
  // What the last field measured goes with it: the reading is now built up as
  // this field's visits land, and must not start from someone else's numbers.
  state.loading = true;
  state.failed = false;
  state.depth = null;
  state.sectors = null;
  state.candidates = null;
  state.huntAgain = false;
  state.filling = false;
  state.visitGoal = 0;
  clearTimeout(fillTimer);
  fillTimer = 0;

  // The field is cut to the room the plate has, and all of it is shown. See
  // fieldGrid for why its short side is the one the size control sets.
  let grid = fieldGrid(ra, dec);
  sky.reset(grid);
  sky.target = state.target;
  placeMarks(marks);
  writeHash();
  renderPresets();
  updateIdentity();
  // The mount names the frame on the plate; with none on it yet it must not
  // go on naming the last field's.
  renderWhen();
  sky.setCatalog([]);
  resetSurveys();
  archives = null;
  archivesNeossat = null;
  renderArchives();
  showFieldPlanets();
  showTip(null);
  clearTimeout(skybot.clock);
  skybot = newSkybot();
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
  state.searched = false;
  setPlateState(t('epochs.searching'), { progress: 0 });
  drawAxis();
  warmWorkers();

  let frames;
  let truncated = false;
  let partial = false;
  let missing = [];
  try {
    ({ frames, truncated, partial = false, missing = [] } = await searchFrames({ ra, dec }, { signal: ctrl.signal }));
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
  state.searched = true;
  state.truncated = truncated;
  state.partial = partial;
  state.missing = missing;
  populateBands();

  state.allVisits = groupVisits(frames, { ra, dec, band: state.band });
  const chosen = spread(state.allVisits, MAX_VISITS);
  // A visit held before a reload is found again in the new list.
  if (visit == null && held) {
    const at = findHeldVisit(state.allVisits, held);
    if (at >= 0) state.wantVisit = visit = at;
    // Said in the link at once, while its frame is on the way.
    writeHash();
  }
  // A visit a link holds is read with the first ten, wherever it falls.
  const wanted = state.allVisits[visit];
  if (wanted && !chosen.includes(wanted)) chosen.push(wanted);
  // Without one, a preset leads with the visit its card shows.
  if (!wanted) {
    const lead = await presetLead(ra, dec, state.allVisits);
    if (ctrl.signal.aborted) return;
    const first = state.allVisits[lead];
    if (first) {
      state.leadVisit = lead;
      if (!chosen.includes(first)) chosen.push(first);
    }
  }
  chosen.sort((p, q) => p.mjd - q.mjd);
  state.visits = chosen.map((frame) => ({ frame, status: 'pending' }));
  drawAxis();
  // The run has just taken its place at the foot of the page, which changes the
  // room the plate has. If that changes the shape the field should be, it is cut
  // again now — before a single pixel has been read onto the old one.
  const refit = fieldGrid(ra, dec);
  if (Math.abs(refit.width / refit.height - grid.width / grid.height) > 0.03) {
    grid = refit;
    sky.reset(grid);
    placeMarks(marks);
    stackAsking = new Set();
    stackDropped = new Set();
    renderMarks();
  }
  updateIdentity();

  if (!chosen.length) { state.loading = false; setPlateState(t('epochs.none')); return; }
  if (state.reference) loadReference(ctrl.signal);
  // SkyBoT is asked about every planned visit now, alongside the pixels, rather
  // than after the last of them: the question needs only a date and a place.
  prefetchKnownObjects(ctrl.signal);
  setPlateState(t('epochs.loading', { done: 0, total: chosen.length }), { progress: 0 });

  // Hunter X starts on the visits in hand if the last ones are slow; the clock
  // is checked again when it runs out, in case nothing lands after that.
  state.readingSince = performance.now();
  setTimeout(() => { if (gen === fieldSeq) maybeHuntEarly(); }, HUNT_PATIENCE_MS + 50);

  const bytes = await readVisits(state.visits, grid, ctrl.signal);

  if (ctrl.signal.aborted) return;
  if (!sky.visits.length) {
    state.loading = false;
    renderVerdict();
    // "SPHEREx has not been here" is a statement about the sky. It is only
    // made when every frame was read and none covered the field.
    const unread = state.visits.some((v) => v.status === 'failed');
    setPlateState(t(unread ? 'epochs.unread' : 'epochs.none'), { retry: unread });
    return;
  }

  setPlateState('', { hidden: true });
  // The first and last visits, unless A and B were chosen while the field
  // loaded: the plate is in use well before its last frame lands.
  if (!state.abChosen) sky.setAB(0, Math.max(0, sky.visits.length - 1));
  // A visit asked for by a link is held on screen, which is a single frame.
  let holding = sky.visits.findIndex((v) => v.frame === state.allVisits[state.wantVisit]);
  // The held frame itself may not have been read (a failed or uncovered
  // file): the nearest visit that was is held instead of none.
  if (holding < 0 && held) holding = findHeldVisit(sky.visits.map((v) => v.frame), held);
  state.wantVisit = null;
  if (holding >= 0) {
    stopPlayback();
    if (sky.mode === 'blink') selectMode('single');
    sky.setIndex(holding);
  }
  syncScrub();
  // The marks card offers a one-press demonstration, which only makes sense once
  // there are visits to measure — so it is re-rendered when they arrive.
  renderMarks();
  refreshKnownObjects();
  loadFieldCatalog(ctrl.signal);
  loadArchives(ctrl.signal);
  applySurvey();

  // The headline number of this whole approach: how little of the archive we touched.
  state.bytes = bytes;
  renderBytes();
  state.loading = false;
  measureDepth({ final: true });
  if (sky.marks.length) retrackMarks();

  if (holding < 0) autoBlink({ final: true });
  // The rest of the field's visits, in the background (see fillVisits).
  fillVisits(fillCap());
  maybeStartTour();
}

/** How little of the archive this field actually cost. */
function renderBytes() {
  $('bytes-note').textContent = state.bytes
    ? t('status.read', {
      mb: fmt(state.bytes / 1048576, 1), total: fmt(state.visits.length * FRAME_FILE_MB, 0),
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
    opt.textContent = range ? `${b} · ${fmt(range[0], 2)}–${fmt(range[1], 2)} ${t('unit.um')}` : b;
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
    b.dataset.band = value;
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

  const span = (lo, hi) => `${fmt(lo, 2)}–${fmt(hi, 2)} ${t('unit.um')}`;
  const ranges = present.map((b) => bandRange(state.frames, b)).filter(Boolean);
  chip('all', t('field.bandAll'), ranges.length
    ? span(Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))) : '');
  for (const b of present) {
    const range = bandRange(state.frames, b);
    chip(b, b, range ? span(range[0], range[1]) : '');
  }
}

/* -------------------------------------------------------------------- search */

/**
 * Open what was typed. `note` is where a problem is said, and `onFound` runs
 * once there is a place to go: the gate passes its own note and closes itself
 * there, so a mistyped name is answered beside the box it was typed in.
 */
async function submitTarget(raw, { note = $('find-note'), onFound } = {}) {
  const text = raw.trim();
  if (!text) return;

  const coords = parseCoordinates(text);
  if (coords) { note.textContent = ''; onFound?.(); openField({ ...coords, label: '' }); return; }
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
    onFound?.();
    openField({ ra: hit.ra, dec: hit.dec, label: hit.name, pm: hit.pm });
  } catch {
    if (ticket !== askSeq) return;
    note.textContent = movedOn() ? '' : t('target.offline');
  }
}

/* -------------------------------------------------------------------- export */

/**
 * Bring the newest mark's panel into view. On a wide screen that scrolls the
 * findings column; on a phone the page is the scroller and the plate would be
 * carried away from under the finger, so there it is left where it is.
 */
function showLatestMark() {
  if (!matchMedia('(min-width: 68.0625rem)').matches) return;
  // The list is rebuilt as the mark is measured and named, and the column's
  // height changes with it: a smooth scroll started now is cut short. So the
  // section is put at the top at once, and again when the answers are in.
  const section = $('marks').closest('section') ?? $('marks');
  const column = section.closest('.side');
  // The catalogue answers keep arriving for a few seconds and each moves the
  // section; it is put back until they stop, unless the reader has taken the
  // scroll into their own hands.
  let theirs = false;
  const taken = () => { theirs = true; };
  column?.addEventListener('wheel', taken, { once: true, passive: true });
  column?.addEventListener('touchstart', taken, { once: true, passive: true });
  // The column's own scroll is set, by the distance the section stands from
  // the column's top: scrollIntoView stopped one column-height short here.
  const show = () => {
    if (theirs || !column) return;
    column.scrollTop += section.getBoundingClientRect().top - column.getBoundingClientRect().top;
  };
  requestAnimationFrame(show);
  for (const ms of [400, 1200, 2500]) setTimeout(show, ms);
}

/** The exposures a mark's spectrum measured, for the CSV beside its track. */
const measuredExposures = (mark) => mark.spectrum?.items.filter((i) => i.status === 'done') ?? [];

/** Save one mark's per-visit measurements as a CSV file. */
function saveTrack(mark, n) {
  const link = document.createElement('a');
  link.download = `muninn_${state.ra.toFixed(4)}_${state.dec.toFixed(4)}_mark${n}.csv`;
  link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(trackCSV(mark.track, measuredExposures(mark)))}`;
  link.click();
}

function savePNG() {
  const link = document.createElement('a');
  const v = sky.current;
  link.download = `muninn_${state.ra.toFixed(4)}_${state.dec.toFixed(4)}_${v ? v.frame.obsId : 'field'}.png`;
  link.href = sky.canvas.toDataURL('image/png');
  link.click();
}

/**
 * "⋯" on a phone's bar: saving and sharing, folded so the bar keeps one row.
 * A press anywhere else or Escape folds it again; a copied link stays in view
 * long enough to read "Copied".
 */
function setMore(open) {
  $('more-key').setAttribute('aria-expanded', String(open));
  $('more').dataset.open = String(open);
}

function wireMore() {
  const key = $('more-key');
  key.addEventListener('click', () => setMore(key.getAttribute('aria-expanded') !== 'true'));
  $('copy-link').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    setTimeout(() => { if (btn.dataset.state === 'done') setMore(false); }, 1500);
  });
  document.addEventListener('pointerdown', (e) => {
    if (key.getAttribute('aria-expanded') === 'true' && !e.target.closest('#more, #more-key')) setMore(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && key.getAttribute('aria-expanded') === 'true') { setMore(false); key.focus(); }
  });
}

async function copyLink(btn) {
  writeHash();
  // The language travels in the fragment; a `?lang=` the page was opened with
  // would say it a second time, and the two could disagree.
  const href = `${location.origin}${location.pathname}#${hashNow()}`;
  try {
    await navigator.clipboard.writeText(href);
    btn.dataset.state = 'done';
    btn.textContent = t('export.linkDone');
    setTimeout(() => { delete btn.dataset.state; btn.textContent = t('export.link'); }, 1800);
  } catch {
    btn.textContent = href;
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
  line.dataset.found = 'false';
  const found = state.candidates;
  if (!found) {
    // Until the first search is in there is no answer to give, only progress.
    const total = plannedVisits().length;
    line.textContent = state.loading ? t('verdict.reading', { done: ready.length, total }) : t('verdict.working');
    line.dataset.state = 'reading';
  } else {
    // The headline says what is known as soon as it is known. SkyBoT's check
    // goes on underneath, in the facts, and changes the headline only when it
    // names something; it no longer holds the answer back for half a minute.
    // Unnamed one-visit flashes are mostly cosmic-ray hits, and a headline is
    // no place for "probably nothing". A known asteroid caught is a finding.
    const moved = found.list?.length ?? 0;
    const caught = [...new Set((state.caught ?? []).map((c) => c.catalog.name))];
    const flashes = found.flashes?.filter((c) => !c.tooSharp).length ?? 0;
    line.textContent = moved
      ? t('verdict.moved', { n: moved })
      : caught.length
        ? t(caught.length === 1 ? 'verdict.caught' : 'verdict.caughtMany', { name: caught[0], n: caught.length })
        : flashes && !skybotSettled()
          ? t('verdict.flashesOpen', { n: flashes })
          : t('verdict.still');
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

/**
 * The night of the exposure: the day leads, the month and year sit under it.
 * Between two visits of one field it is the day that changes.
 */
function writeNight(text) {
  const box = $('when-date');
  const parts = /^(\d{1,2}(?:–\d{1,2})?)\s+(.+)$/.exec(text);
  if (!parts) { box.textContent = text; return; }
  const day = document.createElement('span');
  day.className = 'when__day';
  day.textContent = parts[1];
  const rest = document.createElement('span');
  rest.className = 'when__my';
  rest.textContent = parts[2];
  box.replaceChildren(day, rest);
}

/** The deep-sky list the gate was built from; undefined until it has loaded. */
let gateDeep;

/** Everything the gate offers, newest positions first. */
function gateTargets(deep) {
  const out = [];

  // Planets, computed for right now. They move, so they cannot be a catalogue.
  for (const p of planetsNow()) {
    out.push({
      kind: 'planet', key: p.key, ra: p.ra, dec: p.dec,
      label: t(`planet.${p.key}`),
      sub: t('gate.au', { au: fmt(p.distanceAU, 2) }),
      au: p.distanceAU,
      fov: 0.3, band: 'all',
    });
  }

  // The fields whose frames are already indexed here: no round trip to open.
  for (const f of state.presets) {
    if (!Number.isFinite(f.ra)) continue;
    out.push({
      kind: 'field', key: f.key, ra: f.ra, dec: f.dec,
      // The name in the reader's language, as the list under the search has it.
      label: f.key ? t(`preset.${f.key}`) : f.name, sub: t('stats.visits') + ` ${f.visits ?? '—'}`,
      fov: f.fov, band: f.band ?? 'all', ready: true,
    });
  }

  for (const o of deep?.objects ?? []) {
    out.push({
      kind: 'deep', shape: DEEP_SHAPE[o.kind] ?? 'other',
      key: o.id, ra: o.ra, dec: o.dec,
      label: o.name ? `${o.id} · ${o.name}` : o.id,
      sub: `${t(`deep.${o.kind}`)}${o.mag != null ? ` · ${fmt(o.mag, 1)} mag` : ''}`,
      what: t(`deep.${o.kind}`), mag: o.mag,
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
  // A marker holds its label where its own name was drawn; a bare star has no
  // drawn name, so its label stands off the pointer instead.
  const anchor = hit.item ? gate.projectV(hit.item.v) : null;
  const p = anchor ?? gate.pointer;
  if (!p) return;
  const dpr = gate.box.dpr;
  pin.dataset.anchored = String(Boolean(anchor));
  pin.style.left = `${p[0] / dpr}px`;
  pin.style.top = `${p[1] / dpr}px`;
  // Flip to the other side near the right edge so the label stays on screen.
  pin.dataset.flip = String(p[0] / dpr > gate.box.cssW - 260);
}

/* ------------------------------------------------- the card on the sky */

/** One stored frame per ready field: which exposure each picture is. */
let cardThumbs = null;
/** The stored card frames, fields and sky, asked for once. */
const loadThumbs = () => (cardThumbs ? Promise.resolve(cardThumbs) : Promise.all(['data/thumbs.json', 'data/sky/thumbs.json'].map((url) => (
  fetch(url, { signal: deadline(null, CATALOG_DEADLINE_MS) }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
))).then(([fields, deep]) => { cardThumbs ??= { fields, deep }; return cardThumbs; }));

/**
 * The visit a preset field leads with: the date its card shows, so (152)
 * Atala opens on 25 Dec 2025, the night it sits in the middle, and not on
 * whichever visit's bytes came first.
 */
async function presetLead(ra, dec, visits) {
  const preset = presetAt(ra, dec);
  if (!preset) return -1;
  const thumb = (await loadThumbs()).fields?.[preset.key];
  const mjd = thumb?.iso ? Date.parse(`${thumb.iso}Z`) / 86400000 + 40587 : NaN;
  return Number.isFinite(mjd) ? findHeldVisit(visits, { mjd, band: thumb.band }) : -1;
}
/** The frame lists of ready fields, asked for once each. */
const cardFields = new Map();
/** What the card is showing, so only its own answers are written into it. */
let cardHit = null;
/** The timer that blinks a card's two visits. */
let cardBlink = 0;
const BLINK_CARD_MS = 900;

function fieldIndex(key) {
  if (!cardFields.has(key)) {
    cardFields.set(key, fetch(`data/fields/${key}.json`, { signal: deadline(null, CATALOG_DEADLINE_MS) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return cardFields.get(key);
}

function cardFact(name, value) {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = name;
  dd.textContent = value;
  dd.className = 'num';
  row.append(dt, dd);
  return row;
}

/**
 * Show what was pressed on the sky: its name, what it is, where it is, and for
 * a field whose frames are stored here, one real frame and every visit SPHEREx
 * has made. Nothing is opened until the card's button is pressed.
 */
/** A star with planets, or a field centred on one, offers its system in ExoVision. */
async function showPlanets(hit) {
  const link = $('gate-card-planets');
  link.hidden = true;
  if (hit.kind !== 'star' && hit.kind !== 'field') return;
  // A field is centred where its target's path is best seen, not on the
  // target: the target's own catalogue position is the one to look up.
  const preset = hit.kind === 'field' ? state.presets.find((p) => p.key === hit.key) : null;
  const at = preset?.target ?? hit;
  const host = await planetHostNear(at.ra, at.dec);
  if (cardHit !== hit || !host) return;
  offerSystem(link, host, hit.label, 'card.planets');
}

/**
 * The open field, when its target or its centre is a star with known planets,
 * offers the system in ExoVision under the field's facts, the same way in as
 * from the sky's card. A field on no such star shows nothing.
 */
async function showFieldPlanets() {
  const link = $('field-planets');
  link.hidden = true;
  const gen = fieldSeq;
  const at = state.target ?? { ra: state.ra, dec: state.dec };
  if (!Number.isFinite(at?.ra) || !Number.isFinite(at?.dec)) return;
  const host = await planetHostNear(at.ra, at.dec);
  if (gen !== fieldSeq || !host) return;
  offerSystem(link, host, state.label ? state.label.split(' · ')[0] : null, 'field.planets');
}

/** Point `link` at a host's system in ExoVision, entered by the flight in. */
function offerSystem(link, host, label, key) {
  const [, , n, name] = host;
  const shown = label ?? name;
  const href = systemUrl(host, shown, getLanguage());
  link.href = href;
  link.textContent = t(key, { n });
  link.title = t('card.planetsTitle');
  link.hidden = false;
  link.onclick = (e) => {
    // A press with a modifier, or another button, opens a tab as usual.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    jumpToSystem(href, link.getBoundingClientRect(), shown);
  };
}

/**
 * The way into ExoVision: from the card, the sky closes over in ExoVision's
 * own night, the star brightens at its centre with its name under it, and the
 * system's page opens in the same tab (it links back to the field).
 */
function jumpToSystem(href, from, name) {
  if (REDUCED_MOTION.matches || document.querySelector('.exo-jump')) { location.assign(href); return; }
  const veil = document.createElement('div');
  veil.className = 'exo-jump';
  veil.setAttribute('aria-hidden', 'true');
  veil.style.setProperty('--x', `${Math.round(from.left + from.width / 2)}px`);
  veil.style.setProperty('--y', `${Math.round(from.top + from.height / 2)}px`);
  const star = document.createElement('span');
  star.className = 'exo-jump__star';
  const caption = document.createElement('p');
  caption.className = 'exo-jump__caption';
  const kind = document.createElement('span');
  kind.textContent = t('card.jump');
  const title = document.createElement('strong');
  title.textContent = name;
  const where = document.createElement('span');
  where.textContent = 'ExoVision';
  caption.append(kind, title, where);
  veil.append(star, caption);
  document.body.append(veil);
  // Back from ExoVision restores this page from the cache: the veil goes.
  window.addEventListener('pageshow', () => veil.remove(), { once: true });
  setTimeout(() => location.assign(href), 900);
}

async function showCard(hit, { focus = false } = {}) {
  if (flying) return;
  const card = $('gate-card');
  cardHit = hit;
  clearInterval(cardBlink);
  $('gate-pin').hidden = true;

  const preset = hit.kind === 'field' ? state.presets.find((p) => p.key === hit.key) : null;
  $('gate-card-name').textContent = hit.label ?? t('card.sky');
  $('gate-card-kind').textContent = preset ? (preset.why?.[getLanguage()] ?? preset.why?.en ?? '')
    : hit.kind === 'planet' ? t('card.planet')
      : hit.kind === 'star' ? (hit.what ?? t('card.star'))
        : hit.kind === 'deep' ? hit.what : '';
  $('gate-card-kind').hidden = !$('gate-card-kind').textContent;
  $('gate-card-go-label').textContent = t(preset ? 'card.open' : 'card.search');

  // To the arcminute: the card says where to look, the field screen says exactly.
  const coarse = (text) => text.split(' ').slice(0, 2).join(' ');
  const where = cardFact(t('card.pos'), `${coarse(formatRA(hit.ra))} ${coarse(formatDec(hit.dec))}`);
  const facts = [];
  if (preset?.visits) {
    facts.push(cardFact(t('card.visits'), t('card.visitsValue', { n: preset.visits, d: preset.spanDays })));
    // The archive's count is not what the field opens with; said here, the
    // "Visits 10" on the field does not read as a different answer.
    // Open already: how many are in. Not yet: how the field will load them.
    const here = state.ra != null && Math.abs(deltaRA(state.ra, preset.ra)) < 1e-3 && Math.abs(state.dec - preset.dec) < 1e-3;
    const loaded = here ? state.visits.filter((v) => v.status === 'ready').length : 0;
    if (loaded) {
      facts.push(cardFact(t('card.loaded'), t('card.loadedValue', { n: loaded, total: Math.max(loaded, state.allVisits.length) })));
    } else if (preset.visits > MAX_VISITS) {
      const cap = fillLimit();
      facts.push(cardFact(t('card.opens'), preset.visits <= cap
        ? t('card.opensAll', { shown: MAX_VISITS, rest: preset.visits - MAX_VISITS })
        : t('card.opensValue', { shown: MAX_VISITS, cap, n: preset.visits })));
    }
  }
  if (hit.kind === 'star' && hit.sub) facts.push(cardFact(t('card.name'), hit.sub));
  if ((hit.kind === 'deep' || hit.kind === 'star') && hit.mag != null) {
    facts.push(cardFact(t('card.mag'), `V ${fmt(hit.mag, 1)}`));
  }
  if (hit.kind === 'star' && Number.isFinite(hit.bv)) facts.push(cardFact(t('card.colour'), t(starColour(hit.bv))));
  if (hit.kind === 'planet') facts.push(cardFact(t('card.distance'), t('card.au', { au: fmt(hit.au, 2) })));
  facts.push(where);
  $('gate-card-facts').replaceChildren(...facts);
  showPlanets(hit);

  // The frame: only where one is stored. No picture stands in for a missing one.
  await loadThumbs();
  if (cardHit !== hit) return;
  // A named star is stored under its place on the sky, as the bake wrote it.
  const skyKey = hit.kind === 'deep' ? hit.key
    : hit.kind === 'star' ? `s${hit.ra.toFixed(2)}_${hit.dec.toFixed(2)}` : null;
  const thumb = preset ? cardThumbs.fields[preset.key] : skyKey ? cardThumbs.deep[skyKey] : null;
  const shot = thumb ? (preset ? `img/fields/${preset.key}` : `img/sky/${skyKey}`) : '';
  if (thumb && !preset) {
    // Said beside the picture: how many times SPHEREx has been here in its band.
    where.before(cardFact(t('card.bandVisits', { band: thumb.band }), String(thumb.visits)));
  }
  const frame = $('gate-card-frame');
  const img = $('gate-card-img');
  frame.hidden = !thumb;
  cardLive?.abort();
  $('gate-card-live').hidden = true;
  img.hidden = false;
  delete frame.dataset.live;
  $('gate-card-visits').hidden = true;
  card.dataset.frame = String(Boolean(thumb));
  card.dataset.band = thumb?.band ?? '';
  // The ring marks a point: a field centred on one body, not a galaxy or a cluster.
  frame.dataset.ring = String(Boolean(preset));
  if (thumb) {
    const date = fmtDate(thumb.iso).replace(/\s*г\.?$/, '');
    frame.dataset.ready = 'false';
    img.onload = () => { frame.dataset.ready = 'true'; };
    img.onerror = () => { frame.hidden = true; card.dataset.frame = 'false'; };
    img.src = `${shot}.png?f=${thumb.fovArcmin}`;
    img.alt = t('card.frameAlt', { band: thumb.band, date });
    $('gate-card-tag').textContent = `${thumb.band} · ${date}`;
    blinkCard(shot, thumb);
  }

  card.hidden = false;
  // The next frame, so the card is seen arriving rather than already there.
  requestAnimationFrame(() => { if (cardHit === hit) card.dataset.on = 'true'; });
  if (focus) $('gate-card-go').focus({ preventScroll: true });
  // No stored picture: read one. A planet is left out, because the archive's
  // frames of where it is today were taken when it was somewhere else.
  if (!thumb && hit.kind !== 'planet') previewLive(hit, where);

  if (!preset) return;
  const index = await fieldIndex(preset.key);
  if (cardHit !== hit || !index?.frames?.length) return;
  const visits = groupVisits(index.frames, { ra: preset.ra, dec: preset.dec, band: preset.band ?? 'all' });
  if (visits.length < 2) return;
  const first = visits[0].mjd;
  const span = visits[visits.length - 1].mjd - first || 1;
  $('gate-card-line').replaceChildren(...visits.map((v, i) => {
    const tick = document.createElement('li');
    tick.style.setProperty('--at', ((v.mjd - first) / span).toFixed(4));
    tick.style.setProperty('--i', String(Math.min(i, 24)));
    tick.dataset.day = v.iso.slice(0, 10);
    tick.toggleAttribute('data-shown', Boolean(thumb) && v.iso.startsWith(thumb.iso.slice(0, 10)));
    return tick;
  }));
  const bands = bandsPresent(index.frames);
  where.before(cardFact(t('card.frames'), t('card.framesValue', {
    n: index.frames.length, bands: bands.length > 1 ? `${bands[0]}–${bands[bands.length - 1]}` : bands[0],
  })));
  $('gate-card-from').textContent = fmtDate(visits[0].iso).replace(/\s*г\.?$/, '');
  $('gate-card-to').textContent = fmtDate(visits[visits.length - 1].iso).replace(/\s*г\.?$/, '');
  $('gate-card-visits').hidden = false;
}

/**
 * Where a second visit of the field is stored, the card blinks the two: the
 * tool's whole idea, shown with real frames before anything is opened.
 */
function blinkCard(shot, thumb) {
  clearInterval(cardBlink);
  if (!thumb.blink || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const shots = [[`${shot}.png?f=${thumb.fovArcmin}`, thumb.iso], [`${shot}-2.png?f=${thumb.fovArcmin}`, thumb.blink]];
  const second = new Image();
  second.src = shots[1][0];
  let at = 0;
  cardBlink = setInterval(() => {
    if (!second.complete || !second.naturalWidth) return;
    at = 1 - at;
    const [src, iso] = shots[at];
    $('gate-card-img').src = src;
    $('gate-card-tag').textContent = `${thumb.band} · ${fmtDate(iso).replace(/\s*г\.?$/, '')}`;
    for (const tick of $('gate-card-line').children) {
      tick.toggleAttribute('data-shown', tick.dataset.day === iso.slice(0, 10));
    }
  }, BLINK_CARD_MS);
}

/** A star's colour in a word, from its B−V index. */
function starColour(bv) {
  return bv < 0 ? 'star.blue' : bv < 0.3 ? 'star.white' : bv < 0.6 ? 'star.yellowWhite'
    : bv < 0.9 ? 'star.yellow' : bv < 1.4 ? 'star.orange' : 'star.red';
}

/** The request behind a card's live picture, so leaving the card stops it. */
let cardLive = null;
const CARD_PX = 280;
/** As long as the card's own fade in the stylesheet. */
const CARD_LEAVE_MS = 260;
const CARD_FOV_DEG = 0.1;

/**
 * Read one real frame for a place that has none stored: ask the archive which
 * frames cover it, take the first D2 visit that fills the picture, and paint
 * it the way the plate would. Each step is said on the card while it runs.
 */
async function previewLive(hit, where) {
  const card = $('gate-card');
  const frame = $('gate-card-frame');
  const canvas = $('gate-card-live');
  const tag = $('gate-card-tag');
  const ctrl = new AbortController();
  cardLive = ctrl;
  const mine = () => cardHit === hit && !ctrl.signal.aborted;

  frame.hidden = false;
  $('gate-card-img').hidden = true;
  canvas.hidden = false;
  canvas.getContext('2d').clearRect(0, 0, CARD_PX, CARD_PX);
  card.dataset.frame = 'true';
  card.dataset.band = 'D2';
  frame.dataset.ring = 'false';
  frame.dataset.ready = 'false';
  frame.dataset.live = 'asking';
  tag.textContent = t('card.asking');

  try {
    const { frames } = await searchFrames({ ra: hit.ra, dec: hit.dec }, { signal: ctrl.signal });
    if (!mine()) return;
    const visits = groupVisits(frames, { ra: hit.ra, dec: hit.dec, band: 'D2' });
    if (!visits.length) { frame.dataset.live = 'none'; tag.textContent = t('card.noFrames'); return; }
    where.before(cardFact(t('card.bandVisits', { band: 'D2' }), String(visits.length)));

    frame.dataset.live = 'reading';
    tag.textContent = t('card.reading');
    const grid = new TangentGrid(hit.ra, hit.dec, CARD_FOV_DEG, CARD_PX, CARD_PX);
    const tried = visits.slice(0, 4);
    let failed = 0;
    for (const visit of tried) {
      const stamp = await loadStamp(toS3(visit.url), grid, { signal: ctrl.signal, minCoverage: 0.9 })
        .catch(() => { failed += 1; return null; });
      if (!mine()) return;
      if (!stamp) continue;
      const ctx = canvas.getContext('2d');
      const picture = ctx.createImageData(CARD_PX, CARD_PX);
      const { lo, hi } = limitsFromSorted(sortedFinite(stamp.data));
      paint(picture, stamp.data, rampFromToken(document.documentElement, '--cmap-deep'), {
        lo, hi, stretch: 'asinh', blankAlpha: 255, quality: stamp.quality,
      });
      ctx.putImageData(picture, 0, 0);
      frame.dataset.live = 'shown';
      frame.dataset.ready = 'true';
      tag.textContent = `D2 · ${fmtDate(visit.iso).replace(/\s*г\.?$/, '')}`;
      return;
    }
    // Every read failing is the network's doing, not the sky's.
    const unread = failed === tried.length;
    frame.dataset.live = unread ? 'failed' : 'none';
    tag.textContent = t(unread ? 'card.liveFailed' : 'card.noFrames');
  } catch {
    if (!mine()) return;
    frame.dataset.live = 'failed';
    tag.textContent = t('card.liveFailed');
  }
}

function hideCard() {
  cardLive?.abort();
  clearInterval(cardBlink);
  cardHit = null;
  gate?.select(null);
  const card = $('gate-card');
  if (card.hidden) return;
  delete card.dataset.on;
  // Hidden once it has faded, unless another card has opened in the meantime.
  setTimeout(() => { if (!cardHit) card.hidden = true; }, CARD_LEAVE_MS);
}

function wireCard() {
  $('gate-card-go').addEventListener('click', () => { if (cardHit) enterFrom(cardHit); });
  $('gate-card-close').addEventListener('click', hideCard);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('gate-card').hidden) hideCard();
  });
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
  wakeFill();
  const next = diveWaiters.shift();
  if (!next) return;
  next();
  requestAnimationFrame(releaseDiveWaiters);
}

async function enterFrom(hit) {
  if (flying) return;
  flying = true;
  hideCard();
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

/** A visit that will not arrive: it misses the field, or could not be read. */
const isGone = (v) => v.status === 'dropped' || v.status === 'failed';

/** Back out to the sky, the same way, run backwards. */
async function leaveToSky() {
  if (flying) return;
  // The address follows: the sky has no field in it.
  if (readHash().position) history.replaceState(null, '', location.pathname + location.search);
  // Opened from a link, the sky was not built while the field loaded.
  if (!gate) await ensureGate();
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
    // A link opened mid-flight has already closed the gate again.
    if (!$('gate').hidden) gate.start();
    flying = false;
    // Visits that landed while pulling back are waiting on this.
    releaseDiveWaiters();
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
  hideCard();
  document.body.dataset.gate = 'closed';
  // On a phone the page is the scroller: arrive at the top of the field, not
  // wherever the page under the sky happened to be.
  window.scrollTo(0, 0);
  $('gate').hidden = true;
  $('gate').dataset.entering = 'false';
  gate?.stop();
  if (gate) gate.zoom = null;
  sky?.resize();
}

/** The sky, built once: at once for a visit that starts on it, on the way back for one that started on a field. */
let gateBuilt = null;
const ensureGate = () => (gateBuilt ??= buildGate());

async function buildGate() {
  gate = new Gate($('gate-sky'), {
    // A press shows what was pressed. The flight starts from the card.
    onPick: (hit) => { gate.select(hit); showCard(hit); },
    onName: nameOnSky,
  });
  window.addEventListener('resize', () => { if (!$('gate').hidden) gate.resize(); });

  const [stars, deep] = await Promise.all([
    loadStars().catch(() => null),
    fetch('data/sky/deepsky.json', { signal: deadline(null, CATALOG_DEADLINE_MS) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (stars) gate.setStars(stars);
  gateDeep = deep;
  gate.setTargets(gateTargets(deep));
  // Say which layers are measured and which are drawn from a model: that
  // difference is the whole difference between this tool and a wallpaper. It
  // goes in the colophon with the other credits rather than on the sky, where
  // it was four lines of small type over the only thing worth looking at.
  state.skyLayers = { stars: Boolean(stars), deep: Boolean(deep) };
  relabel();
  gate.resize();
  // The sky was opened before it existed: boot shows the gate first and builds
  // it after, so the sweep starts here or not at all.
  if (!$('gate').hidden) gate.start();
  renderGateJump();
  // On a wide screen the sky opens with its proof beside it: the field this
  // tool was tested on, two real visits blinking. A phone has no room for both.
  const proven = state.presets.find((p) => p.key === 'atala');
  if (proven && !$('gate').hidden && !cardHit && ROOM_FOR_PROOF.matches) {
    const hit = {
      kind: 'field', key: proven.key, ra: proven.ra, dec: proven.dec, fov: proven.fov,
      band: proven.band ?? 'all', label: t(`preset.${proven.key}`),
    };
    showCard(hit);
    provenCard = hit;
  }
}

/**
 * Room for the proof beside the sky: a wide, tall screen with a mouse. A
 * phone, even one asking for the desktop site, keeps its title, search and
 * fields clear; the card it would have covered them with is one tap away.
 */
const ROOM_FOR_PROOF = matchMedia('(min-width: 60rem) and (min-height: 36rem) and (hover: hover)');
/** The card the sky opened by itself, which leaves again if the room goes. */
let provenCard = null;
ROOM_FOR_PROOF.addEventListener('change', (e) => {
  if (!e.matches && provenCard && cardHit === provenCard) hideCard();
});

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
    const hit = { kind: 'field', key: f.key, ra: f.ra, dec: f.dec, fov: f.fov, band: f.band ?? 'all', label: name };
    if (gate) {
      // The sky turns to it first; the reticle settles once it has arrived.
      gate.select(null);
      gate.lookAt(hit).then(() => gate.select(hit));
      showCard(hit, { focus: true });
      return;
    }
    // Pressed before the sky has been built: straight in, without the flight.
    if (hit.fov) { state.fov = nearestFov(hit.fov); $('fov').value = String(state.fov); }
    closeGate();
    openField(hit);
  });
  return go;
}

/* ------------------------------------------------------- search suggestions */

/** What the search boxes can offer, rebuilt when the language or the data changes. */
let suggestCache = { key: '', index: [] };

function suggestIndex() {
  const lang = getLanguage();
  const stars = gate?.stars ?? null;
  const key = `${lang}|${Boolean(stars)}|${Boolean(gateDeep)}|${state.presets.length}`;
  if (suggestCache.key !== key) {
    suggestCache = {
      key,
      index: buildIndex({ presets: state.presets, stars, deep: gateDeep, planets: planetsNow(), lang, say: tIn }),
    };
  }
  return suggestCache.index;
}

const suggestFor = (text) => suggest(text, suggestIndex());

/** A row as the sky's own hit, the same shape a press on the sky gives. */
function hitOfRow(row) {
  // Rows from beyond the page (planet hosts, SIMBAD, NED, JPL) bring their own.
  if (row.hit) return row.hit;
  const ref = row.ref;
  if (row.kind === 'target' || row.kind === 'field') {
    return { kind: 'field', key: ref.key, ra: ref.ra, dec: ref.dec, fov: ref.fov, band: ref.band ?? 'all', label: row.label };
  }
  if (row.kind === 'position') return { kind: 'sky', ra: row.ra, dec: row.dec, label: null };
  if (row.kind === 'star') {
    return {
      kind: 'star', ra: row.ra, dec: row.dec, label: row.label,
      sub: ref.name ? ref.bayer : '', mag: ref.mag, bv: ref.bv,
    };
  }
  // Planets and Messier objects are markers on the sky already: the same one.
  const key = row.kind === 'planet' ? ref.key : ref.id;
  const marker = gate?.targets?.find((m) => m.key === key && m.kind === (row.kind === 'planet' ? 'planet' : 'deep'));
  if (marker) return { ...marker, item: marker, label: row.label };
  return { kind: row.kind === 'planet' ? 'planet' : 'deep', key, ra: row.ra, dec: row.dec, label: row.label, fov: 0.3, band: 'all' };
}

/** Picked on the opening sky: the sky turns to it and its card opens. */
function pickOnSky(row) {
  const hit = hitOfRow(row);
  $('gate-target').value = row.label;
  $('gate-note').textContent = '';
  if (!gate) {
    if (hit.fov) { state.fov = nearestFov(hit.fov); $('fov').value = String(state.fov); }
    closeGate();
    openField({ ra: hit.ra, dec: hit.dec, label: hit.label ?? '', band: hit.band ?? null });
    return;
  }
  gate.select(null);
  gate.lookAt(hit).then(() => gate.select(hit));
  showCard(hit, { focus: true });
}

/** Picked in the field's header: that field opens. */
function pickInField(row) {
  const hit = hitOfRow(row);
  $('target').value = row.label;
  $('find-note').textContent = hit.note ?? '';
  if (hit.kind === 'field' && hit.fov) { state.fov = nearestFov(hit.fov); $('fov').value = String(state.fov); }
  openField({ ra: hit.ra, dec: hit.dec, label: hit.label ?? '', band: hit.kind === 'field' ? hit.band : null });
}

/* --------------------------------------------------------------------- wiring */

const MODE_HINT = { blink: 'mode.blinkHint', wipe: 'mode.wipeHint', difference: 'mode.diffHint', single: 'mode.singleHint' };

/**
 * The line under the run for a mode. The stack's says what this season adds
 * up to: how many visits, and roughly how deep — the per-visit depth of the
 * band plus what averaging those visits buys.
 */
function modeHint(mode) {
  if (mode === 'wipe' && state.reference) return referenceHint();
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

/** One step along the run: a visit, or in the stack a whole season; in Wipe and Difference, B. */
function stepBy(dir) {
  if (sky.mode === 'wipe' || sky.mode === 'difference') { stepB(dir); return; }
  holdStill();
  sky.setIndex(sky.mode === 'stack' ? stackStep(dir) : sky.index + dir);
  syncScrub();
  refreshKnownObjects();
}

/**
 * In Wipe and Difference the picture is A against B, and a step moves B
 * through the visits, round from the last to the first. B on another
 * telescope's picture comes back to a visit with the first step.
 */
function stepB(dir) {
  const n = sky.visits.length;
  if (!n) return;
  stopPlayback();
  if (state.reference) chooseReference(null);
  state.abChosen = true;
  sky.setAB(null, (((sky.b ?? 0) + dir) % n + n) % n);
  syncScrub();
  refreshKnownObjects();
}

/**
 * On a wide screen the settings open over the findings column, beside the
 * plate: under the plate they took its height, and the picture shrank at the
 * moment it was being adjusted. The stylesheet places the panel from the
 * column's own box, written here because the column's top depends on the
 * masthead's height.
 */
function placeTools() {
  const tools = $('tools');
  if (tools.hidden) return;
  const box = document.querySelector('.side--right').getBoundingClientRect();
  tools.style.setProperty('--at-x', `${box.left}px`);
  tools.style.setProperty('--at-y', `${box.top}px`);
  tools.style.setProperty('--at-w', `${box.width}px`);
  // No lower than the run strip's top: below that it covered the mode pills.
  const run = $('run');
  const floor = run && !run.hidden ? run.getBoundingClientRect().top - 8 : innerHeight - 8;
  tools.style.setProperty('--at-h', `${Math.max(160, Math.min(box.height, floor - box.top))}px`);
}

/**
 * What the plate's label carries on a desk. The field's figures close it,
 * beside the picture, where the label column had height to spare and the
 * findings column had none. The two dates the wipe and the difference compare
 * stand where the steps were: under the strip they took a row of height from
 * the plate, and the picture shrank the moment a mode was chosen. Stacked,
 * the figures go back under the finding, and play, the modes and the two
 * dates come up under the plate: at the foot of the run they sat a screen
 * below the picture they drive, and the two were never in view together.
 */
const DESK = matchMedia('(min-width: 68.0625rem) and (min-height: 34.0625rem)');

function placeLabel() {
  const facts = $('stat-line');
  const compare = $('compare');
  const deck = document.querySelector('.deck');
  if (DESK.matches) {
    $('field-pos').before(facts, compare);
    $('matrix-found').after(deck);
    $('play').after($('run-fit'));
  } else {
    $('field-cue').before(facts);
    document.querySelector('.bands').before(deck, compare);
    // The key that lets the run scroll belongs to the run, not to the picture.
    $('matrix-found').after($('run-fit'));
  }
}

function setTools(open) {
  const tools = $('tools');
  if (open) {
    tools.hidden = false;
    delete tools.dataset.leaving;
  } else if (!tools.hidden) {
    // Fades out, then steps aside; opened again meanwhile, it stays.
    tools.dataset.leaving = 'true';
    setTimeout(() => { if (tools.dataset.leaving) { tools.hidden = true; delete tools.dataset.leaving; } }, 180);
  }
  placeTools();
  // On a phone the panel opens under the plate, off the screen: bring it up.
  if (open && !matchMedia('(min-width: 68.0625rem)').matches) {
    requestAnimationFrame(() => tools.scrollIntoView({ block: 'nearest' }));
  }
  const toggle = $('tools-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = t(open ? 'tools.hide' : 'tools.toggle');
}

/* ------------------------------------------------------------------ theme */

const THEME_KEY = 'muninn.theme';
/**
 * The band in the beam colours the chrome (redesign.css keys it off
 * html[data-band]). The canvases read their colours from the same tokens, so
 * they read them again once the new hue is in place.
 */
function watchBandHue() {
  const box = $('lambda');
  if (!box) return;
  let timer = 0;
  const sync = () => {
    // While the chips are being rebuilt there is nothing to read: keep the hue.
    if (!box.children.length) return;
    const on = box.querySelector('.lambda__chip[aria-pressed="true"]');
    const band = on?.dataset.band ?? 'all';
    if (document.documentElement.dataset.band === band) return;
    document.documentElement.dataset.band = band;
    // After the hue has finished its walk (redesign.css, 700 ms), so the
    // canvases do not keep a colour from halfway along the spectrum. Every
    // change starts the wait again: the walk it follows started again too.
    const settle = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 750;
    clearTimeout(timer);
    timer = setTimeout(() => {
      sky?.readTheme();
      readRunPaint();
      drawAxis();
    }, settle);
  };
  new MutationObserver(sync).observe(box, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed'],
  });
  sync();
}

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
    b.setAttribute('aria-pressed', String(b.dataset.band === state.band));
  }
}

/* ------------------------------------------------ the field in other archives */

/** What CADC said about the open field: null, 'asking', 'failed' or a list. */
let archives = null;
/** The newest NEOSSat frame of the field, when CADC has one. */
let archivesNeossat = null;
/** The circle CADC was asked about, which every link to its search opens on. */
let archivesCircle = null;

async function loadArchives(signal) {
  const at = { ra: state.ra, dec: state.dec };
  archivesCircle = { ...at, radiusDeg: Math.min(0.3, sky.grid.spanDeg / 2) };
  archives = 'asking';
  archivesAll = false;
  renderArchives();
  try {
    const list = await fieldArchives(archivesCircle, { signal });
    if (signal?.aborted || state.ra !== at.ra || state.dec !== at.dec) return;
    archives = list.list;
    archivesNeossat = list.neossat;
  } catch {
    if (signal?.aborted) return;
    archives = 'failed';
  }
  renderArchives();
}

/** Eight archives by size at first, each with its count and its years; the rest one press away. */
const ARCHIVES_SHOWN = 8;
let archivesAll = false;
function renderArchives() {
  const box = $('archives');
  if (!box) return;
  box.hidden = archives === null;
  const list = Array.isArray(archives) ? archives : [];
  $('archives-count').textContent = list.length ? String(list.length) : '';
  $('archives-note').textContent = archives === 'asking' ? t('archives.asking')
    : archives === 'failed' ? t('archives.failed')
      : list.length ? t('archives.lede') : t('archives.none');
  const rows = list.map((a) => {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    // Each name opens that collection's observations of this field at CADC.
    const go = document.createElement('a');
    go.className = 'link facts__go archives__go';
    go.href = cadcSearchUrl(archivesCircle, a.name);
    go.target = '_blank';
    go.rel = 'noopener';
    go.textContent = a.name;
    go.setAttribute('aria-label', t('archives.go', { name: a.name }));
    dt.append(go);
    const dd = document.createElement('dd');
    const years = a.from && a.to ? (a.from === a.to ? ` · ${a.from}` : ` · ${a.from}–${a.to}`) : '';
    dd.textContent = `${fmt(a.n, 0)}${years}`;
    row.append(dt, dd);
    return row;
  });
  // Eight in view; the rest fold under a press that says how many, and fold
  // away again under "Show less".
  $('archives-list').replaceChildren(...rows.slice(0, ARCHIVES_SHOWN));
  box.querySelector('.archives__list > .fold')?.remove();
  if (rows.length > ARCHIVES_SHOWN) {
    $('archives-list').after(foldBlock(rows.slice(ARCHIVES_SHOWN), {
      outer: 'div', inner: 'dl', innerClass: 'facts',
      more: t('archives.more', { n: rows.length - ARCHIVES_SHOWN }), less: t('fold.less'),
      open: archivesAll, onToggle: (open) => { archivesAll = open; },
    }));
  }
  const link = $('archives-link');
  link.hidden = !list.length;
  if (archivesCircle) link.href = cadcSearchUrl(archivesCircle);
  renderNeossat(Array.isArray(archives) ? archivesNeossat : null);
}

/**
 * NEOSSat's newest frame of the field, as delivered: a raw frame with no sky
 * coordinates, so it is shown beside the list, not laid over the plate.
 */
function renderNeossat(n) {
  const box = $('archives-neossat');
  box.hidden = !n;
  if (!n) return;
  $('archives-neossat-img').src = n.preview;
  $('archives-neossat-img').alt = t('neossat.alt', { target: n.target ?? '' });
  $('archives-neossat-cap').textContent = t('neossat.cap', {
    date: n.iso ? fmtDate(n.iso) : '—', target: n.target ?? '—', s: n.exposure ? fmt(n.exposure, 1) : '—',
  });
  const fitsLink = $('archives-neossat-fits');
  fitsLink.hidden = !n.fits;
  if (n.fits) fitsLink.href = n.fits;
}

/* ------------------------------------- another survey beside the frame */

/** Where the picture beside the frame stands for the open field: asking, ok or failed. */
let referenceStatus = null;

/** A choice as B's list names it: `wise1`, `wise2` or `gaia`. */
const referenceValue = (ref) => (ref === 'gaia' ? 'gaia' : `wise${ref}`);
/** And back: the AllWISE band as a number, Gaia as its name, nothing as null. */
const referenceOf = (value) => (value === 'gaia' ? 'gaia' : Number(String(value).replace('wise', '')) || null);

/** The other surveys at the foot of B's list: the AllWISE pictures, then the Gaia model. */
function wiseOptions() {
  const frag = document.createDocumentFragment();
  const group = document.createElement('optgroup');
  group.label = t('ref.group');
  for (const band of [1, 2]) {
    const opt = document.createElement('option');
    opt.value = `wise${band}`;
    opt.textContent = t('ref.option', { band: WISE_BANDS[band].name, micron: fmt(WISE_BANDS[band].micron, 1) });
    group.append(opt);
  }
  const model = document.createElement('optgroup');
  model.label = t('ref.gaiaGroup');
  const opt = document.createElement('option');
  opt.value = 'gaia';
  opt.textContent = t('ref.gaiaLabel');
  model.append(opt);
  frag.append(group, model);
  return frag;
}

/**
 * Put another survey as B of the wipe — AllWISE band 1 or 2, or the Gaia
 * model ('gaia') — or take it away (null). The wipe is the one mode where two
 * instruments can sit side by side honestly: a difference across them would
 * subtract one camera's units from another's.
 */
function chooseReference(ref) {
  state.reference = ref;
  for (const radio of document.querySelectorAll('input[name="refimg"]')) {
    radio.checked = radio.value === String(ref ?? 0);
  }
  sky.setUseRef(Boolean(ref));
  if (ref) {
    if (sky.mode !== 'wipe') {
      for (const radio of document.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === 'wipe';
      applyMode('wipe');
    }
    if (sky.ref?.key !== ref && sky.grid && state.ra != null) loadReference(state.abort?.signal);
  }
  fillSlots();
  $('mode-hint').textContent = modeHint(sky.mode);
}

async function loadReference(signal) {
  const ref = state.reference;
  const grid = sky.grid;
  if (!ref || !grid) return;
  referenceStatus = 'asking';
  sky.setReference(null);
  // A new field's reset put B back on a visit; the choice still stands.
  sky.setUseRef(true);
  $('mode-hint').textContent = modeHint(sky.mode);
  try {
    const made = ref === 'gaia' ? await gaiaModel(grid, signal) : await loadWise(grid, ref, { signal });
    // Another field, or another choice, has been asked for since.
    if (signal?.aborted || sky.grid !== grid || state.reference !== ref) return;
    sky.setReference({ ...made, key: ref });
    referenceStatus = 'ok';
  } catch {
    if (signal?.aborted || sky.grid !== grid || state.reference !== ref) return;
    referenceStatus = 'failed';
  }
  $('mode-hint').textContent = modeHint(sky.mode);
}

/**
 * The Gaia sky of the field: the same Gaia DR3 rows the overlay draws (asked
 * of IRSA or MAST through the relay, so it stands when CDS is down), drawn
 * by gaiasky.js. It follows A's date: `follow` draws the stars again where
 * they stood at another visit.
 */
async function gaiaModel(grid, signal) {
  const limit = magLimit(state.fov);
  const have = sky.surveys.gaia;
  const found = have?.limit === limit
    ? have
    : await surveySources('gaia', {
      ra: state.ra, dec: state.dec, radiusDeg: searchRadius(grid.fovDeg, grid.fovHeightDeg), limit,
    }, { signal });
  const fwhm = psfFor(state.band);
  const draw = (mjd) => {
    const { limits, drawn, ...stamp } = drawGaiaSky(grid, found.rows, { mjd, fwhmArcsec: fwhm });
    return { stamp: { ...stamp, limits }, drawn, mjd };
  };
  const a = sky.visits[sky.a];
  return {
    ...draw(a?.frame.mjd), follow: draw, model: true,
    fwhm, limit: found.reached ?? limit, capped: Boolean(found.cut),
  };
}

function referenceHint() {
  if (state.reference === 'gaia') return gaiaHint();
  const { name, micron } = WISE_BANDS[state.reference];
  const words = { band: name, micron: fmt(micron, 1) };
  if (referenceStatus === 'failed') return t('ref.failed', words);
  if (referenceStatus !== 'ok' || !sky.ref) return t('ref.asking', words);
  const a = sky.visits[sky.a];
  return t('ref.hint', { ...words, date: a ? fmtDate(a.frame.iso) : '' });
}

/** What the Gaia model is, how deep and how wide, and what it is for. */
function gaiaHint() {
  if (referenceStatus === 'failed') return t('ref.gaiaFailed');
  const ref = sky.ref;
  if (referenceStatus !== 'ok' || !ref?.model) return t('ref.gaiaAsking');
  const a = sky.visits[sky.a];
  const band = state.band === 'all' ? t('ref.gaiaAnyBand') : state.band;
  const head = t('ref.gaiaHint', {
    date: a ? fmtDate(a.frame.iso) : '', n: ref.drawn, lim: fmt(ref.limit, 1), fwhm: fmt(ref.fwhm, 1), band,
  });
  const cut = ref.capped ? ` ${t('ref.gaiaCut', { cap: ROW_CAP })}` : '';
  return `${head}${cut} ${t('ref.gaiaUse')}`;
}

function applyMode(mode) {
  sky.setMode(mode);
  // A minus B is taken between two SPHEREx visits only: AllWISE or the Gaia
  // model as B would have been named in the picker while a visit was
  // subtracted. Difference goes back to a visit as B, and the picker says so.
  if (mode === 'difference' && state.reference) chooseReference(null);
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
  else { state.abChosen = true; sky.setAB(best, null); }
  syncScrub();
  refreshKnownObjects();
}

function wire() {
  $('find').addEventListener('submit', (e) => { e.preventDefault(); submitTarget($('target').value); });
  $('target').addEventListener('focus', function () { this.select(); });
  attachSuggest($('target'), { query: suggestFor, pick: pickInField, say: t });
  // The sky's search sits at the foot of the screen: its list opens upward,
  // over the title, and does not flip as it grows and shrinks.
  attachSuggest($('gate-target'), { query: suggestFor, pick: pickOnSky, say: t, up: true });
  $('gate-find').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('gate-target').value;
    if (!text.trim()) return;
    $('target').value = text;
    submitTarget(text, { note: $('gate-note'), onFound: closeGate });
  });
  $('to-sky').addEventListener('click', leaveToSky);
  document.querySelector('.brand').addEventListener('click', (e) => {
    e.preventDefault();
    leaveToSky();
  });

  $('random').addEventListener('click', () => {
    // Anywhere is fair, but low ecliptic latitude is where the traffic is.
    const ra = Math.random() * 360;
    const dec = clamp((Math.random() - 0.5) * 60, -88, 88);
    $('find-note').textContent = '';
    openField({ ra, dec, label: '' });
  });

  // A new size or band is the same field read again: the marks stay, and are
  // measured again on the new grid as its visits land.
  $('fov').addEventListener('change', (e) => {
    state.fov = Number(e.target.value);
    updateIdentity();
    reopenField();
  });
  $('band').addEventListener('change', (e) => {
    state.band = e.target.value;
    syncLambda();
    reopenField();
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

  $('slot-a').addEventListener('change', (e) => {
    state.abChosen = true;
    sky.setAB(Number(e.target.value), null);
    syncScrub();
    refreshKnownObjects();
    // The survey beside A names A's date, and the Gaia model has just moved to it.
    if (state.reference) $('mode-hint').textContent = modeHint(sky.mode);
  });
  $('compare-match').addEventListener('click', matchB);
  $('slot-b').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v.startsWith('wise') || v === 'gaia') { chooseReference(referenceOf(v)); return; }
    chooseReference(null);
    state.abChosen = true;
    sky.setAB(null, Number(v));
    syncScrub();
  });
  for (const radio of document.querySelectorAll('input[name="refimg"]')) {
    radio.addEventListener('change', (e) => { if (e.target.checked) chooseReference(referenceOf(e.target.value)); });
  }

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

  $('clear-marks').addEventListener('click', () => {
    const undo = marksUndo;
    if (undo) dropMarksUndo();
    else marksUndo = { marks: sky.marks, link: sky.link, timer: setTimeout(() => { dropMarksUndo(); renderMarks(); }, MARKS_UNDO_MS) };
    sky.marks = undo ? undo.marks : [];
    sky.link = undo ? undo.link : null;
    showMarksUndo(Boolean(marksUndo));
    sky.draw();
    renderMarks();
    writeHash();
  });
  $('mark-centre').addEventListener('click', () => {
    if (state.ra == null || !sky.visits.length) return;
    addMark(state.ra, state.dec);
    retrackMarks();
  });
  $('save-png').addEventListener('click', () => { setMore(false); savePNG(); });
  $('copy-link').addEventListener('click', (e) => copyLink(e.currentTarget));
  wireMore();
  wireNudge();

  const record = $('record');
  if (typeof MediaRecorder !== 'undefined' && sky.canvas.captureStream) {
    record.hidden = false;
    record.addEventListener('click', (e) => recordBlink(e.currentTarget));
  }

  for (const radio of document.querySelectorAll('input[name="survey"]')) {
    radio.checked = radio.value === state.survey;
    radio.addEventListener('change', (e) => { if (e.target.checked) chooseSurvey(e.target.value); });
  }

  $('tools-toggle').addEventListener('click', () => setTools($('tools').hidden));
  try { state.runScroll = localStorage.getItem('muninn.runScroll') === '1'; } catch { /* private window */ }
  $('run-fit').setAttribute('aria-pressed', String(Boolean(state.runScroll)));
  $('run-fit').addEventListener('click', () => setRunScroll(!state.runScroll));
  window.addEventListener('resize', placeTools);
  placeLabel();
  DESK.addEventListener('change', placeLabel);
  // Escape puts the findings back; so does pressing "View" again.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('tools').hidden && !$('about').open) { setTools(false); $('tools-toggle').focus(); }
  });
  $('hunt-run').addEventListener('click', () => huntField());
  // Background reading waits while the tab is hidden and while something is
  // being dragged, so the drag keeps the frame rate it had.
  document.addEventListener('visibilitychange', wakeFill);
  document.addEventListener('pointerdown', (e) => {
    if (e.target instanceof Element && e.target.closest('#sky, #scrub, #run-canvas')) state.dragging = true;
  });
  const endDrag = () => { if (state.dragging) { state.dragging = false; wakeFill(); } };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  $('plate-retry').addEventListener('click', () => {
    if (state.ra != null) openField({ ra: state.ra, dec: state.dec, label: state.label });
  });
  $('bare').addEventListener('click', () => setBare(!state.bare));
  $('restore').addEventListener('click', () => setBare(false));

  // Under the open sheet nothing else should draw: the opening sky's sweep
  // and the field's playback both redrew every frame behind it.
  let pausedUnderSheet = { sky: false, run: false };
  initRead({
    onTour: startTour,
    onOpen: () => {
      pausedUnderSheet = { sky: Boolean(gate?.running && !flying), run: state.playing };
      if (pausedUnderSheet.sky) gate.stop();
      if (pausedUnderSheet.run) stopPlayback();
    },
    onClose: () => {
      if (pausedUnderSheet.sky && !$('gate').hidden) gate.start();
      if (pausedUnderSheet.run && $('gate').hidden) startPlayback();
      pausedUnderSheet = { sky: false, run: false };
    },
  });

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

  const switchLanguage = () => {
    const next = getLanguage() === 'en' ? 'ru' : 'en';
    setLanguage(next);
    try { localStorage.setItem('muninn.lang', next); } catch { /* private window */ }
    relabel();
    writeHash();
  };
  $('lang').addEventListener('click', switchLanguage);
  $('gate-lang').addEventListener('click', switchLanguage);

  // A shared link pasted while the app is already open only changes the fragment,
  // which is a same-document navigation — without this the page would sit there.
  window.addEventListener('hashchange', () => {
    const next = readHash();
    // The language is its own thing: a link that differs only in `lang` still has
    // to switch, so it is applied before the "did the field move" shortcut.
    if (next.lang && next.lang !== getLanguage()) { setLanguage(next.lang); relabel(); }
    // Back from a field entered from the sky: the sky again, the way it came.
    if (!next.position) {
      if ($('gate').hidden && state.ra != null) leaveToSky();
      return;
    }
    if (next.survey !== state.survey) chooseSurvey(next.survey);
    if (next.mode && sky.mode !== next.mode) selectMode(next.mode);
    const moved = state.ra == null
      || Math.abs(deltaRA(next.position.ra, state.ra)) > 1e-4
      || Math.abs(next.position.dec - state.dec) > 1e-4
      || next.band !== state.band
      || (next.fov ?? state.fov) !== state.fov;
    // Forward to the field the sky was left from: it is still loaded underneath.
    if (!moved) {
      if (!$('gate').hidden && !flying) closeGate();
      return;
    }
    if (next.fov) { state.fov = nearestFov(next.fov); $('fov').value = String(state.fov); }
    $('find-note').textContent = '';
    // A link pasted into the address bar of a page that is still showing the
    // sky has to get past the sky: without this the frames load underneath it
    // and nothing appears to happen.
    closeGate();
    openField({ ...next.position, label: next.name, band: next.band, marks: next.marks, visit: next.visit });
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
    // These keys drive the plate. With the sky or the explanation in front of
    // it they stepped and replayed a field nobody could see.
    if (!$('gate').hidden || $('about').open) return;
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
  sky.labels.saturated = (name, n) => (name
    ? t('plate.saturated', { name, n: fmt(n, 0) })
    : t('plate.saturatedAnon', { n: fmt(n, 0) }));
  // A preset's name is the reader's language's; a looked-up name is SIMBAD's.
  if (state.target?.key) state.target.label = t(`preset.${state.target.key}`);
}

function relabel() {
  applyTranslations();
  relabelCue();
  relabelTour();
  if (cardHit && !$('gate-card').hidden) {
    showCard(cardHit.kind === 'field' && cardHit.key ? { ...cardHit, label: t(`preset.${cardHit.key}`) } : cardHit);
  }
  if (sky) { labelSky(); sky.draw(); }
  readRunPaint();
  labelTheme();
  const otherLanguage = getLanguage() === 'en' ? 'RU' : 'EN';
  $('lang-name').textContent = otherLanguage;
  $('gate-lang-name').textContent = otherLanguage;
  $('mode-hint').textContent = modeHint(document.querySelector('input[name="mode"]:checked').value);
  $('rate-value').textContent = t('play.fps', { n: state.rate });
  $('play').setAttribute('aria-label', t(state.playing ? 'play.pause' : 'play.play'));
  $('tools-toggle').textContent = t($('tools').hidden ? 'tools.toggle' : 'tools.hide');
  $('bare').textContent = t(state.bare ? 'view.chrome' : 'view.bare');
  // A touch screen has no pointer to move over anything, and nothing to click.
  const touch = matchMedia('(pointer: coarse)').matches;
  $('cursor-hint').textContent = t(touch ? 'readout.hintTouch' : 'readout.hint');
  $('mark-help').dataset.i18n = touch ? 'mark.helpTouch' : 'mark.help';
  $('mark-help').textContent = t($('mark-help').dataset.i18n);
  renderPresets();
  renderArchives();
  if (state.ra != null) showFieldPlanets();
  // Where the sky in the entry screen comes from, with the other credits.
  const skyCredit = [
    state.skyLayers.stars && t('credit.stars'), state.skyLayers.deep && t('credit.deep'), t('gate.modelled'),
  ].filter(Boolean).join(' · ');
  $('credit').textContent = [t('foot.short'), skyCredit].filter(Boolean).join(String.fromCharCode(10));
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
  // A link to a field: its frame list is asked for now, beside everything
  // the page still has to set up, rather than after it.
  if (hash.position) {
    searchAhead(hash.position);
    warmWorkers();
  }
  let stored = null;
  try { stored = localStorage.getItem('muninn.lang'); } catch { /* private window */ }
  // The hash for a shared field, the query for a plain link (/?lang=en), then what this browser chose before.
  const asked = hash.lang ?? new URLSearchParams(location.search).get('lang');
  setLanguage(['en', 'ru'].includes(asked) ? asked : stored ?? (navigator.language?.startsWith('ru') ? 'ru' : 'en'));
  loadExamined();

  sky = new SkyView($('sky'), {
    onHover: (sample) => updateReadout(sample ?? undefined),
    onPick: ({ ra, dec }) => { addMark(ra, dec); retrackMarks(); showLatestMark(); },
    onItem: (hit, x, y) => showTip(hit, x, y),
    // The Gaia model has moved to another visit's date; its caption names it.
    onReferenceMoved: () => { $('mode-hint').textContent = modeHint(sky.mode); },
    // Every visit has the new cut: the run's thumbnails show it too.
    onRepainted: () => { if (!$('run').hidden) drawAxis(); },
  });
  labelSky();
  // The bright stars, for what the plate says round one (sky.js drawPatches)
  // and beside a mark near one. Not waited for: a field opens without them.
  loadStars().then((stars) => {
    brightList = brightStars(stars);
    sky.setBrightStars(brightList);
    renderWhen();
  }).catch(() => {});

  if (hash.fov) state.fov = nearestFov(hash.fov);
  state.survey = hash.survey;
  state.band = hash.band;

  wire();
  wireCard();
  watchBandHue();
  $('fov').value = String(state.fov);
  relabel();
  sky.resize();
  await loadPresets();

  // A shared link goes straight to its field; anyone else starts at the sky.
  if (hash.mode) selectMode(hash.mode);
  if (hash.position) {
    closeGate();
    openField({ ...hash.position, label: hash.name, band: hash.band, pm: hash.pm, marks: hash.marks, visit: hash.visit });
  } else {
    openGate();
    setPlateState(t('status.idle'));
  }
  // A link straight to a field does not build the sky behind it: two seconds
  // of a phone's time, while the field's frames are what it came for. It is
  // built when the sky is asked for.
  if (!hash.position) ensureGate();
  offerVR();
}

/*
 * The headset's way in, offered only where the browser can run an immersive
 * VR session: on the sky, over a field, and once, in a headset's own browser,
 * as a banner. The VR code is fetched while the page is idle, so a tap asks
 * for the session at once, inside the tap, as a headset requires, and the
 * scene opens over this page on what was on the screen: the field, or the sky.
 */
const VR_BANNER_KEY = 'muninn.vrBanner';
const VR_FEATURES = ['local-floor', 'bounded-floor', 'hand-tracking'];
let vrModule = null;
let vrOpen = false;

async function offerVR() {
  if (!navigator.xr?.isSessionSupported || phoneNotHeadset(navigator.userAgent)) return;
  let ok = false;
  try { ok = await navigator.xr.isSessionSupported('immersive-vr'); } catch { /* no headset */ }
  if (!ok) return;
  for (const id of ['gate-vr', 'mast-vr', 'banner-vr']) $(id)?.addEventListener('click', enterVR);
  $('gate-vr').hidden = false;
  $('mast-vr').hidden = false;
  let seen = false;
  try { seen = localStorage.getItem(VR_BANNER_KEY) === '1'; } catch { /* private window */ }
  if (/OculusBrowser/.test(navigator.userAgent) && !seen) {
    $('vr-banner').hidden = false;
    $('banner-close').addEventListener('click', closeVrBanner);
  }
  const idle = window.requestIdleCallback ?? ((f) => setTimeout(f, 1500));
  idle(() => { vrModule ??= import('./vr/main.js'); });
}

function closeVrBanner() {
  $('vr-banner').hidden = true;
  try { localStorage.setItem(VR_BANNER_KEY, '1'); } catch { /* private window */ }
}

function enterVR() {
  if (vrOpen) return;
  // Asked for first, before anything is awaited: the session is granted only inside the tap.
  const session = navigator.xr.requestSession('immersive-vr', { optionalFeatures: VR_FEATURES });
  vrOpen = true;
  closeVrBanner();
  const onField = $('gate').hidden && state.ra != null;
  const preset = onField ? presetAt(state.ra, state.dec) : null;
  const context = !onField ? null : preset?.key
    ? { key: preset.key }
    : { ra: state.ra, dec: state.dec, fov: state.fov, band: state.band, name: state.label };
  stopPlayback();
  gate?.stop();
  const back = () => {
    vrOpen = false;
    if (!$('gate').hidden) gate?.start();
  };
  (vrModule ??= import('./vr/main.js'))
    .then((m) => m.mountVR({ session, context, lang: getLanguage(), onEnd: back }))
    .catch((err) => {
      session.then((s) => s.end()).catch(() => {});
      back();
      console.error('VR did not start', err);
    });
}

boot();

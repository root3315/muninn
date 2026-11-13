/**
 * spectrum-view.js — the spectrum block of one mark: a button, the spectrum
 * from every exposure read, the same wavelength over time, and what the
 * numbers do and do not mean.
 *
 * The block is built once per mark and refilled as exposures land, so the
 * button the reader pressed stays the same element and keeps the keyboard's
 * focus while sixty frames arrive behind it.
 */

import { t, fmt, fmtDate, fmtDay } from './i18n.js';
import {
  BANDS, WAVE_RANGE, MAX_POOL, MAX_MEASURED, RESOLVING_POWER,
  dateSpan, fluxAxis, fluxDigits, medianLine, wavelengthWindows, variability, nearSaturation, strayDetections,
} from './spectrum.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DETECTOR_ARCSEC = 6.15;
const W = 256;
const H = 156;
const PLOT = { left: 36, right: W - 8, top: 16, bottom: H - 26 };
const WAVE_TICKS = [1, 2, 3, 4, 5];
/** Two exposures further apart than this are not one moment. */
const SAME_MOMENT_DAYS = 1;

const views = new WeakMap();

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mjdToIso = (mjd) => new Date((mjd - 40587) * 86400000).toISOString();

/* ---------------------------------------------------------------- points */

/**
 * Every settled exposure as a point: where on each axis, and what kind. A
 * detection in a band where the source is mostly saturated is marked `edge`,
 * and one centred on a neighbouring source `stray`: both are drawn hollow
 * and kept out of the median and the light curve.
 */
function pointsOf(spectrum) {
  const points = spectrum.items
    .filter((i) => i.status === 'done' && i.point)
    .map((i) => ({
      key: `${i.frame.obsId}|${i.frame.band}`,
      band: i.frame.band,
      iso: i.frame.iso ?? mjdToIso(i.frame.mjd),
      mjd: i.frame.mjd,
      um: i.place.um,
      width: i.place.width,
      measured: i.place.measured,
      ra: i.measurement?.ra,
      dec: i.measurement?.dec,
      at: i.at,
      ...i.point,
    }));
  const edge = nearSaturation(points);
  const stray = strayDetections(points, { pixelArcsec: DETECTOR_ARCSEC });
  for (const p of points) {
    p.edge = p.kind === 'detection' && edge.has(p.band);
    p.stray = stray.has(p.key);
  }
  return points;
}

/**
 * What the median and the light curve may use: a stray is another source and
 * is left out; an edge detection counts as saturated.
 */
const trusted = (points) => points.filter((p) => !p.stray).map((p) => (p.edge ? { ...p, kind: 'saturated' } : p));

const fluxText = (p) => {
  if (p.kind === 'limit') return `< ${fmt(p.mJy, fluxDigits(p.mJy))}`;
  const digits = Math.max(fluxDigits(p.mJy), fluxDigits(p.err) - 2);
  return `${fmt(p.mJy, digits)} ± ${fmt(p.err, digits)}`;
};

function pointTitle(p) {
  const vars = { band: p.band, um: fmt(p.um, 3), date: fmtDate(p.iso) };
  if (p.kind === 'saturated') return t('spectrum.pointSaturated', vars);
  if (p.kind === 'limit') return t('spectrum.pointLimit', { ...vars, flux: fmt(p.mJy, fluxDigits(p.mJy)) });
  if (p.stray) return t('spectrum.pointStray', { ...vars, flux: fluxText(p) });
  return t(p.edge ? 'spectrum.pointEdge' : 'spectrum.point', { ...vars, flux: fluxText(p) });
}

/* ----------------------------------------------------------------- chart */

function svgChart(label, className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', className);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const add = (tag, attrs, text, parent = svg) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    parent.append(node);
    return node;
  };
  return { svg, add };
}

/** The flux axis: a hairline, a few round values, the unit at its head. */
function fluxScale(add, axis) {
  const y = (mJy) => PLOT.top
    + (Math.log(axis.hi / clamp(mJy, axis.lo, axis.hi)) / Math.log(axis.hi / axis.lo)) * (PLOT.bottom - PLOT.top);
  add('line', { x1: PLOT.left, y1: PLOT.top, x2: PLOT.left, y2: PLOT.bottom, class: 'spectrum__axis' });
  add('text', { x: PLOT.left - 5, y: 8, class: 'spectrum__unit', 'text-anchor': 'end' }, t('spectrum.flux'));
  for (const tick of axis.ticks) {
    add('line', { x1: PLOT.left - 3, y1: y(tick), x2: PLOT.left, y2: y(tick), class: 'spectrum__axis' });
    add('text', { x: PLOT.left - 5, y: y(tick) + 3.5, class: 'spectrum__tick', 'text-anchor': 'end' },
      fmt(tick, Math.max(0, -Math.floor(Math.log10(tick)))));
  }
  add('line', { x1: PLOT.left, y1: PLOT.bottom, x2: PLOT.right, y2: PLOT.bottom, class: 'spectrum__axis' });
  return y;
}

/**
 * One exposure on a chart: a dot with its 1σ bar, an arrow down from a 5σ
 * limit, or — saturated, so with no flux to place — a small open triangle
 * along the top edge. A point new since the last redraw fades in.
 */
function drawPoint(add, p, cx, y, fresh) {
  const g = add('g', { class: 'spectrum__pt', 'data-band': p.band, 'data-kind': p.kind });
  if (fresh) g.classList.add('spectrum__pt--new');
  add('title', {}, pointTitle(p), g);
  if (p.kind === 'saturated') {
    const top = PLOT.top - 9;
    add('path', { d: `M${cx - 3} ${top}L${cx + 3} ${top}L${cx} ${top + 5}Z` }, null, g);
  } else if (p.kind === 'limit') {
    const cy = y(p.mJy);
    add('line', { x1: cx - 2.5, y1: cy, x2: cx + 2.5, y2: cy }, null, g);
    add('line', { x1: cx, y1: cy, x2: cx, y2: cy + 6 }, null, g);
    add('path', { d: `M${cx - 2} ${cy + 5}L${cx + 2} ${cy + 5}L${cx} ${cy + 8.5}Z` }, null, g);
  } else {
    const cy = y(p.mJy);
    add('line', { x1: cx, y1: y(p.mJy + p.err), x2: cx, y2: y(Math.max(p.mJy - p.err, p.mJy / 10)) }, null, g);
    // Hollow: a wavelength that was not read, or a flux at the edge of saturation.
    add('circle', { cx, cy, r: 2.2, 'data-measured': String(p.measured && !p.edge && !p.stray) }, null, g);
  }
}

const logSpan = Math.log(WAVE_RANGE[1] / WAVE_RANGE[0]);
/** A few pixels in from the flux axis, so the shortest wavelengths do not sit on it. */
const INSET = 5;
const waveX = (um) => PLOT.left + INSET
  + (Math.log(clamp(um, ...WAVE_RANGE) / WAVE_RANGE[0]) / logSpan) * (PLOT.right - PLOT.left - INSET);

function spectrumChart(points, ranges, window, shown) {
  const axis = fluxAxis(points.filter((p) => p.kind !== 'saturated'));
  if (!axis) return null;
  const { svg, add } = svgChart(t('spectrum.chart'), 'spectrum__chart');
  const y = fluxScale(add, axis);

  // The wavelength the light curve below is drawn at, as a strip behind the points.
  if (window) {
    const x1 = waveX(window.um - window.half);
    const x2 = waveX(window.um + window.half);
    add('rect', {
      x: Math.min(x1, x2 - 2), y: PLOT.top, width: Math.max(2, x2 - x1), height: PLOT.bottom - PLOT.top,
      class: 'spectrum__window', 'data-band': window.band,
    });
  }

  // The wavelength axis is the instrument itself: each band's range in its hue.
  for (const [band, [from, to]] of ranges) {
    add('line', { x1: waveX(from), y1: PLOT.bottom, x2: waveX(to), y2: PLOT.bottom, class: 'spectrum__band', 'data-band': band });
  }
  add('text', { x: PLOT.left - 5, y: PLOT.bottom + 15, class: 'spectrum__unit', 'text-anchor': 'end' }, t('spectrum.wave'));
  for (const tick of WAVE_TICKS) {
    add('line', { x1: waveX(tick), y1: PLOT.bottom + 2, x2: waveX(tick), y2: PLOT.bottom + 5, class: 'spectrum__axis' });
    add('text', { x: waveX(tick), y: PLOT.bottom + 15, class: 'spectrum__tick', 'text-anchor': 'middle' }, String(tick));
  }

  for (const p of points) drawPoint(add, p, waveX(p.um), y, !shown.has(p.key));

  // The shape: the binned medians joined across the bands, drawn over the
  // points it summarises with a rim of the page so it reads through them.
  const line = medianLine(trusted(points));
  if (line.length >= 2) {
    const path = line.map((b) => `${waveX(b.um).toFixed(1)},${y(b.mJy).toFixed(1)}`).join(' ');
    add('polyline', { points: path, class: 'spectrum__median spectrum__median--rim' });
    add('polyline', { points: path, class: 'spectrum__median' });
  }
  return svg;
}

/** Flux against date at one wavelength: the light curve, filter held still. */
function curveChart(points, window, shown) {
  // Saturated visits alone have no flux to draw; the sentence under it says so.
  const axis = fluxAxis(points.filter((p) => p.kind !== 'saturated'));
  const span = dateSpan(points);
  if (!span || !axis) return null;
  const { svg, add } = svgChart(t('curve.chart', { um: fmt(window.um, 3) }), 'spectrum__chart spectrum__chart--curve');
  const y = fluxScale(add, axis);
  const pad = Math.max(span.days * 0.04, 0.5);
  const lo = span.from - pad;
  const hi = span.to + pad;
  const x = (mjd) => PLOT.left + 6 + ((mjd - lo) / (hi - lo)) * (PLOT.right - PLOT.left - 6);
  for (const [mjd, anchor] of [[span.from, 'start'], [span.to, 'end']]) {
    add('line', { x1: x(mjd), y1: PLOT.bottom + 2, x2: x(mjd), y2: PLOT.bottom + 5, class: 'spectrum__axis' });
    add('text', { x: x(mjd), y: PLOT.bottom + 15, class: 'spectrum__tick', 'text-anchor': anchor }, fmtDate(mjdToIso(mjd)));
  }
  for (const p of points) drawPoint(add, p, x(p.mjd), y, !shown.has(`curve|${p.key}`));
  return svg;
}

/* ------------------------------------------------------------ the bands */

function bandTable(points) {
  const tbl = el('table', 'spectrum__table');
  const head = el('tr');
  for (const key of ['spectrum.band', 'spectrum.count', 'spectrum.wave', 'spectrum.median']) {
    const th = el('th', null, t(key));
    th.scope = 'col';
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const band of BANDS) {
    const mine = points.filter((p) => p.band === band);
    if (!mine.length) continue;
    const tr = el('tr');
    tr.dataset.band = band;
    const name = el('th', 'spectrum__name', band);
    name.scope = 'row';
    const waves = mine.filter((p) => p.measured).map((p) => p.um);
    const range = waves.length ? `${fmt(Math.min(...waves), 2)}–${fmt(Math.max(...waves), 2)}` : '—';
    const fluxes = mine.filter((p) => p.kind === 'detection' && !p.edge && !p.stray).map((p) => p.mJy).sort((a, b) => a - b);
    const limits = mine.filter((p) => p.kind === 'limit').map((p) => p.mJy);
    let median;
    if (fluxes.length) median = fmt(fluxes[fluxes.length >> 1], fluxDigits(fluxes[fluxes.length >> 1]));
    else if (limits.length) median = `< ${fmt(Math.min(...limits), fluxDigits(Math.min(...limits)))}`;
    else median = t('spectrum.saturatedShort');
    tr.append(name, el('td', null, String(mine.length)), el('td', null, range), el('td', null, median));
    tbody.append(tr);
  }
  tbl.append(thead, tbody);
  return tbl;
}

/* ----------------------------------------------------------- the verdict */

/** What the visits at one wavelength say, in one sentence. */
function verdictText(v, window) {
  const vars = { um: fmt(window.um, 3), n: v.n };
  switch (v.state) {
    case 'saturated': return t('curve.saturated', { ...vars, sat: v.saturated });
    case 'few': return t('curve.few', { ...vars, det: v.detections });
    case 'varies': return v.lowerBound
      ? t('curve.variesAtLeast', { ...vars, amp: fmt(v.amp, 2) })
      : t('curve.varies', { ...vars, amp: fmt(v.amp, 2), err: fmt(v.ampErr, 2) });
    default: return t('curve.steady', { ...vars, within: fmt(v.within, 2) });
  }
}

const windowKey = (w) => `${w.band}:${w.um.toFixed(4)}`;

function curveBlock(mark, windows, points, view) {
  const block = el('div', 'spectrum__curve');
  block.append(el('p', 'spectrum__head', t('curve.head')));
  if (!windows.length) {
    block.append(el('p', 'spectrum__note', t('curve.none')));
    return { block, window: null };
  }
  const verdicts = windows.map((w) => variability(trusted(w.members)));
  // The one shown: the reader's pick, else the best-populated one that can say something.
  const usable = verdicts.findIndex((v) => v.state === 'varies' || v.state === 'steady');
  let at = windows.findIndex((w) => windowKey(w) === mark.spectrum.lambda);
  if (at < 0) at = usable >= 0 ? usable : 0;
  const window = windows[at];
  const verdict = verdicts[at];

  const chips = el('div', 'spectrum__chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', t('curve.pick'));
  windows.forEach((w, k) => {
    const chip = el('button', 'spectrum__chip', t('curve.chip', { um: fmt(w.um, 3), n: w.members.length }));
    chip.type = 'button';
    chip.dataset.band = w.band;
    chip.setAttribute('aria-pressed', String(k === at));
    chip.addEventListener('click', () => {
      if (k === at) return;
      mark.spectrum.lambda = windowKey(w);
      view.fresh = true;
      spectrumBlock(mark);
      view.root.querySelector(`.spectrum__chip[aria-pressed="true"]`)?.focus({ preventScroll: true });
    });
    chips.append(chip);
  });
  block.append(chips);

  const members = points.filter((p) => window.members.some((m) => m.key === p.key));
  const curve = curveChart(members, window, view.fresh ? new Set() : view.shown);
  if (curve) block.append(curve);
  const line = el('p', 'spectrum__verdict', verdictText(verdict, window));
  line.dataset.state = verdict.state;
  block.append(line);
  const span = dateSpan(members);
  block.append(el('p', 'spectrum__note', t('curve.window', {
    half: fmt(window.half, 3),
    um: fmt(window.um, 3),
    R: RESOLVING_POWER[window.band],
    from: fmtDate(mjdToIso(span.from)),
    to: fmtDate(mjdToIso(span.to)),
  })));
  for (const p of members) view.shown.add(`curve|${p.key}`);
  return { block, window, verdict };
}

/* --------------------------------------------------------------- caption */

/** How many, over how long, and how much that time can matter. */
function summary(spectrum, points, window, verdict) {
  const lines = [];
  const span = dateSpan(points);
  const count = (kind) => points.filter((p) => p.kind === kind).length;
  const bands = new Set(points.map((p) => p.band)).size;
  lines.push(el('p', 'spectrum__lede', t('spectrum.summary', {
    n: points.length, bands, det: count('detection'), lim: count('limit'), sat: count('saturated'),
  })));
  if (count('saturated') === points.length) {
    const all = el('p', 'spectrum__verdict', t('spectrum.allSaturated'));
    all.dataset.state = 'saturated';
    lines.push(all);
  }
  if (span && span.days > SAME_MOMENT_DAYS) {
    const apart = el('p', 'spectrum__note', t('spectrum.apart', {
      days: fmt(span.days, 0), from: fmtDate(mjdToIso(span.from)), to: fmtDate(mjdToIso(span.to)),
    }));
    apart.dataset.warn = 'true';
    lines.push(apart);
    if (verdict?.state === 'varies' || verdict?.state === 'steady') {
      lines.push(el('p', 'spectrum__note', verdict.state === 'varies'
        ? t('spectrum.apartVaries', { um: fmt(window.um, 3), amp: fmt(verdict.amp, 2) })
        : t('spectrum.apartSteady', { um: fmt(window.um, 3), within: fmt(verdict.within, 2) })));
    }
  } else if (span) {
    lines.push(el('p', 'spectrum__note', t('spectrum.close', { hours: fmt(span.days * 24, 1), from: fmtDate(mjdToIso(span.from)) })));
  }
  const edge = [...new Set(points.filter((p) => p.edge).map((p) => p.band))];
  if (edge.length) lines.push(el('p', 'spectrum__note', t('spectrum.edge', { bands: edge.join(', ') })));
  const strays = points.filter((p) => p.stray).length;
  if (strays) lines.push(el('p', 'spectrum__note', t('spectrum.stray', { n: strays })));
  if (spectrum.motion === 'moving') lines.push(el('p', 'spectrum__note', t('spectrum.moving')));
  if (spectrum.motion === 'run') lines.push(el('p', 'spectrum__note', t('spectrum.run')));
  return lines;
}

function method(spectrum) {
  const of = (s) => spectrum.items.filter((i) => i.status === s).length;
  const read = spectrum.items.length - of('waiting') - of('failed');
  const lines = [el('p', 'spectrum__note', t('spectrum.pool', {
    pool: read, measured: of('done') + of('none'), off: of('off'),
  }))];
  lines.push(el('p', 'spectrum__note', t('spectrum.method')));
  return lines;
}

/* ----------------------------------------------------------------- block */

function progress(spectrum) {
  const of = (...s) => spectrum.items.filter((i) => s.includes(i.status)).length;
  if (spectrum.phase === 'waves') {
    const total = spectrum.items.length;
    return { label: t('spectrum.readingWaves', { done: total - of('waiting'), total }), share: (total - of('waiting')) / Math.max(1, total) / 2 };
  }
  const total = of('queued', 'reading', 'done', 'none', 'failed');
  const done = of('done', 'none', 'failed');
  return { label: t('spectrum.reading', { done, total }), share: 0.5 + done / Math.max(1, total) / 2 };
}

function buttonLabel(spectrum) {
  if (!spectrum) return t('spectrum.read');
  if (spectrum.busy) return progress(spectrum).label;
  const failed = spectrum.items.filter((i) => i.status === 'failed').length;
  return failed ? t('spectrum.retry', { n: failed }) : t('spectrum.again');
}

function create(onRead) {
  const root = el('div', 'spectrum');
  const button = el('button', 'again spectrum__read');
  button.type = 'button';
  // Busy is said with aria-disabled, not `disabled`: a disabled button drops
  // the focus of whoever just pressed it.
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') !== 'true') onRead();
  });
  // The share of the reading done, as a hairline under the button; it stays
  // the same element so its width can glide from one count to the next.
  const bar = el('div', 'spectrum__progress');
  bar.setAttribute('aria-hidden', 'true');
  const body = el('div', 'spectrum__body');
  root.append(button, bar, body);
  return { root, button, bar, body, shown: new Set(), fresh: false };
}

/**
 * The spectrum block of a mark, filled from `mark.spectrum`. Calling it again
 * for the same mark refills the same element.
 */
export function spectrumBlock(mark, onRead) {
  let view = views.get(mark);
  if (!view) { view = create(onRead); views.set(mark, view); }
  const { spectrum } = mark;
  const busy = Boolean(spectrum?.busy);

  view.button.textContent = buttonLabel(spectrum);
  view.button.dataset.busy = String(busy);
  view.button.setAttribute('aria-disabled', String(busy));
  view.root.setAttribute('aria-busy', String(busy));
  view.bar.dataset.on = String(busy);
  view.bar.style.setProperty('--done', busy ? String(progress(spectrum).share) : '1');

  if (!spectrum) {
    view.body.replaceChildren(el('p', 'spectrum__note', t('spectrum.hint', { pool: MAX_POOL, max: MAX_MEASURED })));
    return view.root;
  }
  const points = pointsOf(spectrum);
  if (!points.length) {
    const quiet = busy ? null : el('p', 'spectrum__note', t('spectrum.nothing'));
    view.body.replaceChildren(...[quiet, ...(busy ? [] : method(spectrum))].filter(Boolean));
    return view.root;
  }

  // Windows are found among the points with a wavelength the file gave.
  const windows = wavelengthWindows(points.filter((p) => !p.stray), { max: 3, minCount: 3 });
  const curve = curveBlock(mark, windows, points, view);
  const ranges = new Map();
  for (const item of spectrum.items) {
    const { band, emMin, emMax } = item.frame;
    if (!Number.isFinite(emMin) || !Number.isFinite(emMax)) continue;
    const r = ranges.get(band) ?? [emMin, emMax];
    ranges.set(band, [Math.min(r[0], emMin), Math.max(r[1], emMax)]);
  }
  const chart = spectrumChart(points, ranges, curve.window, view.fresh ? new Set(points.map((p) => p.key)) : view.shown);
  for (const p of points) view.shown.add(p.key);
  view.fresh = false;

  view.body.replaceChildren(...[
    chart,
    ...summary(spectrum, points, curve.window, curve.verdict),
    bandTable(points),
    curve.block,
    ...(busy ? [] : method(spectrum)),
  ].filter(Boolean));
  return view.root;
}

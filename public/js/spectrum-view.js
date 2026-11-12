/**
 * spectrum-view.js — the spectrum block of one mark: a button, a chart, the
 * numbers under it and what they do and do not mean.
 *
 * The block is built once per mark and refilled as bands land, so the button
 * the reader pressed stays the same element and keeps the keyboard's focus
 * while six frames arrive behind it.
 */

import { t, fmt, fmtDate, fmtDay } from './i18n.js';
import { WAVE_RANGE, dateSpan, fluxAxis, fluxDigits } from './spectrum.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 240;
const H = 148;
const PLOT = { left: 36, right: W - 8, top: 14, bottom: H - 26 };
const WAVE_TICKS = [1, 2, 3, 4, 5];

const views = new WeakMap();

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mjdToIso = (mjd) => new Date((mjd - 40587) * 86400000).toISOString();

/**
 * A flux and its error to matching decimals: three figures of the flux, or as
 * many as it takes for the error to show one of its own.
 */
const fluxText = (point) => {
  if (point.kind === 'limit') return `< ${fmt(point.mJy, fluxDigits(point.mJy))}`;
  const digits = Math.max(fluxDigits(point.mJy), fluxDigits(point.err) - 2);
  return `${fmt(point.mJy, digits)} ± ${fmt(point.err, digits)}`;
};

/** A read wavelength to the nanometre; an unread one as the band's range. */
const waveText = (place) => (place.measured
  ? fmt(place.um, 3)
  : `${fmt(place.from, 2)}–${fmt(place.to, 2)}`);

const pointTitle = (row) => t(row.point.kind === 'limit' ? 'spectrum.pointLimit' : 'spectrum.point', {
  band: row.band,
  um: waveText(row.place),
  flux: row.point.kind === 'limit' ? fmt(row.point.mJy, fluxDigits(row.point.mJy)) : fluxText(row.point),
  date: fmtDate(row.frame.iso),
});

/* ----------------------------------------------------------------- chart */

function chart(rows) {
  const done = rows.filter((r) => r.status === 'done');
  const axis = fluxAxis(done.map((r) => r.point));
  if (!axis) return null;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'spectrum__chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('spectrum.chart'));
  const add = (tag, attrs, text, parent = svg) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    parent.append(node);
    return node;
  };

  const logSpan = Math.log(WAVE_RANGE[1] / WAVE_RANGE[0]);
  const x = (um) => PLOT.left
    + (Math.log(clamp(um, ...WAVE_RANGE) / WAVE_RANGE[0]) / logSpan) * (PLOT.right - PLOT.left);
  const y = (mJy) => PLOT.top
    + (Math.log(axis.hi / clamp(mJy, axis.lo, axis.hi)) / Math.log(axis.hi / axis.lo)) * (PLOT.bottom - PLOT.top);

  // The flux axis: a hairline, a few round values, the unit at its head.
  add('line', { x1: PLOT.left, y1: PLOT.top, x2: PLOT.left, y2: PLOT.bottom, class: 'spectrum__axis' });
  add('text', { x: PLOT.left - 5, y: 8, class: 'spectrum__unit', 'text-anchor': 'end' }, t('spectrum.flux'));
  for (const tick of axis.ticks) {
    add('line', { x1: PLOT.left - 3, y1: y(tick), x2: PLOT.left, y2: y(tick), class: 'spectrum__axis' });
    add('text', { x: PLOT.left - 5, y: y(tick) + 3.5, class: 'spectrum__tick', 'text-anchor': 'end' },
      fmt(tick, Math.max(0, -Math.floor(Math.log10(tick)))));
  }

  // The wavelength axis is the instrument itself: each band's range in its hue.
  add('line', { x1: PLOT.left, y1: PLOT.bottom, x2: PLOT.right, y2: PLOT.bottom, class: 'spectrum__axis' });
  for (const row of rows) {
    if (!row.range) continue;
    add('line', {
      x1: x(row.range[0]), y1: PLOT.bottom, x2: x(row.range[1]), y2: PLOT.bottom,
      class: 'spectrum__band', 'data-band': row.band,
    });
  }
  add('text', { x: PLOT.left - 5, y: PLOT.bottom + 15, class: 'spectrum__unit', 'text-anchor': 'end' }, t('spectrum.wave'));
  for (const tick of WAVE_TICKS) {
    add('line', { x1: x(tick), y1: PLOT.bottom + 2, x2: x(tick), y2: PLOT.bottom + 5, class: 'spectrum__axis' });
    add('text', { x: x(tick), y: PLOT.bottom + 15, class: 'spectrum__tick', 'text-anchor': 'middle' }, String(tick));
  }

  for (const row of done) {
    const { point, place } = row;
    const g = add('g', { class: 'spectrum__pt', 'data-band': row.band, 'data-kind': point.kind });
    add('title', {}, pointTitle(row), g);
    const cx = x(place.um);
    const cy = y(point.mJy);
    // Across: the bandpass at that pixel, or the whole band when no wavelength
    // could be read. Never narrower than a mark the eye can find.
    const x1 = Math.min(x(place.from), cx - (point.kind === 'limit' ? 4 : 0));
    const x2 = Math.max(x(place.to), cx + (point.kind === 'limit' ? 4 : 0));
    add('line', { x1, y1: cy, x2, y2: cy }, null, g);
    if (point.kind === 'limit') {
      add('line', { x1: cx, y1: cy, x2: cx, y2: cy + 9 }, null, g);
      add('path', { d: `M${cx - 3} ${cy + 8}L${cx + 3} ${cy + 8}L${cx} ${cy + 13}Z` }, null, g);
    } else {
      add('line', { x1: cx, y1: y(point.mJy + point.err), x2: cx, y2: y(point.mJy - point.err) }, null, g);
      // A wavelength that was not read is drawn hollow: a place-holder, not a measurement.
      add('circle', { cx, cy, r: 3, 'data-measured': String(place.measured) }, null, g);
    }
  }
  return svg;
}

/* ----------------------------------------------------------------- table */

const ROW_STATE = {
  waiting: 'spectrum.rowWaiting',
  reading: 'spectrum.rowReading',
  failed: 'spectrum.rowFailed',
  none: 'spectrum.rowNone',
  absent: 'spectrum.rowAbsent',
};

function table(rows) {
  const tbl = el('table', 'spectrum__table');
  const head = el('tr');
  for (const key of ['spectrum.band', 'spectrum.wave', 'spectrum.flux', 'spectrum.date']) {
    const th = el('th', null, t(key));
    th.scope = 'col';
    head.append(th);
  }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    tr.dataset.band = row.band;
    tr.dataset.state = row.status;
    const band = el('th', 'spectrum__name', row.band);
    band.scope = 'row';
    tr.append(band);
    if (row.status === 'done') {
      const date = el('td', null, fmtDay(row.frame.iso));
      date.title = fmtDate(row.frame.iso);
      tr.append(el('td', null, waveText(row.place)), el('td', null, fluxText(row.point)), date);
    } else {
      const state = el('td', 'spectrum__state', t(ROW_STATE[row.status]));
      state.colSpan = 3;
      tr.append(state);
    }
    tbody.append(tr);
  }
  tbl.append(thead, tbody);
  return tbl;
}

/* --------------------------------------------------------------- caption */

/** When the points were taken: the one thing that can make the chart mislead. */
function datesLine(spectrum, done) {
  const span = dateSpan(done.map((r) => r.frame));
  if (!span || done.length < 2) return null;
  const vars = {
    ref: fmtDate(spectrum.ref.iso),
    from: fmtDate(mjdToIso(span.from)),
    to: fmtDate(mjdToIso(span.to)),
    days: fmt(span.days, 1),
    hours: fmt(span.days * 24, 1),
  };
  const apart = span.days > 1;
  const p = el('p', 'spectrum__note', t(apart ? 'spectrum.datesApart' : 'spectrum.datesClose', vars));
  p.dataset.warn = String(apart);
  return p;
}

function caption(spectrum) {
  const done = spectrum.rows.filter((r) => r.status === 'done');
  if (!done.length) return [];
  const lines = [datesLine(spectrum, done)];
  const guessed = done.filter((r) => !r.place.measured).map((r) => r.band);
  if (guessed.length < done.length) lines.push(el('p', 'spectrum__note', t('spectrum.waveRead')));
  if (guessed.length) lines.push(el('p', 'spectrum__note', t('spectrum.waveMissing', { bands: guessed.join(', ') })));
  lines.push(el('p', 'spectrum__note', t('spectrum.method')));
  return lines.filter(Boolean);
}

/* ----------------------------------------------------------------- block */

function buttonLabel(spectrum) {
  if (!spectrum) return t('spectrum.read');
  const total = spectrum.rows.filter((r) => r.status !== 'absent').length;
  const settled = spectrum.rows.filter((r) => ['done', 'none', 'failed'].includes(r.status)).length;
  if (spectrum.busy) return t('spectrum.reading', { done: settled, total });
  const failed = spectrum.rows.filter((r) => r.status === 'failed').length;
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
  const body = el('div', 'spectrum__body');
  root.append(button, body);
  return { root, button, body };
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

  if (!spectrum) {
    view.body.replaceChildren(el('p', 'spectrum__note', t('spectrum.hint')));
    return view.root;
  }
  view.body.replaceChildren(...[chart(spectrum.rows), table(spectrum.rows), ...caption(spectrum)].filter(Boolean));
  return view.root;
}

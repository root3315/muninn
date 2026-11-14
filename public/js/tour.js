/**
 * tour.js — a walk round the field screen, one part at a time.
 *
 * The rest of the page dims under a scrim with a cut-out round the part in
 * question, and a small card beside it says what it is. "Got it" moves on;
 * "Not clear" opens a longer word, a short clip when one has been put in
 * video/tour/, and a way into the matching card of How to read this.
 *
 * It runs on the first field opened after the page loads, and not again in
 * that page load: the state is this module's, so a reload brings it back and
 * a return from another page through the back-forward cache does not.
 * The cut-out is one element whose shadow is the scrim; moving it is a
 * transform and a size, nothing redrawn per frame.
 */

import { t } from './i18n.js';
import { openRead } from './read.js';

const $ = (id) => document.getElementById(id);

/** The modes and Play; on a phone the deck is unboxed under the picture, so the modes alone. */
function modes() {
  const deck = document.querySelector('.deck');
  return deck?.getClientRects().length ? deck : deck?.querySelector('.segments');
}

const STEPS = [
  { key: 'plate', find: () => $('plate'), read: 'read-blink' },
  { key: 'modes', find: modes, read: 'read-modes' },
  { key: 'bands', find: () => document.querySelector('.bands'), read: 'read-spectrum' },
  { key: 'run', find: () => $('run-scroll'), read: 'read-run' },
  { key: 'marks', find: () => $('marks')?.closest('.part'), read: 'read-mark' },
  { key: 'depth', find: () => $('depth'), read: 'read-depth' },
  { key: 'hunt', find: () => $('hunt'), read: 'read-hunt' },
  { key: 'view', find: () => $('tools-toggle'), read: 'read-overlay' },
  // On a phone the link is folded under "⋯"; the tour points at the fold and says so.
  {
    key: 'link', find: () => (shown($('copy-link')) ? $('copy-link') : $('more-key')), read: null,
    words: (el) => (el?.id === 'more-key' ? 'linkFold' : 'link'),
  },
];

const PAD = 8;
const GAP = 14;
const PHONE = window.matchMedia('(max-width: 720px)');
const STILL = window.matchMedia('(prefers-reduced-motion: reduce)');

let ran = false;
let ui = null;
let steps = [];
let at = 0;
let expanded = false;
let returnTo = null;
let frame = 0;

function shown(el) {
  return Boolean(el && !el.closest('[hidden]') && el.getClientRects().length);
}

function build() {
  const root = document.createElement('div');
  root.className = 'tour';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'tour-title');
  root.innerHTML = `
    <div class="tour__hole" aria-hidden="true"></div>
    <section class="tour__card" tabindex="-1">
      <div class="tour__head">
        <span class="tour__count num"></span>
        <span class="tour__pips" aria-hidden="true"></span>
        <button type="button" class="link tour__skip"></button>
      </div>
      <div class="tour__body" aria-live="polite">
        <h2 class="tour__title" id="tour-title"></h2>
        <p class="tour__say"></p>
        <div class="tour__more" id="tour-more" hidden>
          <p class="tour__more-text"></p>
          <video class="tour__clip" muted loop playsinline preload="none" hidden></video>
          <button type="button" class="link tour__read"></button>
        </div>
      </div>
      <div class="tour__acts">
        <button type="button" class="btn btn--primary tour__next"></button>
        <button type="button" class="btn btn--quiet tour__toggle" aria-expanded="false" aria-controls="tour-more"></button>
      </div>
    </section>`;
  document.body.append(root);
  const q = (sel) => root.querySelector(sel);
  ui = {
    root, hole: q('.tour__hole'), card: q('.tour__card'), count: q('.tour__count'), pips: q('.tour__pips'),
    skip: q('.tour__skip'), title: q('.tour__title'), say: q('.tour__say'), more: q('.tour__more'),
    moreText: q('.tour__more-text'), clip: q('.tour__clip'), read: q('.tour__read'),
    next: q('.tour__next'), toggle: q('.tour__toggle'),
  };
  ui.next.addEventListener('click', () => go(at + 1));
  ui.skip.addEventListener('click', end);
  ui.toggle.addEventListener('click', () => setExpanded(!expanded));
  ui.read.addEventListener('click', () => { const id = steps[at]?.read; if (id) openRead(id); });
  root.addEventListener('keydown', trap);
}

/** Keys while the tour is up: Esc leaves, arrows step, nothing reaches the field. */
function onKey(e) {
  if (!ui || ui.root.hidden || $('about')?.open) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(at + 1); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); if (at > 0) go(at - 1); return; }
  if (!ui.root.contains(e.target)) e.stopPropagation();
}

function trap(e) {
  if (e.key !== 'Tab') return;
  const stops = [...ui.card.querySelectorAll('button')].filter((b) => b.getClientRects().length);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function setExpanded(on) {
  expanded = on;
  const step = steps[at];
  ui.more.hidden = !on;
  ui.toggle.setAttribute('aria-expanded', String(on));
  ui.toggle.textContent = t(on ? 'tour.less' : 'tour.more');
  if (on) loadClip(step.key);
  else ui.clip.pause();
  schedule();
}

/** A short clip for this step, shown only if the file is there. */
function loadClip(key) {
  const clip = ui.clip;
  if (clip.dataset.key === key) {
    if (!clip.hidden && !STILL.matches) clip.play().catch(() => {});
    return;
  }
  clip.dataset.key = key;
  clip.hidden = true;
  clip.controls = STILL.matches;
  clip.onloadeddata = () => {
    if (clip.dataset.key !== key) return;
    clip.hidden = false;
    if (!STILL.matches) clip.play().catch(() => {});
    schedule();
  };
  clip.onerror = () => { clip.hidden = true; };
  // Only clips that exist are asked for: a missing one was a 404 in the
  // console of every visitor who pressed "Not clear".
  if (!TOUR_CLIPS.has(key)) { clip.hidden = true; return; }
  clip.preload = 'auto';
  clip.src = `video/tour/${key}.webm`;
}

/** The steps that have a clip in public/video/tour/<key>.webm. */
const TOUR_CLIPS = new Set([]);

function render() {
  const step = steps[at];
  const last = at === steps.length - 1;
  ui.root.setAttribute('aria-label', t('tour.label'));
  ui.count.textContent = t('tour.count', { n: at + 1, total: steps.length });
  ui.pips.replaceChildren(...steps.map((_, i) => {
    const pip = document.createElement('span');
    if (i <= at) pip.className = 'is-done';
    return pip;
  }));
  ui.skip.textContent = t('tour.skip');
  const words = step.words?.(step.el) ?? step.key;
  ui.title.textContent = t(`tour.${words}H`);
  ui.say.textContent = t(`tour.${words}P`);
  ui.moreText.textContent = t(`tour.${words}More`);
  ui.read.hidden = !step.read;
  ui.read.textContent = t('tour.read');
  ui.next.textContent = t(last ? 'tour.finish' : 'tour.next');
  ui.toggle.textContent = t(expanded ? 'tour.less' : 'tour.more');
  ui.card.classList.remove('is-fresh');
  void ui.card.offsetWidth;
  ui.card.classList.add('is-fresh');
}

/** Where the cut-out and the card go, from where the part is now. */
function place() {
  frame = 0;
  if (!ui || ui.root.hidden) return;
  const el = steps[at]?.el;
  if (!el) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = el.getBoundingClientRect();
  const x = Math.max(4, r.left - PAD);
  const y = Math.max(4, r.top - PAD);
  const w = Math.min(vw - 4, r.right + PAD) - x;
  const h = Math.min(vh - 4, r.bottom + PAD) - y;
  ui.hole.style.transform = `translate(${x}px, ${y}px)`;
  ui.hole.style.inlineSize = `${Math.max(0, w)}px`;
  ui.hole.style.blockSize = `${Math.max(0, h)}px`;
  if (PHONE.matches) return;

  const cw = ui.card.offsetWidth;
  const ch = ui.card.offsetHeight;
  const clampX = (v) => Math.min(Math.max(GAP, v), vw - cw - GAP);
  const clampY = (v) => Math.min(Math.max(GAP, v), vh - ch - GAP);
  let cx;
  let cy;
  if (vw - (x + w) >= cw + 2 * GAP) { cx = x + w + GAP; cy = clampY(y); }
  else if (x >= cw + 2 * GAP) { cx = x - cw - GAP; cy = clampY(y); }
  else if (vh - (y + h) >= ch + 2 * GAP) { cx = clampX(x); cy = y + h + GAP; }
  else if (y >= ch + 2 * GAP) { cx = clampX(x); cy = y - ch - GAP; }
  else {
    // No side has the room (a phone on its side): the corner of the screen
    // where the card covers least of the part.
    const covers = ([px, py]) => Math.max(0, Math.min(px + cw, x + w) - Math.max(px, x))
      * Math.max(0, Math.min(py + ch, y + h) - Math.max(py, y));
    const corners = [[vw - cw - GAP, GAP], [vw - cw - GAP, vh - ch - GAP], [GAP, GAP], [GAP, vh - ch - GAP]]
      .map(([px, py]) => [clampX(px), clampY(py)]);
    [cx, cy] = corners.reduce((best, c) => (covers(c) < covers(best) ? c : best));
  }
  ui.card.style.transform = `translate(${Math.round(cx)}px, ${Math.round(cy)}px)`;
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(place);
}

function go(i) {
  if (i >= steps.length) { end(); return; }
  at = i;
  const step = steps[at];
  // The part may have been folded away since the tour began.
  step.el = step.find();
  if (!shown(step.el)) { steps.splice(at, 1); if (at >= steps.length) { end(); return; } go(at); return; }
  if (expanded) setExpanded(false);
  render();
  step.el.style.scrollMarginTop = PHONE.matches ? '16px' : '';
  // A part taller than most of the screen is shown from its heading down.
  const tall = step.el.getBoundingClientRect().height > window.innerHeight * 0.6;
  step.el.scrollIntoView({ block: PHONE.matches || tall ? 'start' : 'nearest', inline: 'nearest', behavior: STILL.matches ? 'auto' : 'smooth' });
  schedule();
  // A smooth scroll can end without a last scroll event; look again once it has settled.
  setTimeout(schedule, 500);
  setTimeout(schedule, 1100);
  ui.next.focus({ preventScroll: true });
}

/** Begin the tour now, whatever has happened before. */
export function startTour() {
  if (!ui) build();
  steps = STEPS.map((s) => ({ ...s, el: s.find() })).filter((s) => shown(s.el));
  if (!steps.length) return;
  ran = true;
  returnTo = document.activeElement;
  expanded = false;
  ui.root.hidden = false;
  ui.root.classList.add('is-entering');
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule);
  go(0);
  place();
  requestAnimationFrame(() => ui.root.classList.remove('is-entering'));
}

function end() {
  if (!ui || ui.root.hidden) return;
  ui.root.hidden = true;
  ui.clip.pause();
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('scroll', schedule, { capture: true });
  window.removeEventListener('resize', schedule);
  for (const s of steps) if (s.el) s.el.style.scrollMarginTop = '';
  if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus({ preventScroll: true });
}

/** On a change of language, the card follows. */
export function relabelTour() {
  if (ui && !ui.root.hidden) { render(); schedule(); }
}

/** Called when a field has finished opening: the first time in this page load, the tour starts. */
export function maybeStartTour() {
  if (ran) return;
  if (!$('gate')?.hidden || $('about')?.open) return;
  ran = true;
  // After the frame that shows the field, so every part has its size.
  setTimeout(() => {
    if (!$('gate')?.hidden || $('about')?.open) { ran = false; return; }
    startTour();
  }, 700);
}

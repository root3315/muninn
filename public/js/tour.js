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
import { openRead, mountDemo } from './read.js';

const $ = (id) => document.getElementById(id);

/** The modes and Play; on a phone the deck is unboxed under the picture, so the modes alone. */
function modes() {
  const deck = document.querySelector('.deck');
  return deck?.getClientRects().length ? deck : deck?.querySelector('.segments');
}

const STEPS = [
  { key: 'plate', find: () => $('plate'), read: 'read-blink' },
  { key: 'rings', find: () => $('plate'), read: 'read-ring' },
  { key: 'modes', find: modes, read: 'read-modes' },
  { key: 'bands', find: () => document.querySelector('.bands'), read: 'read-spectrum' },
  { key: 'run', find: () => $('run-scroll'), read: 'read-run' },
  { key: 'marks', find: () => $('marks')?.closest('.part'), read: 'read-mark' },
  { key: 'depth', find: () => $('depth'), read: 'read-depth' },
  { key: 'hunt', find: () => $('hunt'), read: 'read-hunt' },
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
/** The live demo in the open "Not clear", if any. */
let demo = null;
/** Whether the current part has been scrolled back into view after a shift. */
let nudged = false;
/** Watches the current part and its neighbours, which can push it about as they fill in. */
const shifts = 'ResizeObserver' in window ? new ResizeObserver(() => { nudged = false; schedule(); }) : null;

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
        <div class="tour__more" id="tour-more" tabindex="-1" hidden>
          <div class="tour__more-head">
            <p class="tour__more-text"></p>
            <button type="button" class="tour__more-x"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
          </div>
          <div class="tour__demo is-on"></div>
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
    demo: q('.tour__demo'), moreX: q('.tour__more-x'),
    next: q('.tour__next'), toggle: q('.tour__toggle'),
  };
  ui.next.addEventListener('click', () => go(at + 1));
  ui.skip.addEventListener('click', end);
  ui.toggle.addEventListener('click', () => setExpanded(!expanded));
  ui.moreX.addEventListener('click', () => { setExpanded(false); ui.toggle.focus(); });
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
  const stops = [...ui.card.querySelectorAll('button, input, [tabindex="0"]')].filter((b) => b.getClientRects().length);
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
  if (on) {
    loadClip(step.key);
    // The same small demo as the matching card of How to read this.
    demo = step.read ? mountDemo(step.read, ui.demo) : null;
    ui.demo.hidden = !demo;
    ui.more.focus({ preventScroll: true });
  } else {
    ui.clip.pause();
    ui.demo.replaceChildren();
    demo = null;
  }
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
  const words = step.key;
  ui.title.textContent = t(`tour.${words}H`);
  ui.say.textContent = t(`tour.${words}P`);
  ui.moreText.textContent = t(`tour.${words}More`);
  ui.read.hidden = !step.read;
  ui.read.textContent = t('tour.read');
  ui.moreX.setAttribute('aria-label', t('tour.demoClose'));
  demo?.relabel();
  ui.next.textContent = t(last ? 'tour.finish' : 'tour.next');
  ui.toggle.textContent = t(expanded ? 'tour.less' : 'tour.more');
  ui.card.classList.remove('is-fresh');
  void ui.card.offsetWidth;
  ui.card.classList.add('is-fresh');
}

/**
 * The part of an element that can be seen: its box cut by every ancestor that
 * clips it. A panel in the scrolling side column runs on below the column's
 * edge, and its whole box would light the strip beneath.
 */
function visibleBox(el) {
  let { left, top, right, bottom } = el.getBoundingClientRect();
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    const clipX = cs.overflowX !== 'visible';
    const clipY = cs.overflowY !== 'visible';
    if (!clipX && !clipY) continue;
    const c = p.getBoundingClientRect();
    if (clipX) { left = Math.max(left, c.left); right = Math.min(right, c.right); }
    if (clipY) { top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); }
  }
  return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
}

/** Whether two boxes ({x, y, w, h}) share any area. */
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Where the card goes beside the cut-out: a side with room, else the corner covering least. */
function cardSpot(hole, cw, ch, vw, vh) {
  const { x, y, w, h } = hole;
  const clampX = (v) => Math.min(Math.max(GAP, v), vw - cw - GAP);
  const clampY = (v) => Math.min(Math.max(GAP, v), vh - ch - GAP);
  if (vw - (x + w) >= cw + 2 * GAP) return [x + w + GAP, clampY(y)];
  if (x >= cw + 2 * GAP) return [x - cw - GAP, clampY(y)];
  if (vh - (y + h) >= ch + 2 * GAP) return [clampX(x), y + h + GAP];
  if (y >= ch + 2 * GAP) return [clampX(x), y - ch - GAP];
  const covers = ([px, py]) => Math.max(0, Math.min(px + cw, x + w) - Math.max(px, x))
    * Math.max(0, Math.min(py + ch, y + h) - Math.max(py, y));
  const corners = [[vw - cw - GAP, GAP], [vw - cw - GAP, vh - ch - GAP], [GAP, GAP], [GAP, vh - ch - GAP]]
    .map(([px, py]) => [clampX(px), clampY(py)]);
  return corners.reduce((best, c) => (covers(c) < covers(best) ? c : best));
}

/** Cut the hole back so the card never sits on it, keeping the larger part in view. */
function trimHole(hole, card) {
  if (!overlaps(hole, card)) return hole;
  const above = card.y - GAP - hole.y;
  const below = hole.y + hole.h - (card.y + card.h + GAP);
  if (above >= below) return { ...hole, h: Math.max(0, above) };
  return { ...hole, y: card.y + card.h + GAP, h: Math.max(0, below) };
}

/** Where the cut-out and the card go, from where the part is now. */
function place() {
  frame = 0;
  if (!ui || ui.root.hidden) return;
  const el = steps[at]?.el;
  if (!el) return;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const r = visibleBox(el);
  // Something above it grew (a list filling in) and pushed it out of view: bring it back once.
  if (r.bottom - r.top < Math.min(el.offsetHeight, 48) && !nudged) {
    nudged = true;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    schedule();
    return;
  }
  // Whole pixels: a huge spread shadow at a fractional edge leaves hairline
  // seams running the width of the page.
  const x = Math.round(Math.max(4, r.left - PAD));
  const y = Math.round(Math.max(4, r.top - PAD));
  let hole = { x, y, w: Math.round(Math.min(vw - 4, r.right + PAD)) - x, h: Math.round(Math.min(vh - 4, r.bottom + PAD)) - y };
  let card;
  if (PHONE.matches) {
    const box = ui.card.getBoundingClientRect();
    card = { x: box.left, y: box.top, w: box.width, h: box.height };
  } else {
    const cw = ui.card.offsetWidth;
    const ch = ui.card.offsetHeight;
    const [cx, cy] = cardSpot(hole, cw, ch, vw, vh).map(Math.round);
    card = { x: cx, y: cy, w: cw, h: ch };
    ui.card.style.transform = `translate(${cx}px, ${cy}px)`;
  }
  hole = trimHole(hole, card);
  ui.hole.style.transform = `translate(${hole.x}px, ${hole.y}px)`;
  ui.hole.style.inlineSize = `${Math.max(0, hole.w)}px`;
  ui.hole.style.blockSize = `${Math.max(0, hole.h)}px`;
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
  nudged = false;
  shifts?.disconnect();
  for (const el of [step.el, ...(step.el.parentElement?.children ?? [])]) shifts?.observe(el);
  // A part taller than most of the screen is shown from its heading down; when
  // the card cannot stand beside it, the heading lands just under the card.
  const box = step.el.getBoundingClientRect();
  const tall = box.height > window.innerHeight * 0.6;
  const cw = ui.card.offsetWidth + 2 * GAP;
  const besideRoom = document.documentElement.clientWidth - box.right >= cw || box.left >= cw;
  step.el.style.scrollMarginTop = PHONE.matches ? '16px'
    : tall && !besideRoom ? `${ui.card.offsetHeight + 2 * GAP + PAD}px` : '';
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
  shifts?.disconnect();
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

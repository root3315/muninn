/**
 * read.js — "How to read this": opening it, playing each card's picture
 * only while that card is on screen, and the cue on its buttons until it has
 * been opened once.
 *
 * The pictures are CSS animations keyed off `.is-on`, which an
 * IntersectionObserver sets and clears, so a card scrolled away costs
 * nothing and a closed sheet costs nothing at all.
 */

import { t } from './i18n.js';

const CUED = ['gate-about', 'about-open'];

const $ = (id) => document.getElementById(id);

let watcher = null;
// Lit on every page load until the sheet is opened in that load: a reload,
// Ctrl+Shift+R included, lights it again.
let sessionSeen = false;


/** Put the cue on the buttons, or take it off, in the current language. */
export function relabelCue() {
  const on = !sessionSeen;
  for (const id of CUED) {
    const button = $(id);
    if (!button) continue;
    if (on) button.dataset.cue = t('about.start');
    else delete button.dataset.cue;
  }
}

function markSeen() {
  sessionSeen = true;
  relabelCue();
}

/** Watch the cards inside the open sheet: on while visible, seen once shown. */
function watch(sheet) {
  if (!('IntersectionObserver' in window)) return;
  sheet.classList.add('is-watching');
  watcher = new IntersectionObserver((entries) => {
    for (const e of entries) {
      e.target.classList.toggle('is-on', e.isIntersecting);
      if (e.isIntersecting) e.target.classList.add('is-seen');
    }
  }, { root: sheet, threshold: 0.3 });
  for (const step of sheet.querySelectorAll('.read__step')) watcher.observe(step);
}

function unwatch(sheet) {
  watcher?.disconnect();
  watcher = null;
  for (const step of sheet.querySelectorAll('.read__step.is-on')) step.classList.remove('is-on');
}

/** Tab and Shift+Tab go round inside the sheet. */
function trapFocus(sheet, e) {
  if (e.key !== 'Tab') return;
  const stops = [...sheet.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')]
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

/**
 * Open the sheet, at the top or at one card (by its id).
 * @param {string} [at]
 */
export function openRead(at) {
  const sheet = $('about');
  if (sheet.open) return;
  // The tour walks the field screen, so it is offered only from there.
  $('tour-replay').hidden = !$('gate')?.hidden;
  sheet.showModal();
  markSeen();
  const card = at ? $(at) : null;
  if (card) {
    const bar = sheet.querySelector('.read__bar');
    sheet.scrollTop = card.offsetTop - (bar?.offsetHeight ?? 0) - 12;
    card.classList.add('is-seen');
  } else {
    // Without this the sheet focuses its last button and opens scrolled to the end.
    sheet.scrollTop = 0;
  }
  watch(sheet);
}

/** @param {{ onTour: () => void }} hooks */
export function initRead({ onTour }) {
  const sheet = $('about');
  relabelCue();
  $('about-open').addEventListener('click', () => openRead());
  $('gate-about').addEventListener('click', () => openRead());
  $('about-close').addEventListener('click', () => sheet.close());
  $('about-x').addEventListener('click', () => sheet.close());
  $('tour-replay').addEventListener('click', () => { sheet.close(); onTour(); });
  sheet.addEventListener('keydown', (e) => trapFocus(sheet, e));
  sheet.addEventListener('close', () => unwatch(sheet));
  // A press on the backdrop, outside the sheet's own box, closes it.
  sheet.addEventListener('click', (e) => {
    if (e.target !== sheet) return;
    const r = sheet.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) sheet.close();
  });
}

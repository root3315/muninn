/**
 * world.js — the whole sky and the flight as layers of the front page.
 *
 * "The whole sky" and "Fly among the stars" open over the front page's sky,
 * facing where it faces, and close back onto it: one place, entered at
 * different scales, not three pages. Zooming the front page's sky out past
 * its widest steps out into the flight. A link into the tool from either
 * opens that field here, underneath, by the front page's own address.
 */

let layer = null;
let frame = null;
let current = null;

function ensureLayer() {
  if (layer) return;
  layer = document.createElement('div');
  layer.className = 'world';
  layer.hidden = true;
  frame = document.createElement('iframe');
  frame.className = 'world__frame';
  frame.setAttribute('allow', 'fullscreen');
  layer.append(frame);
  document.body.append(layer);
}

/**
 * Open a layer: `kind` is 'allsky' or 'fly'; `look` the direction the front
 * page faces, { ra, dec, fov }; `lang` the page's language.
 */
export function openWorld(kind, look, lang) {
  ensureLayer();
  const url = new URL(kind === 'fly' ? 'fly.html' : 'allsky.html', location.href);
  url.searchParams.set('embed', '1');
  if (lang) url.searchParams.set('lang', lang);
  if (look) {
    url.hash = kind === 'fly'
      ? `look=${look.ra.toFixed(3)},${look.dec.toFixed(3)}`
      : `ra=${look.ra.toFixed(4)}&dec=${look.dec.toFixed(4)}&fov=${Math.min(100, look.fov ?? 78).toFixed(1)}&view=colour`;
  }
  // The same layer again is shown as it was left.
  if (current !== kind || frame.src === '') frame.src = url.href;
  current = kind;
  layer.hidden = false;
  requestAnimationFrame(() => layer.classList.add('world--on'));
  frame.focus();
}

export function closeWorld() {
  if (!layer || layer.hidden) return;
  layer.classList.remove('world--on');
  const done = () => { layer.hidden = true; };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
  else setTimeout(done, 320);
}

export const worldOpen = () => Boolean(layer && !layer.hidden);

/** The front page's scale keys; `look` and `lang` say how to open a layer. */
let lookNow = () => null;
let langNow = () => null;
export function wireScale({ look, lang }) {
  lookNow = look;
  langNow = lang;
  for (const key of document.querySelectorAll('#scale .scale__key')) {
    key.setAttribute('aria-pressed', String(key.dataset.scale === 'sky'));
    key.addEventListener('click', () => goTo(key.dataset.scale));
  }
}

function goTo(scale) {
  if (scale === 'sky') closeWorld();
  else openWorld(scale, lookNow(), langNow());
}

addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'muninn:close') closeWorld();
  if (e.data.type === 'muninn:scale' && ['sky', 'allsky', 'fly'].includes(e.data.scale)) goTo(e.data.scale);
  if (e.data.type === 'muninn:open' && typeof e.data.hash === 'string' && e.data.hash.startsWith('#')) {
    closeWorld();
    location.hash = e.data.hash;
  }
});

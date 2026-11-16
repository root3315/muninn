/**
 * world.js — the whole sky and the flight as layers of the front page.
 *
 * Zooming the front page's sky in past its narrowest opens SPHEREx's
 * whole-sky detail facing the same way; zooming it out past its widest steps
 * into space. Each layer is loaded once, in the background, before it is
 * wanted, so going in or out is a crossfade over a sky already drawn, not a
 * black screen while a page loads. A link into the tool from a layer opens
 * that field here, by the front page's own address.
 */

const KINDS = { allsky: 'allsky.html', fly: 'fly.html' };
const layers = {};
let current = null;

function layerOf(kind, lang) {
  if (layers[kind]) return layers[kind];
  const el = document.createElement('div');
  el.className = 'world';
  el.hidden = true;
  const frame = document.createElement('iframe');
  frame.className = 'world__frame';
  frame.setAttribute('aria-hidden', 'true');
  const url = new URL(KINDS[kind], location.href);
  url.searchParams.set('embed', '1');
  if (lang) url.searchParams.set('lang', lang);
  frame.src = url.href;
  el.append(frame);
  document.body.append(el);
  layers[kind] = { el, frame };
  return layers[kind];
}

/** Load a layer now, out of sight, so opening it later is immediate. */
export function preloadWorld(kind, lang) {
  layerOf(kind, lang);
}

/** Point a loaded layer where the front page faces. */
function aim(kind, look) {
  const { frame } = layers[kind];
  if (!look || !frame.contentWindow) return;
  frame.contentWindow.postMessage({ type: 'muninn:look', ra: look.ra, dec: look.dec, fov: look.fov, key: look.key, mark: look.mark }, location.origin);
}

/**
 * Open a layer: `kind` is 'allsky' or 'fly'; `look` the direction the front
 * page faces, { ra, dec, fov }, and for the flight from a mark `mark`, what
 * it is ({ name, body }: body a small body's orbital elements); `lang` the
 * page's language.
 */
export function openWorld(kind, look, lang) {
  const layer = layerOf(kind, lang);
  aim(kind, look);
  // A layer still loading is aimed again once it has.
  layer.frame.addEventListener('load', () => {
    aim(kind, look);
    if (current === kind) layer.frame.contentWindow?.postMessage({ type: 'muninn:resume' }, location.origin);
  }, { once: true });
  for (const [k, l] of Object.entries(layers)) if (k !== kind) hide(l);
  current = kind;
  layer.frame.contentWindow?.postMessage({ type: 'muninn:resume' }, location.origin);
  layer.el.hidden = false;
  layer.frame.removeAttribute('aria-hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => layer.el.classList.add('world--on')));
  layer.frame.focus();
}

function hide(layer) {
  if (!layer || layer.el.hidden) return;
  layer.el.classList.remove('world--on');
  layer.frame.setAttribute('aria-hidden', 'true');
  // A hidden layer stops drawing: it costs the page under it nothing.
  setTimeout(() => {
    if (!layer.el.classList.contains('world--on')) layer.frame.contentWindow?.postMessage({ type: 'muninn:pause' }, location.origin);
  }, 650);
  const done = () => { if (!layer.el.classList.contains('world--on')) layer.el.hidden = true; };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
  else setTimeout(done, 650);
}

export function closeWorld() {
  if (current) hide(layers[current]);
  current = null;
}

export const worldOpen = () => current !== null;

/** How the front page opens a layer, and what it does when one hands back a direction. */
let lookNow = () => null;
let langNow = () => null;
let faceNow = () => {};
export function wireWorld({ look, lang, face }) {
  lookNow = look;
  langNow = lang;
  faceNow = face;
}

function goTo(scale, look) {
  if (scale === 'sky') {
    if (look) faceNow(look);
    closeWorld();
  } else {
    openWorld(scale, look ?? lookNow(), langNow());
  }
}

// A key let go here, after it opened a layer, is let go there too.
addEventListener('keyup', (e) => {
  if (current) layers[current].frame.contentWindow?.postMessage({ type: 'muninn:keyup', key: e.code }, location.origin);
});

addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'muninn:close') closeWorld();
  if (e.data.type === 'muninn:scale' && ['sky', 'allsky', 'fly'].includes(e.data.scale)) goTo(e.data.scale, e.data.look);
  if (e.data.type === 'muninn:open' && typeof e.data.hash === 'string' && e.data.hash.startsWith('#')) {
    // The field is put up under the layer first, and the layer fades off it
    // once it is there: closed first, the front page's sky showed between.
    location.hash = e.data.hash;
    setTimeout(closeWorld, 450);
  }
});

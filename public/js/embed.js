/**
 * embed.js — the whole-sky view and the flight, shown inside the front page.
 *
 * Loaded with ?embed=1 they are layers of the front page rather than pages of
 * their own: no bar, a way back to the sky, and a link into the tool opens
 * the field in the front page underneath instead of loading another page.
 * The front page (world.js) listens for these two messages.
 */

export const embedded = new URLSearchParams(location.search).get('embed') === '1';

/** Open the tool at a link (a URL whose fragment names the field). */
export function openInTool(href) {
  if (!embedded) {
    location.href = href;
    return;
  }
  const url = new URL(href, location.href);
  parent.postMessage({ type: 'muninn:open', hash: url.hash }, location.origin);
}

/** Back to the front page's sky. */
export function close() {
  parent.postMessage({ type: 'muninn:close' }, location.origin);
}

/** Another scale of the front page: 'sky', 'allsky' or 'fly'. */
export function goTo(scale) {
  parent.postMessage({ type: 'muninn:scale', scale }, location.origin);
}

/** Wire the scale keys of a page shown at `here`. */
export function wireScale(here) {
  for (const key of document.querySelectorAll('.scale__key')) {
    key.setAttribute('aria-pressed', String(key.dataset.scale === here));
    key.addEventListener('click', () => {
      if (key.dataset.scale === here) return;
      if (embedded) goTo(key.dataset.scale);
      else location.href = key.dataset.scale === 'sky' ? './' : `${key.dataset.scale === 'fly' ? 'fly' : 'allsky'}.html`;
    });
  }
}

if (embedded) {
  document.documentElement.dataset.embed = '1';
  // Links into the tool become messages to the page this sits in.
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    const toTool = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
    if (!toTool) return;
    e.preventDefault();
    if (url.hash.length > 1) openInTool(url.href);
    else close();
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('.fly-card:not([hidden])')) close();
  });
}

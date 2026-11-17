/**
 * safety.js — what the page does about the failures nobody planned for.
 *
 * Loaded as its own module ahead of app.js, with nothing imported, so that it
 * is running even when the rest of the page's code is not: a deploy between
 * the page and its code arriving leaves an old page asking for code under an
 * old tag, and the one cure is to load the page again. That is done once,
 * with a flag in the address that the next load takes out again, and never
 * twice within a few minutes, so a code file that is really gone cannot set
 * the page reloading for ever.
 *
 * Everything else that escapes is written to the console and nowhere else,
 * except a failure the person can see: that gets one small line at the foot
 * of the screen, and the page tries again.
 */

const RELOAD_KEY = 'muninn.codeReload';
const FRESH_PARAM = 'fresh';
export const RELOAD_WINDOW_MS = 5 * 60_000;

/** Whether the page may reload for its code now, given when it last did: once per window. */
export function mayReload(lastAt, now, windowMs = RELOAD_WINDOW_MS) {
  const last = Number(lastAt);
  return !(lastAt != null && lastAt !== '' && Number.isFinite(last) && now - last < windowMs && now >= last);
}

/** Whether a failure is the page's own code not arriving: a module import, a chunk. */
export function isCodeLoadError(err) {
  const text = `${err?.name ?? ''} ${err?.message ?? err ?? ''}`;
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|ChunkLoadError|Unable to preload/i.test(text);
}

/** Whether a script element that failed is the page's own code: a module from this origin. */
export function isOwnCode(script, origin) {
  if (script?.type !== 'module' || !script.src) return false;
  try {
    return new URL(script.src, `${origin}/`).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Load the page again for its code, once per window, under a flag no cache
 * holds an answer for. Returns whether it did; without session storage there
 * is no guard against a loop, so it does not.
 */
export function reloadForCode({ storage = globalThis.sessionStorage, loc = globalThis.location, now = Date.now() } = {}) {
  try {
    if (!storage || !mayReload(storage.getItem(RELOAD_KEY), now)) return false;
    storage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  const url = new URL(loc.href);
  url.searchParams.set(FRESH_PARAM, now.toString(36));
  loc.replace(url.href);
  return true;
}

/** The flag a reload for code put in the address, taken out again; the history entry is not added to. */
function dropFreshFlag() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has(FRESH_PARAM)) return;
    url.searchParams.delete(FRESH_PARAM);
    history.replaceState(history.state, '', url.href);
  } catch { /* an address that cannot be rewritten stays as it is */ }
}

/* -------------------------------------------------------------- the toast */

let toastEl = null;
let toastTimer = 0;
const lastSaid = new Map();
/** The same line is not said again within this. */
const TOAST_QUIET_MS = 20_000;

/** One short line at the foot of the screen, gone by itself. */
export function toast(message, { ms = 4500 } = {}) {
  if (!message || typeof document === 'undefined') return;
  const now = Date.now();
  if (now - (lastSaid.get(message) ?? -Infinity) < TOAST_QUIET_MS) return;
  lastSaid.set(message, now);
  if (!toastEl) {
    toastEl = document.createElement('p');
    toastEl.className = 'safety-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.hidden = true;
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

/* ------------------------------------------------------------ the network */

let netEl = null;

/**
 * Say "no network" while there is none, and call `onBack` when it returns.
 * `words()` gives the line in the reader's language at the moment it is shown.
 */
export function watchNetwork({ words, onBack }) {
  const show = () => {
    if (!netEl) {
      netEl = document.createElement('p');
      netEl.className = 'safety-offline';
      netEl.setAttribute('role', 'status');
      document.body.append(netEl);
    }
    netEl.textContent = words().offline;
    netEl.hidden = false;
  };
  const hide = () => { if (netEl) netEl.hidden = true; };
  window.addEventListener('offline', show);
  window.addEventListener('online', () => {
    hide();
    toast(words().back);
    onBack?.();
  });
  if (navigator.onLine === false) show();
  return { relabel: () => { if (netEl && !netEl.hidden) netEl.textContent = words().offline; } };
}

/* ------------------------------------------------------------- the net */

let trouble = null;

/**
 * What to do about a failure that escaped while something is on screen:
 * `visible()` says whether one would be seen, `onTrouble()` says so and tries
 * again. Set by the page once it is running.
 */
export function onUnplannedFailure(handler) {
  trouble = handler;
}

function quietly(what, err) {
  console.warn(`[muninn] ${what}:`, err);
}

function escaped(err) {
  if (err?.name === 'AbortError') return;
  if (isCodeLoadError(err) && reloadForCode()) return;
  quietly('unhandled', err);
  try {
    if (trouble?.visible()) trouble.onTrouble(err);
  } catch (inner) {
    quietly('while handling', inner);
  }
}

if (typeof window !== 'undefined') {
  dropFreshFlag();
  // A page script that failed to load (the error does not bubble, so it is
  // caught on the way down): the code under this page's tag is gone.
  window.addEventListener('error', (e) => {
    const el = e.target;
    if (el instanceof HTMLScriptElement) {
      // Only this site's own code is a reason to reload. A script someone
      // else put in the page (Cloudflare adds its analytics beacon, which the
      // page's content-security policy refuses) failing is theirs, and
      // reloading for it only showed the page twice.
      if (isOwnCode(el, location.origin)) {
        quietly('code did not load', el.src);
        reloadForCode();
      }
      return;
    }
    if (el && el !== window) return;
    e.preventDefault();
    escaped(e.error ?? e.message);
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    e.preventDefault();
    escaped(e.reason);
  });
}

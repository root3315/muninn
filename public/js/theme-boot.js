/*
 * theme-boot.js — the saved theme, set before the first paint.
 *
 * Loaded as a plain blocking script in the head, ahead of the stylesheets'
 * first use, so a reader who chose day never sees a frame of night first. It
 * is a file rather than an inline script because the page's content policy
 * allows scripts from its own origin only.
 */
try {
  if (localStorage.getItem('muninn.theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
  }
} catch (e) { /* private window: night, as ever */ }

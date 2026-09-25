/**
 * stamp-worker.js — the resampling, off the thread that draws.
 *
 * Putting one visit onto the shared grid is a third of a second of arithmetic,
 * and a field is ten visits. Done on the page's own thread that was three
 * seconds in which the blink stopped, the pointer did nothing and the browser
 * reported the tab as not answering. Here it runs beside the page, several
 * visits at once, and hands back nothing but the finished pixels.
 */

import { loadStamp } from './stamp.js';
import { TangentGrid } from './wcs.js';
import { skySigma } from './depth.js';
import { limits } from './render.js';

/** The white point the page opens with; a visit cut here needs no cut on arrival. */
const DEFAULT_CLIP = 99.5;

const running = new Map();

self.addEventListener('message', async ({ data: msg }) => {
  if (msg.type === 'abort') { running.get(msg.id)?.abort(); return; }

  const { id, url, grid: g } = msg;
  const ctrl = new AbortController();
  running.set(id, ctrl);
  try {
    const grid = new TangentGrid(g.ra, g.dec, g.fovDeg, g.width, g.height);
    const stamp = await loadStamp(url, grid, { signal: ctrl.signal });
    if (!stamp) { self.postMessage({ id, stamp: null }); return; }
    // The WCS is a class instance and the page never reads it; the pixels are
    // moved rather than copied.
    const { wcs, ...plain } = stamp;
    // Both of these sort every pixel of the visit, and on the page's thread
    // they were the stall each time a visit landed — felt as a hitch in the
    // blink and in anything else moving. Done here, they arrive with it.
    plain.sigma = skySigma(plain.data);
    plain.cut = { key: DEFAULT_CLIP, lim: limits(plain.data, { loPercent: 5, hiPercent: DEFAULT_CLIP }) };
    self.postMessage({ id, stamp: plain }, [plain.data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err?.name === 'AbortError' ? 'AbortError' : String(err?.message ?? err) });
  } finally {
    running.delete(id);
  }
});

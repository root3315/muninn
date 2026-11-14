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
import { skySigmaFromSorted } from './depth.js';
import { sortedFinite, limitsFromSorted, quantileTable } from './render.js';

/** The white point the page opens with; a visit cut here needs no cut on arrival. */
const DEFAULT_CLIP = 99.5;

const running = new Map();

self.addEventListener('message', async ({ data: msg }) => {
  if (msg.type === 'abort') { running.get(msg.id)?.abort(); return; }

  const { id, url, grid: g, header } = msg;
  const ctrl = new AbortController();
  running.set(id, ctrl);
  try {
    const grid = new TangentGrid(g.ra, g.dec, g.fovDeg, g.width, g.height);
    const onHeader = header ? () => self.postMessage({ id, header: true }) : undefined;
    const stamp = await loadStamp(url, grid, { signal: ctrl.signal, onHeader });
    if (!stamp) { self.postMessage({ id, stamp: null }); return; }
    // The WCS is a class instance and arrives as its plain fields (the
    // detector patch carries them for sharpness.js); the pixels are moved
    // rather than copied.
    const { wcs, ...plain } = stamp;
    // The noise, the opening cut and the table every later cut is read from
    // all come from the pixels in order. Sorted once, here: on the page's
    // thread each sort was a hitch in the blink as the visit landed.
    const sorted = sortedFinite(plain.data);
    plain.sigma = skySigmaFromSorted(sorted);
    plain.cut = { key: DEFAULT_CLIP, lim: limitsFromSorted(sorted, { loPercent: 5, hiPercent: DEFAULT_CLIP }) };
    plain.quantiles = quantileTable(sorted);
    self.postMessage({ id, stamp: plain }, [plain.data.buffer, plain.quality.buffer, plain.detector.data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err?.name === 'AbortError' ? 'AbortError' : String(err?.message ?? err) });
  } finally {
    running.delete(id);
  }
});

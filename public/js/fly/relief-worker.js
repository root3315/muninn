/**
 * relief-worker.js — a body's height map made into slopes beside the page.
 *
 * Reading a 16-bit PNG and working out half a million slopes takes a tenth
 * of a second or more: on the page itself the flight would stop for it, just
 * as the planet it is flying to comes near. Asked { url, meta, key, seaLevel },
 * it answers { levels } (see relief.js), or { levels: null } if it cannot.
 */

import { decodeGrey16, slopes, halvings } from './relief.js';

addEventListener('message', async (e) => {
  const { url, meta, key, seaLevel } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const grey = await decodeGrey16(await res.arrayBuffer());
    if (!grey) throw new Error('not a 16-bit grey PNG');
    const levels = halvings(slopes(grey, meta, key, seaLevel), grey.w, grey.h);
    postMessage({ key, levels }, levels.map((l) => l.data.buffer));
  } catch {
    postMessage({ key, levels: null });
  }
});

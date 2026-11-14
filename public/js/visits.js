/**
 * visits.js — which of a field's visits are read, and in what order.
 *
 * A field can have fifty visits in the archive; reading all of them costs a
 * minute and a hundred megabytes. Ten are read first, spread across the whole
 * baseline, and more can be asked for ten at a time. Each later batch goes
 * where the baseline is thinnest, so every batch leaves the run more even than
 * it found it rather than piling into one season.
 */

/** How many visits a field opens with, and how many each "load more" adds. */
export const VISITS_PER_BATCH = 10;

/** Keep the ends, spread the rest — a sample that still spans the full baseline. */
export function spread(list, max) {
  if (list.length <= max) return list.slice();
  const out = [];
  for (let k = 0; k < max; k++) out.push(list[Math.round((k * (list.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

const keyOf = (v) => v.obsId ?? v.url ?? v.mjd;

/**
 * The next `n` visits to read, out of `all`, given the ones already `chosen`.
 *
 * Farthest first: each pick is the unread visit whose date lies furthest from
 * every date already read, so the first of a new batch lands in the widest
 * gap and the rest fill the next widest. Ties go to the earlier date, which
 * keeps the choice the same from one run to the next. Returned in date order.
 */
export function nextVisits(all, chosen, n = VISITS_PER_BATCH) {
  const taken = new Set(chosen.map(keyOf));
  const left = all.filter((v) => !taken.has(keyOf(v)));
  if (left.length <= n) return left.slice().sort((a, b) => a.mjd - b.mjd);
  if (!chosen.length) return spread(left.slice().sort((a, b) => a.mjd - b.mjd), n);

  // The distance from each candidate to the nearest date already read,
  // updated as picks are made rather than recomputed from scratch.
  const gap = left.map((v) => Math.min(...chosen.map((c) => Math.abs(c.mjd - v.mjd))));
  const picked = [];
  for (let k = 0; k < n; k++) {
    let best = -1;
    for (let i = 0; i < left.length; i++) {
      if (gap[i] < 0) continue;
      if (best < 0 || gap[i] > gap[best] || (gap[i] === gap[best] && left[i].mjd < left[best].mjd)) best = i;
    }
    if (best < 0) break;
    const pick = left[best];
    picked.push(pick);
    gap[best] = -1;
    for (let i = 0; i < left.length; i++) {
      if (gap[i] >= 0) gap[i] = Math.min(gap[i], Math.abs(left[i].mjd - pick.mjd));
    }
  }
  return picked.sort((a, b) => a.mjd - b.mjd);
}

/**
 * The frame list after a second answer: everything the first had, and what the
 * second adds. A frame is the same frame by its file. Asking again after part
 * of the archive failed to answer must never lose what the first answer gave.
 */
export function mergeFrames(kept, fresh) {
  const have = new Set(kept.map((f) => f.url ?? keyOf(f)));
  return [...kept, ...fresh.filter((f) => !have.has(f.url ?? keyOf(f)))];
}

/**
 * The visit list after a second answer, with every visit of the first kept as
 * the very same object, so the frames read, the one on screen, A and B and
 * the marks all stay where they are. A visit of the second list is new only
 * when no kept visit lies within `minGapHours` of it: the lists are grouped
 * that way (groupVisits), and a nearer frame of a visit already in hand is
 * not a new visit. In date order.
 */
export function mergeVisits(kept, fresh, minGapHours = 6) {
  const gap = minGapHours / 24;
  const added = fresh.filter((v) => !kept.some((k) => Math.abs(k.mjd - v.mjd) < gap));
  return [...kept, ...added].sort((a, b) => a.mjd - b.mjd);
}

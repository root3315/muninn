/**
 * sectors.js — cutting the frame into districts, and ranking them by surprise.
 *
 * Blinking ten frames and hoping is not a search. A person can hold maybe three
 * places in their head at once, and a frame has a hundred thousand pixels. So
 * the frame is divided into a small grid of sectors, and every sector is scored
 * in every visit by one question: how unusual is this visit, for this sector?
 *
 * The score is the sector's brightest pixel, measured against what that same
 * sector normally looks like:
 *
 *     score = (peak in this visit − median peak across visits) / noise
 *
 * A star that is always there scores zero — it is in the median. A visit
 * scores high when the sector's dominant peak changed: something brighter than
 * all else in the sector appeared, or the brightest source brightened. This is
 * an attention map, not a complete detector of moving sources: a faint newcomer
 * beside a brighter steady star leaves the sector's peak where it was. Small
 * tiles instead of whole sectors were tried on real fields and lit dozens of
 * times more cells (unflagged single-pixel hits, stars brighter in one band
 * than another), so the sector peak stays.
 *
 * The noise is the larger of two things: the spread of that sector's own peaks,
 * so a busy sector has to work harder to be called surprising than an empty one
 * does; and the frame's pixel noise, because a sector whose peaks happen to
 * agree closely has not thereby become infinitely sensitive. Without that second
 * floor a flat sector divides by almost nothing and reports scores in the
 * thousands, which is a bug that looks like a discovery.
 *
 * That is the whole idea: the grid tells you which three cells to look at
 * instead of asking you to watch twenty.
 */

/** The brief said five across and four down. */
export const SECTOR_COLS = 5;
export const SECTOR_ROWS = 4;
export const SECTOR_COUNT = SECTOR_COLS * SECTOR_ROWS;

/** Sector n (1-based) as a fraction of the grid, so it survives any resize. */
export function sectorBounds(index, cols = SECTOR_COLS, rows = SECTOR_ROWS) {
  const i = index - 1;
  const cx = i % cols;
  const cy = Math.floor(i / cols);
  return { x0: cx / cols, x1: (cx + 1) / cols, y0: cy / rows, y1: (cy + 1) / rows };
}

/** The brightest valid pixel inside a sector of one resampled frame. */
function sectorPeak(data, width, height, bounds) {
  const x0 = Math.floor(bounds.x0 * width);
  const x1 = Math.max(x0 + 1, Math.floor(bounds.x1 * width));
  const y0 = Math.floor(bounds.y0 * height);
  const y1 = Math.max(y0 + 1, Math.floor(bounds.y1 * height));
  let peak = -Infinity;
  let seen = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      const v = data[row + x];
      if (v === v && Number.isFinite(v)) { seen++; if (v > peak) peak = v; }
    }
  }
  return seen > 8 ? peak : null;
}

/** Where the brightest pixel of a sector sits, as grid indices. */
export function peakIndex(data, width, height, bounds) {
  const x0 = Math.floor(bounds.x0 * width);
  const x1 = Math.max(x0 + 1, Math.floor(bounds.x1 * width));
  const y0 = Math.floor(bounds.y0 * height);
  const y1 = Math.max(y0 + 1, Math.floor(bounds.y1 * height));
  let peak = -Infinity;
  let at = null;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      const v = data[row + x];
      if (v === v && Number.isFinite(v) && v > peak) { peak = v; at = [x, y]; }
    }
  }
  return at;
}

const median = (sorted) => sorted[sorted.length >> 1];

/**
 * Score every sector in every visit.
 *
 * Returns `{ cols, rows, visits, cells, max }`, where `cells[sector][visit]` is
 * the score or null where the frame had no coverage there. Nulls are kept
 * rather than zeroed: "no data" and "nothing happened" are different answers and
 * the grid draws them differently.
 *
 * Each visit is scored against the visits of its own band. A field opened in
 * all bands mixes D1 to D6, and a star is not the same brightness at 1 µm as
 * at 4: against a median of every band, a red star stood out in each long-wave
 * visit and a pole field lit two hundred cells. A band with fewer than three
 * visits has nothing to be usual against, and its visits stay unscored.
 * `sigmas`, when given one a visit, sets each band's pixel-noise floor.
 */
export function scoreSectors(visits, { cols = SECTOR_COLS, rows = SECTOR_ROWS, sigmas = [] } = {}) {
  const count = cols * rows;
  const peaks = [];
  for (let s = 0; s < count; s++) {
    const bounds = sectorBounds(s + 1, cols, rows);
    peaks.push(visits.map((v) => sectorPeak(v.stamp.data, v.stamp.width, v.stamp.height, bounds)));
  }

  const bandOf = (v) => v.frame?.band ?? '';
  const bands = new Map();
  visits.forEach((v, i) => {
    const list = bands.get(bandOf(v)) ?? [];
    list.push(i);
    bands.set(bandOf(v), list);
  });
  const perVisit = sigmas.length === visits.length;
  // One pixel-noise number a band (or for the whole frame), measured once
  // rather than once per sector.
  const floorOf = (members) => {
    const list = (perVisit ? members.map((i) => sigmas[i]) : sigmas).filter((x) => x > 0).sort((a, b) => a - b);
    return list.length ? median(list) : 0;
  };

  const cells = peaks.map((row) => row.map(() => null));
  let max = 0;
  for (const members of bands.values()) {
    if (members.length < 3) continue;
    const pixel = floorOf(members);
    for (let s = 0; s < count; s++) {
      const seen = members.map((i) => peaks[s][i]).filter((p) => p != null).sort((a, b) => a - b);
      if (seen.length < 3) continue;
      const mid = median(seen);
      // Spread of the peaks themselves, from the half that a single bright visit
      // cannot inflate — the same trick the black point uses.
      const lower = seen[Math.max(0, Math.round(0.1587 * (seen.length - 1)))];
      const noise = Math.max(mid - lower, pixel, 1e-6);
      for (const i of members) {
        const p = peaks[s][i];
        if (p == null) continue;
        const z = (p - mid) / noise;
        if (z > max) max = z;
        cells[s][i] = z;
      }
    }
  }
  return { cols, rows, visits: visits.length, cells, max };
}

/**
 * The cells worth a person's attention, strongest first.
 *
 * A threshold rather than a top-N: if nothing in the field is unusual, the
 * honest answer is an empty list, not the least boring cell available.
 */
export function standouts(scored, { minScore = 4, limit = 8 } = {}) {
  const out = [];
  scored.cells.forEach((row, s) => {
    row.forEach((z, v) => {
      if (z != null && z >= minScore) out.push({ sector: s + 1, visit: v, score: z });
    });
  });
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * strip.js — the run of observations, as one object.
 *
 * A time-domain viewer usually gives you a picture and a scrubber, and asks you
 * to hold nine other pictures in your head while you drag. That is the wrong
 * way round: the information in this data is not in any one frame, it is in the
 * differences between them, and a scrubber shows you one frame at a time by
 * design.
 *
 * So the whole run is drawn at once, and it carries four things that used to be
 * four separate controls:
 *
 *   the lane      every observation as a dot at its true date, to scale, under
 *                 the months it falls in — so the survey's own rhythm is
 *                 visible: SPHEREx comes back in clusters of a few days and then
 *                 not for months, and that shape is a fact about what you can
 *                 and cannot measure here.
 *   the frames    a real thumbnail of each one, evenly spaced. Evenly, because
 *                 at true spacing a cluster three days wide would stack four
 *                 frames on top of each other; a line from each dot to its frame
 *                 says which frame is which date, which is the honest way to
 *                 show an ordinal row against a temporal axis.
 *   the signature under each frame, that visit's twenty sectors in the five-by-
 *                 four grid they actually are — so the map of what changed sits
 *                 under the picture it changed in, at the same geometry, rather
 *                 than in a panel somewhere else.
 *   the date      under that, in plain figures.
 *
 * Every visit the field will have is drawn from the start, because its date is
 * known before its pixels are; a frame still on its way is an empty outline in
 * its place. Press a frame to go to it. There is nothing else to learn.
 */

/** The sector grid, as the brief specifies it. */
const COLS = 5;
const ROWS = 4;

/** Scores are clamped here rather than normalised to the field's own maximum. */
const TOP = 12;
/** A cell is lit, and can be pressed, from here: the bar standouts() uses. */
const LIT = 4;

/** Under a frame the month is part of a date, so Russian takes the genitive. */
const DATE_MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
/** On the lane the month stands alone, so it is named as itself. */
const LANE_MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MJD_UNIX = 40587;
const toDate = (mjd) => new Date((mjd - MJD_UNIX) * 86400000);
const toMjd = (date) => date.getTime() / 86400000 + MJD_UNIX;

/**
 * Draw the run and return where each loaded frame landed, so a press can be
 * resolved without the caller repeating any of the arithmetic.
 *
 * `slots` is every visit in date order: `{ frame, visit, at }`, where `visit` is
 * the loaded entry (or null while it is on its way) and `at` its index among the
 * loaded visits — the index `index`, `hover` and the sector scores are in.
 *
 * @returns {{x:number, y:number, w:number, h:number, i:number}[]}
 */
export function drawStrip(canvas, {
  slots, sectors, index, hover = -1, lang = 'ru', paint, now = 0, motion = true,
}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 1;
  const P = paint;

  /* ---- what fits ------------------------------------------------------ */
  const n = slots.length;
  if (!n) { canvas.height = 0; return []; }

  const padX = 8;
  const labelH = 12;           // the month names over the lane
  const gapL = 7;              // month names to the lane
  const sigH = ROWS * 7 + 6;   // the five-by-four signature
  const dateH = 13;
  const gapA = 30;             // lane to frame: the lines need room to turn
  const gapB = 5;              // frame to signature
  const gapC = 3;              // signature to date
  const padY = 4;

  const inner = Math.max(120, cssW - padX * 2);
  const slot = inner / n;
  const thumbW = Math.max(26, Math.min(96, slot - 8));
  // Keep the frames' own proportions; a field is rarely square.
  const src = slots.find((s) => s.visit?.canvas)?.visit.canvas;
  const aspect = src ? src.height / src.width : 0.66;
  // Capped below the width: with a square field the thumbnails would otherwise
  // be as tall as they are wide, and the run would take a third of the window
  // from the frame it is there to serve.
  const thumbH = Math.max(22, Math.min(40, Math.round(thumbW * aspect)));

  const H = padY + labelH + gapL + gapA + thumbH + gapB + sigH + gapC + dateH + padY;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.height = `${H}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, H);

  /* ---- where everything sits ----------------------------------------- */
  const laneY = padY + labelH + gapL;         // the axis
  const thumbY = laneY + gapA;
  const sigY = thumbY + thumbH + gapB;
  const dateY = sigY + sigH + gapC;

  // Before the archive has answered there are places but no dates: the run
  // keeps its shape and its frames, with nothing on the lane yet.
  const skeleton = !slots.some((s) => s.frame);
  const mjds = skeleton ? [0] : slots.map((s) => s.frame.mjd);
  const lo = Math.min(...mjds);
  const hi = Math.max(...mjds);
  const span = hi - lo || 1;
  const atTime = (mjd) => padX + ((mjd - lo) / span) * inner;
  const atSlot = (i) => padX + slot * i + (slot - thumbW) / 2;

  const liveSlot = slots.findIndex((s) => s.at >= 0 && s.at === index);
  const hoverSlot = slots.findIndex((s) => s.at >= 0 && s.at === hover);

  /* ---- the lane: the months it crosses, then the line itself ----------- */
  const laneMonths = lang === 'ru' ? LANE_MONTHS_RU : MONTHS_EN;
  const dateMonths = lang === 'ru' ? DATE_MONTHS_RU : MONTHS_EN;
  ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textBaseline = 'alphabetic';

  // Each month is named over the stretch of the lane it covers, not over the
  // day it begins: a name standing on a boundary reads as the month either
  // side of it, which is how August's visits came to look like September's.
  // A boundary is a short tick through the lane, unlike an observation's dot.
  const first = toDate(lo);
  let cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  let lastYear = null;
  while (!skeleton && toMjd(cursor) <= hi) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const x0 = atTime(Math.max(lo, toMjd(cursor)));
    const x1 = atTime(Math.min(hi, toMjd(next)));
    if (toMjd(cursor) > lo) {
      ctx.strokeStyle = P.ruleSoft;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x0) + 0.5, laneY - 4);
      ctx.lineTo(Math.round(x0) + 0.5, laneY + 4);
      ctx.stroke();
    }
    const year = cursor.getUTCFullYear();
    const name = laneMonths[cursor.getUTCMonth()];
    // The year on the first month shown and wherever it turns.
    const withYear = year !== lastYear ? `${name} ${year}` : name;
    const room = x1 - x0 - 6;
    const label = ctx.measureText(withYear).width <= room ? withYear
      : ctx.measureText(name).width <= room ? name : '';
    if (label) {
      if (label === withYear) lastYear = year;
      ctx.fillStyle = P.label ?? P.faint;
      ctx.textAlign = 'center';
      ctx.fillText(label, (x0 + x1) / 2, padY + labelH - 2);
    }
    cursor = next;
  }

  ctx.strokeStyle = P.rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, laneY + 0.5);
  ctx.lineTo(padX + inner, laneY + 0.5);
  ctx.stroke();

  /* ---- the lines: which dot is which frame ---------------------------- */
  // One smooth line from each date down to its frame. The two-kink version
  // put every horizontal run at the same height, where they merged into one
  // long rule and a line could no longer be followed from end to end. A curve
  // that leaves the lane straight down and meets the frame straight down stays
  // separate from its neighbours all the way.
  const bend = gapA * 0.6;
  const drawLink = (i, tone, width, alpha) => {
    const tx = atTime(slots[i].frame.mjd);
    const bx = atSlot(i) + thumbW / 2;
    ctx.strokeStyle = tone;
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(tx, laneY + 3);
    ctx.bezierCurveTo(tx, laneY + bend, bx, thumbY - bend, bx, thumbY);
    ctx.stroke();
  };
  for (let i = 0; i < n && !skeleton; i++) {
    if (i === liveSlot || i === hoverSlot) continue;
    drawLink(i, P.ruleSoft, 1, slots[i].visit ? 0.9 : 0.45);
  }
  if (hoverSlot >= 0 && hoverSlot !== liveSlot) drawLink(hoverSlot, P.ink, 1, 0.8);
  if (liveSlot >= 0) drawLink(liveSlot, P.accent, 1.5, 1);
  ctx.globalAlpha = 1;

  /* ---- the dots: each observation at its true date --------------------- */
  const dot = (i) => {
    const x = atTime(slots[i].frame.mjd);
    const live = i === liveSlot;
    const loaded = !!slots[i].visit;
    ctx.beginPath();
    ctx.arc(x, laneY + 0.5, live ? 3.5 : 2.5, 0, Math.PI * 2);
    if (loaded) {
      ctx.fillStyle = live ? P.accent : (i === hoverSlot ? P.ink : P.faint);
      ctx.fill();
    } else {
      ctx.fillStyle = P.well;
      ctx.fill();
      ctx.strokeStyle = P.faint;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (live) {
      ctx.beginPath();
      ctx.arc(x, laneY + 0.5, 6.5, 0, Math.PI * 2);
      ctx.strokeStyle = P.accent;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };
  for (let i = 0; i < n && !skeleton; i++) if (i !== liveSlot) dot(i);
  if (liveSlot >= 0) dot(liveSlot);

  /* ---- the frames ------------------------------------------------------ */
  // Frames still being read carry one soft band of light that travels along
  // the whole row, left to right, every 1.6 s: one wave across the run rather
  // than ten separate blinks. A frame that lands fades in over a third of a
  // second instead of popping into its place.
  const WAVE_MS = 1600;
  const wave = motion ? ((now % WAVE_MS) / WAVE_MS) * 1.6 - 0.3 : -1;
  const hits = [];
  for (let i = 0; i < n; i++) {
    const v = slots[i].visit;
    const x = atSlot(i);
    const live = i === liveSlot;

    ctx.fillStyle = P.well;
    ctx.fillRect(x, thumbY, thumbW, thumbH);
    if (v?.canvas?.width) {
      const age = motion && slots[i].landedAt ? (now - slots[i].landedAt) / 320 : 1;
      ctx.globalAlpha = Math.max(0, Math.min(1, age));
      // `contain`: a thumbnail that crops is a thumbnail that lies about what
      // the frame holds.
      const k = Math.min(thumbW / v.canvas.width, thumbH / v.canvas.height);
      const w = v.canvas.width * k;
      const h = v.canvas.height * k;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(v.canvas, x + (thumbW - w) / 2, thumbY + (thumbH - h) / 2, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = live ? P.accent : (i === hoverSlot ? P.ink : P.rule);
      ctx.lineWidth = live ? 1.6 : 1;
      ctx.setLineDash([]);
      ctx.strokeRect(x + 0.5, thumbY + 0.5, thumbW - 1, thumbH - 1);
      hits.push({ x, y: thumbY, w: thumbW, h: thumbH + gapB + sigH, i: slots[i].at });
    } else {
      // Still on its way: the place it will take, and nothing pretending to be
      // it — only the light of the wave passing over it.
      const centre = (x + thumbW / 2) / (padX * 2 + inner);
      const lit = wave < -0.5 ? 0 : Math.exp(-(((centre - wave) / 0.12) ** 2));
      const reading = slots[i].status === 'reading';
      ctx.fillStyle = P.accent;
      ctx.globalAlpha = (reading ? 0.05 : 0.025) + 0.16 * lit;
      ctx.fillRect(x, thumbY, thumbW, thumbH);
      ctx.globalAlpha = 0.5 + 0.5 * lit;
      ctx.strokeStyle = lit > 0.2 ? P.accent : P.rule;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, thumbY + 0.5, thumbW - 1, thumbH - 1);
      ctx.globalAlpha = 1;
    }
  }

  /* ---- the signature: this visit's twenty sectors, in their own shape -- */
  const cw = Math.max(2, Math.floor((thumbW - (COLS - 1)) / COLS));
  const ch = 6;
  for (let i = 0; i < n; i++) {
    const at = slots[i].at;
    const x0 = atSlot(i) + Math.max(0, (thumbW - (cw * COLS + COLS - 1)) / 2);
    for (let s = 0; s < COLS * ROWS; s++) {
      const cx = x0 + (s % COLS) * (cw + 1);
      const cy = sigY + Math.floor(s / COLS) * (ch + 1);
      const z = at >= 0 ? sectors?.cells?.[s]?.[at] : null;
      if (z == null) {
        ctx.fillStyle = P.ruleSoft;
        ctx.globalAlpha = at >= 0 ? 0.35 : 0.15;
      } else {
        ctx.fillStyle = P.accent;
        ctx.globalAlpha = Math.min(1, Math.max(0.05, z / TOP));
        // A lit cell is a place to look, so it can be pressed: that visit,
        // with that sector lit on the picture. The 1px gutter goes to the cell.
        // An unlit one is the ordinary frame, and a press there is a press on
        // its thumbnail.
        if (z >= LIT) hits.push({ x: cx, y: cy, w: cw + 1, h: ch + 1, i: at, sector: s + 1, score: z });
      }
      ctx.fillRect(cx, cy, cw, ch);
    }
  }
  ctx.globalAlpha = 1;

  /* ---- the dates ------------------------------------------------------- */
  ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  // Every date if they fit, otherwise every other one — a row of overlapping
  // dates is a grey smear, not a scale.
  const every = thumbW < 46 ? 2 : 1;
  for (let i = 0; i < n && !skeleton; i++) {
    if (i % every && i !== liveSlot) continue;
    // From the MJD, which is UTC by definition; the ISO string carries no zone
    // and would be read as local time.
    const d = toDate(slots[i].frame.mjd);
    ctx.fillStyle = i === liveSlot ? P.ink : (P.label ?? P.faint);
    ctx.globalAlpha = slots[i].visit ? 1 : 0.55;
    ctx.fillText(
      `${d.getUTCDate()} ${dateMonths[d.getUTCMonth()]}`,
      atSlot(i) + thumbW / 2, dateY + 10,
    );
  }
  ctx.globalAlpha = 1;

  return hits;
}

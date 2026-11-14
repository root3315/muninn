/**
 * marks.js — what a mark is, worked out and said the same way wherever it is
 * made: on the site's plate or on the headset's screen. The SkyBoT check, the
 * verdict, who the catalogues say it is, the season link and its arc, moved
 * here from app.js unchanged so both pages use one code; each page only lays
 * the words out.
 */

import { DETECTOR_ARCSEC, limitAB } from './depth.js';
import { tooSharp, MIN_JUDGED_SNR } from './sharpness.js';
import {
  linkSeasons, separationArcsec, parallaxArc, distanceGrid, arcPoint, ARC_TICKS_AU, NEAR_AU, FAR_AU,
} from './seasons.js';
import { mostlySaturated, shortName } from './sky.js';
import { chunkAt, forStack } from './stack.js';
import { t, fmt, fmtDate } from './i18n.js';
import { separation, deltaRA } from './wcs.js';
import { identifySource, arcsecBetween, SIMBAD_PAGE, VIZIER_PAGE } from './catalog.js';
import { deadline } from './net.js';
import { propagate, epochOfMjd } from './overlay.js';
import { brightStarNear } from './brightstars.js';

/**
 * Which seasons a mark is followed between: its own (A) and the one nearest
 * in time (B; SPHEREx comes back about half a year later), and the frames of
 * each to read, a stack's worth. `chunks` are the band's seasons
 * (stack.js seasonChunks), `ref` the frame the mark was made on, `visits`
 * those already read. Null when the band has one season only.
 */
export function planLink(chunks, ref, visits) {
  const a = chunkAt(chunks, ref.mjd);
  const others = chunks.map((c, k) => ({ c, k })).filter(({ k }) => k !== a);
  if (a < 0 || !others.length) return null;
  const mid = (c) => (c[0].mjd + c[c.length - 1].mjd) / 2;
  const b = others.sort((x, y) => Math.abs(mid(x.c) - ref.mjd) - Math.abs(mid(y.c) - ref.mjd))[0].k;
  const loadedB = visits.find((v) => v.frame.band === ref.band && chunkAt(chunks, v.frame.mjd) === b);
  return {
    loadedB,
    framesA: forStack(chunks[a], ref),
    framesB: forStack(chunks[b], loadedB?.frame ?? chunks[b][Math.floor(chunks[b].length / 2)]),
  };
}

/** The i18n key of each kind of mark (sky.js trackMark). */
export const CALL = {
  none: 'mark.callNone',
  transient: 'mark.callTransient',
  moving: 'mark.callMoving',
  fixed: 'mark.callFixed',
  saturated: 'mark.callSaturated',
  intermittent: 'mark.callIntermittent',
};

/** The shape reading of a mark's strongest detection, when it was seen at most twice. */
export function shapeOf(a) {
  if (!a?.track?.length || a.seen > 2) return null;
  const at = a.kind === 'transient' ? a.at : a.track.reduce((b, p) => ((p.snr ?? 0) > (b.snr ?? 0) ? p : b));
  return at?.sharp ?? null;
}

/** A mark's verdict in a word, in the page's language (`t` from i18n.js). */
export const markCall = (a, t) => (tooSharp(shapeOf(a)) ? t('sharp.call') : t(CALL[a?.kind ?? 'none'] ?? CALL.none));

/**
 * The measurement half of the season link: the mark anchored in season A,
 * the sources of season B, the static check, the decision (seasons.js
 * linkSeasons), on `sky`'s plate. `breathe` yields between visits.
 */
export async function measureLink(sky, m, visitsA, visitsB, { breathe = async () => {} } = {}) {
  // Where the mark is in season A, measured: the strongest detection of it.
  let anchorHit = null;
  const hitsA = [];
  for (const v of visitsA) {
    const hit = sky.measure(v, m.ra, m.dec);
    if (hit) hitsA.push(hit);
    if (hit && (!anchorHit || hit.snr > anchorHit.snr)) anchorHit = hit;
  }
  const refMjd = visitsA.find((v) => v.frame.obsId === m.obsId)?.frame.mjd ?? visitsA[0].frame.mjd;
  const anchor = anchorHit
    ? { ra: anchorHit.ra, dec: anchorHit.dec, mjd: anchorHit.mjd }
    : { ra: m.ra, dec: m.dec, mjd: refMjd };

  const sourcesOf = new Map();
  for (const v of visitsB) {
    sourcesOf.set(v.frame.obsId, sky.sources(v));
    await breathe();
  }
  // Inside the plate by the measuring box's own reach, so every point called
  // checkable could actually be measured.
  const perPixel = DETECTOR_ARCSEC / (sky.grid.scale * 3600);
  const margin = Math.ceil(5 * perPixel) + 1;
  const { width, height } = sky.grid;
  const inField = (ra, dec) => {
    const g = sky.grid.worldToIndex(ra, dec);
    return Boolean(g) && g[0] >= margin && g[1] >= margin && g[0] <= width - 1 - margin && g[1] <= height - 1 - margin;
  };
  // Something at the spot in season A, even at 3σ, makes it a fixed source.
  const occupied = (v, ra, dec) => {
    const hit = sky.measure(v.item, ra, dec, { minSnr: 3 });
    return Boolean(hit) && separationArcsec(hit, { ra, dec }) <= 1.5 * DETECTOR_ARCSEC;
  };
  const asVisit = (v) => ({ id: v.frame.obsId, mjd: v.frame.mjd, item: v });
  // The source at the mark, still at the same spot in a season-B visit.
  const anchorInB = (v) => {
    const hit = sky.measure(v.item, anchor.ra, anchor.dec);
    return Boolean(hit) && separationArcsec(hit, anchor) <= 1.5 * DETECTOR_ARCSEC;
  };
  const result = linkSeasons({
    anchor,
    aVisits: visitsA.map(asVisit),
    bVisits: visitsB.map(asVisit),
    sources: (v) => sourcesOf.get(v.id) ?? [],
    occupied,
    inField,
    anchorInB: anchorHit ? anchorInB : undefined,
    anchorSaturated: mostlySaturated(hitsA),
    pixelArcsec: DETECTOR_ARCSEC,
  });
  // A source at the mark that is still there in season B sits still: a star.
  const stillThere = result.star?.stillThere
    ?? (anchorHit ? visitsB.filter((v) => anchorInB(asVisit(v))).length : 0);
  const limits = visitsB.map((v) => limitAB(v.stamp.meta?.detectorSigma)).filter((x) => x != null).sort((x, y) => x - y);
  return {
    anchor,
    anchored: Boolean(anchorHit),
    stillThere,
    result,
    limit: limits.length ? limits[limits.length >> 1] : null,
    datesA: [visitsA[0].frame, visitsA[visitsA.length - 1].frame],
    visitsB: visitsB.map((v) => v.frame),
  };
}

/** The calendar date of a modified Julian date. */
export const mjdToDate = (mjd) => new Date((mjd - 40587) * 86400000);

/** A share as a whole percentage, never above 100. */
export const pct = (x) => fmt(Math.min(x, 1) * 100, 0);

/**
 * How far a SkyBoT position may sit from a measured one and still be the same
 * body: two detector pixels, since that is how well a SPHEREx position is
 * known, plus whatever SkyBoT says its own position may be off by.
 */
export const matchArcsec = (o) => 2 * DETECTOR_ARCSEC + (Number.isFinite(o.err) ? Math.min(o.err, 60) : 0);

/**
 * What SkyBoT says about something seen at these places, in these visits.
 * `seen` is [{ ra, dec, obsId }] — where it was measured and when. Only visits
 * where it was actually measured are asked about: a known asteroid passing the
 * same spot on another night is not this thing.
 *
 * `match` when any answered visit has a body there; otherwise `waiting`
 * while any is still out, `none` once they have answered, `failed` or `off`
 * when none could be asked.
 *
 * A match names the visit it was made in, and `unmatched` lists the answered
 * visits where the same spot had nothing catalogued. The Atala field is the
 * case: the centre flashes on 6 Jul and on 25 Dec, the asteroid explains only
 * the second, and a bare "In SkyBoT: Atala" quietly explained away the first.
 */
export function skybotVerdict(seen, { knownObjects, failed, on }) {
  let waiting = 0;
  let asked = 0;
  let off = 0;
  let match = null;
  const unmatched = [];
  for (const p of seen) {
    const objects = knownObjects.get(p.obsId);
    if (!objects) {
      if (failed.has(p.obsId)) continue;
      if (on) waiting += 1; else off += 1;
      continue;
    }
    asked += 1;
    const o = objects.find((x) => separation(p.ra, p.dec, x.ra, x.dec) * 3600 <= matchArcsec(x));
    if (!o) { unmatched.push(p.obsId); continue; }
    match ??= { state: 'match', name: o.num ? `(${o.num}) ${o.name}` : o.name, object: o, obsId: p.obsId };
  }
  if (match) return { ...match, unmatched };
  if (waiting) return { state: 'waiting' };
  if (asked) return { state: 'none' };
  return { state: off ? 'off' : 'failed' };
}

/** The date of a loaded visit, by its observation id. */
const visitDate = (visits, obsId) => {
  const v = visits.find((x) => x.frame.obsId === obsId);
  return v ? fmtDate(v.frame.iso) : '—';
};

/**
 * The places a tracked thing was seen, as skybotVerdict wants them. A spot
 * where nothing was seen, marked from a link with no visit of its own, is
 * asked about at the same place in every visit in `obsIds`: with no places at
 * all the verdict could only read "SkyBoT did not answer", though it had.
 */
export function seenAt(analysis, fallback, obsIds = []) {
  const track = analysis?.track ?? [];
  if (track.length) return track.map((p) => ({ ra: p.ra, dec: p.dec, obsId: p.obsId }));
  if (fallback?.obsId) return [fallback];
  return fallback ? obsIds.map((obsId) => ({ ra: fallback.ra, dec: fallback.dec, obsId })) : [];
}

/** The line a mark or a candidate shows for its SkyBoT check; `visits` date it. */
export function skybotLine(verdict, visits, { none = 'mark.unknown' } = {}) {
  switch (verdict?.state) {
    case 'match':
      return verdict.unmatched?.length
        ? t('mark.knownPartly', {
          name: verdict.name,
          when: visitDate(visits, verdict.obsId),
          others: verdict.unmatched.map((id) => visitDate(visits, id)).join(', '),
        })
        : t('mark.known', { name: verdict.name });
    case 'none': return t(none);
    case 'failed': return t('mark.skybotFailed');
    case 'off': return t('mark.skybotOff');
    default: return t('mark.skybotWaiting');
  }
}

/**
 * For styling: a name is quiet, "none" is the interesting case, the rest are
 * pending. A name that explains only some of the visits is still interesting.
 */
export const skybotTone = (verdict) => {
  if (verdict?.state === 'match') return verdict.unmatched?.length ? 'false' : 'true';
  return verdict?.state === 'none' ? 'false' : 'wait';
};

/**
 * The few words a mark carries on the picture beside its number: the body's
 * name if SkyBoT has one, the catalogue name of a star if one was found, and
 * otherwise what the measurement says it is.
 */
/** What the catalogues have said about a mark so far: all of it once done, the answers in while asking. */
export function whoSoFar(m) {
  if (m.who?.state === 'done') return m.who.result;
  return m.who?.state === 'asking' ? m.who.partial ?? null : null;
}

/**
 * The same, for a word drawn on the picture: only once both catalogues that
 * know how stars move have spoken, since before then a fast cold star can
 * carry its neighbour's name.
 */
export function whoSettled(m) {
  const r = whoSoFar(m);
  return r && !r.pending?.some((k) => k === 'gaia' || k === 'catwise') ? r : null;
}

export function tagOf(m) {
  if (m.known) return m.known;
  const r = whoSettled(m);
  if (r?.simbad) return shortName(r.simbad.name);
  if (r?.vsx) return r.vsx.name;
  if (r?.gaia && Number.isFinite(r.gaia.mag)) return `G ${fmt(r.gaia.mag, 1)}ᵐ`;
  return m.analysis ? markCall(m.analysis, t) : null;
}

/**
 * Who a mark is, when it is not an asteroid.
 *
 * A source that sits still in every visit cannot be a solar-system body, so it
 * is asked about at once. One that comes and goes might still be an asteroid,
 * and asking a star catalogue about it first would name whatever faint star
 * happens to lie near its path — so it waits until SkyBoT has said no.
 */
const IDENTIFY = new Set(['fixed', 'saturated', 'intermittent', 'transient']);
export const STILL = new Set(['fixed', 'saturated']);
/** When "asking" becomes "still asking", and when it gives up and says no answer came. */
const IDENTIFY_SLOW_MS = 10_000;
export const IDENTIFY_CAP_MS = 75_000;
/** A mark's centre moved less than this asks the catalogues nothing new: a third of a detector pixel. */
const SAME_SPOT_ARCSEC = 2;

/**
 * Ask the catalogues about a mark (catalog.js identifySource), at the
 * measured centre of its run. `loading` holds the question while visits are
 * still landing; `fieldSignal` is the open field's, `visits` its visits;
 * `live()` says whether the mark is still kept; `onChange` redraws when an
 * answer, a part of one or a failure comes, `onSlow` when "asking" turns into
 * "still asking".
 */
export function identifyMark(m, { loading, fieldSignal, visits, live, onChange, onSlow = onChange }) {
  // While visits are still landing the measured centre moves a little with
  // each one; the catalogues are asked once, about the centre of the whole run.
  if (loading) return;
  const a = m.analysis;
  const ready = a && IDENTIFY.has(a.kind)
    && (STILL.has(a.kind) || ['none', 'failed', 'off'].includes(m.catalog?.state));
  // While SkyBoT is asked again about newly landed visits, what the star
  // catalogues said stays. A mark that is no longer a thing to identify, or
  // that SkyBoT has matched to a body in any visit, loses it: a neighbouring
  // star's name must not sit on an asteroid.
  if (!ready) {
    if (!(a && IDENTIFY.has(a.kind)) || m.catalog?.state === 'match') {
      m.whoStop?.abort();
      m.who = null;
    }
    return;
  }

  // The measured centre, not the click: that is what a catalogue should be asked about.
  const pts = a.track.length ? a.track : [{ ra: m.ra, dec: m.dec }];
  // Averaged as offsets from the first point, so a spot on the 0h meridian
  // (359.999° and 0.001°) averages to itself and not to 180°.
  const ra0 = pts[0].ra;
  const meanRA = ra0 + pts.reduce((s, p) => s + deltaRA(p.ra, ra0), 0) / pts.length;
  // The date the catalogues are compared at: the visits' own, on average,
  // so a fast star is looked for where it was when SPHEREx saw it.
  const dated = pts.filter((p) => Number.isFinite(p.mjd));
  const mjd = dated.length ? dated.reduce((s, p) => s + p.mjd, 0) / dated.length
    : visits.reduce((s, v) => s + v.frame.mjd, 0) / Math.max(1, visits.length);
  const at = {
    ra: ((meanRA % 360) + 360) % 360,
    dec: pts.reduce((s, p) => s + p.dec, 0) / pts.length,
    epoch: Number.isFinite(mjd) && mjd > 0 ? 2000 + (mjd - 51544.5) / 365.25 : 2026,
  };
  // The centre settles as visits land. A move of a fraction of a pixel is
  // the same question: asked again for every 0.4″, ten marks kept dozens of
  // catalogue questions in flight while a field filled in.
  const key = `${at.ra.toFixed(4)} ${at.dec.toFixed(4)}`;
  if (m.who?.at && arcsecBetween(m.who.at.ra, m.who.at.dec, at.ra, at.dec) < SAME_SPOT_ARCSEC) return;
  // The last question is moot: let it go.
  m.whoStop?.abort();
  const stop = new AbortController();
  m.whoStop = stop;
  const who = { key, at, state: 'asking', slow: false };
  m.who = who;
  const field = fieldSignal ? AbortSignal.any([fieldSignal, stop.signal]) : stop.signal;
  // Every question ends in an answer, a failure or "no answer": the relays to
  // IRSA can take a minute, and a line that says "asking" for ever reads as a
  // page that has hung. Past a few seconds it says it is still asking.
  const signal = deadline(field, IDENTIFY_CAP_MS);
  const settle = (next) => {
    clearTimeout(slowTimer);
    if (m.who !== who) return;
    m.who = next;
    if (!live()) return;
    m.tag = tagOf(m);
    onChange();
  };
  const slowTimer = setTimeout(() => {
    if (m.who !== who || who.state !== 'asking') return;
    who.slow = true;
    if (live()) onSlow();
  }, IDENTIFY_SLOW_MS);
  // Each answer is shown as it comes: SIMBAD's name in a second need not
  // wait on an IRSA catalogue that takes twenty.
  const onUpdate = (partial) => {
    if (m.who !== who || !live()) return;
    who.partial = partial;
    m.tag = tagOf(m);
    onChange();
  };
  identifySource(at, { signal, onUpdate })
    .then((result) => settle({ key, at, state: 'done', result }))
    .catch(() => {
      // The field was closed under the question: nobody is waiting for this
      // answer, and a mark carried into the next field asks afresh.
      if (field?.aborted) settle(null);
      else settle({ key, at, state: signal.aborted ? 'timeout' : 'failed' });
    });
}

export const CATALOGUE_NAMES = { simbad: 'SIMBAD', gaia: 'Gaia', tmass: '2MASS', wise: 'AllWISE', catwise: 'CatWISE2020', vsx: 'VSX' };

/** What Gaia's classifier makes of a source, when it is sure enough to say. */
function gaiaKind(g) {
  if (g.pGalaxy >= 0.5) return t('kind.galaxy');
  if (g.pQuasar >= 0.5) return t('kind.quasar');
  if (g.pStar >= 0.9) return t('kind.star');
  return t('kind.gaia');
}

/** A line of words: plain text, or a name with the catalogue page it links to. */
const whoP = (...parts) => ({ parts });
const link = (text, href) => ({ text, href });

/**
 * What the catalogues said about a mark, a line per question: who it is, does
 * it vary, what it looks like in the near infrared SPHEREx sees, how far away.
 * A line appears only when a catalogue had something to say. Each line is
 * `{ parts }` (strings, and `{ text, href }` for a linked name), `phot: true`
 * on the photometry line, or `{ asking: true, text }` while still asking.
 */
export function whoWords(who, kind) {
  if (who.state === 'asking') {
    const out = who.partial?.asking ?? [];
    const so = who.partial ? answerLines(who.partial, kind) : [];
    const text = so.length && out.length
      ? t('mark.whoStill', { list: out.map((k) => CATALOGUE_NAMES[k]).join(', ') })
      : t(who.slow ? 'mark.whoSlow' : 'mark.whoAsking');
    return [...so, { asking: true, text }];
  }
  if (who.state === 'failed') return [whoP(t('mark.whoFailed'))];
  if (who.state === 'timeout') return [whoP(t('mark.whoTimeout', { s: Math.round(IDENTIFY_CAP_MS / 1000) }))];
  const r = who.result;
  const lines = answerLines(r, kind);
  // "Nothing" is said only for the catalogues that answered.
  if (!lines.length) lines.push(whoP(t(r.failed.length ? 'mark.whoNoneRest' : 'mark.whoNone')));
  if (r.failed.length) lines.push(whoP(t('mark.whoPartial', { list: r.failed.map((k) => CATALOGUE_NAMES[k]).join(', ') })));
  return lines;
}

/** A line for each thing the catalogues had to say, from all of them or the ones in so far. */
function answerLines(r, kind) {
  const lines = [];
  const heard = (key) => !r.failed.includes(key) && !r.pending?.includes(key);
  // Beyond a couple of arcsec the name is a neighbour's, and it should say so.
  const off = (sep) => (sep > 2 ? `, ${t('mark.whoSep', { sep: fmt(sep, 1) })}` : '');

  if (r.simbad) {
    const s = r.simbad;
    const what = s.family ? t(`kind.${s.family}`) : t('kind.other', { code: s.otype });
    const mag = Number.isFinite(s.mag) ? `, ${s.magBand} ${fmt(s.mag, 1)}ᵐ` : '';
    lines.push(whoP(`${t('mark.whoSimbad')} `,
      link(s.name, `${SIMBAD_PAGE}${encodeURIComponent(s.name)}`),
      ` — ${what}${mag}${off(s.sep)}`));
  } else if (r.gaia) {
    const g = r.gaia;
    const mag = Number.isFinite(g.mag) ? `, G ${fmt(g.mag, 1)}ᵐ` : '';
    lines.push(whoP(`${t('mark.whoGaia')} `,
      link(g.id, `${VIZIER_PAGE}-source=I/355/gaiadr3&Source=${encodeURIComponent(g.id)}`),
      ` — ${gaiaKind(g)}${mag}${off(g.sep)}`));
  }

  // Does it vary? For something that comes and goes, the first question.
  if (r.vsx) {
    const v = r.vsx;
    const bits = [v.type ? `${t('kind.variable')} ${v.type}` : t('kind.variable')];
    // VSX gives the faint end as an amplitude when it has no minimum: a
    // number smaller than the bright end cannot be a magnitude there.
    if (Number.isFinite(v.max) && Number.isFinite(v.min)) {
      bits.push(v.min > v.max ? `${fmt(v.max, 2)}–${fmt(v.min, 2)}ᵐ` : t('mark.whoAmplitude', { max: fmt(v.max, 2), amp: fmt(v.min, 2) }));
    }
    if (Number.isFinite(v.period)) bits.push(t('mark.whoPeriod', { p: fmt(v.period, v.period < 10 ? 3 : 1) }));
    lines.push(whoP('VSX: ',
      link(v.name, `https://www.aavso.org/vsx/index.php?view=results.get&ident=${encodeURIComponent(v.name)}`),
      ` — ${bits.join(', ')}`));
  } else if (r.gaia?.variable) {
    lines.push(whoP(t('mark.whoGaiaVar')));
  } else if ((kind === 'intermittent' || kind === 'transient') && r.any && heard('vsx') && heard('gaia')) {
    lines.push(whoP(t('mark.whoNotVar')));
  }

  // The near infrared, which is what SPHEREx itself sees.
  const phot = [];
  if (r.tmass) {
    for (const [band, v] of [['J', r.tmass.j], ['H', r.tmass.h], ['K', r.tmass.k]]) {
      if (Number.isFinite(v)) phot.push(`${band} ${fmt(v, 1)}`);
    }
  }
  if (r.wise) {
    if (Number.isFinite(r.wise.w1)) phot.push(`W1 ${fmt(r.wise.w1, 1)}`);
    if (Number.isFinite(r.wise.w2)) phot.push(`W2 ${fmt(r.wise.w2, 1)}`);
  }
  if (phot.length) {
    const p = whoP(`${[r.tmass && '2MASS', r.wise && 'AllWISE'].filter(Boolean).join(' · ')}: ${phot.join(' · ')}`);
    p.phot = true;
    lines.push(p);
  }

  // A distance, only where the parallax is measured and not merely returned.
  const g = r.gaia;
  if (g && g.plx > 0 && g.plxErr > 0 && g.plx / g.plxErr >= 5) {
    const pc = 1000 / g.plx;
    lines.push(whoP(t('mark.whoPlx', { plx: fmt(g.plx, 2), pc: fmt(pc, pc < 100 ? 1 : 0) })));
  }
  if (r.catwise?.pm != null) lines.push(whoP(t('mark.whoCatwise', { pm: fmt(r.catwise.pm, 2) })));
  return lines;
}

/** A number to `digits` significant figures: 0,0042 and 21,3 alike, never 0,00. */
export function fmtSig(v, digits) {
  if (!Number.isFinite(v) || v === 0) return fmt(v, 0);
  const decimals = Math.max(0, digits - 1 - Math.floor(Math.log10(Math.abs(v))));
  return fmt(v, Math.min(6, decimals));
}

/**
 * The verdict, and how many loaded visits never saw the spot: those are left
 * out of every count in it, and the reader is told so.
 */
export function verdict(a) {
  const text = verdictOnly(a);
  const unseen = (a?.loaded ?? 0) - (a?.total ?? 0);
  return unseen > 0 && a?.total ? `${text} ${t('mark.uncoveredSome', { n: unseen })}` : text;
}

function verdictOnly(a) {
  if (a && !a.total) return t('mark.uncovered');
  if (!a || a.kind === 'none') return t('mark.undetected', { total: a?.total ?? 0 });
  if (a.kind === 'transient') {
    return t('mark.transient', {
      date: fmtDate(mjdToDate(a.at.mjd).toISOString()),
      snr: fmt(a.at.snr, 0), rest: a.total - 1,
    });
  }
  if (a.kind === 'moving') {
    return t('mark.moving', { rate: fmtSig(a.ratePerHour, 3), seen: a.seen, days: fmt(a.spanDays, 1), rms: fmt(a.rms, 1) });
  }
  if (a.kind === 'fixed') return t('mark.fixed', { total: a.total, rms: fmt(a.rms, 1) });
  if (a.kind === 'saturated') return t('mark.saturated', { n: a.saturated, total: a.total });
  // Two points always fit a straight line perfectly, so quoting a scatter would be
  // a number with no information in it. Name the dates instead.
  if (a.seen <= 3) {
    const dates = a.track.map((p) => fmtDate(mjdToDate(p.mjd).toISOString())).join(', ');
    return t('mark.intermittentDates', { seen: a.seen, total: a.total, dates });
  }
  return t('mark.intermittent', { seen: a.seen, total: a.total, rms: fmt(a.rms, 1) });
}

/**
 * Context for a spot that comes and goes near a very bright star, or null.
 * Such a star's ghosts and stray light land somewhere new with each roll of
 * the spacecraft, so they show in a few visits only, and no catalogue lists
 * them. The verdict stays what the visits say; this only names the likely
 * cause beside it. `stars` is the catalogue's bright list (brightstars.js
 * brightStars). A mark on the star itself gets no such line.
 */
const BLINKS = new Set(['intermittent', 'transient']);
const ON_THE_STAR_ARCMIN = 1;

export function brightNeighbourWords(m, stars) {
  if (!BLINKS.has(m?.analysis?.kind) || !Number.isFinite(m.ra) || !Number.isFinite(m.dec)) return null;
  const star = brightStarNear(stars, m.ra, m.dec);
  if (!star?.name || star.distArcmin < ON_THE_STAR_ARCMIN) return null;
  return t('mark.brightNeighbour', {
    name: star.name, dist: fmt(star.distArcmin, 0), mag: fmt(star.mag, 2).replace('-', '−'),
  });
}

/** The shape reading of a mark in words, with its verdict (sharp, star, …), or null. */
export function sharpWords(a) {
  const v = shapeOf(a);
  if (!v) return null;
  const words = { share: pct(v.share), limit: v.limit ? pct(v.limit) : '', snr: fmt(v.snr, 0), min: fmt(MIN_JUDGED_SNR, 0) };
  return { text: t(`sharp.mark.${v.verdict}`, words), verdict: v.verdict };
}

/**
 * A saturated source cannot be centred well enough to see it move, but a
 * catalogue that knows its motion can say how far it went over these visits,
 * against the one detector pixel a blink could ever show. The motion is the
 * identification's (Gaia, else CatWISE2020), or the named target's (`tg`) when
 * the mark sits on it.
 */
export function saturatedMotion(m, tg) {
  const a = m.analysis;
  if (a?.kind !== 'saturated' || !(a.spanDays > 0)) return null;
  const r = whoSoFar(m);
  const when = a.track.reduce((s, p) => s + p.mjd, 0) / a.track.length;
  const target = tg && Number.isFinite(tg.epoch)
    && separationArcsec(propagate(tg, epochOfMjd(when), tg.epoch), m) <= 3 * DETECTOR_ARCSEC ? tg : null;
  const source = [r?.gaia, r?.catwise, target].find((s) => Number.isFinite(s?.pmRA) && Number.isFinite(s?.pmDE));
  if (!source) return null;
  const pm = Math.hypot(source.pmRA, source.pmDE) / 1000;
  // An ordinary star's motion rounds to nothing here; only a fast one is worth a line.
  if (pm < 0.1) return null;
  const shift = (pm * a.spanDays) / 365.25;
  return t(shift < DETECTOR_ARCSEC ? 'mark.saturatedUnder' : 'mark.saturatedOver', {
    pm: fmt(pm, pm < 1 ? 2 : 1), shift: fmt(shift, 1), days: fmt(a.spanDays, 0),
    px: fmt(DETECTOR_ARCSEC, 2), n: fmt(shift / DETECTOR_ARCSEC, 1),
  });
}

/**
 * One mark's arc for the plate (sky.js draws `sky.link`), or null. The arc is
 * for the season-B visit that matched, or the first one read; the visits of
 * one season are days apart, which at these distances moves the arc far less
 * than the parallax.
 */
export function linkArc(m) {
  const link = m?.link;
  // A star has no arc to follow.
  if (!link || link.state !== 'done' || !link.shown || link.result.star) return null;
  const hit = link.result.link;
  const mjdB = hit ? hit.visits[0].mjd : link.visitsB[0].mjd;
  const { ra, dec, mjd } = link.anchor;
  const points = parallaxArc(ra, dec, mjd, mjdB, distanceGrid({ near: NEAR_AU, far: FAR_AU, steps: 240 }));
  const ticks = ARC_TICKS_AU.map((d) => ({
    d,
    point: arcPoint(ra, dec, mjd, mjdB, d),
    next: arcPoint(ra, dec, mjd, mjdB, d * 1.02),
  })).filter((tk) => tk.point && tk.next);
  return {
    mark: m,
    points,
    ticks,
    match: hit ? hit.visits[0].at : null,
    tickLabel: (d) => t('link.tick', { d: String(d) }),
  };
}

/**
 * What a mark's season link says, a line at a time (`{ text, tone }`; tone
 * wait, counter or quiet): reading, one season only, failed, or the answer.
 */
export function linkWords(link) {
  const out = [];
  const line = (text, tone) => out.push({ text, tone });
  if (link.state === 'reading') {
    line(t('link.reading', { n: link.n, total: link.total }), 'wait');
    return out;
  }
  if (link.state === 'single') { line(t('link.single', { band: link.band })); return out; }
  if (link.state === 'failed') { line(t('link.failed', { why: link.why ?? '' })); return out; }

  const r = link.result;
  const dateB = fmtDate(link.visitsB[0].iso);
  // A star at the mark is the whole answer: nothing on the arc is offered
  // as where it went, because it did not go anywhere.
  if (r.star) {
    line(t(r.star.saturated ? 'link.starSaturated' : 'link.star', {
      n: r.star.stillThere, total: r.checked, date: dateB,
    }));
    if (r.star.stillThere) line(t('link.starWhy'), 'quiet');
    return out;
  }
  if (!r.covered) {
    line(t('link.outside', { near: fmt(NEAR_AU, 0), far: fmt(FAR_AU, 0) }));
  } else if (r.link) {
    const h = r.link;
    line(t(link.anchored ? 'link.linked' : 'link.unanchored', {
      d: fmt(h.d, 0), near: fmt(h.near, 0), far: fmt(h.far, 0),
      mag: h.mag != null ? fmt(h.mag, 1) : '—', band: link.band,
      n: h.visits.length, total: r.checked, date: dateB,
    }), 'counter');
    line(t('link.check'));
  } else {
    line(t('link.nothing', {
      near: fmt(r.covered.near, 0), far: fmt(r.covered.far, 0),
      limit: link.limit != null ? fmt(link.limit, 1) : '—', band: link.band, n: r.checked, date: dateB,
    }));
  }
  if (r.covered) {
    line(t('link.covered', {
      near: fmt(r.covered.near, 0), far: fmt(r.covered.far, 0), from: fmt(NEAR_AU, 0), to: fmt(FAR_AU, 0),
    }), 'quiet');
  }
  if (!link.anchored) line(t('link.noAnchor', { date: fmtDate(link.datesA[0].iso) }));
  if (link.stillThere) line(t('link.stillThere', { n: link.stillThere, total: r.checked }));
  if (r.staticCount) line(t('link.static', { n: r.staticCount }), 'quiet');
  if (r.checked < 2) line(t('link.oneVisit'));
  line(t('link.how'), 'quiet');
  return out;
}

/**
 * A mark dropped on a SkyBoT ring where SPHEREx measured nothing is not
 * "nothing here" next to "in the catalogue" — read together those sound like
 * a contradiction. It is one finding: the orbit puts a body here and it is
 * too faint to show in a single visit. Its verdict, detail and catalogue
 * line, or null for any other mark.
 */
export function predictedWords(m) {
  if (m.catalog?.state !== 'match' || (m.analysis?.kind ?? 'none') !== 'none') return null;
  const o = m.catalog.object;
  return {
    call: t('mark.callPredicted'),
    detail: Number.isFinite(o?.mag)
      ? t('mark.predicted', { name: m.catalog.name, mag: fmt(o.mag, 1), total: m.analysis?.total ?? 0 })
      : t('mark.predictedNoMag', { name: m.catalog.name, total: m.analysis?.total ?? 0 }),
    id: t('mark.predictedWhy'),
  };
}

/** The peak brightness of a mark in each visit it was measured in, by observation id. */
export function peaksOf(analysis) {
  return new Map((analysis?.track ?? []).map((d) => [d.obsId, Math.max(d.flux ?? 0, 0)]));
}

/**
 * The brightness range of a mark seen more than once, in words, or null. A
 * saturated star has none: its verdict already says no brightness is quoted,
 * and the clipped peak would read as a number ("6.9–6.9 AB").
 */
export function brightnessWords(a) {
  if (!a?.brightness || !(a.seen > 1) || a.kind === 'saturated') return null;
  return t('mark.brightness', { bright: fmt(a.brightness.brightest, 1), faint: fmt(a.brightness.faintest, 1), band: a.brightness.band });
}

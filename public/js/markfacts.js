/**
 * markfacts.js — a mark's facts line: what a folded mark says at a glance.
 *
 * The line a known body's card in Hunter X carries ("6 Jul 2025 · D2 ·
 * V 18.4ᵐ · 35″/h · 6σ"), for a mark: the band, where, the one number the
 * verdict rests on, and in how many visits it was seen. Each bit is kept
 * whole when the line wraps, so "6σ" never lands on a line of its own.
 *
 * Pure: the wording comes in as `t`, numbers through `fmt`, dates through
 * `day`, so the line is tested in Node in both languages.
 */

const SECONDS_PER_DAY = 86400;
const MJD_UNIX_EPOCH = 40587;

/** An MJD as an ISO date, the form `day` reads. */
const isoOf = (mjd) => new Date((mjd - MJD_UNIX_EPOCH) * SECONDS_PER_DAY * 1000).toISOString();

/** A number to three significant figures, as a rate is quoted elsewhere. */
function sig3(v, fmt) {
  if (!Number.isFinite(v) || v === 0) return fmt(v, 0);
  return fmt(v, Math.min(6, Math.max(0, 2 - Math.floor(Math.log10(Math.abs(v))))));
}

/**
 * The bits of a mark's facts line, in order: `{ text, key }`, `key` true for
 * the number the verdict rests on. `a` is the mark's analysis (or null while
 * it is measured), `band` the band the mark was measured in, `ra`/`dec` where.
 */
export function markFacts(a, { band, ra, dec }, { t, fmt, day }) {
  const bits = [];
  if (band) bits.push({ text: band });
  if (Number.isFinite(ra) && Number.isFinite(dec)) {
    bits.push({ text: `${fmt(ra, 3)}° ${dec < 0 ? '−' : '+'}${fmt(Math.abs(dec), 3)}°` });
  }
  if (!a) return bits;
  const kind = a.kind ?? 'none';
  if (kind === 'transient' && a.at) {
    bits.push({ text: day(isoOf(a.at.mjd)) });
    bits.push({ text: `${fmt(a.at.snr, 0)}σ`, key: true });
  } else if (kind === 'moving' && Number.isFinite(a.ratePerHour)) {
    bits.push({ text: t('overlay.rate', { rate: sig3(a.ratePerHour, fmt) }), key: true });
  } else if (kind === 'fixed' && a.brightness) {
    bits.push({ text: `${fmt(a.brightness.brightest, 1)} AB`, key: true });
  }
  // Saturated light has no brightness to quote, and nothing seen has no number.
  if (a.total) {
    const seen = kind === 'none' ? 0 : kind === 'saturated' ? (a.saturated ?? a.seen ?? 0) : (a.seen ?? 0);
    bits.push({ text: t('mark.factVisits', { seen, total: a.total }), key: kind === 'intermittent' });
  }
  return bits;
}

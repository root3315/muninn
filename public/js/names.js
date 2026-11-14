/**
 * Catalogue names as people type them, put the way the name resolver reads
 * them. Sesame already takes "HD209458", "TIC25155310" and "GaiaDR3 …"; it
 * does not take a Gaia number without its release, a TIC number with a
 * hyphen, or a 2MASS name without the J, and those are the forms fixed here.
 * Anything else is passed through unchanged.
 */

/** The text with typographic dashes as hyphens and single spaces. */
const tidy = (text) => String(text ?? '').replace(/[−–—]/g, '-').replace(/\s+/g, ' ').trim();

export function normaliseName(raw) {
  const text = tidy(raw);

  // "Gaia 4472832130942575872", "Gaia EDR3 …": EDR3 and DR3 share their
  // source numbers, and a bare number is taken as the current release.
  let m = /^gaia[ _-]?(?:(e?dr[123])[ _-]?)?(\d{6,20})$/i.exec(text);
  if (m) {
    const release = !m[1] || /^edr3$/i.test(m[1]) ? 'DR3' : m[1].toUpperCase();
    return `Gaia ${release} ${m[2]}`;
  }

  // "TIC-25155310", "tic_25155310".
  m = /^tic[ _-]*(\d{1,10})$/i.exec(text);
  if (m) return `TIC ${m[1]}`;

  // "2MASS 05551028+0724255", "2MASS-J05551028+0724255".
  m = /^2mass[ _-]*j?[ _-]*(\d{8}[+-]\d{7})$/i.exec(text);
  if (m) return `2MASS J${m[1]}`;

  return text;
}

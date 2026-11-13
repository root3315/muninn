/**
 * gaiasky.js — the field as Gaia's catalogue says it should look, drawn on
 * the same grid as the SPHEREx visits, so the wipe can put one beside the
 * other.
 *
 * Gaia publishes positions and brightnesses, not pictures. This is therefore
 * a model, and is labelled as one wherever it is shown: every Gaia DR3 source
 * of the field, carried by its proper motion from J2016.0 to the date of the
 * visit beside it, drawn as a round Gaussian as wide as SPHEREx's own blur in
 * that band, with a brightness that follows its G magnitude, on a sky of
 * nothing. Its use is what it lacks: anything in the SPHEREx picture with no
 * counterpart here — an asteroid, a brown dwarf too cold and faint for Gaia's
 * optical eye, a transient — is something the catalogue does not account for.
 *
 * The flux scale is relative, ten to the −0.4 G and nothing more. G is an
 * optical band and SPHEREx sees 0.75–5 µm, so a red star is brighter on the
 * left of the divider than on the right and a blue one the other way round;
 * no calibration is claimed or wanted for "is there something there".
 */

import { propagate, epochOfMjd } from './overlay.js';

/**
 * SPHEREx's point-spread width per band, in arcseconds: the median
 * second-moment FWHM of unsaturated stars (50–3000σ) on the detector pixels
 * of the Atala field, every DR1 and QR3 visit, with the pixel's own width
 * taken out (42 to 219 stars a band; tools/sharpness-calibrate.mjs). Near
 * one 6.15″ pixel in the short bands and wider at the long
 * end, where diffraction grows. Approximate by construction: an undersampled
 * star's moments depend on where it fell in its pixel.
 */
export const PSF_FWHM_ARCSEC = { D1: 6.6, D2: 6.9, D3: 7.0, D4: 8.9, D5: 9.1, D6: 9.9 };

/** The width used when the band is not one of the six (a field opened on "all"). */
export const PSF_FWHM_DEFAULT = 7.0;

const FWHM_TO_SIGMA = 1 / (2 * Math.sqrt(2 * Math.log(2)));
/** Out to this many σ a star is drawn; past it the Gaussian is under 1/3000 of its peak. */
const REACH_SIGMA = 4;

/** Relative flux for a G magnitude: one at G = 15, by the definition of a magnitude. */
export const fluxOfG = (g) => 10 ** (-0.4 * (g - 15));

/**
 * Draw `sources` (Gaia rows: ra, dec, mag = G, pmRA, pmDE) onto `grid` as
 * they stood at `mjd`. Returns `{ data, width, height, drawn, limits }`:
 * `drawn` counts the stars whose light landed on the grid, and `limits` is a
 * black and white point for painting it (the model's sky is exactly zero, so
 * a percentile cut would find nothing to cut on).
 */
export function drawGaiaSky(grid, sources, { mjd, fwhmArcsec = PSF_FWHM_DEFAULT } = {}) {
  const { width: W, height: H } = grid;
  const data = new Float32Array(W * H);
  const epoch = Number.isFinite(mjd) ? epochOfMjd(mjd) : undefined;
  const sigma = (fwhmArcsec * FWHM_TO_SIGMA) / (grid.scale * 3600);
  const reach = Math.max(2, Math.ceil(REACH_SIGMA * sigma));
  const norm = 1 / (2 * Math.PI * sigma * sigma);
  const peaks = [];
  let drawn = 0;

  for (const s of sources) {
    if (!Number.isFinite(s.mag)) continue;
    const at = epoch === undefined ? s : propagate(s, epoch);
    const g = grid.worldToIndex(at.ra, at.dec);
    if (!g) continue;
    const [x, y] = g;
    if (x < -reach || y < -reach || x > W - 1 + reach || y > H - 1 + reach) continue;
    const amp = fluxOfG(s.mag) * norm;
    let landed = false;
    for (let j = Math.max(0, Math.floor(y - reach)); j <= Math.min(H - 1, Math.ceil(y + reach)); j++) {
      const dy = j - y;
      for (let i = Math.max(0, Math.floor(x - reach)); i <= Math.min(W - 1, Math.ceil(x + reach)); i++) {
        const dx = i - x;
        data[j * W + i] += amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        landed = true;
      }
    }
    if (landed) { drawn += 1; peaks.push(amp); }
  }

  // White at the peak of the fifth-brightest star: the few brightest burn
  // out as they would in any picture, and the rest keep their order.
  peaks.sort((a, b) => b - a);
  const hi = peaks[Math.min(4, peaks.length - 1)] ?? 1;
  return { data, width: W, height: H, drawn, limits: { lo: 0, hi } };
}

/** The band's PSF width, or the default for a field opened on every band. */
export const psfFor = (band) => PSF_FWHM_ARCSEC[band] ?? PSF_FWHM_DEFAULT;

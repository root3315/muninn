/**
 * stars.js — how big and how bright a star is, from what a catalogue gives.
 *
 * Hipparcos gives a star's distance, its brightness and its colour. Its size
 * follows from those, as estimates and said to be estimates:
 *
 *   V             from Hipparcos's own magnitude, Hp, by the colour (vFromHp)
 *   temperature   from B−V (Ballesteros 2012)
 *   luminosity    from the absolute V, with the bolometric correction for
 *                 that temperature (Torres 2010)
 *   radius        from luminosity and temperature (Stefan–Boltzmann)
 *
 * Checked against stars with measured radii: the Sun comes out 0.99 R☉,
 * Sirius 1.69 from its measured V (measured radius 1.71; from its saturated
 * Hp it would be 1.44), Arcturus 28 (25.4), Rigel 77 (79). The
 * coolest stars are where it is weakest — B−V saturates — so the stars the
 * page names carry their measured radii instead.
 */

/** The Sun's effective temperature (IAU 2015), K. */
export const T_SUN = 5772;
/** The Sun's absolute bolometric magnitude (IAU 2015). */
export const MBOL_SUN = 4.74;
/** The Sun's radius in parsecs. */
export const R_SUN_PC = 695700 / 3.0856775814913673e13;

/**
 * V from a Hipparcos magnitude Hp and B−V. Hipparcos measured in its own
 * broad band, Hp, redder than Johnson V; V − Hp as a cubic in B−V, fitted
 * here to the 14 679 stars of the Hipparcos main catalogue (ESA 1997, I/239)
 * with a ground-based V, Hp 2–9 and B−V −0.3 to 2.0: scatter 0.06 mag. It
 * holds for the stars Hipparcos did not saturate; Sirius (Hp −1.09, V −1.44)
 * and the other brightest named stars carry their measured V instead.
 */
export function vFromHp(hp, bv) {
  const x = Math.max(-0.3, Math.min(2.0, Number.isFinite(bv) ? bv : 0.65));
  return hp - 0.0002 - 0.2682 * x + 0.0911 * x * x + 0.0229 * x * x * x;
}

/** Effective temperature from B−V, K (Ballesteros 2012). */
export const temperatureOf = (bv) => 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));

/** Bolometric correction for V at a temperature (Torres 2010, Table 1 polynomials). */
export function bolometricCorrection(t) {
  const x = Math.log10(t);
  let c;
  if (x < 3.7) c = [-0.190537291496456e5, 0.155144866764412e5, -0.421278819301717e4, 0.381476328422343e3];
  else if (x < 3.9) c = [-0.370510203809015e5, 0.385672629965804e5, -0.150651486316025e5, 0.261724637119416e4, -0.170623810323864e3];
  else c = [-0.118115450538963e6, 0.137145973583929e6, -0.636233812100225e5, 0.147412923562646e5, -0.170587278406872e4, 0.788731721804990e2];
  return c.reduce((sum, a, i) => sum + a * x ** i, 0);
}

/** Luminosity in solar units from an absolute magnitude and B−V. */
export const luminosityOf = (absMag, bv) => 10 ** (-0.4 * (absMag + bolometricCorrection(temperatureOf(bv)) - MBOL_SUN));

/** Planck's law, up to a constant: the light of a body at temperature t at wavelength λ (µm). */
const planck = (lambdaUm, t) => 1 / (lambdaUm ** 5 * (Math.exp(14387.77 / (lambdaUm * t)) - 1));

/** Vega's temperature, K: by definition of the Vega system its V − W2 is zero. */
const T_VEGA = 9602;

/**
 * V − W2 (4.6 µm) for a star of temperature t, as a blackbody, in the Vega
 * system. An estimate from colour alone — real stars have lines and dust —
 * and said to be one wherever it shows.
 */
export const vMinusW2 = (t) => 2.5 * Math.log10((planck(4.6, t) / planck(0.55, t)) / (planck(4.6, T_VEGA) / planck(0.55, T_VEGA)));

/** Radius in solar radii from an absolute magnitude and B−V. */
export function radiusOf(absMag, bv) {
  const t = temperatureOf(bv);
  return Math.sqrt(luminosityOf(absMag, bv)) * (T_SUN / t) ** 2;
}

/**
 * stars.js — how big and how bright a star is, from what a catalogue gives.
 *
 * Hipparcos gives a star's distance, its brightness and its colour. Its size
 * follows from those, as estimates and said to be estimates:
 *
 *   temperature   from B−V (Ballesteros 2012)
 *   luminosity    from the absolute magnitude, with the bolometric correction
 *                 for that temperature (Torres 2010)
 *   radius        from luminosity and temperature (Stefan–Boltzmann)
 *
 * Checked against stars with measured radii: the Sun comes out 0.99 R☉,
 * Sirius 1.69 (measured 1.71), Arcturus 27 (25.4), Rigel 79 (79). The
 * coolest stars are where it is weakest — B−V saturates — so the stars the
 * page names carry their measured radii instead.
 */

/** The Sun's effective temperature (IAU 2015), K. */
export const T_SUN = 5772;
/** The Sun's absolute bolometric magnitude (IAU 2015). */
export const MBOL_SUN = 4.74;
/** The Sun's radius in parsecs. */
export const R_SUN_PC = 695700 / 3.0856775814913673e13;

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

/** Radius in solar radii from an absolute magnitude and B−V. */
export function radiusOf(absMag, bv) {
  const t = temperatureOf(bv);
  return Math.sqrt(luminosityOf(absMag, bv)) * (T_SUN / t) ** 2;
}

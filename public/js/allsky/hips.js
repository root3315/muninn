/**
 * hips.js — the SPHEREx DR1 all-sky cube at IRSA, as the page reads it.
 *
 * IRSA serves the whole sky as one HiPS cube: 102 frames in ascending
 * wavelength, one per band (D1–D6) and channel (1–17), each frame the full
 * sky down to order 5 (tiles of 512 pixels, 12.9″ each). Released
 * 2026-11-01; read from its `properties` file, which is where every number
 * below comes from.
 *
 * Frame index = 17 · (band − 1) + (channel − 1). Frames 50 and 51 — band 3
 * channel 17 and band 4 channel 1, the two channels on the dichroic — are
 * blank and are never asked for.
 */

export const HIPS_BASE = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
export const MAX_ORDER = 5;
/** The order whose whole sky comes as one image, `Allsky.png`: 768 tiles of 64 px. */
export const ALLSKY_ORDER = 3;
export const ALLSKY_TILE = 64;
export const ALLSKY_COLUMNS = 27;
export const TILE_PX = 512;

/** Centre wavelength of each frame, µm (data_cube_crval3_arr). */
export const WAVELENGTHS = [
  0.753, 0.771, 0.790, 0.809, 0.828, 0.848, 0.868, 0.889, 0.910, 0.932, 0.955, 0.978, 1.001, 1.025, 1.050, 1.075, 1.102,
  1.113, 1.139, 1.167, 1.195, 1.224, 1.254, 1.284, 1.315, 1.346, 1.378, 1.412, 1.446, 1.481, 1.517, 1.554, 1.592,
  1.631, 1.656, 1.695, 1.735, 1.775, 1.818, 1.861, 1.905, 1.949, 1.995, 2.041, 2.089, 2.139, 2.189, 2.240, 2.292,
  2.345, 2.399, 2.445, 2.506, 2.575, 2.646, 2.719, 2.794, 2.871, 2.951, 3.033, 3.118, 3.204, 3.293, 3.383, 3.476,
  3.570, 3.667, 3.768, 3.833, 3.867, 3.901, 3.935, 3.970, 4.005, 4.040, 4.076, 4.112, 4.148, 4.184, 4.220, 4.257,
  4.294, 4.331, 4.368, 4.405, 4.435, 4.467, 4.500, 4.533, 4.566, 4.600, 4.635, 4.669, 4.704, 4.739, 4.773, 4.808,
  4.843, 4.879, 4.915, 4.951, 4.988,
];

export const CHANNELS = 17;
export const BLANK_FRAMES = new Set([50, 51]);
/** Every frame that has sky in it, in wavelength order. */
export const FRAMES = WAVELENGTHS.map((_, i) => i).filter((i) => !BLANK_FRAMES.has(i));

export const frameOf = (band, channel) => CHANNELS * (band - 1) + (channel - 1);
export const bandOf = (frame) => Math.floor(frame / CHANNELS) + 1;
export const channelOf = (frame) => (frame % CHANNELS) + 1;

/** Where each band opens: its middle channel. */
export const bandFrame = (band) => frameOf(band, 9);

/**
 * The colour view: three real frames, one per display channel, short to long.
 * Blue 0.91 µm (D1), green 2.00 µm (D3), red 4.70 µm (D6). The colours are a
 * convention — all three are infrared — but each is a measurement.
 */
export const COLOUR_FRAMES = [bandFrame(6), bandFrame(3), bandFrame(1)];

/** HiPS names frame 0 plainly and every other frame with its index. */
const suffix = (frame) => (frame === 0 ? '' : `_${frame}`);

export function tileUrl(order, npix, frame) {
  const dir = Math.floor(npix / 10000) * 10000;
  return `${HIPS_BASE}/Norder${order}/Dir${dir}/Npix${npix}${suffix(frame)}.png`;
}

/**
 * Frames whose Allsky image the site makes itself (tools/build-allsky.mjs):
 * the mean of each 8 × 8 block of the tiles instead of one pixel of it, so a
 * wide field is not grain. These are the frames the page opens with — the
 * colour view's three and each band's own.
 */
export const AVERAGED_FRAMES = new Set([8, 25, 42, 59, 76, 93]);

const irsaAllsky = (frame) => `${HIPS_BASE}/Norder${ALLSKY_ORDER}/Allsky${suffix(frame)}.png`;

export const allskyUrl = (frame) => (AVERAGED_FRAMES.has(frame) ? `data/allsky/Allsky_${frame}.png` : irsaAllsky(frame));

/** Where to look when the site's own Allsky is not there: IRSA's, for the same frame; null for any other address. */
export function allskyFallback(url) {
  const m = /^data\/allsky\/Allsky_(\d+)\.png$/.exec(url);
  return m ? irsaAllsky(Number(m[1])) : null;
}

/** Where tile k sits in the Allsky mosaic, as a pixel offset. */
export const allskySlot = (k) => ({ x: (k % ALLSKY_COLUMNS) * ALLSKY_TILE, y: Math.floor(k / ALLSKY_COLUMNS) * ALLSKY_TILE });

/** Side of a tile at an order, in degrees: √(4π sr / 12) halved at each order. */
export const tileDegrees = (order) => 58.63 / 2 ** order;

/**
 * Which tiles the screen needs: null while the one Allsky image is already as
 * sharp as the screen, else the first order whose pixel is no coarser than
 * about one and a half screen pixels, and never beyond what IRSA has. Not one:
 * the next order costs four times the tiles for a sharpness hardly seen.
 */
export function orderFor(degPerScreenPx) {
  const slack = degPerScreenPx * 1.5;
  if (tileDegrees(ALLSKY_ORDER) / ALLSKY_TILE <= slack) return null;
  for (let order = ALLSKY_ORDER; order < MAX_ORDER; order++) {
    if (tileDegrees(order) / TILE_PX <= slack) return order;
  }
  return MAX_ORDER;
}

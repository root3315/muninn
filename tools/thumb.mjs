// What the card pictures share: their size, their grey ramp, and how one
// reprojected SPHEREx frame becomes PNG bytes.
import { sortedFinite, limitsFromSorted, paint, ramp } from '../public/js/render.js';
import { encodePNG } from './png.mjs';

export const SIZE = 280;

/** Near-black to near-white, faintly cold: the page's own grey ramp in sRGB. */
const GREY = ramp([[5, 6, 11], [38, 40, 50], [104, 108, 122], [186, 190, 202], [248, 249, 252]]);

/** The share of a stamp that holds a measurement rather than a masked pixel. */
export function seenFraction(stamp) {
  let seen = 0;
  for (const v of stamp.data) if (v === v) seen++;
  return seen / stamp.data.length;
}

/** One reprojected frame as PNG bytes, on its own black and white point. */
export function toPNG(stamp) {
  const rgba = { data: new Uint8ClampedArray(SIZE * SIZE * 4), width: SIZE, height: SIZE };
  const { lo, hi } = limitsFromSorted(sortedFinite(stamp.data));
  paint(rgba, stamp.data, GREY, {
    lo, hi, stretch: 'asinh', blank: GREY.slice(0, 3), blankAlpha: 255, quality: stamp.quality,
  });
  const rgb = new Uint8Array(SIZE * SIZE * 3);
  for (let i = 0, p = 0; i < rgb.length; i += 3, p += 4) {
    rgb[i] = rgba.data[p]; rgb[i + 1] = rgba.data[p + 1]; rgb[i + 2] = rgba.data[p + 2];
  }
  return encodePNG(rgb, SIZE, SIZE);
}

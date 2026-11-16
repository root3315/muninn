/**
 * gate-sky.js — the front page's sky is SPHEREx's own.
 *
 * Under the gate's canvas, the whole-sky renderer of allsky.html
 * (allsky/view.js): the DR1 all-sky cube, from the averaged Allsky image at
 * the widest field down to 512-pixel tiles as a dive narrows it. The gate
 * keeps its camera, its markers, its pointer and its dive; this only draws
 * the sky behind them, from the gate's camera, every frame it moves.
 *
 * The gate's field of view is vertical; the renderer's is across the shorter
 * side of the screen. On a tall phone screen the shorter side is the width,
 * so the angle is converted, not copied: the two must agree on the focal
 * length in pixels, or the markers would drift off what they mark.
 */

import { createSkyView } from './allsky/view.js';
import { HIPS_BASE, COLOUR_FRAMES } from './allsky/hips.js';

const DEG = Math.PI / 180;

/**
 * A sky layer under `canvas`, or null where WebGL 2 cannot be had (the gate
 * then draws its own band, as before). `onFirstSky` is called once, when the
 * whole sky is first on screen.
 */
export function createSurveySky(canvas, { onFirstSky = () => {} } = {}) {
  const layer = document.createElement('canvas');
  layer.className = `${canvas.className} gate__band`;
  layer.setAttribute('aria-hidden', 'true');
  canvas.before(layer);
  const ramp = getComputedStyle(document.documentElement).getPropertyValue('--cmap-deep')
    .split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
  let shown = false;
  const view = createSkyView(layer, {
    ramp,
    ink: { grid: [0.86, 0.88, 1, 0.14], ecliptic: [1, 0.76, 0.42, 0.7] },
    relay: (url) => url.replace(`${HIPS_BASE}/`, 'api/hips/'),
    onChange: ({ wanted, have }) => {
      if (!shown && wanted > 0 && have >= wanted) {
        shown = true;
        onFirstSky();
      }
    },
  });
  if (!view) {
    layer.remove();
    return null;
  }
  view.setFrames(COLOUR_FRAMES);

  return {
    /** Point the sky as the gate points: RA, Dec, vertical field in degrees, the canvas in CSS pixels. */
    draw({ ra, dec, fov, width, height }) {
      const short = Math.min(width, height);
      const across = (2 * Math.atan(Math.tan((fov * DEG) / 2) * (short / height))) / DEG;
      view.set({ ra, dec, fov: across });
    },
    get shown() { return shown; },
    /** One wavelength (a frame of the cube) or the colour view. */
    setFrames(frames) { view.setFrames(frames); },
  };
}

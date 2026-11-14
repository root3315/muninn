/**
 * layout.js — where everything stands around the viewer, and how it moves.
 * Pure numbers, all in one object to tune.
 *
 * Yaw is measured about the vertical, positive to the left (the way three.js
 * turns a camera), 0 looking along −z. Pitch is positive up. A screen's centre
 * is `dist` metres out at `dy` metres above (or below) the eye, turned to face
 * it.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Text sizes, as angles at the eye. */
export const TEXT_DEG = { body: 1.5, heading: 2.2, key: 2.5 };
export const MIN_TEXT_DEG = TEXT_DEG.body;

/** A height for a screen's centre that puts it at `pitchDeg` from `dist` metres. */
const at = (pitchDeg, dist) => Math.tan(pitchDeg * D2R) * dist;

/**
 * Every number that decides where things stand and how they move.
 *
 *   screens  relative to the main screen's yaw (the target's direction):
 *            the field 1.4 × 1.0 m at 2 m, its buttons just under it, the
 *            card and the findings either side at ±38.5°
 *   ring     the visits as Earth's orbit (timeline.js), still, below the
 *            screens; a second tier for a second year
 *   depth    the field in depth (depthview.js, depth3d.js) behind the viewer
 *   dive     choosing a target
 *   first    the sign that says how to choose, until the first choice
 */
export const LAYOUT = {
  screens: {
    main: { yawDeg: 0, dist: 2.0, dy: at(2.5, 2.0), w: 1.3, h: 0.93 },
    // Two rows' room: the second is used only when the row is full ("More" open).
    bar: { yawDeg: 0, dist: 1.95, dy: at(-18.6, 1.95), w: 1.65, h: 0.24, rowH: 0.115, pxPerM: 760 },
    card: { yawDeg: 35, dist: 1.8, dy: at(1.5, 1.8), w: 0.85, h: 1.25, pxPerM: 760 },
    side: { yawDeg: -35, dist: 1.8, dy: at(1.5, 1.8), w: 0.85, h: 1.25, pxPerM: 760 },
  },
  ring: {
    radius: 2.2, pitchDeg: -23, tierDropM: 0.36, minSepDeg: 8,
    // The orbit is drawn on a short arc in front, not all round: its places
    // in order, a fixed gap apart, the whole no wider than arcDeg.
    arcDeg: 130, gapDeg: 9,
    frameW: 0.24, frameH: 0.18,
    liftM: 0.06, liftMs: 150, hoverScale: 1.3, hoverMs: 120,
    // Frames this far from where the head points are dimmed, to keep the eye on the front.
    gazeDeg: 70, gazeDim: 0.2,
    // A gap between visits longer than this is labelled as one.
    gapDays: 45,
  },
  depth: {
    // To the comoving horizon, about 14 Gpc.
    nearM: 1.0, farM: 6, unknownM: 7, minAU: 0.1, maxPc: 2e10,
    // Turned off straight-behind, so the corridor is seen three-quarter.
    coneDeg: 18, axisPitchDeg: 11, axisYawDeg: 18, falloff: 0.6, faceWithinM: 4, maxLabels: 5,
    // Sky markers this close to the corridor's axis are dimmed while it is open.
    clearDeg: 35,
    plateW: 0.5,
  },
  dive: { ms: 600, fromM: 1.2, skyDim: 0.3, markerGrow: 3 },
  /** The smallest a button is, in metres, whatever its word. */
  minChipM: 0.09,
  /** The Milky Way's brightness until the first choice, so the markers are what is seen. */
  bandFirst: 0.6,
  blinkHz: 1.5,
  first: { dist: 1.8, pitchDeg: -8, w: 1.0, h: 0.22, pxPerM: 760 },
  /** How far the main screen may be from the gaze, and for how long, before a chevron points to it. */
  lost: { deg: 100, ms: 2500 },
  /** Moving about: walking and flying speeds (m/s), the snap turn, the vignette, and the depth scene's scale range. */
  move: { walkMps: 1.4, flyMps: 2.0, snapDeg: 30, vignette: 0.85, minScale: 0.2, maxScale: 20 },
  /** Hold B/Y this long to bring the screens round to where the head points. */
  bringMs: 800,
};

export const SCREENS = LAYOUT.screens;

/** The yaw of a direction, in degrees, by the convention above. */
export function yawOf([x, , z]) {
  return Math.atan2(-x, -z) * R2D;
}

/** A point `dist` metres from `head` at yaw and height offset, and the turn that faces it to the head. */
export function screenPose({ yawDeg, dist, dy }, head, baseYawDeg = 0) {
  const yaw = (baseYawDeg + yawDeg) * D2R;
  const position = [
    head[0] - Math.sin(yaw) * dist,
    head[1] + dy,
    head[2] - Math.cos(yaw) * dist,
  ];
  // Tilted about its own horizontal so its face points at the eye.
  const pitch = Math.atan2(dy, dist);
  return { position, yaw, pitch };
}

/** How tall, in degrees at the eye, a line `px` pixels high stands on a screen. */
export function textDeg(px, pxPerM, dist) {
  return 2 * Math.atan(px / pxPerM / 2 / dist) * R2D;
}

/** The fewest pixels a line needs on a screen of this density at this distance to stand `deg` tall. */
export function minTextPx(pxPerM, dist, deg = MIN_TEXT_DEG) {
  return Math.ceil(2 * Math.tan((deg / 2) * D2R) * dist * pxPerM);
}

/** A screen's pixel sizes for body, heading and key-number type. */
export function typeFor(spec) {
  const dist = Math.hypot(spec.dist, spec.dy);
  return {
    body: minTextPx(spec.pxPerM, dist, TEXT_DEG.body),
    heading: minTextPx(spec.pxPerM, dist, TEXT_DEG.heading),
    key: minTextPx(spec.pxPerM, dist, TEXT_DEG.key),
  };
}

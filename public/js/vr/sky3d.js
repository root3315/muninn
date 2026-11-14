/**
 * sky3d.js — the celestial sphere around the viewer: the catalogued stars
 * and the Milky Way model, in two draw calls.
 *
 * The stars are one set of points with a small shader: a soft core sized by
 * magnitude and a three-stop glow under the bright ones, tinted by colour
 * index, exactly as the opening sky draws them (gate.js), added onto the
 * dark. Their sizes are the page's pixel sizes turned into angles, so a star
 * is as big in the headset as it is on a screen of the usual size.
 *
 * The band is gate.js's model of the galactic disc, computed once into an
 * equirectangular picture and looked up per pixel on a large inward sphere,
 * so there is no seam and no pole pinch. It is a model and the page says so.
 *
 * The sphere travels with the head: the sky is at infinity, so stepping about
 * the room never brings a star closer.
 */

import * as THREE from '../vendor/three.module.js';
import { starBuffers, milkyWayPixels, radecToVec } from './skydata.js';

/** Radius of the sky, in metres: far beyond anything else drawn. */
export const SKY_RADIUS = 600;

/**
 * Pixels per degree on the page the sizes were tuned on: the opening sky's
 * 78° view across a window about 900 pixels high.
 */
const PAGE_PX_PER_DEG = (900 / 2) / Math.tan((39 * Math.PI) / 180) * (Math.PI / 180);

const STAR_VERTEX = /* glsl */ `
  attribute float size;
  attribute float glow;
  attribute vec3 tint;
  attribute vec2 alpha;
  uniform float radius;
  uniform float pxPerDeg;
  uniform float glowScale;
  varying vec3 vTint;
  varying vec2 vAlpha;
  varying float vCore;
  varying float vGlow;
  varying float vAa;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position * radius, 1.0);
    gl_Position = projectionMatrix * mv;
    float k = pxPerDeg / ${PAGE_PX_PER_DEG.toFixed(4)};
    float core = size * k;
    float g = glow * k * glowScale;
    // A core smaller than a pixel shimmers as the head moves: it is drawn a
    // pixel wide and dimmed by the area it lacks, which is the same light.
    float lack = clamp(core / 0.9, 0.0, 1.0);
    core = max(core, 0.9);
    float r = max(core * 1.5, g) + 1.0;
    gl_PointSize = 2.0 * r;
    vCore = core / r;
    vGlow = g / r;
    vAa = 1.0 / r;
    vTint = tint;
    vAlpha = vec2(alpha.x * lack * lack, alpha.y);
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  uniform float dim;
  varying vec3 vTint;
  varying vec2 vAlpha;
  varying float vCore;
  varying float vGlow;
  varying float vAa;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float core = vAlpha.x * (1.0 - smoothstep(vCore - vAa, vCore + vAa, d));
    float glow = 0.0;
    if (vGlow > 0.0) {
      // The glow's three stops, as gate.js paints them: a tight core and a
      // long faint skirt.
      float q = d / vGlow;
      glow = q < 0.12 ? mix(0.95, 0.34, q / 0.12)
        : q < 0.36 ? mix(0.34, 0.08, (q - 0.12) / 0.24)
        : q < 1.0 ? mix(0.08, 0.0, (q - 0.36) / 0.64) : 0.0;
      glow *= vAlpha.y;
    }
    float a = clamp(core + glow, 0.0, 1.0) * dim;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vTint * a, 1.0);
  }
`;

// The band's picture is laid on the sphere by the sphere's own texture
// coordinates, so the fragment does a lookup and no trigonometry. three.js
// puts u = 0.5 at RA 0 in this frame, and v = 1 at the north pole; the
// picture has RA 0 at its left edge and the north pole on its first row.
const BAND_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = vec2(uv.x - 0.5, 1.0 - uv.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BAND_FRAGMENT = /* glsl */ `
  uniform sampler2D band;
  uniform float dim;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(band, vUv).rgb * dim, 1.0);
  }
`;

/** The obliquity of the ecliptic, J2000, degrees. */
const OBLIQUITY = 23.4393;

/** The ecliptic as RA/Dec points, every `step` degrees of longitude. */
export function eclipticPoints(step = 2) {
  const e = OBLIQUITY * Math.PI / 180;
  const out = [];
  for (let l = 0; l <= 360; l += step) {
    const lam = l * Math.PI / 180;
    const dec = Math.asin(Math.sin(e) * Math.sin(lam)) * 180 / Math.PI;
    const ra = ((Math.atan2(Math.cos(e) * Math.sin(lam), Math.cos(lam)) * 180 / Math.PI) + 360) % 360;
    out.push([ra, dec]);
  }
  return out;
}

/**
 * The sky, built from the catalogue (`stars` as loadStars returns it, or null
 * for the band alone). Returns `{ group, setDim(k), update(pxPerDeg), dispose() }`.
 */
export function createSky(stars, { bandWidth = 1024 } = {}) {
  const group = new THREE.Group();
  group.name = 'sky';

  // The band.
  const { width, height, data } = milkyWayPixels(bandWidth);
  const bandTex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  bandTex.flipY = false;
  bandTex.magFilter = THREE.LinearFilter;
  bandTex.minFilter = THREE.LinearMipmapLinearFilter;
  bandTex.generateMipmaps = true;
  bandTex.wrapS = THREE.RepeatWrapping;
  bandTex.needsUpdate = true;
  const bandMat = new THREE.ShaderMaterial({
    uniforms: { band: { value: bandTex }, dim: { value: 1 } },
    vertexShader: BAND_VERTEX,
    fragmentShader: BAND_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const bandMesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS * 1.05, 48, 24), bandMat);
  bandMesh.renderOrder = -20;
  bandMesh.frustumCulled = false;
  group.add(bandMesh);

  // The stars.
  let starMat = null;
  let points = null;
  if (stars) {
    const b = starBuffers(stars);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(b.sizes, 1));
    geo.setAttribute('glow', new THREE.BufferAttribute(b.glows, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(b.colors, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(b.alphas, 2));
    starMat = new THREE.ShaderMaterial({
      uniforms: {
        radius: { value: SKY_RADIUS },
        pxPerDeg: { value: 20 },
        glowScale: { value: 0.8 },
        dim: { value: 1 },
      },
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    points = new THREE.Points(geo, starMat);
    points.renderOrder = -10;
    points.frustumCulled = false;
    group.add(points);
  }

  // The ecliptic, faint: the plane the planets and most asteroids keep to.
  const eclGeo = new THREE.BufferGeometry().setFromPoints(
    eclipticPoints().map(([ra, dec]) => new THREE.Vector3(...radecToVec(ra, dec)).multiplyScalar(SKY_RADIUS * 0.98)),
  );
  const eclMat = new THREE.LineDashedMaterial({ color: 0x8c8cb4, dashSize: 6, gapSize: 6, transparent: true, opacity: 0.35, depthWrite: false });
  const ecliptic = new THREE.Line(eclGeo, eclMat);
  ecliptic.computeLineDistances();
  ecliptic.renderOrder = -5;
  group.add(ecliptic);

  return {
    group,
    /** Dim the whole sky (1 is full), so screens in front of it read. */
    setDim(k) {
      bandMat.uniforms.dim.value = k;
      if (starMat) starMat.uniforms.dim.value = Math.min(1, k * 1.15);
      eclMat.opacity = 0.35 * k;
    },
    /** The current pixels per degree of the eye being drawn. */
    update(pxPerDeg) {
      if (starMat) starMat.uniforms.pxPerDeg.value = pxPerDeg;
    },
    dispose() {
      bandTex.dispose();
      bandMat.dispose();
      bandMesh.geometry.dispose();
      eclGeo.dispose();
      eclMat.dispose();
      if (points) { points.geometry.dispose(); starMat.dispose(); }
    },
  };
}

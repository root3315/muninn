/**
 * view.js — the whole sky in WebGL 2, two ways.
 *
 * The sphere: the observer stands at the centre of the celestial sphere and
 * looks out through a camera, east on the left with north up, as on any sky
 * chart — the same perspective as the sky on the tool's front page, so the
 * two feel like one place. A straight line on the sky stays straight, and the
 * field opens up to 108°, as the front page's does.
 *
 * The map: the whole sky at once on one Mollweide ellipse in galactic
 * coordinates, the Milky Way along the middle, the way all-sky surveys are
 * published. It is drawn per screen pixel from the cube's Allsky image, so it
 * has no seams to hide.
 *
 * What the sphere draws, coarse to fine: the Allsky image (768 small tiles in
 * one picture, there from the first second), then full 512-pixel tiles of
 * orders 3 to 5 as the field narrows, each faded in over its parent once it
 * has arrived, so the picture only ever sharpens.
 *
 * Brightness: the PNGs carry IRSA's own stretch (asinh, 0–40 MJy/sr). Each
 * frame is then set between two levels read from its own Allsky histogram —
 * the sky's floor and its brightest thousandth — so every wavelength fills
 * the same range on screen. Levels change contrast only; they move no pixel
 * and add none.
 */

import { vecOf, radecOf, tileMesh, tileCentre } from './healpix.js';
import {
  ALLSKY_ORDER, ALLSKY_TILE, ALLSKY_COLUMNS, TILE_PX, HIPS_BASE, allskySlot, allskyUrl, allskyFallback, tileUrl, orderFor, tileDegrees,
} from './hips.js';
import { GALACTIC, mollweide, mollweideInverse, toGalactic, fromGalactic } from './maps.js';

const DEG = Math.PI / 180;
export const FOV_MIN = 0.4;
export const FOV_MAX = 108;
/**
 * A camera sees only what is in front of it: a tile whose middle is closer
 * than this to the side of the view (cosine from the axis) is not drawn, as
 * its far corners would be behind the lens.
 */
const FRONT = 0.15;
const WANT_MAX = 140;
const LOADS_AT_ONCE = 6;
const KEEP_TILES = 260;
const RETRY_MS = 8000;
/** Detail-tile meshes kept: a few screens' worth. */
const MESHES_KEPT = 600;
/** How long a newly arrived image takes to come up, ms. */
const FADE_MS = 320;
/**
 * How far down the Allsky's mipmaps the sphere reads it: IRSA's own, made of
 * single pixels, far enough to average their noise out; the site's averaged
 * ones hardly at all, so the stars stay sharp.
 */
const ALLSKY_BIAS = { picked: 1.25, averaged: 0.35 };
const ALLSKY_COUNT = 12 * 4 ** ALLSKY_ORDER;
/** The floor sits this many noise sigmas above the median sky. */
const FLOOR_SIGMAS = 0.8;
const ATLAS_W = ALLSKY_COLUMNS * ALLSKY_TILE;
const ATLAS_H = Math.ceil(ALLSKY_COUNT / ALLSKY_COLUMNS) * ALLSKY_TILE;

/* ---- shaders ------------------------------------------------------------ */

/** One colour from one, or three, frames — shared by the sphere and the map. */
const SHADE = `
uniform sampler2D uR;
uniform sampler2D uG;
uniform sampler2D uB;
uniform sampler2D uRamp;
uniform bool uColour;
uniform vec3 uLo;
uniform vec3 uHi;
vec3 shade(vec3 raw) {
  vec3 x = max((raw - uLo) / max(uHi - uLo, vec3(1e-3)), 0.0);
  // Above 0.7 the light is eased toward white instead of cut at it, so the
  // Milky Way's bright plane keeps its dust lanes and a nucleus keeps its shape.
  x = mix(x, 0.7 + 0.3 * (1.0 - exp(-(x - 0.7) / 0.3)), step(vec3(0.7), x));
  if (!uColour) return texture(uRamp, vec2(x.r, 0.5)).rgb;
  // A star too bright for the detector is blank in the cube at the
  // wavelengths it saturated, and bright in the rest: drawn as it comes it is
  // a false colour. Where a channel is empty under a bright neighbour, the
  // pixel is drawn neutral at the brightness it has.
  float top = max(x.r, max(x.g, x.b));
  bvec3 hole = lessThanEqual(raw, vec3(0.5 / 255.0));
  if (top > 0.2 && any(hole)) x = mix(x, vec3(top), vec3(hole));
  return x;
}`;

const SPHERE_VS = `#version 300 es
in vec3 aPos;
in vec2 aUv;
uniform vec3 uC;
uniform vec3 uE;
uniform vec3 uN;
uniform vec2 uScale;
out vec2 vUv;
void main() {
  float d = dot(aPos, uC);
  vec2 p = vec2(-dot(aPos, uE), dot(aPos, uN)) / max(d, 1e-3);
  gl_Position = vec4(p * uScale, 0.0, 1.0);
  vUv = aUv;
}`;

const SPHERE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uAlpha;
uniform float uBias;
uniform vec2 uTexel;
out vec4 outColour;
${SHADE}
vec3 readAt(vec2 uv) {
  return vec3(texture(uR, uv, uBias).r, texture(uG, uv, uBias).r, texture(uB, uv, uBias).r);
}
void main() {
  vec3 raw = readAt(vUv);
  // The core of a star or a nucleus too bright for the detector is blank in
  // the cube: drawn as it comes it is a black hole, or a ring of false colour
  // where some wavelengths saturated and others did not. Where a pixel is
  // blank, the brightest light around it, out to 16 pixels, says how bright
  // it is at least; the blank wavelengths are drawn at that.
  // A blank core is a patch: the pixel and its four neighbours all blank in
  // that wavelength. A lone 0 is the sky's noise dipping below the floor, and
  // is left as it is.
  vec3 empty = vec3(0.5 / 255.0);
  bvec3 hole = lessThanEqual(raw, empty);
  if (any(hole)) {
    vec3 around = max(max(readAt(vUv + vec2(uTexel.x, 0.0)), readAt(vUv - vec2(uTexel.x, 0.0))),
                      max(readAt(vUv + vec2(0.0, uTexel.y)), readAt(vUv - vec2(0.0, uTexel.y))));
    hole = bvec3(hole.x && around.x <= empty.x, hole.y && around.y <= empty.y, hole.z && around.z <= empty.z);
  }
  if (any(hole)) {
    float top = 0.0;
    for (int r = 0; r < 3; r++) {
      float d = r == 0 ? 3.0 : r == 1 ? 8.0 : 16.0;
      for (int a = 0; a < 4; a++) {
        vec2 dir = a == 0 ? vec2(1.0, 0.0) : a == 1 ? vec2(-1.0, 0.0) : a == 2 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
        vec3 v = readAt(vUv + dir * d * uTexel);
        top = max(top, max(v.r, max(v.g, v.b)));
      }
    }
    if (top > 0.3) raw = mix(raw, vec3(max(top, max(raw.r, max(raw.g, raw.b)))), vec3(hole));
  }
  outColour = vec4(shade(raw), uAlpha);
}`;

const MAP_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/*
 * Per pixel: map → galactic → ICRS → HEALPix face and cell → the cell's place
 * in the Allsky mosaic. The HEALPix part is healpix.js's xyfOf, line for line.
 */
const MAP_FS = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uCentre;
uniform float uS;
uniform mat3 uFromGal;
uniform float uLod;
uniform float uAlpha;
uniform float uEdge;
out vec4 outColour;
${SHADE}
const float PI = 3.141592653589793;
const float SQ2 = 1.4142135623730951;
int spread3(int v) { return (v & 1) | ((v & 2) << 1) | ((v & 4) << 2); }
/* The three frames' values at one point of the map. */
vec3 skyValue(vec2 m) {
  float th = asin(clamp(m.y / SQ2, -1.0, 1.0));
  float b = asin(clamp((2.0 * th + sin(2.0 * th)) / PI, -1.0, 1.0));
  float L = clamp(-PI * m.x / (2.0 * SQ2 * max(cos(th), 1e-6)), -PI, PI);
  vec3 v = uFromGal * vec3(cos(b) * cos(L), cos(b) * sin(L), sin(b));

  float z = clamp(v.z, -1.0, 1.0);
  float za = abs(z);
  float tt = mod(atan(v.y, v.x) / (PI * 0.5), 4.0);
  int face;
  float x;
  float y;
  if (za <= 2.0 / 3.0) {
    float jp = 0.5 + tt - 0.75 * z;
    float jm = 0.5 + tt + 0.75 * z;
    float ifp = floor(jp);
    float ifm = floor(jm);
    if (ifp == ifm) face = int(mod(ifp, 4.0)) + 4;
    else if (ifp < ifm) face = int(mod(ifp, 4.0));
    else face = int(mod(ifm, 4.0)) + 8;
    x = jm - ifm;
    y = 1.0 - (jp - ifp);
  } else {
    float ntt = min(3.0, floor(tt));
    float tp = tt - ntt;
    float tmp = sqrt(3.0 * (1.0 - za));
    float jp = min(tp * tmp, 0.99999);
    float jm = min((1.0 - tp) * tmp, 0.99999);
    if (z > 0.0) { face = int(ntt); x = 1.0 - jm; y = 1.0 - jp; }
    else { face = int(ntt) + 8; x = jp; y = jm; }
  }
  int ix = clamp(int(floor(x * 8.0)), 0, 7);
  int iy = clamp(int(floor(y * 8.0)), 0, 7);
  float a = x * 8.0 - float(ix);
  float bb = y * 8.0 - float(iy);
  int k = face * 64 + spread3(ix) + 2 * spread3(iy);
  vec2 slot = vec2(float(k % ${ALLSKY_COLUMNS}), float(k / ${ALLSKY_COLUMNS})) * ${ALLSKY_TILE}.0;
  // A coarser mipmap level's texel is wider: the sample is kept that far
  // inside its cell, or the filter reaches into the neighbouring cell of the
  // mosaic, which is another part of the sky, and draws its edge as a seam.
  float margin = 0.5 * exp2(floor(uLod) + 1.0);
  vec2 uv = (slot + margin + vec2(bb, a) * (${ALLSKY_TILE}.0 - 2.0 * margin)) / vec2(${ATLAS_W}.0, ${ATLAS_H}.0);
  return vec3(textureLod(uR, uv, uLod).r, textureLod(uG, uv, uLod).r, textureLod(uB, uv, uLod).r);
}
void main() {
  vec2 m = (gl_FragCoord.xy - uCentre) / uS;
  float e = m.x * m.x / 8.0 + m.y * m.y / 2.0;
  if (e > 1.0 + uEdge) discard;
  // Four looks a quarter-pixel apart, averaged: a screen pixel of the map
  // covers several of the mosaic's, and one look would pick one at random.
  float q = 0.25 / uS;
  vec3 raw = 0.25 * (skyValue(m + vec2(-q, -q)) + skyValue(m + vec2(q, -q)) + skyValue(m + vec2(-q, q)) + skyValue(m + vec2(q, q)));
  float rim = 1.0 - smoothstep(1.0 - uEdge, 1.0 + uEdge, e);
  outColour = vec4(shade(raw), uAlpha * rim);
}`;

const LINE_VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 uInk;
out vec4 outColour;
void main() { outColour = uInk; }`;

/** A program from two shaders; attributes are bound by position, before linking. */
function compile(gl, vs, fs, attributes) {
  const program = gl.createProgram();
  attributes.forEach((name, i) => gl.bindAttribLocation(program, i, name));
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(program, sh);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const names = {};
  const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const { name } = gl.getActiveUniform(program, i);
    names[name.replace(/^u/, '')] = gl.getUniformLocation(program, name);
  }
  return { program, u: names };
}

/* ---- geometry ----------------------------------------------------------- */

/** The camera's basis: C toward the middle of the screen, E toward east, N toward north. */
export function basisOf(ra, dec) {
  const a = ra * DEG;
  const d = dec * DEG;
  return {
    C: [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)],
    E: [-Math.sin(a), Math.cos(a), 0],
    N: [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)],
  };
}

const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

/** Screen units per unit of the image plane, for a field `fov` degrees across the shorter side. */
export const scaleFor = (fov) => 1 / Math.tan((fov * DEG) / 2);

/** The direction under a screen offset (units of the shorter half-side, y up). */
export function unproject(x, y, { C, E, N }, k) {
  const X = -x / k;
  const Y = y / k;
  const v = [0, 1, 2].map((i) => X * E[i] + Y * N[i] + C[i]);
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
}

/** Percentiles of the red channel of an image, from its histogram. */
function levelsOf(bitmap, block) {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const hist = new Uint32Array(256);
  let n = 0;
  // The Allsky image is made by taking pixels, not averaging them, so each
  // carries a full pixel's noise; the screen shows it read down the mipmap,
  // averaged. The levels are read the way it is shown: in blocks of 2 × 2.
  // Only blocks with data count: the mosaic's unused cells and the blanked
  // cores are transparent.
  const w = bitmap.width;
  for (let y = 0; y + block <= bitmap.height; y += block) {
    for (let x = 0; x + block <= w; x += block) {
      let sum = 0;
      let lit = 0;
      for (let dy = 0; dy < block; dy++) {
        for (let dx = 0; dx < block; dx++) {
          const i = ((y + dy) * w + x + dx) * 4;
          // Blank is transparent in IRSA's images and 0 in the site's own.
          if (data[i + 3] && data[i]) { sum += data[i]; lit++; }
        }
      }
      if (lit < block * block) continue;
      hist[Math.round(sum / lit)]++;
      n++;
    }
  }
  const pct = (q) => {
    let s = 0;
    for (let v = 0; v < 256; v++) {
      s += hist[v];
      if (s >= q * n) return v / 255;
    }
    return 1;
  };
  // The floor: most of one noise sigma above the median sky, so empty sky is
  // dark instead of grain, and what stands above the noise shows.
  // The top: the brightest five ten-thousandths, with the shader's shoulder
  // above 0.7 easing everything brighter toward white rather than clipping it.
  const sigma = pct(0.5) - pct(0.16);
  return { median: pct(0.5), sigma, lo: pct(0.5) + sigma * FLOOR_SIGMAS, hi: Math.max(pct(0.9995), pct(0.5) + 0.05) };
}

/**
 * The view. `ramp`: CSS colours, dark to light, for one wavelength. `onChange`
 * after every redraw, with how many images the screen wants and has.
 */
export function createSkyView(canvas, { ramp, ink, relay = null, onChange = () => {} }) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) return null;
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');

  const sphere = compile(gl, SPHERE_VS, SPHERE_FS, ['aPos', 'aUv']);
  const map = compile(gl, MAP_VS, MAP_FS, []);
  const line = compile(gl, LINE_VS, LINE_FS, ['aPos']);

  const state = { ra: 266.4, dec: -29.0, fov: 120, frames: [], grid: false, map: 0, insets: { top: 0, bottom: 0 } };
  /** The frames on screen before the last change, drawn under the new ones until those are up. */
  let previous = [];
  let previousSince = 0;
  let disposed = false;
  let queued = false;

  /* ---- meshes ---------------------------------------------------------- */

  function meshVao(positions, uv, steps, count) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffers = [];
    for (const [i, data, size] of [[0, positions, 3], [1, uv, 2]]) {
      buffers.push(gl.createBuffer());
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[buffers.length - 1]);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, size, gl.FLOAT, false, 0, 0);
    }
    const side = steps + 1;
    const perTile = steps * steps * 6;
    const idx = new Uint32Array(perTile * count);
    let k = 0;
    for (let t = 0; t < count; t++) {
      const base = t * side * side;
      for (let i = 0; i < steps; i++) {
        for (let j = 0; j < steps; j++) {
          const p = base + i * side + j;
          idx.set([p, p + 1, p + side, p + 1, p + side + 1, p + side], k);
          k += 6;
        }
      }
    }
    buffers.push(gl.createBuffer());
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers[2]);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, perTile, buffers, used: 0 };
  }

  // The Allsky mosaic: every order-3 tile pointing into its 64-pixel cell of
  // one image, two texels in from the edge so the filter, read down to the
  // second mipmap level, never reaches the neighbouring cell.
  const ALLSKY_STEPS = 4;
  const allskyMesh = (() => {
    const side = ALLSKY_STEPS + 1;
    const positions = new Float32Array(ALLSKY_COUNT * side * side * 3);
    const uv = new Float32Array(ALLSKY_COUNT * side * side * 2);
    const inset = 2 / ALLSKY_TILE;
    for (let n = 0; n < ALLSKY_COUNT; n++) {
      const m = tileMesh(ALLSKY_ORDER, n, ALLSKY_STEPS);
      positions.set(m.positions, n * side * side * 3);
      const slot = allskySlot(n);
      for (let v = 0; v < side * side; v++) {
        const u = inset + m.uv[v * 2] * (1 - 2 * inset);
        const w = inset + m.uv[v * 2 + 1] * (1 - 2 * inset);
        uv[(n * side * side + v) * 2] = (slot.x + u * ALLSKY_TILE) / ATLAS_W;
        uv[(n * side * side + v) * 2 + 1] = (slot.y + w * ALLSKY_TILE) / ATLAS_H;
      }
    }
    return meshVao(positions, uv, ALLSKY_STEPS, ALLSKY_COUNT);
  })();
  const allskyCentres = Array.from({ length: ALLSKY_COUNT }, (_, n) => tileCentre(ALLSKY_ORDER, n));

  const centres = new Map();
  function centresOf(order) {
    if (!centres.has(order)) {
      const count = 12 * 4 ** order;
      const out = new Float32Array(count * 3);
      for (let n = 0; n < count; n++) out.set(tileCentre(order, n), n * 3);
      centres.set(order, out);
    }
    return centres.get(order);
  }

  const meshes = new Map();
  function tileVao(order, npix) {
    const key = `${order}/${npix}`;
    if (!meshes.has(key)) {
      const steps = order === ALLSKY_ORDER ? 4 : 2;
      const m = tileMesh(order, npix, steps);
      const inset = 0.5 / TILE_PX;
      for (let i = 0; i < m.uv.length; i++) m.uv[i] = inset + m.uv[i] * (1 - 2 * inset);
      meshes.set(key, meshVao(m.positions, m.uv, steps, 1));
    }
    return meshes.get(key);
  }

  const lineBuffer = gl.createBuffer();
  const lineVao = gl.createVertexArray();
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const emptyVao = gl.createVertexArray();

  /* ---- textures -------------------------------------------------------- */

  function makeTexture(source, maxLevel) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, maxLevel);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return tex;
  }

  const rampTexture = (() => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 1;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 256, 0);
    ramp.forEach((colour, i) => g.addColorStop(i / (ramp.length - 1), colour));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 1);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    return tex;
  })();

  /** Every image asked for, by URL: `{ state, tex, used, priority, readyAt, levels }`. */
  const images = new Map();
  const queue = [];
  let loading = 0;
  let use = 0;

  function want(url, priority, { allsky = false } = {}) {
    let img = images.get(url);
    if (!img) {
      img = { state: 'queued', tex: null, used: use, priority, readyAt: 0, retryAt: 0, allsky, averaged: !/^https?:/.test(url) };
      images.set(url, img);
      queue.push(url);
    } else if (img.state === 'failed' && performance.now() > img.retryAt) {
      // IRSA has its bad minutes; a failed image is asked for again later, not given up on.
      img.state = 'queued';
      queue.push(url);
    }
    // The priority of this draw, not the best one ever asked: a frame passed
    // over in a sweep must not stay ahead of the one now on screen.
    img.priority = img.used === use ? Math.min(img.priority, priority) : priority;
    img.used = use;
    return img;
  }

  /**
   * An image through the site's own relay, which keeps the cube's tiles on
   * disk, and straight from IRSA where there is no relay (a static host) or
   * the relay cannot help.
   */
  let relayWorks = Boolean(relay);
  async function fetchImage(url, img = null) {
    const fallback = allskyFallback(url);
    if (fallback) {
      // The site's own averaged Allsky; if it is not there, IRSA's.
      try {
        const res = await fetch(url);
        if (res.ok && (res.headers.get('content-type') ?? '').startsWith('image/')) return res.blob();
      } catch { /* IRSA's, then */ }
      if (img) img.fellBack = true;
      return fetchImage(fallback);
    }
    if (relayWorks && url.startsWith(HIPS_BASE)) {
      try {
        const res = await fetch(relay(url));
        if (res.ok && (res.headers.get('content-type') ?? '').startsWith('image/')) return res.blob();
        const fromRelay = Boolean(res.headers.get('x-muninn-hips'));
        // The relay says so when it is the one answering: then a 404 is a
        // tile the cube does not have, and IRSA would say the same.
        if (fromRelay && res.status === 404) throw new Error('404');
        // No such route (a static host's 404, or its own page sent as 200):
        // there is no relay, and it is not asked again. A 5xx or a busy relay
        // is IRSA's bad minute; this one image goes straight to IRSA.
        if (!fromRelay && (res.status === 404 || res.ok)) relayWorks = false;
      } catch { /* the relay is down: IRSA itself */ }
    }
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(String(res.status));
    return res.blob();
  }

  async function load(url) {
    const img = images.get(url);
    img.state = 'loading';
    loading++;
    try {
      const bitmap = await createImageBitmap(await fetchImage(url, img), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (disposed) return;
      if (img.allsky) {
        // IRSA's Allsky is single pixels, shown averaged about 4 × 4; the site's
        // own is averaged already. Each is measured as it is shown.
        const block = img.averaged && !img.fellBack ? 1 : 4;
        img.levels = levelsOf(bitmap, block);
        // The tiles' floor is set against their own grain, which is coarser
        // than the Allsky's as measured: about four times the averaged image's
        // spread, twice the spread of IRSA's read in 4 × 4 blocks. Measured by
        // eye on M31, M42 and the galactic plane against the frames as served.
        img.levels.tileSigma = img.levels.sigma * (block === 1 ? 4 : 2);
        // Averaged or picked is a property of what came, not of what was asked for.
        img.averaged = img.averaged && !img.fellBack;
      }
      img.tex = makeTexture(bitmap, img.allsky ? 2 : 9);
      bitmap.close?.();
      img.state = 'ready';
      img.readyAt = performance.now();
    } catch {
      img.state = 'failed';
      img.retryAt = performance.now() + RETRY_MS;
      // Nothing else may move the view before then: the retry comes by itself.
      setTimeout(redraw, RETRY_MS + 50);
    } finally {
      loading--;
      pump();
      redraw();
    }
  }

  function pump() {
    for (let i = queue.length - 1; i >= 0; i--) {
      const img = images.get(queue[i]);
      if (img.used < use - 1) {
        images.delete(queue[i]);
        queue.splice(i, 1);
      }
    }
    queue.sort((a, b) => images.get(a).priority - images.get(b).priority);
    while (loading < LOADS_AT_ONCE && queue.length) load(queue.shift());
  }

  function evict() {
    // A failed image nobody asks for any more is forgotten, not kept to retry.
    for (const [url, v] of images) if (v.state === 'failed' && v.used < use - 1) images.delete(url);
    // What is on screen now, or was a frame ago, is never let go, whatever the budget.
    const ready = [...images.entries()].filter(([, v]) => v.state === 'ready' && v.used < use - 1);
    const allskies = ready.filter(([, v]) => v.allsky);
    const tiles = ready.filter(([, v]) => !v.allsky);
    // Allsky images are a megabyte each and a sweep through the spectrum passes
    // a hundred of them: the last dozen stay.
    for (const [list, keep] of [[tiles, KEEP_TILES], [allskies, 12]]) {
      if (list.length <= keep) continue;
      list.sort((a, b) => a[1].used - b[1].used);
      for (const [url, v] of list.slice(0, list.length - keep)) {
        gl.deleteTexture(v.tex);
        images.delete(url);
      }
    }
    // Each detail tile's mesh too, once there are many and it is long off screen.
    if (meshes.size > MESHES_KEPT) {
      const old = [...meshes.entries()].filter(([, m]) => m.used < use - 1).sort((a, b) => a[1].used - b[1].used);
      for (const [key, m] of old.slice(0, meshes.size - MESHES_KEPT)) {
        gl.deleteVertexArray(m.vao);
        for (const b of m.buffers) gl.deleteBuffer(b);
        meshes.delete(key);
      }
    }
  }

  /* ---- drawing --------------------------------------------------------- */

  function camera() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const short = Math.min(w, h);
    return { ...basisOf(state.ra, state.dec), k: scaleFor(state.fov), sx: short / w, sy: short / h, w, h, short, dpr };
  }

  /** Where the ellipse sits: centred in the room between the search and the dock, device pixels, y up. */
  function mapFrame(cam) {
    const top = state.insets.top * cam.dpr;
    const bottom = state.insets.bottom * cam.dpr;
    const roomW = cam.w * 0.96;
    const roomH = Math.max(cam.h * 0.3, cam.h - top - bottom);
    const s = Math.min(roomW / (4 * Math.SQRT2), roomH / (2 * Math.SQRT2)) * 0.97;
    return { cx: cam.w / 2, cy: bottom + roomH / 2 + Math.max(0, cam.h - top - bottom - roomH) / 2, s };
  }

  /** The textures and levels for a set of frames, if all are here; else null. */
  function layerOf(urls, priority) {
    const imgs = urls.map((u) => want(u, priority, { allsky: true }));
    if (!imgs.every((i) => i.state === 'ready')) return { ready: false, imgs };
    return { ready: true, imgs };
  }

  function bindLayer(prog, imgs, alpha, levelsFrom = imgs) {
    const colour = imgs.length === 3;
    for (let i = 0; i < 3; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, imgs[colour ? i : 0].tex);
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, rampTexture);
    const u = prog.u;
    gl.uniform1i(u.R, 0);
    gl.uniform1i(u.G, 1);
    gl.uniform1i(u.B, 2);
    gl.uniform1i(u.Ramp, 3);
    gl.uniform1i(u.Colour, colour ? 1 : 0);
    const lv = levelsFrom.map((i) => i.levels ?? { lo: 0, hi: 1 });
    const pick = (key) => (colour ? lv.map((l) => l[key]) : [lv[0][key], lv[0][key], lv[0][key]]);
    gl.uniform3fv(u.Lo, pick('lo'));
    gl.uniform3fv(u.Hi, pick('hi'));
    gl.uniform1f(u.Alpha, alpha);
  }

  const fadeOf = (imgs, now) => Math.min(1, ...imgs.map((i) => (now - i.readyAt) / FADE_MS));

  function onScreen(centre, radiusDeg, cam) {
    const cz = dot(centre, cam.C);
    if (cz < FRONT) return false;
    const x = (-dot(centre, cam.E) / cz) * cam.k * cam.sx;
    const y = (dot(centre, cam.N) / cz) * cam.k * cam.sy;
    // The tile's reach on the screen: its radius, magnified as the camera
    // magnifies toward the edge of a wide field.
    const reach = (radiusDeg * DEG / (cz * cz)) * cam.k * Math.max(cam.sx, cam.sy);
    return Math.abs(x) <= 1 + reach && Math.abs(y) <= 1 + reach;
  }

  function visibleTiles(order, cam) {
    const c = centresOf(order);
    // From a tile's middle to its corner: about three quarters of its side.
    const radius = tileDegrees(order) * 0.75;
    const out = [];
    for (let n = 0; n < c.length / 3; n++) {
      const v = [c[n * 3], c[n * 3 + 1], c[n * 3 + 2]];
      if (onScreen(v, radius, cam)) out.push({ n, near: -dot(v, cam.C) });
    }
    out.sort((a, b) => a.near - b.near);
    return out.slice(0, WANT_MAX);
  }

  function useSphere(cam) {
    gl.useProgram(sphere.program);
    gl.uniform3fv(sphere.u.C, cam.C);
    gl.uniform3fv(sphere.u.E, cam.E);
    gl.uniform3fv(sphere.u.N, cam.N);
    gl.uniform2f(sphere.u.Scale, cam.k * cam.sx, cam.k * cam.sy);
  }

  function drawAllsky(cam) {
    gl.bindVertexArray(allskyMesh.vao);
    let runStart = -1;
    const flush = (end) => {
      if (runStart < 0) return;
      gl.drawElements(gl.TRIANGLES, (end - runStart) * allskyMesh.perTile, gl.UNSIGNED_INT, runStart * allskyMesh.perTile * 4);
      runStart = -1;
    };
    const radius = tileDegrees(ALLSKY_ORDER) * 0.75;
    for (let n = 0; n < ALLSKY_COUNT; n++) {
      if (onScreen(allskyCentres[n], radius, cam)) {
        if (runStart < 0) runStart = n;
      } else {
        flush(n);
      }
    }
    flush(ALLSKY_COUNT);
  }

  /**
   * One set of frames on the sphere: Allsky, then the tiles. `fetch` says
   * whether to ask for what is missing (the current frames) or only draw
   * what is here (the frames being faded out). Returns the counts and whether
   * anything is still fading in.
   */
  function drawSphereLayer(frames, cam, now, fetch, alpha) {
    const out = { wanted: 0, have: 0, fading: false, base: false };
    const sky = fetch ? layerOf(frames.map(allskyUrl), -1) : { imgs: frames.map((f) => images.get(allskyUrl(f))) };
    const skyReady = sky.imgs.every((i) => i?.state === 'ready');
    out.wanted += frames.length;
    useSphere(cam);
    if (skyReady) {
      out.have += frames.length;
      out.base = true;
      const f0 = fadeOf(sky.imgs, now) * alpha;
      if (f0 < 1) out.fading = true;
      bindLayer(sphere, sky.imgs, f0);
      // The Allsky's pixels each carry their own noise, and spread over a wide
      // field they show as grain. Read a little down the mipmap, the grain
      // averages out and the light stays; the sharp tiles above are read as they are.
      gl.uniform1f(sphere.u.Bias, sky.imgs.every((i) => i.averaged) ? ALLSKY_BIAS.averaged : ALLSKY_BIAS.picked);
      gl.uniform2f(sphere.u.Texel, 1 / ATLAS_W, 1 / ATLAS_H);
      drawAllsky(cam);
      gl.uniform1f(sphere.u.Bias, 0);
    } else if (!fetch) {
      return out;
    }
    // Without its Allsky a tile is still drawn, at levels that pass IRSA's stretch through.
    const passThrough = frames.map(() => ({ levels: { lo: 0.06, hi: 0.9 } }));
    // A tile's floor, from its Allsky's, set against the tiles' own grain.
    const tileLevels = skyReady
      ? sky.imgs.map((i) => ({ levels: { lo: Math.min(i.levels.median + i.levels.tileSigma * FLOOR_SIGMAS, i.levels.hi - 0.05), hi: i.levels.hi } }))
      : passThrough;

    const target = orderFor(state.fov / cam.short);
    if (target === null) return out;
    gl.uniform2f(sphere.u.Texel, 1 / TILE_PX, 1 / TILE_PX);
    for (let order = ALLSKY_ORDER; order <= target; order++) {
      const levels = tileLevels;
      for (const { n, near } of visibleTiles(order, cam)) {
        const urls = frames.map((f) => tileUrl(order, n, f));
        const imgs = urls.map((u) => (fetch && order === target ? want(u, near) : images.get(u)));
        if (fetch && order === target) out.wanted += imgs.length;
        if (!imgs.every((i) => i?.state === 'ready')) continue;
        if (fetch && order === target) out.have += imgs.length;
        for (const i of imgs) i.used = use;
        const f = fadeOf(imgs, now) * alpha;
        if (f < 1) out.fading = true;
        // Levels always from the Allsky of the same frames, so a tile and the
        // sky around it are set alike.
        bindLayer(sphere, imgs, f, levels);
        const mesh = tileVao(order, n);
        mesh.used = use;
        gl.bindVertexArray(mesh.vao);
        gl.drawElements(gl.TRIANGLES, mesh.perTile, gl.UNSIGNED_INT, 0);
      }
    }
    return out;
  }

  function drawMapLayer(frames, cam, now, fetch, alpha) {
    const out = { wanted: frames.length, have: 0, fading: false, base: false };
    const imgs = frames.map((f) => (fetch ? want(allskyUrl(f), -1, { allsky: true }) : images.get(allskyUrl(f))));
    if (!imgs.every((i) => i?.state === 'ready')) return out;
    out.have = frames.length;
    out.base = true;
    const f = fadeOf(imgs, now) * alpha;
    if (f < 1) out.fading = true;
    const frame = mapFrame(cam);
    gl.useProgram(map.program);
    bindLayer(map, imgs, f);
    gl.uniform2f(map.u.Centre, frame.cx, frame.cy);
    gl.uniform1f(map.u.S, frame.s);
    gl.uniformMatrix3fv(map.u.FromGal, false, GALACTIC.flat());
    // The mosaic's pixel against the screen's, for the right mipmap level.
    const degPerPx = 360 / (4 * Math.SQRT2 * frame.s);
    gl.uniform1f(map.u.Lod, Math.max(0, Math.log2(degPerPx / (tileDegrees(ALLSKY_ORDER) / ALLSKY_TILE)) - 1));
    gl.uniform1f(map.u.Edge, 1.5 / frame.s);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return out;
  }

  /* ---- lines ----------------------------------------------------------- */

  function gridStep(fov) {
    for (const s of [0.25, 0.5, 1, 2, 5, 10, 15, 30]) if (fov / s <= 8) return s;
    return 30;
  }

  /** Lines on the sky, each a list of ICRS vectors, as screen polylines in clip space. */
  function strokes(lines, cam, inMap) {
    const out = [];
    const frame = inMap ? mapFrame(cam) : null;
    for (const pts of lines) {
      let run = [];
      let last = null;
      for (const v of pts) {
        let p = null;
        if (inMap) {
          const g = toGalactic(v);
          const { ra: l, dec: b } = radecOf(g);
          const m = mollweide(l, b);
          p = [(frame.cx + m.x * frame.s) / cam.w * 2 - 1, (frame.cy + m.y * frame.s) / cam.h * 2 - 1];
          // The map's left and right edges are one meridian: a line crossing it breaks there.
          if (last && Math.abs(p[0] - last[0]) > 0.5) {
            if (run.length > 1) out.push(run);
            run = [];
          }
        } else if (dot(v, cam.C) > 0.05) {
          const d = dot(v, cam.C);
          p = [(-dot(v, cam.E) / d) * cam.k * cam.sx, (dot(v, cam.N) / d) * cam.k * cam.sy];
        }
        if (!p) {
          if (run.length > 1) out.push(run);
          run = [];
        } else {
          run.push(p);
        }
        last = p;
      }
      if (run.length > 1) out.push(run);
    }
    return out;
  }

  function drawLines(cam, inMap, alpha) {
    const grid = [];
    if (inMap) {
      // On the map, the galaxy's own lines: latitude every 30°, longitude every 60°.
      for (let b = -60; b <= 60; b += 30) {
        const pts = [];
        for (let l = 0; l <= 360; l += 1) pts.push(fromGalactic(vecOf(l, b)));
        grid.push(pts);
      }
      for (let l = 0; l < 360; l += 60) {
        const pts = [];
        for (let b = -90; b <= 90; b += 1) pts.push(fromGalactic(vecOf(l, b)));
        grid.push(pts);
      }
    } else {
      const step = gridStep(state.fov);
      const raStep = state.fov > 60 ? 30 : step;
      const fine = Math.min(step / 8, 1);
      for (let dec = -90 + step; dec < 90; dec += step) {
        const pts = [];
        for (let ra = 0; ra <= 360; ra += fine * 2) pts.push(vecOf(ra, dec));
        grid.push(pts);
      }
      for (let ra = 0; ra < 360; ra += raStep) {
        const pts = [];
        for (let dec = -90; dec <= 90; dec += fine * 2) pts.push(vecOf(ra, dec));
        grid.push(pts);
      }
    }
    // The ecliptic: the plane the planets keep to, and the first place to look for one.
    const eps = 23.4393 * DEG;
    const ecl = [];
    for (let l = 0; l <= 360; l += 0.5) {
      const lam = l * DEG;
      ecl.push([Math.cos(lam), Math.sin(lam) * Math.cos(eps), Math.sin(lam) * Math.sin(eps)]);
    }
    gl.useProgram(line.program);
    gl.bindVertexArray(lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
    for (const [set, colour] of [[grid, ink.grid], [[ecl], ink.ecliptic]]) {
      gl.uniform4fv(line.u.Ink, [colour[0], colour[1], colour[2], colour[3] * alpha]);
      for (const run of strokes(set, cam, inMap)) {
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(run.flat()), gl.STREAM_DRAW);
        gl.drawArrays(gl.LINE_STRIP, 0, run.length);
      }
    }
  }

  /* ---- the frame ------------------------------------------------------- */

  function draw() {
    queued = false;
    if (disposed) return;
    use++;
    const now = performance.now();
    const cam = camera();
    gl.viewport(0, 0, cam.w, cam.h);
    gl.clearColor(0.025, 0.025, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const m = state.map;
    let result = { wanted: 0, have: 0, fading: false, base: false };
    const layer = (fn, alpha) => {
      // Under the new frames, the old ones, until the new are fully up.
      if (previous.length) fn(previous, cam, now, false, alpha);
      const r = fn(state.frames, cam, now, true, alpha);
      result = { wanted: result.wanted + r.wanted, have: result.have + r.have, fading: result.fading || r.fading, base: result.base || r.base };
    };
    if (state.frames.length) {
      if (m < 1) layer(drawSphereLayer, 1);
      if (m > 0) layer(drawMapLayer, m);
      pump();
      evict();
    }
    if (previous.length && ((result.base && !result.fading && result.have >= result.wanted) || now - previousSince > 4000)) previous = [];
    if (state.grid) {
      if (m < 1) drawLines(cam, false, 1 - m);
      if (m > 0) drawLines(cam, true, m);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    if (result.fading || previous.length) redraw();
    const failed = [...images.values()].filter((i) => i.state === 'failed' && i.used >= use).length;
    onChange({ wanted: result.wanted, have: result.have, failed });
  }

  function redraw() {
    if (queued || disposed) return;
    queued = true;
    requestAnimationFrame(draw);
  }

  new ResizeObserver(redraw).observe(canvas);

  /** The map's device-pixel frame and the camera, for the pointer helpers. */
  const geometry = () => {
    const cam = camera();
    return { cam, frame: mapFrame(cam) };
  };

  return {
    get state() { return { ...state, frames: [...state.frames] }; },
    set({ ra = state.ra, dec = state.dec, fov = state.fov, map: mix = state.map } = {}) {
      state.ra = ((ra % 360) + 360) % 360;
      state.dec = Math.max(-89.999, Math.min(89.999, dec));
      state.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, fov));
      state.map = Math.max(0, Math.min(1, mix));
      redraw();
    },
    /** One frame for a single wavelength, three (red, green, blue) for colour. */
    setFrames(frames) {
      if (frames.join() === state.frames.join()) return;
      const sky = state.frames.map((f) => images.get(allskyUrl(f)));
      if (state.frames.length && sky.every((i) => i?.state === 'ready')) {
        previous = state.frames;
        previousSince = performance.now();
      }
      state.frames = [...frames];
      redraw();
    },
    setGrid(on) { state.grid = on; redraw(); },
    /** CSS pixels kept clear of the map at the top and bottom. */
    setInsets(insets) { state.insets = insets; redraw(); },
    /** The sky under a point of the canvas (CSS pixels), in whichever view is showing; null off the map. */
    skyAt(px, py) {
      const { cam, frame } = geometry();
      if (state.map >= 0.5) {
        const x = (px * cam.dpr - frame.cx) / frame.s;
        const y = (cam.h - py * cam.dpr - frame.cy) / frame.s;
        const g = mollweideInverse(x, y);
        return g ? radecOf(fromGalactic(vecOf(g.l, g.b))) : null;
      }
      const x = (px * cam.dpr - cam.w / 2) / (cam.short / 2);
      const y = -(py * cam.dpr - cam.h / 2) / (cam.short / 2);
      return radecOf(unproject(x, y, cam, cam.k));
    },
    /** Where a point of the sky is on the canvas, CSS pixels; null if behind. */
    screenOf(ra, dec) {
      const { cam, frame } = geometry();
      if (state.map >= 0.5) {
        const { ra: l, dec: b } = radecOf(toGalactic(vecOf(ra, dec)));
        const m = mollweide(l, b);
        return { x: (frame.cx + m.x * frame.s) / cam.dpr, y: (cam.h - frame.cy - m.y * frame.s) / cam.dpr };
      }
      const v = vecOf(ra, dec);
      const d = dot(v, cam.C);
      if (d < 0.05) return null;
      const x = (-dot(v, cam.E) / d) * (cam.short / 2);
      const y = (dot(v, cam.N) / d) * (cam.short / 2);
      return { x: (cam.w / 2 + x * cam.k) / cam.dpr, y: (cam.h / 2 - y * cam.k) / cam.dpr };
    },
    redraw,
    dispose() { disposed = true; },
  };
}

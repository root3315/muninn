/**
 * view.js — the whole sky drawn from inside, in WebGL 2.
 *
 * The observer stands at the centre of the celestial sphere and looks out, so
 * east is on the left with north up, as on any sky chart. The sphere is put on
 * the screen by the stereographic projection: it keeps small shapes true at
 * every width, which is why a constellation looks itself both at 120° and at
 * 1°, and it reaches past a hemisphere without tearing.
 *
 * What is drawn, coarse to fine:
 *   1. the cube's Allsky image — the whole sky in one picture of 768 small
 *      tiles, there from the first second;
 *   2. full 512-pixel tiles of orders 3 to 5, as the field narrows, each laid
 *      over its parent once it has arrived, so the picture only ever sharpens.
 *
 * One frame of the cube is one wavelength. The colour view samples three
 * frames, one per display channel; the single view runs one frame through a
 * ramp. The data are the cube's PNGs as served — the stretch is IRSA's
 * (asinh, 0–40 MJy/sr) and nothing here alters it.
 */

import { vecOf, radecOf, tileMesh, tileCentre } from './healpix.js';
import {
  ALLSKY_ORDER, ALLSKY_TILE, TILE_PX, allskySlot, allskyUrl, tileUrl, orderFor, tileDegrees,
} from './hips.js';

const DEG = Math.PI / 180;
export const FOV_MIN = 0.4;
export const FOV_MAX = 150;
/** Tiles are not drawn whose middle is this far behind the observer's ear: stereographic runs to infinity at the antipode. */
const BEHIND = -0.35;
/** More tiles than this on screen at one order is more than any screen shows. */
const WANT_MAX = 140;
const LOADS_AT_ONCE = 6;
const KEEP_TILES = 260;
const RETRY_MS = 8000;

const VERTEX = `#version 300 es
in vec3 aPos;
in vec2 aUv;
uniform vec3 uC;
uniform vec3 uE;
uniform vec3 uN;
uniform vec2 uScale;
out vec2 vUv;
void main() {
  float d = 1.0 + dot(aPos, uC);
  vec2 p = vec2(-dot(aPos, uE), dot(aPos, uN)) * 2.0 / max(d, 1e-4);
  gl_Position = vec4(p * uScale, 0.0, 1.0);
  vUv = aUv;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uR;
uniform sampler2D uG;
uniform sampler2D uB;
uniform sampler2D uRamp;
uniform bool uColour;
out vec4 outColour;
void main() {
  float r = texture(uR, vUv).r;
  if (uColour) {
    outColour = vec4(r, texture(uG, vUv).r, texture(uB, vUv).r, 1.0);
  } else {
    outColour = vec4(texture(uRamp, vec2(r, 0.5)).rgb, 1.0);
  }
}`;

const LINE_VERTEX = `#version 300 es
in vec3 aPos;
uniform vec3 uC;
uniform vec3 uE;
uniform vec3 uN;
uniform vec2 uScale;
void main() {
  float d = 1.0 + dot(aPos, uC);
  vec2 p = vec2(-dot(aPos, uE), dot(aPos, uN)) * 2.0 / max(d, 1e-4);
  gl_Position = vec4(p * uScale, 0.0, 1.0);
}`;

const LINE_FRAGMENT = `#version 300 es
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
  return program;
}

/** The camera's basis: C toward the middle of the screen, E toward east, N toward north. */
export function basisOf(ra, dec) {
  const a = ra * DEG;
  const d = dec * DEG;
  const C = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  const E = [-Math.sin(a), Math.cos(a), 0];
  const N = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
  return { C, E, N };
}

const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

/**
 * Where a direction lands, as offsets from the middle of the screen in units
 * of the screen's shorter half-side, x right and y up; null behind the
 * observer.
 */
export function project(v, { C, E, N }, k) {
  const d = 1 + dot(v, C);
  if (d < 1 + BEHIND) return null;
  return { x: (-dot(v, E) * 2 / d) * k, y: (dot(v, N) * 2 / d) * k, cz: d - 1 };
}

/** The direction under a screen offset — the inverse of project. */
export function unproject(x, y, { C, E, N }, k) {
  const X = -x / k;
  const Y = y / k;
  const r2 = X * X + Y * Y;
  const s = 4 / (4 + r2);
  const cx = X * s;
  const cy = Y * s;
  const cz = (4 - r2) / (4 + r2);
  return [0, 1, 2].map((i) => cx * E[i] + cy * N[i] + cz * C[i]);
}

/** Screen units per stereographic unit, for a field `fov` degrees across the shorter side. */
export const scaleFor = (fov) => 1 / (2 * Math.tan((fov * DEG) / 4));

/**
 * The view itself. `ramp` is a list of CSS colours, dark to light, for the
 * single-wavelength view. Calls `onChange` after every redraw with how many
 * tiles the screen wants and has.
 */
export function createSkyView(canvas, { ramp, onChange = () => {} }) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  const program = compile(gl, VERTEX, FRAGMENT, ['aPos', 'aUv']);
  const lineProgram = compile(gl, LINE_VERTEX, LINE_FRAGMENT, ['aPos']);
  const at = (p, n) => gl.getUniformLocation(p, n);
  const U = { C: at(program, 'uC'), E: at(program, 'uE'), N: at(program, 'uN'), scale: at(program, 'uScale'),
    R: at(program, 'uR'), G: at(program, 'uG'), B: at(program, 'uB'), ramp: at(program, 'uRamp'), colour: at(program, 'uColour') };
  const L = { C: at(lineProgram, 'uC'), E: at(lineProgram, 'uE'), N: at(lineProgram, 'uN'), scale: at(lineProgram, 'uScale'), ink: at(lineProgram, 'uInk') };

  const state = { ra: 266.4, dec: -29.0, fov: 120, frames: [], grid: false };
  let disposed = false;
  let queued = false;

  /* ---- meshes ------------------------------------------------------- */

  /** A mesh in one VAO: positions and texture coordinates, indexed as a grid of quads. */
  function meshVao(positions, uv, steps, count) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const tex = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tex);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
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
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, perTile, buffers: [pos, tex, ib] };
  }

  // The Allsky mosaic: every order-3 tile, its texture coordinates pointing
  // into its 64-pixel cell of one image, half a texel in from the edge so the
  // filter never reaches the neighbouring cell.
  const ALLSKY_COUNT = 12 * 4 ** ALLSKY_ORDER;
  const ALLSKY_STEPS = 4;
  const allskyMesh = (() => {
    const side = ALLSKY_STEPS + 1;
    const positions = new Float32Array(ALLSKY_COUNT * side * side * 3);
    const uv = new Float32Array(ALLSKY_COUNT * side * side * 2);
    const W = 27 * ALLSKY_TILE;
    const H = Math.ceil(ALLSKY_COUNT / 27) * ALLSKY_TILE;
    const inset = 0.5 / ALLSKY_TILE;
    for (let n = 0; n < ALLSKY_COUNT; n++) {
      const m = tileMesh(ALLSKY_ORDER, n, ALLSKY_STEPS);
      positions.set(m.positions, n * side * side * 3);
      const slot = allskySlot(n);
      for (let v = 0; v < side * side; v++) {
        const u = inset + m.uv[v * 2] * (1 - 2 * inset);
        const w = inset + m.uv[v * 2 + 1] * (1 - 2 * inset);
        uv[(n * side * side + v) * 2] = (slot.x + u * ALLSKY_TILE) / W;
        uv[(n * side * side + v) * 2 + 1] = (slot.y + w * ALLSKY_TILE) / H;
      }
    }
    return meshVao(positions, uv, ALLSKY_STEPS, ALLSKY_COUNT);
  })();
  const allskyCentres = Array.from({ length: ALLSKY_COUNT }, (_, n) => tileCentre(ALLSKY_ORDER, n));

  /** Tile centres by order, made once on first need: 12 288 at order 5. */
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

  /** One mesh per detail tile, kept with the tile. */
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

  /* ---- textures ----------------------------------------------------- */

  function makeTexture(source, { mip, maxLevel = 8 }) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mip) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, maxLevel);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    return tex;
  })();

  /**
   * Every image the view has asked for, by URL: `{ state, tex, used }`, state
   * one of queued, loading, ready, failed.
   */
  const images = new Map();
  const queue = [];
  let loading = 0;
  let use = 0;

  function want(url, priority, mip) {
    let img = images.get(url);
    if (!img) {
      img = { state: 'queued', tex: null, used: use, priority, mip, retryAt: 0 };
      images.set(url, img);
      queue.push(url);
    } else if (img.state === 'failed' && performance.now() > img.retryAt) {
      // IRSA has its bad minutes; a tile that failed is asked again later, not given up on.
      img.state = 'queued';
      queue.push(url);
    }
    img.used = use;
    img.priority = priority;
    return img;
  }

  async function load(url) {
    const img = images.get(url);
    img.state = 'loading';
    loading++;
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(String(res.status));
      const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (disposed) return;
      img.tex = makeTexture(bitmap, { mip: true, maxLevel: img.mip });
      bitmap.close?.();
      img.state = 'ready';
    } catch {
      img.state = 'failed';
      img.retryAt = performance.now() + RETRY_MS;
    } finally {
      loading--;
      pump();
      redraw();
    }
  }

  /** Start the most wanted loads, nearest the middle of the screen first; forget what is no longer wanted. */
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

  /** Drop the least recently drawn textures past the budget. */
  function evict() {
    const ready = [...images.entries()].filter(([, v]) => v.state === 'ready' && !v.pinned);
    if (ready.length <= KEEP_TILES) return;
    ready.sort((a, b) => a[1].used - b[1].used);
    for (const [url, v] of ready.slice(0, ready.length - KEEP_TILES)) {
      gl.deleteTexture(v.tex);
      images.delete(url);
    }
  }

  /* ---- drawing ------------------------------------------------------ */

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h };
  }

  function camera() {
    const { w, h } = size();
    const short = Math.min(w, h);
    const k = scaleFor(state.fov);
    return { ...basisOf(state.ra, state.dec), k, sx: short / w, sy: short / h, w, h, short };
  }

  function useCamera(prog, u, cam) {
    gl.useProgram(prog);
    gl.uniform3fv(u.C, cam.C);
    gl.uniform3fv(u.E, cam.E);
    gl.uniform3fv(u.N, cam.N);
    gl.uniform2f(u.scale, cam.k * cam.sx, cam.k * cam.sy);
  }

  function bindFrames(texs) {
    const colour = texs.length === 3;
    for (let i = 0; i < 3; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texs[colour ? i : 0]);
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, rampTexture);
    gl.uniform1i(U.R, 0);
    gl.uniform1i(U.G, 1);
    gl.uniform1i(U.B, 2);
    gl.uniform1i(U.ramp, 3);
    gl.uniform1i(U.colour, colour ? 1 : 0);
  }

  /** Whether a tile with this middle and radius can touch the screen. */
  function onScreen(centre, radiusDeg, cam) {
    const cz = dot(centre, cam.C);
    if (cz < BEHIND) return false;
    const d = 1 + cz;
    const x = (-dot(centre, cam.E) * 2 / d) * cam.k * cam.sx;
    const y = (dot(centre, cam.N) * 2 / d) * cam.k * cam.sy;
    // The tile's reach on the screen: its radius, magnified as the stereographic
    // map magnifies at that distance from the middle.
    const reach = radiusDeg * DEG * (2 / d) * cam.k * Math.max(cam.sx, cam.sy) * 1.15;
    return Math.abs(x) <= 1 + reach && Math.abs(y) <= 1 + reach;
  }

  function drawAllsky(cam, ready) {
    bindFrames(ready);
    gl.bindVertexArray(allskyMesh.vao);
    let runStart = -1;
    const flush = (end) => {
      if (runStart < 0) return;
      gl.drawElements(gl.TRIANGLES, (end - runStart) * allskyMesh.perTile, gl.UNSIGNED_INT, runStart * allskyMesh.perTile * 4);
      runStart = -1;
    };
    const radius = tileDegrees(ALLSKY_ORDER);
    for (let n = 0; n < ALLSKY_COUNT; n++) {
      if (onScreen(allskyCentres[n], radius, cam)) {
        if (runStart < 0) runStart = n;
      } else {
        flush(n);
      }
    }
    flush(ALLSKY_COUNT);
  }

  /** The visible tiles of an order, nearest the middle first. */
  function visibleTiles(order, cam) {
    const c = centresOf(order);
    const radius = tileDegrees(order);
    const out = [];
    for (let n = 0; n < c.length / 3; n++) {
      const v = [c[n * 3], c[n * 3 + 1], c[n * 3 + 2]];
      if (onScreen(v, radius, cam)) out.push({ n, near: -dot(v, cam.C) });
    }
    out.sort((a, b) => a.near - b.near);
    return out.slice(0, WANT_MAX);
  }

  /** The grid: lines of RA and Dec at a spacing that suits the field, and the ecliptic. */
  const lineBuffer = gl.createBuffer();
  const lineVao = gl.createVertexArray();
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  function gridStep(fov) {
    for (const s of [0.25, 0.5, 1, 2, 5, 10, 15, 30]) if (fov / s <= 8) return s;
    return 30;
  }

  function drawLines(cam) {
    const step = gridStep(state.fov);
    const raStep = state.fov > 60 ? 30 : step;
    const pts = [];
    const runs = [];
    const fine = Math.min(step / 8, 1);
    const push = (list) => { runs.push([pts.length / 3, list.length]); for (const v of list) pts.push(...v); };
    for (let dec = -90 + step; dec < 90; dec += step) {
      const line = [];
      for (let ra = 0; ra <= 360; ra += fine * 2) line.push(vecOf(ra, dec));
      push(line);
    }
    for (let ra = 0; ra < 360; ra += raStep) {
      const line = [];
      for (let dec = -90; dec <= 90; dec += fine * 2) line.push(vecOf(ra, dec));
      push(line);
    }
    const gridRuns = runs.length;
    // The ecliptic: the plane the planets keep to, and the first place to look for one.
    const eps = 23.4393 * DEG;
    const ecl = [];
    for (let l = 0; l <= 360; l += 0.5) {
      const lam = l * DEG;
      ecl.push([Math.cos(lam), Math.sin(lam) * Math.cos(eps), Math.sin(lam) * Math.sin(eps)]);
    }
    push(ecl);

    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STREAM_DRAW);
    useCamera(lineProgram, L, cam);
    gl.bindVertexArray(lineVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // A segment that crosses behind the observer would be drawn across the
    // whole screen; such runs are split where they leave the front.
    runs.forEach(([start, count], i) => {
      gl.uniform4fv(L.ink, i < gridRuns ? [0.86, 0.88, 1, 0.16] : [1, 0.74, 0.38, 0.55]);
      let from = -1;
      for (let p = 0; p <= count; p++) {
        const ok = p < count && dot(pts.slice((start + p) * 3, (start + p) * 3 + 3), cam.C) > BEHIND;
        if (ok && from < 0) from = p;
        if (!ok && from >= 0) {
          if (p - from > 1) gl.drawArrays(gl.LINE_STRIP, start + from, p - from);
          from = -1;
        }
      }
    });
    gl.disable(gl.BLEND);
  }

  function draw() {
    queued = false;
    if (disposed) return;
    use++;
    const cam = camera();
    gl.viewport(0, 0, cam.w, cam.h);
    gl.clearColor(0.03, 0.03, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const frames = state.frames;
    let wanted = 0;
    let have = 0;
    if (frames.length) {
      useCamera(program, U, cam);
      // The whole sky first, at once, as the ground everything sharper is laid on.
      const skies = frames.map((f) => {
        const img = want(allskyUrl(f), -1, 2);
        img.pinned = true;
        return img;
      });
      wanted += skies.length;
      if (skies.every((s) => s.state === 'ready')) {
        have += skies.length;
        drawAllsky(cam, skies.map((s) => s.tex));
      }

      const degPerPx = state.fov / cam.short;
      const target = orderFor(degPerPx);
      if (target !== null) {
        for (let order = ALLSKY_ORDER; order <= target; order++) {
          const tiles = visibleTiles(order, cam);
          for (const { n, near } of tiles) {
            const urls = frames.map((f) => tileUrl(order, n, f));
            // Only the target order is fetched; a coarser one is drawn if it is already here.
            const imgs = urls.map((u) => (order === target ? want(u, near, 9) : images.get(u)));
            if (order === target) wanted += imgs.length;
            if (imgs.every((i) => i?.state === 'ready')) {
              if (order === target) have += imgs.length;
              for (const i of imgs) i.used = use;
              bindFrames(imgs.map((i) => i.tex));
              const mesh = tileVao(order, n);
              gl.bindVertexArray(mesh.vao);
              gl.drawElements(gl.TRIANGLES, mesh.perTile, gl.UNSIGNED_INT, 0);
            }
          }
        }
      }
      pump();
      evict();
    }
    if (state.grid) drawLines(cam);
    gl.bindVertexArray(null);
    const failed = [...images.values()].filter((i) => i.state === 'failed' && i.used >= use).length;
    onChange({ wanted, have, failed, cam });
  }

  function redraw() {
    if (queued || disposed) return;
    queued = true;
    requestAnimationFrame(draw);
  }

  new ResizeObserver(redraw).observe(canvas);

  return {
    get state() { return { ...state }; },
    /** Point the view: any of ra, dec, fov. */
    set({ ra = state.ra, dec = state.dec, fov = state.fov } = {}) {
      state.ra = ((ra % 360) + 360) % 360;
      state.dec = Math.max(-89.999, Math.min(89.999, dec));
      state.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, fov));
      redraw();
    },
    /** One frame for the single view, three (red, green, blue) for colour. */
    setFrames(frames) {
      if (frames.join() === state.frames.join()) return;
      for (const img of images.values()) img.pinned = false;
      state.frames = [...frames];
      redraw();
    },
    setGrid(on) { state.grid = on; redraw(); },
    /** The sky under a point of the canvas, in CSS pixels from its top left. */
    skyAt(px, py) {
      const cam = camera();
      const dpr = cam.w / canvas.clientWidth;
      const x = ((px * dpr - cam.w / 2) / (cam.short / 2));
      const y = -((py * dpr - cam.h / 2) / (cam.short / 2));
      return radecOf(unproject(x, y, cam, cam.k));
    },
    /** Where a point of the sky is on the canvas, in CSS pixels; null if behind. */
    screenOf(ra, dec) {
      const cam = camera();
      const p = project(vecOf(ra, dec), cam, cam.k);
      if (!p || p.cz < 0) return null;
      const dpr = cam.w / canvas.clientWidth;
      return { x: (cam.w / 2 + p.x * cam.short / 2) / dpr, y: (cam.h / 2 - p.y * cam.short / 2) / dpr };
    },
    redraw,
    dispose() { disposed = true; },
  };
}

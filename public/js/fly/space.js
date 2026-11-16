/**
 * space.js — the Sun's neighbourhood in three dimensions, drawn in WebGL 2.
 *
 * Every star is where its parallax puts it (data/fly/stars.bin), and is drawn
 * as bright as it would look from where the camera is: its absolute
 * magnitude, moved to the camera's distance by the inverse-square law. Fly
 * toward a star and it brightens; fly away from the Sun and the
 * constellations come apart, because their stars were only ever lined up from
 * here.
 *
 * Behind everything, at infinity, the Milky Way as SPHEREx saw it from the
 * Sun. A few hundred parsecs is next to nothing against the Galaxy, so from
 * anywhere this page can reach, the band would look almost the same.
 *
 * Units are parsecs; axes are ICRS, the Sun at the origin.
 */

const STAR_VS = `#version 300 es
in vec3 aPos;
in float aMag;
in vec3 aCol;
uniform vec3 uEye;
uniform vec3 uR;
uniform vec3 uU;
uniform vec3 uF;
uniform vec2 uFocal;
uniform float uLimit;
uniform float uPx;
out vec3 vCol;
out float vAlpha;
void main() {
  vec3 rel = aPos - uEye;
  float d = length(rel);
  vec3 c = vec3(dot(rel, uR), dot(rel, uU), dot(rel, uF));
  if (c.z < 1e-6 || d < 1e-5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  gl_Position = vec4(c.x / c.z * uFocal.x, c.y / c.z * uFocal.y, 0.0, 1.0);
  // Apparent magnitude from here, and the light that gets through.
  float m = aMag + 5.0 * log(d / 10.0) / log(10.0);
  float flux = pow(10.0, -0.4 * (m - uLimit));
  vAlpha = clamp(flux, 0.0, 1.0);
  gl_PointSize = clamp(uPx * (1.2 + 1.6 * log(1.0 + flux)), uPx, 48.0 * uPx);
  vCol = aCol;
}`;

const STAR_FS = `#version 300 es
precision mediump float;
in vec3 vCol;
in float vAlpha;
out vec4 outColour;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  // A bright core and a soft halo, as a star looks through any optics.
  float core = exp(-r2 * 9.0);
  float halo = exp(-r2 * 2.5) * 0.25;
  outColour = vec4(vCol * (core + halo) * vAlpha, 1.0);
}`;

const SKY_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
uniform vec3 uR;
uniform vec3 uU;
uniform vec3 uF;
uniform vec2 uFocal;
uniform vec2 uSize;
uniform float uDim;
uniform sampler2D uSky;
out vec4 outColour;
const float PI = 3.141592653589793;
void main() {
  vec2 ndc = gl_FragCoord.xy / uSize * 2.0 - 1.0;
  vec3 v = normalize(uF + (ndc.x / uFocal.x) * uR + (ndc.y / uFocal.y) * uU);
  vec2 uv = vec2(fract(atan(v.y, v.x) / (2.0 * PI) + 1.0), 0.5 - asin(clamp(v.z, -1.0, 1.0)) / PI);
  outColour = vec4(textureLod(uSky, uv, 0.0).rgb * uDim, 1.0);
}`;

function compile(gl, vs, fs, attributes = []) {
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
  const u = {};
  const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const { name } = gl.getActiveUniform(program, i);
    u[name.replace(/^u/, '')] = gl.getUniformLocation(program, name);
  }
  return { program, u };
}

/**
 * The scene. `stars` is { pos: Float32Array (x, y, z), mag: Float32Array,
 * col: Float32Array (r, g, b in 0–1) }; `sky` an image of the Milky Way in
 * equirectangular layout, or null.
 */
export function createSpace(canvas, { stars, sky }) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
  if (!gl) return null;
  const starProg = compile(gl, STAR_VS, STAR_FS, ['aPos', 'aMag', 'aCol']);
  const skyProg = compile(gl, SKY_VS, SKY_FS);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  for (const [i, data, size] of [[0, stars.pos, 3], [1, stars.mag, 1], [2, stars.col, 3]]) {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, size, gl.FLOAT, false, 0, 0);
  }
  gl.bindVertexArray(null);
  const count = stars.mag.length;
  const emptyVao = gl.createVertexArray();

  let skyTex = null;
  if (sky) {
    skyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, skyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sky);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  const coarse = matchMedia('(pointer: coarse)').matches;

  /** Size the canvas to its box; returns the device-pixel size. */
  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h, dpr };
  }

  return {
    /**
     * Draw from `eye` (parsecs) looking along the basis { R, U, F }, with a
     * vertical field of `fov` degrees. Returns the projection, for labels.
     */
    draw({ eye, R, U, F, fov, limit = 8.5 }) {
      const { w, h, dpr } = fit();
      const fy = 1 / Math.tan((fov * Math.PI) / 360);
      const focal = [fy * (h / w), fy];
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (skyTex) {
        gl.useProgram(skyProg.program);
        gl.uniform3fv(skyProg.u.R, R);
        gl.uniform3fv(skyProg.u.U, U);
        gl.uniform3fv(skyProg.u.F, F);
        gl.uniform2fv(skyProg.u.Focal, focal);
        gl.uniform2f(skyProg.u.Size, w, h);
        // The band behind, quieter than the stars in front of it.
        gl.uniform1f(skyProg.u.Dim, 0.45);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, skyTex);
        gl.uniform1i(skyProg.u.Sky, 0);
        gl.bindVertexArray(emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(starProg.program);
      gl.uniform3fv(starProg.u.Eye, eye);
      gl.uniform3fv(starProg.u.R, R);
      gl.uniform3fv(starProg.u.U, U);
      gl.uniform3fv(starProg.u.F, F);
      gl.uniform2fv(starProg.u.Focal, focal);
      gl.uniform1f(starProg.u.Limit, limit);
      gl.uniform1f(starProg.u.Px, dpr);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      return { focal, w, h, dpr };
    },
  };
}

/** Where a point in space lands on the canvas, CSS pixels; null if behind. */
export function screenOf(p, { eye, R, U, F }, { focal, w, h, dpr }) {
  const rel = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const z = rel[0] * F[0] + rel[1] * F[1] + rel[2] * F[2];
  if (z <= 1e-6) return null;
  const x = (rel[0] * R[0] + rel[1] * R[1] + rel[2] * R[2]) / z * focal[0];
  const y = (rel[0] * U[0] + rel[1] * U[1] + rel[2] * U[2]) / z * focal[1];
  if (Math.abs(x) > 1.2 || Math.abs(y) > 1.2) return null;
  return { x: ((x + 1) / 2) * w / dpr, y: ((1 - y) / 2) * h / dpr };
}

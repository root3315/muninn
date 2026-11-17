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
in float aRad;
in float aIr;
uniform bool uIR;
uniform float uFocalPx;
uniform float uMaxPoint;
uniform int uSkip[12];
uniform vec4 uNear;
uniform vec3 uEye;
uniform vec3 uR;
uniform vec3 uU;
uniform vec3 uF;
uniform vec2 uFocal;
uniform float uLimit;
uniform float uPx;
// The catalogue's stars, below this index, are dimmed by uStarGain while the
// survey's own picture of them is shown; the Sun's bodies, above it, are not.
uniform int uStored;
uniform float uStarGain;
out vec3 vCol;
out float vAlpha;
out float vDisk;
const float R_SUN_PC = ${695700 / 3.0856775814913673e13};
bool skipped(int id) {
  for (int k = 0; k < 12; k++) if (uSkip[k] == id) return true;
  return false;
}
void main() {
  vec3 rel = aPos - uEye;
  float d = length(rel);
  vec3 c = vec3(dot(rel, uR), dot(rel, uU), dot(rel, uF));
  // The near star is drawn as a sphere instead, from exact coordinates.
  if (c.z <= 1e-3 * d || d < 1e-16 || skipped(gl_VertexID)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  // Behind the near star's sphere: hidden by it.
  if (uNear.w > 0.0 && d > length(uNear.xyz)) {
    float along = dot(rel, uNear.xyz) / d;
    if (along > 0.0 && dot(uNear.xyz, uNear.xyz) - along * along < uNear.w * uNear.w) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
  }
  gl_Position = vec4(c.x / c.z * uFocal.x, c.y / c.z * uFocal.y, 0.0, 1.0);
  // Apparent magnitude from here, and the light that gets through.
  float m = (uIR ? aIr : aMag) + 5.0 * log(d / 10.0) / log(10.0);
  float flux = pow(10.0, -0.4 * (m - uLimit));
  vAlpha = clamp(flux, 0.0, 1.0) * (gl_VertexID < uStored ? uStarGain : 1.0);
  if (vAlpha <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  // The star's own disc, at its real size: its radius over its distance.
  float disc = aRad * R_SUN_PC / c.z * uFocalPx;
  float glow = clamp(uPx * (1.2 + 1.6 * log(1.0 + flux)), uPx, 48.0 * uPx);
  float size = min(max(glow, 2.0 * disc + 4.0 * uPx), uMaxPoint);
  gl_PointSize = size;
  vDisk = disc > 0.75 * uPx ? min(1.0, 2.0 * disc / size) : 0.0;
  vCol = aCol;
}`;

const STAR_FS = `#version 300 es
precision mediump float;
in vec3 vCol;
in float vAlpha;
in float vDisk;
out vec4 outColour;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  if (vDisk > 0.0 && r2 < vDisk * vDisk) {
    // Inside the disc: limb darkening, the edge of a star dimmer than its
    // middle because the eye sees cooler, higher layers there.
    float mu = sqrt(1.0 - r2 / (vDisk * vDisk));
    outColour = vec4(vCol * (0.4 + 0.6 * mu) * vAlpha, vAlpha);
    return;
  }
  // A bright core and a soft halo, as a star looks through any optics:
  // light added, covering nothing behind it.
  float core = exp(-r2 * 9.0);
  float halo = exp(-r2 * 2.5) * 0.25;
  outColour = vec4(vCol * (core + halo) * vAlpha, 0.0);
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

/*
 * The star the camera is close to, as a sphere: per pixel, the ray from the
 * eye meets it or passes it. A point sprite cannot be drawn larger than the
 * GPU allows; a star seen from a few of its own radii fills the sky.
 */
const NEAR_FS = `#version 300 es
precision highp float;
uniform vec3 uR;
uniform vec3 uU;
uniform vec3 uF;
uniform vec2 uFocal;
uniform vec2 uSize;
uniform vec3 uCentre;
uniform float uRadius;
uniform vec3 uCol;
uniform bool uLit;
uniform vec3 uSun;
// Rings, in units of the body's radius: inner edge, outer edge, the gap's
// inner and outer edges (all 0 for none), and the ring plane's pole.
uniform vec4 uRing;
uniform vec3 uPole;
// A surface map, simple cylindrical, west edge at longitude -180°, and the
// body's axes (prime meridian, 90° east, north pole) to read it by.
uniform bool uHasMap;
uniform sampler2D uMap;
uniform vec3 uBX;
uniform vec3 uBY;
uniform vec3 uBZ;
// Air: the colour its scattered sunlight adds (0 for none). The maps are of
// the ground; from space the Earth is as blue as its air makes it.
uniform vec3 uAir;
// The ground's slope east and north (relief.js), laid out as the map, and
// how many times steeper than true it is drawn.
uniform bool uHasRelief;
uniform sampler2D uRelief;
uniform float uReliefScale;
out vec4 outColour;

const float PI = 3.14159265;

/** Where the normal n points on the maps, and the gradients to read them by, taken across the seam at ±180° without a line. */
vec2 mapAt(vec3 n, out vec2 dx, out vec2 dy) {
  float lon = atan(dot(n, uBY), dot(n, uBX));
  float lat = asin(clamp(dot(n, uBZ), -1.0, 1.0));
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  float u2 = fract(uv.x + 0.5);
  dx = vec2(dFdx(uv.x), dFdx(uv.y));
  dy = vec2(dFdy(uv.x), dFdy(uv.y));
  if (abs(dFdx(u2)) < abs(dx.x)) dx.x = dFdx(u2);
  if (abs(dFdy(u2)) < abs(dy.x)) dy.x = dFdy(u2);
  return uv;
}

/** The map's colour there; the map is sRGB, and light is added in linear terms. */
vec3 surface(vec2 uv, vec2 dx, vec2 dy) {
  return pow(textureGrad(uMap, uv, dx, dy).rgb, vec3(2.2));
}

/**
 * The ground's own normal: the sphere's, tilted by the slope there. Ground
 * rising to the east faces west by as much, and so on; at the poles, where
 * east has no direction, the sphere's.
 */
vec3 ground(vec3 n, vec2 uv, vec2 dx, vec2 dy) {
  if (!uHasRelief) return n;
  vec3 east = cross(uBZ, n);
  if (dot(east, east) < 1e-8) return n;
  east = normalize(east);
  vec3 north = cross(n, east);
  vec2 slope = textureGrad(uRelief, uv, dx, dy).rg * uReliefScale;
  return normalize(n - slope.x * east - slope.y * north);
}

/** Whether a point is in the body's shadow: the line from it to the Sun passes through the body. */
bool shadowed(vec3 p) {
  vec3 toSun = normalize(uSun - p);
  vec3 c = uCentre - p;
  float t = dot(c, toSun);
  if (t <= 0.0) return false;
  return dot(c, c) - t * t < uRadius * uRadius;
}

/** The rings seen along v: their colour and cover, and how far away; cover 0 where there are none. */
vec4 rings(vec3 v, out float dist) {
  dist = 1e30;
  if (uRing.y <= 0.0) return vec4(0.0);
  float den = dot(v, uPole);
  if (abs(den) < 1e-9) return vec4(0.0);
  float t = dot(uCentre, uPole) / den;
  if (t <= 0.0) return vec4(0.0);
  vec3 p = v * t;
  float d = length(p - uCentre) / uRadius;
  if (d < uRing.x || d > uRing.y || (d > uRing.z && d < uRing.w)) return vec4(0.0);
  dist = t;
  // Denser in the middle (the B ring), thinner at the edges; the side the
  // Sun lights is brighter than the side away from it.
  float dense = smoothstep(uRing.x, uRing.x + 0.25, d) * (d < uRing.z ? 0.95 : 0.7) * (1.0 - smoothstep(uRing.y - 0.08, uRing.y, d));
  float lit = abs(dot(normalize(uSun - p), uPole)) * 0.75 + 0.25;
  if (shadowed(p)) lit *= 0.12;
  return vec4(uCol * 1.05 * lit, dense);
}

void main() {
  vec2 ndc = gl_FragCoord.xy / uSize * 2.0 - 1.0;
  vec3 v = normalize(uF + (ndc.x / uFocal.x) * uR + (ndc.y / uFocal.y) * uU);
  float along = dot(v, uCentre);
  float ringDist;
  vec4 ring = rings(v, ringDist);
  if (along <= 0.0 && ring.a <= 0.0) discard;
  float miss2 = dot(uCentre, uCentre) - along * along;
  float r2 = uRadius * uRadius;
  float hitDist = miss2 < r2 && along > 0.0 ? along - sqrt(r2 - miss2) : 1e30;
  // Rings in front of the body are drawn over it; behind it, hidden by it.
  if (ring.a > 0.0 && ringDist < hitDist) {
    vec3 under = vec3(0.0);
    if (hitDist < 1e29) {
      vec3 hit = v * hitDist;
      vec3 n = (hit - uCentre) / uRadius;
      under = uCol * (0.02 + 0.98 * max(0.0, dot(n, normalize(uSun - hit))));
    }
    outColour = vec4(mix(under, ring.rgb, ring.a), hitDist < 1e29 ? 1.0 : ring.a);
    return;
  }
  if (miss2 < r2 && along > 0.0) {
    if (uLit) {
      // A planet or the Moon: lit by the Sun from where the Sun is, so its
      // phase is the phase it has from here. A little ambient keeps the night
      // side from being a hole in the stars.
      vec3 hit = v * (along - sqrt(r2 - miss2));
      vec3 n = (hit - uCentre) / uRadius;
      float sunUp = dot(n, normalize(uSun - hit));
      float day = max(0.0, sunUp);
      // The rings' shadow on the body.
      float ringShade = 1.0;
      if (uRing.y > 0.0) {
        vec3 toSun = normalize(uSun - hit);
        float den = dot(toSun, uPole);
        if (abs(den) > 1e-6) {
          float t = dot(uCentre - hit, uPole) / den;
          if (t > 0.0) {
            float d = length(hit + toSun * t - uCentre) / uRadius;
            if (d > uRing.x && d < uRing.y && !(d > uRing.z && d < uRing.w)) ringShade = 0.35;
          }
        }
      }
      day *= ringShade;
      if (uHasMap) {
        vec2 dx;
        vec2 dy;
        vec2 uv = mapAt(n, dx, dy);
        // The Sun on the ground as it slopes: a slope facing it brighter, one
        // facing away darker, most of all near the terminator, where the Sun
        // is low. A peak just past the terminator still catches a little.
        vec3 g = ground(n, uv, dx, dy);
        float lit = max(0.0, dot(g, normalize(uSun - hit))) * smoothstep(-0.05, 0.02, sunUp) * ringShade;
        // The map, lit as the plain colour is; back to sRGB for the screen.
        vec3 lin = surface(uv, dx, dy) * (0.015 + 1.1 * lit);
        // Scattered light, more of it towards the limb, where the line of
        // sight runs through more air; only where the Sun is up.
        float mu = max(dot(n, -v), 0.0);
        float twilight = smoothstep(-0.15, 0.25, dot(n, normalize(uSun - hit)));
        lin += uAir * twilight * (0.35 + 0.9 * pow(1.0 - mu, 3.0));
        outColour = vec4(pow(lin, vec3(1.0 / 2.2)), 1.0);
        return;
      }
      outColour = vec4(uCol * (0.02 + 0.98 * day), 1.0);
    } else {
      // A star: limb darkening, the edge dimmer than the middle.
      float mu = sqrt(1.0 - miss2 / r2);
      outColour = vec4(uCol * (0.4 + 0.6 * mu), 1.0);
    }
  } else if (uLit) {
    // The air's thin rim beyond the limb, lit side only.
    if (uAir.b > 0.0) {
      float above = (sqrt(miss2) - uRadius) / (uRadius * 0.025);
      if (above < 1.0 && along > 0.0) {
        vec3 rim = uCentre + normalize(v * along - uCentre) * uRadius;
        float lit = smoothstep(-0.1, 0.3, dot(normalize(rim - uCentre), normalize(uSun - rim)));
        float a = (1.0 - above) * (1.0 - above) * lit;
        outColour = vec4(pow(uAir * 2.2 * a, vec3(1.0 / 2.2)), a);
        return;
      }
    }
    if (ring.a > 0.0) {
      outColour = vec4(ring.rgb * ring.a, ring.a);
      return;
    }
    discard;
  } else {
    // A star's light scattered in the eye: added, not drawn over. Its reach
    // is in pixels, at least the glow its point had, so it never shrinks.
    float pxPerRad = uFocal.y * uSize.y * 0.5;
    float limbPx = (sqrt(miss2) - uRadius) / along * pxPerRad;
    float discPx = uRadius / along * pxPerRad;
    float reach = max(discPx * 0.6, 7.0);
    outColour = vec4(uCol * 0.55 * exp(-limbPx / reach), 0.0);
  }
}`;

/* Lines in space — the reach shells, the orbits — projected by the camera, clipped by the GPU through w. */
const LINE3_VS = `#version 300 es
in vec3 aPos;
uniform vec3 uEye;
uniform vec3 uR;
uniform vec3 uU;
uniform vec3 uF;
uniform vec2 uFocal;
void main() {
  vec3 rel = aPos - uEye;
  gl_Position = vec4(dot(rel, uR) * uFocal.x, dot(rel, uU) * uFocal.y, 0.0, dot(rel, uF));
}`;

const LINE3_FS = `#version 300 es
precision mediump float;
uniform vec4 uInk;
out vec4 outColour;
void main() { outColour = uInk; }`;

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
export function createSpace(canvas, { stars, sky, stored = Infinity }) {
  // Alpha: where the SPHEREx sky under this canvas shows through (see draw's survey).
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, depth: false });
  if (!gl) return null;
  const starProg = compile(gl, STAR_VS, STAR_FS, ['aPos', 'aMag', 'aCol', 'aRad', 'aIr']);
  const lineProg = compile(gl, LINE3_VS, LINE3_FS, ['aPos']);
  /** Line groups uploaded once: { vao, count, ink, show }. */
  let lineGroups = [];
  const live = {};
  const liveBufs = {};
  const maps = new Map();
  const reliefs = new Map();
  const skyProg = compile(gl, SKY_VS, SKY_FS);
  const nearProg = compile(gl, SKY_VS, NEAR_FS);
  const maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  let posBuffer = null;
  for (const [i, data, size] of [[0, stars.pos, 3], [1, stars.mag, 1], [2, stars.col, 3], [3, stars.rad, 1], [4, stars.ir, 1]]) {
    const buf = gl.createBuffer();
    if (i === 0) posBuffer = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
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
     * vertical field of `fov` degrees; `near` is the star the camera is
     * closest to, { index, pos, rpc, col }, drawn as a sphere. Returns the
     * projection, for labels.
     */
    /** New positions for stars from `first` on (the bodies that move: the planets and the Moon). */
    movePositions(first, xyz) {
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, first * 12, xyz);
    },
    /**
     * Lines that change, relative to the eye: named groups, each replaced
     * whenever it is given; null data for none.
     */
    /** A body's surface map, by key, from an image: drawn on its sphere once loaded. */
    setMap(key, image) {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      maps.set(key, tex);
    },

    /**
     * A body's slopes, by key: the levels relief.js halves them into, each
     * { data, w, h } with two floats a cell, largest first. Half floats are
     * enough for a slope and, unlike full ones, every WebGL2 filters them;
     * the smaller levels come from relief.js, since a half-float texture
     * cannot be asked to make its own everywhere.
     */
    setRelief(key, levels) {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      levels.forEach((l, k) => gl.texImage2D(gl.TEXTURE_2D, k, gl.RG16F, l.w, l.h, 0, gl.RG, gl.FLOAT, l.data));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      reliefs.set(key, tex);
    },

    setLiveLines(data, ink, name = 'system') {
      if (!data || !data.length) { delete live[name]; return; }
      if (!liveBufs[name]) {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        liveBufs[name] = { vao, buf, bytes: 0 };
      }
      // The same buffer is written over while the lines fit in it: a new one
      // each time they move would be made and thrown away every frame.
      const held = liveBufs[name];
      gl.bindBuffer(gl.ARRAY_BUFFER, held.buf);
      if (data.byteLength > held.bytes) {
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        held.bytes = data.byteLength;
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      }
      live[name] = { vao: liveBufs[name].vao, count: data.length / 3, ink, live: true };
    },
    /** Lines to draw every frame: [{ data: Float32Array of segment ends, ink: [r, g, b, a], key }]. */
    setLines(groups) {
      lineGroups = groups.map((g) => {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, g.data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        return { vao, count: g.data.length / 3, ink: g.ink, key: g.key };
      });
    },
    /**
     * survey: how much of the SPHEREx sky under this canvas shows, 0 to 1.
     * Where it shows, this canvas is clear, its own band is left out, and
     * the catalogue's stars are dimmed to the same degree: the survey is the
     * picture of them seen from the Sun, the stars in 3-D the picture from
     * anywhere else.
     */
    draw({ eye, R, U, F, fov, limit = 8.5, near = null, ir = false, show = () => true, survey = 0 }) {
      const { w, h, dpr } = fit();
      const fy = 1 / Math.tan((fov * Math.PI) / 360);
      const focal = [fy * (h / w), fy];
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1 - survey);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (skyTex && survey < 0.999) {
        gl.enable(gl.BLEND);
        // Its light added; the cover the clear left, kept.
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
        gl.useProgram(skyProg.program);
        gl.uniform3fv(skyProg.u.R, R);
        gl.uniform3fv(skyProg.u.U, U);
        gl.uniform3fv(skyProg.u.F, F);
        gl.uniform2fv(skyProg.u.Focal, focal);
        gl.uniform2f(skyProg.u.Size, w, h);
        // The band behind, quieter than the stars in front of it.
        gl.uniform1f(skyProg.u.Dim, 0.45 * (1 - survey));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, skyTex);
        gl.uniform1i(skyProg.u.Sky, 0);
        gl.bindVertexArray(emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(starProg.program);
      gl.uniform1i(starProg.u.Stored, Math.min(stored, 2147483647));
      gl.uniform1f(starProg.u.StarGain, 1 - survey);
      gl.uniform3fv(starProg.u.Eye, eye);
      gl.uniform3fv(starProg.u.R, R);
      gl.uniform3fv(starProg.u.U, U);
      gl.uniform3fv(starProg.u.F, F);
      gl.uniform2fv(starProg.u.Focal, focal);
      gl.uniform1f(starProg.u.Limit, limit);
      gl.uniform1i(starProg.u.IR, ir ? 1 : 0);
      gl.uniform1f(starProg.u.Px, dpr);
      gl.uniform1f(starProg.u.FocalPx, (fy * h) / 2);
      gl.uniform1f(starProg.u.MaxPoint, maxPoint);
      const nears = (Array.isArray(near) ? near : near ? [near] : []).slice(0, 12);
      // The spheres are drawn exactly; their points are left out of the star pass.
      // A body drawn as a sphere is left out of the point pass: its point,
      // placed in single precision, would sit beside it. Its glow is the
      // sphere pass's, sized in pixels, so a star approached grows into its
      // disc rather than shrinking from a bright point into a small ball.
      const skip = new Int32Array(12).fill(-1);
      nears.forEach((n, k) => { skip[k] = n.index; });
      gl.uniform1iv(starProg.u['Skip[0]'], skip);
      const front = nears[0];
      gl.uniform4fv(starProg.u.Near, front
        ? [front.pos[0] - eye[0], front.pos[1] - eye[1], front.pos[2] - eye[2], front.rpc]
        : [0, 0, 0, 0]);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.POINTS, 0, count);
      if (lineGroups.length || Object.keys(live).length) {
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.useProgram(lineProg.program);
        gl.uniform3fv(lineProg.u.Eye, eye);
        gl.uniform3fv(lineProg.u.R, R);
        gl.uniform3fv(lineProg.u.U, U);
        gl.uniform3fv(lineProg.u.F, F);
        gl.uniform2fv(lineProg.u.Focal, focal);
        for (const g of [...lineGroups, ...Object.values(live)]) {
          if (!g.live && !show(g.key)) continue;
          // The changing lines come relative to the eye already, worked out in
          // double precision: a system's orbits are hundred-millionths of a
          // parsec across, finer than single precision holds at its distance.
          gl.uniform3fv(lineProg.u.Eye, g.live ? [0, 0, 0] : eye);
          gl.uniform4fv(lineProg.u.Ink, g.ink);
          gl.bindVertexArray(g.vao);
          gl.drawArrays(gl.LINES, 0, g.count);
        }
      }
      if (nears.length) {
        gl.useProgram(nearProg.program);
        gl.uniform3fv(nearProg.u.R, R);
        gl.uniform3fv(nearProg.u.U, U);
        gl.uniform3fv(nearProg.u.F, F);
        gl.uniform2fv(nearProg.u.Focal, focal);
        gl.uniform2f(nearProg.u.Size, w, h);
        const sunFrom = (n) => {
          // The star that lights it: the Sun, unless it says otherwise.
          const l = n.light ?? [0, 0, 0];
          return [l[0] - eye[0], l[1] - eye[1], l[2] - eye[2]];
        };
        // A disc covers what is behind it; a star's glow adds to it.
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(emptyVao);
        // The farther first, so the nearer is drawn over it.
        const order = [...nears].sort((a, b) => Math.hypot(b.pos[0] - eye[0], b.pos[1] - eye[1], b.pos[2] - eye[2])
          - Math.hypot(a.pos[0] - eye[0], a.pos[1] - eye[1], a.pos[2] - eye[2]));
        for (const n of order) {
          gl.uniform3fv(nearProg.u.Centre, [n.pos[0] - eye[0], n.pos[1] - eye[1], n.pos[2] - eye[2]]);
          gl.uniform1f(nearProg.u.Radius, n.rpc);
          gl.uniform3fv(nearProg.u.Col, n.col);
          gl.uniform1i(nearProg.u.Lit, n.lit ? 1 : 0);
          gl.uniform4fv(nearProg.u.Ring, n.ring ?? [0, 0, 0, 0]);
          gl.uniform3fv(nearProg.u.Pole, n.pole ?? [0, 0, 1]);
          const map = n.map && maps.get(n.map);
          gl.uniform1i(nearProg.u.HasMap, map && n.axes ? 1 : 0);
          gl.uniform3fv(nearProg.u.Air, n.air ?? [0, 0, 0]);
          if (map && n.axes) {
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, map);
            gl.uniform1i(nearProg.u.Map, 3);
            gl.uniform3fv(nearProg.u.BX, n.axes.x);
            gl.uniform3fv(nearProg.u.BY, n.axes.y);
            gl.uniform3fv(nearProg.u.BZ, n.axes.z);
          }
          const relief = map && n.axes && n.relief > 0 && reliefs.get(n.map);
          gl.uniform1i(nearProg.u.HasRelief, relief ? 1 : 0);
          if (relief) {
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_2D, relief);
            gl.uniform1i(nearProg.u.Relief, 4);
            gl.uniform1f(nearProg.u.ReliefScale, n.relief);
          }
          gl.uniform3fv(nearProg.u.Sun, sunFrom(n));
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        gl.blendFunc(gl.ONE, gl.ONE);
      }
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
  // In front of the eye at all: a body beside the camera is millionths of a
  // parsec away, so no fixed distance can be the threshold.
  if (z <= 1e-3 * Math.hypot(...rel)) return null;
  const x = (rel[0] * R[0] + rel[1] * R[1] + rel[2] * R[2]) / z * focal[0];
  const y = (rel[0] * U[0] + rel[1] * U[1] + rel[2] * U[2]) / z * focal[1];
  if (Math.abs(x) > 1.2 || Math.abs(y) > 1.2) return null;
  return { x: ((x + 1) / 2) * w / dpr, y: ((1 - y) / 2) * h / dpr };
}

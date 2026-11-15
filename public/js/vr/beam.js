/**
 * beam.js — a line that stands out against the sky: a pointer's ray and a
 * mark's beam in the depth view.
 *
 * A thin quad turned to the eye, drawn in one pass: a bright core, a soft
 * glow sleeve in the line's colour, and a faint dark rim outside both, so it
 * reads against the Milky Way and a bright field as well as against black.
 * It fades along its length (`near` → `far`), and a pulse can run along it
 * toward its end, so the direction reads at a glance. Its width is a few
 * millimetres plus a constant angle, so it holds its weight at any distance.
 * Premultiplied blending: the light adds, the rim darkens. Four vertices each.
 */
import * as THREE from '../vendor/three.module.js';

const VERTEX = /* glsl */ `
  attribute float t;
  attribute float side;
  uniform vec3 a;
  uniform vec3 b;
  uniform float widthM;
  uniform float widthAng;
  varying float vT;
  varying float vSide;
  void main() {
    vec4 pa = modelViewMatrix * vec4(a, 1.0);
    vec4 pb = modelViewMatrix * vec4(b, 1.0);
    vec4 p = mix(pa, pb, t);
    vec3 along = pb.xyz - pa.xyz;
    vec3 across = cross(normalize(along + vec3(1e-6)), normalize(-p.xyz + vec3(0.0, 0.0, 1e-6)));
    float hw = widthM + widthAng * length(p.xyz);
    p.xyz += normalize(across + vec3(1e-6, 0.0, 0.0)) * side * hw;
    vT = t;
    vSide = side;
    gl_Position = projectionMatrix * p;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 tint;
  uniform float k;
  uniform float near;
  uniform float far;
  uniform float pulse;
  uniform float time;
  uniform float rim;
  varying float vT;
  varying float vSide;
  void main() {
    float s = abs(vSide);
    float fade = mix(near, far, vT);
    // A pulse a tenth of the length long, running toward the end twice in three seconds.
    float ph = fract(vT * 1.6 - time * 0.55);
    float wave = pulse * smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.08, 0.22, ph));
    float core = 1.0 - smoothstep(0.1, 0.35, s);
    float glow = exp(-s * s * 4.0);
    float ring = smoothstep(0.62, 0.8, s) * (1.0 - smoothstep(0.88, 1.0, s));
    float lit = (glow * 0.55 + core) * fade * k * (1.0 + 1.6 * wave);
    vec3 light = tint * glow * 0.9 + vec3(1.0) * core * 0.75;
    float dark = ring * rim * fade;
    gl_FragColor = vec4(light * lit, clamp(lit * 0.35 + dark, 0.0, 1.0));
  }
`;

/** A beam's quad: t along, side across (its own, so disposing one leaves the rest). */
function quadGeometry() {
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  quad.setAttribute('t', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 1]), 1));
  quad.setAttribute('side', new THREE.BufferAttribute(new Float32Array([-1, 1, -1, 1]), 1));
  quad.setIndex([0, 2, 1, 1, 2, 3]);
  return quad;
}

/**
 * A beam from `a` to `b` (in its parent's space). `widthM` and `widthAng`
 * (radians, half-widths) set its weight; `near` and `far` its brightness at
 * each end; `pulse` a travelling pulse; `rim` the dark rim's strength.
 */
export function createBeam({ color, k = 1, widthM = 0.002, widthAng = 0.0015, near = 1, far = 0.35, pulse = 0, rim = 0.5, renderOrder = 9 } = {}) {
  const uniforms = {
    a: { value: new THREE.Vector3() }, b: { value: new THREE.Vector3(0, 0, -1) },
    tint: { value: new THREE.Color(color) }, k: { value: k }, near: { value: near }, far: { value: far },
    widthM: { value: widthM }, widthAng: { value: widthAng }, pulse: { value: pulse }, time: { value: 0 }, rim: { value: rim },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT,
    transparent: true, depthWrite: false, premultipliedAlpha: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(quadGeometry(), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  return {
    mesh,
    uniforms,
    /** The ends, as arrays or vectors. */
    set(from, to) {
      uniforms.a.value.set(...(from.isVector3 ? from.toArray() : from));
      uniforms.b.value.set(...(to.isVector3 ? to.toArray() : to));
    },
    /** The pulse's clock, in seconds. */
    tick(sec) { uniforms.time.value = sec; },
    dispose() { material.dispose(); mesh.geometry.dispose(); mesh.removeFromParent(); },
  };
}

const RIBBON_VERTEX = /* glsl */ `
  attribute float t;
  attribute float side;
  attribute vec3 toward;
  uniform float widthM;
  uniform float widthAng;
  varying float vT;
  varying float vSide;
  void main() {
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    vec4 q = modelViewMatrix * vec4(toward, 1.0);
    vec3 across = cross(normalize(q.xyz - p.xyz + vec3(1e-6)), normalize(-p.xyz + vec3(0.0, 0.0, 1e-6)));
    float hw = widthM + widthAng * length(p.xyz);
    p.xyz += normalize(across + vec3(1e-6, 0.0, 0.0)) * side * hw;
    vT = t;
    vSide = side;
    gl_Position = projectionMatrix * p;
  }
`;

/**
 * The same look along a path through `points` (arrays, in its parent's
 * space): one strip of quads turned to the eye, its pulse running from the
 * first point to the last, the way the thing moves.
 */
export function createRibbon(points, { color, k = 1.2, widthM = 0, widthAng = 0.011, near = 0.75, far = 1, pulse = 1, rim = 0.55, renderOrder = 9 } = {}) {
  const n = points.length;
  const pos = new Float32Array(n * 2 * 3);
  const toward = new Float32Array(n * 2 * 3);
  const t = new Float32Array(n * 2);
  const side = new Float32Array(n * 2);
  const len = [0];
  for (let i = 1; i < n; i++) len.push(len[i - 1] + Math.hypot(...points[i].map((v, j) => v - points[i - 1][j])));
  const total = len[n - 1] || 1;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    // The way on at this point: toward the next one (or on from the last).
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    const ahead = [p[0] + (b[0] - a[0]), p[1] + (b[1] - a[1]), p[2] + (b[2] - a[2])];
    for (let s = 0; s < 2; s++) {
      const v = i * 2 + s;
      pos.set(p, v * 3);
      toward.set(ahead, v * 3);
      t[v] = len[i] / total;
      side[v] = s ? 1 : -1;
    }
  }
  const index = [];
  for (let i = 0; i < n - 1; i++) {
    const v = i * 2;
    index.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('toward', new THREE.BufferAttribute(toward, 3));
  geometry.setAttribute('t', new THREE.BufferAttribute(t, 1));
  geometry.setAttribute('side', new THREE.BufferAttribute(side, 1));
  geometry.setIndex(index);
  const uniforms = {
    tint: { value: new THREE.Color(color) }, k: { value: k }, near: { value: near }, far: { value: far },
    widthM: { value: widthM }, widthAng: { value: widthAng }, pulse: { value: pulse }, time: { value: 0 }, rim: { value: rim },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: RIBBON_VERTEX, fragmentShader: FRAGMENT,
    transparent: true, depthWrite: false, premultipliedAlpha: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  return {
    mesh,
    uniforms,
    tick(sec) { uniforms.time.value = sec; },
    dispose() { material.dispose(); geometry.dispose(); mesh.removeFromParent(); },
  };
}

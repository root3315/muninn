/**
 * gate-band.js — the front page's Milky Way, drawn by the GPU.
 *
 * The band is a picture in sky coordinates (right ascension across,
 * declination down), and every frame each screen pixel has to find its place
 * in it. Done on the CPU that is tens of thousands of rays a frame, every
 * frame the sky turns, and with the surveyed band it was enough to make the
 * page stutter on a phone. Here the same ray is cast per pixel in a fragment
 * shader, on a WebGL canvas laid under the gate's own; the stars, markers and
 * names stay where they were, on the canvas above.
 *
 * The camera is the gate's: the same forward, right and up axes and the same
 * focal length, so the band and the stars cannot part.
 */

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform vec3 uF;
uniform vec3 uR;
uniform vec3 uU;
uniform float uFocal;
uniform vec2 uCentre;
uniform vec3 uWell;
uniform float uMix;
uniform sampler2D uModel;
uniform sampler2D uSurvey;
out vec4 outColour;
const float PI = 3.141592653589793;
void main() {
  // The gate's ray: right is +a toward the left of the screen, up is +b.
  float a = (uCentre.x - gl_FragCoord.x) / uFocal;
  float b = (gl_FragCoord.y - uCentre.y) / uFocal;
  vec3 v = normalize(uF + a * uR + b * uU);
  vec2 uv = vec2(fract(atan(v.y, v.x) / (2.0 * PI) + 1.0), 0.5 - asin(clamp(v.z, -1.0, 1.0)) / PI);
  vec3 model = textureLod(uModel, uv, 0.0).rgb;
  vec3 survey = textureLod(uSurvey, uv, 0.0).rgb;
  // Added onto the night, as the gate's canvas added it.
  outColour = vec4(min(uWell + mix(model, survey, uMix), vec3(1.0)), 1.0);
}`;

function compile(gl) {
  const program = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
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

/**
 * A band layer under `canvas`, or null where WebGL 2 cannot be had (the gate
 * then draws the band itself, as before).
 */
export function createBandLayer(canvas) {
  const layer = document.createElement('canvas');
  layer.className = `${canvas.className} gate__band`;
  layer.setAttribute('aria-hidden', 'true');
  const gl = layer.getContext('webgl2', { alpha: false, antialias: false, depth: false });
  if (!gl) return null;
  let program;
  try {
    program = compile(gl);
  } catch {
    return null;
  }
  canvas.before(layer);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  const at = (name) => gl.getUniformLocation(program, name);
  const u = {
    F: at('uF'), R: at('uR'), U: at('uU'), focal: at('uFocal'), centre: at('uCentre'),
    well: at('uWell'), mix: at('uMix'), model: at('uModel'), survey: at('uSurvey'),
  };
  const vao = gl.createVertexArray();

  function texture(unit) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Black until a picture comes: the band adds nothing.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Across, the sky wraps at right ascension 0; down, it stops at the poles.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  const textures = { model: texture(0), survey: texture(1) };

  function upload(which, source) {
    gl.activeTexture(gl.TEXTURE0 + (which === 'model' ? 0 : 1));
    gl.bindTexture(gl.TEXTURE_2D, textures[which]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  return {
    /** The modelled band, a canvas in the gate's band layout. */
    setModel(source) { upload('model', source); },
    /** The surveyed band, an image in the same layout. */
    setSurvey(source) { upload('survey', source); },
    /**
     * Draw for the gate's camera. `basis` is its { f, r, u }; `width` and
     * `height` its canvas in device pixels; `well` the night as [r, g, b] in
     * 0–1; `mix` how far the survey has come in over the model.
     */
    draw({ basis, focal, width, height, well, mix }) {
      if (layer.width !== width || layer.height !== height) {
        layer.width = width;
        layer.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.uniform3fv(u.F, basis.f);
      gl.uniform3fv(u.R, basis.r);
      gl.uniform3fv(u.U, basis.u);
      gl.uniform1f(u.focal, focal);
      gl.uniform2f(u.centre, width / 2, height / 2);
      gl.uniform3fv(u.well, well);
      gl.uniform1f(u.mix, mix);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textures.model);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, textures.survey);
      gl.uniform1i(u.model, 0);
      gl.uniform1i(u.survey, 1);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

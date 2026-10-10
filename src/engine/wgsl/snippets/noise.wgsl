// 2D simplex noise (Ashima Arts / McEwan-style port), fbm, and the curl of
// the fbm field, shared by core.noise (see sources/builtin/noise.ts).
// Deterministic: the same (position, octaves, lacunarity, gain) always
// produces the same value, so a seed is implemented as a fixed per-seed
// domain offset (noise_seed_offset) rather than reseeding any hash state.
// Distinct seeds sample uncorrelated regions of the same continuous field.

fn blendgen_mod289_3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn blendgen_mod289_2(x: vec2f) -> vec2f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn blendgen_permute3(x: vec3f) -> vec3f { return blendgen_mod289_3(((x * 34.0) + 1.0) * x); }

fn simplex2d(v: vec2f) -> f32 {
  let c = vec4f(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  var i = floor(v + dot(v, c.yy));
  let x0 = v - i + dot(i, c.xx);
  var i1: vec2f;
  if (x0.x > x0.y) { i1 = vec2f(1.0, 0.0); } else { i1 = vec2f(0.0, 1.0); }
  var x12 = x0.xyxy + c.xxzz;
  x12 = vec4f(x12.xy - i1, x12.zw);
  i = blendgen_mod289_2(i);
  let p = blendgen_permute3(blendgen_permute3(i.y + vec3f(0.0, i1.y, 1.0)) + i.x + vec3f(0.0, i1.x, 1.0));
  var m = max(0.5 - vec3f(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3f(0.0));
  m = m * m;
  m = m * m;
  let x = 2.0 * fract(p * c.www) - 1.0;
  let h = abs(x) - 0.5;
  let ox = floor(x + 0.5);
  let a0 = x - ox;
  m = m * (1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h));
  let g = vec3f(
    a0.x * x0.x + h.x * x0.y,
    a0.y * x12.x + h.y * x12.y,
    a0.z * x12.z + h.z * x12.w,
  );
  return 130.0 * dot(m, g);
}

// hash21 (wgsl/snippets/common.wgsl) gives a seed a fixed, well-spread
// domain offset, cheap and deterministic without touching the noise math.
fn noise_seed_offset(seed: f32) -> vec2f {
  return vec2f(hash21(vec2f(seed, 0.0)), hash21(vec2f(0.0, seed))) * 1000.0;
}

fn fbm(p: vec2f, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  for (var i = 0; i < octaves; i = i + 1) {
    sum = sum + amp * simplex2d(p * freq);
    freq = freq * lacunarity;
    amp = amp * gain;
  }
  return sum;
}

// Curl of the fbm scalar field: rotate its numerical gradient 90 degrees,
// giving a divergence-free (incompressible-flow-like) vector field, the
// classic curl-noise look.
fn curl_fbm(p: vec2f, octaves: i32, lacunarity: f32, gain: f32) -> vec2f {
  let eps = 0.01;
  let dx = (fbm(p + vec2f(eps, 0.0), octaves, lacunarity, gain) - fbm(p - vec2f(eps, 0.0), octaves, lacunarity, gain)) / (2.0 * eps);
  let dy = (fbm(p + vec2f(0.0, eps), octaves, lacunarity, gain) - fbm(p - vec2f(0.0, eps), octaves, lacunarity, gain)) / (2.0 * eps);
  return vec2f(dy, -dx);
}

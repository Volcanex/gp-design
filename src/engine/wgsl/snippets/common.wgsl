// Small shared helpers used by other snippets and builtin passes.

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Sign-preserving cube root: WGSL's pow() is undefined for negative bases,
// but OKLab's l/m/s intermediates can go slightly negative for out-of-gamut
// colors.
fn cbrt(x: f32) -> f32 {
  return sign(x) * pow(abs(x), 1.0 / 3.0);
}

// OKLab a/b components stay roughly within this range for in-gamut colors;
// shared by quantise and dither so both normalise/denormalise consistently.
const AB_RANGE: f32 = 0.4;

fn quantise_channel(x: f32, n: f32) -> f32 {
  return floor(x * n) / n;
}

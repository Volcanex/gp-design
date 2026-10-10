// Interleaved gradient noise (Jimenez 2014) with a golden-ratio per-frame
// offset so the dither pattern decorrelates across frames instead of
// sticking to the screen.

fn ign(px: vec2f, frame: u32) -> f32 {
  let base = fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715))));
  let golden_ratio = 0.61803398875;
  return fract(base + golden_ratio * f32(frame % 4096u));
}

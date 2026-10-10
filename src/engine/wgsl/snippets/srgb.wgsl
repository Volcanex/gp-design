// sRGB transfer curve, per-channel. Used to decode/encode 8-bit display
// values at the boundary (image sources in, present/export out), never
// applied to the OKLab working buffers themselves.

fn srgb_encode_channel(c: f32) -> f32 {
  let cc = clamp(c, 0.0, 1.0);
  if (cc <= 0.0031308) {
    return cc * 12.92;
  }
  return 1.055 * pow(cc, 1.0 / 2.4) - 0.055;
}

fn srgb_decode_channel(c: f32) -> f32 {
  let cc = clamp(c, 0.0, 1.0);
  if (cc <= 0.04045) {
    return cc / 12.92;
  }
  return pow((cc + 0.055) / 1.055, 2.4);
}

fn srgb_encode(c: vec3f) -> vec3f {
  return vec3f(srgb_encode_channel(c.x), srgb_encode_channel(c.y), srgb_encode_channel(c.z));
}

fn srgb_decode(c: vec3f) -> vec3f {
  return vec3f(srgb_decode_channel(c.x), srgb_decode_channel(c.y), srgb_decode_channel(c.z));
}

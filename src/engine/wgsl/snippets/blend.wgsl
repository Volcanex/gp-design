// Porter-Duff "src over base" for straight (non-premultiplied) alpha
// buffers holding OKLab. The formula is colorspace-agnostic (a per-channel
// alpha-weighted average is valid in any linearly-blendable space,
// including OKLab): it's the same math as the classic RGB version.

fn porter_duff_over(base: vec4f, src: vec4f) -> vec4f {
  let out_a = src.a + base.a * (1.0 - src.a);
  let premultiplied = src.rgb * src.a + base.rgb * base.a * (1.0 - src.a);
  let out_rgb = select(vec3f(0.0), premultiplied / max(out_a, 1e-6), out_a > 1e-6);
  return vec4f(out_rgb, out_a);
}

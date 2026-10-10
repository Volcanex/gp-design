import type { PassDescriptor } from '../pass';

/**
 * Packed-2D 3D LUT: an `asset`-kind 'lut' param becomes a second texture
 * binding (input1/samp1, per bindings.ts's assetInputsOf/layoutFor), resolved
 * to a bound rgba8unorm texture by core/frame.ts's runPass via
 * core/asset-textures.ts. Layout is standard Hald-style tiling (N*N-wide,
 * N-tall, x = b_slice * n + r, y = g), built by lutBytes() in
 * lut-bytes.ts (shared with tests and the future UI).
 *
 * Sampling is manual (textureLoad, not textureSample) so it can do its own
 * trilinear interpolation across the tiled slices; the identity/inverted
 * shape isn't something a hardware sampler's 2D bilinear filtering can do
 * correctly across tile boundaries.
 */
export const lut: PassDescriptor = {
  id: 'core.lut',
  label: 'LUT',
  kind: 'render',
  wgsl: `
fn sample_lut(rgb: vec3f) -> vec3f {
  let dims = textureDimensions(input1);
  let n = i32(dims.y);
  let nf = f32(n);
  let r = clamp(rgb.x, 0.0, 1.0) * (nf - 1.0);
  let g = clamp(rgb.y, 0.0, 1.0) * (nf - 1.0);
  let b = clamp(rgb.z, 0.0, 1.0) * (nf - 1.0);
  let r0 = i32(floor(r)); let r1 = min(r0 + 1, n - 1); let rf = fract(r);
  let g0 = i32(floor(g)); let g1 = min(g0 + 1, n - 1); let gf = fract(g);
  let b0 = i32(floor(b)); let b1 = min(b0 + 1, n - 1); let bf = fract(b);
  // tile layout: x = slice * n + r, y = g
  let c000 = textureLoad(input1, vec2i(b0 * n + r0, g0), 0).rgb;
  let c100 = textureLoad(input1, vec2i(b0 * n + r1, g0), 0).rgb;
  let c010 = textureLoad(input1, vec2i(b0 * n + r0, g1), 0).rgb;
  let c110 = textureLoad(input1, vec2i(b0 * n + r1, g1), 0).rgb;
  let c001 = textureLoad(input1, vec2i(b1 * n + r0, g0), 0).rgb;
  let c101 = textureLoad(input1, vec2i(b1 * n + r1, g0), 0).rgb;
  let c011 = textureLoad(input1, vec2i(b1 * n + r0, g1), 0).rgb;
  let c111 = textureLoad(input1, vec2i(b1 * n + r1, g1), 0).rgb;
  let c0 = mix(mix(c000, c100, rf), mix(c010, c110, rf), gf);
  let c1 = mix(mix(c001, c101, rf), mix(c011, c111, rf), gf);
  return mix(c0, c1, bf);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let rgb = oklab_to_linear_srgb(src.rgb);
  let looked = sample_lut(rgb);
  let outRgb = mix(rgb, looked, params.amount);
  return vec4f(linear_srgb_to_oklab(clamp(outRgb, vec3f(0.0), vec3f(1.0))), src.a);
}
`,
  includes: ['oklab'],
  inputs: [{ name: 'input0' }],
  params: {
    asset: { kind: 'asset', assetType: 'lut', label: 'LUT' },
    amount: { kind: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Amount' },
  },
  metadata: { category: 'core', menuPath: 'Effects/LUT', description: 'Packed-2D 3D LUT look, mixed by amount.' },
};

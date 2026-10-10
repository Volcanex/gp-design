import type { PassDescriptor } from '../pass';

/**
 * 3x3 Sobel on L: 8 taps at texel offsets around (not on) the centre pixel,
 * texel size derived from the engine resolution uniform.
 */
export const edgeDetect: PassDescriptor = {
  id: 'core.edge-detect',
  label: 'Edge Detect',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let texel = vec2f(1.0 / engine.width, 1.0 / engine.height);

  let tl = textureSample(input0, samp0, in.uv + vec2f(-texel.x, -texel.y)).x;
  let tm = textureSample(input0, samp0, in.uv + vec2f(0.0, -texel.y)).x;
  let tr = textureSample(input0, samp0, in.uv + vec2f(texel.x, -texel.y)).x;
  let ml = textureSample(input0, samp0, in.uv + vec2f(-texel.x, 0.0)).x;
  let mr = textureSample(input0, samp0, in.uv + vec2f(texel.x, 0.0)).x;
  let bl = textureSample(input0, samp0, in.uv + vec2f(-texel.x, texel.y)).x;
  let bm = textureSample(input0, samp0, in.uv + vec2f(0.0, texel.y)).x;
  let br = textureSample(input0, samp0, in.uv + vec2f(texel.x, texel.y)).x;

  let gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  let gy = -tl - 2.0 * tm - tr + bl + 2.0 * bm + br;
  var mag = clamp(length(vec2f(gx, gy)) * params.strength, 0.0, 1.0);
  if (params.invert != 0u) {
    mag = 1.0 - mag;
  }

  if (params.mode == 1u) {
    let l = clamp(src.x + mag, 0.0, 1.0);
    return vec4f(l, src.y, src.z, src.a);
  }
  return vec4f(mag, 0.0, 0.0, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    strength: { kind: 'float', default: 1, min: 0, max: 8, animatable: true },
    mode: { kind: 'enum', default: 'edges', options: ['edges', 'overlay'] },
    invert: { kind: 'bool', default: false },
  },
  metadata: { category: 'core', menuPath: 'Effects/Stylize/Edge Detect', description: 'Sobel edge magnitude on L, as a mask or overlaid on the source.' },
};

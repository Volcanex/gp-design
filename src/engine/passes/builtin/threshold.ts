import type { PassDescriptor } from '../pass';

export const threshold: PassDescriptor = {
  id: 'core.threshold',
  label: 'Threshold',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  // Smooth black/white split around params.threshold, softened by
  // params.softness. softness is floored to avoid a zero-width smoothstep
  // (edge0 == edge1 is undefined behaviour).
  let s = max(params.softness, 0.0001);
  var bw = smoothstep(params.threshold - s, params.threshold + s, src.x);
  if (params.invert != 0u) {
    bw = 1.0 - bw;
  }
  return vec4f(bw, 0.0, 0.0, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    threshold: { kind: 'float', default: 0.5, min: 0, max: 1, step: 0.01, animatable: true },
    softness: { kind: 'float', default: 0, min: 0, max: 0.5, step: 0.01, animatable: true },
    invert: { kind: 'bool', default: false },
  },
  metadata: { category: 'core', menuPath: 'Adjustments/Threshold', description: 'Smoothstep black/white split of L around a threshold.' },
};

import type { PassDescriptor } from '../pass';

export const gamma: PassDescriptor = {
  id: 'core.gamma',
  label: 'Gamma',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let l = pow(max(src.x, 0.0), 1.0 / params.gamma);
  return vec4f(l, src.y, src.z, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    gamma: { kind: 'float', default: 1, min: 0.2, max: 5, step: 0.01, animatable: true },
  },
  metadata: { category: 'core', menuPath: 'Adjustments/Gamma', description: 'Power-law remap of L: L = pow(L, 1/gamma).' },
};

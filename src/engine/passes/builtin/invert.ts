import type { PassDescriptor } from '../pass';

export const invert: PassDescriptor = {
  id: 'core.invert',
  label: 'Invert Colors',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  return vec4f(1.0 - src.x, -src.y, -src.z, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {},
  metadata: { category: 'core', menuPath: 'Adjustments/Invert Colors', description: 'Invert L and negate a/b.' },
};

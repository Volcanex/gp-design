import type { PassDescriptor } from '../pass';

export const blit: PassDescriptor = {
  id: 'core.blit',
  label: 'Blit',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return textureSample(input0, samp0, in.uv);
}
`,
  inputs: [{ name: 'input0' }],
  params: {},
  metadata: { category: 'core', description: 'Passthrough copy of input0.' },
};

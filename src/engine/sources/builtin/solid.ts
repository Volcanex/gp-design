import type { PassDescriptor } from '../../passes/pass';
import { sourceFromPass } from '../from-pass';

const solidPass: PassDescriptor = {
  id: 'core.solid',
  label: 'Solid',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return params.color;
}
`,
  inputs: [],
  params: {
    color: { kind: 'color', default: [0.6, 0.1, -0.05, 1], space: 'oklab' },
  },
  metadata: { category: 'core', description: 'Flat solid-color fill.' },
};

export const solid = sourceFromPass(solidPass);

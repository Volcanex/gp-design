import type { PassDescriptor } from '../pass';

export const quantise: PassDescriptor = {
  id: 'core.quantise',
  label: 'Quantise',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let n = f32(params.levels);
  let l = quantise_channel(src.x, n);
  // a/b range roughly +/-AB_RANGE: normalise to 0..1, quantise, denormalise.
  let a_norm = quantise_channel((src.y / AB_RANGE) * 0.5 + 0.5, n);
  let b_norm = quantise_channel((src.z / AB_RANGE) * 0.5 + 0.5, n);
  let a = (a_norm - 0.5) * 2.0 * AB_RANGE;
  let b = (b_norm - 0.5) * 2.0 * AB_RANGE;
  return vec4f(l, a, b, src.a);
}
`,
  includes: ['common'],
  inputs: [{ name: 'input0' }],
  params: {
    levels: { kind: 'int', default: 8, min: 2, max: 256 },
  },
  metadata: { category: 'core', menuPath: 'Effects/Quantise', description: 'Posterise L/a/b to N levels each.' },
};

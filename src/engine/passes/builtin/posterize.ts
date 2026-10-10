import type { PassDescriptor } from '../pass';

export const posterize: PassDescriptor = {
  id: 'core.posterize',
  label: 'Posterize',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let n = f32(params.levels);
  let l = quantise_channel(src.x, n);
  var a = src.y;
  var b = src.z;
  if (params.chromaToo != 0u) {
    let a_norm = quantise_channel((src.y / AB_RANGE) * 0.5 + 0.5, n);
    let b_norm = quantise_channel((src.z / AB_RANGE) * 0.5 + 0.5, n);
    a = (a_norm - 0.5) * 2.0 * AB_RANGE;
    b = (b_norm - 0.5) * 2.0 * AB_RANGE;
  }
  return vec4f(l, a, b, src.a);
}
`,
  includes: ['common'],
  inputs: [{ name: 'input0' }],
  params: {
    levels: { kind: 'int', default: 4, min: 2, max: 64 },
    chromaToo: { kind: 'bool', default: false, label: 'Posterize chroma too' },
  },
  metadata: { category: 'core', menuPath: 'Adjustments/Posterize', description: 'Quantise L (and optionally a/b) to N levels.' },
};

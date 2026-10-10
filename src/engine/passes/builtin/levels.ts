import type { PassDescriptor } from '../pass';

export const levels: PassDescriptor = {
  id: 'core.levels',
  label: 'Levels',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  // Mirrors look-math.ts's levelsRemap: normalise L into [inBlack, inWhite],
  // apply gamma, then remap into [outBlack, outWhite].
  let range = params.inWhite - params.inBlack;
  var t = 0.0;
  if (range != 0.0) {
    t = clamp((src.x - params.inBlack) / range, 0.0, 1.0);
  }
  let g = pow(t, 1.0 / params.gamma);
  let l = params.outBlack + g * (params.outWhite - params.outBlack);
  return vec4f(l, src.y, src.z, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    inBlack: { kind: 'float', default: 0, min: 0, max: 1, step: 0.01 },
    inWhite: { kind: 'float', default: 1, min: 0, max: 1, step: 0.01 },
    gamma: { kind: 'float', default: 1, min: 0.1, max: 10, step: 0.01 },
    outBlack: { kind: 'float', default: 0, min: 0, max: 1, step: 0.01 },
    outWhite: { kind: 'float', default: 1, min: 0, max: 1, step: 0.01 },
  },
  metadata: { category: 'core', menuPath: 'Adjustments/Levels', description: 'Classic in/out black-white-gamma remap of L.' },
};

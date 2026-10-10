import type { PassDescriptor } from '../pass';

export const duotone: PassDescriptor = {
  id: 'core.duotone',
  label: 'Duotone',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  // Map L through a two-colour gradient in OKLab: t is L re-biased by
  // balance (clamped to [0,1]), then colorA/colorB (both OKLab triples) are
  // mixed by t. amount blends the mapped result back with the original.
  let t = clamp(src.x + params.balance * 0.5, 0.0, 1.0);
  let mapped = mix(params.colorA.xyz, params.colorB.xyz, t);
  let lab = mix(src.xyz, mapped, params.amount);
  return vec4f(lab, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    colorA: { kind: 'color', default: [0.28, 0.02, -0.22, 1], space: 'oklab', animatable: true, label: 'Shadow colour' },
    colorB: { kind: 'color', default: [0.95, 0.015, 0.04, 1], space: 'oklab', animatable: true, label: 'Highlight colour' },
    balance: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01, animatable: true },
    amount: { kind: 'float', default: 1, min: 0, max: 1, step: 0.01, animatable: true },
  },
  metadata: { category: 'core', menuPath: 'Effects/Color/Duotone', description: 'Two-colour OKLab gradient mapped from L, blended by amount.' },
};

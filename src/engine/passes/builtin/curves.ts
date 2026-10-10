import type { PassDescriptor } from '../pass';

export const curves: PassDescriptor = {
  id: 'core.curves',
  label: 'Curves',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  // Parametric stand-in for a curve editor: shadows/midtones/highlights each
  // contribute an additive offset to L, weighted by a smooth partition-of-
  // unity basis centred at L=0/0.5/1 (wShadow + wMid + wHighlight === 1 for
  // every L; wMid is defined as the remainder). Mirrors look-math.ts's
  // curvesRemap exactly.
  let t = clamp(src.x, 0.0, 1.0);
  let wShadow = 1.0 - smoothstep(0.0, 0.5, t);
  let wHighlight = smoothstep(0.5, 1.0, t);
  let wMid = 1.0 - wShadow - wHighlight;
  let offset = (params.shadows * wShadow + params.midtones * wMid + params.highlights * wHighlight) * 0.5;
  let l = clamp(t + offset, 0.0, 1.0);
  return vec4f(l, src.y, src.z, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    shadows: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01 },
    midtones: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01 },
    highlights: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01 },
  },
  metadata: { category: 'core', menuPath: 'Adjustments/Curves', description: 'Three-zone parametric L remap; stand-in until a curve editor exists.' },
};

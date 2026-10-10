import type { PassDescriptor } from '../pass';

export const vibrance: PassDescriptor = {
  id: 'core.vibrance',
  label: 'Vibrance',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  // C = chroma (ab length). Vibrance boosts low-chroma pixels more than
  // already-saturated ones (factor tapers to 1 as C approaches
  // CHROMA_RANGE); saturation is a flat multiplier on top.
  let CHROMA_RANGE = 0.4;
  let c = length(vec2f(src.y, src.z));
  let vibFactor = 1.0 + params.vibrance * clamp(1.0 - c / CHROMA_RANGE, 0.0, 1.0);
  let satFactor = 1.0 + params.saturation;
  let ab = vec2f(src.y, src.z) * vibFactor * satFactor;
  return vec4f(src.x, ab.x, ab.y, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    vibrance: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01, animatable: true },
    saturation: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01, animatable: true },
  },
  metadata: { category: 'core', menuPath: 'Adjustments/Vibrance', description: 'Chroma-aware saturation boost (vibrance) plus a flat saturation term.' },
};

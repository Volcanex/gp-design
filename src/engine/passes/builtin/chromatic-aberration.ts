import type { PassDescriptor } from '../pass';

/**
 * Per-channel radial displacement, so it needs true RGB channels rather
 * than OKLab's L/a/b. Declares metadata.colorSpace: 'rgb' and the chain
 * executor wraps it in core.to-rgb/from-rgb (see convert-rgb.ts).
 */
export const chromaticAberration: PassDescriptor = {
  id: 'core.chromatic-aberration',
  label: 'Chromatic Aberration',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = in.uv - params.center;
  let dist = length(d);
  let dir = select(vec2f(0.0, 0.0), d / max(dist, 0.0001), dist > 0.0001);
  let px = vec2f(1.0 / engine.width, 1.0 / engine.height);
  let offsetUv = dir * (params.amount * pow(dist, params.falloff)) * px;

  let r = textureSample(input0, samp0, in.uv - offsetUv).r;
  let center = textureSample(input0, samp0, in.uv);
  let b = textureSample(input0, samp0, in.uv + offsetUv).b;
  return vec4f(r, center.g, b, center.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    amount: { kind: 'float', default: 4, min: 0, max: 50, unit: 'px', animatable: true },
    center: { kind: 'vec2', default: [0.5, 0.5] },
    falloff: { kind: 'float', default: 1, min: 0, max: 4, animatable: true },
  },
  metadata: {
    category: 'core',
    menuPath: 'Effects/Distort/Chromatic Aberration',
    description: 'Radial per-channel UV offset from center, scaled by amount and distance falloff.',
    colorSpace: 'rgb',
  },
};

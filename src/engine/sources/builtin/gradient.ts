import type { PassDescriptor } from '../../passes/pass';
import { sourceFromPass } from '../from-pass';

/**
 * Two-color gradient (linear or radial) between `fromPt`/`toPt` points in
 * normalized doc-uv space [0,1] (same space as `in.uv`, resolution-
 * independent). Colors are OKLab already (toolState's primary/secondary),
 * so `mix` interpolates straight in OKLab: no srgb round-trip needed.
 * Schema keys are `gradType` (not `type`) and `fromPt`/`toPt` (not `from`/
 * `to`): all four are reserved WGSL words and silently fail shader
 * compilation, rendering black. See repo CLAUDE.md gotchas and
 * tests/unit/registries.test.ts's reserved-word guard, which is what caught
 * `from`/`to` here (the previous name) after they shipped broken.
 */
const gradientPass: PassDescriptor = {
  id: 'core.gradient',
  label: 'Gradient',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let dir = params.toPt - params.fromPt;
  let len2 = dot(dir, dir);
  var t: f32 = 0.0;
  if (params.gradType == 1u) {
    let maxDist = max(length(dir), 0.0001);
    t = clamp(length(in.uv - params.fromPt) / maxDist, 0.0, 1.0);
  } else if (len2 > 0.0000001) {
    t = clamp(dot(in.uv - params.fromPt, dir) / len2, 0.0, 1.0);
  }
  return mix(params.colorA, params.colorB, t);
}
`,
  inputs: [],
  params: {
    fromPt: { kind: 'vec2', default: [0.2, 0.5] },
    toPt: { kind: 'vec2', default: [0.8, 0.5] },
    colorA: { kind: 'color', default: [0.6, 0.1, -0.05, 1], space: 'oklab' },
    colorB: { kind: 'color', default: [1, 0, 0, 1], space: 'oklab' },
    gradType: { kind: 'enum', default: 'linear', options: ['linear', 'radial'], label: 'Type' },
  },
  metadata: { category: 'core', description: 'Linear or radial gradient between two OKLab colors.' },
};

export const gradient = sourceFromPass(gradientPass);

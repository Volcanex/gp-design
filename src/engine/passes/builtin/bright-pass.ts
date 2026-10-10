import type { PassDescriptor } from '../pass';

/**
 * Hidden sub-pass (no menuPath). Extracts the amount by which L exceeds
 * `threshold` (0 below threshold), keeping chroma (a, b) wherever L is
 * above it so the subsequent blur doesn't discolour the bloom halo; below
 * threshold, chroma is zeroed too (nothing there should contribute once
 * blurred). Alpha passes through unchanged.
 */
export const brightPass: PassDescriptor = {
  id: 'core.bright-pass',
  label: 'Bright Pass (internal)',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let excess = max(src.x - params.threshold, 0.0);
  let keep = select(0.0, 1.0, src.x > params.threshold);
  return vec4f(excess, src.y * keep, src.z * keep, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    threshold: { kind: 'float', default: 0.7, min: 0, max: 1, animatable: true, label: 'Threshold' },
  },
  metadata: { category: 'core' },
};

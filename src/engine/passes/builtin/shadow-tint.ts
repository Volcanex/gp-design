import type { PassDescriptor } from '../pass';

/**
 * Hidden sub-pass (no menuPath). First step of core.drop-shadow's expand:
 * takes the source's alpha as a silhouette mask and recolors it to the
 * shadow's OKLab `color`, scaling alpha by `opacity`. The result is what
 * gets blurred in the next two steps.
 */
export const shadowTint: PassDescriptor = {
  id: 'core.shadow-tint',
  label: 'Shadow Tint (internal)',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  return vec4f(params.color.x, params.color.y, params.color.z, src.a * params.opacity);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    color: { kind: 'color', default: [0, 0, 0, 1], space: 'oklab', label: 'Color' },
    opacity: { kind: 'float', default: 0.6, min: 0, max: 1, animatable: true, label: 'Opacity' },
  },
  metadata: { category: 'core' },
};

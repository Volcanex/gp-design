import type { PassDescriptor } from '../pass';

/**
 * OKLab <-> linear-sRGB passthrough converts. These are the passes the
 * chain executor wraps an effect in when that effect declares
 * `metadata.colorSpace: 'rgb'`. They don't set that flag on themselves
 * (it would just wrap the wrapper).
 */
export const toRgb: PassDescriptor = {
  id: 'core.to-rgb',
  label: 'To RGB (internal)',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  return vec4f(oklab_to_linear_srgb(src.rgb), src.a);
}
`,
  includes: ['oklab'],
  inputs: [{ name: 'input0' }],
  params: {},
  metadata: { category: 'core', description: 'OKLab -> linear sRGB.' },
};

export const fromRgb: PassDescriptor = {
  id: 'core.from-rgb',
  label: 'From RGB (internal)',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  return vec4f(linear_srgb_to_oklab(src.rgb), src.a);
}
`,
  includes: ['oklab'],
  inputs: [{ name: 'input0' }],
  params: {},
  metadata: { category: 'core', description: 'Linear sRGB -> OKLab.' },
};

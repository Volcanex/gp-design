import type { PassDescriptor } from '../pass';

export const hsl: PassDescriptor = {
  id: 'core.hsl',
  label: 'Hue / Saturation',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let lch = oklab_to_oklch(src.rgb);
  let h = lch.z + radians(params.hue);
  let c = max(lch.y * (1.0 + params.saturation), 0.0);
  let l = clamp(lch.x + params.lightness, 0.0, 1.0);
  let lab = oklch_to_oklab(vec3f(l, c, h));
  return vec4f(lab, src.a);
}
`,
  includes: ['oklab'],
  inputs: [{ name: 'input0' }],
  params: {
    hue: { kind: 'float', default: 0, min: -180, max: 180, unit: 'deg' },
    saturation: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01 },
    lightness: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01 },
  },
  metadata: { category: 'core', menuPath: 'Adjustments/Hue / Saturation', description: 'Rotate hue, scale chroma, offset lightness in OKLCH.' },
};

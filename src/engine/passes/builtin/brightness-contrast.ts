import type { PassDescriptor } from '../pass';

export const brightnessContrast: PassDescriptor = {
  id: 'core.brightness-contrast',
  label: 'Brightness / Contrast',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let bright = src.x + params.brightness;
  // Contrast pivots at mid-grey (L=0.5): factor 0 at contrast=-1 (flattens
  // to grey), factor 2 at contrast=1 (doubles deviation from the pivot).
  let l = clamp((bright - 0.5) * (1.0 + params.contrast) + 0.5, 0.0, 1.0);
  return vec4f(l, src.y, src.z, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    brightness: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01 },
    contrast: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01 },
  },
  metadata: { category: 'core', menuPath: 'Adjustments/Brightness / Contrast', description: 'Additive brightness then contrast pivoted at L=0.5.' },
};

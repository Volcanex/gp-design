import type { PassDescriptor } from '../pass';

export const temperature: PassDescriptor = {
  id: 'core.temperature',
  label: 'Temperature & Tint',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  // Shift b (warm/cool) and a (green/magenta) scaled by L so blacks are
  // protected (no shift at L=0, full shift at L=1). SHIFT_SCALE bounds the
  // max excursion well within AB_RANGE (0.4) at temperature/tint = +-1.
  let SHIFT_SCALE = 0.2;
  let b = src.z + params.temperature * SHIFT_SCALE * src.x;
  let a = src.y + params.tint * SHIFT_SCALE * src.x;
  return vec4f(src.x, a, b, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    temperature: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01, animatable: true },
    tint: { kind: 'float', default: 0, min: -1, max: 1, step: 0.01, animatable: true },
  },
  metadata: { category: 'core', menuPath: 'Adjustments/Temperature & Tint', description: 'Warm/cool (b) and green/magenta (a) shift, scaled by L to protect blacks.' },
};

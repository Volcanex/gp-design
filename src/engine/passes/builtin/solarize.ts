import type { PassDescriptor } from '../pass';

export const solarize: PassDescriptor = {
  id: 'core.solarize',
  label: 'Solarize',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let rgb = src.rgb;
  // Per-channel invert above threshold: select(c, 1-c, c > threshold).
  let sol = select(rgb, vec3f(1.0) - rgb, rgb > vec3f(params.threshold));
  let out = mix(rgb, sol, params.amount);
  return vec4f(out, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    threshold: { kind: 'float', default: 0.5, min: 0, max: 1, step: 0.01, animatable: true },
    amount: { kind: 'float', default: 1, min: 0, max: 1, step: 0.01, animatable: true },
  },
  metadata: {
    category: 'core',
    menuPath: 'Effects/Color/Solarize',
    description: 'Per-channel invert above threshold in RGB space, blended by amount.',
    colorSpace: 'rgb',
  },
};

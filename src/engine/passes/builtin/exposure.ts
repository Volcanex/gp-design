import type { PassDescriptor } from '../pass';

export const exposure: PassDescriptor = {
  id: 'core.exposure',
  label: 'Exposure',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  // Perceptual approximation: scale OKLab L directly by an EV-derived gain
  // rather than round-tripping to linear sRGB for a physically exact
  // exposure multiply. Cheap and good enough for a live preview adjustment.
  let gain = pow(2.0, params.exposure * 0.5);
  return vec4f(src.x * gain, src.y, src.z, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    exposure: {
      kind: 'float', default: 0, min: -4, max: 4, step: 0.01, unit: 'EV', animatable: true,
    },
  },
  metadata: { category: 'core', menuPath: 'Adjustments/Exposure', description: 'Perceptual exposure adjustment in OKLab L.' },
};

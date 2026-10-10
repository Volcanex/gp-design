import type { PassDescriptor } from '../pass';

/**
 * `hardness` reshapes the raw sine (0..1) through a variable power curve:
 * exponent 1 at hardness 0 (soft sinusoid), down toward 0.1 at hardness 1
 * (narrow, hard-edged bands).
 */
export const scanlines: PassDescriptor = {
  id: 'core.scanlines',
  label: 'Scanlines',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let phase = in.uv.y * engine.height * params.frequency + engine.time * params.speed;
  let raw = sin(phase) * 0.5 + 0.5;
  let shaped = pow(raw, mix(1.0, 0.1, params.hardness));
  let l = clamp(src.x - params.intensity * shaped, 0.0, 1.0);
  return vec4f(l, src.y, src.z, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    frequency: { kind: 'float', default: 40, min: 1, max: 500, animatable: true },
    intensity: { kind: 'float', default: 0.5, min: 0, max: 1, animatable: true },
    speed: { kind: 'float', default: 0, min: -20, max: 20, animatable: true },
    hardness: { kind: 'float', default: 0.5, min: 0, max: 1, animatable: true },
  },
  metadata: { category: 'core', menuPath: 'Effects/Stylize/Scanlines', description: 'Time-scrolling sinusoidal scanline darkening of L.' },
};

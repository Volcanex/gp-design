import type { PassDescriptor } from '../pass';

/**
 * Single-pass, fixed 13-tap poisson-disc blur of thresholded L, screen-added
 * onto the original. Deliberately cheap: a real multi-pass gaussian bloom
 * is a separate workstream (see gdesign wave3 brief).
 */
export const glow: PassDescriptor = {
  id: 'core.glow',
  label: 'Glow',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let px = vec2f(1.0 / engine.width, 1.0 / engine.height) * params.radius;

  let offsets = array<vec2f, 13>(
    vec2f(0.0, 0.0),
    vec2f(0.926, -0.378), vec2f(0.152, 0.964), vec2f(-0.929, 0.372),
    vec2f(-0.155, -0.977), vec2f(0.487, 0.702), vec2f(-0.618, 0.578),
    vec2f(0.639, -0.556), vec2f(-0.502, -0.652), vec2f(0.965, 0.235),
    vec2f(-0.960, -0.215), vec2f(0.198, -0.951), vec2f(-0.221, 0.943),
  );

  var bright = 0.0;
  for (var i = 0; i < 13; i = i + 1) {
    let s = textureSample(input0, samp0, in.uv + offsets[i] * px);
    bright = bright + max(s.x - params.threshold, 0.0);
  }
  bright = (bright / 13.0) * params.intensity;

  let screened = src.x + bright - src.x * bright;
  return vec4f(clamp(screened, 0.0, 1.0), src.y, src.z, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    threshold: { kind: 'float', default: 0.7, min: 0, max: 1, animatable: true },
    radius: { kind: 'float', default: 8, min: 0, max: 100, unit: 'px', animatable: true },
    intensity: { kind: 'float', default: 1, min: 0, max: 5, animatable: true },
  },
  metadata: {
    category: 'core',
    menuPath: 'Effects/Blur/Glow',
    description: '13-tap poisson-disc blur of thresholded brights, screen-added onto the source.',
  },
};

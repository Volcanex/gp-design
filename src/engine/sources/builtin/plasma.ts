import type { PassDescriptor } from '../../passes/pass';
import { sourceFromPass } from '../from-pass';

/**
 * Classic sinusoidal plasma field, mixed between two OKLab colors. `speed`
 * multiplies engine.time directly inside the trig field, so a still frame
 * at t=0 and one at t=1 differ whenever speed != 0 (the animated-by-default
 * case per liveByDefault: true from sourceFromPass).
 */
const plasmaPass: PassDescriptor = {
  id: 'core.plasma',
  label: 'Plasma',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let uv = in.uv * params.scale;
  let t = engine.time * params.speed;
  let v = sin(uv.x + t)
        + sin(uv.y * 1.3 - t * 0.7)
        + sin((uv.x + uv.y) * 0.8 + t * 1.1)
        + sin(length(uv - vec2f(params.scale * 0.5)) - t * 1.3);
  let field = v * 0.25 * 0.5 + 0.5;
  let lab = mix(params.hueA, params.hueB, clamp(field, 0.0, 1.0));
  return vec4f(lab.xyz, 1.0);
}
`,
  inputs: [],
  params: {
    scale: { kind: 'float', default: 8, min: 1, max: 64, step: 0.1 },
    speed: { kind: 'float', default: 1, min: 0, max: 8, step: 0.01, animatable: true },
    hueA: { kind: 'color', default: [0.6, 0.15, -0.05, 1], space: 'oklab' },
    hueB: { kind: 'color', default: [0.75, -0.1, 0.15, 1], space: 'oklab' },
  },
  metadata: { category: 'core', description: 'Animated classic plasma field, mixed in OKLab.' },
};

export const plasma = sourceFromPass(plasmaPass);

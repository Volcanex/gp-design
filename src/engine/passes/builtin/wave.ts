import type { PassDescriptor } from '../pass';

/**
 * `mode` enum index order (wave=0, ripple=1) matches gradient.ts's
 * gradType convention: enum params pack to the index of `options`, so the
 * WGSL side just compares against a literal u32.
 */
export const wave: PassDescriptor = {
  id: 'core.wave',
  label: 'Wave',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  var uv = in.uv;
  let t = engine.time * params.speed;
  if (params.mode == 1u) {
    let d = uv - params.center;
    let dist = length(d);
    let dir = select(vec2f(0.0, 0.0), d / max(dist, 0.0001), dist > 0.0001);
    let disp = sin(dist * params.frequency + t);
    uv = uv + dir * disp * vec2f(params.ampX, params.ampY);
  } else {
    uv = uv + vec2f(params.ampX, params.ampY) * sin(uv.yx * params.frequency + t);
  }
  return textureSample(input0, samp0, uv);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    ampX: { kind: 'float', default: 0.02, min: -0.5, max: 0.5, step: 0.001, animatable: true },
    ampY: { kind: 'float', default: 0.02, min: -0.5, max: 0.5, step: 0.001, animatable: true },
    frequency: { kind: 'float', default: 10, min: 0, max: 100, animatable: true },
    speed: { kind: 'float', default: 1, min: -10, max: 10, animatable: true },
    mode: { kind: 'enum', default: 'wave', options: ['wave', 'ripple'] },
    center: { kind: 'vec2', default: [0.5, 0.5] },
  },
  metadata: {
    category: 'core',
    menuPath: 'Effects/Distort/Wave',
    description: 'Sinusoidal UV displacement; plain wave or radial ripple from center.',
  },
};

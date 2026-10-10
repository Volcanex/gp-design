import type { PassDescriptor } from '../../passes/pass';
import { sourceFromPass } from '../from-pass';

/**
 * core.noise: stateless generative field (simplex / fbm / curl, see
 * wgsl/snippets/noise.wgsl), mixed between two OKLab colors, same shape as
 * plasma.ts. `speed` drifts the sampled position diagonally over time
 * (engine.time is 2D-incompatible with simplex2d's signature, so time is
 * folded into the xy offset rather than used as a third noise dimension).
 * `seed` offsets the sampled domain (noise_seed_offset) so distinct seeds
 * land on uncorrelated regions of the same field, not a reseed.
 */
const noisePass: PassDescriptor = {
  id: 'core.noise',
  label: 'Noise',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let seedOffset = noise_seed_offset(params.seed);
  let t = engine.time * params.speed;
  let pos = in.uv * params.scale + seedOffset + vec2f(t * 0.3, t * 0.17);

  var value: f32;
  if (params.mode == 0u) {
    value = simplex2d(pos) * 0.5 + 0.5;
  } else if (params.mode == 1u) {
    value = fbm(pos, 5, 2.0, 0.5) * 0.5 + 0.5;
  } else {
    let c = curl_fbm(pos, 5, 2.0, 0.5);
    value = clamp(length(c) * 1.5, 0.0, 1.0);
  }

  let lab = mix(params.colorA, params.colorB, clamp(value, 0.0, 1.0));
  return vec4f(lab.xyz, 1.0);
}
`,
  includes: ['noise'],
  inputs: [],
  params: {
    mode: { kind: 'enum', default: 'fbm', options: ['simplex', 'fbm', 'curl'] },
    scale: { kind: 'float', default: 4, min: 0.5, max: 32, step: 0.1 },
    speed: { kind: 'float', default: 0.5, min: 0, max: 8, step: 0.01, animatable: true },
    seed: { kind: 'float', default: 0, min: 0, max: 1000, step: 1 },
    colorA: { kind: 'color', default: [0.6, 0.15, -0.05, 1], space: 'oklab' },
    colorB: { kind: 'color', default: [0.2, -0.05, 0.1, 1], space: 'oklab' },
  },
  metadata: { category: 'core', description: 'Generative simplex/fbm/curl-noise field, mixed in OKLab.' },
};

export const noise = sourceFromPass(noisePass);

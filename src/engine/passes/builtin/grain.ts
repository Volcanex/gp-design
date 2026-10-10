import type { PassDescriptor } from '../pass';

/**
 * `size` buckets uv into per-grain-cell pixel coordinates before hashing so
 * grain reads as flat noise blobs, not per-texel static. `animated` keys the
 * hash off `engine.frame` when true; when false the hash never sees the
 * frame counter so the pattern is identical every render regardless of time.
 */
export const grain: PassDescriptor = {
  id: 'core.grain',
  label: 'Film Grain',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let cell = floor(in.uv * vec2f(engine.width, engine.height) / max(params.size, 1.0));
  let frameOffset = select(0.0, f32(engine.frame), params.animated != 0u);
  let nL = hash21(cell + vec2f(frameOffset * 0.6180339887, frameOffset * 0.3141592)) - 0.5;
  let nA = hash21(cell + vec2f(frameOffset * 0.7071067 + 13.1, 7.7)) - 0.5;
  let nB = hash21(cell + vec2f(3.3, frameOffset * 0.4472135 + 91.7)) - 0.5;
  let l = clamp(src.x + nL * params.amount, 0.0, 1.0);
  let a = src.y + nA * params.chroma * AB_RANGE;
  let b = src.z + nB * params.chroma * AB_RANGE;
  return vec4f(l, a, b, src.a);
}
`,
  includes: ['common'],
  inputs: [{ name: 'input0' }],
  params: {
    amount: { kind: 'float', default: 0.15, min: 0, max: 1, animatable: true },
    size: { kind: 'float', default: 4, min: 1, max: 64, animatable: true },
    chroma: { kind: 'float', default: 0, min: 0, max: 1, animatable: true },
    animated: { kind: 'bool', default: true },
  },
  metadata: { category: 'core', menuPath: 'Effects/Noise/Film Grain', description: 'Hash-based per-cell luminance (and optional chroma) grain.' },
};

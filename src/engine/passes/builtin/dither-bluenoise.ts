import type { PassDescriptor } from '../pass';

export const ditherBluenoise: PassDescriptor = {
  id: 'core.dither',
  label: 'Dither (Blue-noise)',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let px = in.uv * vec2f(engine.width, engine.height);
  let noise = (ign(px, engine.frame) - 0.5) * params.amount;
  let n = f32(params.levels);

  let l = quantise_channel(src.x + noise / n, n);
  let a_norm = quantise_channel(((src.y / AB_RANGE) * 0.5 + 0.5) + noise / n, n);
  let b_norm = quantise_channel(((src.z / AB_RANGE) * 0.5 + 0.5) + noise / n, n);
  let a = (a_norm - 0.5) * 2.0 * AB_RANGE;
  let b = (b_norm - 0.5) * 2.0 * AB_RANGE;
  return vec4f(l, a, b, src.a);
}
`,
  includes: ['common', 'bluenoise'],
  inputs: [{ name: 'input0' }],
  params: {
    levels: { kind: 'int', default: 8, min: 2, max: 256 },
    amount: { kind: 'float', default: 1, min: 0, max: 1 },
  },
  metadata: { category: 'core', menuPath: 'Effects/Dither/Blue-noise', description: 'Blue-noise dithered quantisation of L/a/b.' },
};

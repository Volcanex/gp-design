import type { PassDescriptor } from '../pass';

/**
 * Classic 4x4/8x8 Bayer ordered dither. The matrix (const arrays, no texture
 * needed; see gdesign-wt/fx-stylize brief) supplies a per-pixel threshold
 * that plays the same role dither-bluenoise.ts's `ign()` noise does: shift
 * the value before quantise_channel so neighbouring pixels round differently
 * and the banding reads as a stable dither pattern instead of flat bands.
 */
export const ditherOrdered: PassDescriptor = {
  id: 'core.dither-ordered',
  label: 'Ordered (Bayer)',
  kind: 'render',
  wgsl: `
const BAYER4 = array<f32, 16>(
  0.0, 8.0, 2.0, 10.0,
  12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0,
  15.0, 7.0, 13.0, 5.0,
);
const BAYER8 = array<f32, 64>(
  0.0, 32.0, 8.0, 40.0, 2.0, 34.0, 10.0, 42.0,
  48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0, 4.0, 36.0, 14.0, 46.0, 6.0, 38.0,
  60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
  3.0, 35.0, 11.0, 43.0, 1.0, 33.0, 9.0, 41.0,
  51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0, 7.0, 39.0, 13.0, 45.0, 5.0, 37.0,
  63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0,
);

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let px = vec2u(in.uv * vec2f(engine.width, engine.height));
  var bayerVal: f32;
  if (params.matrix == 1u) {
    let x = px.x % 8u;
    let y = px.y % 8u;
    bayerVal = (BAYER8[y * 8u + x] + 0.5) / 64.0;
  } else {
    let x = px.x % 4u;
    let y = px.y % 4u;
    bayerVal = (BAYER4[y * 4u + x] + 0.5) / 16.0;
  }

  let n = f32(params.levels);
  let noise = (bayerVal - 0.5) / n;
  let l = quantise_channel(src.x + noise, n);
  var a = src.y;
  var b = src.z;
  if (params.monoOnly == 0u) {
    let a_norm = quantise_channel(((src.y / AB_RANGE) * 0.5 + 0.5) + noise, n);
    let b_norm = quantise_channel(((src.z / AB_RANGE) * 0.5 + 0.5) + noise, n);
    a = (a_norm - 0.5) * 2.0 * AB_RANGE;
    b = (b_norm - 0.5) * 2.0 * AB_RANGE;
  }
  return vec4f(l, a, b, src.a);
}
`,
  includes: ['common'],
  inputs: [{ name: 'input0' }],
  params: {
    levels: { kind: 'int', default: 4, min: 2, max: 256 },
    matrix: { kind: 'enum', default: '4x4', options: ['4x4', '8x8'] },
    monoOnly: { kind: 'bool', default: false, label: 'Dither L only' },
  },
  metadata: { category: 'core', menuPath: 'Effects/Dither/Ordered (Bayer)', description: 'Bayer-matrix ordered dither of L (and optionally a/b).' },
};

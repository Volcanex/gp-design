import type { PassDescriptor } from '../pass';

/**
 * Classic unsharp mask: an inline 3x3 tent blur (9 taps, no separate pass)
 * subtracted from src and added back scaled by `amount`. `lumaOnly`
 * restricts the boost to L (OKLab's perceptual luma), leaving a/b (chroma)
 * untouched, the usual choice to avoid haloing color fringes.
 */
export const sharpen: PassDescriptor = {
  id: 'core.sharpen',
  label: 'Unsharp Mask',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let texel = vec2f(1.0 / engine.width, 1.0 / engine.height) * params.radius;
  let src = textureSample(input0, samp0, in.uv);

  let offsets = array<vec2f, 9>(
    vec2f(-1.0, -1.0), vec2f(0.0, -1.0), vec2f(1.0, -1.0),
    vec2f(-1.0,  0.0), vec2f(0.0,  0.0), vec2f(1.0,  0.0),
    vec2f(-1.0,  1.0), vec2f(0.0,  1.0), vec2f(1.0,  1.0),
  );
  let weights = array<f32, 9>(1.0, 2.0, 1.0, 2.0, 4.0, 2.0, 1.0, 2.0, 1.0);

  var sum = vec4f(0.0);
  for (var i = 0; i < 9; i = i + 1) {
    sum = sum + textureSample(input0, samp0, in.uv + offsets[i] * texel) * weights[i];
  }
  let blur = sum / 16.0;
  let diff = src - blur;

  if (params.lumaOnly != 0u) {
    return vec4f(src.x + diff.x * params.amount, src.y, src.z, src.a);
  }
  let sharpened = src + diff * params.amount;
  return vec4f(sharpened.x, sharpened.y, sharpened.z, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    amount: { kind: 'float', default: 0.5, min: 0, max: 3, animatable: true },
    radius: { kind: 'float', default: 1, min: 0.5, max: 2, animatable: true },
    lumaOnly: { kind: 'bool', default: true },
  },
  metadata: {
    category: 'core',
    menuPath: 'Effects/Sharpen/Unsharp Mask',
    description: 'Inline 3x3 tent-blur unsharp mask; optionally restricted to L.',
  },
};

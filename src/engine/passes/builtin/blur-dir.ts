import type { PassDescriptor } from '../pass';

/**
 * Hidden sub-pass (no menuPath: never appears in menus, only reached via
 * a macro's `expand`). Separable 1D blur along `dir` (unit-ish vector,
 * e.g. [1,0] or [0,1]; the macro composes both axes for a full 2D blur).
 * Fixed 33-tap kernel (16 either side of centre); `radius` scales tap
 * spacing rather than tap count, so cost stays constant regardless of
 * radius (per CLAUDE.md: cap taps ~33). `boxWeights` switches the same
 * tap layout from a gaussian falloff to flat (box blur) weights, so
 * core.blur-gaussian and core.blur-box can share this one sub-pass.
 * Operates directly on OKLab (L, a, b, alpha) componentwise: no RGB
 * round-trip needed for a spatial blur.
 */
export const blurDir: PassDescriptor = {
  id: 'core.blur-dir',
  label: 'Blur (directional, internal)',
  kind: 'render',
  wgsl: `
const TAPS: i32 = 33;
const HALF: i32 = 16;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let px = vec2f(1.0 / engine.width, 1.0 / engine.height);
  let radius = max(params.radius, 0.0);
  let step = radius / f32(HALF);
  let sigma = max(radius / 3.0, 0.0001);

  var acc = vec4f(0.0);
  var sumW = 0.0;
  for (var i = -HALF; i <= HALF; i = i + 1) {
    let offset = f32(i) * step;
    var w: f32;
    if (params.boxWeights != 0u) {
      w = 1.0;
    } else {
      w = exp(-(offset * offset) / (2.0 * sigma * sigma));
    }
    let uv = in.uv + params.dir * offset * px;
    acc = acc + textureSample(input0, samp0, uv) * w;
    sumW = sumW + w;
  }
  return acc / sumW;
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    dir: { kind: 'vec2', default: [1, 0], label: 'Direction' },
    radius: { kind: 'float', default: 8, min: 0, max: 64, unit: 'px', animatable: true, label: 'Radius' },
    boxWeights: { kind: 'bool', default: false, label: 'Box weights' },
  },
  metadata: { category: 'core' },
};

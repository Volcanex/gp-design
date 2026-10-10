import type { PassDescriptor } from '../pass';

/**
 * Folds the angle around `center` into a `2*pi/segments` wedge, mirroring
 * every other half of the wedge (about its bisector) before resampling.
 * Standard kaleidoscope fold.
 */
export const kaleidoscope: PassDescriptor = {
  id: 'core.kaleidoscope',
  label: 'Kaleidoscope',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = in.uv - params.center;
  let r = length(d);
  let wedge = 6.28318530718 / f32(params.segments);
  var a = atan2(d.y, d.x) - radians(params.rotation);
  a = a - floor(a / wedge) * wedge;
  if (a > wedge * 0.5) {
    a = wedge - a;
  }
  let uv = params.center + vec2f(cos(a), sin(a)) * r;
  return textureSample(input0, samp0, uv);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    segments: { kind: 'int', default: 6, min: 2, max: 24 },
    rotation: { kind: 'float', default: 0, min: -360, max: 360, unit: 'deg', animatable: true },
    center: { kind: 'vec2', default: [0.5, 0.5] },
  },
  metadata: {
    category: 'core',
    menuPath: 'Effects/Distort/Kaleidoscope',
    description: 'Fold the image into a mirrored angular wedge around center.',
  },
};

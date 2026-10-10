import type { PassDescriptor } from '../pass';

export const twirl: PassDescriptor = {
  id: 'core.twirl',
  label: 'Twirl',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = in.uv - params.center;
  let dist = length(d);
  var uv = in.uv;
  if (params.radius > 0.0001 && dist < params.radius) {
    let f = 1.0 - dist / params.radius;
    let ang = params.angle * f * f;
    let s = sin(ang);
    let c = cos(ang);
    let rot = mat2x2f(c, s, -s, c);
    uv = params.center + rot * d;
  }
  return textureSample(input0, samp0, uv);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    angle: { kind: 'float', default: 2.0, min: -12.566, max: 12.566, unit: 'rad', animatable: true },
    radius: { kind: 'float', default: 0.3, min: 0, max: 1, animatable: true },
    center: { kind: 'vec2', default: [0.5, 0.5] },
  },
  metadata: {
    category: 'core',
    menuPath: 'Effects/Distort/Twirl',
    description: 'Rotate UV around center by angle*(1-dist/radius)^2 inside radius.',
  },
};

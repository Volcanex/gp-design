import type { PassDescriptor } from '../pass';

/**
 * Aspect-corrected distance to `center` so the vignette reads circular
 * regardless of canvas aspect ratio; `roundness` blends Chebyshev (square,
 * 0) to Euclidean (circle, 1) distance metrics.
 */
export const vignette: PassDescriptor = {
  id: 'core.vignette',
  label: 'Vignette',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let aspect = engine.width / engine.height;
  let d = (in.uv - params.center) * vec2f(aspect, 1.0);
  let boxDist = max(abs(d.x), abs(d.y));
  let circDist = length(d);
  let dist = mix(boxDist, circDist, params.roundness);
  let inner = max(params.radius - params.softness, 0.0);
  let mask = 1.0 - smoothstep(inner, params.radius, dist);
  let l = src.x * mix(1.0, mask, params.amount);
  return vec4f(l, src.y, src.z, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    amount: { kind: 'float', default: 1, min: 0, max: 1, animatable: true },
    radius: { kind: 'float', default: 0.75, min: 0, max: 2, animatable: true },
    softness: { kind: 'float', default: 0.4, min: 0, max: 2, animatable: true },
    roundness: { kind: 'float', default: 1, min: 0, max: 1, animatable: true },
    center: { kind: 'vec2', default: [0.5, 0.5], animatable: true },
  },
  metadata: { category: 'core', menuPath: 'Effects/Stylize/Vignette', description: 'Darken L toward the edges, shaped by radius/softness/roundness.' },
};

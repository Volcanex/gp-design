import type { PassDescriptor } from '../pass';

/**
 * The per-mode `fn blend(base: vec4f, src: vec4f) -> vec3f` is spliced in
 * separately by the chain executor from the selected BlendModeDef, not via
 * `includes`. This pass's own `includes: ['blend']` refers to the
 * porter_duff_over() snippet (wgsl/snippets/blend.wgsl), a different thing
 * that happens to share the name 'blend' as a registry key vs. a WGSL fn.
 */
export const composite: PassDescriptor = {
  id: 'core.composite',
  label: 'Composite',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let b = textureSample(input0, samp0, in.uv);
  var s = textureSample(input1, samp1, in.uv);
  s.a *= params.opacity;
  let mixed = vec4f(blend(b, s), s.a);
  return porter_duff_over(b, mixed);
}
`,
  includes: ['blend'],
  inputs: [{ name: 'input0' }, { name: 'input1' }],
  params: {
    opacity: { kind: 'float', default: 1, min: 0, max: 1, animatable: true },
  },
  metadata: { category: 'core', description: 'Alpha-composite src (input1) over base (input0).' },
};

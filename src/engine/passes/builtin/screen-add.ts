import type { PassDescriptor } from '../pass';

/**
 * Hidden sub-pass (no menuPath), two inputs: input0 = 'prev' (the blurred
 * bloom layer), input1 = 'orig' (the macro's own input, pre-bloom).
 * Screen-combines L (`1 - (1-a)(1-b)`, the standard screen-blend
 * identity, applied to L rather than RGB since buffers are OKLab): this
 * only ever brightens, never darkens, matching how bloom should read.
 * Chroma choice is a judgement call (no canonical "screen" for a/b):
 * mix orig's chroma toward the bloom layer's chroma, weighted by how much
 * the bloom actually contributes at that pixel (`contrib`). A strongly
 * bloomed pixel takes on the bloom's colour cast, an unaffected pixel
 * keeps its own. This reads as "max-ish" without an unbounded max() that
 * could push a/b outside their working range.
 */
export const screenAdd: PassDescriptor = {
  id: 'core.screen-add',
  label: 'Screen Add (internal)',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let bloom = textureSample(input0, samp0, in.uv);
  let orig = textureSample(input1, samp1, in.uv);
  let bloomL = clamp(bloom.x * params.intensity, 0.0, 1.0);
  let l = 1.0 - (1.0 - bloomL) * (1.0 - orig.x);
  let contrib = bloomL;
  let ab = mix(orig.yz, bloom.yz, contrib);
  return vec4f(l, ab.x, ab.y, orig.a);
}
`,
  inputs: [{ name: 'input0' }, { name: 'input1' }],
  params: {
    intensity: { kind: 'float', default: 1, min: 0, max: 5, animatable: true, label: 'Intensity' },
  },
  metadata: { category: 'core' },
};

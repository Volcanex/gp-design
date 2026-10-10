import type { PassDescriptor } from '../pass';

/**
 * Hidden sub-pass (no menuPath), two inputs: input0 = 'prev' (the blurred,
 * tinted shadow layer), input1 = 'orig' (the macro's own input, the
 * unmodified source). The shadow sits UNDER the original, shifted by
 * `offset` (in pixels): sample the shadow at `uv - offset/resolution` so
 * it visually reads as offset relative to the source, then porter-duff
 * "orig over shadow".
 */
export const shadowComposite: PassDescriptor = {
  id: 'core.shadow-composite',
  label: 'Shadow Composite (internal)',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let px = vec2f(1.0 / engine.width, 1.0 / engine.height);
  let shadow = textureSample(input0, samp0, in.uv - params.offset * px);
  let orig = textureSample(input1, samp1, in.uv);
  return porter_duff_over(shadow, orig);
}
`,
  includes: ['blend'],
  inputs: [{ name: 'input0' }, { name: 'input1' }],
  params: {
    offset: { kind: 'vec2', default: [8, 8], label: 'Offset' },
  },
  metadata: { category: 'core' },
};

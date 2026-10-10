import type { PassDescriptor } from '../pass';

/**
 * MASKS block (own this block; see gdesign-wt/masks). Hidden pass (no
 * menuPath): core/engine.ts's renderNodeContent runs this directly after a
 * layer's own content (source + chain) whenever `layer.mask?.enabled`, the
 * same "manually invoked, not reachable from a chain/menu" pattern
 * core.image.blit and core.feedback's transform pass already use.
 *
 * 2 declared inputs: input0 = the layer's content, input1 = the mask asset
 * (uploaded straight from its rgba16float raster bytes, same layout a paint
 * layer's own backing store uses; see doc/json.ts's Layer.mask comment).
 * Only the mask's L channel is meaningful (1 = keep, 0 = hide); a/b/alpha
 * are ignored. `invert` flips which end of L means "keep".
 */
export const maskApply: PassDescriptor = {
  id: 'core.mask-apply',
  label: 'Mask Apply (internal)',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let content = textureSample(input0, samp0, in.uv);
  let mask = textureSample(input1, samp1, in.uv);
  let factor = select(mask.x, 1.0 - mask.x, params.invert != 0u);
  return vec4f(content.xyz, content.a * factor);
}
`,
  inputs: [{ name: 'input0' }, { name: 'input1' }],
  params: {
    invert: { kind: 'bool', default: false },
  },
  metadata: { category: 'core', description: "Multiplies a layer's content alpha by a mask raster asset's L channel (or its inverse)." },
};

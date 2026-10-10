import type { PassDescriptor } from '../pass';

/**
 * SINGLE pass (not a macro): Effects/Distort/Displacement Map. The `asset`
 * param becomes input1 (per lut.ts's precedent: declared inputs first,
 * then asset-kind params in sorted key order). Sampled RGB xy channels,
 * recentred around 0.5, drive a UV offset scaled by `amount` (in normalized
 * uv units, not px, so displacement scales with the doc regardless of
 * resolution). When the asset param is left unset, core/frame.ts's
 * resolveAssetInputs falls back to a neutral mid-grey 1x1 texture: xy of
 * mid-grey (0.5, 0.5) recentres to (0, 0), so an unset map is identity.
 */
export const displacement: PassDescriptor = {
  id: 'core.displacement',
  label: 'Displacement Map',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let d = textureSample(input1, samp1, in.uv).xy - vec2f(0.5, 0.5);
  let uv = in.uv + d * params.amount;
  return textureSample(input0, samp0, uv);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    asset: { kind: 'asset', assetType: 'image', label: 'Displacement Map' },
    amount: { kind: 'float', default: 0.05, min: -1, max: 1, step: 0.001, animatable: true, label: 'Amount' },
  },
  metadata: { category: 'core', menuPath: 'Effects/Distort/Displacement Map', description: 'Offsets UVs by a displacement map\'s xy channels (recentred at mid-grey), scaled by amount.' },
};

import type { PassDescriptor } from '../../passes/pass';
import { sourceFromPass } from '../from-pass';

/**
 * Adjustment-layer sentinel. No new doc schema: a Layer whose
 * `source.type === 'core.adjustment'` IS an adjustment layer (see
 * core/engine.ts's renderNodes ADJUST branch, which intercepts it before
 * this render() ever runs). This render() only fires via renderNodeContent
 * (renderSubtree/burn, or a future/older engine that doesn't know about
 * adjustment layers). Transparent is the honest "nothing below" answer in
 * both cases, not a placeholder to be improved on later.
 */
const adjustmentPass: PassDescriptor = {
  id: 'core.adjustment',
  label: 'Adjustment',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, 0.0);
}
`,
  inputs: [],
  params: {},
  metadata: {
    category: 'core',
    description: 'Adjustment layer sentinel: applies its effect chain to everything below it. Renders transparent standalone (renderNodes intercepts it before this fallback is used).',
  },
};

export const adjustment = sourceFromPass(adjustmentPass);

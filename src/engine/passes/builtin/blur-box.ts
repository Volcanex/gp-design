import type { PassDescriptor } from '../pass';
import type { ResolvedParams } from '../../params/schema';

/**
 * Macro effect: Effects/Blur/Box. Same shape as core.blur-gaussian, but
 * asks core.blur-dir for flat (box) weights instead of gaussian falloff.
 * Shares the sub-pass rather than shipping a twin.
 */
export const blurBox: PassDescriptor = {
  id: 'core.blur-box',
  label: 'Box Blur',
  kind: 'render',
  wgsl: '',
  inputs: [{ name: 'input0' }],
  params: {
    radius: { kind: 'float', default: 8, min: 0, max: 64, unit: 'px', animatable: true, label: 'Radius' },
  },
  metadata: { category: 'core', menuPath: 'Effects/Blur/Box', description: 'Separable 2-pass box blur.' },
  expand: (params) => [
    { pass: 'core.blur-dir', params: { dir: [1, 0], radius: params.radius, boxWeights: true } as ResolvedParams },
    { pass: 'core.blur-dir', params: { dir: [0, 1], radius: params.radius, boxWeights: true } as ResolvedParams },
  ],
};

import type { PassDescriptor } from '../pass';
import type { ResolvedParams } from '../../params/schema';

/**
 * Macro effect (PassDescriptor.expand): Effects/Blur/Gaussian. Composes
 * two core.blur-dir passes (horizontal then vertical) for a full 2D
 * separable gaussian blur. `wgsl: ''`: this descriptor never compiles
 * itself, run-chain.ts's macro branch runs the sub-passes instead.
 */
export const blurGaussian: PassDescriptor = {
  id: 'core.blur-gaussian',
  label: 'Gaussian Blur',
  kind: 'render',
  wgsl: '',
  inputs: [{ name: 'input0' }],
  params: {
    radius: { kind: 'float', default: 8, min: 0, max: 64, unit: 'px', animatable: true, label: 'Radius' },
  },
  metadata: { category: 'core', menuPath: 'Effects/Blur/Gaussian', description: 'Separable 2-pass gaussian blur.' },
  expand: (params) => [
    { pass: 'core.blur-dir', params: { dir: [1, 0], radius: params.radius, boxWeights: false } as ResolvedParams },
    { pass: 'core.blur-dir', params: { dir: [0, 1], radius: params.radius, boxWeights: false } as ResolvedParams },
  ],
};

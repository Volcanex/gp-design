import type { PassDescriptor } from '../pass';
import type { ResolvedParams } from '../../params/schema';

/**
 * Macro effect: Effects/Stylize/Drop Shadow. Tints the source's alpha
 * silhouette to `color`/`opacity`, blurs it (2-pass separable), then
 * composites the untouched original back on top, shadow shifted by
 * `offset` px. See core.shadow-tint / core.shadow-composite.
 */
export const dropShadow: PassDescriptor = {
  id: 'core.drop-shadow',
  label: 'Drop Shadow',
  kind: 'render',
  wgsl: '',
  inputs: [{ name: 'input0' }],
  params: {
    offset: { kind: 'vec2', default: [8, 8], label: 'Offset' },
    radius: { kind: 'float', default: 6, min: 0, max: 64, unit: 'px', animatable: true, label: 'Radius' },
    color: { kind: 'color', default: [0, 0, 0, 1], space: 'oklab', label: 'Color' },
    opacity: { kind: 'float', default: 0.6, min: 0, max: 1, animatable: true, label: 'Opacity' },
  },
  metadata: { category: 'core', menuPath: 'Effects/Stylize/Drop Shadow', description: 'Blurred, offset shadow of the source composited underneath it.' },
  expand: (params) => [
    { pass: 'core.shadow-tint', params: { color: params.color, opacity: params.opacity } as ResolvedParams },
    { pass: 'core.blur-dir', params: { dir: [1, 0], radius: params.radius, boxWeights: false } as ResolvedParams },
    { pass: 'core.blur-dir', params: { dir: [0, 1], radius: params.radius, boxWeights: false } as ResolvedParams },
    { pass: 'core.shadow-composite', params: { offset: params.offset } as ResolvedParams, inputs: ['prev', 'orig'] },
  ],
};

import type { PassDescriptor } from '../pass';
import type { ResolvedParams } from '../../params/schema';

/**
 * Macro effect: Effects/Blur/Bloom. Extracts brights above `threshold`,
 * blurs them (2-pass separable), then screen-adds the result back onto
 * the original at `intensity`. See core.screen-add for the chroma-combine
 * choice; core.bright-pass for the extraction rule.
 */
export const bloom: PassDescriptor = {
  id: 'core.bloom',
  label: 'Bloom',
  kind: 'render',
  wgsl: '',
  inputs: [{ name: 'input0' }],
  params: {
    threshold: { kind: 'float', default: 0.7, min: 0, max: 1, animatable: true, label: 'Threshold' },
    radius: { kind: 'float', default: 12, min: 0, max: 64, unit: 'px', animatable: true, label: 'Radius' },
    intensity: { kind: 'float', default: 1, min: 0, max: 5, animatable: true, label: 'Intensity' },
  },
  metadata: { category: 'core', menuPath: 'Effects/Blur/Bloom', description: 'Threshold-extract, blur, screen-add bloom.' },
  expand: (params) => [
    { pass: 'core.bright-pass', params: { threshold: params.threshold } as ResolvedParams },
    { pass: 'core.blur-dir', params: { dir: [1, 0], radius: params.radius, boxWeights: false } as ResolvedParams },
    { pass: 'core.blur-dir', params: { dir: [0, 1], radius: params.radius, boxWeights: false } as ResolvedParams },
    { pass: 'core.screen-add', params: { intensity: params.intensity } as ResolvedParams, inputs: ['prev', 'orig'] },
  ],
};

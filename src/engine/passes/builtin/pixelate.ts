import type { PassDescriptor } from '../pass';

/**
 * `input0` is sampled NEAREST (see PassInputDecl.filter) so a single sample
 * at the snapped cell centre is a true block-colour lookup, not an averaged
 * one. That plus the uv snap below is what makes cells flat.
 */
export const pixelate: PassDescriptor = {
  id: 'core.pixelate',
  label: 'Pixelate',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let grid = vec2f(engine.width, engine.height) / max(params.cellSize, 1.0);
  let cellUv = (floor(in.uv * grid) + 0.5) / grid;
  return textureSample(input0, samp0, cellUv);
}
`,
  inputs: [{ name: 'input0', filter: 'nearest' }],
  params: {
    cellSize: { kind: 'float', default: 8, min: 1, max: 256, animatable: true },
  },
  metadata: { category: 'core', menuPath: 'Effects/Stylize/Pixelate', description: 'Snap uv to a coarse cell grid sized in pixels.' },
};

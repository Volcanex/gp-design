import type { PassDescriptor } from '../pass';

/**
 * Rotates pixel-space uv by `angle` before splitting into cells so the dot
 * (or line) grid can sit at an arbitrary screen angle, the classic
 * dot-screen look. Per-cell coverage is driven by the source L at the cell
 * centre: darker cells get bigger dots/thicker lines.
 */
export const halftone: PassDescriptor = {
  id: 'core.halftone',
  label: 'Halftone',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let ca = cos(params.angle);
  let sa = sin(params.angle);
  let p = in.uv * vec2f(engine.width, engine.height);
  let rotated = vec2f(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  let cellSize = max(params.cellSize, 1.0);
  let cellPos = rotated / cellSize;
  let local = fract(cellPos) - 0.5;
  let isDots = params.mode == 0u;
  let distMetric = select(abs(local.y), length(local), isDots);
  let radius = (1.0 - src.x) * 0.5;
  let edge = max(params.softness, 0.001);
  let coverage = 1.0 - smoothstep(radius - edge, radius + edge, distMetric);
  let l = 1.0 - coverage;
  return vec4f(l, src.y, src.z, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    cellSize: { kind: 'float', default: 12, min: 2, max: 128, animatable: true },
    angle: { kind: 'float', default: 0.7853982, min: -6.283185, max: 6.283185, animatable: true },
    mode: { kind: 'enum', default: 'dots', options: ['dots', 'lines'] },
    softness: { kind: 'float', default: 0.15, min: 0, max: 1, animatable: true },
  },
  metadata: { category: 'core', menuPath: 'Effects/Stylize/Halftone', description: 'Rotated dot-screen or line halftone driven by source L.' },
};

import type { PassDescriptor } from '../pass';

/**
 * `mode` enum index order (mirrorX=0, mirrorY=1, tile=2). Tile mode uses a
 * mirrored-repeat wrap (triangle wave, period 2 tiles) rather than a plain
 * `fract` wrap, so adjacent tiles are seamless instead of hard-seamed.
 */
export const tileMirror: PassDescriptor = {
  id: 'core.tile-mirror',
  label: 'Mirror & Tile',
  kind: 'render',
  wgsl: `
fn mirror_repeat(x: f32) -> f32 {
  let t = fract(x * 0.5) * 2.0;
  return 1.0 - abs(t - 1.0);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  var uv = in.uv;
  if (params.mode == 0u) {
    uv.x = select(uv.x, 1.0 - uv.x, uv.x > 0.5);
  } else if (params.mode == 1u) {
    uv.y = select(uv.y, 1.0 - uv.y, uv.y > 0.5);
  } else {
    let p = (in.uv + params.offset) * f32(params.count);
    uv = vec2f(mirror_repeat(p.x), mirror_repeat(p.y));
  }
  return textureSample(input0, samp0, uv);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    mode: { kind: 'enum', default: 'tile', options: ['mirrorX', 'mirrorY', 'tile'] },
    count: { kind: 'int', default: 2, min: 1, max: 16 },
    offset: { kind: 'vec2', default: [0, 0], animatable: true },
  },
  metadata: {
    category: 'core',
    menuPath: 'Effects/Distort/Mirror & Tile',
    description: 'Mirror the frame about an axis, or mirror-tile it in a grid.',
  },
};

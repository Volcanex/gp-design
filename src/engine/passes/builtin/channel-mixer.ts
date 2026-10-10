import type { PassDescriptor } from '../pass';

export const channelMixer: PassDescriptor = {
  id: 'core.channel-mixer',
  label: 'Channel Mixer',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let rgb = src.rgb;
  let r = dot(rgb, params.redRow) + params.constants.x;
  let g = dot(rgb, params.greenRow) + params.constants.y;
  let b = dot(rgb, params.blueRow) + params.constants.z;
  return vec4f(r, g, b, src.a);
}
`,
  inputs: [{ name: 'input0' }],
  params: {
    redRow: { kind: 'vec3', default: [1, 0, 0], animatable: true, label: 'Red row' },
    greenRow: { kind: 'vec3', default: [0, 1, 0], animatable: true, label: 'Green row' },
    blueRow: { kind: 'vec3', default: [0, 0, 1], animatable: true, label: 'Blue row' },
    constants: { kind: 'vec3', default: [0, 0, 0], animatable: true, label: 'Constants' },
  },
  metadata: {
    category: 'core',
    menuPath: 'Adjustments/Channel Mixer',
    description: 'Each output channel is a dot product of input RGB with a row, plus a constant.',
    colorSpace: 'rgb',
  },
};

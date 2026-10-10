import type { PassDescriptor } from '../pass';

const grey = (l: number): readonly [number, number, number, number] => [l, 0, 0, 1];

export const paletteMap: PassDescriptor = {
  id: 'core.palette-map',
  label: 'Palette Map',
  kind: 'render',
  wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let src = textureSample(input0, samp0, in.uv);
  let px = in.uv * vec2f(engine.width, engine.height);
  let jitter = (ign(px, engine.frame) - 0.5) * params.dither * 0.05;
  let jittered = src.xyz + vec3f(jitter);

  var palette = array<vec3f, 8>(
    params.c1.xyz, params.c2.xyz, params.c3.xyz, params.c4.xyz,
    params.c5.xyz, params.c6.xyz, params.c7.xyz, params.c8.xyz,
  );

  var bestDist = 1e9;
  var bestIdx = 0;
  for (var i = 0; i < params.count; i = i + 1) {
    let d = palette[i] - jittered;
    let dist = dot(d, d);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return vec4f(palette[bestIdx], src.a);
}
`,
  includes: ['bluenoise'],
  inputs: [{ name: 'input0' }],
  params: {
    count: { kind: 'int', default: 2, min: 1, max: 8 },
    c1: { kind: 'color', default: [0, 0, 0, 1], space: 'oklab', label: 'Colour 1 (black)' },
    c2: { kind: 'color', default: [1, 0, 0, 1], space: 'oklab', label: 'Colour 2 (white)' },
    c3: { kind: 'color', default: grey(0.2), space: 'oklab', label: 'Colour 3' },
    c4: { kind: 'color', default: grey(0.35), space: 'oklab', label: 'Colour 4' },
    c5: { kind: 'color', default: grey(0.5), space: 'oklab', label: 'Colour 5' },
    c6: { kind: 'color', default: grey(0.65), space: 'oklab', label: 'Colour 6' },
    c7: { kind: 'color', default: grey(0.8), space: 'oklab', label: 'Colour 7' },
    c8: { kind: 'color', default: grey(0.9), space: 'oklab', label: 'Colour 8' },
    dither: { kind: 'float', default: 0, min: 0, max: 1, step: 0.01 },
  },
  metadata: { category: 'core', menuPath: 'Effects/Palette Map', description: 'Nearest-colour OKLab palette mapping (the Titan look).' },
};

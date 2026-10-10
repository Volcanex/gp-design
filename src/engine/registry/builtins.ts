/**
 * Import this module for its side effects to register every builtin pass,
 * source, and blend mode. Idempotent per module instance (ESM caches the
 * module), but importing it twice from two different module graphs (e.g.
 * a test that also imports an individual builtin/*.ts directly) would
 * double-register. Registries throw a clear error in that case.
 */
import { effects } from './effects';
import { sources } from './sources';
import { blends } from './blends';
import { exportTargets } from './exports';

import { blit } from '../passes/builtin/blit';
import { composite } from '../passes/builtin/composite';
import { toRgb, fromRgb } from '../passes/builtin/convert-rgb';
import { exposure } from '../passes/builtin/exposure';
import { quantise } from '../passes/builtin/quantise';
import { ditherBluenoise } from '../passes/builtin/dither-bluenoise';
// P2-look block: adjustments/look passes (own this block; see gdesign-wt/p2-look).
import { levels } from '../passes/builtin/levels';
import { curves } from '../passes/builtin/curves';
import { hsl } from '../passes/builtin/hsl';
import { brightnessContrast } from '../passes/builtin/brightness-contrast';
import { posterize } from '../passes/builtin/posterize';
import { invert } from '../passes/builtin/invert';
import { paletteMap } from '../passes/builtin/palette-map';
import { lut } from '../passes/builtin/lut';
// end P2-look block
// FX-COLOR block: colour/grade adjustments (own this block; see gdesign-wt/fx-color).
import { temperature } from '../passes/builtin/temperature';
import { vibrance } from '../passes/builtin/vibrance';
import { gamma } from '../passes/builtin/gamma';
import { threshold } from '../passes/builtin/threshold';
import { channelMixer } from '../passes/builtin/channel-mixer';
import { duotone } from '../passes/builtin/duotone';
import { solarize } from '../passes/builtin/solarize';
// end FX-COLOR block
// FX-STYLIZE block: stylize/dither effects (own this block; see gdesign-wt/fx-stylize).
import { vignette } from '../passes/builtin/vignette';
import { pixelate } from '../passes/builtin/pixelate';
import { scanlines } from '../passes/builtin/scanlines';
import { halftone } from '../passes/builtin/halftone';
import { grain } from '../passes/builtin/grain';
import { ditherOrdered } from '../passes/builtin/dither-ordered';
import { edgeDetect } from '../passes/builtin/edge-detect';
// end FX-STYLIZE block

// FX-DISTORT block: distort/focus effects (own this block; see gdesign-wt/fx-distort).
import { wave } from '../passes/builtin/wave';
import { twirl } from '../passes/builtin/twirl';
import { kaleidoscope } from '../passes/builtin/kaleidoscope';
import { tileMirror } from '../passes/builtin/tile-mirror';
import { chromaticAberration } from '../passes/builtin/chromatic-aberration';
import { sharpen } from '../passes/builtin/sharpen';
import { glow } from '../passes/builtin/glow';
// end FX-DISTORT block

// FX-MULTIPASS block: multi-pass macro effects (own this block; see gdesign-wt/multipass).
import { blurDir } from '../passes/builtin/blur-dir';
import { brightPass } from '../passes/builtin/bright-pass';
import { screenAdd } from '../passes/builtin/screen-add';
import { shadowTint } from '../passes/builtin/shadow-tint';
import { shadowComposite } from '../passes/builtin/shadow-composite';
import { blurGaussian } from '../passes/builtin/blur-gaussian';
import { blurBox } from '../passes/builtin/blur-box';
import { bloom } from '../passes/builtin/bloom';
import { dropShadow } from '../passes/builtin/drop-shadow';
import { displacement } from '../passes/builtin/displacement';
// end FX-MULTIPASS block

// MASKS block (own this block; see gdesign-wt/masks).
import { maskApply } from '../passes/builtin/mask-apply';
// end MASKS block

import { solid } from '../sources/builtin/solid';
// ADJUST block: adjustment-layer sentinel source (own this line; see gdesign-wt/adjust).
import { adjustment } from '../sources/builtin/adjustment';
// end ADJUST block
import { image } from '../sources/builtin/image';
import { text } from '../sources/builtin/text';
import { plasma } from '../sources/builtin/plasma';
import { gradient } from '../sources/builtin/gradient';
import { raster } from '../sources/builtin/raster';
import { scene } from '../sources/builtin/scene';
import { nestedDoc } from '../sources/builtin/stubs';
// P3-3d block: 3D scene source (own this block; see gdesign-wt/p3-3d).
import { threed } from '../sources/builtin/threed';
// end P3-3d block

// FX-BLENDGEN block: generative sources (own this block; see gdesign-wt/blendgen).
import { noise } from '../sources/builtin/noise';
import { feedback } from '../sources/builtin/feedback';
// end FX-BLENDGEN block

// P3-export block: export targets (own this block; see gdesign-wt/p3-export).
import { pngExportTarget } from '../export/png';
import { videoExportTarget } from '../export/video';
import { liveEmbedExportTarget } from '../export/live-embed';
import { pngSequenceExportTarget } from '../export/png-sequence';
// end P3-export block

for (const pass of [
  blit, composite, toRgb, fromRgb, exposure, quantise, ditherBluenoise,
  // P2-look block
  levels, curves, hsl, brightnessContrast, posterize, invert, paletteMap, lut,
  // end P2-look block
  // FX-COLOR block
  temperature, vibrance, gamma, threshold, channelMixer, duotone, solarize,
  // end FX-COLOR block
  // FX-STYLIZE block
  vignette, pixelate, scanlines, halftone, grain, ditherOrdered, edgeDetect,
  // end FX-STYLIZE block
  // FX-DISTORT block
  wave, twirl, kaleidoscope, tileMirror, chromaticAberration, sharpen, glow,
  // end FX-DISTORT block
  // FX-MULTIPASS block
  blurDir, brightPass, screenAdd, shadowTint, shadowComposite,
  blurGaussian, blurBox, bloom, dropShadow, displacement,
  // end FX-MULTIPASS block
  // MASKS block
  maskApply,
  // end MASKS block
]) {
  if (!effects.get(pass.id)) effects.register(pass);
}

for (const source of [solid, image, plasma, gradient, raster, text, scene, nestedDoc, threed, noise, feedback, adjustment]) {
  if (!sources.get(source.id)) sources.register(source);
}

for (const target of [pngExportTarget, videoExportTarget, liveEmbedExportTarget, pngSequenceExportTarget]) {
  if (!exportTargets.get(target.id)) exportTargets.register(target);
}

blends.register({
  id: 'normal',
  label: 'Normal',
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  return src.xyz;
}
`,
});

blends.register({
  id: 'darken',
  label: 'Darken',
  // Perceptual interpretation: darken by L, keep src chroma. Tuning later.
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  let l = min(base.x, src.x);
  return vec3f(l, src.y, src.z);
}
`,
});

blends.register({
  id: 'lighten',
  // Perceptual interpretation: lighten by L, keep src chroma. Tuning later.
  label: 'Lighten',
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  let l = max(base.x, src.x);
  return vec3f(l, src.y, src.z);
}
`,
});

blends.register({
  id: 'add',
  label: 'Add',
  // Perceptual interpretation: additive L, chroma summed and clamped to the
  // working a/b range. Tuning later.
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  let l = clamp(base.x + src.x, 0.0, 1.0);
  let ab = clamp(base.yz + src.yz, vec2f(-0.4), vec2f(0.4));
  return vec3f(l, ab.x, ab.y);
}
`,
});

blends.register({
  id: 'multiply',
  label: 'Multiply',
  // Perceptual interpretation: multiplicative L, chroma averaged 50/50.
  // Tuning later.
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  let l = base.x * src.x;
  let ab = mix(base.yz, src.yz, 0.5);
  return vec3f(l, ab.x, ab.y);
}
`,
});

// --- FX-BLENDGEN block: OKLab-native blend pack (own this block; see gdesign-wt/blendgen) ---

blends.register({
  id: 'screen',
  label: 'Screen',
  // Classic screen formula (1-(1-a)(1-b)) applied directly to L instead of
  // per-RGB-channel: OKLab's L already IS the perceptual "how bright"
  // channel, so one screen op replaces the usual three. Chroma leans toward
  // src, weighted by how much src lightens the result (its own L).
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  let l = 1.0 - (1.0 - base.x) * (1.0 - src.x);
  let ab = mix(base.yz, src.yz, clamp(src.x, 0.0, 1.0));
  return vec3f(l, ab.x, ab.y);
}
`,
});

blends.register({
  id: 'overlay',
  label: 'Overlay',
  // Standard overlay split at L=0.5 (multiply below the midpoint, screen
  // above it), same shape as Photoshop's but on L rather than RGB. Chroma
  // mixed 50/50: overlay is primarily a contrast move, not a hue move.
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  let l = select(1.0 - 2.0 * (1.0 - base.x) * (1.0 - src.x), 2.0 * base.x * src.x, base.x < 0.5);
  let ab = mix(base.yz, src.yz, 0.5);
  return vec3f(l, ab.x, ab.y);
}
`,
});

blends.register({
  id: 'soft-light',
  label: 'Soft Light',
  // W3C compositing-spec soft-light formula (the D(x) helper below), applied
  // to L only. Chroma mixed 50/50, same rationale as overlay.
  wgsl: `
fn blendgen_soft_light_d(x: f32) -> f32 {
  return select(sqrt(x), ((16.0 * x - 12.0) * x + 4.0) * x, x <= 0.25);
}
fn blend(base: vec4f, src: vec4f) -> vec3f {
  let cb = base.x;
  let cs = src.x;
  let l = select(
    cb + (2.0 * cs - 1.0) * (blendgen_soft_light_d(cb) - cb),
    cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb),
    cs <= 0.5,
  );
  let ab = mix(base.yz, src.yz, 0.5);
  return vec3f(l, ab.x, ab.y);
}
`,
});

blends.register({
  id: 'difference',
  label: 'Difference',
  // Absolute L delta (classic difference), chroma delta clamped to the
  // working a/b range (AB_RANGE in wgsl/snippets/common.wgsl) so an
  // out-of-gamut subtraction doesn't blow past what quantise/dither expect.
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  let l = abs(base.x - src.x);
  let ab = clamp(base.yz - src.yz, vec2f(-0.4), vec2f(0.4));
  return vec3f(l, ab.x, ab.y);
}
`,
});

blends.register({
  id: 'color',
  label: 'Color',
  // Take src's chroma (hue+saturation), keep base's L. OKLab makes this a
  // one-line swap instead of Photoshop's RGB<->HSL round trip, and it stays
  // perceptually correct because a/b are already a hue/chroma plane.
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  return vec3f(base.x, src.y, src.z);
}
`,
});

blends.register({
  id: 'luminosity',
  label: 'Luminosity',
  // Inverse of Color: take src's L, keep base's chroma.
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  return vec3f(src.x, base.y, base.z);
}
`,
});

blends.register({
  id: 'hue',
  label: 'Hue',
  // Rotate base's chroma vector to src's hue angle (atan2 on a/b) while
  // keeping base's chroma magnitude and L: only the hue angle moves.
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  let baseChroma = length(base.yz);
  let srcAngle = atan2(src.z, src.y);
  let ab = vec2f(cos(srcAngle), sin(srcAngle)) * baseChroma;
  return vec3f(base.x, ab.x, ab.y);
}
`,
});

blends.register({
  id: 'saturation',
  label: 'Saturation',
  // Inverse of Hue: keep base's hue angle and L, take src's chroma
  // magnitude (its distance from the neutral axis in the a/b plane).
  wgsl: `
fn blend(base: vec4f, src: vec4f) -> vec3f {
  let srcChroma = length(src.yz);
  let baseAngle = atan2(base.z, base.y);
  let ab = vec2f(cos(baseAngle), sin(baseAngle)) * srcChroma;
  return vec3f(base.x, ab.x, ab.y);
}
`,
});

// --- end FX-BLENDGEN block -------------------------------------------------

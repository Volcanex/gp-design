/**
 * Shared WGSL struct fields + packing for the ObjectNode transform (see
 * ../../core/transform2d.ts, which this must match formula-for-formula: CPU
 * hit-testing and GPU rendering must agree on where an object sits). Used by
 * every own-pipeline shape/image draw in scene.ts; text objects go through
 * text-gpu.ts's own (MSDF-flavoured) copy of the same formula instead, since
 * that shader has its own struct layout inherited from core.text.
 *
 * Byte layout (matches the WGSL below): resolution(8)@0, anchor(8)@8,
 * translate(8)@16, scale(8)@24, rotation(4)@32, pad(12)@36 -> 48 bytes total,
 * leaving the embedding struct's next field (e.g. `color: vec4f`) starting
 * at the required 16-byte alignment.
 */

export const TRANSFORM_UNIFORM_SIZE = 48;

export const TRANSFORM_WGSL_FIELDS = `
  resolution: vec2f,
  anchor: vec2f,
  translate: vec2f,
  scale: vec2f,
  rotation: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
`;

/** Assumes a `u: Uniforms` binding is in scope and a `localPos: vec2f` vertex
 * input; declares `let clip: vec4f` for the caller to return/assign. */
export const TRANSFORM_VS_BODY = `
  let rel = localPos - u.anchor;
  let scaled = rel * u.scale;
  let c = cos(u.rotation);
  let s = sin(u.rotation);
  let rot = vec2f(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c);
  let doc = rot + u.translate;
  let clip = vec4f(2.0 * doc.x / u.resolution.x - 1.0, 1.0 - 2.0 * doc.y / u.resolution.y, 0.0, 1.0);
`;

export function writeTransformUniform(
  view: DataView,
  offset: number,
  resolution: readonly [number, number],
  anchor: readonly [number, number],
  translate: readonly [number, number],
  scale: readonly [number, number],
  rotation: number,
): void {
  view.setFloat32(offset + 0, resolution[0], true);
  view.setFloat32(offset + 4, resolution[1], true);
  view.setFloat32(offset + 8, anchor[0], true);
  view.setFloat32(offset + 12, anchor[1], true);
  view.setFloat32(offset + 16, translate[0], true);
  view.setFloat32(offset + 20, translate[1], true);
  view.setFloat32(offset + 24, scale[0], true);
  view.setFloat32(offset + 28, scale[1], true);
  view.setFloat32(offset + 32, rotation, true);
}

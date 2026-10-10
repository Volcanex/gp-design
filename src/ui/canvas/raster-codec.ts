/**
 * rgba16float <-> Float32Array conversion for CPU-side flood fill. This is a
 * deliberate small duplicate of engine/gpu/readback.ts's private f16ToF32 (and
 * its inverse, which readback.ts never needed since it only ever decodes):
 * src/ui/CLAUDE.md's boundary rule is that UI touches the engine only through
 * `@engine`, and neither direction of this conversion is exported there. The
 * flood fill tool needs to read AND write raw raster asset bytes directly
 * (bucket fill runs entirely CPU-side, no GPU readback involved, see
 * doc/json.ts's AssetJSON('raster'): rgba16float bytes are the document's
 * own storage format, not a render output), so this file owns both halves.
 */

/** IEEE 754 half-precision -> f32. Bit-for-bit the same algorithm as
 * engine/gpu/readback.ts's f16ToF32. */
function f16ToF32(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

const f32Scratch = new Float32Array(1);
const i32Scratch = new Int32Array(f32Scratch.buffer);

/** IEEE 754 f32 -> half-precision, round-to-nearest-even. Standard bit-
 * twiddling encoder (same algorithm as three.js's DataUtils.toHalfFloat). */
function f32ToF16(val: number): number {
  f32Scratch[0] = val;
  const x = i32Scratch[0]!;
  let bits = (x >> 16) & 0x8000; // sign
  let m = (x >> 12) & 0x07ff; // mantissa
  const e = (x >> 23) & 0xff; // exponent

  if (e < 103) return bits; // too small for even a subnormal half -> signed zero
  if (e > 142) {
    // Overflow / Inf / NaN -> Inf (NaN payload isn't preserved; not needed here).
    bits |= 0x7c00;
    bits |= (e === 255 ? 0 : 1) && (x & 0x007fffff ? 0x200 : 0);
    return bits;
  }
  if (e < 113) {
    // Subnormal half.
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1; // round to nearest even
  return bits;
}

/** Decodes a raw rgba16float ArrayBuffer (AssetJSON('raster').data's layout)
 * into a Float32Array of the same length, one f32 per channel. */
export function decodeRgba16f(buffer: ArrayBuffer): Float32Array {
  const halfs = new Uint16Array(buffer);
  const out = new Float32Array(halfs.length);
  for (let i = 0; i < halfs.length; i += 1) out[i] = f16ToF32(halfs[i]!);
  return out;
}

/** Encodes a Float32Array (one f32 per channel) into raw rgba16float bytes,
 * the inverse of decodeRgba16f. */
export function encodeRgba16f(values: Float32Array): ArrayBuffer {
  const halfs = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i += 1) halfs[i] = f32ToF16(values[i]!);
  return halfs.buffer;
}

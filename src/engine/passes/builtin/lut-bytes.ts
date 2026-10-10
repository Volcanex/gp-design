/**
 * Packed-2D 3D LUT byte layout, shared by core.lut's shader (the WGSL comment
 * in lut.ts mirrors this tiling), tests, and the future LUT-picker UI:
 * width = n*n, height = n, tile x = bSlice * n + r, tile y = g, rgba8unorm.
 */

export type LutSample = (r: number, g: number, b: number) => readonly [number, number, number];

/** Builds the raw rgba8unorm bytes (straight sRGB-scale 0..255, alpha 255)
 * for an N x N x N LUT, sampling `map` at each of the N^3 grid points. */
export function packLutBytes(n: number, map: LutSample): Uint8Array {
  const width = n * n;
  const height = n;
  const bytes = new Uint8Array(width * height * 4);
  for (let g = 0; g < n; g++) {
    for (let bSlice = 0; bSlice < n; bSlice++) {
      for (let r = 0; r < n; r++) {
        const [rr, gg, bb] = map(
          n > 1 ? r / (n - 1) : 0,
          n > 1 ? g / (n - 1) : 0,
          n > 1 ? bSlice / (n - 1) : 0,
        );
        const x = bSlice * n + r;
        const idx = (g * width + x) * 4;
        bytes[idx] = Math.round(Math.min(1, Math.max(0, rr)) * 255);
        bytes[idx + 1] = Math.round(Math.min(1, Math.max(0, gg)) * 255);
        bytes[idx + 2] = Math.round(Math.min(1, Math.max(0, bb)) * 255);
        bytes[idx + 3] = 255;
      }
    }
  }
  return bytes;
}

/** r,g,b -> r,g,b unchanged. */
export function identityLutBytes(n: number): Uint8Array {
  return packLutBytes(n, (r, g, b) => [r, g, b]);
}

/** r,g,b -> 1-r,1-g,1-b. */
export function invertedLutBytes(n: number): Uint8Array {
  return packLutBytes(n, (r, g, b) => [1 - r, 1 - g, 1 - b]);
}

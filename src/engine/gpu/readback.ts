/**
 * copyTextureToBuffer requires bytesPerRow padded to 256 bytes; both read
 * paths pad on the GPU side and unpad into a tightly-packed CPU array so
 * callers never see the padding.
 */

import type { CreateReadback, ReadbackOps } from './interfaces';

const BYTES_PER_ROW_ALIGN = 256;

async function copyToMappedBuffer(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  bytesPerPixel: number,
): Promise<{ mapped: ArrayBuffer; paddedBytesPerRow: number }> {
  const unpaddedBytesPerRow = width * bytesPerPixel;
  const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / BYTES_PER_ROW_ALIGN) * BYTES_PER_ROW_ALIGN;
  const buffer = device.createBuffer({
    size: paddedBytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow: paddedBytesPerRow },
    [width, height],
  );
  device.queue.submit([enc.finish()]);

  await buffer.mapAsync(GPUMapMode.READ);
  // Copy out of the mapped range: the range is invalidated on unmap.
  const mapped = buffer.getMappedRange().slice(0);
  buffer.unmap();
  buffer.destroy();
  return { mapped, paddedBytesPerRow };
}

/** IEEE 754 half-precision -> f32. */
function f16ToF32(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

export const createReadback: CreateReadback = (device: GPUDevice): ReadbackOps => ({
  async readFloat(texture, width, height) {
    const bytesPerPixel = 8; // rgba16float
    const { mapped, paddedBytesPerRow } = await copyToMappedBuffer(device, texture, width, height, bytesPerPixel);
    const halfs = new Uint16Array(mapped);
    const rowWords = paddedBytesPerRow / 2;
    const out = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcBase = y * rowWords + x * 4;
        const dstBase = (y * width + x) * 4;
        out[dstBase] = f16ToF32(halfs[srcBase]!);
        out[dstBase + 1] = f16ToF32(halfs[srcBase + 1]!);
        out[dstBase + 2] = f16ToF32(halfs[srcBase + 2]!);
        out[dstBase + 3] = f16ToF32(halfs[srcBase + 3]!);
      }
    }
    return out;
  },

  async readUnorm8(texture, width, height) {
    const bytesPerPixel = 4; // rgba8unorm
    const { mapped, paddedBytesPerRow } = await copyToMappedBuffer(device, texture, width, height, bytesPerPixel);
    const bytes = new Uint8Array(mapped);
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const srcRow = y * paddedBytesPerRow;
      const dstRow = y * width * 4;
      out.set(bytes.subarray(srcRow, srcRow + width * 4), dstRow);
    }
    return out;
  },
});

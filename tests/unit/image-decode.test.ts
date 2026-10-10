import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { createPlaceholderTexture, decodeImageAsset } from '../../src/engine/core/image-decode';
import type { AssetJSON } from '../../src/engine/doc/json';

// GPUTextureUsage is only provided by a real browser/WebGPU runtime, not
// vitest's node environment. Stub the two flag bits image-decode.ts reads.
beforeEach(() => {
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 0x04, COPY_DST: 0x02, RENDER_ATTACHMENT: 0x10 });
});

/**
 * Mock GPUDevice: plain objects standing in for GPUTexture, same pattern as
 * gpu-pool.test.ts. Numeric usage flags aren't touched (no GPUTextureUsage
 * global in vitest's node environment), only createTexture's `size`/`format`.
 */
function mockDevice() {
  const writeTexture = vi.fn();
  const copyExternalImageToTexture = vi.fn();
  const created: { size: [number, number]; format: string }[] = [];
  const device = {
    createTexture: (desc: { size: [number, number]; format: string; usage: number }) => {
      created.push({ size: desc.size, format: desc.format });
      return { ...desc, createView: () => ({}), destroy: () => {} };
    },
    queue: { writeTexture, copyExternalImageToTexture },
  };
  return { device: device as unknown as GPUDevice, created, writeTexture, copyExternalImageToTexture };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('image-decode', () => {
  it('createPlaceholderTexture makes a 1x1 rgba8unorm texture and writes transparent pixels', () => {
    const { device, created, writeTexture } = mockDevice();
    const ph = createPlaceholderTexture(device);
    expect(ph.texture).toBeTruthy();
    expect(ph.view).toBeTruthy();
    expect(created).toEqual([{ size: [1, 1], format: 'rgba8unorm' }]);
    expect(writeTexture).toHaveBeenCalledTimes(1);
    expect(writeTexture.mock.calls[0]![1]).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it('decodeImageAsset decodes bytes via createImageBitmap, uploads to a texture sized to the bitmap, and closes the bitmap', async () => {
    const bitmap = { width: 12, height: 34, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    const { device, created, copyExternalImageToTexture } = mockDevice();

    const asset: Extract<AssetJSON, { type: 'image' }> = {
      type: 'image',
      mime: 'image/png',
      data: new ArrayBuffer(4),
      width: 12,
      height: 34,
    };
    const result = await decodeImageAsset(device, asset);

    expect(created).toEqual([{ size: [12, 34], format: 'rgba8unorm' }]);
    expect(copyExternalImageToTexture).toHaveBeenCalledWith({ source: bitmap }, { texture: result.texture }, [12, 34]);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('decodeImageAsset closes the bitmap even if the texture upload throws', async () => {
    const bitmap = { width: 1, height: 1, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    const device = {
      createTexture: () => {
        throw new Error('boom');
      },
      queue: { copyExternalImageToTexture: vi.fn() },
    } as unknown as GPUDevice;

    const asset: Extract<AssetJSON, { type: 'image' }> = {
      type: 'image',
      mime: 'image/png',
      data: new ArrayBuffer(4),
      width: 1,
      height: 1,
    };
    await expect(decodeImageAsset(device, asset)).rejects.toThrow('boom');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('decodeImageAsset propagates a createImageBitmap rejection (undecodable bytes)', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('bad image data')));
    const { device } = mockDevice();
    const asset: Extract<AssetJSON, { type: 'image' }> = {
      type: 'image',
      mime: 'image/png',
      data: new ArrayBuffer(4),
      width: 1,
      height: 1,
    };
    await expect(decodeImageAsset(device, asset)).rejects.toThrow('bad image data');
  });
});

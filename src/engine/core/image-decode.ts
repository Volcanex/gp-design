/**
 * Shared decode-on-demand primitive for 'image' AssetJSON entries.
 * ctx.getAsset() (SourceCreateContext) hands sources the raw DocumentJSON
 * asset (still-encoded bytes + mime, never a pre-decoded bitmap), so any
 * source that draws an image asset (core.image, core.scene's image objects)
 * must decode it itself. Decoding is async; callers serve
 * createPlaceholderTexture()'s 1x1 transparent texture until decodeImageAsset
 * resolves (and forever, for a missing/wrong-type/undecodable asset: a bad
 * asset must never fail a frame).
 *
 * A pure pair of functions rather than a shared cache: image.ts (one texture
 * per source instance) and scene.ts (one per scene object, keyed by node id)
 * have different caching/keying needs, so each owns its own cache and just
 * calls these two primitives.
 */

import type { AssetJSON } from '../doc/json';

export interface DecodedTexture {
  texture: GPUTexture;
  view: GPUTextureView;
}

/** Decodes a raw 'image' AssetJSON's bytes into a GPU texture. Rejects if
 * createImageBitmap can't decode the bytes. Callers should catch. */
export async function decodeImageAsset(
  device: GPUDevice,
  asset: Extract<AssetJSON, { type: 'image' }>,
): Promise<DecodedTexture> {
  const blob = new Blob([asset.data], { type: asset.mime });
  const bitmap = await createImageBitmap(blob);
  try {
    const texture = device.createTexture({
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);
    return { texture, view: texture.createView() };
  } finally {
    bitmap.close();
  }
}

/** A 1x1 transparent texture, the frame this source shows while decode is
 * pending, or forever for a bad asset. */
export function createPlaceholderTexture(device: GPUDevice): DecodedTexture {
  const texture = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1]);
  return { texture, view: texture.createView() };
}

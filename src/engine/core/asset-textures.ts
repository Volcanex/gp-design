/**
 * Uploads DocumentJSON.assets entries to GPUTexture on demand for `asset`-kind
 * chain params (frame.ts's runPass resolves them here before calling
 * bindings.groupsFor). One cache instance lives for the lifetime of an
 * engine (created alongside pipelineCache/bindings/ring in core/engine.ts),
 * not per-frame, so a LUT/image already uploaded isn't re-uploaded every
 * render() call.
 */

import type { AssetJSON } from '../doc/json';
import type { PooledBuffer } from '../gpu/pool';

interface CachedEntry {
  signature: string;
  texture: GPUTexture;
  view: GPUTextureView;
  bytes: number;
}

export interface AssetTextureCache {
  /** Synchronous: 'lut' uploads immediately. 'image' decode is async (matches
   * sources/builtin/text.ts's atlas-load pattern): the placeholder (or the
   * previously decoded texture, if any) is served until decode lands. */
  resolve(id: string, asset: AssetJSON): PooledBuffer;
  /** 1x1 mid-grey (0.5, 0.5, 0.5, 1) texture, the neutral value for an
   * optional asset param left unset (e.g. core.displacement's map, where
   * mid-grey xy recentres to (0,0), i.e. identity). Distinct from the
   * transparent placeholder above, which exists for a different reason
   * (image decode not landed yet, not "no asset chosen"). */
  neutral(): PooledBuffer;
  /** MEMORY-EVICTION block: destroys every cached entry whose id is not in
   * `liveIds` (doc/document.ts's liveAssetIds). Called by
   * core/engine.ts's reconcile() after every applyEdits batch. An id still
   * mid-decode (in `decoding`) but not yet in `cache` is simply not evicted
   * here; its landing callback still fires and lands an orphaned texture
   * (a known, small, decode-latency-bounded gap, not worth a cancellation
   * mechanism for this pass). */
  evict(liveIds: ReadonlySet<string>): void;
  /** Sum of GPU bytes this cache currently owns (placeholder/neutral
   * included), folded into localHost's memoryStats() so eviction here is
   * actually visible in the statusbar/e2e-observable readout, not just a
   * silent internal bookkeeping change. */
  bytes(): number;
  dispose(): void;
}

function wrap(texture: GPUTexture, view: GPUTextureView): PooledBuffer {
  return {
    texture,
    view,
    key: { width: texture.width, height: texture.height, format: texture.format, usage: texture.usage },
    generation: 0,
  };
}

/**
 * Cheap signature that catches both asset replacement (a new AssetJSON object
 * swapped into doc.assets[id], e.g. undo/redo) and in-place byte mutation
 * (commitRaster writes into the same ArrayBuffer, see localHost.ts) without
 * hashing the whole buffer: byte length plus a handful of sampled bytes.
 */
function signatureOf(asset: AssetJSON): string {
  const data = 'data' in asset ? asset.data : undefined;
  if (!data) return asset.type;
  const bytes = new Uint8Array(data);
  const n = bytes.length;
  const step = Math.max(1, Math.floor(n / 16));
  let sig = `${asset.type}:${n}`;
  for (let i = 0; i < n; i += step) sig += `,${bytes[i]}`;
  return sig;
}

export function createAssetTextureCache(device: GPUDevice): AssetTextureCache {
  const cache = new Map<string, CachedEntry>();
  const decoding = new Set<string>();
  // Fixed 1x1 placeholder+neutral bytes (4 each), tracked once at creation;
  // `cacheBytes` covers only entries in `cache` (lut/image), added/removed
  // alongside them so it never drifts from what's actually allocated.
  let cacheBytes = 8;

  const placeholderTexture = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: placeholderTexture },
    new Uint8Array([0, 0, 0, 0]),
    { bytesPerRow: 4 },
    { width: 1, height: 1 },
  );
  const placeholderView = placeholderTexture.createView();

  const neutralTexture = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: neutralTexture },
    new Uint8Array([128, 128, 128, 255]),
    { bytesPerRow: 4 },
    { width: 1, height: 1 },
  );
  const neutralView = neutralTexture.createView();

  function uploadLut(asset: Extract<AssetJSON, { type: 'lut' }>): { texture: GPUTexture; view: GPUTextureView; bytes: number } {
    const n = asset.size;
    const width = n * n;
    const height = n;
    const texture = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture },
      asset.data,
      { bytesPerRow: width * 4, rowsPerImage: height },
      { width, height },
    );
    return { texture, view: texture.createView(), bytes: width * height * 4 };
  }

  /** Removes a cache entry (if present) and un-counts its bytes: the one
   * place `cacheBytes` is decremented, so replace/evict/dispose can't drift
   * out of sync with what's actually destroyed. */
  function dropCached(id: string): void {
    const entry = cache.get(id);
    if (!entry) return;
    entry.texture.destroy();
    cache.delete(id);
    cacheBytes -= entry.bytes;
  }

  function beginImageDecode(id: string, asset: Extract<AssetJSON, { type: 'image' }>, signature: string): void {
    if (decoding.has(id)) return;
    decoding.add(id);
    (async () => {
      const blob = new Blob([asset.data], { type: asset.mime });
      const bitmap = await createImageBitmap(blob);
      const texture = device.createTexture({
        size: [bitmap.width, bitmap.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);
      const bytes = bitmap.width * bitmap.height * 4;
      const prev = cache.get(id);
      cache.set(id, { signature, texture, view: texture.createView(), bytes });
      cacheBytes += bytes;
      if (prev) {
        prev.texture.destroy();
        cacheBytes -= prev.bytes;
      }
    })()
      .catch((err) => console.error(`asset-textures: image decode failed for asset "${id}"`, err))
      .finally(() => decoding.delete(id));
  }

  function resolve(id: string, asset: AssetJSON): PooledBuffer {
    const signature = signatureOf(asset);
    const cached = cache.get(id);
    if (cached && cached.signature === signature) return wrap(cached.texture, cached.view);

    if (asset.type === 'lut') {
      const prevBytes = cached?.bytes ?? 0;
      if (cached) cached.texture.destroy();
      const { texture, view, bytes } = uploadLut(asset);
      cache.set(id, { signature, texture, view, bytes });
      cacheBytes += bytes - prevBytes;
      return wrap(texture, view);
    }
    if (asset.type === 'image') {
      beginImageDecode(id, asset, signature);
      if (cached) return wrap(cached.texture, cached.view);
      return wrap(placeholderTexture, placeholderView);
    }
    throw new Error(`asset-textures: unsupported asset type "${asset.type}" for a chain asset param`);
  }

  function neutral(): PooledBuffer {
    return wrap(neutralTexture, neutralView);
  }

  function evict(liveIds: ReadonlySet<string>): void {
    for (const id of Array.from(cache.keys())) {
      if (!liveIds.has(id)) dropCached(id);
    }
  }

  function bytes(): number {
    return cacheBytes;
  }

  function dispose(): void {
    for (const id of Array.from(cache.keys())) dropCached(id);
    placeholderTexture.destroy();
    neutralTexture.destroy();
    cacheBytes = 0;
  }

  return { resolve, neutral, evict, bytes, dispose };
}

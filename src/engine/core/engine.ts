/**
 * The scheduler: walks the document bottom-up per frame, running each
 * layer's source + chain, compositing onto a per-level accumulator, and
 * recursing for groups. createEngine owns its own Presenter (built from the
 * same bundle/pool it's given) so both live presenting and readback-via-
 * quantised can share one pipeline cache.
 */

import type { DeviceBundle } from '../gpu/interfaces';
import type { BufferPool, RetainedBuffer, PooledBuffer, BufferKey } from '../gpu/pool';
import { WORKING_FORMAT, RENDER_TARGET_USAGE } from '../gpu/pool';
import type { DocumentJSON, LayerNode, Layer } from '../doc/json';
import type { ParamValue } from '../params/schema';
import { layerId, type LayerId, type Seconds } from './types';
import { createPipelineCache } from '../gpu/pipelines';
import { createBindings } from '../gpu/bindings';
import { createPresenter } from '../gpu/present';
import { createFrameContext, UniformRing, type FrameContextImpl } from './frame';
import { createAssetTextureCache } from './asset-textures';
import { runChain } from '../passes/run-chain';
import { sources } from '../registry/sources';
import { blends } from '../registry/blends';
import { resolveParams } from '../params/resolve';
import type { SourceInstance } from '../sources/source';
import { findLayer, evictedLayerIds, liveAssetIds } from '../doc/document';

export interface RenderFrameOpts {
  present?: boolean;
  keepAccumulator?: boolean;
}

export interface RenderFrameResult {
  accumulator: RetainedBuffer | null;
}

/** burn's frame-pull accessor (core/engine.ts's owned addition, see burn/burn.ts). */
export interface RenderSubtreeResult {
  buffer: RetainedBuffer;
  width: number;
  height: number;
}

const BAKED_CLIP_BYTES_PER_PIXEL = 8; // rgba16float
const BAKED_CLIP_RGBA8_BYTES_PER_PIXEL = 4;
// MASKS block: a mask asset is the same raw rgba16float raster layout a
// paint layer's own backing store uses (doc/document.ts's RASTER_BYTES_PER_PIXEL).
const MASK_BYTES_PER_PIXEL = 8;

interface MaskTextureCacheEntry {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  /** assetGeneration value at last upload (see invalidateAsset) plus the
   * ArrayBuffer identity uploaded. A byte-SAMPLING signature was tried
   * first and is unfixable: any fixed stride that divides the row length
   * only ever samples one column, and no sparse sample can guarantee it
   * sees a 1px pencil stamp. In-place mutators must call
   * engine.invalidateAsset(id) (EngineHost additive diff, 2026-07-08);
   * wholesale asset replacement is caught by the buffer-identity check. */
  generation: number;
  uploadedData: ArrayBuffer;
}

/** Owns one persistent (non-pool-scoped) texture per baked-clip layer, so a
 * clip only re-uploads when the sampled frame index actually changes.
 *
 * `staging` only exists for `format: 'rgba8unorm'` clips: frame bytes land
 * there first (sRGB-encoded RGB, straight alpha), then `core.image.blit`
 * (registered by sources/builtin/image.ts) converts srgb->OKLab into
 * `texture`, the same WORKING_FORMAT cache texture `rgba16float` clips
 * write into directly. Without this conversion, rgba8 clip frames would
 * be sRGB bytes reinterpreted as OKLab and render wrong. */
interface ClipTextureCacheEntry {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  frameIndex: number;
  staging?: { texture: GPUTexture; view: GPUTextureView };
}

function resolveOpacity(value: ParamValue, time: Seconds): number {
  const resolved = resolveParams({ opacity: { kind: 'float', default: 1 } }, { opacity: value }, time);
  return resolved.opacity as number;
}

function clear(encoder: GPUCommandEncoder, buf: PooledBuffer): void {
  const rp = encoder.beginRenderPass({
    colorAttachments: [{ view: buf.view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
  });
  rp.end();
}

export function createEngine(bundle: DeviceBundle, pool: BufferPool, doc: DocumentJSON) {
  const { device } = bundle;
  const pipelineCache = createPipelineCache(device);
  const bindings = createBindings(device);
  const presenter = createPresenter(bundle, pool);
  const ring = new UniformRing(device);
  const assetTextures = createAssetTextureCache(device);
  const sourceCache = new Map<string, { type: string; instance: SourceInstance }>();
  const clipTextureCache = new Map<LayerId, ClipTextureCacheEntry>();
  // MASKS block.
  const maskTextureCache = new Map<LayerId, MaskTextureCacheEntry>();
  const maskWarned = new Set<LayerId>();
  /** Per-asset in-place-mutation counters, bumped by invalidateAsset (the
   * EngineHost additive diff mask painting's live preview relies on). */
  const assetGenerations = new Map<string, number>();
  /**
   * MEMORY-EVICTION block: bytes owned by clipTextureCache + maskTextureCache
   * (both raw device.createTexture allocations, never pool-tracked; see
   * their creation sites in sampleBakedClip/resolveMaskTexture). Folded into
   * memoryBytes() below, alongside assetTextures.bytes(), so localHost's
   * memoryStats() actually reflects these caches shrinking on eviction:
   * without this they were invisible to the statusbar/memoryStats reader
   * entirely, evicted or not. */
  let cacheBytes = 0;
  let cachePeakBytes = 0;
  function bumpCacheBytes(delta: number): void {
    cacheBytes += delta;
    if (cacheBytes > cachePeakBytes) cachePeakBytes = cacheBytes;
  }

  function getSource(layer: Layer): SourceInstance {
    const cached = sourceCache.get(layer.id);
    if (cached && cached.type === layer.source.type) return cached.instance;
    if (cached) cached.instance.dispose?.();
    const descriptor = sources.require(layer.source.type);
    // Reads `doc` live (not a snapshot): doc is the same mutable reference
    // localHost mutates in place via applyEdits, so an asset added after
    // this instance is created (e.g. by a stroke's addAsset) still resolves.
    const instance = descriptor.create({ device, pool, getAsset: (id) => doc.assets[id] });
    sourceCache.set(layer.id, { type: layer.source.type, instance });
    return instance;
  }

  /**
   * Narrow internal hook for host-side paint-tool stroke plumbing
   * (localHost.ts beginStroke/strokePoint/endStroke), NOT part of the
   * frozen Source contract. Only returns an instance already created by a
   * prior render pass; a layer that has never rendered (e.g. disabled, or
   * added but not yet drawn) returns undefined.
   */
  function getSourceInstance(layerId: string): SourceInstance | undefined {
    return sourceCache.get(layerId)?.instance;
  }

  /**
   * All currently-cached source instances (across every layer that has
   * rendered at least once). Used by localHost after applyEdits to give
   * stateful sources (raster in particular) a chance to notice their
   * backing doc data changed underneath them (undo/redo included) and
   * resync. Same "not part of the frozen Source contract" caveat as
   * getSourceInstance above.
   */
  function listSourceInstances(): SourceInstance[] {
    return Array.from(sourceCache.values(), (v) => v.instance);
  }

  function canvasKey(width: number, height: number): BufferKey {
    return { width, height, format: WORKING_FORMAT, usage: RENDER_TARGET_USAGE };
  }

  /** Sampled-clip texture, wrapped as a plain (non-pool-tracked) PooledBuffer: read-only input, never `pool.return`ed. */
  function wrapClipTexture(entry: ClipTextureCacheEntry): PooledBuffer {
    return { texture: entry.texture, view: entry.view, key: canvasKey(entry.width, entry.height), generation: 0 };
  }

  /**
   * A `baked` layer's content is a pre-rendered clip, not a live source+chain
   * run: sample the frame nearest `time` (clamped to the clip's range) and
   * upload it to a persistent per-layer texture, re-uploading only when the
   * sampled frame index actually changes. Returns null if the layer isn't
   * baked, or its clip asset is missing/mismatched (falls back to live).
   */
  function clipEntryBytes(entry: Pick<ClipTextureCacheEntry, 'width' | 'height' | 'staging'>): number {
    const base = entry.width * entry.height * BAKED_CLIP_BYTES_PER_PIXEL;
    const staging = entry.staging ? entry.width * entry.height * BAKED_CLIP_RGBA8_BYTES_PER_PIXEL : 0;
    return base + staging;
  }

  function destroyClipEntry(id: LayerId): void {
    const entry = clipTextureCache.get(id);
    if (!entry) return;
    entry.texture.destroy();
    entry.staging?.texture.destroy();
    clipTextureCache.delete(id);
    bumpCacheBytes(-clipEntryBytes(entry));
  }

  function sampleBakedClip(node: Layer, ctx: FrameContextImpl): PooledBuffer | null {
    if (!node.baked) return null;
    const asset = doc.assets[node.baked.clip];
    if (!asset || asset.type !== 'clip' || asset.frames.length === 0) return null;
    const isRgba8 = asset.format === 'rgba8unorm';
    const frameIndex = Math.max(0, Math.min(asset.frames.length - 1, Math.floor(ctx.time * node.baked.fps)));

    let entry = clipTextureCache.get(node.id);
    if (!entry || entry.width !== asset.width || entry.height !== asset.height) {
      if (entry) destroyClipEntry(node.id);
      const texture = device.createTexture({
        size: [asset.width, asset.height],
        format: WORKING_FORMAT,
        usage:
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
      let staging: ClipTextureCacheEntry['staging'];
      if (isRgba8) {
        const stagingTexture = device.createTexture({
          size: [asset.width, asset.height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        staging = { texture: stagingTexture, view: stagingTexture.createView() };
      }
      entry = { texture, view: texture.createView(), width: asset.width, height: asset.height, frameIndex: -1, staging };
      clipTextureCache.set(node.id, entry);
      bumpCacheBytes(clipEntryBytes(entry));
    }
    if (entry.frameIndex !== frameIndex) {
      if (isRgba8 && entry.staging) {
        device.queue.writeTexture(
          { texture: entry.staging.texture },
          asset.frames[frameIndex]!,
          { bytesPerRow: asset.width * BAKED_CLIP_RGBA8_BYTES_PER_PIXEL },
          [asset.width, asset.height],
        );
        // sRGB rgba8 bytes -> OKLab rgba16float: reuse core.image's upload
        // conversion pass (the shader that already does srgb_decode +
        // linear_srgb_to_oklab) rather than a plain blit, so this texture
        // ends up holding what every other buffer in the pipeline holds.
        const stagingBuffer: PooledBuffer = {
          texture: entry.staging.texture,
          view: entry.staging.view,
          key: {
            width: asset.width,
            height: asset.height,
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          },
          generation: 0,
        };
        ctx.runPass('core.image.blit', [stagingBuffer], {}, wrapClipTexture(entry));
      } else {
        device.queue.writeTexture(
          { texture: entry.texture },
          asset.frames[frameIndex]!,
          { bytesPerRow: asset.width * BAKED_CLIP_BYTES_PER_PIXEL },
          [asset.width, asset.height],
        );
      }
      entry.frameIndex = frameIndex;
    }
    return wrapClipTexture(entry);
  }

  /**
   * MASKS block. Resolves a layer's mask asset to a texture, uploading (or
   * re-uploading, when the asset's invalidation generation or its
   * ArrayBuffer identity changed; see MaskTextureCacheEntry) straight from
   * the raw rgba16float bytes exactly like sources/builtin/raster.ts's
   * loadFromAsset does for a layer's own backing store. Missing/wrong-type
   * asset: warns ONCE per layer id (recovers silently once the asset is
   * valid again) and returns null so the caller renders unmasked instead of
   * throwing, the crash-proofing doctrine (see src/engine/CLAUDE.md).
   */
  function destroyMaskEntry(id: LayerId): void {
    const entry = maskTextureCache.get(id);
    if (!entry) return;
    entry.texture.destroy();
    maskTextureCache.delete(id);
    maskWarned.delete(id);
    bumpCacheBytes(-(entry.width * entry.height * MASK_BYTES_PER_PIXEL));
  }

  function resolveMaskTexture(node: Layer): PooledBuffer | null {
    const mask = node.mask;
    if (!mask) return null;
    const asset = doc.assets[mask.asset];
    if (!asset || asset.type !== 'raster') {
      if (!maskWarned.has(node.id)) {
        console.warn(`[gdesign] layer '${node.id}' mask asset '${mask.asset}' is missing or not a raster asset, rendering unmasked`);
        maskWarned.add(node.id);
      }
      return null;
    }
    maskWarned.delete(node.id);

    const currentGen = assetGenerations.get(mask.asset) ?? 0;
    let entry = maskTextureCache.get(node.id);
    if (!entry || entry.width !== asset.width || entry.height !== asset.height) {
      if (entry) destroyMaskEntry(node.id);
      const texture = device.createTexture({
        size: [asset.width, asset.height],
        format: WORKING_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      entry = { texture, view: texture.createView(), width: asset.width, height: asset.height, generation: -1, uploadedData: new ArrayBuffer(0) };
      maskTextureCache.set(node.id, entry);
      bumpCacheBytes(entry.width * entry.height * MASK_BYTES_PER_PIXEL);
    }
    if (entry.generation !== currentGen || entry.uploadedData !== asset.data) {
      device.queue.writeTexture(
        { texture: entry.texture },
        asset.data,
        { bytesPerRow: asset.width * MASK_BYTES_PER_PIXEL },
        [asset.width, asset.height],
      );
      entry.generation = currentGen;
      entry.uploadedData = asset.data;
    }
    return { texture: entry.texture, view: entry.view, key: canvasKey(entry.width, entry.height), generation: 0 };
  }

  /**
   * One node's own content: source (or, for a group, its composited
   * children) run through its chain, then (layers only) its mask if enabled,
   * WITHOUT blend/opacity, which are only meaningful when compositing
   * this result onto a parent accumulator. Shared by renderNodes (the
   * per-frame scheduler) and renderSubtree (burn's frame-pull accessor), so
   * burning a layer captures exactly what the scheduler would have produced
   * for it (mask included).
   */
  function renderNodeContent(
    node: LayerNode,
    ctx: FrameContextImpl,
    width: number,
    height: number,
    borrow: (k: BufferKey) => PooledBuffer,
  ): PooledBuffer {
    if (node.kind === 'group') {
      const groupAcc = renderNodes(node.children, ctx, width, height, borrow);
      return runChain(node.chain, groupAcc, ctx);
    }

    let content: PooledBuffer | undefined;
    if (node.liveness === 'baked') {
      content = sampleBakedClip(node, ctx) ?? undefined;
    }
    if (!content) {
      const target = borrow(canvasKey(width, height));
      const instance = getSource(node);
      const sourceDesc = sources.require(node.source.type);
      const resolvedSourceParams = resolveParams(sourceDesc.params, node.source.params, ctx.time);
      instance.render(ctx, resolvedSourceParams, target);
      content = runChain(node.chain, target, ctx);
    }

    if (node.mask?.enabled) {
      const maskTex = resolveMaskTexture(node);
      if (maskTex) {
        const masked = borrow(canvasKey(width, height));
        ctx.runPass('core.mask-apply', [content, maskTex], { invert: !!node.mask.invert }, masked);
        content = masked;
      }
    }
    return content;
  }

  function renderNodes(
    nodes: LayerNode[],
    ctx: FrameContextImpl,
    width: number,
    height: number,
    borrow: (k: BufferKey) => PooledBuffer,
  ): PooledBuffer {
    let accumulator = borrow(canvasKey(width, height));
    clear(ctx.encoder, accumulator);

    for (const node of nodes) {
      if (!node.enabled) continue;

      // FX-BLENDGEN block additive diff (2026-07-07, architect-approved):
      // sources that opt in via wantsBackdrop get the current accumulator
      // (everything below this node, already composited, this frame) just
      // before they render. `accumulator` is a pool-scoped scratch buffer:
      // the instance must not retain it past its render() call (see
      // sources/source.ts's setBackdrop doc comment).
      if (node.kind === 'layer' && node.liveness !== 'baked') {
        const sourceDesc = sources.require(node.source.type);
        if (sourceDesc.wantsBackdrop) {
          getSource(node).setBackdrop?.(accumulator);
        }
      }

      // ADJUST block (own this branch; see gdesign-wt/adjust): a Layer whose
      // source.type is the core.adjustment sentinel applies its OWN chain to
      // the CURRENT accumulator (everything already composited below it)
      // instead of rendering its own content. The chained result then
      // composites over the pre-chain accumulator via the ordinary
      // core.composite step below, so blendMode/opacity behave exactly like
      // any other layer (opacity 0.5 = half-strength adjustment). An empty
      // chain composites the accumulator over itself, a no-op. Baked/
      // liveness paths never apply here (adjustment layers can't be baked):
      // this branch runs unconditionally for the sentinel type. Standalone
      // rendering (renderSubtree/burn, via renderNodeContent) does NOT take
      // this branch and instead gets the chain applied to the source's own
      // transparent fallback render (see adjustment.ts and src/engine/CLAUDE.md).
      const layerOut = node.kind === 'layer' && node.source.type === 'core.adjustment'
        ? runChain(node.chain, accumulator, ctx)
        : renderNodeContent(node, ctx, width, height, borrow);

      const blendDef = blends.require(node.blendMode);
      const opacity = resolveOpacity(node.opacity, ctx.time);
      const composited = borrow(canvasKey(width, height));
      ctx.runPass(
        'core.composite',
        [accumulator, layerOut],
        { opacity },
        composited,
        blendDef.wgsl,
        node.blendMode,
      );
      accumulator = composited;
    }

    return accumulator;
  }

  /**
   * burn's frame-pull accessor: renders a single layer's own content (source
   * + chain, no blend/opacity; see renderNodeContent) at an arbitrary time,
   * independent of the live clock, and retains the result past this frame's
   * pool scope so the caller can read it back asynchronously. Not part of
   * the frozen Source/EngineHost contracts, internal to localHost's burn().
   * Returns null if `target` doesn't resolve to a layer (e.g. a group, an
   * ObjectId, or an unknown id) in the current document.
   */
  function renderSubtree(target: LayerId, time: Seconds, frame: number): RenderSubtreeResult | null {
    const found = findLayer(doc, target);
    if (!found || found.node.kind !== 'layer') return null;

    const width = doc.canvas.width;
    const height = doc.canvas.height;
    ring.beginFrame();
    const encoder = device.createCommandEncoder();
    let retained: RetainedBuffer | null = null;

    pool.scope((borrow) => {
      const ctx = createFrameContext({
        device, encoder, pool, time, frame, pipelineCache, bindings, ring,
        getAsset: (id) => doc.assets[id],
        assetTextures,
        borrow,
      });
      const buf = renderNodeContent(found.node, ctx, width, height, borrow);
      try {
        retained = pool.retain(buf);
      } catch {
        // Not a pool-tracked buffer: the sampled-clip path (re-burning an
        // already-baked layer). The clip texture cache owns its lifetime
        // regardless of release(), so a no-op release is correct here.
        retained = { ...buf, release() {} };
      }
      device.queue.submit([encoder.finish()]);
    });

    return retained ? { buffer: retained, width, height } : null;
  }

  function renderFrame(time: Seconds, frame: number, opts: RenderFrameOpts = {}): RenderFrameResult {
    ring.beginFrame();
    const encoder = device.createCommandEncoder();
    let retained: RetainedBuffer | null = null;

    // pool.scope()'s auto-cleanup destroys every non-retained scratch buffer
    // synchronously the instant this callback returns, before the caller
    // gets a chance to submit. Textures destroy()'d before their recording
    // encoder is submitted invalidate that encoder's commands, so submit
    // MUST happen in here, as the last thing before the callback returns.
    pool.scope((borrow) => {
      const ctx = createFrameContext({
        device, encoder, pool, time, frame, pipelineCache, bindings, ring,
        getAsset: (id) => doc.assets[id],
        assetTextures,
        borrow,
      });
      const width = doc.canvas.width;
      const height = doc.canvas.height;

      let acc = renderNodes(doc.layers, ctx, width, height, borrow);
      acc = runChain(doc.postChain, acc, ctx);

      // Submit the frame's rendering BEFORE presenting: present() records and
      // submits its own encoder, and it samples the accumulator. Presenting
      // first would put the present pass on the queue ahead of the commands
      // that draw the accumulator's contents, showing a stale/blank frame on
      // real hardware. (Readback-based tests never caught this: they don't
      // present. See tests/e2e/present.spec.ts.)
      device.queue.submit([encoder.finish()]);

      if (opts.present) {
        presenter.present(acc, time, frame);
      }
      if (opts.keepAccumulator) {
        retained = pool.retain(acc);
      }
    });

    return { accumulator: retained };
  }

  /** See EngineHost.invalidateAsset: in-place byte mutators (mask painting)
   * bump the asset's generation so derived textures re-upload next resolve. */
  function invalidateAsset(id: string): void {
    assetGenerations.set(id, (assetGenerations.get(id) ?? 0) + 1);
  }

  /**
   * MEMORY-EVICTION block. Called by localHost.ts's applyEdits right after
   * every edit batch (forward, undo, AND redo: all three go through that
   * one channel), so a layer/asset dropped by any of the three gets its GPU
   * resources released on the very next call, not just piled up until the
   * next full dispose()/rebuildEngine(). Deliberately reads `doc` live (the
   * same mutable reference every other doc-aware function in this file
   * closes over) rather than taking a doc argument: there is only ever one
   * document this engine renders, and passing it would just invite it to
   * drift from the one actually rendered.
   *
   * Undo needs no special-cased "recreate": sourceCache/clipTextureCache/
   * maskTextureCache are all populated lazily (getSource/sampleBakedClip/
   * resolveMaskTexture each check-then-create on their own), so a layer
   * un-deleted by undo just looks like a layer rendering for the first
   * time to the next renderFrame(): exactly the boot-time path, not a
   * separate one.
   */
  function reconcile(): void {
    // sourceCache is keyed by plain string (getSourceInstance's public
    // surface takes one), not LayerId. Re-brand for the shared walk, which
    // only ever compares it against doc-derived ids anyway.
    for (const id of evictedLayerIds(doc, Array.from(sourceCache.keys(), layerId))) {
      sourceCache.get(id)!.instance.dispose?.();
      sourceCache.delete(id);
    }
    for (const id of evictedLayerIds(doc, clipTextureCache.keys())) destroyClipEntry(id);
    for (const id of evictedLayerIds(doc, maskTextureCache.keys())) destroyMaskEntry(id);
    // assetGenerations is bookkeeping (a per-asset upload counter), not a
    // GPU handle. Dropped once the asset itself no longer exists in the
    // document at all, regardless of whether anything currently references
    // it (a re-added asset with the same id legitimately starts fresh).
    for (const id of Array.from(assetGenerations.keys())) {
      if (!doc.assets[id]) assetGenerations.delete(id);
    }
    assetTextures.evict(liveAssetIds(doc));
  }

  /** Live GPU bytes this engine owns OUTSIDE the buffer pool (clip/mask
   * texture caches here + core/asset-textures.ts's own cache), folded into
   * localHost's memoryStats() alongside pool.stats() so eviction above is
   * actually observable, not just an internal accounting change. assetTextures'
   * own bytes have no separate peak tracked (its cache only ever shrinks via
   * evict()/dispose(), both explicit, not the ambient churn a running peak is
   * for): cachePeakBytes plus its CURRENT bytes is a legitimate lower bound
   * on the true historical peak, same spirit as pool.stats().peakBytes never
   * dropping. */
  function memoryBytes(): { bytes: number; peakBytes: number } {
    const assetBytes = assetTextures.bytes();
    return { bytes: cacheBytes + assetBytes, peakBytes: cachePeakBytes + assetBytes };
  }

  /** Frees every GPU resource this engine owns. localHost calls this before
   * replacing the engine (loadDocument) and on host dispose. Without it,
   * each document load stacked a full pipeline's textures in memory, which
   * on unified-memory machines (Apple Silicon) degrades the whole system,
   * not just the tab. The engine is unusable afterwards. */
  function dispose(): void {
    for (const { instance } of sourceCache.values()) instance.dispose?.();
    sourceCache.clear();
    for (const id of Array.from(clipTextureCache.keys())) destroyClipEntry(id);
    for (const id of Array.from(maskTextureCache.keys())) destroyMaskEntry(id);
    assetTextures.dispose();
    ring.dispose();
  }

  return {
    renderFrame, presenter, getSourceInstance, listSourceInstances, renderSubtree,
    invalidateAsset, reconcile, memoryBytes, dispose,
  };
}

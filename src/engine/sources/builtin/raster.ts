import type { SourceDescriptor, SourceInstance, SourceCreateContext, FrameContext } from '../source';
import type { ResolvedParams } from '../../params/schema';
import type { PooledBuffer } from '../../gpu/pool';
import type { AssetRef, Rect } from '../../core/types';
import type { PassDescriptor } from '../../passes/pass';
import type { AssetJSON } from '../../doc/json';
import type { StrokeConfig, StrokePoint } from '../../host/protocol';
import { effects } from '../../registry/effects';
import { StrokeBatcher, strokeBounds, type StrokeBatchPoint } from './stroke-batch';

const BYTES_PER_PIXEL = 8; // rgba16float

/**
 * Stamps a capsule segment (a -> b) into input0 (the previous backing
 * state), with round-falloff coverage, and composites it onto the result:
 * 'paint' porter-duff-overs params.color, 'erase' scales down alpha instead.
 * `a`/`b`/`size` are in pixel space (matches engine.width/height).
 */
const rasterStampPass: PassDescriptor = {
  id: 'core.raster-stamp',
  label: 'Raster stamp (internal)',
  kind: 'render',
  wgsl: `
fn sd_segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let prev = textureSample(input0, samp0, in.uv);
  let px = in.uv * vec2f(engine.width, engine.height);
  let d = sd_segment(px, params.a, params.b);
  let r = max(params.size * 0.5, 0.0001);
  let coverage = 1.0 - smoothstep(r - 1.0, r + 1.0, d);
  if (params.mode == 0u) {
    let stamp = vec4f(params.color.xyz, params.color.a * coverage);
    return porter_duff_over(prev, stamp);
  }
  return vec4f(prev.xyz, prev.a * (1.0 - coverage));
}
`,
  includes: ['blend'],
  inputs: [{ name: 'input0' }],
  params: {
    a: { kind: 'vec2', default: [0, 0] },
    b: { kind: 'vec2', default: [0, 0] },
    size: { kind: 'float', default: 8, min: 0.1, max: 4096 },
    color: { kind: 'color', default: [0.6, 0.1, -0.05, 1], space: 'oklab' },
    mode: { kind: 'enum', default: 'paint', options: ['paint', 'erase'] },
  },
  metadata: { category: 'core', description: 'Capsule brush stamp into a raster backing store.' },
};

if (!effects.get(rasterStampPass.id)) {
  effects.register(rasterStampPass);
}

interface OwnedTexture {
  texture: GPUTexture;
  view: GPUTextureView;
}

function makeBacking(device: GPUDevice, width: number, height: number): OwnedTexture {
  const texture = device.createTexture({
    size: [width, height],
    format: 'rgba16float',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST,
  });
  return { texture, view: texture.createView() };
}

/** Clears a texture to transparent black outside of any frame's encoder, used once at creation. */
function clearToTransparent(device: GPUDevice, tex: OwnedTexture): void {
  const enc = device.createCommandEncoder();
  const rp = enc.beginRenderPass({
    colorAttachments: [{ view: tex.view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
  });
  rp.end();
  device.queue.submit([enc.finish()]);
}

function wrap(tex: OwnedTexture, width: number, height: number): PooledBuffer {
  return {
    texture: tex.texture,
    view: tex.view,
    key: { width, height, format: 'rgba16float', usage: tex.texture.usage },
    generation: 0,
  };
}

const BYTES_PER_ROW_ALIGN = 256;

/**
 * Raw (un-decoded) rgba16float bytes readback: matches AssetJSON('raster'/
 * 'clip').data's layout exactly. Exported for reuse by burn/burn.ts, which
 * needs the same raw layout for baked raster/clip assets (not the decoded
 * Float32Array gpu/readback.ts's ReadbackOps.readFloat returns).
 *
 * `origin` (default 0,0) reads a sub-rect of `texture` instead of starting
 * at its top-left corner. `width`/`height` are the SIZE of that rect, not
 * the full texture's dimensions. Used by the raster source's stroke readback
 * to pull back only a stroke's bounding box instead of the whole canvas.
 */
export async function readRawRgba16f(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  origin: { x: number; y: number } = { x: 0, y: 0 },
): Promise<ArrayBuffer> {
  const unpaddedBytesPerRow = width * BYTES_PER_PIXEL;
  const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / BYTES_PER_ROW_ALIGN) * BYTES_PER_ROW_ALIGN;
  const buffer = device.createBuffer({
    size: paddedBytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture, origin: { x: origin.x, y: origin.y, z: 0 } },
    { buffer, bytesPerRow: paddedBytesPerRow },
    [width, height],
  );
  device.queue.submit([enc.finish()]);

  await buffer.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();

  if (paddedBytesPerRow === unpaddedBytesPerRow) return mapped.buffer;
  const out = new Uint8Array(unpaddedBytesPerRow * height);
  for (let y = 0; y < height; y++) {
    out.set(mapped.subarray(y * paddedBytesPerRow, y * paddedBytesPerRow + unpaddedBytesPerRow), y * unpaddedBytesPerRow);
  }
  return out.buffer;
}

export interface RasterReadback {
  /** Bytes for exactly `width` x `height`: the requested region, or the full backing store when none was given. */
  data: ArrayBuffer;
  width: number;
  height: number;
  /** Full backing-store dimensions regardless of what region (if any) was requested, needed to size a brand-new asset. */
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Extra surface localHost's stroke API drives, layered onto the plain
 * SourceInstance duck-type via isRasterStrokeInstance() below. Not part of
 * the frozen Source contract (source.ts): deliberately internal, since only
 * the raster source and its host-side stroke plumbing need it.
 */
export interface RasterStrokeInstance extends SourceInstance {
  beginStroke(config: StrokeConfig): void;
  strokePoint(p: StrokePoint): void;
  /** Marks the stroke finished; the pending batch still flushes on the next render(). */
  endStroke(): void;
  /**
   * Bounding box of every point pushed since the last beginStroke, expanded
   * by that stroke's brush size and clamped to the canvas. Null if the
   * stroke had no points (or the backing store doesn't exist yet). Valid
   * after endStroke(), before the next beginStroke() resets it.
   */
  strokeBounds(): Rect | null;
  /** Reads back the current backing store, or just `region` when given. Call after a render() has drained any pending stamps. */
  readBack(region?: Rect): Promise<RasterReadback>;
  /**
   * Marks the GPU backing as stale relative to doc.assets: the next
   * render() re-uploads from the asset's bytes instead of trusting the
   * texture. Needed because applyEdits (undo/redo included) can change
   * doc.assets out from under an already-live SourceInstance: commitRaster's
   * inverse mutates asset.data's bytes in place (same ArrayBuffer identity),
   * so there's no cheap reference check. A host-driven invalidate is the
   * simplest correct fix. localHost calls this for every applied edit batch
   * (see localHost.ts's applyEdits), which is the one channel all mutation
   * (forward, undo, redo) already goes through.
   */
  invalidateAsset(): void;
}

export function isRasterStrokeInstance(inst: SourceInstance): inst is RasterStrokeInstance {
  return typeof (inst as Partial<RasterStrokeInstance>).beginStroke === 'function';
}

export const raster: SourceDescriptor = {
  id: 'core.raster',
  label: 'Raster',
  params: {
    // Reuses the 'asset' param kind (frozen to assetType 'image'|'lut'|'font')
    // to store a reference to a doc.assets entry. The entry itself is type
    // 'raster', not 'image'; assetType here is UI/menu metadata only, never
    // checked at runtime against AssetJSON.type.
    asset: { kind: 'asset', assetType: 'image', label: 'Raster' },
  },
  liveByDefault: false,
  create(ctx: SourceCreateContext): RasterStrokeInstance {
    let front: OwnedTexture | null = null;
    let back: OwnedTexture | null = null;
    let width = 0;
    let height = 0;

    const batcher = new StrokeBatcher();
    let activeConfig: StrokeConfig | null = null;
    let dirty = false;
    // Full-stroke point history + brush size, independent of `batcher`'s
    // pending queue (which drains on every render() during the stroke, so
    // it can't answer "what did this whole stroke touch?" by endStroke
    // time). Reset at beginStroke, read via strokeBounds() after endStroke.
    let strokePoints: StrokeBatchPoint[] = [];
    let strokeBrushSize = 0;

    /** (Re)loads front from the doc asset's bytes, or clears it if absent/mismatched. */
    function loadFromAsset(assetRef: AssetRef | undefined): void {
      if (!front) return;
      clearToTransparent(ctx.device, front);
      const asset = assetRef ? (ctx.getAsset(assetRef.asset) as AssetJSON | undefined) : undefined;
      if (asset && asset.type === 'raster' && asset.width === width && asset.height === height) {
        ctx.device.queue.writeTexture({ texture: front.texture }, asset.data, { bytesPerRow: width * BYTES_PER_PIXEL }, [width, height]);
      }
    }

    function ensureBacking(w: number, h: number, assetRef: AssetRef | undefined): void {
      if (front) return;
      width = w;
      height = h;
      front = makeBacking(ctx.device, w, h);
      back = makeBacking(ctx.device, w, h);
      clearToTransparent(ctx.device, back);
      loadFromAsset(assetRef);
    }

    function stampSegment(frameCtx: FrameContext, seg: { a: readonly [number, number]; b: readonly [number, number] }): void {
      if (!front || !back) return;
      const params: ResolvedParams = {
        a: seg.a,
        b: seg.b,
        size: activeConfig?.size ?? 8,
        color: activeConfig?.color ?? [0.6, 0.1, -0.05, 1],
        mode: activeConfig?.mode ?? 'paint',
      };
      frameCtx.runPass(rasterStampPass.id, [wrap(front, width, height)], params, wrap(back, width, height));
      const swap = front;
      front = back;
      back = swap;
    }

    return {
      render(frameCtx: FrameContext, params: ResolvedParams, target: PooledBuffer) {
        const assetRef = params.asset as AssetRef | undefined;
        ensureBacking(target.key.width, target.key.height, assetRef);
        if (dirty) {
          loadFromAsset(assetRef);
          dirty = false;
        }
        for (const seg of batcher.drain()) {
          stampSegment(frameCtx, seg);
        }
        frameCtx.runPass('core.blit', [wrap(front!, width, height)], {}, target);
      },

      dispose() {
        front?.texture.destroy();
        back?.texture.destroy();
        front = null;
        back = null;
      },

      beginStroke(config: StrokeConfig) {
        activeConfig = config;
        batcher.begin();
        strokePoints = [];
        strokeBrushSize = config.size;
      },

      strokePoint(p: StrokePoint) {
        if (!activeConfig) return;
        batcher.push(p);
        strokePoints.push({ x: p.x, y: p.y });
      },

      endStroke() {
        // Nothing to do synchronously: any points already pushed stay
        // queued and flush on the next render(); readBack() is called
        // after that render happens. strokePoints/strokeBrushSize are
        // deliberately left intact here (not cleared until the NEXT
        // beginStroke) so strokeBounds() can still answer for this stroke.
        activeConfig = null;
      },

      strokeBounds(): Rect | null {
        if (!front) return null;
        return strokeBounds(strokePoints, strokeBrushSize, width, height);
      },

      async readBack(region?: Rect): Promise<RasterReadback> {
        if (!front) return { data: new ArrayBuffer(0), width: 0, height: 0, canvasWidth: 0, canvasHeight: 0 };
        const rw = region?.width ?? width;
        const rh = region?.height ?? height;
        const data = await readRawRgba16f(ctx.device, front.texture, rw, rh, region ? { x: region.x, y: region.y } : undefined);
        return { data, width: rw, height: rh, canvasWidth: width, canvasHeight: height };
      },

      invalidateAsset() {
        dirty = true;
      },
    };
  },
};

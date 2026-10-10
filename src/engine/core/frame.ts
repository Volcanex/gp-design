/**
 * FrameContext implementation: wraps the encoder/pool/time/frame for one
 * render, and is the thing sources/effects actually call through. runPass()
 * assembles a pass's shader (engine struct + generated Params struct +
 * resolved includes + an optional caller-supplied splice, e.g. a blend
 * mode's `fn blend`), allocates a slice of the uniform ring, packs Engine +
 * Params into it, and records a render/compute pass on the shared encoder.
 *
 * `runPass`'s public shape matches the frozen FrameContext.runPass: sources
 * only ever call it with four args. engine.ts (same track, own file) uses
 * the extra optional `extraSplice`/`variantKey` args below to run
 * core.composite with the active layer's blend-mode function spliced in;
 * that isn't expressible through the frozen 4-arg signature because blend
 * mode is a per-call choice, not part of the PassDescriptor.
 */

import type { FrameContext } from '../sources/source';
import type { BufferKey, PooledBuffer, BufferPool } from '../gpu/pool';
import type { PipelineCache, BindingsFactory } from '../gpu/interfaces';
import type { ResolvedParams } from '../params/schema';
import type { PassDescriptor } from '../passes/pass';
import type { AssetJSON } from '../doc/json';
import type { AssetRef, Seconds } from './types';
import type { AssetTextureCache } from './asset-textures';
import { effects } from '../registry/effects';
import { paramsUbo, engineStructWgsl } from '../gpu/params-ubo';
import { resolveIncludes } from '../wgsl/include-impl';

const ENGINE_UNIFORM_SIZE = 16;
const UNIFORM_ALIGN = 256;
// Each buffer-binding *offset* must independently satisfy the uniform
// alignment (256 on this backend), not just the outer ring allocation, so
// Params can't simply start right after Engine's 16 bytes. Reserve a full
// 256-byte slot for Engine and start Params at the next 256 boundary.
// bindings.ts (gpu/bindings.ts) must agree on this same layout.
const PARAMS_SLOT_OFFSET = 256;

/** Grows within a frame without invalidating bind groups already recorded
 * on that frame's encoder: retired buffers are only destroyed at the start
 * of the NEXT frame, once the previous frame's submission has been queued. */
export class UniformRing {
  private buffer: GPUBuffer;
  private capacity: number;
  private cursor = 0;
  private retired: GPUBuffer[] = [];

  constructor(private device: GPUDevice, initial = 64 * 1024) {
    this.capacity = initial;
    this.buffer = device.createBuffer({ size: initial, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  get current(): GPUBuffer {
    return this.buffer;
  }

  alloc(size: number): number {
    const aligned = Math.ceil(this.cursor / UNIFORM_ALIGN) * UNIFORM_ALIGN;
    if (aligned + size > this.capacity) {
      const newCap = Math.max(this.capacity * 2, aligned + size);
      const newBuf = this.device.createBuffer({ size: newCap, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.retired.push(this.buffer);
      this.buffer = newBuf;
      this.capacity = newCap;
    }
    this.cursor = aligned + size;
    return aligned;
  }

  write(offset: number, data: ArrayBuffer): void {
    this.device.queue.writeBuffer(this.buffer, offset, data);
  }

  /** Call once at the start of each frame, before any alloc(). */
  beginFrame(): void {
    for (const b of this.retired) b.destroy();
    this.retired = [];
    this.cursor = 0;
  }

  dispose(): void {
    for (const b of this.retired) b.destroy();
    this.retired = [];
    this.buffer.destroy();
  }
}

export interface FrameContextImpl extends FrameContext {
  runPass(
    pass: string,
    inputs: PooledBuffer[],
    params: ResolvedParams,
    target: PooledBuffer,
    extraSplice?: string,
    variantKey?: string,
  ): void;
}

export interface FrameContextDeps {
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  pool: BufferPool;
  time: Seconds;
  frame: number;
  pipelineCache: PipelineCache;
  bindings: BindingsFactory;
  ring: UniformRing;
  getAsset: (id: string) => AssetJSON | undefined;
  assetTextures: AssetTextureCache;
  /** The enclosing pool.scope()'s tracked borrow. Required in practice:
   * without it scratch buffers escape scope cleanup (see borrowScratch). */
  borrow?: (key: BufferKey) => PooledBuffer;
}

/** Resolves a pass's `asset`-kind params (sorted keys, same order bindings.ts's
 * assetInputsOf appends them in) to bound textures, so runPass's inputs array
 * lines up with the group(1) layout bindings.ts/pipelines.ts already build.
 * An unset asset param (legitimate: resolve.ts leaves 'asset' keys absent
 * with no default) falls back to assetTextures.neutral(), a 1x1 mid-grey
 * texture, rather than throwing: core.displacement relies on this for its
 * documented "no map set == identity" behaviour. A *set* param pointing at
 * an asset id that isn't in the document is still a real error and throws. */
function resolveAssetInputs(
  desc: PassDescriptor,
  params: ResolvedParams,
  getAsset: (id: string) => AssetJSON | undefined,
  assetTextures: AssetTextureCache,
): PooledBuffer[] {
  const assetKeys = Object.keys(desc.params).filter((k) => desc.params[k]!.kind === 'asset').sort();
  return assetKeys.map((key) => {
    const value = params[key] as AssetRef | undefined;
    // No ref set yet (e.g. a freshly-added core.lut/core.displacement
    // instance, before the user has picked an asset in the picker; see
    // ui/forms/params-form.ts's assetRow) or a ref pointing at nothing
    // (a dangling asset id) both fall back to a neutral texture rather than
    // throwing and killing the whole render. See asset-textures.ts's
    // neutral() doc comment.
    if (!value || typeof value !== 'object' || !('asset' in value)) {
      return assetTextures.neutral();
    }
    const assetJson = getAsset(value.asset);
    if (!assetJson) {
      return assetTextures.neutral();
    }
    return assetTextures.resolve(value.asset, assetJson);
  });
}

export function createFrameContext(deps: FrameContextDeps): FrameContextImpl {
  const { device, encoder, pool, time, frame, pipelineCache, bindings, ring, getAsset, assetTextures } = deps;
  const borrow = deps.borrow ?? ((k: BufferKey) => pool.borrow(k));

  function runPass(
    pass: string,
    inputs: PooledBuffer[],
    params: ResolvedParams,
    target: PooledBuffer,
    extraSplice = '',
    variantKey = 'default',
  ): void {
    const desc = effects.require(pass);
    const extraWgsl = [
      engineStructWgsl,
      paramsUbo.structWgsl(desc.params),
      resolveIncludes(desc.includes ?? []),
      extraSplice,
    ].join('\n');

    const paramsSize = paramsUbo.byteSize(desc.params);
    const totalSize = PARAMS_SLOT_OFFSET + paramsSize;
    const offset = ring.alloc(totalSize);

    const engineData = new ArrayBuffer(ENGINE_UNIFORM_SIZE);
    const engineView = new DataView(engineData);
    engineView.setFloat32(0, time, true);
    engineView.setUint32(4, frame, true);
    engineView.setFloat32(8, target.key.width, true);
    engineView.setFloat32(12, target.key.height, true);
    ring.write(offset, engineData);

    const paramsData = new ArrayBuffer(paramsSize);
    paramsUbo.pack(desc.params, params, new DataView(paramsData));
    ring.write(offset + PARAMS_SLOT_OFFSET, paramsData);

    const allInputs = [...inputs, ...resolveAssetInputs(desc, params, getAsset, assetTextures)];

    const groups = bindings.groupsFor(
      desc,
      ring.current,
      offset,
      totalSize,
      allInputs,
      desc.kind === 'compute' ? target : undefined,
    );

    if (desc.kind === 'render') {
      const pipeline = pipelineCache.render(desc, target.key.format, variantKey, extraWgsl);
      const rp = encoder.beginRenderPass({
        colorAttachments: [{ view: target.view, loadOp: 'clear', storeOp: 'store' }],
      });
      rp.setPipeline(pipeline);
      groups.forEach((g, i) => rp.setBindGroup(i, g));
      rp.draw(3);
      rp.end();
    } else {
      const pipeline = pipelineCache.compute(desc, variantKey, extraWgsl);
      const cp = encoder.beginComputePass();
      cp.setPipeline(pipeline);
      groups.forEach((g, i) => cp.setBindGroup(i, g));
      cp.dispatchWorkgroups(Math.ceil(target.key.width / 8), Math.ceil(target.key.height / 8));
      cp.end();
    }
  }

  return {
    device,
    encoder,
    pool,
    time,
    frame,
    runPass,
    // Through the SCOPE's tracked borrow, never pool.borrow directly: an
    // untracked borrow is never returned when the scope ends, so every
    // chain step leaked one full-canvas texture per frame (found 2026-09,
    // the likely cause of "gdesign freezes once I add an effect").
    borrowScratch(like) {
      return borrow(like.key);
    },
  };
}

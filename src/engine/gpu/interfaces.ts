/**
 * FROZEN CONTRACT (F0). The seam between the GPU substrate (track A, which
 * implements these) and the scheduler/host (track D, which consumes them).
 */

import type { EngineCaps } from '../core/types';
import type { PassDescriptor } from '../passes/pass';
import type { ParamsSchema, ResolvedParams } from '../params/schema';
import type { BufferPool, PooledBuffer } from './pool';

export interface DeviceBundle {
  device: GPUDevice;
  /** Null when initialised headless (tests, export-only). */
  context: GPUCanvasContext | null;
  caps: EngineCaps;
  presentFormat: GPUTextureFormat;
}

/** gpu/device.ts */
export type InitDevice = (
  canvas: HTMLCanvasElement | OffscreenCanvas | null,
  outputColorSpace: 'srgb' | 'display-p3',
) => Promise<DeviceBundle>;

/** gpu/pool-impl.ts */
export type CreateBufferPool = (device: GPUDevice) => BufferPool;

/**
 * gpu/pipelines.ts: pipelines cached by (desc.id, target, variantKey).
 * extraWgsl is spliced before the pass body (blend fn, generated Params
 * struct, resolved includes); it must be part of variantKey's identity.
 */
export interface PipelineCache {
  render(desc: PassDescriptor, target: GPUTextureFormat, variantKey: string,
         extraWgsl: string): GPURenderPipeline;
  compute(desc: PassDescriptor, variantKey: string, extraWgsl: string): GPUComputePipeline;
}
export type CreatePipelineCache = (device: GPUDevice) => PipelineCache;

/**
 * gpu/params-ubo.ts: schema → WGSL struct text + packed bytes.
 * Layout must match std140-compatible uniform rules; unit-tested on CPU.
 */
export interface ParamsUbo {
  /** `struct Params { ... }` text for splicing into shaders. */
  structWgsl(schema: ParamsSchema): string;
  byteSize(schema: ParamsSchema): number;
  pack(schema: ParamsSchema, values: ResolvedParams, out: DataView): void;
}

/**
 * gpu/bindings.ts: derives bind group layout + groups from the fixed
 * binding convention documented in passes/pass.ts.
 */
export interface BindingsFactory {
  layoutFor(desc: PassDescriptor): GPUBindGroupLayout[];
  groupsFor(desc: PassDescriptor, uniforms: GPUBuffer, uniformsOffset: number,
            uniformsSize: number, inputs: PooledBuffer[],
            computeTarget?: PooledBuffer): GPUBindGroup[];
}

/** gpu/readback.ts: owns 256-byte bytesPerRow padding/unpadding. */
export interface ReadbackOps {
  readFloat(texture: GPUTexture, width: number, height: number): Promise<Float32Array>;
  readUnorm8(texture: GPUTexture, width: number, height: number): Promise<Uint8Array>;
}
export type CreateReadback = (device: GPUDevice) => ReadbackOps;

/**
 * gpu/present.ts: the final OKLab accumulator → display path:
 * OKLab → linear display primaries → blue-noise dither → transfer encode →
 * swapchain (or an offscreen rgba8unorm target for export/tests, which must
 * be the IDENTICAL pass chain so exported pixels = seen pixels).
 */
export interface Presenter {
  present(accumulator: PooledBuffer, time: number, frame: number): void;
  /** Same conversion into an offscreen 8-bit target; caller owns the buffer. */
  toQuantised(accumulator: PooledBuffer, pool: BufferPool): PooledBuffer;
}
export type CreatePresenter = (bundle: DeviceBundle, pool: BufferPool) => Presenter;

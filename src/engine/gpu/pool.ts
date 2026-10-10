/**
 * FROZEN CONTRACT (F0). Interface only; implementation lands in Phase 1
 * (engine track A) as pool-impl.ts. Buffers are borrowed, never constructed
 * in the hot path. Generation counters catch stale handles; poison mode
 * fills returned buffers magenta so aliasing bugs are visible, not subtle.
 */

export interface BufferKey {
  width: number;
  height: number;
  format: GPUTextureFormat;
  usage: GPUTextureUsageFlags;
}

export interface PooledBuffer {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly key: BufferKey;
  /** Bumped on every borrow: stale-handle detection. */
  readonly generation: number;
}

/** A refcounted hold that outlives frame scope (layer caches, baked clips). */
export interface RetainedBuffer extends PooledBuffer {
  release(): void;
}

export interface PoolStats {
  alive: number;
  pooled: number;
  bytes: number;
  peakBytes: number;
}

export interface BufferPool {
  borrow(key: BufferKey): PooledBuffer;
  /** Throws on double-return (generation check). */
  return(buf: PooledBuffer): void;
  /** Escape hatch out of frame scope, refcounted. */
  retain(buf: PooledBuffer): RetainedBuffer;
  /** Everything borrowed via the callback is auto-returned when fn exits. */
  scope<T>(fn: (borrow: (k: BufferKey) => PooledBuffer) => T): T;
  stats(): PoolStats;
  trim(maxIdleFrames: number): void;
  debugPoisonOnReturn: boolean;
}

/** Default working format for every intermediate buffer. */
export const WORKING_FORMAT: GPUTextureFormat = 'rgba16float';

// Numeric literals, not GPUTextureUsage.*: that global only exists where
// WebGPU does, and this module is imported by pure-CPU vitest suites.
// COPY_SRC (0x01) | TEXTURE_BINDING (0x04) | RENDER_ATTACHMENT (0x10).
export const RENDER_TARGET_USAGE: GPUTextureUsageFlags = 0x01 | 0x04 | 0x10;

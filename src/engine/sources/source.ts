/**
 * FROZEN CONTRACT (F0). A Source is "a Pass with no buffer inputs": it
 * generates a buffer from non-buffer data. Stateless sources are literally
 * that, via sourceFromPass(). Stateful ones (MSDF atlas, 3D scene, nested
 * document, raster/paint) get a SourceInstance to hold per-instance GPU
 * resources. Sources write OKLab + straight alpha to their target.
 */

import type { ParamsSchema, ResolvedParams } from '../params/schema';
import type { PassDescriptor } from '../passes/pass';
import type { PooledBuffer, BufferPool } from '../gpu/pool';
import type { ObjectId, Seconds } from '../core/types';

/** Per-frame context handed to render(). Implemented in core/frame.ts (Phase 1). */
export interface FrameContext {
  readonly device: GPUDevice;
  readonly encoder: GPUCommandEncoder;
  readonly pool: BufferPool;
  readonly time: Seconds;
  readonly frame: number;
  /** Run a registered pass. Sources compose passes rather than raw pipelines. */
  runPass(pass: string, inputs: PooledBuffer[], params: ResolvedParams,
          target: PooledBuffer): void;
  borrowScratch(like: PooledBuffer): PooledBuffer;
}

export interface SourceCreateContext {
  readonly device: GPUDevice;
  readonly pool: BufferPool;
  getAsset(id: string): unknown;
}

export interface SourceInstance {
  render(ctx: FrameContext, params: ResolvedParams, target: PooledBuffer): void;
  dispose?(): void;
  /** Scene sources only: object picking (M5). */
  hitTest?(x: number, y: number, time: Seconds): ObjectId | null;
  /**
   * FX-BLENDGEN block additive diff (2026-07-07, architect-approved): only
   * called when the descriptor's `wantsBackdrop` is true. `backdrop` is the
   * CURRENT accumulator: everything below this layer, already composited,
   * for THIS FRAME ONLY (see core/engine.ts's renderNodes). It's a
   * pool-scoped scratch buffer: sample it during this same render() call
   * if you need it, but never retain the reference past that call (the
   * buffer may be recycled or its contents overwritten the moment this
   * frame's pool scope ends); copy into a persistent texture first if
   * longer-lived content is needed. core.feedback is the reference
   * implementation.
   */
  setBackdrop?(backdrop: PooledBuffer): void;
}

export interface SourceDescriptor {
  id: string;
  label: string;
  params: ParamsSchema;
  /** plasma yes, image no. Informs the live/baked UI default. */
  liveByDefault: boolean;
  /**
   * FX-BLENDGEN block additive diff (2026-07-07, architect-approved): opts
   * into engine.ts's renderNodes calling the instance's `setBackdrop()`
   * with the current accumulator just before this layer renders each frame.
   * core.feedback is the only user so far.
   */
  wantsBackdrop?: boolean;
  create(ctx: SourceCreateContext): SourceInstance;
}

/**
 * Wrap a no-input PassDescriptor as a Source: solid, plasma etc. are
 * one-liners. Implemented in Phase 1 (engine track C) as sources/from-pass.ts,
 * exporting: `export const sourceFromPass: SourceFromPass`.
 */
export type SourceFromPass = (pass: PassDescriptor) => SourceDescriptor;

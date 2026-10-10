/**
 * Implements BufferPool (pool.ts, FROZEN CONTRACT). Buffers are borrowed from
 * a free-list keyed by (w, h, format, usage); a generation counter is bumped
 * on every borrow so a handle from a prior borrow reads as stale. Poison mode
 * clears returned renderable buffers to magenta so use-after-return aliasing
 * bugs are visible in a screenshot, not a subtle NaN.
 */

import type { BufferKey, BufferPool, PoolStats, PooledBuffer, RetainedBuffer } from './pool';

const keyOf = (k: BufferKey) => `${k.width}x${k.height}:${k.format}:${k.usage}`;

const bytesPerPixel = (format: GPUTextureFormat): number => {
  switch (format) {
    case 'rgba16float': return 8;
    case 'rgba8unorm': case 'rgba8unorm-srgb': case 'bgra8unorm': case 'bgra8unorm-srgb': return 4;
    case 'rgba32float': return 16;
    case 'r16float': return 2;
    case 'r8unorm': return 1;
    default: return 4;
  }
};

// Hardcoded per the WebGPU spec bit layout rather than the GPUTextureUsage
// global: that global doesn't exist in the Node/vitest environment this
// module is unit-tested under, only in a real browser/WebGPU runtime.
const RENDER_ATTACHMENT_BIT = 0x10;
const isRenderable = (usage: GPUTextureUsageFlags) => (usage & RENDER_ATTACHMENT_BIT) !== 0;

interface PoolEntry {
  key: BufferKey;
  texture: GPUTexture;
  view: GPUTextureView;
  generation: number;
  idleFrames: number;
}

interface LiveEntry extends PoolEntry {
  refcount: number;
}

class PoisonPipeline {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | undefined;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  private ensure(): GPURenderPipeline {
    if (this.pipeline) return this.pipeline;
    const module = this.device.createShaderModule({
      code: `
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
          var p = array<vec2f, 3>(vec2f(-1,-3), vec2f(-1,1), vec2f(3,1));
          return vec4f(p[i], 0, 1);
        }
        @fragment fn fs() -> @location(0) vec4f {
          return vec4f(1.0, 0.0, 1.0, 1.0);
        }`,
    });
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    });
    return this.pipeline;
  }

  poison(entry: PoolEntry): void {
    if (!isRenderable(entry.key.usage)) return;
    const pipeline = this.ensure();
    const enc = this.device.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: entry.view, loadOp: 'clear', storeOp: 'store' }],
    });
    rp.setPipeline(pipeline);
    rp.draw(3);
    rp.end();
    this.device.queue.submit([enc.finish()]);
  }
}

class BufferPoolImpl implements BufferPool {
  debugPoisonOnReturn = false;

  private device: GPUDevice;
  private free = new Map<string, PoolEntry[]>();
  private live = new Set<PooledBuffer>();
  /** Maps a live PooledBuffer handle back to its pool entry (for return/poison/retain). */
  private entryFor = new WeakMap<PooledBuffer, PoolEntry>();
  private retained = new Map<PooledBuffer, LiveEntry>();
  private poisoner: PoisonPipeline;
  private currentBytes = 0;
  private peakBytes = 0;
  /**
   * MEMORY-EVICTION block: one array per currently-executing `scope()` call
   * (a stack, not a single field, so a scope nested inside another scope's
   * callback attributes retains to the innermost one), holding every
   * RetainedBuffer produced by `retain()` while that scope's `fn` is on the
   * stack. On normal return the array is just discarded: retain()'s whole
   * point is to hand a buffer to the caller past scope exit, so a clean
   * return must not touch it. On a THROW, everything in the top array gets
   * force-released here: without this, a `pool.retain()` called earlier in
   * the same `scope()` callback (core/engine.ts's renderFrame/renderSubtree,
   * ~410/~457) escapes `this.live` (retain() already removed it, so scope's
   * own auto-return finally can't see it either) and is never freed, because
   * the code path that would normally consume+release it never runs.
   */
  private retainStack: RetainedBuffer[][] = [];

  constructor(device: GPUDevice) {
    this.device = device;
    this.poisoner = new PoisonPipeline(device);
  }

  private bytesOf(key: BufferKey): number {
    return key.width * key.height * bytesPerPixel(key.format);
  }

  private createEntry(key: BufferKey): PoolEntry {
    const texture = this.device.createTexture({
      size: [key.width, key.height],
      format: key.format,
      usage: key.usage,
    });
    const view = texture.createView();
    this.currentBytes += this.bytesOf(key);
    if (this.currentBytes > this.peakBytes) this.peakBytes = this.currentBytes;
    return { key, texture, view, generation: 0, idleFrames: 0 };
  }

  borrow(key: BufferKey): PooledBuffer {
    const k = keyOf(key);
    const bucket = this.free.get(k);
    let entry: PoolEntry;
    if (bucket && bucket.length > 0) {
      entry = bucket.pop()!;
    } else {
      entry = this.createEntry(key);
    }
    entry.generation++;
    entry.idleFrames = 0;
    const buf: PooledBuffer = {
      texture: entry.texture,
      view: entry.view,
      key: entry.key,
      generation: entry.generation,
    };
    this.live.add(buf);
    this.entryFor.set(buf, entry);
    return buf;
  }

  return(buf: PooledBuffer): void {
    const entry = this.entryFor.get(buf);
    if (!entry || !this.live.has(buf) || entry.generation !== buf.generation) {
      throw new Error('BufferPool.return: double-return or stale handle');
    }
    this.live.delete(buf);
    this.entryFor.delete(buf);
    if (this.debugPoisonOnReturn) this.poisoner.poison(entry);
    entry.idleFrames = 0;
    const k = keyOf(entry.key);
    const bucket = this.free.get(k) ?? [];
    bucket.push(entry);
    this.free.set(k, bucket);
  }

  retain(buf: PooledBuffer): RetainedBuffer {
    const entry = this.entryFor.get(buf);
    if (!entry || !this.live.has(buf) || entry.generation !== buf.generation) {
      throw new Error('BufferPool.retain: stale handle');
    }
    let live = this.retained.get(buf);
    if (!live) {
      live = { ...entry, refcount: 0 };
      this.retained.set(buf, live);
    }
    live.refcount++;
    // Escapes normal frame-scope liveness tracking; return() no longer applies to it.
    this.live.delete(buf);
    this.entryFor.delete(buf);
    const self = this;
    const retained: RetainedBuffer = {
      texture: entry.texture,
      view: entry.view,
      key: entry.key,
      generation: entry.generation,
      release() {
        const l = self.retained.get(buf);
        if (!l) return;
        l.refcount--;
        if (l.refcount <= 0) {
          self.retained.delete(buf);
          l.idleFrames = 0;
          const k = keyOf(l.key);
          const bucket = self.free.get(k) ?? [];
          bucket.push(l);
          self.free.set(k, bucket);
        }
      },
    };
    // Record against the innermost active scope (if any) so a throw before
    // this retain's caller gets a chance to use/store it can be released.
    // See retainStack's doc comment above.
    const top = this.retainStack[this.retainStack.length - 1];
    if (top) top.push(retained);
    return retained;
  }

  scope<T>(fn: (borrow: (k: BufferKey) => PooledBuffer) => T): T {
    const scoped: PooledBuffer[] = [];
    const scopeRetains: RetainedBuffer[] = [];
    const borrow = (k: BufferKey) => {
      const buf = this.borrow(k);
      scoped.push(buf);
      return buf;
    };
    this.retainStack.push(scopeRetains);
    try {
      const result = fn(borrow);
      return result;
    } catch (err) {
      // Only on a throw: a clean return means the caller is holding these
      // retains on purpose (e.g. renderFrame's keepAccumulator), and must
      // release them itself. release() is idempotent against a handle
      // already released earlier in the same throwing call.
      for (const r of scopeRetains) r.release();
      throw err;
    } finally {
      this.retainStack.pop();
      for (const buf of scoped) {
        if (this.live.has(buf)) this.return(buf);
      }
    }
  }

  stats(): PoolStats {
    let pooled = 0;
    for (const bucket of this.free.values()) pooled += bucket.length;
    return {
      alive: this.live.size + this.retained.size,
      pooled,
      bytes: this.currentBytes,
      peakBytes: this.peakBytes,
    };
  }

  /**
   * MEMORY-EVICTION block: only walks `free`, deliberately not `retained`.
   * A retained buffer being "idle" (unused for N frames) is not evidence of
   * a leak the way an idle free-list entry is. A free-list entry is scratch
   * the pool itself owns and can always safely reclaim; a RetainedBuffer's
   * whole contract (pool.ts's doc comment: "a refcounted hold that outlives
   * frame scope") is that some OTHER owner (a layer cache, a baked clip,
   * localHost's export/readback pull) is holding it on purpose, for however
   * long its own lifetime requires: a still-open export can legitimately
   * retain a buffer across hundreds of frames. The pool has no way to tell
   * "idle because forgotten" from "idle because still needed" for a
   * retained handle (unlike a free-list entry, which is never "needed" by
   * definition), so aging them here would silently destroy a texture a
   * caller still has a live reference to and intends to sample, the exact
   * "destroy a buffer a previous frame may still reference" mistake
   * src/engine/CLAUDE.md's GPU-resource-lifetime section warns about. The
   * scope-level release added to `scope()`'s catch above covers the actual
   * leak this block was scoped to fix (a throw between retain() and the
   * caller taking ownership of the result); a genuinely forgotten
   * `release()` after a clean return is a caller bug, not something this
   * pool can detect from here.
   */
  trim(maxIdleFrames: number): void {
    for (const [k, bucket] of this.free) {
      const kept: PoolEntry[] = [];
      for (const entry of bucket) {
        entry.idleFrames++;
        if (entry.idleFrames > maxIdleFrames) {
          entry.texture.destroy();
          this.currentBytes -= this.bytesOf(entry.key);
        } else {
          kept.push(entry);
        }
      }
      if (kept.length > 0) this.free.set(k, kept);
      else this.free.delete(k);
    }
  }
}

export const createBufferPool = (device: GPUDevice): BufferPool => new BufferPoolImpl(device);

import { describe, expect, it } from 'vitest';
import { createBufferPool } from '../../src/engine/gpu/pool-impl';
import type { BufferKey } from '../../src/engine/gpu/pool';

/**
 * Mock GPUDevice: plain objects standing in for GPUTexture/GPUShaderModule/
 * GPURenderPipeline. Only the surface BufferPoolImpl actually touches.
 */
function mockDevice() {
  const encoder = {
    beginRenderPass: () => ({
      setPipeline: () => {},
      draw: () => {},
      end: () => {},
    }),
    finish: () => ({}),
  };
  const device = {
    createTexture: (desc: { size: [number, number]; format: string; usage: number }) => ({
      __desc: desc,
      createView: () => ({}),
      destroy: () => {},
    }),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({}),
    createCommandEncoder: () => encoder,
    queue: { submit: () => {} },
  };
  return device as unknown as GPUDevice;
}

// Numeric literals, not the GPUTextureUsage global: that global is only
// provided by a real browser/WebGPU runtime, not vitest's node environment.
const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const COPY_SRC = 0x01;

const key = (overrides: Partial<BufferKey> = {}): BufferKey => ({
  width: 64,
  height: 64,
  format: 'rgba16float',
  usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC,
  ...overrides,
});

describe('BufferPool', () => {
  it('recycles a returned buffer for a matching key and bumps generation on reborrow', () => {
    const pool = createBufferPool(mockDevice());
    const k = key();
    const a = pool.borrow(k);
    expect(a.generation).toBe(1);
    pool.return(a);
    const b = pool.borrow(k);
    expect(b.texture).toBe(a.texture); // recycled, not recreated
    expect(b.generation).toBe(2);
  });

  it('throws on double-return', () => {
    const pool = createBufferPool(mockDevice());
    const a = pool.borrow(key());
    pool.return(a);
    expect(() => pool.return(a)).toThrow();
  });

  it('auto-returns everything borrowed inside scope()', () => {
    const pool = createBufferPool(mockDevice());
    const k = key();
    let borrowed: ReturnType<typeof pool.borrow> | undefined;
    pool.scope((borrow) => {
      borrowed = borrow(k);
    });
    expect(pool.stats().alive).toBe(0);
    expect(pool.stats().pooled).toBe(1);
    // reborrowing after scope exit recycles the same texture
    const again = pool.borrow(k);
    expect(again.texture).toBe(borrowed!.texture);
  });

  it('retain() outlives scope exit; release() re-pools it', () => {
    const pool = createBufferPool(mockDevice());
    const k = key();
    let retained: ReturnType<typeof pool.retain> | undefined;
    pool.scope((borrow) => {
      const buf = borrow(k);
      retained = pool.retain(buf);
    });
    // not returned to the free list by scope exit, still alive via retain
    expect(pool.stats().alive).toBe(1);
    expect(pool.stats().pooled).toBe(0);
    retained!.release();
    expect(pool.stats().alive).toBe(0);
    expect(pool.stats().pooled).toBe(1);
  });

  it('tracks stats including peakBytes', () => {
    const pool = createBufferPool(mockDevice());
    const k = key({ width: 100, height: 100, format: 'rgba16float' });
    const a = pool.borrow(k);
    const b = pool.borrow(k);
    const expectedBytes = 100 * 100 * 8;
    expect(pool.stats().bytes).toBe(expectedBytes * 2);
    expect(pool.stats().peakBytes).toBe(expectedBytes * 2);
    pool.return(a);
    pool.return(b);
    expect(pool.stats().bytes).toBe(expectedBytes * 2); // freed, not destroyed
    expect(pool.stats().peakBytes).toBe(expectedBytes * 2); // peak never drops
  });

  it('trim(maxIdleFrames) destroys buffers idle past the threshold', () => {
    const pool = createBufferPool(mockDevice());
    const k = key();
    const a = pool.borrow(k);
    pool.return(a);
    pool.trim(1);
    expect(pool.stats().pooled).toBe(1); // idleFrames 1, not yet past threshold
    pool.trim(1);
    expect(pool.stats().pooled).toBe(0); // idleFrames 2 > 1, destroyed
    expect(pool.stats().bytes).toBe(0);
  });

  it('a throw inside scope() releases a buffer retained earlier in that same scope call', () => {
    const pool = createBufferPool(mockDevice());
    const k = key();
    expect(() => {
      pool.scope((borrow) => {
        const buf = borrow(k);
        pool.retain(buf); // e.g. renderFrame's keepAccumulator, before the frame finishes
        throw new Error('render failed after retain');
      });
    }).toThrow('render failed after retain');
    // Not leaked as a permanently-live retain: released back to the free list.
    expect(pool.stats().alive).toBe(0);
    expect(pool.stats().pooled).toBe(1);
  });

  it('a clean scope() exit leaves a retain alone: only a throw force-releases it', () => {
    const pool = createBufferPool(mockDevice());
    const k = key();
    let retained: ReturnType<typeof pool.retain> | undefined;
    pool.scope((borrow) => {
      retained = pool.retain(borrow(k));
    });
    // Caller (e.g. renderFrame's return value) still owns this: must not
    // have been force-released just because it happened inside a scope().
    expect(pool.stats().alive).toBe(1);
    retained!.release();
    expect(pool.stats().alive).toBe(0);
  });

  it('a throw caught by an outer scope only releases the inner scope\'s own retains', () => {
    const pool = createBufferPool(mockDevice());
    const k = key();
    let outerRetained: ReturnType<typeof pool.retain> | undefined;
    pool.scope((borrowOuter) => {
      outerRetained = pool.retain(borrowOuter(k));
      // The inner scope's own throw/catch is fully contained here: the
      // outer scope() call itself still returns normally, so its retain
      // must be attributed to the OUTER frame on the stack, not the inner.
      expect(() => {
        pool.scope((borrowInner) => {
          pool.retain(borrowInner(k));
          throw new Error('inner scope failed');
        });
      }).toThrow('inner scope failed');
    });
    // Inner retain released; outer retain untouched (its scope returned cleanly).
    expect(pool.stats().alive).toBe(1);
    outerRetained!.release();
    expect(pool.stats().alive).toBe(0);
  });

  it('debugPoisonOnReturn clears returned renderable buffers without throwing', () => {
    const pool = createBufferPool(mockDevice());
    pool.debugPoisonOnReturn = true;
    const renderable = pool.borrow(key());
    expect(() => pool.return(renderable)).not.toThrow();

    const nonRenderable = pool.borrow(key({ usage: TEXTURE_BINDING }));
    expect(() => pool.return(nonRenderable)).not.toThrow();
  });
});

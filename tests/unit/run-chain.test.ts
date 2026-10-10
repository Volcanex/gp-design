import { describe, it, expect, vi, beforeAll } from 'vitest';
import { runChain } from '../../src/engine/passes/run-chain';
import { effects } from '../../src/engine/registry/effects';
import type { PooledBuffer } from '../../src/engine/gpu/pool';
import type { FrameContext } from '../../src/engine/sources/source';
import type { Chain } from '../../src/engine/passes/chain';

beforeAll(() => {
  effects.register({
    id: 'test.identity', label: 'Identity', kind: 'render',
    wgsl: '', inputs: [{ name: 'src' }], params: {},
    metadata: { category: 'test' },
  });
  effects.register({
    id: 'test.rgbwrap-missing', label: 'RGB wrap (missing convert passes)', kind: 'render',
    wgsl: '', inputs: [{ name: 'src' }], params: {},
    metadata: { category: 'test', colorSpace: 'rgb' },
  });
});

function makeBuffer(tag: string): PooledBuffer {
  return {
    texture: {} as GPUTexture,
    view: { __tag: tag } as unknown as GPUTextureView,
    key: { width: 4, height: 4, format: 'rgba16float', usage: 0 },
    generation: 0,
  };
}

function makeCtx(borrowSeq: PooledBuffer[]): FrameContext {
  let i = 0;
  return {
    device: {} as GPUDevice,
    encoder: {} as GPUCommandEncoder,
    pool: {} as never,
    time: 0,
    frame: 0,
    runPass: vi.fn(),
    borrowScratch: vi.fn(() => borrowSeq[i++]!),
  };
}

describe('runChain', () => {
  it('returns input unchanged for an empty chain', () => {
    const input = makeBuffer('in');
    const ctx = makeCtx([]);
    const result = runChain([], input, ctx);
    expect(result).toBe(input);
    expect(ctx.borrowScratch).not.toHaveBeenCalled();
    expect(ctx.runPass).not.toHaveBeenCalled();
  });

  it('skips disabled effects', () => {
    const input = makeBuffer('in');
    const chain: Chain = [{ id: 'a', pass: 'test.identity', params: {}, enabled: false }];
    const ctx = makeCtx([makeBuffer('unused')]);
    const result = runChain(chain, input, ctx);
    expect(result).toBe(input);
    expect(ctx.runPass).not.toHaveBeenCalled();
  });

  it('skips a step with enabled omitted (undefined) exactly like enabled: false (same for a macro pass)', () => {
    // Regression pin: a test fixture (tests/e2e/blur.spec.ts) built chain
    // items from a type that didn't require `enabled`, so every call site
    // silently omitted it; `if (!inst.enabled) continue` treats that
    // identically to `enabled: false`, so the step never runs. This looked
    // exactly like "the macro expand() mechanism isn't executing" (blur/
    // bloom read back as pixel-identical to the raw input) when the real
    // cause was upstream of expand ever being consulted. Root cause was in
    // the test fixture, not the engine: `Chain`/`EffectInstance.enabled`
    // is already a required field (not optional) at the type level, so
    // this only bites callers that bypass the type (e.g. Playwright specs
    // building doc literals with no compile-time check against `Chain`).
    effects.register({
      id: 'test.macro-identity-check', label: 'Macro identity check', kind: 'render',
      wgsl: '', inputs: [{ name: 'src' }], params: {},
      metadata: { category: 'test' },
      expand: (params) => [{ pass: 'test.identity', params }],
    });
    const input = makeBuffer('in');
    const chain = [{ id: 'a', pass: 'test.macro-identity-check', params: {} }] as unknown as Chain;
    const ctx = makeCtx([makeBuffer('unused')]);
    const result = runChain(chain, input, ctx);
    expect(result).toBe(input);
    expect(ctx.runPass).not.toHaveBeenCalled();
  });

  it('ping-pongs across enabled effects, alternating buffers', () => {
    const input = makeBuffer('in');
    const t1 = makeBuffer('t1');
    const t2 = makeBuffer('t2');
    const chain: Chain = [
      { id: 'a', pass: 'test.identity', params: {}, enabled: true },
      { id: 'b', pass: 'test.identity', params: {}, enabled: true },
    ];
    const ctx = makeCtx([t1, t2]);
    const result = runChain(chain, input, ctx);
    expect(result).toBe(t2);
    expect(ctx.runPass).toHaveBeenCalledTimes(2);
    const calls = (ctx.runPass as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toBe('test.identity');
    expect(calls[0]![3]).toBe(t1);
    expect(calls[1]![3]).toBe(t2);
  });

  it('throws when a borrowed target aliases its input (ping-pong invariant)', () => {
    const input = makeBuffer('in');
    const chain: Chain = [{ id: 'a', pass: 'test.identity', params: {}, enabled: true }];
    // Simulate a broken pool that hands back the same buffer it was given.
    const ctx = makeCtx([input]);
    expect(() => runChain(chain, input, ctx)).toThrow();
  });

  it('throws for an rgb colorSpace pass when the convert passes are not registered', () => {
    const input = makeBuffer('in');
    const chain: Chain = [{ id: 'a', pass: 'test.rgbwrap-missing', params: {}, enabled: true }];
    const ctx = makeCtx([makeBuffer('scratch')]);
    expect(() => runChain(chain, input, ctx)).toThrow(/core\.to-rgb/);
  });

  it('wraps rgb colorSpace passes via core.to-rgb/core.from-rgb once registered', () => {
    effects.register({
      id: 'core.to-rgb', label: 'to rgb', kind: 'render', wgsl: '', inputs: [{ name: 'src' }], params: {},
      metadata: { category: 'convert' },
    });
    effects.register({
      id: 'core.from-rgb', label: 'from rgb', kind: 'render', wgsl: '', inputs: [{ name: 'src' }], params: {},
      metadata: { category: 'convert' },
    });
    effects.register({
      id: 'test.rgbwrap', label: 'RGB wrap', kind: 'render', wgsl: '', inputs: [{ name: 'src' }], params: {},
      metadata: { category: 'test', colorSpace: 'rgb' },
    });

    const input = makeBuffer('in');
    const toRgbBuf = makeBuffer('toRgb');
    const mainBuf = makeBuffer('main');
    const fromRgbBuf = makeBuffer('fromRgb');
    const chain: Chain = [{ id: 'a', pass: 'test.rgbwrap', params: {}, enabled: true }];
    const ctx = makeCtx([toRgbBuf, mainBuf, fromRgbBuf]);

    const result = runChain(chain, input, ctx);

    expect(result).toBe(fromRgbBuf);
    const calls = (ctx.runPass as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toBe('core.to-rgb');
    expect(calls[1]![0]).toBe('test.rgbwrap');
    expect(calls[2]![0]).toBe('core.from-rgb');
  });

  describe('macro effects (PassDescriptor.expand)', () => {
    it('runs a single-step macro as one sub-pass against the macro input', () => {
      effects.register({
        id: 'test.macro-single', label: 'Macro single', kind: 'render',
        wgsl: '', inputs: [{ name: 'src' }], params: {},
        metadata: { category: 'test' },
        expand: (params) => [{ pass: 'test.sub-a', params }],
      });

      const input = makeBuffer('in');
      const sub = makeBuffer('sub');
      const chain: Chain = [{ id: 'a', pass: 'test.macro-single', params: {}, enabled: true }];
      const ctx = makeCtx([sub]);

      const result = runChain(chain, input, ctx);

      expect(result).toBe(sub);
      const calls = (ctx.runPass as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe('test.sub-a');
      expect(calls[0]![1]).toEqual([input]);
      expect(calls[0]![3]).toBe(sub);
    });

    it('chains a multi-step macro: each step\'s input defaults to the previous step\'s output', () => {
      effects.register({
        id: 'test.macro-multi', label: 'Macro multi', kind: 'render',
        wgsl: '', inputs: [{ name: 'src' }], params: {},
        metadata: { category: 'test' },
        expand: (params) => [
          { pass: 'test.sub-a', params },
          { pass: 'test.sub-b', params },
        ],
      });

      const input = makeBuffer('in');
      const step1 = makeBuffer('step1');
      const step2 = makeBuffer('step2');
      const chain: Chain = [{ id: 'a', pass: 'test.macro-multi', params: {}, enabled: true }];
      const ctx = makeCtx([step1, step2]);

      const result = runChain(chain, input, ctx);

      expect(result).toBe(step2);
      const calls = (ctx.runPass as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]![0]).toBe('test.sub-a');
      expect(calls[0]![1]).toEqual([input]); // first step: 'prev' defaults to the macro's own input
      expect(calls[0]![3]).toBe(step1);
      expect(calls[1]![0]).toBe('test.sub-b');
      expect(calls[1]![1]).toEqual([step1]); // second step: 'prev' is the first step's output
      expect(calls[1]![3]).toBe(step2);
    });

    it('maps an [orig, prev] two-input step to the macro input and the previous step output', () => {
      effects.register({
        id: 'test.macro-two-input', label: 'Macro two-input', kind: 'render',
        wgsl: '', inputs: [{ name: 'src' }], params: {},
        metadata: { category: 'test' },
        expand: (params) => [
          { pass: 'test.sub-a', params },
          { pass: 'test.sub-combine', params, inputs: ['orig', 'prev'] },
        ],
      });

      const input = makeBuffer('in');
      const step1 = makeBuffer('step1');
      const step2 = makeBuffer('step2');
      const chain: Chain = [{ id: 'a', pass: 'test.macro-two-input', params: {}, enabled: true }];
      const ctx = makeCtx([step1, step2]);

      const result = runChain(chain, input, ctx);

      expect(result).toBe(step2);
      const calls = (ctx.runPass as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[1]![0]).toBe('test.sub-combine');
      expect(calls[1]![1]).toEqual([input, step1]); // 'orig' = macro input, 'prev' = step1's output
    });
  });
});

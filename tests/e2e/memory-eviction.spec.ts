/**
 * MEMORY-EVICTION block. Contract: see boot.spec.ts header for the full
 * window.__gdesign shape. Proves that deleting layers actually frees GPU
 * memory: engine.memoryStats() (localHost.ts) folds in both the buffer
 * pool's own bytes AND the per-layer/per-asset caches core/engine.ts's
 * reconcile() now evicts (clip/mask texture caches, core/asset-textures.ts's
 * LUT/image cache). See src/engine/CLAUDE.md's "GPU resource lifetime"
 * section for what gets evicted and when.
 *
 * DEVIATION FROM BRIEF, DOCUMENTED PER ITS OWN INSTRUCTIONS: the brief asked
 * for "8 layers each with two effects". Giving a layer ANY non-empty chain
 * (even one effect) makes `runChain` call `ctx.borrowScratch` at least once
 * per step; `borrowScratch` (core/frame.ts) calls the raw `pool.borrow()`
 * directly rather than the `borrow` callback `pool.scope()` hands its
 * caller, so that buffer never enters `scope()`'s own `scoped` list and is
 * therefore NEVER auto-returned: it stays in BufferPool's `live` set
 * forever, invisible to `trim()` (which only walks the `free` list). This is
 * a real, pre-existing, general leak (confirmed empirically: it reproduces
 * with plain chain effects and is unrelated to anything this task's diff
 * touches, engine.ts/pool-impl.ts/localHost.ts/asset-textures.ts), NOT
 * something introduced by memory-eviction work, and NOT in this task's
 * scope (`src/engine/core/frame.ts` isn't one of the brief's scoped files).
 * It is also unconditional and frame-count-multiplied: every rendered frame
 * leaks 2 more buffers per 2-effect layer, permanently, regardless of
 * whether the owning layer still exists, so a chain-bearing layer design
 * here would make "memory returns near baseline after delete" categorically
 * unachievable no matter how correct this task's eviction code is, and
 * would silently stop testing this task's actual scope the moment it
 * started failing for the wrong reason. Flagged in the task report rather
 * than fixed here (out of scope, and `run-chain.ts`/`frame.ts` are shared
 * with every other workstream). Each of the 8 layers below instead gets a
 * MASK ONLY (`chain: []`): masks are resolved through the properly
 * pool-scoped `borrow` callback (`renderNodeContent`'s `masked = borrow(...)`
 * in core/engine.ts), not `borrowScratch`, so they exercise exactly the
 * eviction path this task adds (maskTextureCache) without the confound. A
 * 1280x720 rgba16float mask is ~7.4MB (matches masks.spec.ts's own comment
 * on the same asset). 8 of them is a large, unambiguous signal.
 * core/asset-textures.ts's LUT/image cache eviction is covered instead by
 * tests/unit/memory-eviction.test.ts's pure evictedAssetIds cases, for the
 * same reason.
 *
 * Whole flow lives inside ONE page.evaluate (tests/CLAUDE.md: the evaluate
 * bridge corrupts ArrayBuffers) and asserts with exactly ONE expect on a
 * digest object. No readback() is used anywhere: memoryStats() alone is
 * enough to prove eviction and never touches the GPU readback path (whose
 * second-call-in-a-page footgun is documented in chain-panel.spec.ts).
 */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
});

test('deleting masked layers returns memoryStats() close to its pre-add baseline', async ({ page }) => {
  const result = await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    const engine = gd.engine;

    // Pause the auto-playing clock (tests/CLAUDE.md convention) before
    // touching anything: a continuous render loop racing this evaluate's
    // own requestFrame() calls would make the frame-count-based trim()
    // timing below unpredictable.
    engine.setClock({ cmd: 'pause' });

    const settle = (n: number) => { for (let i = 0; i < n; i += 1) engine.requestFrame(); };

    settle(5);
    const baseline = engine.memoryStats();

    const { width, height } = gd.doc().canvas;
    const layerIds: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const id = `mem-evict-layer-${i}`;
      const maskId = `mem-evict-mask-${i}`;
      layerIds.push(id);
      const layer = {
        id,
        kind: 'layer',
        name: id,
        enabled: true,
        source: { type: 'core.solid', params: { color: [0.5, 0, 0, 1] } },
        chain: [],
        blendMode: 'normal',
        opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'live',
        mask: { asset: maskId, enabled: true, invert: false },
      };
      engine.applyEdits([
        { op: 'addAsset', id: maskId, asset: { type: 'raster', data: new ArrayBuffer(width * height * 8), width, height } },
        { op: 'addLayer', parent: null, index: gd.doc().layers.length, layer },
      ]);
    }

    settle(5);
    const afterAdd = engine.memoryStats();

    for (const id of layerIds) engine.applyEdits([{ op: 'removeLayer', id }]);
    // Enough rendered frames for the buffer pool's own trim(120) to age out
    // whatever scratch high-water it needed while 8 masked layers were
    // rendering (localHost.ts's TRIM_IDLE_FRAMES). maskTextureCache itself
    // is freed immediately by reconcile() inside the removeLayer applyEdits
    // calls above, not by this loop.
    settle(130);
    const afterDelete = engine.memoryStats();

    const grew = afterAdd.bytes > baseline.bytes;
    const denom = Math.max(baseline.bytes, 1);
    const ratio = Math.abs(afterDelete.bytes - baseline.bytes) / denom;

    return {
      baselineBytes: baseline.bytes,
      baselinePeakBytes: baseline.peakBytes,
      afterAddBytes: afterAdd.bytes,
      afterAddPeakBytes: afterAdd.peakBytes,
      afterDeleteBytes: afterDelete.bytes,
      afterDeletePeakBytes: afterDelete.peakBytes,
      grew,
      withinTolerance: ratio <= 0.10,
      ok: grew && ratio <= 0.10,
    };
  });

  // eslint-disable-next-line no-console
  console.log('[memory-eviction]', JSON.stringify(result));
  expect(result.ok, JSON.stringify(result)).toBe(true);
});

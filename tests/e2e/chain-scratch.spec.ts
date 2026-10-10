/**
 * Regression for the effect-chain scratch leak (core/frame.ts's
 * borrowScratch, fixed 2026-09): with any effect applied, every rendered
 * frame used to borrow a fresh full-canvas texture that was never returned
 * to the pool. Render a doc with a two-effect layer for a run of frames and
 * assert pool bytes are flat between the first and second half of the run.
 * Whole flow in ONE page.evaluate (tests/CLAUDE.md); one assertion.
 */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
  await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'pause' }));
});

test('rendering a layer with a two-effect chain does not grow pool memory frame over frame', async ({ page }) => {
  const result = await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    const engine = gd.engine;
    const doc = engine.getDocument();
    const layer = doc.layers.find((l: any) => l.id === 'layer-1');
    engine.applyEdits([{
      op: 'setChain',
      target: { kind: 'layer', id: layer.id },
      chain: [
        { id: 'fx-1', pass: 'core.invert', params: {}, enabled: true },
        { id: 'fx-2', pass: 'core.brightness-contrast', params: {}, enabled: true },
      ],
    }]);
    const frames = (n: number) => {
      for (let i = 0; i < n; i += 1) engine.setClock({ cmd: 'seek', time: i / 30 });
    };
    frames(30);
    const afterWarmup = engine.memoryStats().bytes;
    frames(60);
    const afterRun = engine.memoryStats().bytes;
    return { afterWarmup, afterRun, chainLength: engine.getDocument().layers.find((l: any) => l.id === layer.id).chain.length };
  });
  expect(result, JSON.stringify(result)).toMatchObject({ chainLength: 2, afterRun: result.afterWarmup });
});

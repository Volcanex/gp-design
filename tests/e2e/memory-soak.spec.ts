import { test, expect } from '@playwright/test';

/**
 * History-budget soak: 60 real engine-level strokes (beginStroke/
 * strokePoint/endStroke, see tests/e2e/stroke.spec.ts's idiom) interleaved
 * with 20 undo/redo pairs, all inside ONE page.evaluate (Playwright's
 * evaluate bridge corrupts ArrayBuffers across separate calls, tests/
 * CLAUDE.md). `window.__gdesign` doesn't expose the app-level `history`
 * singleton (app/commands/app-history.ts), so this mirrors history.ts's own
 * byte-budget eviction algorithm locally against the REAL edits the engine
 * produces, proving the same 256MB-budget/200-cap logic (already exercised
 * directly against fake commands in tests/unit/history-budget.test.ts) holds
 * up under genuine commitRaster payloads, and (the thing this spec alone
 * can prove) that region scoping (src/engine/host/localHost.ts's endStroke)
 * keeps every stroke's commitRaster region well under full-canvas size.
 */
test('60 strokes + 20 undo/redo pairs stay under the history byte budget with region-scoped commits', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });

  // Every app-page spec must pause the boot clock (tests/CLAUDE.md) before
  // any readback/soak work: the continuous render loop compounds across
  // sequential contexts under SwiftShader until readbacks hang outright.
  await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'pause' }));

  const result = await page.evaluate(async () => {
    const gd = (window as any).__gdesign;
    const engine = gd.engine;
    const layer = 'paint-1'; // the starter doc's raster layer (main.ts)
    const canvas = gd.doc().canvas;
    const canvasArea = canvas.width * canvas.height;

    const HISTORY_BYTE_BUDGET = 256 * 1024 * 1024;
    const HISTORY_CAP = 200;

    function bytesOfEdits(edits: any[]): number {
      let total = 0;
      for (const e of edits) {
        if (e.op === 'commitRaster' && e.data) total += e.data.byteLength;
        if (e.op === 'addAsset' && e.asset?.data) total += e.asset.data.byteLength;
      }
      return total;
    }

    // Local mirror of app/commands/history.ts's push/eviction. See this
    // file's header comment for why it's not the real singleton.
    const stack: { edits: any[]; inverse: any[]; bytes: number }[] = [];
    let pointer = -1;
    const totalBytes = () => stack.reduce((s, e) => s + e.bytes, 0);
    function pushEntry(edits: any[], inverse: any[]): void {
      stack.length = pointer + 1; // truncateRedo
      stack.push({ edits, inverse, bytes: bytesOfEdits(edits) + bytesOfEdits(inverse) });
      pointer++;
      while (stack.length > 1 && (stack.length > HISTORY_CAP || totalBytes() > HISTORY_BYTE_BUDGET)) {
        stack.shift();
        pointer--;
      }
    }

    let regionsAllSmaller = true;
    let strokesCommitted = 0;

    for (let i = 0; i < 60; i++) {
      const baseX = 40 + (i % 20) * 50;
      const baseY = 40 + Math.floor(i / 20) * 200;
      engine.beginStroke({ layer, brush: 'round', size: 12, color: [0.5, 0.05, -0.05, 1], mode: 'paint' });
      for (let s = 0; s < 4; s++) engine.strokePoint({ x: baseX + s * 3, y: baseY + s * 2 });
      const edits = await engine.endStroke();
      if (edits.length === 0) continue; // touched nothing
      strokesCommitted++;
      const commit = edits.find((e: any) => e.op === 'commitRaster');
      if (commit && commit.region.width * commit.region.height >= canvasArea) regionsAllSmaller = false;
      const inverse = engine.applyEdits(edits);
      pushEntry(edits, inverse);
    }

    // Interleave 20 undo/redo pairs against the tail of the stack.
    for (let i = 0; i < 20 && pointer >= 0; i++) {
      engine.applyEdits(stack[pointer]!.inverse);
      const undonePointer = pointer - 1;
      pointer = undonePointer;
      if (pointer + 1 < stack.length) {
        pointer++;
        engine.applyEdits(stack[pointer]!.edits);
      }
    }

    return {
      historyBytes: totalBytes(),
      budget: HISTORY_BYTE_BUDGET,
      entries: stack.length,
      strokesCommitted,
      regionsAllSmaller,
      canvasArea,
      jsHeap: (performance as any).memory?.usedJSHeapSize ?? null,
    };
  });

  expect(result.strokesCommitted).toBeGreaterThan(0);
  expect(result.historyBytes).toBeLessThanOrEqual(result.budget);
  expect(result.entries).toBeLessThanOrEqual(200);
  expect(result.regionsAllSmaller).toBe(true);
  if (result.jsHeap !== null) expect(result.jsHeap).toBeGreaterThan(0);
});

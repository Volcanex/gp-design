import { test, expect } from '@playwright/test';
import type { LayerId } from '@engine';

const layer = 'raster1' as LayerId;
const color: [number, number, number, number] = [0.6, 0.2, -0.1, 1];
const strokeXs = [16, 24, 32, 40, 48];

/**
 * Raster source + stroke API, end to end: an empty raster layer, a short
 * stroke drawn via beginStroke/strokePoint/endStroke. endStroke returns an
 * UNAPPLIED edit batch (per architect clarification): the caller applies it
 * exactly once via applyEdits, same channel as everything else, so undo
 * works by replaying the returned inverses.
 *
 * Edits carry raw ArrayBuffers (commitRaster's pixel data); round-tripping
 * those through page.evaluate's Node<->browser boundary across two separate
 * calls corrupts them, so paint + apply + readback all happen inside one
 * evaluate call and only plain numbers cross back to Node.
 */
test('stroke: endStroke returns unapplied edits; applying them commits to the document', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
    await window.__engineTest!.loadRaster();
  });

  const result = await page.evaluate(
    async ({ layer, color, strokeXs }) => {
      const host = window.__engineTest!.host;

      host.beginStroke({ layer, brush: 'round', size: 16, color, mode: 'paint' });
      for (const x of strokeXs) host.strokePoint({ x, y: 32 });
      const edits = await host.endStroke();

      const assetCountBefore = Object.keys(host.getDocument().assets).length;
      const inverses = host.applyEdits(edits);
      const doc = host.getDocument();
      const rasterAsset = Object.values(doc.assets).find((a) => a.type === 'raster');

      const rb = await host.readback({ via: 'float' });
      const data = Array.from(new Float32Array(rb.data));

      return {
        editCount: edits.length,
        inverseCount: inverses.length,
        assetCountBefore,
        hasRasterAsset: !!rasterAsset,
        width: rb.width,
        data,
      };
    },
    { layer, color, strokeXs },
  );

  expect(result.editCount).toBeGreaterThan(0);
  expect(result.inverseCount).toBe(result.editCount);
  // Not applied until applyEdits ran: no raster asset existed beforehand.
  expect(result.assetCountBefore).toBe(0);
  expect(result.hasRasterAsset).toBe(true);

  const at = (x: number, y: number) => {
    const idx = (y * result.width + x) * 4;
    return result.data.slice(idx, idx + 4);
  };

  // Centre of the stroke: painted, alpha ~1, L/a/b close to the brush color.
  const stroked = at(32, 32);
  expect(stroked[3]).toBeGreaterThan(0.9);
  expect(Math.abs(stroked[0]! - color[0])).toBeLessThan(0.05);
  expect(Math.abs(stroked[1]! - color[1])).toBeLessThan(0.05);
  expect(Math.abs(stroked[2]! - color[2])).toBeLessThan(0.05);

  // Untouched corner: still transparent.
  const untouched = at(2, 2);
  expect(untouched[3]).toBeLessThan(0.05);
});

test('stroke undo: applying the inverse edits restores pre-stroke pixels', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
    await window.__engineTest!.loadRaster();
  });

  const result = await page.evaluate(
    async ({ layer, color, strokeXs }) => {
      const host = window.__engineTest!.host;

      host.beginStroke({ layer, brush: 'round', size: 16, color, mode: 'paint' });
      for (const x of strokeXs) host.strokePoint({ x, y: 32 });
      const edits = await host.endStroke();
      const inverses = host.applyEdits(edits);

      const paintedRb = await host.readback({ via: 'float' });
      const painted = Array.from(new Float32Array(paintedRb.data));

      // Undo: apply the inverse batch through the same channel.
      host.applyEdits(inverses);
      const undoneRb = await host.readback({ via: 'float' });
      const undone = Array.from(new Float32Array(undoneRb.data));

      return { width: paintedRb.width, painted, undone };
    },
    { layer, color, strokeXs },
  );

  const at = (data: number[], x: number, y: number) => {
    const idx = (y * result.width + x) * 4;
    return data.slice(idx, idx + 4);
  };

  expect(at(result.painted, 32, 32)[3]).toBeGreaterThan(0.9);
  // The raster SourceInstance's GPU texture must resync from doc.assets
  // (now back to pre-stroke bytes) rather than keep showing the painted
  // pixels it already had cached.
  expect(at(result.undone, 32, 32)[3]).toBeLessThan(0.05);
});

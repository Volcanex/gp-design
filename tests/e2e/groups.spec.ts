/** Contract: see tests/e2e/boot.spec.ts header for the full window.__gdesign
 * shape. Group/ungroup have no dedicated buttons: driven via
 * gd.exec('layer.group' | 'layer.ungroup'), same as every other command. */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
  // main.ts's boot() auto-plays the clock, driving a continuous render
  // loop for the page's whole lifetime; under this host's SwiftShader
  // (software) WebGPU, that compounds across sequential e2e contexts and
  // was the actual cause of this file's readback-based tests going from
  // "slow" to genuinely hanging (confirmed via isolated repro, see
  // src/ui/CLAUDE.md). clipboard.spec.ts/lut.spec.ts/paste-stability.spec.ts/
  // video-import.spec.ts already pause on boot for the same reason; this
  // file predates that convention.
  await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'pause' }));
});

async function readbackNonZero(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(async () => {
    const gd = (window as any).__gdesign;
    const result = await gd.engine.readback({ via: 'quantised' });
    return new Uint8Array(result.data).some((b: number) => b !== 0);
  });
}

test('grouping two layers nests them under a new group row and leaves the render unchanged', async ({ page }) => {
  const rows = page.locator('[data-testid="layer-row"]');
  await page.locator('[data-testid="layer-new"]').click();
  await page.locator('[data-testid="layer-new"]').click();
  const startCount = await rows.count();

  const beforeNonZero = await readbackNonZero(page);

  // Group the active (most-recently-added) layer.
  await page.evaluate(() => (window as any).__gdesign.exec('layer.group'));

  // One new group row + the grouped layer nested one level in: same total
  // row count as before plus the new group row itself.
  await expect(rows).toHaveCount(startCount + 1);

  const kinds = await page.evaluate(() =>
    [...(window as any).__gdesign.doc().layers].reverse().map((l: any) => l.kind),
  );
  expect(kinds).toContain('group');

  const afterNonZero = await readbackNonZero(page);
  expect(afterNonZero).toBe(beforeNonZero); // grouping alone must not change what's rendered
});

test('group opacity affects the readback', async ({ page }) => {
  await page.locator('[data-testid="layer-new"]').click();
  await page.evaluate(() => (window as any).__gdesign.exec('layer.group'));

  const beforeBytes = await page.evaluate(async () => {
    const gd = (window as any).__gdesign;
    const result = await gd.engine.readback({ via: 'quantised' });
    return Array.from(new Uint8Array(result.data));
  });

  // The group is now active (activeLayer wasn't reassigned by layer.group,
  // so it's still the layer that got grouped; set opacity via the group id
  // directly through the doc instead of the footer control).
  await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    const doc = gd.doc();
    const group = [...doc.layers].reverse().find((l: any) => l.kind === 'group');
    gd.stores.viewState.update((s: any) => ({ ...s, activeLayer: group.id }));
  });

  const opacitySlider = page.locator('[data-testid="layer-opacity"]');
  await opacitySlider.fill('50');
  await opacitySlider.dispatchEvent('input');

  const afterBytes = await page.evaluate(async () => {
    const gd = (window as any).__gdesign;
    const result = await gd.engine.readback({ via: 'quantised' });
    return Array.from(new Uint8Array(result.data));
  });
  expect(afterBytes).not.toEqual(beforeBytes);
});

test('ungroup restores the pre-group row count and readback', async ({ page }) => {
  await page.locator('[data-testid="layer-new"]').click();
  await page.locator('[data-testid="layer-new"]').click();
  const rows = page.locator('[data-testid="layer-row"]');
  const startCount = await rows.count();
  const beforeIds = await page.evaluate(() =>
    [...(window as any).__gdesign.doc().layers].reverse().map((l: any) => l.id),
  );
  const beforeNonZero = await readbackNonZero(page);

  await page.evaluate(() => (window as any).__gdesign.exec('layer.group'));
  await expect(rows).toHaveCount(startCount + 1);

  await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    const doc = gd.doc();
    const group = [...doc.layers].reverse().find((l: any) => l.kind === 'group');
    gd.stores.viewState.update((s: any) => ({ ...s, activeLayer: group.id }));
  });
  await page.evaluate(() => (window as any).__gdesign.exec('layer.ungroup'));

  await expect(rows).toHaveCount(startCount);
  const afterIds = await page.evaluate(() =>
    [...(window as any).__gdesign.doc().layers].reverse().map((l: any) => l.id),
  );
  expect(afterIds).toEqual(beforeIds);
  expect(await readbackNonZero(page)).toBe(beforeNonZero);
});

test('dragging a layer onto a group row nests it (drop-into)', async ({ page }) => {
  await page.locator('[data-testid="layer-new"]').click();
  await page.locator('[data-testid="layer-new"]').click();
  await page.evaluate(() => (window as any).__gdesign.exec('layer.group'));

  const rows = page.locator('[data-testid="layer-row"]');
  // Rows render top-first via a RECURSIVE walk (layers-logic.ts's
  // displayOrder): a group's children render immediately below it, at
  // depth+1, as their OWN rows. `[...doc.layers].reverse()` only sees
  // TOP-LEVEL siblings, so `groupRowIndex + 1` is the group's own CHILD
  // row, not a sibling. Dragging that back onto its own parent is
  // correctly a no-op (same parent, dropTarget's "already there" case),
  // which is what made this test fail before: it was dragging the wrong
  // row. Walk the same way the panel does and pick a genuine depth-0
  // sibling instead.
  const { groupRowIndex, otherRowIndex } = await page.evaluate(() => {
    const doc = (window as any).__gdesign.doc();
    const displayRows: { id: string; kind: string; depth: number }[] = [];
    const walk = (nodes: any[], depth: number) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        displayRows.push({ id: node.id, kind: node.kind, depth });
        if (node.kind === 'group') walk(node.children, depth + 1);
      }
    };
    walk(doc.layers, 0);
    const groupRowIndex = displayRows.findIndex((r) => r.kind === 'group');
    const otherRowIndex = displayRows.findIndex((r) => r.depth === 0 && r.kind !== 'group');
    return { groupRowIndex, otherRowIndex };
  });

  const groupChildrenBefore = await page.evaluate(() => {
    const doc = (window as any).__gdesign.doc();
    return doc.layers.find((l: any) => l.kind === 'group').children.length;
  });

  // Drag starts on the grip specifically: layers.ts's pointer-drag logic
  // lives there now, not on the row as a whole.
  const dragBox = (await rows.nth(otherRowIndex).locator('[data-testid="layer-drag-handle"]').boundingBox())!;
  const groupBox = (await rows.nth(groupRowIndex).boundingBox())!;
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(groupBox.x + groupBox.width / 2, groupBox.y + groupBox.height / 2, { steps: 4 });
  await page.mouse.up();

  const groupChildrenAfter = await page.evaluate(() => {
    const doc = (window as any).__gdesign.doc();
    return doc.layers.find((l: any) => l.kind === 'group').children.length;
  });
  expect(groupChildrenAfter).toBe(groupChildrenBefore + 1);
});

test('collapsing a group hides its children rows', async ({ page }) => {
  await page.locator('[data-testid="layer-new"]').click();
  await page.evaluate(() => (window as any).__gdesign.exec('layer.group'));

  const rows = page.locator('[data-testid="layer-row"]');
  const expandedCount = await rows.count();

  const collapseButton = page.locator('[data-testid="layer-group-collapse"]');
  await collapseButton.click();
  await expect(rows).toHaveCount(expandedCount - 1); // the grouped child's row disappears

  await collapseButton.click();
  await expect(rows).toHaveCount(expandedCount); // expanding brings it back
});

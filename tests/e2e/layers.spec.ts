/** Contract: see tests/e2e/boot.spec.ts header for the full window.__gdesign shape. */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
});

test('adding layers grows the row list; renaming, visibility, and delete all reach the document', async ({ page }) => {
  const rows = page.locator('[data-testid="layer-row"]');
  const startCount = await rows.count();

  await page.locator('[data-testid="layer-new"]').click();
  await page.locator('[data-testid="layer-new"]').click();
  await expect(rows).toHaveCount(startCount + 2);

  const lastRow = rows.last();
  await lastRow.dblclick();
  const renameInput = lastRow.locator('input');
  await renameInput.fill('Renamed Layer');
  await renameInput.press('Enter');

  const names = await page.evaluate(() => (window as any).__gdesign.doc().layers.map((l: { name: string }) => l.name));
  expect(names).toContain('Renamed Layer');

  // Rows render top-first, so the LAST row is doc.layers[0] (doc order is
  // bottom-up for compositing).
  const visibilityToggle = lastRow.locator('[data-testid="layer-visibility"]');
  const enabledBefore = await page.evaluate(
    () => (window as any).__gdesign.doc().layers[0]?.enabled,
  );
  await visibilityToggle.click();
  await expect.poll(() => page.evaluate(
    () => (window as any).__gdesign.doc().layers[0]?.enabled,
  )).toBe(!enabledBefore);

  // Delete acts on the active layer; the button lives in the panel footer.
  await lastRow.click();
  await page.locator('[data-testid="layer-delete"]').click();
  await expect(rows).toHaveCount(startCount + 1);

  await page.keyboard.press('Control+z');
  await expect(rows).toHaveCount(startCount + 2);
});

/** doc.layers is bottom-first; the panel displays top-first (layers.ts's
 * displayOrder reverses it). This mirrors that conversion so expectations
 * can be written in doc-id terms without hardcoding row positions. */
async function displayIdsTopFirst(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => [...(window as any).__gdesign.doc().layers].reverse().map((l: any) => l.id));
}

test('drag-reorder: an adjacent downward nudge actually moves the layer (reorderTarget off-by-one regression)', async ({ page }) => {
  // Boot ships 2 layers; add 2 more so there's room to nudge between rows
  // without immediately hitting the top/bottom edge cases.
  await page.locator('[data-testid="layer-new"]').click();
  await page.locator('[data-testid="layer-new"]').click();
  const rows = page.locator('[data-testid="layer-row"]');
  await expect(rows).toHaveCount(4);

  const before = await displayIdsTopFirst(page);

  // Drag row 1 down onto row 2: adjacent, downward, the single most
  // common reorder gesture, and the one the off-by-one silently no-opped.
  // The drag starts on the grip specifically (layers.ts's pointer-drag
  // logic lives there now, not on the row as a whole); the drop target can
  // stay the full row since @pointerenter/@pointerup are still row-level.
  const box1 = (await rows.nth(1).locator('[data-testid="layer-drag-handle"]').boundingBox())!;
  const box2 = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2);
  await page.mouse.down();
  // Several intermediate points, not just the endpoints: also exercises
  // the pointermove geometric drop-tracking fallback (Bug 2), not just a
  // single @pointerenter firing.
  await page.mouse.move(box1.x + box1.width / 2, (box1.y + box2.y) / 2, { steps: 2 });
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2, { steps: 2 });
  await page.mouse.up();

  const after = await displayIdsTopFirst(page);
  expect(after).not.toEqual(before); // must NOT be a silent no-op
  // Rows 1 and 2 swap; rows 0 and 3 (untouched) stay put.
  expect(after).toEqual([before[0], before[2], before[1], before[3]]);
});

test('drag-reorder: top row dropped on the bottom row lands at doc index 0, not 1', async ({ page }) => {
  await page.locator('[data-testid="layer-new"]').click();
  await page.locator('[data-testid="layer-new"]').click();
  const rows = page.locator('[data-testid="layer-row"]');
  const rowCount = await rows.count();
  const before = await displayIdsTopFirst(page);

  const topBox = (await rows.first().locator('[data-testid="layer-drag-handle"]').boundingBox())!;
  const bottomBox = (await rows.last().boundingBox())!;
  await page.mouse.move(topBox.x + topBox.width / 2, topBox.y + topBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(bottomBox.x + bottomBox.width / 2, bottomBox.y + bottomBox.height / 2, { steps: 6 });
  await page.mouse.up();

  const draggedId = await page.evaluate(() => (window as any).__gdesign.doc().layers[0]?.id);
  expect(draggedId).toBe(before[0]); // the dragged (formerly top) layer is now at doc index 0
  expect(await page.evaluate(() => (window as any).__gdesign.doc().layers.length)).toBe(rowCount);
});

test('drag-reorder: starting a rename on one row, then dragging a different row, commits the rename instead of swallowing the drag', async ({ page }) => {
  await page.locator('[data-testid="layer-new"]').click();
  const rows = page.locator('[data-testid="layer-row"]');
  await expect(rows).toHaveCount(3);
  const before = await displayIdsTopFirst(page);

  await rows.first().dblclick();
  await rows.first().locator('input').fill('Renamed mid-drag');
  // No Enter/blur: go straight into dragging a DIFFERENT row (from its
  // grip, see the off-by-one regression test's comment above).
  const box1 = (await rows.nth(1).locator('[data-testid="layer-drag-handle"]').boundingBox())!;
  const box2 = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2, { steps: 4 });
  await page.mouse.up();

  const names = await page.evaluate(() => (window as any).__gdesign.doc().layers.map((l: any) => l.name));
  expect(names).toContain('Renamed mid-drag'); // committed, not lost
  const after = await displayIdsTopFirst(page);
  expect(after).not.toEqual(before); // and the drag on the OTHER row still happened
});

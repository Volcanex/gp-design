/** Contract: see tests/e2e/boot.spec.ts header for the full window.__gdesign shape. */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
});

test('"b" selects the brush tool', async ({ page }) => {
  await page.keyboard.press('b');
  const active = await page.evaluate(() => (window as any).__gdesign.stores.toolState.get().active);
  expect(active).toBe('brush');
});

test('F7 toggles the layers panel visibility', async ({ page }) => {
  const panel = page.locator('[data-testid="panel-layers"]');
  await expect(panel).toBeVisible();
  await page.keyboard.press('F7');
  await expect(panel).toBeHidden();
  await page.keyboard.press('F7');
  await expect(panel).toBeVisible();
});

test('Ctrl+Shift+N adds a layer; Ctrl+Z undoes it; Ctrl+Y redoes it', async ({ page }) => {
  const layerCount = () => page.evaluate(() => (window as any).__gdesign.doc().layers.length);

  const before = await layerCount();
  await page.keyboard.press('Control+Shift+N');
  await expect.poll(layerCount).toBe(before + 1);

  await page.keyboard.press('Control+z');
  await expect.poll(layerCount).toBe(before);

  await page.keyboard.press('Control+y');
  await expect.poll(layerCount).toBe(before + 1);
});

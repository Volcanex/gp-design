/**
 * Docked shell layout persistence (stores.ts layoutState, key
 * gdesign.layout.v2): pane collapse, pane visibility and the right column
 * width all survive a reload; corrupt or floating-era (v1) storage boots
 * with defaults; Ctrl+Shift+F5 (panel.reset) restores the default layout.
 */

import { test, expect } from '@playwright/test';

const KEY = 'gdesign.layout.v2';

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
  await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'pause' }));
}

test('collapse, hide and splitter width survive a reload', async ({ page }) => {
  await boot(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.locator('[data-testid="pane-title-colors"]').click();
  await expect(page.locator('[data-testid="pane-title-colors"]')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('F6'); // history hidden
  await expect(page.locator('[data-testid="panel-history"]')).toBeHidden();

  const right = page.locator('#gd-right');
  const before = (await right.boundingBox())!.width;
  const splitter = page.locator('.g-splitter');
  const box = (await splitter.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 90, y, { steps: 6 });
  await page.mouse.up();
  const after = (await right.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 60);

  await page.waitForTimeout(400); // past the 250ms save debounce
  await page.reload();
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });

  await expect(page.locator('[data-testid="pane-title-colors"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-testid="panel-history"]')).toBeHidden();
  const restored = (await page.locator('#gd-right').boundingBox())!.width;
  expect(Math.abs(restored - after)).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test('corrupt and floating-era layouts boot with defaults, no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Init scripts run on every navigation, so this one fires once only:
  // the reload below must see the v1 layout it sets, not fresh garbage.
  await page.addInitScript((key) => {
    if (sessionStorage.getItem('gd-test-corrupted')) return;
    sessionStorage.setItem('gd-test-corrupted', '1');
    localStorage.setItem(key, '{not json');
  }, KEY);
  await boot(page);
  await expect(page.locator('[data-testid="panel-layers"]')).toBeVisible();

  await page.evaluate((key) => {
    localStorage.removeItem(key);
    localStorage.setItem('gdesign.layout.v1', JSON.stringify({ panels: { colors: { visible: false, x: 5, y: 5, w: 900 } }, theme: 'light' }));
  }, KEY);
  await page.reload();
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
  await expect(page.locator('[data-testid="panel-colors"]')).toBeHidden();
  await expect(page.locator('[data-testid="panel-layers"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Ctrl+Shift+F5 resets the whole layout', async ({ page }) => {
  await boot(page);
  await page.locator('[data-testid="pane-title-layers"]').click();
  await page.keyboard.press('F8');
  await expect(page.locator('[data-testid="panel-colors"]')).toBeHidden();

  await page.keyboard.press('Control+Shift+F5');
  await expect(page.locator('[data-testid="pane-title-layers"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-testid="panel-colors"]')).toBeVisible();
  const width = await page.evaluate(() => (window as any).__gdesign.stores.layoutState.get().rightWidth);
  expect(width).toBe(280);
});

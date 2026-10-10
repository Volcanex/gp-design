/** Covers the two ways boot can fail before the app is usable: no
 * navigator.gpu at all (index.html's pre-JS guard) and requestAdapter()
 * resolving null (main.ts's boot().catch(showBootFailure) path). Neither
 * scenario reaches window.__gdesign, so this file does not use
 * tests/e2e/lib/boot.ts. */

import { test, expect } from '@playwright/test';

test('no navigator.gpu shows the WebGPU boot-failure message with zero pageerrors', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'gpu', { value: undefined, configurable: true });
  });
  await page.goto('/');

  const failure = page.locator('[data-testid="boot-failure"]');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('WebGPU');

  expect(pageErrors).toEqual([]);
});

test('requestAdapter() resolving null shows the boot-failure message via showBootFailure', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.addInitScript(() => {
    const install = () => {
      if (!navigator.gpu) return;
      navigator.gpu.requestAdapter = async () => null;
    };
    install();
  });
  await page.goto('/');

  const failure = page.locator('[data-testid="boot-failure"]');
  await expect(failure).toBeVisible({ timeout: 30_000 });
  await expect(failure).toContainText('WebGPU');

  expect(pageErrors).toEqual([]);
});

/**
 * Effect menu scaling (menubar.ts's buildEffectMenus). Covers the 3-segment
 * menuPath grouping (headings) and the menuPath-undefined skip that keeps
 * internal passes (Blit, Composite, to-rgb, from-rgb) out of the Effects
 * menu. Menus are g-system popovers: every item is in the DOM from mount,
 * and a trigger's popovertarget names its menu.
 *
 * NOT run from this agent session. Build first (`npm run build`) and serve
 * dist/ before `npx playwright test tests/e2e/menu-grouping.spec.ts` (see
 * tests/CLAUDE.md).
 */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
  await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'pause' }));
});

async function openMenu(page: import('@playwright/test').Page, label: string) {
  const trigger = page.locator('[data-testid="menu-trigger"]', { hasText: label });
  await trigger.click();
  const id = await trigger.getAttribute('popovertarget');
  const menu = page.locator(`#${id}`);
  await expect(menu).toBeVisible();
  return menu;
}

test('Effects menu shows grouped section headings and omits internal passes', async ({ page }) => {
  const menu = await openMenu(page, 'Effects');
  const headings = await menu.locator('[data-testid="menu-heading"]').allTextContents();
  expect(headings.length).toBeGreaterThan(0); // Dither's "Dither" group, at minimum

  // Headings are alphabetically sorted.
  const sorted = [...headings].sort((a, b) => a.localeCompare(b));
  expect(headings).toEqual(sorted);

  // Internal passes with no menuPath must never leak into any menu.
  for (const label of ['Blit', 'Composite', 'to-rgb', 'from-rgb']) {
    await expect(page.locator('[data-testid="menu-item"] .gd-menu-label', { hasText: new RegExp(`^${label}$`) })).toHaveCount(0);
  }
});

test('a menu heading is not clickable (no command dispatch, menu stays open)', async ({ page }) => {
  const menu = await openMenu(page, 'Effects');
  const heading = menu.locator('[data-testid="menu-heading"]').first();
  await heading.click({ force: true });
  await expect(menu).toBeVisible();
  const dialogs = await page.locator('[data-testid="effect-dialog"]').count();
  expect(dialogs).toBe(0);
});

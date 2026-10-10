/** Contract: see tests/e2e/boot.spec.ts header. Small-viewport layout
 * sweep for the docked shell: the rail, the canvas region and the right
 * column share the row with no overlap, every visible pane title is
 * inside the viewport (the column scrolls, it never overflows the page),
 * and the statusbar/timeline never push the page into horizontal scroll. */

import { test, expect } from '@playwright/test';
import { bootAndPause } from './lib/boot';

function within(inner: { x: number; y: number; width: number; height: number },
  outer: { x: number; y: number; width: number; height: number }): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

async function assertLayoutSane(page: import('@playwright/test').Page): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const page_ = { x: 0, y: 0, width: viewport!.width, height: viewport!.height };

  const region = await page.locator('[data-testid="canvas-region"]').boundingBox();
  const rail = await page.locator('[data-testid="panel-tools"]').boundingBox();
  const column = await page.locator('#gd-right').boundingBox();
  expect(region).not.toBeNull();
  expect(rail).not.toBeNull();
  expect(column).not.toBeNull();
  expect(rail!.x + rail!.width).toBeLessThanOrEqual(region!.x + 0.5);
  expect(region!.x + region!.width).toBeLessThanOrEqual(column!.x + 6);
  expect(within(column!, page_), 'right column outside the viewport').toBe(true);
  expect(region!.width).toBeGreaterThan(200);

  const titles = page.locator('.g-pane:not([hidden]) > .g-pane-title');
  const count = await titles.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    // The column scrolls when the window is short: a title is "reachable"
    // if scrolling the column brings it fully into the viewport.
    await titles.nth(i).scrollIntoViewIfNeeded();
    const box = await titles.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(within(box!, page_), `pane title #${i} outside the viewport`).toBe(true);
  }
  const statusbar = await page.locator('.gd-statusbar').boundingBox();
  expect(statusbar).not.toBeNull();
  expect(statusbar!.y).toBeGreaterThanOrEqual(0);
  expect(statusbar!.y + statusbar!.height).toBeLessThanOrEqual(viewport!.height + 0.5);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const innerWidth = await page.evaluate(() => window.innerWidth);
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test('panels and the statusbar stay inside a small viewport, before and after resize', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 560 });
  await bootAndPause(page);
  await assertLayoutSane(page);

  await page.setViewportSize({ width: 1280, height: 600 });
  await assertLayoutSane(page);
});

test('opening the timeline (F10) keeps the statusbar visible', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 560 });
  await bootAndPause(page);

  await page.keyboard.press('F10');
  await expect(page.locator('.gd-statusbar')).toBeVisible();

  const viewport = page.viewportSize()!;
  const statusbar = await page.locator('.gd-statusbar').boundingBox();
  expect(statusbar).not.toBeNull();
  expect(statusbar!.y + statusbar!.height).toBeLessThanOrEqual(viewport.height + 0.5);

  await page.keyboard.press('F10'); // close it again, tidy
});

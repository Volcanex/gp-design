/**
 * Single-coordinate-system pan/zoom: panX/panY is the canvas's absolute
 * top-left within .gd-canvas-region (see src/ui/shell/view-math.ts and
 * src/ui/CLAUDE.md's viewport section). Assertions use window.__gdesign +
 * getBoundingClientRect, never screenshots (see tests/CLAUDE.md).
 */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
});

async function viewState(page: any) {
  return page.evaluate(() => (window as any).__gdesign.stores.viewState.get());
}

async function canvasRect(page: any) {
  return page.evaluate(() => document.getElementById('gd-canvas')!.getBoundingClientRect());
}

async function regionRect(page: any) {
  return page.evaluate(() => document.querySelector('[data-testid="canvas-region"]')!.getBoundingClientRect());
}

test('boot fits and centres the canvas fully inside the region', async ({ page }) => {
  const region = await regionRect(page);
  const canvas = await canvasRect(page);
  expect(canvas.left).toBeGreaterThanOrEqual(region.left - 0.5);
  expect(canvas.top).toBeGreaterThanOrEqual(region.top - 0.5);
  expect(canvas.right).toBeLessThanOrEqual(region.right + 0.5);
  expect(canvas.bottom).toBeLessThanOrEqual(region.bottom + 0.5);
  // Centred: equal-ish margins left/right and top/bottom (up to rounding).
  const marginLeft = canvas.left - region.left;
  const marginRight = region.right - canvas.right;
  expect(Math.abs(marginLeft - marginRight)).toBeLessThan(2);
});

test('Ctrl+wheel zoom keeps the cursor doc point fixed', async ({ page }) => {
  const region = await regionRect(page);
  const cursorClientX = region.left + region.width * 0.3;
  const cursorClientY = region.top + region.height * 0.6;

  const before = await viewState(page);
  const docBefore = {
    x: (cursorClientX - region.left - before.panX) / before.zoom,
    y: (cursorClientY - region.top - before.panY) / before.zoom,
  };

  await page.mouse.move(cursorClientX, cursorClientY);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');

  const after = await viewState(page);
  expect(after.zoom).not.toBeCloseTo(before.zoom, 5);
  const docAfter = {
    x: (cursorClientX - region.left - after.panX) / after.zoom,
    y: (cursorClientY - region.top - after.panY) / after.zoom,
  };
  expect(Math.abs(docAfter.x - docBefore.x)).toBeLessThan(1);
  expect(Math.abs(docAfter.y - docBefore.y)).toBeLessThan(1);
});

test('"h" then a plain drag pans the canvas 1:1', async ({ page }) => {
  await page.keyboard.press('h');
  const region = await regionRect(page);
  const before = await viewState(page);

  const startX = region.left + region.width / 2;
  const startY = region.top + region.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 40, startY + 25, { steps: 5 });
  await page.mouse.up();

  const after = await viewState(page);
  expect(after.panX - before.panX).toBeCloseTo(40, 0);
  expect(after.panY - before.panY).toBeCloseTo(25, 0);
});

test('Shift+drag pans 1:1 with the brush tool active and paints nothing', async ({ page }) => {
  const active = await page.evaluate(() => (window as any).__gdesign.stores.toolState.get().active);
  expect(active).toBe('brush');

  const region = await regionRect(page);
  const before = await viewState(page);
  const startX = region.left + region.width / 2;
  const startY = region.top + region.height / 2;

  await page.mouse.move(startX, startY);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(startX - 30, startY - 15, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');

  const after = await viewState(page);
  expect(after.panX - before.panX).toBeCloseTo(-30, 0);
  expect(after.panY - before.panY).toBeCloseTo(-15, 0);

  const historyRows = await page.locator('[data-testid="history-row"]').count();
  expect(historyRows).toBe(0);
});

test('Ctrl+Equal zooms anchored at the region centre', async ({ page }) => {
  const region = await regionRect(page);
  const centreX = region.width / 2;
  const centreY = region.height / 2;

  const before = await viewState(page);
  const docBefore = { x: (centreX - before.panX) / before.zoom, y: (centreY - before.panY) / before.zoom };

  await page.keyboard.press('Control+Equal');

  const after = await viewState(page);
  expect(after.zoom).toBeGreaterThan(before.zoom);
  const docAfter = { x: (centreX - after.panX) / after.zoom, y: (centreY - after.panY) / after.zoom };
  expect(Math.abs(docAfter.x - docBefore.x)).toBeLessThan(1);
  expect(Math.abs(docAfter.y - docBefore.y)).toBeLessThan(1);
});

test('Zoom tool: click zooms in 1.25x anchored at the cursor', async ({ page }) => {
  await page.keyboard.press('z');
  const active = await page.evaluate(() => (window as any).__gdesign.stores.toolState.get().active);
  expect(active).toBe('zoom');

  const region = await regionRect(page);
  const clickX = region.left + region.width * 0.35;
  const clickY = region.top + region.height * 0.4;

  const before = await viewState(page);
  const docBefore = {
    x: (clickX - region.left - before.panX) / before.zoom,
    y: (clickY - region.top - before.panY) / before.zoom,
  };

  await page.mouse.click(clickX, clickY);

  const after = await viewState(page);
  expect(after.zoom).toBeCloseTo(before.zoom * 1.25, 5);
  const docAfter = {
    x: (clickX - region.left - after.panX) / after.zoom,
    y: (clickY - region.top - after.panY) / after.zoom,
  };
  expect(Math.abs(docAfter.x - docBefore.x)).toBeLessThan(1);
  expect(Math.abs(docAfter.y - docBefore.y)).toBeLessThan(1);
});

test('panning far away then Ctrl+B recovers a fitted, centred canvas', async ({ page }) => {
  await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    gd.stores.viewState.update((s: any) => ({ ...s, panX: -5000, panY: -5000, zoom: 8 }));
  });
  await page.keyboard.press('Control+b');

  const region = await regionRect(page);
  const canvas = await canvasRect(page);
  expect(canvas.left).toBeGreaterThanOrEqual(region.left - 0.5);
  expect(canvas.top).toBeGreaterThanOrEqual(region.top - 0.5);
  expect(canvas.right).toBeLessThanOrEqual(region.right + 0.5);
  expect(canvas.bottom).toBeLessThanOrEqual(region.bottom + 0.5);
  const marginLeft = canvas.left - region.left;
  const marginRight = region.right - canvas.right;
  expect(Math.abs(marginLeft - marginRight)).toBeLessThan(2);
});

test('plain wheel pans vertically', async ({ page }) => {
  const region = await regionRect(page);
  await page.mouse.move(region.left + region.width / 2, region.top + region.height / 2);
  const before = await viewState(page);
  await page.mouse.wheel(0, 100);
  const after = await viewState(page);
  expect(after.panX).toBeCloseTo(before.panX, 0);
  expect(after.panY).toBeLessThan(before.panY);
});

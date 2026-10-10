import { test, expect } from '@playwright/test';

/**
 * The REAL presentation path (canvas swapchain) is skipped under SwiftShader
 * by default, which is how a present-before-submit ordering bug shipped while
 * 33 readback-based tests stayed green. This spec forces swapchain config
 * (__GDESIGN_FORCE_PRESENT, see gpu/device.ts) and asserts the present path
 * produces zero WebGPU validation warnings across boot, edits, and a brush
 * drag. Pixels can't be asserted here (presenting breaks mapAsync on this
 * SwiftShader build), so warning-freedom is the signal.
 */

test('forced presentation runs clean: no WebGPU validation warnings', async ({ page }) => {
  const gpuWarnings: string[] = [];
  page.on('console', (m) => {
    const text = m.text();
    if (/(Invalid|error while parsing WGSL|does not satisfy|Destroyed texture|\[Invalid)/i.test(text)) {
      gpuWarnings.push(text.slice(0, 300));
    }
  });
  page.on('pageerror', (e) => {
    const text = String(e);
    // Known SwiftShader-only environment bug (see gpu/device.ts): once a
    // swapchain is configured, mapAsync dies with this exact error. It is
    // the reason presentation is normally skipped here, and does not occur
    // on real hardware. Everything else is a real failure.
    if (/mapAsync.*valid external Instance/i.test(text)) return;
    gpuWarnings.push(`pageerror: ${text.slice(0, 300)}`);
  });

  await page.addInitScript(() => {
    (globalThis as { __GDESIGN_FORCE_PRESENT?: boolean }).__GDESIGN_FORCE_PRESENT = true;
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });

  // Exercise presents: a few explicit frames, a document edit, a brush drag.
  await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    for (let i = 0; i < 3; i++) gd.engine.requestFrame();
    gd.exec('layer.new');
  });
  await page.keyboard.press('b');
  const canvas = page.locator('#gd-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  expect(gpuWarnings, gpuWarnings.join('\n')).toEqual([]);
});

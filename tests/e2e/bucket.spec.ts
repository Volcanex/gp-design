/**
 * Contract: see tests/e2e/boot.spec.ts header for the full window.__gdesign
 * shape. WRITTEN, NOT RUN (see agents/ brief for this workstream). The
 * float readback path here mirrors paint.spec.ts's picker test.
 */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
  // Pause the auto-playing clock (SwiftShader readback-hang convention,
  // see groups.spec.ts's beforeEach).
  await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));
});

/** Reads back one pixel's OKLab+alpha via the float readback path (exact
 * under SwiftShader, see tests/CLAUDE.md), same idiom as paint.spec.ts's picker test. */
async function readPixel(page: import('@playwright/test').Page, x: number, y: number) {
  return page.evaluate(async ({ x, y }) => {
    const gd = (window as any).__gdesign;
    const result = await gd.engine.readback({ via: 'float' });
    const data = new Float32Array(result.data);
    const px = Math.round(x), py = Math.round(y);
    const i = (py * result.width + px) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  }, { x, y });
}

test('bucket-click inside a painted ring fills the interior, leaves the ring and outside untouched, and undoes in one step', async ({ page }) => {
  const fillColor = [0.95, 0, 0, 1];
  await page.evaluate((color) => {
    const gd = (window as any).__gdesign;
    gd.stores.toolState.update((s: any) => ({ ...s, primary: color, brushSize: 30, bucketTolerance: 0.08 }));
  }, fillColor);

  // Paint a closed ring with the brush around the DOC centre. Boot zoom is
  // fit-to-region (usually < 1), so client px != doc px. Convert through
  // the live zoom like every other canvas-drag spec (tools2's header).
  await page.keyboard.press('b');
  const canvas = page.locator('#gd-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas not laid out');
  const { zoom } = await page.evaluate(() => (window as any).__gdesign.stores.viewState.get());
  const docW = await page.evaluate(() => (window as any).__gdesign.doc().canvas.width);
  const docH = await page.evaluate(() => (window as any).__gdesign.doc().canvas.height);
  const cxDoc = docW / 2;
  const cyDoc = docH / 2;
  const client = (dx: number, dy: number) => [box.x + dx * zoom, box.y + dy * zoom] as const;
  const radius = 80; // doc px
  const steps = 24;
  await page.mouse.move(...client(cxDoc + radius, cyDoc));
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    await page.mouse.move(...client(cxDoc + radius * Math.cos(angle), cyDoc + radius * Math.sin(angle)), { steps: 2 });
  }
  await page.mouse.up();

  await expect.poll(() => page.evaluate(() => {
    const gd = (window as any).__gdesign;
    return Object.values(gd.doc().assets).some((a: any) => a.type === 'raster');
  }), { timeout: 15_000 }).toBe(true);

  const beforeOutside = await readPixel(page, cxDoc + radius + 40, cyDoc);
  const beforeRing = await readPixel(page, cxDoc + radius, cyDoc);

  // Bucket-fill the interior.
  await page.keyboard.press('f');
  await page.mouse.click(...client(cxDoc, cyDoc));

  await expect.poll(() => page.evaluate(() => {
    const gd = (window as any).__gdesign;
    return gd.doc().layers.find((l: any) => l.id === gd.stores.viewState.get().activeLayer)?.name ?? null;
  }), { timeout: 15_000 }).not.toBeNull();

  const inside = await readPixel(page, cxDoc, cyDoc);
  for (let i = 0; i < 3; i += 1) expect(inside[i]).toBeCloseTo(fillColor[i]!, 1);
  expect(inside[3]).toBeCloseTo(1, 1);

  const afterRing = await readPixel(page, cxDoc + radius, cyDoc);
  const afterOutside = await readPixel(page, cxDoc + radius + 40, cyDoc);
  for (let i = 0; i < 4; i += 1) {
    expect(afterRing[i]).toBeCloseTo(beforeRing[i]!, 1);
    expect(afterOutside[i]).toBeCloseTo(beforeOutside[i]!, 1);
  }

  // One Ctrl+Z reverts the entire fill: the interior goes back to whatever
  // it read as before the bucket click (transparent, in this fixture).
  await page.keyboard.press('Control+z');
  const afterUndo = await readPixel(page, cxDoc, cyDoc);
  expect(Math.abs(afterUndo[0]! - fillColor[0]!)).toBeGreaterThan(0.05);
});

test('bucket fill on a brand-new (assetless) paint layer fills the whole canvas in one undoable step', async ({ page }) => {
  const fillColor = [0.3, 0.05, -0.02, 1];
  await page.evaluate((color) => {
    const gd = (window as any).__gdesign;
    gd.stores.toolState.update((s: any) => ({ ...s, primary: color, bucketTolerance: 0.08 }));
    // The starter doc's own 'Paint' layer IS the brand-new assetless raster
    // layer this test wants. The first draft ran layer.new here, but that
    // creates an OPAQUE core.solid layer on top, hiding the fill entirely.
    const paint = gd.doc().layers.find((l: any) => l.kind === 'layer' && l.source.type === 'core.raster');
    gd.stores.viewState.update((s: any) => ({ ...s, activeLayer: paint.id }));
  }, fillColor);

  await page.keyboard.press('f');
  const canvas = page.locator('#gd-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas not laid out');
  // Click the canvas CENTRE: a corner click lands under the docked Tools
  // panel, which silently eats the pointer event (tools2.spec.ts's header
  // documents the trap). The fill floods the whole canvas from any seed.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect.poll(() => page.evaluate(() => {
    const gd = (window as any).__gdesign;
    return Object.values(gd.doc().assets).filter((a: any) => a.type === 'raster').length;
  }), { timeout: 15_000 }).toBeGreaterThan(0);

  const docSize = await page.evaluate(() => (window as any).__gdesign.doc().canvas);
  const corner = await readPixel(page, 5, 5);
  const centre = await readPixel(page, docSize.width / 2, docSize.height / 2);
  for (let i = 0; i < 3; i += 1) {
    expect(corner[i]).toBeCloseTo(fillColor[i]!, 1);
    expect(centre[i]).toBeCloseTo(fillColor[i]!, 1);
  }

  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => {
    const gd = (window as any).__gdesign;
    return Object.values(gd.doc().assets).some((a: any) => a.type === 'raster');
  })).toBe(false);
});

test('tolerance 0 vs a wide tolerance fill different extents across an antialiased brush edge', async ({ page }) => {
  await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    gd.stores.toolState.update((s: any) => ({ ...s, primary: [0.6, 0.1, -0.05, 1], brushSize: 60 }));
  });
  await page.keyboard.press('b');
  const canvas = page.locator('#gd-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas not laid out');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const boxWidth = box.width;
  const boxHeight = box.height;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.up(); // single dab -> a soft-edged round brush stamp

  await expect.poll(() => page.evaluate(() => {
    const gd = (window as any).__gdesign;
    return Object.values(gd.doc().assets).some((a: any) => a.type === 'raster');
  }), { timeout: 15_000 }).toBe(true);

  async function fillAndMeasureExtent(tolerance: number): Promise<number> {
    await page.evaluate((tol) => {
      const gd = (window as any).__gdesign;
      gd.stores.toolState.update((s: any) => ({ ...s, primary: [0.95, 0, 0, 1], bucketTolerance: tol }));
    }, tolerance);
    await page.keyboard.press('f');
    await page.mouse.click(cx, cy);
    await expect.poll(() => page.evaluate(() => (window as any).__gdesign.doc().layers.length)).toBeGreaterThan(0);
    // Measure how far right of centre the fill reached along the horizontal midline.
    let extent = 0;
    for (let dx = 0; dx < 40; dx += 2) {
      const px = await readPixel(page, boxWidth / 2 + dx, boxHeight / 2);
      if (Math.abs(px[0]! - 0.95) < 0.05) extent = dx;
    }
    await page.keyboard.press('Control+z');
    return extent;
  }

  const narrowExtent = await fillAndMeasureExtent(0);
  const wideExtent = await fillAndMeasureExtent(0.3);
  expect(wideExtent).toBeGreaterThanOrEqual(narrowExtent);
});

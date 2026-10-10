/** Contract: see tests/e2e/boot.spec.ts header for the full window.__gdesign shape. */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
});

test('brush drag wires down/move/up into beginStroke/strokePoint/endStroke and commits once the engine lands', async ({ page }) => {
  await page.keyboard.press('b');
  const active = await page.evaluate(() => (window as any).__gdesign.stores.toolState.get().active);
  expect(active).toBe('brush');

  // Deliberately activate the SOLID background layer: painting must still
  // work (resolvePaintLayer falls through to the starter doc's raster layer).
  await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    const layer = gd.doc().layers[0];
    gd.stores.viewState.update((s: any) => ({ ...s, activeLayer: layer.id }));
  });

  // Instrument the SAME engine instance paint-tool.ts holds (window.__gdesign.engine
  // is app.engine by reference, see main.ts) to count calls without needing
  // to widen the frozen __gdesign contract.
  await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    (window as any).__paintProbe = { begin: 0, points: 0, end: 0 };
    const engine = gd.engine;
    const origBegin = engine.beginStroke.bind(engine);
    const origPoint = engine.strokePoint.bind(engine);
    const origEnd = engine.endStroke.bind(engine);
    engine.beginStroke = (cfg: unknown) => { (window as any).__paintProbe.begin += 1; return origBegin(cfg); };
    engine.strokePoint = (p: unknown) => { (window as any).__paintProbe.points += 1; return origPoint(p); };
    engine.endStroke = async () => { (window as any).__paintProbe.end += 1; return origEnd(); };
  });

  const canvas = page.locator('#gd-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas not laid out');
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 30, centerY + 20, { steps: 5 });
  await page.mouse.up();

  await expect.poll(() => page.evaluate(() => (window as any).__paintProbe.end)).toBeGreaterThan(0);
  const probe = await page.evaluate(() => (window as any).__paintProbe);
  expect(probe.begin).toBe(1);
  expect(probe.points).toBeGreaterThanOrEqual(2); // at least the down point + the up point
  expect(probe.end).toBe(1);

  // The drag above already committed: even with the solid layer active,
  // resolvePaintLayer routed the stroke to the starter doc's raster layer.
  // The batch goes through patchCommand → history exactly once; the raster
  // asset appears in doc.assets and the stroke is one undoable step.
  await expect.poll(() => page.evaluate(() => {
    const gd = (window as any).__gdesign;
    const assets = gd.doc().assets;
    return Object.values(assets).some((a: any) => a.type === 'raster');
  }), { timeout: 15_000 }).toBe(true);

  await page.keyboard.press('Control+z');
  // Undo replays the inverse batch; the stroke created the asset, so undo
  // removes it again.
  await expect.poll(() => page.evaluate(() => {
    const gd = (window as any).__gdesign;
    return Object.values(gd.doc().assets).some((a: any) => a.type === 'raster');
  })).toBe(false);
});

test('picker round-trips a painted OKLab colour exactly (no sRGB double-conversion)', async ({ page }) => {
  const knownColor = [0.62, 0.08, -0.04, 1];

  await page.evaluate((color) => {
    const gd = (window as any).__gdesign;
    gd.stores.toolState.update((s: any) => ({ ...s, primary: color, brushSize: 40 }));
  }, knownColor);

  await page.keyboard.press('b');
  const canvas = page.locator('#gd-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas not laid out');
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 5, centerY, { steps: 3 });
  await page.mouse.up();

  await expect.poll(() => page.evaluate(() => {
    const gd = (window as any).__gdesign;
    return Object.values(gd.doc().assets).some((a: any) => a.type === 'raster');
  }), { timeout: 15_000 }).toBe(true);

  // Reset primary (alpha 0, so the poll below can't be satisfied by the
  // reset value itself) so the pick below can't accidentally pass by
  // reading back the value it started with.
  await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    gd.stores.toolState.update((s: any) => ({ ...s, primary: [0, 0, 0, 0] }));
  });

  await page.keyboard.press('k');
  await page.mouse.click(centerX, centerY);

  const picked = await page.waitForFunction(() => {
    const gd = (window as any).__gdesign;
    const p = gd.stores.toolState.get().primary;
    return p[3] > 0.5 ? p : null;
  }, { timeout: 15_000 }).then((h) => h.jsonValue());

  for (let i = 0; i < 4; i += 1) {
    expect(Math.abs((picked as number[])[i]! - knownColor[i]!)).toBeLessThanOrEqual(0.02);
  }
});

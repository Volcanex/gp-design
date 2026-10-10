/**
 * ADJUST block (own this file; see gdesign-wt/adjust). Contract: see
 * tests/e2e/boot.spec.ts header for window.__gdesign and window.__engineTest.
 * Engine-level cases (a-d) use the engine-test.html harness + host.readback
 * (never screenshots, see tests/CLAUDE.md); the app-level case (e) drives
 * the real UI (Layers menu, F9 Effects panel) via window.__gdesign.
 *
 * WRITTEN, NOT RUN: per the team-lead brief, this repo's playwright/build
 * gates are out of scope for this workstream; tsc+vitest are the verified
 * gates. Follows chain-panel.spec.ts's "at most one readback() per page once
 * a chain is involved" convention for the app-level test.
 */

import { test, expect, type Page } from '@playwright/test';

function twoLayerDoc(opts: {
  baseColor: [number, number, number, number];
  adjustmentAbove: boolean;
  adjustmentChain?: { id: string; pass: string; params: Record<string, unknown>; enabled: boolean }[];
  adjustmentOpacity?: number;
  thirdLayerColor?: [number, number, number, number];
}) {
  const base = {
    id: 'base',
    kind: 'layer',
    name: 'Base',
    enabled: true,
    source: { type: 'core.solid', params: { color: opts.baseColor } },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
  };
  const adjustment = {
    id: 'adj',
    kind: 'layer',
    name: 'Adjustment',
    enabled: true,
    source: { type: 'core.adjustment', params: {} },
    chain: opts.adjustmentChain ?? [],
    blendMode: 'normal',
    opacity: opts.adjustmentOpacity ?? 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
  };
  const layers = opts.adjustmentAbove ? [base, adjustment] : [adjustment, base];
  if (opts.thirdLayerColor) {
    layers.push({
      id: 'top',
      kind: 'layer',
      name: 'Top',
      enabled: true,
      source: { type: 'core.solid', params: { color: opts.thirdLayerColor } },
      chain: [],
      blendMode: 'normal',
      opacity: 1,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
      liveness: 'live',
    });
  }
  return {
    version: 1,
    canvas: { width: 8, height: 8, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers,
    postChain: [],
    assets: {},
  };
}

async function readCentre(page: Page): Promise<number[]> {
  const r = await page.evaluate(async () => {
    const res = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: res.width, height: res.height, data: Array.from(new Float32Array(res.data)) };
  });
  const cx = Math.floor(r.width / 2);
  const cy = Math.floor(r.height / 2);
  const idx = (cy * r.width + cx) * 4;
  return r.data.slice(idx, idx + 4);
}

test.describe('adjustment layers (engine-level)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
  });

  test('(a) solid red + adjustment layer above with core.invert in its chain -> readback = inverted red', async ({ page }) => {
    const red: [number, number, number, number] = [0.5, 0.15, 0.05, 1];
    const doc = twoLayerDoc({
      baseColor: red,
      adjustmentAbove: true,
      adjustmentChain: [{ id: 'fx1', pass: 'core.invert', params: {}, enabled: true }],
    });
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);

    const px = await readCentre(page);
    expect(px[0]).toBeCloseTo(1 - red[0], 2);
    expect(px[1]).toBeCloseTo(-red[1], 2);
    expect(px[2]).toBeCloseTo(-red[2], 2);
    expect(px[3]).toBeCloseTo(1, 2);
  });

  test('(b) a layer ABOVE the adjustment layer is not affected by it', async ({ page }) => {
    const red: [number, number, number, number] = [0.5, 0.15, 0.05, 1];
    const blue: [number, number, number, number] = [0.4, -0.1, -0.2, 1];
    const doc = twoLayerDoc({
      baseColor: red,
      adjustmentAbove: true,
      adjustmentChain: [{ id: 'fx1', pass: 'core.invert', params: {}, enabled: true }],
      thirdLayerColor: blue, // stacks above BOTH base and adjustment
    });
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);

    const px = await readCentre(page);
    // The top solid layer paints over everything below it (opacity 1,
    // normal blend): its own color, untouched by the adjustment beneath it.
    expect(px[0]).toBeCloseTo(blue[0], 2);
    expect(px[1]).toBeCloseTo(blue[1], 2);
    expect(px[2]).toBeCloseTo(blue[2], 2);
  });

  test('(c) adjustment opacity 0.5 -> half-strength effect (linear mix of base and fully-adjusted result)', async ({ page }) => {
    const red: [number, number, number, number] = [0.5, 0.15, 0.05, 1];
    const doc = twoLayerDoc({
      baseColor: red,
      adjustmentAbove: true,
      adjustmentChain: [{ id: 'fx1', pass: 'core.invert', params: {}, enabled: true }],
      adjustmentOpacity: 0.5,
    });
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);

    const px = await readCentre(page);
    const inverted = [1 - red[0], -red[1], -red[2]];
    // core.composite's porter_duff_over on two fully-opaque inputs reduces to
    // a plain per-component lerp(base, src, opacity). See composite.ts.
    const expected = [0, 1, 2].map((i) => red[i]! * 0.5 + inverted[i]! * 0.5);
    expect(px[0]).toBeCloseTo(expected[0]!, 2);
    expect(px[1]).toBeCloseTo(expected[1]!, 2);
    expect(px[2]).toBeCloseTo(expected[2]!, 2);
  });

  test('(d) reordering the adjustment layer BELOW the solid layer has no effect on it', async ({ page }) => {
    const red: [number, number, number, number] = [0.5, 0.15, 0.05, 1];
    const doc = twoLayerDoc({
      baseColor: red,
      adjustmentAbove: false, // adjustment is now the bottom layer, solid is on top
      adjustmentChain: [{ id: 'fx1', pass: 'core.invert', params: {}, enabled: true }],
    });
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);

    const px = await readCentre(page);
    // The adjustment layer only ever sees what's ALREADY composited below
    // it (nothing, here). With nothing below it to adjust, the solid layer
    // above renders its own unaffected color.
    expect(px[0]).toBeCloseTo(red[0], 2);
    expect(px[1]).toBeCloseTo(red[1], 2);
    expect(px[2]).toBeCloseTo(red[2], 2);
  });
});

test.describe('adjustment layers (app-level)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true, { timeout: 30_000 });
    // Pause the auto-playing clock (SwiftShader readback-hang convention,
    // see groups.spec.ts's beforeEach).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));
  });

  test('(e) Layers > New Adjustment Layer, F9 add Invert, readback changes; undo x N restores', async ({ page, browser }) => {
    // Boot doc's default layer is an asymmetric-chroma solid (see chain-panel
    // .spec.ts's comment on why: invert's fixed point is grey, which would
    // make a "readback changed" assertion pass/fail for the wrong reason).
    await page.evaluate(() => window.__gdesign!.exec('layer.newAdjustment'));

    const layersAfterAdd = await page.evaluate(() => window.__gdesign!.doc().layers.length);

    await page.keyboard.press('Control+Shift+I'); // effect.open core.invert, targets the active (adjustment) layer
    await page.locator('[data-testid="effect-ok"]').click();

    const chain = await page.evaluate(() => {
      const gd = window.__gdesign!;
      const activeId = gd.stores.viewState.get().activeLayer;
      return gd.doc().layers.find((l) => l.id === activeId)!.chain.map((fx) => fx.pass);
    });
    expect(chain).toEqual(['core.invert']);

    // Exactly one readback() call in this page, now that a chain is involved
    // (see chain-panel.spec.ts header note 2).
    const withAdjustment = await page.evaluate(async () => {
      const r = await window.__gdesign!.engine.readback({ via: 'quantised' });
      return Array.from(new Uint8Array(r.data));
    });

    const page2 = await browser.newPage();
    await page2.goto('/');
    await page2.waitForFunction(() => window.__gdesign?.ready === true, { timeout: 30_000 });
    // Pause the auto-playing clock (SwiftShader readback-hang convention,
    // see groups.spec.ts's beforeEach).
    await page2.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));
    const withoutAdjustment = await page2.evaluate(async () => {
      const r = await window.__gdesign!.engine.readback({ via: 'quantised' });
      return Array.from(new Uint8Array(r.data));
    });
    await page2.close();

    expect(withAdjustment).not.toEqual(withoutAdjustment);

    // Undo the effect-add, then undo the layer-add: back to the boot doc's
    // original layer count, no readback() needed for this half.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    const layersAfterUndo = await page.evaluate(() => window.__gdesign!.doc().layers.length);
    expect(layersAfterUndo).toBe(layersAfterAdd - 1);
  });

  test('Adjustments menu leads with "New adjustment layer"', async ({ page }) => {
    const trigger = page.locator('[data-testid="menu-trigger"]', { hasText: 'Adjustments' });
    await trigger.click();
    const menu = page.locator(`#${await trigger.getAttribute('popovertarget')}`);
    const firstItem = menu.locator('[data-testid="menu-item"] .gd-menu-label').first();
    await expect(firstItem).toHaveText('New adjustment layer');
  });

  test('layers panel shows the adjustment indicator icon on an adjustment layer row, not on an ordinary one', async ({ page }) => {
    await page.locator('[data-testid="layer-new"]').click();
    await page.evaluate(() => window.__gdesign!.exec('layer.newAdjustment'));

    const rows = page.locator('[data-testid="layer-row"]');
    // Top-first: row 0 is the just-added adjustment layer (most recent).
    await expect(rows.first().locator('[data-testid="layer-adjustment-icon"]')).toBeVisible();
    await expect(rows.nth(1).locator('[data-testid="layer-adjustment-icon"]')).toHaveCount(0);
  });
});

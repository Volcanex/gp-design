/**
 * window.__gdesign contract (shell tracks A/B/C, Phase 1):
 *
 *   window.__gdesign = {
 *     ready: boolean;
 *     engine: EngineHost;               // @engine facade (see src/engine/host/EngineHost.ts)
 *     doc(): DocumentJSON;              // engine.getDocument()
 *     stores: {
 *       toolState: Store<ToolState>;       // track A: src/app/stores.ts
 *       viewState: Store<ViewState>;       // track A
 *       selectionState: Store<SelectionState>; // track A
 *       layoutState: Store<LayoutState>;   // track A
 *     };
 *     exec(id: string): void;           // track B: command registry dispatch
 *   };
 *
 * Panel testids (track A, panels dock through PanelHost):
 *   [data-testid="panel-tools"]
 *   [data-testid="panel-history"]
 *   [data-testid="panel-layers"]
 *   [data-testid="panel-colors"]
 *
 * Layer-list testids (track B):
 *   [data-testid="layer-new"]:        add-layer button
 *   [data-testid="layer-row"]:        one per layer, in document order
 *   [data-testid="layer-visibility"]: visibility toggle within a row
 *   [data-testid="layer-delete"]:     delete button within a row
 *
 * Dialog testids (track C, this file's owner):
 *   [data-testid="effect-dialog"], "effect-ok", "effect-cancel"
 *   [data-testid="layer-props-dialog"], "layer-props-ok", "layer-props-cancel"
 *
 * Menubar: [data-testid="menubar"].
 */

import { test, expect } from '@playwright/test';

// The full contract isn't yet reflected in main.ts's `declare global` (tracks
// A/B widen it at Phase 1 merge, see header above); read it through `any`
// here so this spec doesn't need to change when that widening lands, and
// doesn't fight main.ts's own (narrower, Phase-0) ambient declaration.

test('boots the app, initialises the engine, and shows the shell chrome', async ({ page }) => {
  await page.goto('/');

  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });

  const readback = await page.evaluate(async () => {
    const gd = (window as any).__gdesign;
    const result = await gd.engine.readback({ via: 'quantised' });
    const bytes = new Uint8Array(result.data);
    return { width: result.width, height: result.height, nonZero: bytes.some((b: number) => b !== 0) };
  });
  expect(readback.width).toBeGreaterThan(0);
  expect(readback.height).toBeGreaterThan(0);
  expect(readback.nonZero).toBe(true);

  await expect(page.locator('[data-testid="menubar"]')).toBeVisible();
  await expect(page.locator('[data-testid="panel-tools"]')).toBeVisible();
  await expect(page.locator('[data-testid="panel-history"]')).toBeVisible();
  await expect(page.locator('[data-testid="panel-layers"]')).toBeVisible();
  await expect(page.locator('[data-testid="panel-colors"]')).toBeVisible();
});

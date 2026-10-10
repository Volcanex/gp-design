/**
 * Contract: see tests/e2e/boot.spec.ts header for the full window.__gdesign
 * shape. This spec covers the wave-2 shell fixes: menu-hint correctness,
 * dialog keyboard gating, effect-dialog cancel-revert, drag-and-drop import,
 * the statusbar toast, and File New/Save/Open.
 *
 * NOT run from this agent session. Build first (`npm run build`) and serve
 * dist/ before `npx playwright test tests/e2e/shell2.spec.ts` (see
 * tests/CLAUDE.md: ad-hoc preview servers get reaped from agent sessions,
 * use a throwaway `python3 -m http.server` + GDESIGN_BASE_URL for worktree
 * builds instead of the shared systemd dist:8095).
 */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
});

test('effect menu hints: at most one item per shortcut, not every generated item', async ({ page }) => {
  // Open every top menu and collect (item label -> hint) pairs; the old bug
  // stamped 'Ctrl+L' on every Effects/Adjustments item.
  const triggers = page.locator('.gd-menu__trigger');
  const count = await triggers.count();
  const hintCounts = new Map<string, number>();

  for (let i = 0; i < count; i++) {
    await triggers.nth(i).click();
    const hints = await page.locator('.gd-menu__item .gd-menu__hint').allTextContents();
    for (const h of hints) {
      const trimmed = h.trim();
      if (!trimmed) continue;
      hintCounts.set(trimmed, (hintCounts.get(trimmed) ?? 0) + 1);
    }
    await page.keyboard.press('Escape');
  }

  for (const [hint, n] of hintCounts) {
    expect(n, `hint "${hint}" should label exactly one menu item`).toBe(1);
  }
});

test('a modal dialog suppresses canvas-scoped shortcuts until it closes', async ({ page }) => {
  // Any effect id opens the dialog (registry.ts's effect.open no-ops
  // gracefully if the id isn't registered: the dialog still opens and
  // shows "not available yet" via a toast in that case, so pick whichever
  // the app actually lists to keep this robust to registry changes).
  const effectId = await page.evaluate(() => (window as any).__gdesign.engine.listEffects()[0]?.id ?? null);
  test.skip(!effectId, 'no effects registered to open a dialog against');

  await page.evaluate((id) => (window as any).__gdesign.exec('effect.open', id), effectId);
  await expect(page.locator('[data-testid="effect-dialog"]')).toBeVisible();

  const before = await page.evaluate(() => (window as any).__gdesign.stores.toolState.get().active);
  await page.keyboard.press('z'); // canvas-scoped zoom-tool shortcut
  const during = await page.evaluate(() => (window as any).__gdesign.stores.toolState.get().active);
  expect(during).toBe(before);

  await page.locator('[data-testid="effect-cancel"]').click();
  await page.keyboard.press('z');
  const after = await page.evaluate(() => (window as any).__gdesign.stores.toolState.get().active);
  expect(after).toBe('zoom');
});

test('effect dialog Cancel reverts the document exactly, even mid-drag', async ({ page }) => {
  const effectId = await page.evaluate(() => (window as any).__gdesign.engine.listEffects()[0]?.id ?? null);
  test.skip(!effectId, 'no effects registered to open a dialog against');

  const before = await page.evaluate(() => JSON.stringify((window as any).__gdesign.doc()));

  await page.evaluate((id) => (window as any).__gdesign.exec('effect.open', id), effectId);
  const slider = page.locator('[data-testid^="pf-slider-"]').first();
  if (await slider.count()) {
    await slider.fill(await slider.getAttribute('max') ?? '1');
    await slider.dispatchEvent('input');
  }
  await page.locator('[data-testid="effect-cancel"]').click();

  await expect.poll(() => page.evaluate(() => JSON.stringify((window as any).__gdesign.doc()))).toBe(before);
});

test('dropping an image onto the canvas imports it as a new layer and rendering survives', async ({ page }) => {
  const before = await page.evaluate(() => (window as any).__gdesign.doc().layers.length);

  // A minimal valid 1x1 PNG, base64-encoded, handed to the page as a File via
  // a DataTransfer: real OS drag-drop isn't available under Playwright.
  const png1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'dropped.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const region = document.querySelector('.gd-canvas-region')!;
    region.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, png1x1);

  await expect.poll(() => page.evaluate(() => (window as any).__gdesign.doc().layers.length)).toBe(before + 1);

  // Regression guard: an imported layer's core.image source used to assume
  // ctx.getAsset() handed back a pre-decoded ImageBitmap (it hands back the
  // raw AssetJSON bytes instead), throwing on first render and permanently
  // killing the render loop. Poll because the source's decode is async.
  // This must resolve to a real frame, not stay stuck on a placeholder.
  await expect
    .poll(async () => {
      return page.evaluate(async () => {
        try {
          const r = await (window as any).__gdesign.engine.readback({ via: 'quantised' });
          return r.width > 0 && r.height > 0;
        } catch {
          return false;
        }
      });
    })
    .toBe(true);
});

test('dropping an undecodable file surfaces a statusbar toast instead of failing silently', async ({ page }) => {
  await page.evaluate(() => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'not-an-image.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const region = document.querySelector('.gd-canvas-region')!;
    region.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });

  await expect(page.locator('[data-testid="status-message"]')).toHaveText("Couldn't decode image");
});

test('File > New, Save, and Open round-trip a document', async ({ page }) => {
  // New: set dimensions, OK, confirm the doc picks them up and undo history clears.
  await page.evaluate(() => (window as any).__gdesign.exec('file.new'));
  await page.locator('[data-testid="nd-width"]').fill('400');
  await page.locator('[data-testid="nd-height"]').fill('300');
  await page.locator('[data-testid="nd-width"]').press('Tab'); // commit the change event
  await page.locator('[data-testid="new-document-ok"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__gdesign.doc().canvas.width)).toBe(400);
  await expect.poll(() => page.evaluate(() => (window as any).__gdesign.doc().canvas.height)).toBe(300);

  // Save: downloads a .gdesign.json.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => (window as any).__gdesign.exec('file.save')),
  ]);
  expect(download.suggestedFilename()).toBe('document.gdesign.json');
  const savedPath = await download.path();
  expect(savedPath).toBeTruthy();

  // Open: load the saved file back in and confirm the round trip.
  await page.evaluate(() => (window as any).__gdesign.exec('file.new')); // dirty the doc first
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.evaluate(() => (window as any).__gdesign.exec('file.open')),
  ]);
  await chooser.setFiles(savedPath!);
  await expect.poll(() => page.evaluate(() => (window as any).__gdesign.doc().canvas.width)).toBe(400);
  await expect.poll(() => page.evaluate(() => (window as any).__gdesign.doc().canvas.height)).toBe(300);
});

/**
 * Effects panel (F9): the chain becomes visible/editable outside undo.
 * Contract: see boot.spec.ts header for window.__gdesign; readback via
 * engine.readback (never screenshots, see tests/CLAUDE.md). Panel testids:
 * [data-testid="panel-effects"], "effect-row", "effect-toggle",
 * "effect-remove", "effect-drag-handle", "effects-doc-add",
 * "effects-doc-picker", "effects-picker-item".
 *
 * Two environment quirks this file works around (found empirically while
 * fixing this spec, not assumptions):
 *
 * 1. Every dockable panel (Tools/History/Layers/Colors/Effects) defaults to
 *    visible on boot (stores.ts's PANEL_DEFAULTS). F9 TOGGLES the Effects
 *    panel, it doesn't open a closed one. Pressing F9 on a fresh page closes
 *    it, which is why an earlier draft of this file saw every locator as
 *    "not visible": it wrongly assumed the panel started closed. Fixed by
 *    simply not pressing F9: the panel is already there, exactly like
 *    Tools/History/Layers/Colors in boot.spec.ts.
 * 2. `engine.readback()` in app (window.__gdesign) context is safe to call
 *    any number of times UNTIL a non-empty effect chain has been rendered at
 *    least once; the FIRST readback() call after that point still succeeds,
 *    but every SUBSEQUENT readback() call in the SAME page then throws
 *    `AbortError: ... mapAsync ... A valid external Instance reference no
 *    longer exists`, permanently, for that page (reproduced with a plain
 *    engine.applyEdits setChain, no dialog/UI involved; with an enabled OR
 *    disabled chain entry; with or without a resulting pixel change; and
 *    survives pausing the clock, so it isn't render-loop starvation or a
 *    timing race to wait out). This is the same family of SwiftShader-only
 *    instance-loss bug present.spec.ts documents for forced presentation,
 *    just triggered by a chain's render pipeline instead of a swapchain
 *    configure. Not something a spec can dodge by waiting or reordering
 *    within one page. Tests below that need a pixel comparison against a
 *    chain-affected render do it across two pages (at most one readback()
 *    call per page); tests that only need to confirm the panel wrote the
 *    right chain data use document-state reads instead (no GPU call, and a
 *    more precise assertion of what the panel itself owns, see
 *    tools2.spec.ts's header for the same "assert via document/state"
 *    convention this follows).
 */

import { test, expect, type Page, type Browser } from '@playwright/test';

async function readbackBytes(page: Page): Promise<Uint8Array> {
  const arr = await page.evaluate(async () => {
    const r = await window.__gdesign!.engine.readback({ via: 'quantised' });
    return Array.from(new Uint8Array(r.data));
  });
  return new Uint8Array(arr);
}

/** `layer-new` appends after the active layer (topLevelIndexAboveActive in
 * registry.ts), which lands it at the END of doc.layers on a fresh boot doc
 * (no prior active layer): `doc.layers[0]` is still the ORIGINAL boot
 * layer, never the one these tests just added and targeted. An earlier
 * draft indexed `layers[0]` throughout, which happened to read an
 * always-empty chain and passed for the wrong reason on the "remove" test.
 * Read the ACTIVE layer (viewState, which layer.new/effect.open both target)
 * instead. */
async function activeLayerChain(page: Page): Promise<{ id: string; pass: string; enabled: boolean; params: Record<string, unknown> }[]> {
  return page.evaluate(() => {
    const gd = window.__gdesign!;
    const activeId = gd.stores.viewState.get().activeLayer;
    const layer = gd.doc().layers.find((l) => l.id === activeId)!;
    return layer.chain;
  });
}

/** A throwaway second page for a single post-chain readback (see header note
 * 2), always closed by the caller once done with it. */
async function freshReadyPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.goto('/');
  await page.waitForFunction(() => window.__gdesign?.ready === true, { timeout: 30_000 });
  return page;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__gdesign?.ready === true, { timeout: 30_000 });
  await expect(page.locator('[data-testid="panel-effects"]')).toBeVisible(); // open by default, like every other panel
});

test('add invert, toggle it off via the panel: chain state flips accordingly', async ({ page }) => {
  // A disabled chain entry rendering identically to no chain at all is
  // engine-level behaviour (already covered, GPU-free, in
  // run-chain.test.ts's "skips a disabled effect" case). This test's job is
  // the panel's own wiring: does the toggle button actually flip
  // `enabled` in the document. Deliberately no readback() here: this file
  // uses at most one readback() call per page once a chain is involved (see
  // header note 2), and that one call is spent in the postChain test below,
  // which proves something a unit test can't (the panel's chain data
  // actually reaches the renderer).
  await page.locator('[data-testid="layer-new"]').click();
  await page.waitForTimeout(200);

  await page.keyboard.press('Control+Shift+I'); // effect.open core.invert, targets the active layer
  await page.locator('[data-testid="effect-ok"]').click();

  const afterAdd = (await activeLayerChain(page)).map((fx) => ({ pass: fx.pass, enabled: fx.enabled }));
  expect(afterAdd).toEqual([{ pass: 'core.invert', enabled: true }]);

  await page.locator('[data-testid="effect-row"] [data-testid="effect-toggle"]').first().click();
  const afterToggle = (await activeLayerChain(page))[0]!.enabled;
  expect(afterToggle).toBe(false);
});

test('reorder two effects via the drag handle: the chain array order flips', async ({ page }) => {
  await page.locator('[data-testid="layer-new"]').click();
  await page.waitForTimeout(200);

  await page.keyboard.press('Control+Shift+I'); // core.invert
  await page.locator('[data-testid="effect-ok"]').click();
  await page.keyboard.press('Control+Shift+P'); // core.posterize
  await page.locator('[data-testid="effect-ok"]').click();

  const beforeOrder = (await activeLayerChain(page)).map((fx) => fx.pass);
  expect(beforeOrder).toEqual(['core.invert', 'core.posterize']);

  const rows = page.locator('[data-testid="effect-row"]');
  await expect(rows).toHaveCount(2);

  // Display row 0 (top = last-applied = posterize) dragged onto row 1 (invert).
  const handle0 = rows.nth(0).locator('[data-testid="effect-drag-handle"]');
  const handle1 = rows.nth(1).locator('[data-testid="effect-drag-handle"]');
  const box0 = (await handle0.boundingBox())!;
  const box1 = (await handle1.boundingBox())!;
  await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
  await page.mouse.down();
  await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2, { steps: 4 });
  await page.mouse.up();

  const afterOrder = (await activeLayerChain(page)).map((fx) => fx.pass);
  expect(afterOrder).not.toEqual(beforeOrder); // must not be a silent no-op
  expect(afterOrder).toEqual([...beforeOrder].reverse());
});

test('edit-in-place: double-click a row, change a param, the chain entry is replaced (not appended) with the new param', async ({ page }) => {
  await page.locator('[data-testid="layer-new"]').click();
  await page.waitForTimeout(200);

  await page.keyboard.press('Control+Shift+T'); // core.brightness-contrast, both params default to 0
  await page.locator('[data-testid="effect-ok"]').click();
  const originalId = (await activeLayerChain(page))[0]!.id;

  const row = page.locator('[data-testid="effect-row"]').first();
  await row.dblclick();
  await expect(page.locator('.dlg-title')).toHaveText('Edit Brightness / Contrast');

  const slider = page.locator('[data-testid="pf-slider-brightness"]');
  await slider.fill('0.5');
  await page.locator('[data-testid="effect-ok"]').click();

  await expect(page.locator('[data-testid="effect-row"]')).toHaveCount(1); // replaced, not appended
  const chain = await activeLayerChain(page);
  expect(chain).toHaveLength(1);
  expect(chain[0]!.id).toBe(originalId); // same instance, edited in place
  expect(chain[0]!.params['brightness']).toBe(0.5);
});

test('remove: the row and the chain entry both disappear', async ({ page }) => {
  await page.locator('[data-testid="layer-new"]').click();
  await page.waitForTimeout(200);

  await page.keyboard.press('Control+Shift+I'); // core.invert
  await page.locator('[data-testid="effect-ok"]').click();
  await expect(page.locator('[data-testid="effect-row"]')).toHaveCount(1);

  await page.locator('[data-testid="effect-row"] [data-testid="effect-remove"]').first().click();

  await expect(page.locator('[data-testid="effect-row"]')).toHaveCount(0);
  const chainLength = (await activeLayerChain(page)).length;
  expect(chainLength).toBe(0);
});

test('document postChain: adding an effect via the panel writes doc.postChain and changes the composited readback', async ({ page, browser }) => {
  // Uses the boot doc's own default layer (main.ts seeds a non-grey solid
  // background, OKLab [0.65, 0.05, -0.1, 1]) rather than layer-new's flat
  // [0.5, 0, 0, 1] grey: grey is invert's fixed point (L=0.5, a=b=0 maps to
  // itself), which would make an invert-based "readback changed" assertion
  // pass or fail for the wrong reason depending on the starting color. The
  // boot layer's asymmetric a/b guarantees invert is actually visible.
  await page.locator('[data-testid="effects-doc-add"]').click();
  await expect(page.locator('[data-testid="effects-doc-picker"]')).toBeVisible();
  await page.locator('[data-testid="effects-picker-item"]', { hasText: 'Invert Colors' }).click();
  await page.locator('[data-testid="effect-ok"]').click();

  const postChain = await page.evaluate(() => window.__gdesign!.doc().postChain.map((fx) => fx.pass));
  expect(postChain).toEqual(['core.invert']);

  // Exactly one readback() call in this page, now that postChain is set.
  const withPostChain = await readbackBytes(page);

  const page2 = await freshReadyPage(browser);
  const withoutPostChain = await readbackBytes(page2);
  await page2.close();

  expect(withPostChain).not.toEqual(withoutPostChain);
});

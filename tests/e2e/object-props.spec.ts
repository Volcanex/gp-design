/**
 * Object properties (Effects panel's Object section, panels/effects.ts):
 * transform fields (x/y/width/height/rotation) + per-content-type fields
 * (shape -> fill, text -> text/size/fill, image -> transform only + an
 * asset-name label) for a single selected scene object. Contract: see
 * boot.spec.ts header for window.__gdesign; readback via engine.readback
 * (never screenshots, see tests/CLAUDE.md). Panel testids: [data-testid=
 * "effects-object-section"], "object-x"/"object-y"/"object-width"/
 * "object-height"/"object-rotation", "object-fill", "object-text",
 * "object-text-size", "object-image-asset". Color popover testids (shared
 * with paramsForm's colorRow, forms/params-form.ts): "color-popover",
 * "pf-color-hex".
 *
 * Follows tools2.spec.ts's canvasBoxAndZoom/pollReadbackAlpha conventions
 * (panel-free x-strip, float readback, manual poll loop not expect.poll;
 * see that file's header for why expect.poll hangs on readback waits here).
 *
 * Not run as part of this task. Written for the next e2e pass (tsc/vitest
 * were this worktree's gates; Playwright needs the built dist, see
 * tests/CLAUDE.md).
 */

import { test, expect } from '@playwright/test';

async function canvasBoxAndZoom(page: import('@playwright/test').Page) {
  const canvas = page.locator('#gd-canvas');
  const box = (await canvas.boundingBox())!;
  const { zoom } = await page.evaluate(() => window.__gdesign!.stores.viewState.get());
  return { canvas, box, zoom };
}

async function floatReadback(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const r = await window.__gdesign!.engine.readback({ via: 'float' });
    return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
  });
}

function pixelAt(float: { width: number; data: number[] }, x: number, y: number): number[] {
  const idx = (y * float.width + x) * 4;
  return float.data.slice(idx, idx + 4);
}

async function insertRectAndSelect(page: import('@playwright/test').Page) {
  await page.evaluate(() => window.__gdesign!.exec('scene.newLayer'));
  await page.keyboard.press('o'); // -> line
  await page.keyboard.press('o'); // -> shapes
  const { box, zoom } = await canvasBoxAndZoom(page);
  await page.mouse.move(box.x + 400 * zoom, box.y + 100 * zoom);
  await page.mouse.down();
  await page.mouse.move(box.x + 600 * zoom, box.y + 250 * zoom, { steps: 4 });
  await page.mouse.up();
  const id = await page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects[0]!);
  await page.keyboard.press('m'); // move tool, so the shapes tool doesn't eat the next drag/click
  return id;
}

test.describe('Object properties panel', () => {
  test('insert rect -> select -> change fill via panel -> readback changes; change width -> bounds change; undo steps back cleanly', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true, { timeout: 30_000 });
    // Pause the auto-playing clock: its continuous render loop compounds
    // across sequential contexts under SwiftShader until readbacks hang
    // outright (see groups.spec.ts's beforeEach for the full story).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

    await insertRectAndSelect(page);

    // The Effects panel is OPEN by default and F9 is panel.toggle: a blind
    // press closes it (the regression this guard fixes). Only toggle when
    // the panel is actually hidden.
    const section = page.locator('[data-testid="effects-object-section"]');
    if (!(await section.isVisible())) await page.keyboard.press('F9');
    await expect(section).toBeVisible();

    // Rect spans doc (500,175) +/- 100/75 (400,100)-(600,250) around its anchor,
    // so (500,175) is well inside it both before and after a fill/width change.
    const before = await floatReadback(page);
    const insideBefore = pixelAt(before, 500, 175);

    await page.locator('[data-testid="object-fill"]').click();
    const hex = page.locator('[data-testid="pf-color-hex"]');
    await expect(hex).toBeVisible();
    await hex.fill('#00ff00');
    await hex.press('Tab'); // blur -> 'change' fires content.fill's setParam commit
    await page.waitForTimeout(200);

    const afterFill = await floatReadback(page);
    const insideAfterFill = pixelAt(afterFill, 500, 175);
    expect(insideAfterFill).not.toEqual(insideBefore);

    // Widen the rect from 200 to 400 doc-px: (610,175), just outside the
    // original right edge (600), should now be inside the shape.
    const outsideOriginalRightEdge = pixelAt(before, 610, 175);
    const widthInput = page.locator('[data-testid="object-width"]');
    await widthInput.fill('400');
    await widthInput.press('Tab');
    await page.waitForTimeout(200);

    const afterWidth = await floatReadback(page);
    const nowInsideRight = pixelAt(afterWidth, 610, 175);
    expect(nowInsideRight).not.toEqual(outsideOriginalRightEdge);
    expect(nowInsideRight[3]).toBeGreaterThan(0.5);

    // Undo Resize, then undo Change Fill: both revert cleanly to baseline.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    const afterUndoResize = await floatReadback(page);
    expect(pixelAt(afterUndoResize, 610, 175)).toEqual(outsideOriginalRightEdge);

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    const afterUndoFill = await floatReadback(page);
    expect(pixelAt(afterUndoFill, 500, 175)).toEqual(insideBefore);
  });

  test('text object: edit size via panel -> glyph extent changes (readback)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true, { timeout: 30_000 });
    // Pause the auto-playing clock: its continuous render loop compounds
    // across sequential contexts under SwiftShader until readbacks hang
    // outright (see groups.spec.ts's beforeEach for the full story).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

    await page.evaluate(() => window.__gdesign!.exec('scene.newLayer'));
    await page.keyboard.press('t'); // text tool
    const { box, zoom } = await canvasBoxAndZoom(page);
    await page.mouse.click(box.x + 300 * zoom, box.y + 200 * zoom);

    const editor = page.locator('[data-testid="text-editor"]');
    await expect(editor).toBeVisible();
    await editor.fill('HI');
    await editor.press('Enter');
    await expect(editor).toBeHidden();

    await page.keyboard.press('m'); // move tool
    await page.mouse.click(box.x + 300 * zoom, box.y + 200 * zoom); // single click: select, don't reopen the floating editor
    // Effects panel is open by default; F9 toggles, so only press when hidden.
    const section = page.locator('[data-testid="effects-object-section"]');
    if (!(await section.isVisible())) await page.keyboard.press('F9');
    await expect(section).toBeVisible();

    // A point just right of the glyph's rendered extent at the default size
    // (approxTextBox's ~0.55em-per-char estimate) reads background; after a
    // large size bump it should read glyph ink instead.
    // Centre-anchored at x=300: at size 120 this lands on the 'I' stem of the
    // JetBrains Mono atlas (pen x ~36..40, scale 120/42), well right of the
    // whole string's ink at the default size 48.
    const probeX = 300 + 42;
    const before = await floatReadback(page);
    const beforeProbe = pixelAt(before, probeX, 200 + 8);

    const sizeInput = page.locator('[data-testid="object-text-size"]');
    await sizeInput.fill('120');
    await sizeInput.press('Tab');
    await page.waitForTimeout(200);

    const after = await floatReadback(page);
    const afterProbe = pixelAt(after, probeX, 200 + 8);
    expect(afterProbe).not.toEqual(beforeProbe);
    expect(afterProbe[3]).toBeGreaterThan(0.3);
  });

  test('double-click a shape object (move tool) opens/focuses the Effects panel', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true, { timeout: 30_000 });
    // Pause the auto-playing clock: its continuous render loop compounds
    // across sequential contexts under SwiftShader until readbacks hang
    // outright (see groups.spec.ts's beforeEach for the full story).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

    const id = await insertRectAndSelect(page);
    await page.keyboard.press('F9'); // close it: F9 is panel.toggle
    await expect(page.locator('[data-testid="panel-effects"]')).toBeHidden();

    const { box, zoom } = await canvasBoxAndZoom(page);
    await page.mouse.dblclick(box.x + 500 * zoom, box.y + 175 * zoom);

    await expect(page.locator('[data-testid="panel-effects"]')).toBeVisible();
    await expect(page.locator('[data-testid="effects-object-section"]')).toBeVisible();
    expect(await page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects)).toEqual([id]);
    // A shape double-click must NOT open the floating text editor.
    await expect(page.locator('[data-testid="text-editor"]')).toBeHidden();
  });
});

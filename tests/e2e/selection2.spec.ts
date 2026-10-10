import { test, expect } from '@playwright/test';

/**
 * Wave-5 selection semantics: click-select activates the hit object's
 * layer, Delete removes the selected object (undo restores it), Ctrl+A
 * selects everything, arrow keys nudge, Escape deselects. Follows
 * tools2.spec.ts's conventions (window.__gdesign exec()/doc()/stores,
 * canvas.boundingBox()+zoom for client<->doc px, x in [212,1048] to stay
 * clear of the docked panels regardless of window size; see that file's
 * header for why). Written but NOT run as part of this pass (no
 * playwright/build gate here). A follow-up pass should run it against a
 * real browser before relying on it.
 */
async function canvasBoxAndZoom(page: import('@playwright/test').Page) {
  const canvas = page.locator('#gd-canvas');
  const box = (await canvas.boundingBox())!;
  const { zoom } = await page.evaluate(() => window.__gdesign!.stores.viewState.get());
  return { canvas, box, zoom };
}

test.describe('wave-5 selection semantics', () => {
  test('click selects the topmost object under the cursor and activates its layer; Delete removes it (undo restores); Ctrl+A selects all; arrows nudge; Escape deselects', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true);

    // Two shapes on two different scene layers, so click-select and Ctrl+A
    // both have to search across layers, not just the active one.
    const ids = await page.evaluate(() => {
      window.__gdesign!.exec('scene.newLayer');
      window.__gdesign!.exec('object.insertRect'); // centred at (640, 360), 200x120
      window.__gdesign!.exec('scene.newLayer');
      window.__gdesign!.exec('object.insertEllipse'); // centred at (640, 360) too, on TOP (last layer wins)
      const doc = window.__gdesign!.doc();
      const sceneLayers = doc.layers.filter((l) => l.kind === 'layer' && l.source.type === 'core.scene');
      return sceneLayers.map((l) => ({
        layerId: l.id,
        objId: (l as { source: { params: { scene?: unknown } } }).source.params.scene as { id: string }[],
      })).map((e) => ({ layerId: e.layerId, objId: e.objId[0]!.id }));
    });
    const [firstLayer, topLayer] = ids;

    await page.keyboard.press('m'); // move tool
    const { box, zoom } = await canvasBoxAndZoom(page);

    // Click the shared centre point: the TOPMOST object (the ellipse, on
    // the layer created last) must win, and its layer becomes active.
    await page.mouse.click(box.x + 640 * zoom, box.y + 360 * zoom);
    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects))
      .toEqual([topLayer!.objId]);
    expect(await page.evaluate(() => window.__gdesign!.stores.viewState.get().activeLayer)).toBe(topLayer!.layerId);

    // Delete removes the selected object; undo restores it.
    await page.keyboard.press('Delete');
    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects)).toEqual([]);
    const existsAfterDelete = await page.evaluate((id) => {
      const doc = window.__gdesign!.doc();
      return doc.layers.some((l) =>
        l.kind === 'layer' && l.source.type === 'core.scene' &&
        ((l.source.params as { scene?: { id: string }[] }).scene ?? []).some((o) => o.id === id));
    }, topLayer!.objId);
    expect(existsAfterDelete).toBe(false);

    await page.keyboard.press('Control+z');
    const existsAfterUndo = await page.evaluate((id) => {
      const doc = window.__gdesign!.doc();
      return doc.layers.some((l) =>
        l.kind === 'layer' && l.source.type === 'core.scene' &&
        ((l.source.params as { scene?: { id: string }[] }).scene ?? []).some((o) => o.id === id));
    }, topLayer!.objId);
    expect(existsAfterUndo).toBe(true);

    // Ctrl+A selects every object across every scene layer.
    await page.keyboard.press('Control+a');
    await expect.poll(() =>
      page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects.slice().sort()),
    ).toEqual([firstLayer!.objId, topLayer!.objId].sort());

    // Arrow keys nudge every selected object; Shift+arrow nudges 10px.
    await page.evaluate((id) => {
      window.__gdesign!.stores.selectionState.set({ objects: [id], marquee: null });
    }, topLayer!.objId);
    const before = await page.evaluate((id) => {
      const doc = window.__gdesign!.doc();
      const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene' &&
        ((l.source.params as { scene?: { id: string }[] }).scene ?? []).some((o) => o.id === id))!;
      return (layer as unknown as { source: { params: { scene: { id: string; transform: { x: number; y: number } }[] } } })
        .source.params.scene.find((o) => o.id === id)!.transform;
    }, topLayer!.objId);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    const after = await page.evaluate((id) => {
      const doc = window.__gdesign!.doc();
      const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene' &&
        ((l.source.params as { scene?: { id: string }[] }).scene ?? []).some((o) => o.id === id))!;
      return (layer as unknown as { source: { params: { scene: { id: string; transform: { x: number; y: number } }[] } } })
        .source.params.scene.find((o) => o.id === id)!.transform;
    }, topLayer!.objId);
    expect(after.x).toBeCloseTo(before.x + 1, 0);
    expect(after.y).toBeCloseTo(before.y + 10, 0);

    // Escape deselects.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects)).toEqual([]);
  });
});

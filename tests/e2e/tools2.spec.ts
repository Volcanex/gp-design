import { test, expect } from '@playwright/test';

/**
 * Wave-2 tools: marquee select/deselect, gradient, line, shapes, text, and
 * the disabled-tool guard. Follows scene.spec.ts's move-tool-flow pattern:
 * window.__gdesign exec()/stores for state, canvas.boundingBox()+zoom for
 * client<->doc px, page.mouse for drags, expect.poll for anything behind an
 * async engine call. Assert via document/state readback, never screenshots.
 *
 * Drag/click x-coordinates stay inside [212, 1048] (doc px, any y): the
 * only strip guaranteed clear of every docked panel regardless of window
 * size (panels only occupy the far-left/far-right columns; see
 * src/app/stores.ts's PANEL_DEFAULTS). An earlier draft used x<300 for some
 * drags, which landed under the Tools panel and silently ate the pointer
 * events (never reached the canvas at all).
 *
 * `pollReadbackAlpha` below, not `expect.poll`, drives every
 * engine.readback()-based wait: `expect.poll(() => page.evaluate(async () =>
 * { await engine.readback(...); ... }))`, in ANY wrapping shape, reliably
 * hung forever on this Playwright/Chromium/SwiftShader combination the
 * moment readback followed a just-finished stroke, reproduced with both an
 * async-wrapped and plain-arrow poll callback, and with a poll target as
 * simple as `r.width`, yet a manual loop of the exact same
 * `page.evaluate(readback)` call, awaited directly with a small
 * `waitForTimeout` between attempts, resolves on the very first try. Root
 * cause not chased further (may be an expect.poll/Playwright interaction
 * bug, not a product bug). Flagged here so nobody reintroduces
 * expect.poll for a readback wait and burns time on the same hang.
 */
async function canvasBoxAndZoom(page: import('@playwright/test').Page) {
  const canvas = page.locator('#gd-canvas');
  const box = (await canvas.boundingBox())!;
  const { zoom } = await page.evaluate(() => window.__gdesign!.stores.viewState.get());
  return { canvas, box, zoom };
}

async function pollReadbackAlpha(
  page: import('@playwright/test').Page,
  x: number,
  y: number,
  attempts = 15,
  intervalMs = 200,
): Promise<number> {
  let alpha = 0;
  for (let i = 0; i < attempts; i += 1) {
    alpha = await page.evaluate(async ({ x, y }) => {
      const r = await window.__gdesign!.engine.readback({ via: 'float' });
      const data = new Float32Array(r.data);
      const idx = (y * r.width + x) * 4;
      return data[idx + 3] ?? 0;
    }, { x, y });
    if (alpha > 0.5) return alpha;
    await page.waitForTimeout(intervalMs);
  }
  return alpha;
}

test.describe('wave-2 tools', () => {
  test('marquee select (select-rect): drag selects overlapping objects, plain click deselects', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true);
    // Pause the auto-playing clock: its continuous render loop compounds
    // across sequential contexts under SwiftShader until readbacks hang
    // outright (see groups.spec.ts's beforeEach for the full story).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

    const objectId = await page.evaluate(() => {
      window.__gdesign!.exec('scene.newLayer');
      window.__gdesign!.exec('object.insertRect'); // centred at (640, 360), 200x120
      const doc = window.__gdesign!.doc();
      const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene')!;
      const objects = (layer as { source: { params: { scene?: unknown } } }).source.params.scene as { id: string }[];
      return objects[0]!.id;
    });

    await page.keyboard.press('s'); // tool.cycle -> select-rect
    const { canvas, box, zoom } = await canvasBoxAndZoom(page);

    // Marquee well around the 200x120 rect at (640,360).
    await page.mouse.move(box.x + 500 * zoom, box.y + 250 * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + 800 * zoom, box.y + 450 * zoom, { steps: 4 });
    await expect(page.locator('[data-testid="selection-overlay"] .gd-marquee-box')).toBeVisible();
    await page.mouse.up();

    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects))
      .toEqual([objectId]);
    // The rect is KEPT (not nulled) after a successful marquee resolve
    // (edit.fillSelection reads it), unlike a deselect, which clears both.
    expect(await page.evaluate(() => window.__gdesign!.stores.selectionState.get().marquee)).not.toBeNull();

    // Plain click (no drag), away from any object AND from any docked
    // panel (panels occupy the x<212 and x>1048 strips at any y; x=640 is
    // clear regardless of y, see src/app/stores.ts's PANEL_DEFAULTS):
    // deselects and clears the rect.
    await canvas.click({ position: { x: 640 * zoom, y: 50 * zoom } });
    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects)).toEqual([]);
    expect(await page.evaluate(() => window.__gdesign!.stores.selectionState.get().marquee)).toBeNull();

    // Re-select, then Escape deselects.
    await page.mouse.move(box.x + 500 * zoom, box.y + 250 * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + 800 * zoom, box.y + 450 * zoom, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects))
      .toEqual([objectId]);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects)).toEqual([]);

    // Re-select again, then bare Delete DELETES the selected object (see
    // tests/e2e/selection2.spec.ts for the fuller delete/undo coverage).
    // This used to only deselect; that convention was inverted in Wave 5 to
    // match every other editor's Delete key.
    await page.mouse.move(box.x + 500 * zoom, box.y + 250 * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + 800 * zoom, box.y + 450 * zoom, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects))
      .toEqual([objectId]);
    await page.keyboard.press('Delete');
    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects)).toEqual([]);
    const stillExists = await page.evaluate((id) => {
      const doc = window.__gdesign!.doc();
      const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene')!;
      // removeObject collapses params.scene to ABSENT when the last object
      // goes (deliberate: keeps its undo a true no-op). Absent means the
      // object is definitely gone, not an error.
      const objects = (layer as { source: { params: { scene?: unknown } } }).source.params.scene as { id: string }[] | undefined;
      return (objects ?? []).some((o) => o.id === id);
    }, objectId);
    expect(stillExists).toBe(false); // Delete now deletes the selected object.
  });

  test('Edit > Fill Selection stamps the raster layer inside the marquee rect', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true);
    // Pause the auto-playing clock: its continuous render loop compounds
    // across sequential contexts under SwiftShader until readbacks hang
    // outright (see groups.spec.ts's beforeEach for the full story).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

    await page.keyboard.press('s'); // select-rect
    const { box, zoom } = await canvasBoxAndZoom(page);
    // Well inside the panel-free x-strip (212-1048).
    await page.mouse.move(box.x + 400 * zoom, box.y + 400 * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + 500 * zoom, box.y + 500 * zoom, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().marquee)).not.toBeNull();

    await page.evaluate(() => window.__gdesign!.exec('edit.fillSelection'));

    // See the file header: expect.poll hangs on a readback-based check here.
    const alpha = await pollReadbackAlpha(page, 450, 450); // centre of the filled rect
    expect(alpha).toBeGreaterThan(0.5);
  });

  test('gradient tool: drag creates one core.gradient layer with fromPt/toPt/colors mapped from the drag', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true);
    // Pause the auto-playing clock: its continuous render loop compounds
    // across sequential contexts under SwiftShader until readbacks hang
    // outright (see groups.spec.ts's beforeEach for the full story).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

    await page.keyboard.press('g'); // tool.cycle -> gradient
    const { box, zoom } = await canvasBoxAndZoom(page);
    const { width, height } = await page.evaluate(() => window.__gdesign!.doc().canvas);

    await page.mouse.move(box.x + 0.2 * width * zoom, box.y + 0.5 * height * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + 0.8 * width * zoom, box.y + 0.5 * height * zoom, { steps: 4 });
    await page.mouse.up();

    const gradientLayer = await page.evaluate(() => {
      const doc = window.__gdesign!.doc();
      return doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.gradient') as
        | { source: { params: Record<string, unknown> } }
        | undefined;
    });
    expect(gradientLayer).toBeDefined();
    const from = gradientLayer!.source.params.fromPt as [number, number];
    const to = gradientLayer!.source.params.toPt as [number, number];
    expect(from[0]).toBeCloseTo(0.2, 1);
    expect(to[0]).toBeCloseTo(0.8, 1);
    expect(gradientLayer!.source.params.gradType).toBe('linear');
  });

  test('line tool: one drag commits a single straight stroke as one undo step', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true);
    // Pause the auto-playing clock: its continuous render loop compounds
    // across sequential contexts under SwiftShader until readbacks hang
    // outright (see groups.spec.ts's beforeEach for the full story).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

    await page.keyboard.press('o'); // tool.cycle -> line
    const { box, zoom } = await canvasBoxAndZoom(page);

    // x in [212,1048] clears every docked panel regardless of y (panels
    // only occupy the far-left/far-right strips, see src/app/stores.ts's
    // PANEL_DEFAULTS); the earlier x=100-300 drag landed under the Tools
    // panel and its pointer events never reached the canvas.
    await page.mouse.move(box.x + 400 * zoom, box.y + 100 * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + 600 * zoom, box.y + 100 * zoom, { steps: 4 });
    await page.mouse.up();

    // endStroke/history.push are async off the engine call. Poll (see the
    // file header on why this isn't expect.poll).
    const alpha = await pollReadbackAlpha(page, 500, 100); // midpoint of the drawn segment
    expect(alpha).toBeGreaterThan(0.5);
  });

  test('shapes tool: drag inserts a sized rect object as one undo step and selects it', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true);
    // Pause the auto-playing clock: its continuous render loop compounds
    // across sequential contexts under SwiftShader until readbacks hang
    // outright (see groups.spec.ts's beforeEach for the full story).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

    await page.evaluate(() => window.__gdesign!.exec('scene.newLayer'));
    await page.keyboard.press('o'); // -> line
    await page.keyboard.press('o'); // -> shapes
    const { box, zoom } = await canvasBoxAndZoom(page);

    // Same panel-free x-strip as the line tool test above.
    await page.mouse.move(box.x + 400 * zoom, box.y + 100 * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + 600 * zoom, box.y + 250 * zoom, { steps: 4 });
    await page.mouse.up();

    const inserted = await page.evaluate(() => {
      const doc = window.__gdesign!.doc();
      const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene')!;
      const objects = (layer as { source: { params: { scene?: unknown } } }).source.params.scene as
        { id: string; content: { type: string; shape: { width: number; height: number } }; transform: { x: number; y: number } }[];
      return objects[0]!;
    });
    expect(inserted.content.type).toBe('shape');
    expect(inserted.content.shape.width).toBeCloseTo(200, 0);
    expect(inserted.content.shape.height).toBeCloseTo(150, 0);
    expect(inserted.transform.x).toBeCloseTo(500, 0);
    expect(inserted.transform.y).toBeCloseTo(175, 0);

    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects))
      .toEqual([inserted.id]);
  });

  test('text tool: click inserts a text object and opens the editor; typing + Enter commits, Escape cancels', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true);
    // Pause the auto-playing clock: its continuous render loop compounds
    // across sequential contexts under SwiftShader until readbacks hang
    // outright (see groups.spec.ts's beforeEach for the full story).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

    await page.evaluate(() => window.__gdesign!.exec('scene.newLayer'));
    await page.keyboard.press('t');
    const { box, zoom } = await canvasBoxAndZoom(page);
    await page.mouse.click(box.x + 300 * zoom, box.y + 200 * zoom);

    const editor = page.locator('[data-testid="text-editor"]');
    await expect(editor).toBeVisible();
    await editor.fill('Hello gdesign');
    await editor.press('Enter');
    await expect(editor).toBeHidden();

    const committed = await page.evaluate(() => {
      const doc = window.__gdesign!.doc();
      const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene')!;
      const objects = (layer as { source: { params: { scene?: unknown } } }).source.params.scene as
        { content: { text: { text: string } } }[];
      return objects[0]!.content.text.text;
    });
    expect(committed).toBe('Hello gdesign');

    // Move tool double-click reopens the editor on the same object; Escape cancels.
    await page.keyboard.press('m');
    await page.mouse.dblclick(box.x + 300 * zoom, box.y + 200 * zoom);
    await expect(editor).toBeVisible();
    await editor.fill('Should not stick');
    await editor.press('Escape');
    await expect(editor).toBeHidden();

    const stillCommitted = await page.evaluate(() => {
      const doc = window.__gdesign!.doc();
      const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene')!;
      const objects = (layer as { source: { params: { scene?: unknown } } }).source.params.scene as
        { content: { text: { text: string } } }[];
      return objects[0]!.content.text.text;
    });
    expect(stillCommitted).toBe('Hello gdesign');
  });

  test('disabled tools (select-lasso/select-wand/clone/recolor) never activate; bucket is now real', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true);
    // Pause the auto-playing clock: its continuous render loop compounds
    // across sequential contexts under SwiftShader until readbacks hang
    // outright (see groups.spec.ts's beforeEach for the full story).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

    // The Tools panel has one button per ToolId EXCEPT the select-* family,
    // which shares a single 'select-rect' button (see tools.ts's header
    // comment), so of DISABLED_TOOLS' 4 ids, only clone/recolor have a
    // distinct disabled button; select-lasso/select-wand have none to click
    // at all (not present, not just disabled). Bucket graduated to a real
    // tool in Wave 6 and is covered by bucket.spec.ts.
    // The rail's tooltip is a g-system data-tip (sentence case), not a title.
    const disabledButtons = page.locator('[data-tip*="not implemented yet"]');
    await expect(disabledButtons).toHaveCount(2);

    const before = await page.evaluate(() => window.__gdesign!.stores.toolState.get().active);
    const count = await disabledButtons.count();
    for (let i = 0; i < count; i += 1) {
      await disabledButtons.nth(i).click({ force: true });
    }
    const after = await page.evaluate(() => window.__gdesign!.stores.toolState.get().active);
    expect(after).toBe(before);

    // tool.cycle (keyboard) skips disabled tools but selects enabled ones:
    // F is bucket's single-key group, and bucket is real now.
    await page.keyboard.press('f');
    expect(await page.evaluate(() => window.__gdesign!.stores.toolState.get().active)).toBe('bucket');
  });

  test('painting first does not break Shapes/Text insert or marquee select (activeLayer resolve-or-create, never refuse)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true);
    // Pause the auto-playing clock: its continuous render loop compounds
    // across sequential contexts under SwiftShader until readbacks hang
    // outright (see groups.spec.ts's beforeEach for the full story).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

    // A scene layer + one object to marquee-select later.
    const rectId = await page.evaluate(() => {
      window.__gdesign!.exec('scene.newLayer');
      window.__gdesign!.exec('object.insertRect'); // centred at (640, 360), 200x120
      const doc = window.__gdesign!.doc();
      const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene')!;
      return (layer as { source: { params: { scene?: unknown } } }).source.params.scene as { id: string }[];
    }).then((objects) => objects[0]!.id);
    const sceneLayerCountBefore = await page.evaluate(() =>
      window.__gdesign!.doc().layers.filter((l) => l.kind === 'layer' && l.source.type === 'core.scene').length);
    expect(sceneLayerCountBefore).toBe(1);

    // Paint a brush stroke: the default 'brush' tool, on boot's default
    // raster layer. This is the exact probe repro: resolvePaintLayer
    // reassigns viewState.activeLayer away from the scene layer.
    await page.keyboard.press('b');
    const { box, zoom } = await canvasBoxAndZoom(page);
    await page.mouse.move(box.x + 400 * zoom, box.y + 550 * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + 500 * zoom, box.y + 550 * zoom, { steps: 4 });
    await page.mouse.up();
    const activeAfterPaint = await page.evaluate(() => window.__gdesign!.stores.viewState.get().activeLayer);
    const activeIsRaster = await page.evaluate((id) => {
      const doc = window.__gdesign!.doc();
      const l = doc.layers.find((x) => x.id === id);
      return l?.kind === 'layer' && l.source.type === 'core.raster';
    }, activeAfterPaint);
    expect(activeIsRaster).toBe(true); // sanity: the probe's precondition actually happened

    // Shapes tool: must still insert (into the EXISTING scene layer, not a
    // new one) despite activeLayer now pointing at the raster layer.
    await page.keyboard.press('o'); // -> line
    await page.keyboard.press('o'); // -> shapes
    await page.mouse.move(box.x + 300 * zoom, box.y + 100 * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + 400 * zoom, box.y + 180 * zoom, { steps: 4 });
    await page.mouse.up();
    const sceneLayerCountAfterShape = await page.evaluate(() =>
      window.__gdesign!.doc().layers.filter((l) => l.kind === 'layer' && l.source.type === 'core.scene').length);
    expect(sceneLayerCountAfterShape).toBe(1); // fell back to the existing scene layer, didn't create another

    // Text tool: click must still insert + open the editor.
    await page.keyboard.press('t');
    await page.mouse.click(box.x + 300 * zoom, box.y + 250 * zoom);
    const editor = page.locator('[data-testid="text-editor"]');
    await expect(editor).toBeVisible();
    await editor.press('Escape');

    // Marquee select: must find the object from step 1 even though
    // activeLayer currently points at the raster layer.
    await page.keyboard.press('s'); // -> select-rect
    await page.mouse.move(box.x + 500 * zoom, box.y + 250 * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + 800 * zoom, box.y + 450 * zoom, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects))
      .toEqual([rectId]);
  });
});

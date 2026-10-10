import { test, expect } from '@playwright/test';

/**
 * Image import as a scene OBJECT (not a full-canvas layer): the fix for the
 * user-reported "pasted image is stretched and I can't touch it" bug. Mirrors
 * scene.spec.ts's move-tool test's canvas-drag conventions (doc px -> client
 * px via the live zoom) and shell2.spec.ts's drop-a-File-via-DataTransfer
 * convention (real OS drag-drop isn't available under Playwright). Every
 * `page.evaluate` block is self-contained per the house rule: never shuttle
 * ArrayBuffers/edit batches across evaluate calls.
 *
 * Images are built in-page via a 2D canvas (not a checked-in fixture) so an
 * arbitrary non-canvas aspect ratio is trivial to produce.
 */

/** Drops an in-page-generated solid-colour PNG of the given size onto the
 * canvas region, mirroring shell2.spec.ts's drop-import test. Returns once
 * the drop event has been dispatched. Callers poll for the resulting layer. */
async function dropGeneratedImage(page: import('@playwright/test').Page, width: number, height: number, color: string): Promise<void> {
  await page.evaluate(
    async ({ width, height, color }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
      const file = new File([blob], 'dropped.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const region = document.querySelector('[data-testid="canvas-region"]')!;
      region.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { width, height, color },
  );
}

/** The scene layer + its (sole) image object created by the most recent
 * import. Asserts there's exactly one object, since every import creates
 * a fresh layer holding exactly one. */
async function readImportedObject(page: import('@playwright/test').Page): Promise<{
  layerId: string;
  objectId: string;
  assetWidth: number;
  assetHeight: number;
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number; anchorX: number; anchorY: number };
}> {
  return page.evaluate(() => {
    const doc = (window as any).__gdesign.doc();
    const layer = doc.layers.find((l: any) => l.kind === 'layer' && l.source.type === 'core.scene' && l.source.params.scene?.length === 1);
    const object = layer.source.params.scene[0];
    const asset = doc.assets[object.content.asset];
    return {
      layerId: layer.id,
      objectId: object.id,
      assetWidth: asset.width,
      assetHeight: asset.height,
      transform: object.transform,
    };
  });
}

test.describe('image import as a scene object', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
    // main.ts's boot() auto-plays the clock, driving a continuous render
    // loop for the page's whole lifetime; under this host's SwiftShader
    // (software) WebGPU, that compounds across this file's own several
    // readback-heavy tests (worse still alongside other files in one
    // combined run) until a later boot's readiness check times out
    // entirely (the same failure groups.spec.ts hit; see this file's
    // history). clipboard/lut/paste-stability/video-import/groups.spec.ts
    // all pause on boot for the same reason.
    await page.evaluate(() => (window as any).__gdesign.engine.setClock({ cmd: 'pause' }));
  });

  test('drop a tall-aspect image: the object keeps the SOURCE aspect, not the canvas aspect (no stretch)', async ({ page }) => {
    const before = await page.evaluate(() => (window as any).__gdesign.doc().layers.length);

    // 40x160 (1:4, tall) into the default 1280x720 (16:9, wide) canvas:
    // stretched-to-canvas would come out ~1280x720 (16:9); contain-fit keeps
    // it 1:4 (smaller than the canvas on both axes here, so native size).
    await dropGeneratedImage(page, 40, 160, '#ff0000');
    await expect.poll(() => page.evaluate(() => (window as any).__gdesign.doc().layers.length)).toBe(before + 1);

    const imported = await readImportedObject(page);
    expect(imported.assetWidth).toBe(40);
    expect(imported.assetHeight).toBe(160);
    // Uniform scale only: never a different X vs Y factor, or the object
    // itself would stretch even with the right asset dimensions.
    expect(imported.transform.scaleX).toBe(imported.transform.scaleY);
    expect(imported.transform.scaleX).toBe(1); // smaller than the canvas -> native size, unscaled

    const renderedWidth = imported.assetWidth * imported.transform.scaleX;
    const renderedHeight = imported.assetHeight * imported.transform.scaleY;
    expect(renderedWidth / renderedHeight).toBeCloseTo(40 / 160, 5);
  });

  test('a larger-than-canvas image is contained (shrunk, aspect preserved), never stretched to fill the canvas', async ({ page }) => {
    const before = await page.evaluate(() => (window as any).__gdesign.doc().layers.length);

    // 3000x1500 (2:1) into the default 1280x720 canvas: width is the
    // limiting axis (3000/1280 > 1500/720), so scale = 1280/3000.
    await dropGeneratedImage(page, 3000, 1500, '#00ff00');
    await expect.poll(() => page.evaluate(() => (window as any).__gdesign.doc().layers.length)).toBe(before + 1);

    const imported = await readImportedObject(page);
    expect(imported.transform.scaleX).toBe(imported.transform.scaleY);
    expect(imported.transform.scaleX).toBeCloseTo(1280 / 3000, 5);
    const renderedWidth = imported.assetWidth * imported.transform.scaleX;
    const renderedHeight = imported.assetHeight * imported.transform.scaleY;
    expect(renderedWidth).toBeLessThanOrEqual(1280 + 0.01);
    expect(renderedHeight).toBeLessThanOrEqual(720 + 0.01);
    expect(renderedWidth / renderedHeight).toBeCloseTo(2, 5);
  });

  test('readback: non-transparent at the image centre, the starter doc\'s opaque Background layer outside its bounds', async ({ page }) => {
    // 200x100 centred on the default 1280x720 canvas -> spans doc
    // (540,310)-(740,410). Sample well inside vs. a far corner.
    await dropGeneratedImage(page, 200, 100, '#ff0000');
    await expect.poll(() => page.evaluate(() => (window as any).__gdesign.doc().layers.length).catch(() => 0)).toBeGreaterThan(0);

    // Image decode (createImageBitmap + GPU upload) is async. Poll a
    // readback until the centre pixel stops being the placeholder's
    // transparent alpha (same pattern as scene.spec.ts's image-object test).
    await expect
      .poll(async () => {
        return page.evaluate(async () => {
          const r = await (window as any).__gdesign.engine.readback({ via: 'float' });
          const data = new Float32Array(r.data);
          const idx = (360 * r.width + 640) * 4; // doc centre, well inside the 540,310-740,410 box
          return data[idx + 3]; // alpha
        });
      })
      .toBeGreaterThan(0);

    // The far corner isn't transparent: main.ts's starter doc ships an
    // opaque, full-canvas 'Background' core.solid layer (OKLab
    // [0.65, 0.05, -0.1, 1]) underneath everything, so outside the image
    // object's bounds the composite shows THAT colour at alpha 1, not
    // nothing. Assert the background's own colour instead of transparency.
    const outsidePixel = await page.evaluate(async () => {
      const r = await (window as any).__gdesign.engine.readback({ via: 'float' });
      const data = new Float32Array(r.data);
      const idx = (10 * r.width + 10) * 4; // far corner, outside the image object and every other layer
      return [data[idx]!, data[idx + 1]!, data[idx + 2]!, data[idx + 3]!];
    });
    expect(outsidePixel[0]).toBeCloseTo(0.65, 2);
    expect(outsidePixel[1]).toBeCloseTo(0.05, 2);
    expect(outsidePixel[2]).toBeCloseTo(-0.1, 2);
    expect(outsidePixel[3]).toBeCloseTo(1, 2);
  });

  test('import selects the new object and switches to the move tool, so the very next drag moves it', async ({ page }) => {
    await dropGeneratedImage(page, 100, 100, '#ff00ff');
    const imported = await expect.poll(() => readImportedObject(page).then((r) => r).catch(() => null)).not.toBeNull()
      .then(() => readImportedObject(page));

    await expect.poll(() => page.evaluate(() => (window as any).__gdesign.stores.selectionState.get().objects)).toEqual([imported.objectId]);
    await expect.poll(() => page.evaluate(() => (window as any).__gdesign.stores.toolState.get().active)).toBe('move');
    await expect(page.locator('[data-testid="selection-overlay"] .gd-selection-box')).toBeVisible();

    const { x: startX, y: startY } = imported.transform;
    const canvas = page.locator('#gd-canvas');
    const box = (await canvas.boundingBox())!;
    const { zoom } = await page.evaluate(() => (window as any).__gdesign.stores.viewState.get());

    await page.mouse.move(box.x + startX * zoom, box.y + startY * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + (startX + 40) * zoom, box.y + (startY + 15) * zoom, { steps: 4 });
    await page.mouse.up();

    const afterDrag = await readImportedObject(page);
    expect(afterDrag.transform.x).toBeCloseTo(startX + 40, 0);
    expect(afterDrag.transform.y).toBeCloseTo(startY + 15, 0);

    // One undo step restores the pre-drag position.
    await page.evaluate(() => (window as any).__gdesign.exec('edit.undo'));
    const afterUndo = await readImportedObject(page);
    expect(afterUndo.transform.x).toBeCloseTo(startX, 0);
    expect(afterUndo.transform.y).toBeCloseTo(startY, 0);
  });

  test('resize handles work on an imported object', async ({ page }) => {

    await dropGeneratedImage(page, 100, 100, '#00ffff');
    const imported = await expect.poll(() => readImportedObject(page).then((r) => r).catch(() => null)).not.toBeNull()
      .then(() => readImportedObject(page));

    await expect(page.locator('[data-testid="handle-br"]')).toBeVisible();

    const canvas = page.locator('#gd-canvas');
    const box = (await canvas.boundingBox())!;
    const { zoom } = await page.evaluate(() => (window as any).__gdesign.stores.viewState.get());
    // Bottom-right handle sits at the object's own bottom-right corner
    // (anchor 0.5/0.5, native 100x100, scale 1 -> corner at x+50, y+50).
    const cornerX = imported.transform.x + 50;
    const cornerY = imported.transform.y + 50;

    const handle = page.locator('[data-testid="handle-br"]');
    const hbox = (await handle.boundingBox())!;
    await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
    await page.mouse.down();
    // Many steps on purpose: each move fires setTransform → document-changed
    // → overlay re-render, which used to destroy the handle (and its
    // listeners) after the FIRST step, leaving the drag dead: scale ended
    // barely above 1 instead of tracking the pointer. Asserting the final
    // scale (not just "> start") pins the fix.
    await page.mouse.move(box.x + (cornerX + 40) * zoom, box.y + (cornerY + 40) * zoom, { steps: 12 });
    await page.mouse.up();

    // Corner dragged from (x+50, y+50) to (x+90, y+90) about the centre
    // anchor → scale 90/50 = 1.8 on both axes.
    const afterResize = await readImportedObject(page);
    expect(afterResize.transform.scaleX).toBeCloseTo(1.8, 1);
    expect(afterResize.transform.scaleY).toBeCloseTo(1.8, 1);
  });

  test('Shift+resize locks the aspect ratio (uniform scale on both axes)', async ({ page }) => {
    // Non-square source so a stretched result is detectable: 200x100.
    await dropGeneratedImage(page, 200, 100, '#00ff00');
    const imported = await expect.poll(() => readImportedObject(page).then((r) => r).catch(() => null)).not.toBeNull()
      .then(() => readImportedObject(page));

    const handle = page.locator('[data-testid="handle-br"]');
    await expect(handle).toBeVisible();
    const canvas = page.locator('#gd-canvas');
    const box = (await canvas.boundingBox())!;
    const { zoom } = await page.evaluate(() => (window as any).__gdesign.stores.viewState.get());
    const cornerX = imported.transform.x + 100;
    const cornerY = imported.transform.y + 50;

    const hbox = (await handle.boundingBox())!;
    await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
    await page.keyboard.down('Shift');
    await page.mouse.down();
    // Deliberately drag much further in X than Y. Without the lock this
    // ends at scaleX ~1.8, scaleY ~1.2; the lock follows the dominant
    // axis and forces both to the same factor.
    await page.mouse.move(box.x + (cornerX + 80) * zoom, box.y + (cornerY + 10) * zoom, { steps: 12 });
    await page.mouse.up();
    await page.keyboard.up('Shift');

    const after = await readImportedObject(page);
    expect(after.transform.scaleX).toBeCloseTo(after.transform.scaleY, 5);
    expect(after.transform.scaleX).toBeCloseTo(1.8, 1); // dominant (X) factor: (100+80)/100
  });

  test('rotate handle tracks a full drag, not just the first move event', async ({ page }) => {
    await dropGeneratedImage(page, 100, 100, '#ffff00');
    const imported = await expect.poll(() => readImportedObject(page).then((r) => r).catch(() => null)).not.toBeNull()
      .then(() => readImportedObject(page));

    const rotate = page.locator('[data-testid="handle-rotate"]');
    await expect(rotate).toBeVisible();
    const canvas = page.locator('#gd-canvas');
    const box = (await canvas.boundingBox())!;
    const { zoom } = await page.evaluate(() => (window as any).__gdesign.stores.viewState.get());
    const { x: cx, y: cy } = imported.transform;

    const rbox = (await rotate.boundingBox())!;
    await page.mouse.move(rbox.x + rbox.width / 2, rbox.y + rbox.height / 2);
    await page.mouse.down();
    // Sweep the pointer to due-right of the object's centre in several
    // steps (overlay re-renders between each, the regression this pins).
    // Rotate maps pointer-at-angle+90°: due right (atan2 = 0) → rotation 90°.
    await page.mouse.move(box.x + (cx + 80) * zoom, box.y + cy * zoom, { steps: 12 });
    await page.mouse.up();

    const after = await readImportedObject(page);
    expect(after.transform.rotation).toBeCloseTo(Math.PI / 2, 1);
  });
});

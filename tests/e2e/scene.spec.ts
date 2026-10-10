import { test, expect } from '@playwright/test';

/**
 * core.scene: render (rect fill vs background), hitTest (topmost object at
 * a point, null elsewhere), setTransform (translate + readback confirms the
 * move), and the move-tool UI flow (insert -> click -> select -> drag ->
 * undo). Each `page.evaluate` block is self-contained per the house rule:
 * never shuttle ArrayBuffers/edit batches across evaluate calls.
 */
test.describe('core.scene', () => {
  test('renders a shape object: fill colour inside the rect, background outside', async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
    await page.evaluate(async () => {
      await window.__engineTest!.loadScene();
    });

    const float = await page.evaluate(async () => {
      const r = await window.__engineTest!.host.readback({ via: 'float' });
      return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
    });

    const pixelAt = (x: number, y: number) => {
      const idx = (y * float.width + x) * 4;
      return float.data.slice(idx, idx + 4);
    };

    // Rect spans doc (10,10)-(30,25); sample well inside vs. well outside.
    const inside = pixelAt(20, 17);
    expect(inside[0]).toBeCloseTo(0.62796, 1);
    expect(inside[1]).toBeCloseTo(0.22486, 1);
    expect(inside[2]).toBeCloseTo(0.12585, 1);
    expect(inside[3]).toBeCloseTo(1, 1);

    const outside = pixelAt(50, 50);
    expect(outside[0]).toBeCloseTo(0.15, 1);
    expect(outside[1]).toBeCloseTo(0, 1);
    expect(outside[2]).toBeCloseTo(0, 1);
  });

  test('hitTest returns the object id inside the rect, null elsewhere', async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
    const ids = await page.evaluate(async () => window.__engineTest!.loadScene());

    const inside = await page.evaluate(async () => window.__engineTest!.host.hitTest(20, 17));
    expect(inside.object).toBe(ids.object);
    expect(inside.layer).toBe(ids.layer);

    const outside = await page.evaluate(async () => window.__engineTest!.host.hitTest(50, 50));
    expect(outside.object).toBeNull();
  });

  test('setTransform translate moves the rendered rect', async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
    const ids = await page.evaluate(async () => window.__engineTest!.loadScene());

    await page.evaluate(async ({ object }) => {
      window.__engineTest!.host.applyEdits([
        { op: 'setTransform', id: object as unknown as never, transform: { x: 40, y: 40, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 } },
      ]);
    }, { object: ids.object });

    const float = await page.evaluate(async () => {
      const r = await window.__engineTest!.host.readback({ via: 'float' });
      return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
    });
    const pixelAt = (x: number, y: number) => {
      const idx = (y * float.width + x) * 4;
      return float.data.slice(idx, idx + 4);
    };

    // Moved to (40,40)-(60,55): old spot is now background, new spot is red.
    expect(pixelAt(20, 17)[0]).toBeCloseTo(0.15, 1);
    const moved = pixelAt(50, 47);
    expect(moved[0]).toBeCloseTo(0.62796, 1);
  });

  test('move tool: insert, click-select, drag-move, undo restores position', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true);

    await page.evaluate(() => {
      window.__gdesign!.exec('scene.newLayer');
      window.__gdesign!.exec('object.insertRect');
    });

    const before = await page.evaluate(() => {
      const doc = window.__gdesign!.doc();
      const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene')!;
      const objects = (layer as { source: { params: { scene?: unknown } } }).source.params.scene as { id: string; transform: { x: number; y: number } }[];
      return { objectId: objects[0]!.id, x: objects[0]!.transform.x, y: objects[0]!.transform.y };
    });
    expect(before.x).toBe(640);
    expect(before.y).toBe(360);

    // Switch to the move tool and click the object's centre (default insert
    // transform: 200x120 rect anchored at its own centre, positioned at 640,360,
    // away from every docked panel's default corner). The canvas element is
    // itself scaled by the current zoom (boot fits-and-centres the doc), so
    // doc px -> canvas-local CSS px needs *zoom; client px -> doc px is the
    // reverse (see src/ui/shell/view-math.ts / viewport.ts's toDocPoint).
    await page.keyboard.press('m');
    const canvas = page.locator('#gd-canvas');
    const box = (await canvas.boundingBox())!;
    const { zoom } = await page.evaluate(() => window.__gdesign!.stores.viewState.get());
    await canvas.click({ position: { x: 640 * zoom, y: 360 * zoom } });

    // hitTest is async (engine.hitTest returns a Promise). Poll rather than
    // assert immediately after click() returns.
    await expect.poll(() => page.evaluate(() => window.__gdesign!.stores.selectionState.get().objects)).toEqual([before.objectId]);

    await expect(page.locator('[data-testid="selection-overlay"] .gd-selection-box')).toBeVisible();

    // Drag the object 40 doc-px right, 15 doc-px down (client px = doc px * zoom).
    await page.mouse.move(box.x + 640 * zoom, box.y + 360 * zoom);
    await page.mouse.down();
    await page.mouse.move(box.x + 680 * zoom, box.y + 375 * zoom, { steps: 4 });
    await page.mouse.up();

    const afterDrag = await page.evaluate((id) => {
      const doc = window.__gdesign!.doc();
      const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene')!;
      const objects = (layer as { source: { params: { scene?: unknown } } }).source.params.scene as { id: string; transform: { x: number; y: number } }[];
      return objects.find((o) => o.id === id)!.transform;
    }, before.objectId);
    expect(afterDrag.x).toBeCloseTo(680, 0);
    expect(afterDrag.y).toBeCloseTo(375, 0);

    await page.evaluate(() => window.__gdesign!.exec('edit.undo'));
    const afterUndo = await page.evaluate((id) => {
      const doc = window.__gdesign!.doc();
      const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene')!;
      const objects = (layer as { source: { params: { scene?: unknown } } }).source.params.scene as { id: string; transform: { x: number; y: number } }[];
      return objects.find((o) => o.id === id)!.transform;
    }, before.objectId);
    expect(afterUndo.x).toBeCloseTo(640, 0);
    expect(afterUndo.y).toBeCloseTo(360, 0);
  });

  // Regression guard for the getAsset()-returns-raw-AssetJSON mismatch fixed
  // in core.scene's image objects (same class of bug as core.image's, see
  // src/engine/core/image-decode.ts): an image object must actually render,
  // not just avoid throwing. Decode is async, so poll a readback rather than
  // asserting immediately after the addObject edit lands.
  test('a scene image object decodes and renders (non-transparent at its position)', async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
    const ids = await page.evaluate(async () => window.__engineTest!.loadScene());

    // A minimal valid 1x1 PNG (same fixture as shell2.spec.ts's drop-import
    // test), scaled 20x so its rendered box is easy to sample reliably.
    const png1x1 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await page.evaluate(async ({ layer, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const assetId = 'image-obj-asset';
      window.__engineTest!.host.applyEdits([
        { op: 'addAsset', id: assetId, asset: { type: 'image', mime: 'image/png', data: bytes.buffer, width: 1, height: 1 } },
        {
          op: 'addObject',
          layer: layer as unknown as never,
          parent: null,
          index: 1,
          object: {
            id: 'image-obj' as unknown as never,
            name: 'Image',
            enabled: true,
            content: { type: 'image', asset: assetId as unknown as never },
            style: {},
            liveness: 'live',
            transform: { x: 40, y: 40, rotation: 0, scaleX: 20, scaleY: 20, anchorX: 0, anchorY: 0 },
          } as unknown as never,
        },
      ]);
    }, { layer: ids.layer, b64: png1x1 });

    // Image decode is async (createImageBitmap + GPU upload). Poll a
    // readback until the pixel at the image's doc position stops being the
    // placeholder's transparent alpha.
    await expect
      .poll(async () => {
        return page.evaluate(async () => {
          const r = await window.__engineTest!.host.readback({ via: 'float' });
          const data = new Float32Array(r.data);
          const idx = (50 * r.width + 50) * 4; // well inside the 40,40-60,60 box
          return data[idx + 3]; // alpha
        });
      })
      .toBeGreaterThan(0);
  });
});

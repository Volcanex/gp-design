/**
 * Contract: see boot.spec.ts header for the full window.__gdesign shape.
 * Clipboard precedence (src/ui/CLAUDE.md): Copy/Cut/Paste (Ctrl+C/X/V) are
 * internal-clipboard-first; Ctrl+Shift+C/V are OS-clipboard-explicit.
 *
 * Environment quirk found while fixing this spec (real, not an assumption):
 * `window.__gdesign` boots with the clock PLAYING (main.ts), a continuous
 * requestAnimationFrame render loop. Under this host's headless SwiftShader
 * build, that loop contends with `engine.readback()`'s own render+mapAsync:
 * reproduced directly (outside Playwright, via a raw script against the
 * built dist) that back-to-back readback() calls on a live-clock page get
 * progressively slower (sub-second, then ~12s, then never resolving at
 * all within 30s), while the SAME sequence with the clock paused first
 * stays sub-second throughout, regardless of how many readback() calls or
 * how many layers are in the document. This is a distinct trigger from
 * chain-panel.spec.ts's documented chain-render AbortError poison (that one
 * THROWS after a chain renders; this one just never settles). Both are
 * SwiftShader-only mapAsync contention, different causes. Every test below
 * that calls readback() pauses the clock first; it has nothing to do with
 * what these tests assert (document state / a static pixel comparison).
 */

import { test, expect } from '@playwright/test';

async function readbackBytes(page: import('@playwright/test').Page): Promise<Uint8Array> {
  const arr = await page.evaluate(async () => {
    const r = await window.__gdesign!.engine.readback({ via: 'quantised' });
    return Array.from(new Uint8Array(r.data));
  });
  return new Uint8Array(arr);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__gdesign?.ready === true, { timeout: 30_000 });
  await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));
});

test.describe('internal clipboard: layer', () => {
  test('copy layer -> paste duplicates above active with fresh ids, unchanged render', async ({ page }) => {
    await page.locator('[data-testid="layer-new"]').click();
    const before = await page.evaluate(() => window.__gdesign!.doc().layers.map((l) => l.id));
    const beforeBytes = await readbackBytes(page);

    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');

    const after = await page.evaluate(() => window.__gdesign!.doc().layers.map((l) => l.id));
    expect(after).toHaveLength(before.length + 1);
    expect(new Set(after).size).toBe(after.length); // no id collisions

    const afterBytes = await readbackBytes(page);
    expect(afterBytes).toEqual(beforeBytes); // an identical solid layer stacked on itself renders the same
  });

  test('repeated paste keeps producing fresh ids', async ({ page }) => {
    await page.locator('[data-testid="layer-new"]').click();
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await page.keyboard.press('Control+v');

    const ids = await page.evaluate(() => window.__gdesign!.doc().layers.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

test.describe('internal clipboard: object', () => {
  async function insertRectAndSelect(page: import('@playwright/test').Page): Promise<string> {
    return page.evaluate(() => {
      const gd = window.__gdesign!;
      gd.exec('object.insertRect');
      const id = gd.stores.selectionState.get().objects[0]!;
      return id;
    });
  }

  test('copy object -> paste inserts an offset copy with a fresh id', async ({ page }) => {
    const originalId = await insertRectAndSelect(page);

    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');

    const scene = await page.evaluate(() => {
      const doc = window.__gdesign!.doc();
      const sceneLayer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene') as any;
      return sceneLayer.source.params.scene as { id: string; transform: { x: number; y: number } }[];
    });
    expect(scene).toHaveLength(2);
    const pasted = scene.find((o) => o.id !== originalId)!;
    const original = scene.find((o) => o.id === originalId)!;
    expect(pasted.transform.x).toBe(original.transform.x + 10);
    expect(pasted.transform.y).toBe(original.transform.y + 10);
  });

  test('cut removes the object; paste brings it back', async ({ page }) => {
    await insertRectAndSelect(page);
    const countBefore = await page.evaluate(() => {
      const doc = window.__gdesign!.doc();
      const sceneLayer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene') as any;
      return (sceneLayer.source.params.scene ?? []).length;
    });

    await page.keyboard.press('Control+x');
    const afterCut = await page.evaluate(() => {
      const doc = window.__gdesign!.doc();
      const sceneLayer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene') as any;
      return (sceneLayer.source.params.scene ?? []).length;
    });
    expect(afterCut).toBe(countBefore - 1);

    await page.keyboard.press('Control+v');
    const afterPaste = await page.evaluate(() => {
      const doc = window.__gdesign!.doc();
      const sceneLayer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene') as any;
      return (sceneLayer.source.params.scene ?? []).length;
    });
    expect(afterPaste).toBe(countBefore);
  });
});

// OS-clipboard round trip needs real clipboard permissions. Kept in its own
// describe so it can be skipped where the CI sandbox denies them.
test.describe('OS clipboard round trip', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('Copy Merged writes a PNG to the OS clipboard; Paste as Layer (Ctrl+Shift+V) reads it back as a new layer', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('[data-testid="layer-new"]').click();
    const layerCountBefore = await page.evaluate(() => window.__gdesign!.doc().layers.length);

    await page.keyboard.press('Control+Shift+C'); // edit.copyMerged

    // edit.copyMerged awaits its own internal readback() before writing the
    // PNG. A fixed wait here would race that (and previously did: a 200ms
    // wait sometimes fired Ctrl+Shift+V before the OS clipboard write had
    // landed, so Paste as Layer found nothing and layers.length never grew).
    // Poll the OS clipboard itself instead of guessing a delay.
    await expect.poll(async () => page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      return items.some((item) => item.types.some((t) => t.startsWith('image/')));
    }), { timeout: 20_000 }).toBe(true);

    await page.keyboard.press('Control+Shift+V'); // edit.pasteAsLayer (OS-clipboard-explicit)
    await expect.poll(async () => page.evaluate(() => window.__gdesign!.doc().layers.length), { timeout: 20_000 })
      .toBe(layerCountBefore + 1);
  });
});

// See tests/e2e/paste-stability.spec.ts for the "pasting images flashes"
// regression guard (moved there: it needs the forced-present harness, not
// just a readback loop, to be conclusive).

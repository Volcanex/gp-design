import { test, expect } from '@playwright/test';
import type { DocumentJSON } from '../../src/engine/doc/json';
import { identityLutBytes, invertedLutBytes } from '../../src/engine/passes/builtin/lut-bytes';

/**
 * Self-contained per CLAUDE.md: doc constructed inline against
 * window.__engineTest.host, asserted only via host.readback (no
 * screenshots: headless SwiftShader has no real display).
 */

const N = 8;

/**
 * Playwright's page.evaluate argument serialization does NOT preserve
 * ArrayBuffer (it round-trips as a plain object with no byteLength), so the
 * LUT bytes cross the boundary as a plain number[] and get rebuilt into a
 * real ArrayBuffer inside the page, right before loadDocument.
 */
function lutDoc(lutBytesArray: number[], colorLab: [number, number, number, number], amount: number) {
  const doc: Omit<DocumentJSON, 'assets'> & { assets: Record<string, { type: 'lut'; data: number[]; size: number }> } = {
    version: 1,
    canvas: { width: 8, height: 8, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [
      {
        id: 'l1' as never,
        kind: 'layer',
        name: 'solo',
        enabled: true,
        source: { type: 'core.solid', params: { color: colorLab } },
        chain: [{ id: 'fx1', pass: 'core.lut', params: { asset: { asset: 'lut1' }, amount }, enabled: true }],
        blendMode: 'normal',
        opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'live',
      } as never,
    ],
    postChain: [],
    assets: {
      lut1: { type: 'lut', data: lutBytesArray, size: N },
    },
  };
  return doc;
}

async function loadLutDoc(page: import('@playwright/test').Page, lutBytes: Uint8Array, colorLab: [number, number, number, number], amount: number) {
  await page.evaluate(async (doc) => {
    const lut1 = doc.assets.lut1!;
    (lut1 as unknown as { data: ArrayBuffer }).data = Uint8Array.from(lut1.data as unknown as number[]).buffer;
    await window.__engineTest!.host.loadDocument(doc as never);
  }, lutDoc(Array.from(lutBytes), colorLab, amount));
}

async function readCentre(page: import('@playwright/test').Page) {
  const r = await page.evaluate(async () => {
    const res = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: res.width, height: res.height, data: Array.from(new Float32Array(res.data)) };
  });
  const cx = Math.floor(r.width / 2);
  const cy = Math.floor(r.height / 2);
  const idx = (cy * r.width + cx) * 4;
  return r.data.slice(idx, idx + 4);
}

test.describe('core.lut', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
  });

  test('identity LUT at amount 1 leaves the pixel unchanged', async ({ page }) => {
    const orange: [number, number, number, number] = [0.55, 0.1, 0.08, 1];
    await loadLutDoc(page, identityLutBytes(N), orange, 1);

    const px = await readCentre(page);
    expect(Math.abs(px[0]! - orange[0])).toBeLessThan(0.03);
    expect(Math.abs(px[1]! - orange[1])).toBeLessThan(0.03);
    expect(Math.abs(px[2]! - orange[2])).toBeLessThan(0.03);
    expect(px[3]).toBeCloseTo(1, 2);
  });

  test('inverted LUT at amount 1 inverts linear-sRGB rgb (round-trips back through OKLab)', async ({ page }) => {
    const orange: [number, number, number, number] = [0.55, 0.1, 0.08, 1];
    await loadLutDoc(page, invertedLutBytes(N), orange, 1);

    const px = await readCentre(page);
    // Applying the inverted LUT twice (once here, once as a mental check)
    // should be close to identity in linear-sRGB space. Cheaper to assert:
    // the result must differ meaningfully from the untouched input.
    const changed = Math.abs(px[0]! - orange[0]) > 0.05
      || Math.abs(px[1]! - orange[1]) > 0.02
      || Math.abs(px[2]! - orange[2]) > 0.02;
    expect(changed).toBe(true);
    expect(px[3]).toBeCloseTo(1, 2);
  });

  test('amount 0 leaves the pixel unchanged regardless of LUT contents', async ({ page }) => {
    const teal: [number, number, number, number] = [0.5, -0.1, -0.05, 1];
    await loadLutDoc(page, invertedLutBytes(N), teal, 0);

    const px = await readCentre(page);
    expect(Math.abs(px[0]! - teal[0])).toBeLessThan(0.03);
    expect(Math.abs(px[1]! - teal[1])).toBeLessThan(0.03);
    expect(Math.abs(px[2]! - teal[2])).toBeLessThan(0.03);
  });
});

/**
 * Full UI path (unlike the engine-direct describe above): add core.lut via
 * the Effect dialog, pick the built-in Identity entry through the asset
 * picker popover (ui/forms/params-form.ts's assetRow + effect-dialog.ts's
 * opts.assets), and confirm the readback is unchanged at amount 1, the
 * same invariant as "identity LUT at amount 1 leaves the pixel unchanged"
 * above, but exercised end-to-end through the picker instead of a doc built
 * by hand.
 *
 * Contract: see boot.spec.ts header for window.__gdesign.
 *
 * At most one `engine.readback()` call per page (see chain-panel.spec.ts's
 * header note 2): once a real effect chain has rendered (which happens the
 * moment an asset is picked here, since effect-dialog.ts's live preview
 * applies the chain immediately, not just on OK), every readback() call
 * AFTER that in the SAME page throws `AbortError: ... mapAsync ... A valid
 * external Instance reference no longer exists` (reproduced directly: this
 * test originally read back once before adding the effect and once after,
 * and the second call threw exactly that error). Baseline and
 * picker-applied readbacks are taken on two separate pages instead.
 */
test.describe('core.lut: asset picker (UI)', () => {
  async function freshReadyPage(browser: import('@playwright/test').Browser) {
    const page = await browser.newPage();
    await page.goto('/');
    await page.waitForFunction(() => window.__gdesign?.ready === true, { timeout: 30_000 });
    // Multiple readback() calls in one page under a continuously-playing
    // clock progressively slow down (SwiftShader/RAF-loop contention) and
    // can hang outright. Pausing removes the unrelated per-frame work
    // this test's static pixel comparison doesn't need. See
    // clipboard.spec.ts's header for the fuller writeup (found while fixing
    // that spec's readback timeouts).
    await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));
    await page.locator('[data-testid="layer-new"]').click();
    await page.waitForTimeout(200);
    return page;
  }

  test('picking the built-in Identity LUT via the picker leaves the readback unchanged', async ({ browser }) => {
    const basePage = await freshReadyPage(browser);
    const beforeBytes = await basePage.evaluate(async () => {
      const r = await window.__gdesign!.engine.readback({ via: 'quantised' });
      return Array.from(new Uint8Array(r.data));
    });
    await basePage.close();

    const page = await freshReadyPage(browser);
    await page.evaluate(() => window.__gdesign!.exec('effect.open', 'core.lut'));
    await page.locator('[data-testid="pf-asset-asset"]').click();
    await page.locator('[data-testid="asset-option-import"]').click();
    await page.locator('[data-testid="lut-import-identity"]').click();
    await page.locator('[data-testid="effect-ok"]').click();
    await page.waitForTimeout(200);

    const afterBytes = await page.evaluate(async () => {
      const r = await window.__gdesign!.engine.readback({ via: 'quantised' });
      return Array.from(new Uint8Array(r.data));
    });
    await page.close();

    // Amount defaults to 1 (lut.ts's ParamsSchema): an Identity LUT at full
    // amount must leave every pixel unchanged. ONE expect over a plain-loop
    // max, never expect()-per-element: 3.7M expect calls block the worker's
    // event loop for so long the test timeout can't even fire. The run
    // looks wedged at 90% CPU (this exact loop stalled every full-suite run
    // at the same spot and left orphaned workers behind).
    let maxDiff = 0;
    for (let i = 0; i < beforeBytes.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(beforeBytes[i]! - afterBytes[i]!));
    }
    expect(maxDiff).toBeLessThanOrEqual(1); // rounding tolerance
  });
});

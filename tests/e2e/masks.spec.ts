/**
 * MASKS block. Contract: see tests/e2e/boot.spec.ts header for the full
 * window.__gdesign shape. Written but NOT run in this worktree (no GPU).
 * See agents/masks brief.
 *
 * Setup for every test: a bottom SOLID layer (distinct colour, "what's
 * below") and an active top SOLID layer (distinct colour, "the masked
 * layer"), both full-canvas and opaque, so porter_duff_over degenerates to
 * "just whichever is on top / visible", exactly like blendgen.spec.ts's
 * centre-pixel comparisons. Every mask-affecting command below is run via
 * gd.exec(...) so this stays a document/engine test, not a UI-drag test
 * (canvas painting is exercised separately, see the dedicated stroke test).
 */

import { test, expect } from '@playwright/test';

const BELOW: [number, number, number, number] = [0.3, 0.05, 0.02, 1];
const FG: [number, number, number, number] = [0.8, -0.05, 0.05, 1];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });
  // Pause the auto-playing clock (SwiftShader readback-hang convention,
  // see groups.spec.ts's beforeEach).
  await page.evaluate(() => window.__gdesign!.engine.setClock({ cmd: 'pause' }));

  // Boot ships a solid Background + a raster Paint layer (main.ts). Replace
  // with two solids so this spec doesn't depend on that starter shape.
  await page.evaluate(([below, fg]) => {
    const gd = (window as any).__gdesign;
    const doc = gd.doc();
    const solid = (id: string, color: number[]) => ({
      id,
      kind: 'layer',
      name: id,
      enabled: true,
      source: { type: 'core.solid', params: { color } },
      chain: [],
      blendMode: 'normal',
      opacity: 1,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
      liveness: 'baked',
    });
    doc.layers.length = 0;
    doc.layers.push(solid('below', below), solid('fg', fg));
    gd.engine.loadDocument(doc);
    gd.stores.viewState.update((s: any) => ({ ...s, activeLayer: 'fg', maskEditing: null }));
  }, [BELOW, FG] as const);
});

async function centreFloat(page: import('@playwright/test').Page): Promise<[number, number, number, number]> {
  return page.evaluate(async () => {
    const gd = (window as any).__gdesign;
    const r = await gd.engine.readback({ via: 'float' });
    const data = new Float32Array(r.data);
    const cx = Math.floor(r.width / 2);
    const cy = Math.floor(r.height / 2);
    const i = (cy * r.width + cx) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
  });
}

async function edgeFloat(page: import('@playwright/test').Page): Promise<[number, number, number, number]> {
  return page.evaluate(async () => {
    const gd = (window as any).__gdesign;
    const r = await gd.engine.readback({ via: 'float' });
    const data = new Float32Array(r.data);
    const i = (2 * r.width + 2) * 4; // near the top-left corner, outside any centred brush stamp
    return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
  });
}

function closeTo(a: number[], b: number[], eps = 0.02): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) <= eps);
}

/** Byte-comparable doc snapshot, DIGESTED IN-PAGE: the first draft shipped
 * the whole doc (including the 7.4MB mask asset expanded to a plain number
 * array) across the evaluate bridge as JSON on every call, which livelocked
 * the shared full-suite browser process in GC (92% CPU, no progress; the
 * standalone run merely crawled). Same house rule as "never shuttle
 * ArrayBuffers across evaluate": return a short fingerprint, not the data.
 * FNV-1a over the structural JSON plus every asset's raw bytes. */
async function docSnapshot(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const gd = (window as any).__gdesign;
    let h = 0x811c9dc5;
    const mix = (b: number) => { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; };
    const structural = JSON.stringify(gd.doc(), (key, value) => (value instanceof ArrayBuffer ? `<buf:${value.byteLength}>` : value));
    for (let i = 0; i < structural.length; i += 1) mix(structural.charCodeAt(i) & 0xff);
    for (const asset of Object.values(gd.doc().assets) as any[]) {
      if (asset.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(asset.data);
        for (let i = 0; i < bytes.length; i += 1) mix(bytes[i]!);
      }
    }
    return h.toString(16);
  });
}

test('addMask on a solid layer is identity (white mask = keep everything)', async ({ page }) => {
  const before = await centreFloat(page);
  expect(closeTo(before, FG)).toBe(true);

  await page.evaluate(() => (window as any).__gdesign.exec('layer.addMask'));

  const hasMask = await page.evaluate(() => !!(window as any).__gdesign.doc().layers.find((l: any) => l.id === 'fg')?.mask);
  expect(hasMask).toBe(true);

  const after = await centreFloat(page);
  expect(closeTo(after, FG)).toBe(true); // unchanged: the whole point of an all-white mask
});

test('painting black at the mask centre reveals the layer below; the untouched edge is unaffected', async ({ page }) => {
  await page.evaluate(() => (window as any).__gdesign.exec('layer.addMask'));
  const before = await docSnapshot(page);

  // Enter MASK EDIT MODE via the layers panel chip (not the store directly)
  // so this exercises the real UI entry point.
  await page.locator('[data-testid="layer-row"]', { hasText: 'fg' }).locator('[data-testid="mask-chip"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__gdesign.stores.viewState.get().maskEditing)).toBe('fg');

  // Paint black (L=0): "paint white to reveal, black to hide".
  await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    gd.stores.toolState.update((s: any) => ({ ...s, primary: [0, 0, 0, 1], brushSize: 60 }));
  });
  await page.keyboard.press('b');
  const canvas = page.locator('#gd-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas not laid out');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 2, cy, { steps: 2 });
  await page.mouse.up();

  await expect.poll(async () => closeTo(await centreFloat(page), BELOW)).toBe(true);
  expect(closeTo(await edgeFloat(page), FG, 0.02)).toBe(true); // untouched corner still shows fg

  // One undo entry for the whole stroke; undo restores byte-identical doc.
  await page.keyboard.press('Control+z');
  expect(await docSnapshot(page)).toBe(before);
});

test('invert flips which end of the mask keeps content; disable and remove both restore identity', async ({ page }) => {
  await page.evaluate(() => (window as any).__gdesign.exec('layer.addMask'));
  await page.locator('[data-testid="layer-row"]', { hasText: 'fg' }).locator('[data-testid="mask-chip"]').click();
  await page.evaluate(() => {
    const gd = (window as any).__gdesign;
    gd.stores.toolState.update((s: any) => ({ ...s, primary: [0, 0, 0, 1], brushSize: 60 }));
  });
  await page.keyboard.press('b');
  const canvas = page.locator('#gd-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas not laid out');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 2, cy, { steps: 2 });
  await page.mouse.up();
  await expect.poll(async () => closeTo(await centreFloat(page), BELOW)).toBe(true);

  const beforeInvert = await docSnapshot(page);
  await page.evaluate(() => (window as any).__gdesign.exec('layer.toggleMaskInvert'));
  // Poll: readback returns the LAST rendered accumulator, so an immediate
  // read races the post-edit frame (same reason the paint assertion above
  // polls).
  await expect.poll(async () => closeTo(await centreFloat(page), FG)).toBe(true); // painted centre now HIDDEN -> keeps fg
  expect(closeTo(await edgeFloat(page), BELOW)).toBe(true); // untouched edge now shows below
  await page.keyboard.press('Control+z');
  expect(await docSnapshot(page)).toBe(beforeInvert);
  await page.evaluate(() => (window as any).__gdesign.exec('layer.toggleMaskInvert')); // redo the invert for the next steps

  const beforeDisable = await docSnapshot(page);
  await page.evaluate(() => (window as any).__gdesign.exec('layer.disableMask'));
  await expect.poll(async () => closeTo(await centreFloat(page), FG)).toBe(true); // back to fully unmasked
  expect(closeTo(await edgeFloat(page), FG)).toBe(true);
  await page.keyboard.press('Control+z');
  expect(await docSnapshot(page)).toBe(beforeDisable);
  await page.evaluate(() => (window as any).__gdesign.exec('layer.disableMask'));

  const beforeRemove = await docSnapshot(page);
  await page.evaluate(() => (window as any).__gdesign.exec('layer.removeMask'));
  const hasMask = await page.evaluate(() => !!(window as any).__gdesign.doc().layers.find((l: any) => l.id === 'fg')?.mask);
  expect(hasMask).toBe(false);
  expect(closeTo(await centreFloat(page), FG)).toBe(true);
  await page.keyboard.press('Control+z');
  expect(await docSnapshot(page)).toBe(beforeRemove);
});

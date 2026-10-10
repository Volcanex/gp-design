import { test, expect } from '@playwright/test';

/**
 * Self-contained: docs are constructed inline in page.evaluate against
 * window.__engineTest.host (loaded via engine-test.html, see test-harness.ts).
 * LayerId/ObjectId etc. are branded strings (`s as LayerId`), so plain string
 * literals work fine at runtime. Assert only via host.readback, per CLAUDE.md.
 */

function soloLayerDoc(colorLab: [number, number, number, number], pass: string, params: Record<string, unknown>) {
  return {
    version: 1,
    canvas: { width: 8, height: 8, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [
      {
        id: 'l1',
        kind: 'layer',
        name: 'solo',
        enabled: true,
        source: { type: 'core.solid', params: { color: colorLab } },
        chain: [{ id: 'fx1', pass, params, enabled: true }],
        blendMode: 'normal',
        opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'live',
      },
    ],
    postChain: [],
    assets: {},
  };
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

test.describe('look passes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
  });

  test('core.invert: L -> 1-L, a/b negated', async ({ page }) => {
    const grey: [number, number, number, number] = [0.4, 0.1, -0.05, 1];
    await page.evaluate(async (doc) => {
      await window.__engineTest!.host.loadDocument(doc as never);
    }, soloLayerDoc(grey, 'core.invert', {}));

    const px = await readCentre(page);
    expect(px[0]).toBeCloseTo(1 - grey[0], 2);
    expect(px[1]).toBeCloseTo(-grey[1], 2);
    expect(px[2]).toBeCloseTo(-grey[2], 2);
    expect(px[3]).toBeCloseTo(1, 2);
  });

  test('core.brightness-contrast: +0.2 brightness shifts L up by 0.2', async ({ page }) => {
    const grey: [number, number, number, number] = [0.4, 0, 0, 1];
    await page.evaluate(async (doc) => {
      await window.__engineTest!.host.loadDocument(doc as never);
    }, soloLayerDoc(grey, 'core.brightness-contrast', { brightness: 0.2, contrast: 0 }));

    const px = await readCentre(page);
    expect(px[0]).toBeCloseTo(0.6, 2);
  });

  test('core.palette-map: count 2 black/white maps mid-grey 0.6 to white', async ({ page }) => {
    const grey: [number, number, number, number] = [0.6, 0, 0, 1];
    await page.evaluate(async (doc) => {
      await window.__engineTest!.host.loadDocument(doc as never);
    }, soloLayerDoc(grey, 'core.palette-map', { count: 2 }));

    const px = await readCentre(page);
    expect(px[0]).toBeCloseTo(1, 2);
    expect(px[1]).toBeCloseTo(0, 2);
    expect(px[2]).toBeCloseTo(0, 2);
  });
});

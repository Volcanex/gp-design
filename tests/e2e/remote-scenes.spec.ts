/**
 * Live-link smoke: boot must dynamically import scenes.mjs from
 * render.gabrielpenman.com and register render.* sources, and a
 * render.raymarch layer must actually draw (WebGL canvas -> OKLab pipeline).
 * Needs outbound network to render.gabrielpenman.com. If that service is
 * down this spec fails while the rest of the suite (and the app) carry on;
 * that asymmetry is the point of the fail-soft contract.
 */

import { test, expect } from '@playwright/test';

test('registers remote render scenes at boot and renders one', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__gdesign?.ready === true, { timeout: 30_000 });

  const ids = await page.evaluate(() =>
    (window as any).__gdesign.engine.listSources().map((s: { id: string }) => s.id),
  );
  expect(ids).toContain('render.raymarch');

  const readback = await page.evaluate(async () => {
    const gd = (window as any).__gdesign;
    gd.engine.applyEdits([
      {
        op: 'addLayer',
        parent: null,
        index: 2,
        layer: {
          id: 'e2e-raymarch',
          kind: 'layer',
          name: 'Raymarch',
          enabled: true,
          source: { type: 'render.raymarch', params: {} },
          chain: [],
          blendMode: 'normal',
          opacity: 1,
          transform: { translate: [0, 0], scale: [1, 1], rotate: 0 },
          liveness: 'live',
        },
      },
    ]);
    // First render lazily boots the WebGL scene; render a couple of frames so
    // the canvas has real content before reading back.
    gd.engine.requestFrame();
    gd.engine.requestFrame();
    const result = await gd.engine.readback({ via: 'quantised' });
    const bytes = new Uint8Array(result.data);
    const distinct = new Set<number>();
    for (let i = 0; i < bytes.length; i += 1) distinct.add(bytes[i]!);
    return { width: result.width, height: result.height, distinct: distinct.size };
  });

  expect(readback.width).toBeGreaterThan(0);
  // A raymarched world on top of the starter doc is many-valued; a failed
  // upload (silent black) or placeholder would collapse toward a handful.
  expect(readback.distinct).toBeGreaterThan(16);
});

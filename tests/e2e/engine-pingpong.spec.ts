import { test, expect } from '@playwright/test';
import type { DocumentJSON } from '../../src/engine/doc/json';

/**
 * One layer, chain of TWO core.exposure{1} effects. Each multiplies L by
 * 2^0.5, so the pair multiplies L by 2 total: proves runChain actually
 * ping-pongs through both passes rather than aliasing/short-circuiting.
 */
test('engine ping-pong: two exposure passes multiply L by 2 total', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
  });

  const doc: DocumentJSON = {
    version: 1,
    canvas: { width: 64, height: 64, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [
      {
        id: 'l1' as unknown as DocumentJSON['layers'][number]['id'],
        kind: 'layer',
        name: 'PingPong',
        enabled: true,
        source: { type: 'core.solid', params: { color: [0.5, 0, 0, 1] } },
        chain: [
          { id: 'fx1', pass: 'core.exposure', params: { exposure: 1 }, enabled: true },
          { id: 'fx2', pass: 'core.exposure', params: { exposure: 1 }, enabled: true },
        ],
        blendMode: 'normal',
        opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'live',
      },
    ],
    postChain: [],
    assets: {},
  };

  await page.evaluate(async (d) => {
    await window.__engineTest!.host.loadDocument(d);
  }, doc);

  const result = await page.evaluate(async () => {
    const r = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
  });

  const cx = Math.floor(result.width / 2);
  const cy = Math.floor(result.height / 2);
  const idx = (cy * result.width + cx) * 4;

  expect(result.data[idx]).toBeCloseTo(0.5 * 2, 1);
});

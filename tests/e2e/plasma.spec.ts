import { test, expect } from '@playwright/test';

/**
 * core.plasma must actually animate: with a nonzero `speed`, the trig field
 * at t=0 and t=1 should differ meaningfully at the centre pixel. This is a
 * live source (liveByDefault: true), so a plain readback at time 0 followed
 * by a clock seek to t=1 is enough to exercise engine.time end to end.
 */
test('plasma: animates over time', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
    await window.__engineTest!.loadPlasma();
  });

  const at0 = await page.evaluate(async () => {
    const r = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
  });

  await page.evaluate(() => {
    window.__engineTest!.host.setClock({ cmd: 'seek', time: 1 });
  });

  const at1 = await page.evaluate(async () => {
    const r = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
  });

  // Average the L/a/b delta over a handful of sample points rather than a
  // single pixel, so the assertion isn't sensitive to any one point's phase
  // in the trig field landing near a coincidental match between t=0 and t=1.
  const samples: [number, number][] = [
    [32, 32], [16, 16], [48, 16], [16, 48], [48, 48],
  ];
  let totalDelta = 0;
  for (const [x, y] of samples) {
    const idx = (y * at0.width + x) * 4;
    const px0 = at0.data.slice(idx, idx + 4);
    const px1 = at1.data.slice(idx, idx + 4);
    expect(px0[3]).toBeCloseTo(1, 2); // plasma always writes alpha 1
    expect(px1[3]).toBeCloseTo(1, 2);
    totalDelta += Math.abs(px0[0]! - px1[0]!) + Math.abs(px0[1]! - px1[1]!) + Math.abs(px0[2]! - px1[2]!);
  }
  expect(totalDelta / samples.length).toBeGreaterThan(0.05);
});

import { test, expect } from '@playwright/test';

/**
 * core.text over a dark solid background. "HI" at a large size with a
 * bright OKLab fill: sample a pixel expected to sit inside a glyph stroke
 * (should read close to the text color), a pixel far from any glyph
 * (should read close to the background), and don't over-assert on the
 * exact antialiased edge: MSDF + SwiftShader softness gets generous
 * tolerances.
 */
test('core.text: glyph interior matches fill color, far background untouched', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
  });

  const bg: [number, number, number, number] = [0.2, 0, 0, 1];
  const color: [number, number, number, number] = [0.9, 0, 0, 1];

  await page.evaluate(
    async ({ bg, color }) => {
      await window.__engineTest!.loadText('HI', { size: 48, x: 4, y: 4, bg, color });
    },
    { bg, color },
  );

  const float = await page.evaluate(async () => {
    const r = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
  });

  const pixelAt = (x: number, y: number) => {
    const idx = (y * float.width + x) * 4;
    return float.data.slice(idx, idx + 4);
  };

  // 'H' at size 48 starting near x=4,y=4 has a solid left vertical stroke
  // spanning roughly x=8..11. Sample its center, well inside the glyph body.
  const insideGlyph = pixelAt(9, 30);
  expect(insideGlyph[0]).toBeCloseTo(color[0], 1);
  expect(insideGlyph[1]).toBeCloseTo(color[1], 1);
  expect(insideGlyph[2]).toBeCloseTo(color[2], 1);
  expect(insideGlyph[3]!).toBeGreaterThan(0.7);

  // Far corner, well outside any glyph's bounding box: pure background.
  const farBackground = pixelAt(float.width - 4, float.height - 4);
  expect(farBackground[0]).toBeCloseTo(bg[0], 1);
  expect(farBackground[1]).toBeCloseTo(bg[1], 1);
  expect(farBackground[2]).toBeCloseTo(bg[2], 1);
});

test('core.text: empty string renders only the background (no residual quads)', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
  });

  const bg: [number, number, number, number] = [0.3, 0, 0, 1];
  await page.evaluate(async ({ bg }) => {
    await window.__engineTest!.loadText('', { bg });
  }, { bg });

  const float = await page.evaluate(async () => {
    const r = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
  });
  const cx = Math.floor(float.width / 2);
  const cy = Math.floor(float.height / 2);
  const idx = (cy * float.width + cx) * 4;
  const px = float.data.slice(idx, idx + 4);
  expect(px[0]).toBeCloseTo(bg[0], 1);
  expect(px[1]).toBeCloseTo(bg[1], 1);
  expect(px[2]).toBeCloseTo(bg[2], 1);
});

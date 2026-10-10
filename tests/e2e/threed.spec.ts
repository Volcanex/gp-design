import { test, expect } from '@playwright/test';

/**
 * core.3d: a 3D scene rendered as a flat Source. Depth is internal to the
 * source (own depth24plus texture) and never leaves it: the compositor
 * only ever sees a flat OKLab+alpha buffer, so these tests only ever read
 * back colour, never depth.
 */

async function readFloat(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const r = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
  });
}

test('core.3d: cube at t=0 (centre is opaque mesh, far corner is transparent background)', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
    await window.__engineTest!.loadThreeD({ model: 'cube', spin: 0 });
  });

  const float = await readFloat(page);
  const cx = Math.floor(float.width / 2);
  const cy = Math.floor(float.height / 2);
  const centreIdx = (cy * float.width + cx) * 4;
  expect(float.data[centreIdx + 3]).toBeGreaterThan(0.9);

  const cornerIdx = (2 * float.width + 2) * 4;
  expect(float.data[cornerIdx + 3]).toBeCloseTo(0, 2);
});

test('core.3d: spin animates the render (t=0 vs t=0.4 differ)', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
    await window.__engineTest!.loadThreeD({ model: 'cube', spin: 0.5 });
  });

  const at0 = await readFloat(page);

  await page.evaluate(() => {
    window.__engineTest!.host.setClock({ cmd: 'seek', time: 0.4 });
  });
  const at04 = await readFloat(page);

  // Average delta over several points spanning the mesh footprint, so the
  // assertion isn't sensitive to any single sample landing on a face that
  // happens to look the same at both rotations.
  const samples: [number, number][] = [
    [32, 32], [24, 24], [40, 24], [24, 40], [40, 40], [20, 32], [44, 32],
  ];
  let totalDelta = 0;
  for (const [x, y] of samples) {
    const idx = (y * at0.width + x) * 4;
    totalDelta += Math.abs(at0.data[idx]! - at04.data[idx]!)
      + Math.abs(at0.data[idx + 1]! - at04.data[idx + 1]!)
      + Math.abs(at0.data[idx + 2]! - at04.data[idx + 2]!)
      + Math.abs(at0.data[idx + 3]! - at04.data[idx + 3]!);
  }
  expect(totalDelta / samples.length).toBeGreaterThan(0.02);
});

test('core.3d: [core.dither levels=4] in the layer chain quantises L to a small discrete set', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
    await window.__engineTest!.loadThreeD({
      model: 'cube',
      spin: 0,
      chain: [{ pass: 'core.dither', params: { levels: 4, amount: 0 } }],
    });
  });

  const float = await readFloat(page);
  // floor(L*4)/4 lands on one of these rungs (levels=4); amount:0 removes
  // the dither-noise perturbation so every pixel sits exactly on a rung
  // (modulo float16 rounding / bilinear edge softness, hence the tolerance).
  const rungs = [0, 0.25, 0.5, 0.75, 1];
  let checked = 0;
  for (let y = 0; y < float.height; y += 4) {
    for (let x = 0; x < float.width; x += 4) {
      const idx = (y * float.width + x) * 4;
      const alpha = float.data[idx + 3]!;
      if (alpha < 0.9) continue; // background / edge antialiasing, skip
      const l = float.data[idx]!;
      const nearestRung = rungs.reduce((a, b) => (Math.abs(b - l) < Math.abs(a - l) ? b : a));
      expect(Math.abs(l - nearestRung)).toBeLessThan(0.05);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});

test('core.3d: torus depth (the near tube wall occludes the far tube wall)', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
    // Light aimed straight down the view axis: front-facing tube surface
    // (normal.z > 0) always has ndl > 0 -> full colorA (bright), and by the
    // torus parametrisation z = r*sin(phi) IS the camera-space depth axis
    // (camera sits on +Z looking at the origin), so "front-facing" and
    // "nearer the camera" are the same condition for every point on the
    // ring. If depth testing in the source's own pipeline were broken, some
    // visible pixels would instead show the far (dark, colorB) wall.
    await window.__engineTest!.loadThreeD({
      model: 'torus',
      spin: 0,
      light: [0, 0, 1],
      colorA: [0.9, 0, 0, 1],
      colorB: [0.1, 0, 0, 1],
    });
  });

  const float = await readFloat(page);
  let checked = 0;
  for (let y = 0; y < float.height; y++) {
    for (let x = 0; x < float.width; x++) {
      const idx = (y * float.width + x) * 4;
      const alpha = float.data[idx + 3]!;
      if (alpha < 0.95) continue;
      const l = float.data[idx]!;
      // Correct depth test => near (lit) wall visible => L close to colorA
      // (0.9), never anywhere near colorB (0.1).
      expect(l).toBeGreaterThan(0.5);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});

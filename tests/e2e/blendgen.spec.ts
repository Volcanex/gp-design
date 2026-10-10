import { test, expect } from '@playwright/test';

/**
 * Wave 4 blends + generative sources (see src/engine/CLAUDE.md's blend
 * inventory and core.feedback/backdrop-contract notes). Blend assertions
 * mirror each WGSL `fn blend` in registry/builtins.ts exactly in JS, then
 * compare against the engine's own readback at the centre pixel: both
 * solid layers are full-canvas and opaque, so porter_duff_over degenerates
 * to "just src" and the composite equals blend(base, src) directly.
 */

async function readFloat(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const r = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
  });
}

function centrePixel(float: { width: number; height: number; data: number[] }): [number, number, number, number] {
  const cx = Math.floor(float.width / 2);
  const cy = Math.floor(float.height / 2);
  const idx = (cy * float.width + cx) * 4;
  return [float.data[idx]!, float.data[idx + 1]!, float.data[idx + 2]!, float.data[idx + 3]!];
}

type Lab = [number, number, number, number]; // L, a, b, alpha

const softLightD = (x: number): number => (x <= 0.25 ? ((16 * x - 12) * x + 4) * x : Math.sqrt(x));

const BLEND_MATH: Record<string, (base: Lab, src: Lab) => [number, number, number]> = {
  screen: (base, src) => {
    const l = 1 - (1 - base[0]) * (1 - src[0]);
    const t = Math.min(Math.max(src[0], 0), 1);
    return [l, base[1] + (src[1] - base[1]) * t, base[2] + (src[2] - base[2]) * t];
  },
  overlay: (base, src) => {
    const l = base[0] < 0.5 ? 2 * base[0] * src[0] : 1 - 2 * (1 - base[0]) * (1 - src[0]);
    return [l, (base[1] + src[1]) / 2, (base[2] + src[2]) / 2];
  },
  'soft-light': (base, src) => {
    const cb = base[0];
    const cs = src[0];
    const l = cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (softLightD(cb) - cb);
    return [l, (base[1] + src[1]) / 2, (base[2] + src[2]) / 2];
  },
  difference: (base, src) => {
    const clampAb = (v: number) => Math.min(Math.max(v, -0.4), 0.4);
    return [Math.abs(base[0] - src[0]), clampAb(base[1] - src[1]), clampAb(base[2] - src[2])];
  },
  color: (base, src) => [base[0], src[1], src[2]],
  luminosity: (base, src) => [src[0], base[1], base[2]],
  hue: (base, src) => {
    const baseChroma = Math.hypot(base[1], base[2]);
    const srcAngle = Math.atan2(src[2], src[1]);
    return [base[0], Math.cos(srcAngle) * baseChroma, Math.sin(srcAngle) * baseChroma];
  },
  saturation: (base, src) => {
    const srcChroma = Math.hypot(src[1], src[2]);
    const baseAngle = Math.atan2(base[2], base[1]);
    return [base[0], Math.cos(baseAngle) * srcChroma, Math.sin(baseAngle) * srcChroma];
  },
};

const BASE: Lab = [0.4, 0.08, -0.06, 1];
const SRC: Lab = [0.7, -0.1, 0.12, 1];

for (const [mode, math] of Object.entries(BLEND_MATH)) {
  test(`blend '${mode}': composite centre pixel matches CPU-mirrored formula`, async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
    await page.evaluate(
      async ({ mode, base, src }) => {
        await window.__engineTest!.loadBlendTest(mode, base as [number, number, number, number], src as [number, number, number, number]);
      },
      { mode, base: BASE, src: SRC },
    );

    const float = await readFloat(page);
    const [l, a, b, alpha] = centrePixel(float);
    const [expL, expA, expB] = math(BASE, SRC);

    expect(alpha).toBeCloseTo(1, 2);
    expect(l).toBeCloseTo(expL, 2);
    expect(a).toBeCloseTo(expA, 2);
    expect(b).toBeCloseTo(expB, 2);
  });
}

test('noise: two distinct pixels in the same frame differ', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
    await window.__engineTest!.loadNoise({ mode: 'fbm', scale: 6, speed: 0, seed: 3 });
  });
  const float = await readFloat(page);
  const idxA = (10 * float.width + 10) * 4;
  const idxB = (40 * float.width + 50) * 4;
  const deltaL = Math.abs(float.data[idxA]! - float.data[idxB]!);
  expect(deltaL).toBeGreaterThan(0.02);
});

test('noise: same seed + time reproducible across two loads', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
    await window.__engineTest!.loadNoise({ mode: 'fbm', scale: 6, speed: 0, seed: 7 });
  });
  const first = await readFloat(page);

  await page.evaluate(async () => {
    await window.__engineTest!.loadNoise({ mode: 'fbm', scale: 6, speed: 0, seed: 7 });
  });
  const second = await readFloat(page);

  expect(second.data).toEqual(first.data);
});

test('noise: a different seed produces a visibly different field at the same time', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
    await window.__engineTest!.loadNoise({ mode: 'fbm', scale: 6, speed: 0, seed: 1 });
  });
  const seedA = await readFloat(page);

  await page.evaluate(async () => {
    await window.__engineTest!.loadNoise({ mode: 'fbm', scale: 6, speed: 0, seed: 99 });
  });
  const seedB = await readFloat(page);

  let totalDelta = 0;
  for (let i = 0; i < seedA.data.length; i += 4) {
    totalDelta += Math.abs(seedA.data[i]! - seedB.data[i]!);
  }
  expect(totalDelta / (seedA.data.length / 4)).toBeGreaterThan(0.02);
});

/**
 * core.feedback accumulation/decay proof, now backed by the wantsBackdrop/
 * setBackdrop wiring (sources/source.ts + core/engine.ts's renderNodes,
 * 2026-07-07 architect-approved additive diff): the feedback layer
 * genuinely composites the base layer's content each frame now.
 *
 * Tracked quantity is PREMULTIPLIED brightness (`L * alpha`), not raw
 * straight-alpha `L`, and the base layer's opacity is deliberately < 1.
 * Two things fall out of straight-alpha/Porter-Duff semantics that make the
 * naive "readback L" version of this test meaningless: (1) a base layer at
 * full opacity (alpha=1) overwrites the feedback trail's memory every
 * single frame (`over` degenerates to exactly `src` when `src.a`=1), so
 * there's nothing to accumulate, hence baseOpacity < 1 here; (2) even with
 * partial opacity, straight-alpha `over` reproduces the backdrop's exact L
 * from frame one regardless of alpha (alpha only matters once something
 * ELSE is composited underneath), so raw `L` stays flat at the base's L
 * throughout and never "increases". What genuinely increases is the
 * trail's accumulating alpha, which is exactly what a viewer would see as
 * increasing brightness once presented against a transparent/black
 * canvas, i.e. `L * alpha`. See feedback.ts's module doc comment for why
 * `fade` decays alpha only (not L) to make this work.
 */
test('feedback: accumulates while the base layer is present, decays after it is removed', async ({ page }) => {
  await page.goto('/engine-test.html');
  const { baseLayer } = await page.evaluate(async () => {
    await window.__engineTest!.ready;
    return window.__engineTest!.loadFeedback({ base: [0.8, 0, 0, 1], baseOpacity: 0.5, zoom: 1.0, fade: 0.8 });
  });

  const visualL = (float: { width: number; height: number; data: number[] }): number => {
    const [l, , , alpha] = centrePixel(float);
    return l * alpha;
  };

  const samples: number[] = [];
  for (let frame = 1; frame <= 3; frame++) {
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate((t) => window.__engineTest!.host.setClock({ cmd: 'seek', time: t }), frame * 0.1);
    // eslint-disable-next-line no-await-in-loop
    const float = await readFloat(page);
    samples.push(visualL(float));
  }
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i]!).toBeGreaterThan(samples[i - 1]!);
  }
  // Approaches (never overshoots) the base's own L=0.8 as the trail's alpha saturates toward 1.
  expect(samples[samples.length - 1]!).toBeLessThanOrEqual(0.8 + 1e-3);

  await page.evaluate((id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.__engineTest!.host.applyEdits([{ op: 'removeLayer', id: id as any }]);
  }, baseLayer);

  const decaySamples: number[] = [];
  for (let frame = 4; frame <= 6; frame++) {
    // eslint-disable-next-line no-await-in-loop
    await page.evaluate((t) => window.__engineTest!.host.setClock({ cmd: 'seek', time: t }), frame * 0.1);
    // eslint-disable-next-line no-await-in-loop
    const float = await readFloat(page);
    decaySamples.push(visualL(float));
  }
  for (let i = 1; i < decaySamples.length; i++) {
    expect(decaySamples[i]!).toBeLessThan(decaySamples[i - 1]!);
  }
});

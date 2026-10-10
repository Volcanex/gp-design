import { test, expect } from '@playwright/test';

/**
 * Follows look.spec.ts/plasma.spec.ts patterns: docs constructed inline
 * against window.__engineTest.host, assertions via host.readback only
 * (never screenshots: SwiftShader has no real display).
 *
 * Where a pass needs spatial variance (pixelate, edge-detect) the source is
 * core.gradient, not core.solid, since a flat fill can't exercise per-pixel
 * cell/edge behaviour. Temporal variance (scanlines, grain) uses host's
 * clock seek, mirroring plasma.spec.ts.
 *
 * core.gradient's params are `fromPt`/`toPt`, not `from`/`to`: the latter
 * are reserved WGSL words and silently render black; see
 * src/engine/sources/builtin/gradient.ts and tests/unit/registries.test.ts's
 * reserved-word guard.
 */

function soloLayerDoc(
  source: { type: string; params: Record<string, unknown> },
  chain: { pass: string; params: Record<string, unknown> }[],
  size = 64,
) {
  return {
    version: 1,
    canvas: { width: size, height: size, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [
      {
        id: 'l1',
        kind: 'layer',
        name: 'solo',
        enabled: true,
        source,
        chain: chain.map((c, i) => ({ id: `fx${i}`, pass: c.pass, params: c.params, enabled: true })),
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

function solidSource(color: [number, number, number, number]) {
  return { type: 'core.solid', params: { color } };
}

/** Near-hard step at x=0.5 in doc-uv space: `fromPt`/`toPt` a hair apart so
 * the whole ramp collapses into ~1px, giving edge-detect a real edge to find. */
function stepGradientSource(colorA: [number, number, number, number], colorB: [number, number, number, number]) {
  return {
    type: 'core.gradient',
    params: { fromPt: [0.499, 0.5], toPt: [0.501, 0.5], colorA, colorB, gradType: 'linear' },
  };
}

async function readFloat(page: import('@playwright/test').Page) {
  const r = await page.evaluate(async () => {
    const res = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: res.width, height: res.height, data: Array.from(new Float32Array(res.data)) };
  });
  return r;
}

function pixelAt(r: { width: number; data: number[] }, x: number, y: number) {
  const idx = (y * r.width + x) * 4;
  return r.data.slice(idx, idx + 4);
}

test.describe('FX-STYLIZE builtins', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
  });

  test('core.vignette: corner L darker than centre L on a flat source', async ({ page }) => {
    const doc = soloLayerDoc(solidSource([0.6, 0, 0, 1]), [
      { pass: 'core.vignette', params: { amount: 1, radius: 0.6, softness: 0.3, roundness: 1, center: [0.5, 0.5] } },
    ]);
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);
    const r = await readFloat(page);
    const centre = pixelAt(r, Math.floor(r.width / 2), Math.floor(r.height / 2));
    const corner = pixelAt(r, 1, 1);
    expect(corner[0]!).toBeLessThan(centre[0]!);
  });

  test('core.pixelate: two nearby pixels inside one cell are identical', async ({ page }) => {
    const doc = soloLayerDoc(
      { type: 'core.gradient', params: { fromPt: [0, 0], toPt: [1, 1], colorA: [0.2, 0.1, -0.1, 1], colorB: [0.9, -0.1, 0.1, 1], gradType: 'linear' } },
      [{ pass: 'core.pixelate', params: { cellSize: 16 } }],
    );
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);
    const r = await readFloat(page);
    // Cell [0,16) spans pixels 0..15 in both axes at cellSize 16 on a 64px doc.
    const a = pixelAt(r, 2, 2);
    const b = pixelAt(r, 9, 11);
    expect(a[0]).toBeCloseTo(b[0]!, 5);
    expect(a[1]).toBeCloseTo(b[1]!, 5);
    expect(a[2]).toBeCloseTo(b[2]!, 5);
  });

  test('core.scanlines: animates over time at nonzero speed', async ({ page }) => {
    const doc = soloLayerDoc(solidSource([0.5, 0, 0, 1]), [
      { pass: 'core.scanlines', params: { frequency: 20, intensity: 0.8, speed: 8, hardness: 0.5 } },
    ]);
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);
    const at0 = await readFloat(page);
    await page.evaluate(() => { window.__engineTest!.host.setClock({ cmd: 'seek', time: 1 }); });
    const at1 = await readFloat(page);

    let totalDelta = 0;
    const samples: [number, number][] = [[8, 8], [8, 32], [8, 56], [32, 16], [32, 48]];
    for (const [x, y] of samples) {
      const p0 = pixelAt(at0, x, y);
      const p1 = pixelAt(at1, x, y);
      totalDelta += Math.abs(p0[0]! - p1[0]!);
    }
    expect(totalDelta / samples.length).toBeGreaterThan(0.01);
  });

  test('core.halftone: darker source region gets larger dot coverage (lower L) than lighter region', async ({ page }) => {
    const doc = soloLayerDoc(
      { type: 'core.gradient', params: { fromPt: [0, 0.5], toPt: [1, 0.5], colorA: [0.15, 0, 0, 1], colorB: [0.9, 0, 0, 1], gradType: 'linear' } },
      [{ pass: 'core.halftone', params: { cellSize: 8, angle: 0, mode: 'dots', softness: 0.05 } }],
    );
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);
    const r = await readFloat(page);
    // Average L over a strip near the dark end vs the light end of the gradient.
    let darkSum = 0, lightSum = 0, n = 0;
    for (let y = 0; y < r.height; y += 4) {
      darkSum += pixelAt(r, 4, y)[0]!;
      lightSum += pixelAt(r, r.width - 5, y)[0]!;
      n++;
    }
    expect(darkSum / n).toBeLessThan(lightSum / n);
  });

  test('core.grain: animated noise differs over time at the same pixel', async ({ page }) => {
    const doc = soloLayerDoc(solidSource([0.5, 0, 0, 1]), [
      { pass: 'core.grain', params: { amount: 0.4, size: 2, chroma: 0, animated: true } },
    ]);
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);
    const at0 = await readFloat(page);
    await page.evaluate(() => { window.__engineTest!.host.setClock({ cmd: 'seek', time: 1 }); });
    const at1 = await readFloat(page);

    let totalDelta = 0;
    const samples: [number, number][] = [[4, 4], [20, 12], [40, 30], [50, 50], [10, 55]];
    for (const [x, y] of samples) {
      totalDelta += Math.abs(pixelAt(at0, x, y)[0]! - pixelAt(at1, x, y)[0]!);
    }
    expect(totalDelta / samples.length).toBeGreaterThan(0.01);
  });

  test('core.grain: non-animated noise is identical across time', async ({ page }) => {
    const doc = soloLayerDoc(solidSource([0.5, 0, 0, 1]), [
      { pass: 'core.grain', params: { amount: 0.4, size: 2, chroma: 0, animated: false } },
    ]);
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);
    const at0 = await readFloat(page);
    await page.evaluate(() => { window.__engineTest!.host.setClock({ cmd: 'seek', time: 1 }); });
    const at1 = await readFloat(page);

    const samples: [number, number][] = [[4, 4], [20, 12], [40, 30], [50, 50], [10, 55]];
    for (const [x, y] of samples) {
      expect(pixelAt(at1, x, y)[0]).toBeCloseTo(pixelAt(at0, x, y)[0]!, 5);
    }
  });

  test('core.dither-ordered: mid-grey at levels=2 quantises to exactly the two expected L values', async ({ page }) => {
    const doc = soloLayerDoc(solidSource([0.5, 0, 0, 1]), [
      { pass: 'core.dither-ordered', params: { levels: 2, matrix: '4x4', monoOnly: true } },
    ]);
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);
    const r = await readFloat(page);

    const seen = new Set<number>();
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        seen.add(Math.round(pixelAt(r, x, y)[0]! * 1000) / 1000);
      }
    }
    // quantise_channel(x, 2) can only land on 0 or 0.5.
    expect([...seen].sort()).toEqual([0, 0.5]);
  });

  test('core.edge-detect: bright at a hard gradient step, dark in flat regions', async ({ page }) => {
    const doc = soloLayerDoc(stepGradientSource([0.1, 0, 0, 1], [0.9, 0, 0, 1]), [
      { pass: 'core.edge-detect', params: { strength: 4, mode: 'edges', invert: false } },
    ]);
    await page.evaluate(async (d) => { await window.__engineTest!.host.loadDocument(d as never); }, doc);
    const r = await readFloat(page);

    const mid = Math.floor(r.width / 2);
    const edgePixel = pixelAt(r, mid, mid)[0]!;
    const flatPixel = pixelAt(r, 4, mid)[0]!; // near-saturated colorA region, no local step
    expect(edgePixel).toBeGreaterThan(0.3);
    expect(flatPixel).toBeLessThan(0.1);
  });
});

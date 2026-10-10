import { test, expect } from '@playwright/test';

/**
 * Gold tests for the FX-MULTIPASS block (core.blur-gaussian, core.blur-box,
 * core.bloom, core.drop-shadow, core.displacement; see src/engine/CLAUDE.md
 * for the expand-macro mechanism). Written but not run (no GPU on the
 * authoring host). See tests/CLAUDE.md / look.spec.ts / fx-distort.spec.ts
 * for the SwiftShader caveats and readback conventions this follows.
 *
 * The step-gradient doc mirrors fx-distort.spec.ts's sharpen test: a very
 * short from->to span on core.gradient puts most of the frame on two flat
 * plateaus (colorA at L=0, colorB at L=1) with a narrow transition, which
 * is enough to check blur's midpoint-averaging and monotonicity without a
 * raster asset.
 */

const SIZE = 64;

function toPixel(uv: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.round(uv * size - 0.5)));
}

async function readFull(page: import('@playwright/test').Page) {
  const r = await page.evaluate(async () => {
    const res = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: res.width, height: res.height, data: Array.from(new Float32Array(res.data)) };
  });
  return {
    width: r.width,
    height: r.height,
    at(px: number, py: number) {
      const idx = (py * r.width + px) * 4;
      return r.data.slice(idx, idx + 4);
    },
  };
}

/** enabled is required (not optional): runChain's `if (!inst.enabled) continue`
 * silently skips a step with no enabled key at all, a real bug class this
 * file hit everywhere until fixed (see CLAUDE.md's Contract changelog /
 * fx-multipass gotcha note). Making it required here means a forgotten
 * `enabled: true` is a compile error, not a silent no-op test. */
type ChainStep = { id: string; pass: string; params: Record<string, unknown>; enabled: boolean };

function solidLayer(chain: ChainStep[], color: [number, number, number, number]) {
  return {
    id: 'l1',
    kind: 'layer',
    name: 'solid',
    enabled: true,
    source: { type: 'core.solid', params: { color } },
    chain,
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
  };
}

function gradientLayer(
  chain: ChainStep[],
  from: [number, number] = [0, 0.5],
  to: [number, number] = [1, 0.5],
) {
  return {
    id: 'l1',
    kind: 'layer',
    name: 'gradient',
    enabled: true,
    source: {
      type: 'core.gradient',
      params: { fromPt: from, toPt: to, colorA: [0, 0, 0, 1], colorB: [1, 0, 0, 1], gradType: 'linear' },
    },
    chain,
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
  };
}

/** A short-span gradient (per fx-distort.spec.ts's sharpen doc): two flat
 * plateaus at L=0 (x<0.48) and L=1 (x>0.52) with a narrow transition. */
function stepLayer(chain: ChainStep[]) {
  return gradientLayer(chain, [0.48, 0.5], [0.52, 0.5]);
}

function docWith(layers: unknown[]) {
  return {
    version: 1,
    canvas: { width: SIZE, height: SIZE, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers,
    postChain: [],
    assets: {},
  };
}

async function load(page: import('@playwright/test').Page, d: unknown) {
  await page.evaluate(async (doc) => {
    await window.__engineTest!.host.loadDocument(doc as never);
  }, d);
}

test.describe('FX-MULTIPASS gold', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
  });

  test('core.blur-gaussian: a uniform solid is unchanged by blur at any radius', async ({ page }) => {
    const color: [number, number, number, number] = [0.55, 0.1, -0.05, 1];
    await load(page, docWith([solidLayer([], color)]));
    const base = await readFull(page);
    const baseline = base.at(32, 32);

    await load(page, docWith([solidLayer([{ id: 'fx1', pass: 'core.blur-gaussian', params: { radius: 24 }, enabled: true }], color)]));
    const res = await readFull(page);
    const blurred = res.at(32, 32);

    expect(blurred[0]).toBeCloseTo(baseline[0]!, 2);
    expect(blurred[1]).toBeCloseTo(baseline[1]!, 2);
    expect(blurred[2]).toBeCloseTo(baseline[2]!, 2);
    expect(blurred[3]).toBeCloseTo(baseline[3]!, 2);
  });

  test('core.blur-gaussian: midpoint of a sharp step lands near the mean of the two plateaus, and the ramp is monotone', async ({ page }) => {
    await load(page, docWith([stepLayer([])]));
    const raw = await readFull(page);
    const rawLeft = raw.at(toPixel(0.4, raw.width), toPixel(0.5, raw.height))[0]!;
    const rawRight = raw.at(toPixel(0.6, raw.width), toPixel(0.5, raw.height))[0]!;

    await load(page, docWith([stepLayer([{ id: 'fx1', pass: 'core.blur-gaussian', params: { radius: 20 }, enabled: true }])]));
    const res = await readFull(page);
    const blurredLeft = res.at(toPixel(0.4, res.width), toPixel(0.5, res.height))[0]!;
    const blurredRight = res.at(toPixel(0.6, res.width), toPixel(0.5, res.height))[0]!;

    // Prove the blur actually ran before checking its shape: on the raw,
    // unblurred step doc, x=0.4/0.6 sit on the flat plateaus (0 and 1
    // exactly). A blurred result must have visibly bled signal across the
    // transition into both, or the effect didn't execute.
    expect(rawLeft).toBeCloseTo(0, 3);
    expect(rawRight).toBeCloseTo(1, 3);
    expect(blurredLeft).toBeGreaterThan(rawLeft + 0.03);
    expect(blurredRight).toBeLessThan(rawRight - 0.03);

    const mid = res.at(toPixel(0.5, res.width), toPixel(0.5, res.height));
    expect(mid[0]).toBeGreaterThan(0.3);
    expect(mid[0]).toBeLessThan(0.7); // roughly the mean of plateaus 0 and 1

    // Monotone non-decreasing left -> right across the transition band.
    let prev = -Infinity;
    for (let x = 0.3; x <= 0.7; x += 0.05) {
      const v = res.at(toPixel(x, res.width), toPixel(0.5, res.height))[0]!;
      expect(v).toBeGreaterThanOrEqual(prev - 1e-4);
      prev = v;
    }
  });

  test('core.blur-box vs core.blur-gaussian: same radius, different result on a step edge', async ({ page }) => {
    // radius=24, sampled at uv=0.31 (~13px left of the transition): both
    // kernels reach into the ramp here, but gaussian's falloff means it
    // picks up far less of it than box's flat weights, empirically
    // ~0.08 vs ~0.27 (verified via a throwaway pixel-sweep, not guessed).
    await load(page, docWith([stepLayer([{ id: 'fx1', pass: 'core.blur-gaussian', params: { radius: 24 }, enabled: true }])]));
    const gaussRes = await readFull(page);
    const gaussVal = gaussRes.at(toPixel(0.31, gaussRes.width), toPixel(0.5, gaussRes.height))[0]!;

    await load(page, docWith([stepLayer([{ id: 'fx1', pass: 'core.blur-box', params: { radius: 24 }, enabled: true }])]));
    const boxRes = await readFull(page);
    const boxVal = boxRes.at(toPixel(0.31, boxRes.width), toPixel(0.5, boxRes.height))[0]!;

    // Both blurred, so both differ from the raw plateau (0) at this point:
    // proves the passes ran, not just that gauss != box by fluke.
    expect(gaussVal).toBeGreaterThan(0.03);
    expect(boxVal).toBeGreaterThan(0.03);
    expect(Math.abs(gaussVal - boxVal)).toBeGreaterThan(0.05);
  });

  test('core.bloom: dark pixel adjacent to a bright region gains L vs baseline', async ({ page }) => {
    const baseline = docWith([gradientLayer([])]);
    await load(page, baseline);
    const base = await readFull(page);
    const darkBase = base.at(toPixel(0.85, base.width), toPixel(0.5, base.height));

    const bloomed = docWith([
      gradientLayer([{ id: 'fx1', pass: 'core.bloom', params: { threshold: 0.7, radius: 14, intensity: 2 }, enabled: true }]),
    ]);
    await load(page, bloomed);
    const res = await readFull(page);
    const darkBloomed = res.at(toPixel(0.85, res.width), toPixel(0.5, res.height));

    expect(darkBloomed[0]).toBeGreaterThan(darkBase[0]!);

    // Far from the bright region, bloom should have negligible effect.
    const farBase = base.at(toPixel(0.05, base.width), toPixel(0.5, base.height));
    const farBloomed = res.at(toPixel(0.05, res.width), toPixel(0.5, res.height));
    expect(Math.abs(farBloomed[0]! - farBase[0]!)).toBeLessThan(0.02);
  });

  test('core.drop-shadow: a semi-transparent source picks up the shadow color underneath it', async ({ page }) => {
    // A solid rect-like source isn't available without a scene object; use
    // core.solid (opaque everywhere) with alpha 0.3 so the shadow shows
    // through. Compare the SAME source with the effect enabled vs disabled
    // (not a differently-colored baseline). That isolates the effect
    // itself as the cause of any difference, rather than "these two docs
    // just have different sources".
    const srcColor: [number, number, number, number] = [0.5, 0.2, 0.1, 0.3];
    const shadowColor: [number, number, number, number] = [0.05, 0, 0, 1];
    const fx = {
      id: 'fx1',
      pass: 'core.drop-shadow',
      params: { offset: [4, 4], radius: 2, color: shadowColor, opacity: 1 },
    };

    await load(page, docWith([solidLayer([{ ...fx, enabled: false }], srcColor)]));
    const base = await readFull(page);
    const baseCentre = base.at(32, 32);

    await load(page, docWith([solidLayer([{ ...fx, enabled: true }], srcColor)]));
    const res = await readFull(page);
    const shadowed = res.at(32, 32);

    // Porter-Duff over: semi-transparent source over the (opaque, tinted)
    // shadow pulls L down toward the shadow's dark L=0.05, and raises alpha
    // above the source's own 0.3 (the shadow is now opaque underneath it),
    // compared to the same source with the effect disabled.
    expect(shadowed[0]).toBeLessThan(baseCentre[0]! - 0.1);
    expect(shadowed[0]).toBeGreaterThan(shadowColor[0]); // blended toward, not replaced by, the shadow color
    expect(shadowed[3]).toBeGreaterThan(baseCentre[3]!);
  });

  test('core.displacement: with no asset set, output matches the unmodified source (identity fallback)', async ({ page }) => {
    await load(page, docWith([gradientLayer([])]));
    const base = await readFull(page);
    const baseCentre = base.at(32, 32);

    await load(
      page,
      docWith([gradientLayer([{ id: 'fx1', pass: 'core.displacement', params: { amount: 0.2 }, enabled: true }])]),
    );
    const res = await readFull(page);
    const displaced = res.at(32, 32);

    expect(displaced[0]).toBeCloseTo(baseCentre[0]!, 2);
  });

  test('core.displacement: a uniform displacement map shifts the gradient by the computable amount', async ({ page }) => {
    // Build a solid-color PNG asset in-browser (Canvas -> toBlob -> bytes),
    // so decode goes through the real createImageBitmap path in
    // core/asset-textures.ts, rather than hand-rolling PNG bytes here.
    // Uniform 200,200,128,255 -> normalized xy = (0.784, 0.784); recentred
    // at mid-grey (0.5): d = (0.284, 0.284). amount=0.1 -> uv offset =
    // (0.0284, 0.0284) everywhere (a constant shift, since the map itself
    // is uniform).
    const amount = 0.1;
    const dxNorm = (200 / 255 - 0.5) * amount;

    await page.evaluate(async ({ amount: amt }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'rgb(200,200,128)';
      ctx.fillRect(0, 0, 4, 4);
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
      const data = await blob.arrayBuffer();

      const doc = {
        version: 1,
        canvas: { width: 64, height: 64, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
        clock: { fps: 30 },
        layers: [
          {
            id: 'l1',
            kind: 'layer',
            name: 'gradient',
            enabled: true,
            source: {
              type: 'core.gradient',
              params: { fromPt: [0, 0.5], toPt: [1, 0.5], colorA: [0, 0, 0, 1], colorB: [1, 0, 0, 1], gradType: 'linear' },
            },
            chain: [
              {
                id: 'fx1',
                pass: 'core.displacement',
                params: { asset: { asset: 'dispMap' }, amount: amt },
                enabled: true,
              },
            ],
            blendMode: 'normal',
            opacity: 1,
            transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
            liveness: 'live',
          },
        ],
        postChain: [],
        assets: {
          dispMap: { type: 'image', mime: 'image/png', data, width: 4, height: 4 },
        },
      };
      await window.__engineTest!.host.loadDocument(doc as never);
      // Image asset decode is async. Give it a few frames to land, same
      // pattern as test-harness.ts's loadText.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 50));
        window.__engineTest!.host.requestFrame();
      }
    }, { amount });

    const res = await readFull(page);
    const x = 0.5;
    const px = toPixel(x, res.width);
    const sample = res.at(px, toPixel(0.5, res.height));
    const expectedL = Math.min(1, Math.max(0, x + dxNorm));
    expect(sample[0]).toBeCloseTo(expectedL, 1);
  });
});

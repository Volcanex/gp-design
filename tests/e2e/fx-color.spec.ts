import { test, expect } from '@playwright/test';
import { linearSrgbToOklab } from '../../src/engine/color/oklab';

/**
 * Self-contained: docs are constructed inline in page.evaluate against
 * window.__engineTest.host (loaded via engine-test.html, see test-harness.ts).
 * LayerId/ObjectId etc. are branded strings (`s as LayerId`), so plain string
 * literals work fine at runtime. Assert only via host.readback, per CLAUDE.md.
 * Lifted verbatim from tests/e2e/look.spec.ts.
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

test.describe('FX-COLOR gold passes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/engine-test.html');
    await page.evaluate(async () => {
      await window.__engineTest!.ready;
    });
  });

  test('core.temperature: b += temperature*0.2*L, a += tint*0.2*L', async ({ page }) => {
    const L = 0.5, a = 0.1, b = -0.05;
    const temperature = 0.5, tint = -0.3;
    const grey: [number, number, number, number] = [L, a, b, 1];
    await page.evaluate(async (doc) => {
      await window.__engineTest!.host.loadDocument(doc as never);
    }, soloLayerDoc(grey, 'core.temperature', { temperature, tint }));

    const px = await readCentre(page);
    const expectedB = b + temperature * 0.2 * L;
    const expectedA = a + tint * 0.2 * L;
    expect(px[0]).toBeCloseTo(L, 2);
    expect(px[1]).toBeCloseTo(expectedA, 2);
    expect(px[2]).toBeCloseTo(expectedB, 2);
  });

  test('core.vibrance: ab *= (1 + vibrance*clamp(1-C/0.4,0,1)) * (1+saturation)', async ({ page }) => {
    const L = 0.6, a = 0.2, b = 0.1;
    const vibrance = 0.5, saturation = 0.2;
    const color: [number, number, number, number] = [L, a, b, 1];
    await page.evaluate(async (doc) => {
      await window.__engineTest!.host.loadDocument(doc as never);
    }, soloLayerDoc(color, 'core.vibrance', { vibrance, saturation }));

    const px = await readCentre(page);
    const c = Math.sqrt(a * a + b * b);
    const vibFactor = 1 + vibrance * Math.min(1, Math.max(0, 1 - c / 0.4));
    const satFactor = 1 + saturation;
    expect(px[0]).toBeCloseTo(L, 2);
    expect(px[1]).toBeCloseTo(a * vibFactor * satFactor, 2);
    expect(px[2]).toBeCloseTo(b * vibFactor * satFactor, 2);
  });

  test('core.gamma: L = pow(L, 1/gamma)', async ({ page }) => {
    const L = 0.25, gammaVal = 2;
    const color: [number, number, number, number] = [L, 0, 0, 1];
    await page.evaluate(async (doc) => {
      await window.__engineTest!.host.loadDocument(doc as never);
    }, soloLayerDoc(color, 'core.gamma', { gamma: gammaVal }));

    const px = await readCentre(page);
    expect(px[0]).toBeCloseTo(Math.pow(L, 1 / gammaVal), 2);
  });

  test('core.threshold: smoothstep(t-s,t+s,L), invert flips the result', async ({ page }) => {
    const L = 0.52, thresholdVal = 0.5, softness = 0.05;
    const color: [number, number, number, number] = [L, 0, 0, 1];
    await page.evaluate(async (doc) => {
      await window.__engineTest!.host.loadDocument(doc as never);
    }, soloLayerDoc(color, 'core.threshold', { threshold: thresholdVal, softness, invert: true }));

    const px = await readCentre(page);
    const t = Math.min(1, Math.max(0, (L - (thresholdVal - softness)) / (2 * softness)));
    const smooth = t * t * (3 - 2 * t);
    const expected = 1 - smooth; // invert: true
    expect(px[0]).toBeCloseTo(expected, 2);
  });

  test('core.channel-mixer: out.rgb = dot(rgb, row) + const, in RGB space (channel rotate)', async ({ page }) => {
    const rgbIn: [number, number, number] = [0.6, 0.3, 0.1];
    const inputLab = linearSrgbToOklab(rgbIn);
    const color: [number, number, number, number] = [inputLab[0], inputLab[1], inputLab[2], 1];
    await page.evaluate(async (doc) => {
      await window.__engineTest!.host.loadDocument(doc as never);
    }, soloLayerDoc(color, 'core.channel-mixer', {
      redRow: [0, 1, 0], greenRow: [0, 0, 1], blueRow: [1, 0, 0], constants: [0, 0, 0],
    }));

    const px = await readCentre(page);
    // Row-rotate: out = [g, b, r] of the input.
    const expectedRgb: [number, number, number] = [rgbIn[1], rgbIn[2], rgbIn[0]];
    const expectedLab = linearSrgbToOklab(expectedRgb);
    expect(px[0]).toBeCloseTo(expectedLab[0], 2);
    expect(px[1]).toBeCloseTo(expectedLab[1], 2);
    expect(px[2]).toBeCloseTo(expectedLab[2], 2);
  });

  test('core.duotone: lab = mix(src, mix(colorA,colorB,clamp(L+balance*0.5,0,1)), amount)', async ({ page }) => {
    const L = 0.4, a = 0.02, b = -0.01;
    const colorA: [number, number, number, number] = [0, 0, 0, 1];
    const colorB: [number, number, number, number] = [1, 0.1, 0.05, 1];
    const balance = 0.2, amount = 0.5;
    const color: [number, number, number, number] = [L, a, b, 1];
    await page.evaluate(async (doc) => {
      await window.__engineTest!.host.loadDocument(doc as never);
    }, soloLayerDoc(color, 'core.duotone', { colorA, colorB, balance, amount }));

    const px = await readCentre(page);
    const t = Math.min(1, Math.max(0, L + balance * 0.5));
    const mapped: [number, number, number] = [
      colorA[0] + (colorB[0] - colorA[0]) * t,
      colorA[1] + (colorB[1] - colorA[1]) * t,
      colorA[2] + (colorB[2] - colorA[2]) * t,
    ];
    const expected: [number, number, number] = [
      L + (mapped[0] - L) * amount,
      a + (mapped[1] - a) * amount,
      b + (mapped[2] - b) * amount,
    ];
    expect(px[0]).toBeCloseTo(expected[0], 2);
    expect(px[1]).toBeCloseTo(expected[1], 2);
    expect(px[2]).toBeCloseTo(expected[2], 2);
  });

  test('core.solarize: select(c, 1-c, c>threshold) per channel in RGB space', async ({ page }) => {
    const rgbIn: [number, number, number] = [0.3, 0.7, 0.4];
    const thresholdVal = 0.5, amount = 1;
    const inputLab = linearSrgbToOklab(rgbIn);
    const color: [number, number, number, number] = [inputLab[0], inputLab[1], inputLab[2], 1];
    await page.evaluate(async (doc) => {
      await window.__engineTest!.host.loadDocument(doc as never);
    }, soloLayerDoc(color, 'core.solarize', { threshold: thresholdVal, amount }));

    const px = await readCentre(page);
    const sol: [number, number, number] = rgbIn.map((c) => (c > thresholdVal ? 1 - c : c)) as [number, number, number];
    const expectedRgb: [number, number, number] = [
      rgbIn[0] + (sol[0] - rgbIn[0]) * amount,
      rgbIn[1] + (sol[1] - rgbIn[1]) * amount,
      rgbIn[2] + (sol[2] - rgbIn[2]) * amount,
    ];
    const expectedLab = linearSrgbToOklab(expectedRgb);
    expect(px[0]).toBeCloseTo(expectedLab[0], 2);
    expect(px[1]).toBeCloseTo(expectedLab[1], 2);
    expect(px[2]).toBeCloseTo(expectedLab[2], 2);
  });
});

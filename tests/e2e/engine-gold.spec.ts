import { test, expect } from '@playwright/test';

/**
 * Gold doc: layer1 solid red-in-OKLab + exposure{1} (L *= 2^0.5); layer2
 * solid mid-grey at opacity 0.5, blend normal. Expected centre pixel is
 * computed here in TS (the CPU mirror) and compared against both the float
 * accumulator readback and the quantised (sRGB-encoded) readback.
 */
test('engine gold: composite + exposure matches CPU mirror', async ({ page }) => {
  await page.goto('/engine-test.html');
  await page.evaluate(async () => {
    await window.__engineTest!.ready;
    await window.__engineTest!.loadGold();
  });

  const float = await page.evaluate(async () => {
    const r = await window.__engineTest!.host.readback({ via: 'float' });
    return { width: r.width, height: r.height, data: Array.from(new Float32Array(r.data)) };
  });

  const redL = 0.62796 * Math.pow(2, 1 * 0.5);
  const redA = 0.22486;
  const redB = 0.12585;
  const greyL = 0.59987;
  const opacity = 0.5;

  // layer1 over transparent black at opacity 1: out = src (normal blend passthrough)
  const afterLayer1 = [redL, redA, redB, 1];
  // layer2 (grey) over afterLayer1 at opacity 0.5
  const expected = [
    greyL * opacity + afterLayer1[0]! * (1 - opacity),
    0 * opacity + afterLayer1[1]! * (1 - opacity),
    0 * opacity + afterLayer1[2]! * (1 - opacity),
    opacity + afterLayer1[3]! * (1 - opacity),
  ];

  const cx = Math.floor(float.width / 2);
  const cy = Math.floor(float.height / 2);
  const idx = (cy * float.width + cx) * 4;
  const px = float.data.slice(idx, idx + 4);

  expect(px[0]).toBeCloseTo(expected[0]!, 2);
  expect(px[1]).toBeCloseTo(expected[1]!, 2);
  expect(px[2]).toBeCloseTo(expected[2]!, 2);
  expect(px[3]).toBeCloseTo(expected[3]!, 2);

  const quant = await page.evaluate(async () => {
    const r = await window.__engineTest!.host.readback({ via: 'quantised' });
    return { width: r.width, height: r.height, data: Array.from(new Uint8Array(r.data)) };
  });
  const qidx = (cy * quant.width + cx) * 4;
  const qpx = quant.data.slice(qidx, qidx + 4);

  function oklabToSrgb8(lab: number[]): [number, number, number] {
    const [L = 0, a = 0, b = 0] = lab;
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    const enc = (c: number) => {
      const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, v)) * 255);
    };
    return [enc(r), enc(g), enc(bb)];
  }
  const [er, eg, eb] = oklabToSrgb8(expected);

  expect(Math.abs(qpx[0]! - er)).toBeLessThanOrEqual(3);
  expect(Math.abs(qpx[1]! - eg)).toBeLessThanOrEqual(3);
  expect(Math.abs(qpx[2]! - eb)).toBeLessThanOrEqual(3);
});

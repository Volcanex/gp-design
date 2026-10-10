import { describe, it, expect } from 'vitest';
import {
  srgbEncode, srgbDecode, linearSrgbToOklab, oklabToLinearSrgb, oklabToOklch, oklchToOklab,
  oklabToSrgb8, srgb8ToOklab, linearSrgbToLinearP3, linearP3ToLinearSrgb,
} from '../../src/engine/color/oklab';

describe('sRGB gamma round-trip', () => {
  it('encode/decode are inverses', () => {
    for (const c of [0, 0.001, 0.04045, 0.2, 0.5, 0.9, 1]) {
      expect(srgbDecode(srgbEncode(c))).toBeCloseTo(c, 5);
    }
  });
});

describe('OKLab known vectors', () => {
  it('white → L≈1, a≈0, b≈0', () => {
    const [L, a, b] = linearSrgbToOklab([1, 1, 1]);
    expect(L).toBeCloseTo(1, 3);
    expect(a).toBeCloseTo(0, 3);
    expect(b).toBeCloseTo(0, 3);
  });

  it('sRGB red → L≈0.6280, a≈0.2249, b≈0.1258', () => {
    const linearRed: readonly [number, number, number] = [srgbDecode(1), srgbDecode(0), srgbDecode(0)];
    const [L, a, b] = linearSrgbToOklab(linearRed);
    expect(L).toBeCloseTo(0.6280, 3);
    expect(a).toBeCloseTo(0.2249, 3);
    expect(b).toBeCloseTo(0.1258, 3);
  });
});

describe('OKLab/OKLCh round-trip', () => {
  it('oklab -> oklch -> oklab', () => {
    const lab: readonly [number, number, number] = [0.6, 0.05, -0.08];
    const lch = oklabToOklch(lab);
    const back = oklchToOklab(lch);
    expect(back[0]).toBeCloseTo(lab[0], 5);
    expect(back[1]).toBeCloseTo(lab[1], 5);
    expect(back[2]).toBeCloseTo(lab[2], 5);
  });
});

describe('sRGB <-> OKLab round-trip', () => {
  it('linear sRGB -> OKLab -> linear sRGB within 1e-4', () => {
    const samples: (readonly [number, number, number])[] = [
      [0, 0, 0], [1, 1, 1], [0.8, 0.2, 0.1], [0.1, 0.9, 0.4], [0.5, 0.5, 0.5],
    ];
    for (const rgb of samples) {
      const lab = linearSrgbToOklab(rgb);
      const back = oklabToLinearSrgb(lab);
      expect(back[0]).toBeCloseTo(rgb[0], 4);
      expect(back[1]).toBeCloseTo(rgb[1], 4);
      expect(back[2]).toBeCloseTo(rgb[2], 4);
    }
  });

  it('8-bit sRGB -> OKLab -> 8-bit sRGB round-trips exactly (within rounding)', () => {
    const samples: (readonly [number, number, number])[] = [
      [0, 0, 0], [255, 255, 255], [200, 40, 10], [10, 200, 90], [128, 128, 128],
    ];
    for (const rgb8 of samples) {
      const lab = srgb8ToOklab(rgb8);
      const back = oklabToSrgb8(lab);
      expect(Math.abs(back[0] - rgb8[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(back[1] - rgb8[1])).toBeLessThanOrEqual(1);
      expect(Math.abs(back[2] - rgb8[2])).toBeLessThanOrEqual(1);
    }
  });
});

describe('linear sRGB <-> linear Display P3 round-trip', () => {
  it('forward then inverse recovers the original within 1e-4', () => {
    const samples: (readonly [number, number, number])[] = [
      [0, 0, 0], [1, 1, 1], [0.8, 0.2, 0.1], [0.1, 0.9, 0.4], [0.3, 0.3, 0.7],
    ];
    for (const rgb of samples) {
      const p3 = linearSrgbToLinearP3(rgb);
      const back = linearP3ToLinearSrgb(p3);
      expect(back[0]).toBeCloseTo(rgb[0], 4);
      expect(back[1]).toBeCloseTo(rgb[1], 4);
      expect(back[2]).toBeCloseTo(rgb[2], 4);
    }
  });
});

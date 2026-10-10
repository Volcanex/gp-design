import { describe, expect, it } from 'vitest';
import { strokeBounds } from '../../src/engine/sources/builtin/stroke-batch';

describe('strokeBounds', () => {
  it('returns null for no points', () => {
    expect(strokeBounds([], 16, 1280, 720)).toBeNull();
  });

  it('expands a single point by brush radius + 1px falloff, clamped to canvas', () => {
    const r = strokeBounds([{ x: 100, y: 100 }], 16, 1280, 720);
    // pad = size/2 + 1 = 9
    expect(r).toEqual({ x: 91, y: 91, width: 18, height: 18 });
  });

  it('covers every point pushed during the stroke, not just the first/last', () => {
    const points = [
      { x: 16, y: 32 },
      { x: 24, y: 32 },
      { x: 32, y: 32 },
      { x: 40, y: 32 },
      { x: 48, y: 32 },
    ];
    const r = strokeBounds(points, 16, 1280, 720)!;
    const pad = 16 / 2 + 1;
    expect(r.x).toBe(Math.max(0, Math.floor(16 - pad)));
    expect(r.y).toBe(Math.max(0, Math.floor(32 - pad)));
    expect(r.x + r.width).toBe(Math.ceil(48 + pad));
    expect(r.y + r.height).toBe(Math.ceil(32 + pad));
  });

  it('is a small fraction of a full-canvas region for a short stroke on a large canvas', () => {
    const points = [{ x: 640, y: 360 }, { x: 660, y: 360 }];
    const r = strokeBounds(points, 8, 1920, 1080)!;
    expect(r.width * r.height).toBeLessThan(1920 * 1080 * 0.01);
  });

  it('clamps to the canvas at the top-left edge', () => {
    const r = strokeBounds([{ x: 0, y: 0 }], 16, 1280, 720)!;
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.width).toBe(9); // clamped: only the right/bottom half of the pad survives
    expect(r.height).toBe(9);
  });

  it('clamps to the canvas at the bottom-right edge', () => {
    const r = strokeBounds([{ x: 1280, y: 720 }], 16, 1280, 720)!;
    expect(r.x + r.width).toBe(1280);
    expect(r.y + r.height).toBe(720);
  });

  it('returns null when the expanded box falls entirely off-canvas', () => {
    expect(strokeBounds([{ x: -1000, y: -1000 }], 8, 1280, 720)).toBeNull();
  });

  it('a wider brush produces a larger bbox for the same points', () => {
    const points = [{ x: 100, y: 100 }, { x: 120, y: 100 }];
    const small = strokeBounds(points, 4, 1280, 720)!;
    const large = strokeBounds(points, 64, 1280, 720)!;
    expect(large.width * large.height).toBeGreaterThan(small.width * small.height);
  });
});

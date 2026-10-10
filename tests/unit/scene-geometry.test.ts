import { describe, it, expect } from 'vitest';
import { shapePath, fillTriangles, strokeTriangles } from '../../src/engine/sources/builtin/scene-geometry';
import type { ShapeSpec } from '../../src/engine/doc/json';

describe('shapePath', () => {
  it('rect: four corners, closed', () => {
    const path = shapePath({ shape: 'rect', width: 100, height: 50 });
    expect(path.closed).toBe(true);
    expect(path.points).toEqual([[0, 0], [100, 0], [100, 50], [0, 50]]);
  });

  it('ellipse: 32 segments on the bounding-box ellipse, closed', () => {
    const path = shapePath({ shape: 'ellipse', width: 100, height: 60 });
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(32);
    // rightmost point (angle 0) sits at the horizontal extreme
    expect(path.points[0]![0]).toBeCloseTo(100);
    expect(path.points[0]![1]).toBeCloseTo(30);
  });

  it('line: two points, open', () => {
    const path = shapePath({ shape: 'line', width: 40, height: 4 });
    expect(path.closed).toBe(false);
    expect(path.points).toEqual([[0, 2], [40, 2]]);
  });

  it('polygon: passes through the given points verbatim, closed', () => {
    const spec: ShapeSpec = { shape: 'polygon', width: 10, height: 10, points: [[0, 0], [10, 0], [5, 10]] };
    const path = shapePath(spec);
    expect(path.closed).toBe(true);
    expect(path.points).toEqual([[0, 0], [10, 0], [5, 10]]);
  });

  it('polygon: empty points list is tolerated', () => {
    const path = shapePath({ shape: 'polygon', width: 10, height: 10 });
    expect(path.points).toEqual([]);
  });

  it('polygon: `sides` generates a regular convex n-gon when no explicit points are given', () => {
    const path = shapePath({ shape: 'polygon', width: 100, height: 100, sides: 6 });
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(6);
    // Points up (-90deg): first vertex sits at the top-centre of the box.
    expect(path.points[0]![0]).toBeCloseTo(50);
    expect(path.points[0]![1]).toBeCloseTo(0);
    expect(path.fanOrigin).toBeUndefined(); // convex: default points[0]-fan is correct
  });

  it('polygon: explicit `points` wins over `sides`', () => {
    const path = shapePath({ shape: 'polygon', width: 10, height: 10, sides: 6, points: [[0, 0], [10, 0], [5, 10]] });
    expect(path.points).toEqual([[0, 0], [10, 0], [5, 10]]);
  });

  it('star: 2*n boundary points alternating outer/inner radius, plus a centre fanOrigin', () => {
    const path = shapePath({ shape: 'star', width: 100, height: 100, starPoints: 5, innerRatio: 0.5 });
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(10);
    expect(path.fanOrigin).toEqual([50, 50]);
    // Outer tip (index 0, pointing up) sits on the full radius.
    expect(Math.hypot(path.points[0]![0] - 50, path.points[0]![1] - 50)).toBeCloseTo(50);
    // Inner notch (index 1) sits at innerRatio * radius.
    expect(Math.hypot(path.points[1]![0] - 50, path.points[1]![1] - 50)).toBeCloseTo(25);
  });

  it('rounded-rect: (segments+1)*4 boundary points, all within the box (radius clamped to half the smaller dimension)', () => {
    const path = shapePath({ shape: 'rounded-rect', width: 100, height: 60, radius: 12 });
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(9 * 4); // 8 segments + 1 endpoint, per corner
    for (const [x, y] of path.points) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(100 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(60 + 1e-9);
    }
    // Top-left corner's first point sits exactly `radius` px in from both edges
    // (the arc's 180deg start, straight left of the corner centre).
    expect(path.points[0]![0]).toBeCloseTo(0);
    expect(path.points[0]![1]).toBeCloseTo(12);
  });

  it('rounded-rect: an oversized radius clamps to half the smaller dimension, staying inside the box', () => {
    const path = shapePath({ shape: 'rounded-rect', width: 20, height: 10, radius: 999 });
    for (const [x, y] of path.points) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(20 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(10 + 1e-9);
    }
  });
});

describe('fillTriangles', () => {
  it('rect fans into 2 triangles (6 vertices)', () => {
    const path = shapePath({ shape: 'rect', width: 10, height: 10 });
    const flat = fillTriangles(path);
    expect(flat).toHaveLength(2 * 3 * 2);
  });

  it('a 2-point path (degenerate) yields no triangles', () => {
    const path = shapePath({ shape: 'line', width: 10, height: 0 });
    expect(fillTriangles(path)).toHaveLength(0);
  });

  it('star (fanOrigin set): fans a FULL loop from the centre (n boundary points -> n triangles, not n-2)', () => {
    const path = shapePath({ shape: 'star', width: 100, height: 100, starPoints: 5, innerRatio: 0.5 });
    const flat = fillTriangles(path);
    expect(flat).toHaveLength(10 * 3 * 2); // 10 boundary points -> 10 triangles
    // Every triangle's first vertex is the centre (fanOrigin), not points[0].
    for (let i = 0; i < flat.length; i += 6) {
      expect(flat[i]).toBeCloseTo(50);
      expect(flat[i + 1]).toBeCloseTo(50);
    }
  });
});

describe('strokeTriangles', () => {
  it('closed rect path yields one quad (2 triangles) per edge = 4 quads', () => {
    const path = shapePath({ shape: 'rect', width: 10, height: 10 });
    const flat = strokeTriangles(path, 2);
    expect(flat).toHaveLength(4 * 2 * 3 * 2);
  });

  it('open line path yields exactly one quad', () => {
    const path = shapePath({ shape: 'line', width: 10, height: 0 });
    const flat = strokeTriangles(path, 2);
    expect(flat).toHaveLength(2 * 3 * 2);
  });

  it('stroke quad is centred on the path (perpendicular offset = thickness/2)', () => {
    const path = { points: [[0, 0], [10, 0]] as const, closed: false };
    const flat = strokeTriangles(path, 4);
    const ys = flat.filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeCloseTo(-2);
    expect(Math.max(...ys)).toBeCloseTo(2);
  });
});

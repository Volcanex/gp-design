/**
 * Pure CPU geometry for core.scene's shape objects: no GPU, unit-testable
 * in isolation (mirrors text-layout.ts's split for core.text). A ShapeSpec
 * becomes a boundary path in local content-box space; fillTriangles() and
 * strokeTriangles() both derive from that ONE path so fill/stroke never
 * disagree about where the shape's edge is.
 *
 * Limitation: fillTriangles() fans from points[0] by default, which is only
 * correct for convex (or star-shaped-from-vertex-0) polygons: rect/ellipse/
 * regular-polygon/rounded-rect always qualify (all convex); an arbitrary
 * concave `polygon` (explicit `points`) may fill incorrectly. Documented
 * rather than fixed: proper concave triangulation (ear-clipping) is more
 * machinery than this phase needs.
 *
 * `star` is the one CONCAVE shape this file generates on purpose, and it
 * sidesteps the limitation above rather than hitting it: a regular star is
 * star-shaped about its own centre (every boundary point is in line-of-sight
 * of the centre, even into the inner notches), so ShapePath carries an
 * optional `fanOrigin`: when set, fillTriangles() fans a FULL loop from that
 * interior point instead of from points[0] on the boundary. Verified by
 * tests/e2e/shapes2.spec.ts's readback: an outer star tip reads fill colour,
 * a concave notch point reads background (would be inverted if fanned from a
 * boundary vertex instead).
 */

import type { ShapeSpec } from '../../doc/json';

export interface ShapePath {
  points: readonly (readonly [number, number])[];
  closed: boolean;
  /** When set, fillTriangles() fans a closed loop from this point instead of
   * from points[0]. See header comment (star's concave-but-star-shaped case). */
  fanOrigin?: readonly [number, number];
}

const ELLIPSE_SEGMENTS = 32;
const ROUNDED_RECT_CORNER_SEGMENTS = 8;

function regularPolygonPoints(width: number, height: number, sides: number): [number, number][] {
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2;
  const ry = height / 2;
  const n = Math.max(3, Math.floor(sides));
  const points: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    // Start pointing up (-90deg) rather than ellipse's 0deg-start convention:
    // an arbitrary but nicer-looking default orientation for n-gons.
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return points;
}

function starPoints(width: number, height: number, points: number, innerRatio: number): [number, number][] {
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2;
  const ry = height / 2;
  const n = Math.max(2, Math.floor(points)) * 2;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const r = i % 2 === 0 ? 1 : innerRatio;
    out.push([cx + rx * r * Math.cos(a), cy + ry * r * Math.sin(a)]);
  }
  return out;
}

/** Quarter-circle corner fans, `segments` steps each, arc endpoints included
 * (so straight edges need no separate points). TL, TR, BR, BL order. */
function roundedRectPoints(width: number, height: number, radius: number, segments = ROUNDED_RECT_CORNER_SEGMENTS): [number, number][] {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const corners: [number, number][] = [[r, r], [width - r, r], [width - r, height - r], [r, height - r]];
  const points: [number, number][] = [];
  for (let c = 0; c < 4; c += 1) {
    const [cx, cy] = corners[c]!;
    const startAngle = Math.PI + c * (Math.PI / 2);
    for (let s = 0; s <= segments; s += 1) {
      const a = startAngle + (s / segments) * (Math.PI / 2);
      points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return points;
}

export function shapePath(spec: ShapeSpec): ShapePath {
  switch (spec.shape) {
    case 'rect':
      return {
        points: [[0, 0], [spec.width, 0], [spec.width, spec.height], [0, spec.height]],
        closed: true,
      };
    case 'ellipse': {
      const cx = spec.width / 2;
      const cy = spec.height / 2;
      const rx = spec.width / 2;
      const ry = spec.height / 2;
      const points: [number, number][] = [];
      for (let i = 0; i < ELLIPSE_SEGMENTS; i += 1) {
        const a = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
        points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
      return { points, closed: true };
    }
    case 'line':
      return { points: [[0, spec.height / 2], [spec.width, spec.height / 2]], closed: false };
    case 'polygon':
      // Explicit points win (arbitrary/freehand outline); `sides` generates a
      // regular n-gon: convex, so the default points[0]-fan triangulates it
      // correctly (see header comment). Neither set: empty, unchanged from
      // before `sides` existed.
      if (spec.points) return { points: spec.points.map(([x, y]) => [x, y] as [number, number]), closed: true };
      if (spec.sides !== undefined) return { points: regularPolygonPoints(spec.width, spec.height, spec.sides), closed: true };
      return { points: [], closed: true };
    case 'star': {
      const points = starPoints(spec.width, spec.height, spec.starPoints ?? 5, spec.innerRatio ?? 0.5);
      const fanOrigin: [number, number] = [spec.width / 2, spec.height / 2];
      return { points, closed: true, fanOrigin };
    }
    case 'rounded-rect':
      return { points: roundedRectPoints(spec.width, spec.height, spec.radius ?? 12), closed: true };
    default:
      // ShapeSpec is a flat interface (not a discriminated union), so
      // `spec` itself doesn't narrow to `never` here even though
      // `spec.shape`'s literal union is exhausted above.
      throw new Error(`shapePath: unknown shape kind '${(spec as ShapeSpec).shape}'`);
  }
}

/** Flat (x, y) triples-of-vertices list. Fans from `path.fanOrigin` (a full
 * closed loop over every edge) when set, else from points[0] (points.length-2
 * triangles, no separate closing edge needed since points[0] is itself on the
 * boundary). See header comment for which shapes need which. Empty for <3
 * points (fanOrigin case: 0 points is degenerate too, guarded the same way). */
export function fillTriangles(path: ShapePath): number[] {
  const { points, fanOrigin } = path;
  const out: number[] = [];
  if (fanOrigin) {
    if (points.length < 3) return out;
    const [ox, oy] = fanOrigin;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      out.push(ox, oy, a[0], a[1], b[0], b[1]);
    }
    return out;
  }
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[0]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    out.push(a[0], a[1], b[0], b[1], c[0], c[1]);
  }
  return out;
}

/** Flat vertex list of quads (2 triangles each) along the path, `thickness`
 * px wide, centred on the path. Open paths (line) get segments only between
 * consecutive points; closed paths also connect the last point back to the first. */
export function strokeTriangles(path: ShapePath, thickness: number): number[] {
  const { points, closed } = path;
  const n = points.length;
  if (n < 2) return [];
  const segCount = closed ? n : n - 1;
  const out: number[] = [];
  const half = thickness / 2;
  for (let i = 0; i < segCount; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * half;
    const ny = (dx / len) * half;
    const p0: [number, number] = [a[0] + nx, a[1] + ny];
    const p1: [number, number] = [b[0] + nx, b[1] + ny];
    const p2: [number, number] = [b[0] - nx, b[1] - ny];
    const p3: [number, number] = [a[0] - nx, a[1] - ny];
    out.push(
      p0[0], p0[1], p1[0], p1[1], p2[0], p2[1],
      p0[0], p0[1], p2[0], p2[1], p3[0], p3[1],
    );
  }
  return out;
}

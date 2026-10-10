/**
 * Pure batching logic for paint-tool strokes: turns a stream of individual
 * pointer points into capsule segments to stamp. The first point of a stroke
 * has no predecessor, so it becomes a degenerate segment (a === b), a dot.
 * Kept GPU-free and side-effect-free so it's unit-testable without a device.
 */

import type { Rect } from '../../core/types';

export interface StrokeBatchPoint {
  x: number;
  y: number;
}

export interface StrokeSegment {
  a: readonly [number, number];
  b: readonly [number, number];
}

export class StrokeBatcher {
  private last: readonly [number, number] | null = null;
  private pending: StrokeSegment[] = [];

  /** Resets batching state for a new stroke. */
  begin(): void {
    this.last = null;
    this.pending = [];
  }

  push(p: StrokeBatchPoint): void {
    const cur: readonly [number, number] = [p.x, p.y];
    this.pending.push({ a: this.last ?? cur, b: cur });
    this.last = cur;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Returns and clears everything queued since the last drain (or begin). */
  drain(): StrokeSegment[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

/**
 * Bounding box of a stroke's brush footprint: every point's capsule stamp
 * (radius = brushSize/2, plus 1px for the stamp shader's antialiasing
 * falloff band; see rasterStampPass's smoothstep(r-1, r+1, d) in raster.ts),
 * clamped to the canvas. Used by endStroke to scope commitRaster to the
 * pixels actually touched instead of the whole canvas. Returns null when
 * there are no points, or when the expanded box falls entirely off-canvas:
 * both read as "this stroke touched nothing."
 */
export function strokeBounds(
  points: readonly StrokeBatchPoint[],
  brushSize: number,
  canvasWidth: number,
  canvasHeight: number,
): Rect | null {
  if (points.length === 0) return null;
  const pad = brushSize / 2 + 1;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x - pad < minX) minX = p.x - pad;
    if (p.y - pad < minY) minY = p.y - pad;
    if (p.x + pad > maxX) maxX = p.x + pad;
    if (p.y + pad > maxY) maxY = p.y + pad;
  }
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(canvasWidth, Math.ceil(maxX));
  const y1 = Math.min(canvasHeight, Math.ceil(maxY));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;
  return { x: x0, y: y0, width, height };
}

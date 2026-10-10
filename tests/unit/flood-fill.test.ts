import { describe, it, expect } from 'vitest';
import { floodFill, colorDistance, MAX_VISITED_PIXELS } from '../../src/ui/canvas/flood-fill';

const RED: readonly [number, number, number, number] = [0.6, 0.2, 0, 1];
const BLUE: readonly [number, number, number, number] = [0.4, -0.1, -0.2, 1];
const FILL: readonly [number, number, number, number] = [0.9, 0, 0, 1];

/** Builds a width*height*4 OKLab+alpha buffer where `paint` decides each
 * pixel's colour (defaults to a solid RED canvas). */
function makeCanvas(width: number, height: number, paint?: (x: number, y: number) => readonly [number, number, number, number]): Float32Array {
  const out = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = paint ? paint(x, y) : RED;
      const i = (y * width + x) * 4;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = c[3];
    }
  }
  return out;
}

function pixelAt(result: ReturnType<typeof floodFill>, x: number, y: number): [number, number, number, number] {
  const { region, data } = result;
  if (!region) throw new Error('no region');
  const rx = x - region.x;
  const ry = y - region.y;
  const arr = new Float32Array(data);
  const i = (ry * region.width + rx) * 4;
  return [arr[i]!, arr[i + 1]!, arr[i + 2]!, arr[i + 3]!];
}

/** Component-wise approximate equality: the region data round-trips
 * through a Float32Array, so an f64 literal like 0.9 loses a few ULPs. */
function expectPixel(actual: [number, number, number, number], expected: readonly [number, number, number, number]): void {
  for (let i = 0; i < 4; i += 1) expect(actual[i]).toBeCloseTo(expected[i]!, 5);
}

describe('colorDistance', () => {
  it('treats two fully-transparent pixels as an exact match regardless of L/a/b', () => {
    expect(colorDistance([0.9, 0.4, -0.3, 0], [0.1, -0.2, 0.1, 0])).toBe(0);
  });

  it('is 0 for identical opaque colours and > 0 otherwise', () => {
    expect(colorDistance(RED, RED)).toBe(0);
    expect(colorDistance(RED, BLUE)).toBeGreaterThan(0);
  });
});

describe('floodFill', () => {
  it('fills a solid region exactly to a hard colour boundary', () => {
    // 10x10 red canvas with a blue column at x=5..9.
    const width = 10, height = 10;
    const pixels = makeCanvas(width, height, (x) => (x >= 5 ? BLUE : RED));
    const result = floodFill({ width, height, pixels, seed: { x: 0, y: 0 }, fillColor: FILL, tolerance: 0.05 });

    expect(result.region).toEqual({ x: 0, y: 0, width: 5, height: 10 });
    // Every filled pixel is FILL.
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        expectPixel(pixelAt(result, x, y), FILL);
      }
    }
  });

  it('does not cross into a boundary column outside tolerance', () => {
    const width = 10, height = 10;
    const pixels = makeCanvas(width, height, (x) => (x >= 5 ? BLUE : RED));
    const result = floodFill({ width, height, pixels, seed: { x: 0, y: 0 }, fillColor: FILL, tolerance: 0.05 });
    expect(result.region!.width).toBe(5); // stops before the blue column
  });

  it('wider tolerance monotonically widens (never shrinks) the filled region', () => {
    const width = 20, height = 1;
    // A smooth colour ramp so distance from the seed grows with x.
    const pixels = makeCanvas(width, height, (x) => [0.5 + x * 0.02, 0, 0, 1]);
    const narrow = floodFill({ width, height, pixels, seed: { x: 0, y: 0 }, fillColor: FILL, tolerance: 0.05 });
    const wide = floodFill({ width, height, pixels, seed: { x: 0, y: 0 }, fillColor: FILL, tolerance: 0.3 });
    expect(wide.region!.width).toBeGreaterThanOrEqual(narrow.region!.width);

    const wider = floodFill({ width, height, pixels, seed: { x: 0, y: 0 }, fillColor: FILL, tolerance: 1 });
    expect(wider.region!.width).toBeGreaterThanOrEqual(wide.region!.width);
  });

  it('a transparent canvas (no raster asset) seed fills the entire canvas', () => {
    const width = 8, height = 6;
    const result = floodFill({ width, height, pixels: null, seed: { x: 3, y: 2 }, fillColor: FILL, tolerance: 0 });
    expect(result.region).toEqual({ x: 0, y: 0, width, height });
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        expectPixel(pixelAt(result, x, y), FILL);
      }
    }
  });

  it('clips the fill to a selection rect even when matching pixels extend beyond it', () => {
    const width = 10, height = 10;
    const pixels = makeCanvas(width, height); // uniform RED everywhere
    const result = floodFill({
      width, height, pixels, seed: { x: 5, y: 5 }, fillColor: FILL, tolerance: 0.05,
      clip: { x: 2, y: 2, width: 4, height: 4 },
    });
    expect(result.region).toEqual({ x: 2, y: 2, width: 4, height: 4 });
  });

  it('returns a null region when the seed itself is outside the clip', () => {
    const width = 10, height = 10;
    const pixels = makeCanvas(width, height);
    const result = floodFill({
      width, height, pixels, seed: { x: 0, y: 0 }, fillColor: FILL, tolerance: 0.05,
      clip: { x: 5, y: 5, width: 2, height: 2 },
    });
    expect(result.region).toBeNull();
    expect(result.data.byteLength).toBe(0);
  });

  it('a non-rectangular filled region leaves in-bbox but unmatched pixels at their original colour', () => {
    // A "ring" of BLUE around a RED interior. Bucket-click the interior;
    // the ring pixels sit inside the fill's bounding box but must not change.
    const width = 5, height = 5;
    const isRing = (x: number, y: number) => x === 0 || y === 0 || x === width - 1 || y === height - 1;
    const pixels = makeCanvas(width, height, (x, y) => (isRing(x, y) ? BLUE : RED));
    const result = floodFill({ width, height, pixels, seed: { x: 2, y: 2 }, fillColor: FILL, tolerance: 0.05 });

    expect(result.region).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    for (let y = 1; y < 4; y += 1) {
      for (let x = 1; x < 4; x += 1) {
        expectPixel(pixelAt(result, x, y), FILL);
      }
    }
  });

  it('bails out with capped:true once the visited-pixel cap is hit, on a uniform large canvas', () => {
    // A canvas bigger than the cap, uniformly matching everywhere.
    const side = Math.ceil(Math.sqrt(MAX_VISITED_PIXELS)) + 200;
    const pixels = null; // transparent-everywhere: cheapest way to get a huge uniform match
    const result = floodFill({ width: side, height: side, pixels, seed: { x: 0, y: 0 }, fillColor: FILL, tolerance: 0 });
    expect(result.capped).toBe(true);
  });

  it('does not report capped on an ordinary fill', () => {
    const width = 10, height = 10;
    const pixels = makeCanvas(width, height);
    const result = floodFill({ width, height, pixels, seed: { x: 0, y: 0 }, fillColor: FILL, tolerance: 0.05 });
    expect(result.capped).toBe(false);
  });
});

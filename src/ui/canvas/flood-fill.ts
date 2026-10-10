/**
 * Pure CPU flood-fill algorithm for the Bucket tool. No engine/DOM
 * dependency: operates on an already-decoded Float32Array of OKLab+alpha
 * pixels (raster-codec.ts's decodeRgba16f, or null for a layer with no
 * raster asset yet, which reads as an all-transparent canvas). Scanline fill
 * (not a naive one-pixel-per-queue-entry BFS) so a full-canvas fill at
 * 1280x720 stays sane; a hard visited-pixel cap bails out of runaway fills
 * (e.g. a near-uniform image at a high tolerance) rather than hanging.
 */

export interface FloodFillClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloodFillInput {
  /** Canvas/layer pixel dimensions the fill operates within. */
  width: number;
  height: number;
  /** Decoded OKLab (L, a, b) + straight alpha, row-major, 4 floats/pixel,
   * length width*height*4. Null means "no raster asset yet": every pixel
   * reads as fully transparent [0, 0, 0, 0]. */
  pixels: Float32Array | null;
  seed: { x: number; y: number };
  /** OKLab + straight alpha fill colour. */
  fillColor: readonly [number, number, number, number];
  /** Max OKLab+alpha distance from the seed's colour still counted as a match. */
  tolerance: number;
  /** Restricts the fill to this rect (e.g. an active marquee selection);
   * pixels outside it never match, regardless of colour. Defaults to the
   * full canvas. */
  clip?: FloodFillClip;
}

export interface FloodFillResult {
  /** Tight bounding box of every pixel touched by the fill, or null if the
   * seed point itself is outside the canvas/clip (nothing to do). */
  region: { x: number; y: number; width: number; height: number } | null;
  /** rgba16float bytes for exactly `region` (fillColor where matched, the
   * original pixel colour everywhere else in the bbox), ready to hand to a
   * commitRaster edit. Empty buffer when region is null. */
  data: ArrayBuffer;
  /** True if the visited-pixel cap was hit before the fill finished: the
   * result is a partial (but still internally consistent) fill. */
  capped: boolean;
}

/** Pixels visited before a fill bails out with a partial result. ~4.3x a
 * 1280x720 canvas: generous headroom for a full fill, a hard stop against
 * runaway growth on much larger documents. */
export const MAX_VISITED_PIXELS = 4_000_000;

/** A pixel is "transparent" for match purposes below this alpha. */
const ALPHA_EPSILON = 1e-3;

type Rgba = readonly [number, number, number, number];

function colorAt(pixels: Float32Array | null, width: number, x: number, y: number): Rgba {
  if (!pixels) return [0, 0, 0, 0];
  const i = (y * width + x) * 4;
  return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
}

/**
 * Weighted OKLab+alpha euclidean distance. Two fully transparent pixels
 * always match (distance 0) regardless of their L/a/b: those channels are
 * meaningless once alpha is ~0, so comparing them would make an empty
 * canvas fail to match itself.
 */
export function colorDistance(a: Rgba, b: Rgba): number {
  const aTransparent = a[3] <= ALPHA_EPSILON;
  const bTransparent = b[3] <= ALPHA_EPSILON;
  if (aTransparent && bTransparent) return 0;
  const dL = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  const dAlpha = a[3] - b[3];
  return Math.sqrt(dL * dL + da * da + db * db + dAlpha * dAlpha);
}

export function floodFill(input: FloodFillInput): FloodFillResult {
  const { width, height, pixels, seed, fillColor, tolerance } = input;
  const clip = input.clip ?? { x: 0, y: 0, width, height };
  const clipX0 = Math.max(0, Math.floor(clip.x));
  const clipY0 = Math.max(0, Math.floor(clip.y));
  const clipX1 = Math.min(width, Math.ceil(clip.x + clip.width));
  const clipY1 = Math.min(height, Math.ceil(clip.y + clip.height));

  const sx = Math.round(seed.x);
  const sy = Math.round(seed.y);
  if (sx < clipX0 || sx >= clipX1 || sy < clipY0 || sy >= clipY1) {
    return { region: null, data: new ArrayBuffer(0), capped: false };
  }

  const seedColor = colorAt(pixels, width, sx, sy);
  const filled = new Uint8Array(width * height);

  const matches = (x: number, y: number): boolean => {
    if (x < clipX0 || x >= clipX1 || y < clipY0 || y >= clipY1) return false;
    if (filled[y * width + x]) return false;
    return colorDistance(seedColor, colorAt(pixels, width, x, y)) <= tolerance;
  };

  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;
  let visited = 0;
  let capped = false;
  const stack: Array<[number, number]> = [[sx, sy]];

  outer: while (stack.length > 0) {
    const point = stack.pop()!;
    const [x, y] = point;
    if (!matches(x, y)) continue; // already filled via an earlier span on this row

    let lx = x;
    while (matches(lx - 1, y)) lx -= 1;
    let rx = x;
    while (matches(rx + 1, y)) rx += 1;

    let spanAbove = false;
    let spanBelow = false;
    for (let i = lx; i <= rx; i += 1) {
      filled[y * width + i] = 1;
      visited += 1;
      if (i < minX) minX = i;
      if (i > maxX) maxX = i;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (matches(i, y - 1)) {
        if (!spanAbove) {
          stack.push([i, y - 1]);
          spanAbove = true;
        }
      } else {
        spanAbove = false;
      }

      if (matches(i, y + 1)) {
        if (!spanBelow) {
          stack.push([i, y + 1]);
          spanBelow = true;
        }
      } else {
        spanBelow = false;
      }

      if (visited >= MAX_VISITED_PIXELS) {
        capped = true;
        console.warn(`[gdesign] bucket fill hit the ${MAX_VISITED_PIXELS}px visited cap: result is partial`);
        break outer;
      }
    }
  }

  const rw = maxX - minX + 1;
  const rh = maxY - minY + 1;
  const data = new Float32Array(rw * rh * 4);
  for (let ry = 0; ry < rh; ry += 1) {
    for (let rx2 = 0; rx2 < rw; rx2 += 1) {
      const x = minX + rx2;
      const y = minY + ry;
      const di = (ry * rw + rx2) * 4;
      const src = filled[y * width + x] ? fillColor : colorAt(pixels, width, x, y);
      data[di] = src[0];
      data[di + 1] = src[1];
      data[di + 2] = src[2];
      data[di + 3] = src[3];
    }
  }

  return {
    region: { x: minX, y: minY, width: rw, height: rh },
    data: data.buffer,
    capped,
  };
}

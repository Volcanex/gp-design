/**
 * Pure memory/decimation math for video import, split out from
 * video-import.ts so it's unit-testable without a decoder or GPU: the
 * dialog needs it synchronously (live estimate label, OK-button gating) and
 * the importer needs the exact same numbers, so there is one source of
 * truth for both.
 */

export const VIDEO_IMPORT_HARD_MAX_BYTES = 512 * 1024 * 1024;
export const VIDEO_IMPORT_MAX_RANGE_SECONDS = 8;
export const VIDEO_IMPORT_DEFAULT_RANGE_SECONDS = 4;
export const VIDEO_IMPORT_HALF_RES_THRESHOLD = 1280;

const BYTES_PER_PIXEL = 4; // rgba8unorm

/** Target fps never exceeds source fps: decimating past the source's own
 * frame rate would just repeat frames, not save memory. */
export function pickTargetFps(sourceFps: number, requestedFps: number): number {
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return Math.max(1, requestedFps);
  return Math.max(1, Math.min(requestedFps, sourceFps));
}

/** Number of baked frames a range/fps combination produces. Rounds rather
 * than floors/ceils so a range that's a hair off an exact frame boundary
 * (float duration math) doesn't silently lose or gain a frame. */
export function estimateFrameCount(fromSeconds: number, toSeconds: number, fps: number): number {
  const duration = Math.max(0, toSeconds - fromSeconds);
  return Math.max(1, Math.round(duration * fps));
}

/** Half-res is worth defaulting on above this width. Not a hard rule, just
 * the point where 1:1 baked frames start costing real memory for a clip of
 * any useful length. */
export function defaultHalfRes(sourceWidth: number): boolean {
  return sourceWidth > VIDEO_IMPORT_HALF_RES_THRESHOLD;
}

export function estimateBytes(frameCount: number, width: number, height: number): number {
  return frameCount * width * height * BYTES_PER_PIXEL;
}

export function exceedsHardBudget(bytes: number): boolean {
  return bytes > VIDEO_IMPORT_HARD_MAX_BYTES;
}

/** Presentation-timestamp decimator: given the fps a source is decoding at,
 * decides whether the sample at `timestamp` should be kept, and advances
 * the caller's cursor. Frame-accurate regardless of the source's actual
 * frame timing jitter: it always keeps the frame at or after the next
 * wanted instant, never repeats/skips based on decode order alone. */
export interface FrameDecimator {
  shouldKeep(timestamp: number): boolean;
}

// Tolerance for float error accumulated by repeated `timestamp + interval`
// arithmetic (e.g. 0.4 + 0.2 = 0.6000000000000001). Without it, a frame
// landing exactly on the wanted instant gets spuriously dropped.
const EPSILON = 1e-9;

export function createFrameDecimator(targetFps: number): FrameDecimator {
  const interval = 1 / Math.max(1, targetFps);
  let nextWanted = -Infinity;
  return {
    shouldKeep(timestamp: number): boolean {
      if (timestamp < nextWanted - EPSILON) return false;
      nextWanted = timestamp + interval;
      return true;
    },
  };
}

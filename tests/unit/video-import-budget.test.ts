import { describe, it, expect } from 'vitest';
import {
  pickTargetFps, estimateFrameCount, estimateBytes, exceedsHardBudget, defaultHalfRes,
  createFrameDecimator, VIDEO_IMPORT_HARD_MAX_BYTES, VIDEO_IMPORT_HALF_RES_THRESHOLD,
} from '../../src/app/commands/video-import-budget';

describe('video-import-budget', () => {
  describe('pickTargetFps', () => {
    it('caps the requested fps at the source fps', () => {
      expect(pickTargetFps(24, 30)).toBe(24);
    });
    it('passes through a requested fps below the source fps', () => {
      expect(pickTargetFps(60, 24)).toBe(24);
    });
    it('falls back to the requested fps when source fps is unknown/invalid', () => {
      expect(pickTargetFps(0, 30)).toBe(30);
      expect(pickTargetFps(NaN, 30)).toBe(30);
    });
  });

  describe('estimateFrameCount', () => {
    it('rounds duration * fps', () => {
      expect(estimateFrameCount(0, 2, 30)).toBe(60);
      expect(estimateFrameCount(1, 2, 30)).toBe(30);
    });
    it('never returns fewer than 1 frame for a non-empty range', () => {
      expect(estimateFrameCount(0, 0.01, 1)).toBe(1);
    });
    it('clamps a negative/inverted range to zero duration', () => {
      expect(estimateFrameCount(2, 1, 30)).toBe(1);
    });
  });

  describe('defaultHalfRes', () => {
    it('is off at/under the threshold', () => {
      expect(defaultHalfRes(VIDEO_IMPORT_HALF_RES_THRESHOLD)).toBe(false);
      expect(defaultHalfRes(1280)).toBe(false);
    });
    it('is on above the threshold', () => {
      expect(defaultHalfRes(1920)).toBe(true);
    });
  });

  describe('estimateBytes / exceedsHardBudget', () => {
    it('computes frameCount * width * height * 4', () => {
      expect(estimateBytes(10, 100, 50)).toBe(10 * 100 * 50 * 4);
    });
    it('flags exactly-at-budget as not exceeding, and one byte over as exceeding', () => {
      expect(exceedsHardBudget(VIDEO_IMPORT_HARD_MAX_BYTES)).toBe(false);
      expect(exceedsHardBudget(VIDEO_IMPORT_HARD_MAX_BYTES + 1)).toBe(true);
    });
  });

  describe('createFrameDecimator', () => {
    it('keeps the first frame and then only frames at or past each fps-spaced interval', () => {
      const decimator = createFrameDecimator(5); // 0.2s interval
      const timestamps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
      const kept = timestamps.filter((t) => decimator.shouldKeep(t));
      expect(kept).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    });
    it('keeps every frame when target fps matches source fps (no decimation)', () => {
      const decimator = createFrameDecimator(10);
      const timestamps = [0, 0.1, 0.2, 0.3];
      const kept = timestamps.filter((t) => decimator.shouldKeep(t));
      expect(kept).toEqual(timestamps);
    });
    it('does not drift when source frames arrive with jitter around the interval', () => {
      const decimator = createFrameDecimator(2); // 0.5s interval
      const timestamps = [0, 0.49, 0.51, 0.98, 1.02, 1.49];
      const kept = timestamps.filter((t) => decimator.shouldKeep(t));
      expect(kept).toEqual([0, 0.51, 1.02]);
    });
  });
});

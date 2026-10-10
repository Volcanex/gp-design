import { describe, it, expect } from 'vitest';
import {
  visibleEnd, timeToX, xToTime, quantiseToFrame, resolveTrackAt,
  trackWithKeyAt, trackWithKeyMoved, trackWithKeyRemoved, lanesFor,
} from '../../src/ui/shell/timeline-logic';
import type { Keyframe, ParamsSchema, ParamValues } from '@engine';

describe('visibleEnd', () => {
  it('floors at 2s for a brand-new doc with no duration/loop', () => {
    expect(visibleEnd(undefined, undefined)).toBe(2);
  });
  it('picks the largest of duration/loop.to/2', () => {
    expect(visibleEnd(5, 3)).toBe(5);
    expect(visibleEnd(1, 8)).toBe(8);
    expect(visibleEnd(0.5, 0.5)).toBe(2);
  });
});

describe('timeToX / xToTime', () => {
  it('are inverses across the visible range', () => {
    const width = 400;
    const end = 10;
    for (const t of [0, 1, 2.5, 10]) {
      expect(xToTime(timeToX(t, width, end), width, end)).toBeCloseTo(t, 10);
    }
  });
  it('returns 0 for a zero-width or zero-end track', () => {
    expect(timeToX(5, 0, 10)).toBe(0);
    expect(timeToX(5, 400, 0)).toBe(0);
    expect(xToTime(100, 0, 10)).toBe(0);
  });
  it('clamps xToTime to non-negative', () => {
    expect(xToTime(-50, 400, 10)).toBe(0);
  });
});

describe('quantiseToFrame', () => {
  it('snaps to the nearest frame at a given fps', () => {
    expect(quantiseToFrame(0.51, 30)).toBeCloseTo(0.5, 10);
    expect(quantiseToFrame(1.001, 24)).toBeCloseTo(1, 10);
  });
  it('passes time through unchanged for a non-positive fps', () => {
    expect(quantiseToFrame(1.2345, 0)).toBe(1.2345);
  });
});

describe('resolveTrackAt', () => {
  const track: Keyframe[] = [{ t: 0, v: 0 }, { t: 1, v: 10, ease: 'hold' }, { t: 2, v: 20 }];

  it('clamps before the first and after the last key', () => {
    expect(resolveTrackAt(track, -1)).toBe(0);
    expect(resolveTrackAt(track, 5)).toBe(20);
  });
  it('holds through a hold-eased segment', () => {
    expect(resolveTrackAt(track, 1.5)).toBe(10);
  });
  it('lerps linearly by default', () => {
    const linear: Keyframe[] = [{ t: 0, v: 0 }, { t: 2, v: 10 }];
    expect(resolveTrackAt(linear, 1)).toBe(5);
  });
  it('applies cubic smoothstep easing', () => {
    const cubic: Keyframe[] = [{ t: 0, v: 0, ease: 'cubic' }, { t: 2, v: 10 }];
    expect(resolveTrackAt(cubic, 1)).toBe(5); // smoothstep(0.5) == 0.5 exactly
    expect(resolveTrackAt(cubic, 0.5)).toBeLessThan(2.5); // eased slower than linear near the start
  });
  it('lerps arrays component-wise', () => {
    const vec: Keyframe[] = [{ t: 0, v: [0, 0, 0] }, { t: 2, v: [2, 4, 6] }];
    expect(resolveTrackAt(vec, 1)).toEqual([1, 2, 3]);
  });
  it('returns 0 for an empty track and the sole value for a single key', () => {
    expect(resolveTrackAt([], 5)).toBe(0);
    expect(resolveTrackAt([{ t: 3, v: 7 }], 100)).toBe(7);
  });
});

describe('trackWithKeyAt', () => {
  it('inserts a new key in sorted order', () => {
    const track: Keyframe[] = [{ t: 0, v: 0 }, { t: 2, v: 2 }];
    const next = trackWithKeyAt(track, 1, 1);
    expect(next.map((k) => k.t)).toEqual([0, 1, 2]);
    expect(next[1]).toEqual({ t: 1, v: 1 });
  });
  it('replaces an existing key at the exact same time, preserving its ease', () => {
    const track: Keyframe[] = [{ t: 0, v: 0 }, { t: 1, v: 5, ease: 'cubic' }];
    const next = trackWithKeyAt(track, 1, 9);
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ t: 1, v: 9, ease: 'cubic' });
  });
  it('overrides ease when explicitly given', () => {
    const track: Keyframe[] = [{ t: 1, v: 5, ease: 'cubic' }];
    const next = trackWithKeyAt(track, 1, 9, 'hold');
    expect(next[0]).toEqual({ t: 1, v: 9, ease: 'hold' });
  });
  it('does not mutate the input track', () => {
    const track: Keyframe[] = [{ t: 0, v: 0 }];
    const before = JSON.stringify(track);
    trackWithKeyAt(track, 1, 1);
    expect(JSON.stringify(track)).toBe(before);
  });
});

describe('trackWithKeyMoved', () => {
  it('retimes a key and reports its new sorted index', () => {
    const track: Keyframe[] = [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 2 }];
    const { track: next, index } = trackWithKeyMoved(track, 0, 3);
    expect(next.map((k) => k.t)).toEqual([1, 2, 3]);
    expect(index).toBe(2);
    expect(next[2]).toEqual({ t: 3, v: 0 });
  });
  it('preserves value and ease across the move', () => {
    const track: Keyframe[] = [{ t: 0, v: 42, ease: 'cubic' }, { t: 5, v: 1 }];
    const { track: next, index } = trackWithKeyMoved(track, 0, 4);
    expect(next[index]).toEqual({ t: 4, v: 42, ease: 'cubic' });
  });
  it('is a no-op for an out-of-range index', () => {
    const track: Keyframe[] = [{ t: 0, v: 0 }];
    expect(trackWithKeyMoved(track, 5, 1)).toEqual({ track, index: 5 });
  });
});

describe('trackWithKeyRemoved', () => {
  it('removes a key, keeping the rest as a track', () => {
    const track: Keyframe[] = [{ t: 0, v: 0 }, { t: 1, v: 1 }];
    expect(trackWithKeyRemoved(track, 0)).toEqual([{ t: 1, v: 1 }]);
  });
  it('collapses to the removed key\'s static scalar value when it was the last key', () => {
    const track: Keyframe[] = [{ t: 3, v: 0.75 }];
    expect(trackWithKeyRemoved(track, 0)).toBe(0.75);
  });
  it('collapses to the removed key\'s static array value when it was the last key', () => {
    const track: Keyframe[] = [{ t: 3, v: [1, 2, 3] }];
    expect(trackWithKeyRemoved(track, 0)).toEqual([1, 2, 3]);
  });
  it('is a no-op for an out-of-range index', () => {
    const track: Keyframe[] = [{ t: 0, v: 0 }];
    expect(trackWithKeyRemoved(track, 5)).toBe(track);
  });
});

describe('lanesFor', () => {
  const schema: ParamsSchema = {
    freq: { kind: 'float', default: 1, animatable: true, label: 'Frequency' },
    steady: { kind: 'float', default: 0, animatable: true, label: 'Steady' },
    color: { kind: 'color', default: [0, 0, 0, 1], animatable: true, label: 'Tint' },
    mode: { kind: 'enum', default: 'a', options: ['a', 'b'], label: 'Mode' },
  };

  it('returns one lane per param currently holding a track, skipping static/non-animatable params', () => {
    const values: ParamValues = {
      freq: { track: [{ t: 0, v: 2 }] },
      steady: 0.5,
      color: { track: [{ t: 0, v: [0, 0, 0, 1] }] },
      mode: 'a',
    };
    const lanes = lanesFor(values, schema);
    expect(lanes.map((l) => l.key)).toEqual(['freq', 'color']);
    expect(lanes[0]).toMatchObject({ key: 'freq', label: 'Frequency', kind: 'float' });
  });

  it('returns no lanes when nothing is keyframed', () => {
    expect(lanesFor({ freq: 1, steady: 0 }, schema)).toEqual([]);
  });
});

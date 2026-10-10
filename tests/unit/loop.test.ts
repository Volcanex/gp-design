import { describe, it, expect } from 'vitest';
import { wrapLoopTime } from '../../src/engine/core/loop';

describe('wrapLoopTime', () => {
  it('passes time through unchanged when no range is set', () => {
    expect(wrapLoopTime(5, undefined)).toBe(5);
  });

  it('passes time through unchanged while still inside the range', () => {
    expect(wrapLoopTime(1.5, { from: 1, to: 2 })).toBe(1.5);
  });

  it('wraps to "from" plus the overshoot once time reaches "to"', () => {
    expect(wrapLoopTime(2, { from: 1, to: 2 })).toBe(1);
    expect(wrapLoopTime(2.1, { from: 1, to: 2 })).toBeCloseTo(1.1, 10);
  });
});

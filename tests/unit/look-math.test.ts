import { describe, it, expect } from 'vitest';
import { levelsRemap, curvesRemap } from '../../src/engine/passes/builtin/look-math';

describe('levelsRemap', () => {
  it('is identity at default in/out ranges and gamma 1', () => {
    for (const l of [0, 0.25, 0.5, 0.75, 1]) {
      expect(levelsRemap(l, 0, 1, 1, 0, 1)).toBeCloseTo(l, 6);
    }
  });

  it('clamps below inBlack and above inWhite', () => {
    expect(levelsRemap(-1, 0.2, 0.8, 1, 0, 1)).toBeCloseTo(0, 6);
    expect(levelsRemap(2, 0.2, 0.8, 1, 0, 1)).toBeCloseTo(1, 6);
  });

  it('remaps out range', () => {
    expect(levelsRemap(1, 0, 1, 1, 0.2, 0.9)).toBeCloseTo(0.9, 6);
    expect(levelsRemap(0, 0, 1, 1, 0.2, 0.9)).toBeCloseTo(0.2, 6);
  });

  it('applies gamma at the midpoint', () => {
    // gamma 2: t=0.5 -> 0.5^(1/2) = sqrt(0.5)
    expect(levelsRemap(0.5, 0, 1, 2, 0, 1)).toBeCloseTo(Math.sqrt(0.5), 6);
  });
});

describe('curvesRemap', () => {
  it('is identity when all controls are zero', () => {
    for (const l of [0, 0.25, 0.5, 0.75, 1]) {
      expect(curvesRemap(l, 0, 0, 0)).toBeCloseTo(l, 6);
    }
  });

  it('shadows control dominates near L=0 and vanishes near L=1', () => {
    const atZero = curvesRemap(0, 1, 0, 0) - 0;
    const atOne = curvesRemap(1, 1, 0, 0) - 1;
    expect(atZero).toBeGreaterThan(0.1);
    expect(Math.abs(atOne)).toBeLessThan(1e-6);
  });

  it('highlights control dominates near L=1 and vanishes near L=0', () => {
    const atOne = curvesRemap(1, 0, 0, -1) - 1;
    const atZero = curvesRemap(0, 0, 0, -1) - 0;
    expect(atOne).toBeLessThan(-0.1);
    expect(Math.abs(atZero)).toBeLessThan(1e-6);
  });

  it('midtones control peaks at L=0.5', () => {
    const mid = curvesRemap(0.5, 0, 1, 0) - 0.5;
    expect(mid).toBeCloseTo(0.5, 6);
  });

  it('stays within [0, 1] at the extremes', () => {
    expect(curvesRemap(1, 1, 1, 1)).toBeLessThanOrEqual(1);
    expect(curvesRemap(0, -1, -1, -1)).toBeGreaterThanOrEqual(0);
  });
});

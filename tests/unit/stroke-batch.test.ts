import { describe, it, expect } from 'vitest';
import { StrokeBatcher } from '../../src/engine/sources/builtin/stroke-batch';

describe('StrokeBatcher', () => {
  it('has nothing pending before any push', () => {
    const b = new StrokeBatcher();
    b.begin();
    expect(b.hasPending()).toBe(false);
    expect(b.drain()).toEqual([]);
  });

  it('the first point of a stroke is a dot (a === b)', () => {
    const b = new StrokeBatcher();
    b.begin();
    b.push({ x: 10, y: 20 });
    const segs = b.drain();
    expect(segs).toEqual([{ a: [10, 20], b: [10, 20] }]);
  });

  it('subsequent points form a segment from the previous point', () => {
    const b = new StrokeBatcher();
    b.begin();
    b.push({ x: 0, y: 0 });
    b.push({ x: 5, y: 5 });
    b.push({ x: 5, y: 10 });
    const segs = b.drain();
    expect(segs).toEqual([
      { a: [0, 0], b: [0, 0] },
      { a: [0, 0], b: [5, 5] },
      { a: [5, 5], b: [5, 10] },
    ]);
  });

  it('batches everything pushed since the last drain (or begin)', () => {
    const b = new StrokeBatcher();
    b.begin();
    b.push({ x: 0, y: 0 });
    b.push({ x: 1, y: 1 });
    expect(b.drain().length).toBe(2);
    expect(b.hasPending()).toBe(false);

    b.push({ x: 2, y: 2 });
    // No begin() call: continues the same stroke, segment from last point.
    const segs = b.drain();
    expect(segs).toEqual([{ a: [1, 1], b: [2, 2] }]);
  });

  it('begin() resets so the next push is a fresh dot', () => {
    const b = new StrokeBatcher();
    b.begin();
    b.push({ x: 0, y: 0 });
    b.push({ x: 9, y: 9 });
    b.drain();

    b.begin();
    b.push({ x: 3, y: 3 });
    expect(b.drain()).toEqual([{ a: [3, 3], b: [3, 3] }]);
  });
});

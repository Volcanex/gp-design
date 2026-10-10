import { describe, it, expect } from 'vitest';
import { rowIndexAtPointerY } from '../../src/ui/panels/layers';

/** Four 28px rows stacked from y=0 (row 0, topmost) to y=112 (bottom of row 3). */
const ROWS = [
  { top: 0, height: 28 },
  { top: 28, height: 28 },
  { top: 56, height: 28 },
  { top: 84, height: 28 },
];

describe('rowIndexAtPointerY (geometric drop-row tracking, Bug 2)', () => {
  it('resolves a point inside a row to that row', () => {
    expect(rowIndexAtPointerY(ROWS, 5)).toBe(0);
    expect(rowIndexAtPointerY(ROWS, 40)).toBe(1);
    expect(rowIndexAtPointerY(ROWS, 100)).toBe(3);
  });

  it('resolves the exact visual centre of a row to that SAME row, not the next one', () => {
    // Row 2 spans 56..84, centre 70 (the single most natural place to
    // release a drag, and where a boundary based on a top/bottom-half
    // midpoint split, a real regression this guards, rolled over to
    // row 3 instead via a strict `<` compare against exactly the centre).
    expect(rowIndexAtPointerY(ROWS, 70)).toBe(2);
    // Full containment: anywhere in row 2's own span resolves to row 2.
    expect(rowIndexAtPointerY(ROWS, 56)).toBe(2);
    expect(rowIndexAtPointerY(ROWS, 83.999)).toBe(2);
    // The instant it crosses into row 3's span, it's row 3.
    expect(rowIndexAtPointerY(ROWS, 84)).toBe(3);
  });

  it('clamps above the first row to row 0', () => {
    expect(rowIndexAtPointerY(ROWS, -50)).toBe(0);
  });

  it('clamps below the last row to the last row', () => {
    expect(rowIndexAtPointerY(ROWS, 9999)).toBe(3);
  });

  it('a fast drag that never visits intermediate rows still resolves correctly from a single point', () => {
    // Simulates the bug: pointermove reports one sample far past several
    // rows without ever crossing their boundaries individually. The
    // geometry doesn't care, it only needs the final Y.
    expect(rowIndexAtPointerY(ROWS, 90)).toBe(3);
  });

  it('returns 0 for an empty row list rather than a negative index', () => {
    expect(rowIndexAtPointerY([], 50)).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { cubeTextToLut } from '../../src/ui/dialogs/lut-import';
import { identityLutBytes } from '../../src/engine/passes/builtin/lut-bytes';

/** A tiny 2x2x2 identity .cube: r fastest, then g, then b, per the format's
 * fixed nesting order. */
function identityCubeText(n: number): string {
  const lines = [`LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const v = (i: number) => (n > 1 ? i / (n - 1) : 0);
        lines.push(`${v(r)} ${v(g)} ${v(b)}`);
      }
    }
  }
  return lines.join('\n');
}

describe('cubeTextToLut', () => {
  it('parses LUT_3D_SIZE and repacks into core.lut byte layout matching identityLutBytes', () => {
    const n = 4;
    const parsed = cubeTextToLut(identityCubeText(n));
    expect(parsed.size).toBe(n);
    expect(Array.from(parsed.bytes)).toEqual(Array.from(identityLutBytes(n)));
  });

  it('ignores comments and TITLE/DOMAIN metadata lines', () => {
    const n = 2;
    const text = `TITLE "test"\n# a comment\n${identityCubeText(n)}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n`;
    const parsed = cubeTextToLut(text);
    expect(parsed.size).toBe(n);
    expect(Array.from(parsed.bytes)).toEqual(Array.from(identityLutBytes(n)));
  });

  it('throws on a malformed file (size/data row count mismatch)', () => {
    expect(() => cubeTextToLut('LUT_3D_SIZE 4\n0 0 0\n')).toThrow(/valid 3D \.cube/);
  });

  it('throws when LUT_3D_SIZE is missing entirely', () => {
    expect(() => cubeTextToLut('0 0 0\n1 1 1\n')).toThrow();
  });
});

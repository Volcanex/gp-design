import { describe, it, expect } from 'vitest';
import { layoutText, quadsToVertexData, type BmFontData } from '../../src/engine/sources/builtin/text-layout';

/** Minimal fixture: two monospace-ish glyphs 'A' (65) and 'B' (66), plus a
 * kerning pair between them, mirroring msdf-bmfont-xml's JSON shape. */
const font: BmFontData = {
  info: { size: 42 },
  common: { scaleW: 256, scaleH: 256, lineHeight: 42, base: 34 },
  distanceField: { distanceRange: 4, fieldType: 'msdf' },
  chars: [
    { id: 65, x: 0, y: 0, width: 20, height: 30, xoffset: 2, yoffset: 1, xadvance: 24 },
    { id: 66, x: 20, y: 0, width: 18, height: 30, xoffset: 3, yoffset: 1, xadvance: 22 },
  ],
  kernings: [{ first: 65, second: 66, amount: -2 }],
};

describe('layoutText', () => {
  it('places the first glyph at its own xoffset/yoffset with no pen advance yet', () => {
    const [a] = layoutText(font, 'A');
    expect(a!.x0).toBe(2);
    expect(a!.y0).toBe(1);
    expect(a!.x1).toBe(22);
    expect(a!.y1).toBe(31);
  });

  it('advances the pen by xadvance for the second glyph, applying kerning', () => {
    const [, b] = layoutText(font, 'AB');
    // pen after 'A' = 24, kerning(A,B) = -2, then + xoffset(3)
    expect(b!.x0).toBe(24 - 2 + 3);
  });

  it('maps atlas pixel rects to normalized UVs', () => {
    const [a] = layoutText(font, 'A');
    expect(a!.u0).toBeCloseTo(0 / 256);
    expect(a!.v0).toBeCloseTo(0 / 256);
    expect(a!.u1).toBeCloseTo(20 / 256);
    expect(a!.v1).toBeCloseTo(30 / 256);
  });

  it('skips characters missing from the atlas without throwing', () => {
    const quads = layoutText(font, 'A€B');
    expect(quads).toHaveLength(2);
  });

  it('omits zero-size glyphs (e.g. space) from the quad list but still consumes their advance', () => {
    const withSpace: BmFontData = {
      ...font,
      chars: [...font.chars, { id: 32, x: 0, y: 0, width: 0, height: 0, xoffset: 0, yoffset: 0, xadvance: 10 }],
    };
    const quads = layoutText(withSpace, 'A B');
    expect(quads).toHaveLength(2);
    // pen after 'A'(24) + ' '(10) = 34, then B's xoffset(3)
    expect(quads[1]!.x0).toBe(34 + 3);
  });

  it('produces an empty array for an empty string', () => {
    expect(layoutText(font, '')).toEqual([]);
  });
});

describe('quadsToVertexData', () => {
  it('emits 6 vertices of 4 floats each per quad', () => {
    const quads = layoutText(font, 'AB');
    const data = quadsToVertexData(quads);
    expect(data.length).toBe(quads.length * 6 * 4);
  });

  it('covers all four corners of the quad across its 6 vertices', () => {
    const quads = layoutText(font, 'A');
    const data = quadsToVertexData(quads);
    const xs = new Set<number>();
    const ys = new Set<number>();
    for (let i = 0; i < 6; i++) {
      xs.add(data[i * 4]!);
      ys.add(data[i * 4 + 1]!);
    }
    expect(xs).toEqual(new Set([quads[0]!.x0, quads[0]!.x1]));
    expect(ys).toEqual(new Set([quads[0]!.y0, quads[0]!.y1]));
  });
});

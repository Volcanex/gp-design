/**
 * Pure CPU layout math for core.text: no GPU, no DOM, unit-testable in
 * isolation. Shapes a BMFont-style (msdf-bmfont-xml JSON output) atlas
 * description + a string into glyph quads in "local" space: pen-relative,
 * at the atlas's baked font size (font.info.size), unscaled by the layer's
 * `size` param. text.ts multiplies by scale = size / font.info.size at
 * render time so re-typing the string is the only thing that rebuilds
 * geometry. Resizing/moving/recoloring don't.
 */

export interface BmFontChar {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  xoffset: number;
  yoffset: number;
  xadvance: number;
}

export interface BmFontKerning {
  first: number;
  second: number;
  amount: number;
}

export interface BmFontData {
  info: { size: number };
  common: { scaleW: number; scaleH: number; lineHeight: number; base: number };
  distanceField: { distanceRange: number; fieldType: string };
  chars: BmFontChar[];
  kernings: BmFontKerning[];
}

/** Local-space (pen-relative, atlas-pixel-scale) glyph quad + its atlas UVs. */
export interface GlyphQuad {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * Single-line layout: walks codepoints left to right, applying kerning
 * pairs when present, skipping glyphs missing from the atlas (e.g. an
 * unsupported character) while still consuming pen advance for anything
 * charMap does have. Chars absent entirely just contribute no advance.
 */
export function layoutText(font: BmFontData, text: string): GlyphQuad[] {
  const charMap = new Map(font.chars.map((c) => [c.id, c]));
  const kerning = new Map<string, number>();
  for (const k of font.kernings) kerning.set(`${k.first}:${k.second}`, k.amount);

  const quads: GlyphQuad[] = [];
  let pen = 0;
  let prevId: number | null = null;

  for (const ch of text) {
    const id = ch.codePointAt(0)!;
    const glyph = charMap.get(id);
    if (!glyph) {
      prevId = null;
      continue;
    }
    if (prevId !== null) {
      pen += kerning.get(`${prevId}:${id}`) ?? 0;
    }
    if (glyph.width > 0 && glyph.height > 0) {
      const x0 = pen + glyph.xoffset;
      const y0 = glyph.yoffset;
      quads.push({
        x0,
        y0,
        x1: x0 + glyph.width,
        y1: y0 + glyph.height,
        u0: glyph.x / font.common.scaleW,
        v0: glyph.y / font.common.scaleH,
        u1: (glyph.x + glyph.width) / font.common.scaleW,
        v1: (glyph.y + glyph.height) / font.common.scaleH,
      });
    }
    pen += glyph.xadvance;
    prevId = id;
  }

  return quads;
}

/** Two triangles per glyph, (pos.xy, uv.xy) interleaved (text.ts's vertex buffer layout). */
export function quadsToVertexData(quads: readonly GlyphQuad[]): Float32Array {
  const floatsPerVertex = 4;
  const verticesPerQuad = 6;
  const data = new Float32Array(quads.length * verticesPerQuad * floatsPerVertex);
  let o = 0;
  for (const q of quads) {
    const verts: [number, number, number, number][] = [
      [q.x0, q.y0, q.u0, q.v0],
      [q.x1, q.y0, q.u1, q.v0],
      [q.x0, q.y1, q.u0, q.v1],
      [q.x1, q.y0, q.u1, q.v0],
      [q.x1, q.y1, q.u1, q.v1],
      [q.x0, q.y1, q.u0, q.v1],
    ];
    for (const v of verts) {
      data[o++] = v[0];
      data[o++] = v[1];
      data[o++] = v[2];
      data[o++] = v[3];
    }
  }
  return data;
}

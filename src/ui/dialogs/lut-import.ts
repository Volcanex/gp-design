/**
 * Small parsers for the two LUT file formats the asset picker's LUT
 * "Import…" flow accepts, both re-packed into core.lut's own tiled layout
 * (lut-bytes.ts) so core/asset-textures.ts and lut.ts's WGSL never need a
 * second code path for an imported vs. procedurally-built LUT.
 */

import { packLutBytes } from '@engine';

export interface ParsedLut {
  size: number;
  bytes: Uint8Array;
}

/**
 * Adobe/Iridas .cube: a `LUT_3D_SIZE n` header line, then n^3 `r g b` float
 * triples in 0..1, ordered r-fastest / g / b-slowest (the format spec's
 * fixed nesting order, not something the file states explicitly). Comments
 * (`#`) and metadata lines (TITLE, DOMAIN_MIN/MAX) are ignored; DOMAIN
 * remapping is out of scope for this "small parser".
 */
function parseCubeText(text: string): { size: number; data: Float64Array } {
  let size = 0;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1] ?? '0', 10);
      continue;
    }
    if (/^[A-Z_]+/.test(line)) continue; // TITLE, DOMAIN_MIN, DOMAIN_MAX, LUT_1D_SIZE (unsupported), ...
    const parts = line.split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) values.push(...parts);
  }
  if (!size || values.length !== size * size * size * 3) {
    throw new Error('not a valid 3D .cube file (LUT_3D_SIZE / data row count mismatch)');
  }
  return { size, data: Float64Array.from(values) };
}

export function cubeTextToLut(text: string): ParsedLut {
  const { size, data } = parseCubeText(text);
  const bytes = packLutBytes(size, (r, g, b) => {
    // packLutBytes calls this at exact grid points only (see its own doc
    // comment). Snap back to the integer index the .cube row was stored at.
    const ri = Math.round(r * (size - 1));
    const gi = Math.round(g * (size - 1));
    const bi = Math.round(b * (size - 1));
    const idx = ((bi * size + gi) * size + ri) * 3;
    return [data[idx]!, data[idx + 1]!, data[idx + 2]!];
  });
  return { size, bytes };
}

/**
 * A Hald PNG lays a 3D LUT out as a square-ish 2D image; the convention this
 * accepts is width = height^2 (core.lut's own tiling, per lut.ts/lut-bytes.ts's
 * doc comments: "standard Hald-style tiling"), so a matching PNG can be
 * decoded and used as raw rgba8unorm bytes with no re-tiling at all.
 */
export async function pngBlobToLut(blob: Blob): Promise<ParsedLut> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    const size = height;
    if (width !== size * size) {
      throw new Error(`PNG is not a valid Hald LUT (expected width = height^2, got ${width}x${height})`);
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable to decode Hald LUT PNG');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    return { size, bytes: new Uint8Array(imageData.data.buffer.slice(0)) };
  } finally {
    bitmap.close();
  }
}

/** File.name-sniffed dispatch: the picker's single "Choose File…" input
 * accepts both extensions and doesn't ask the user which parser to use. */
export async function parseLutFile(file: File): Promise<ParsedLut> {
  if (file.name.toLowerCase().endsWith('.cube')) return cubeTextToLut(await file.text());
  return pngBlobToLut(file);
}

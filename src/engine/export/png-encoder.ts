/**
 * Canvas-free PNG encoder (signature, IHDR, colour chunk(s), IDAT via
 * CompressionStream('deflate'): that stream format is zlib-wrapped
 * deflate, exactly what IDAT requires, not raw deflate).
 *
 * Colour-space tagging: cICP (PNG third-edition / ITU-T H.273 nclx values)
 * is the spec-correct tag for Display P3: colour primaries 12 (P3-D65,
 * SMPTE EG 432-1), transfer characteristics 13 (IEC 61966-2-1, the sRGB
 * curve: Display P3 shares sRGB's transfer function), matrix coefficients
 * 0 (identity: PNG carries RGB, not YCbCr), full-range flag 1. Browser
 * support for cICP on *raster PNGs* (vs. AVIF/HEIF, where it's long
 * established) is still uneven as of this writing, so cHRM+gAMA ride
 * along as a fallback: those two chunks are PNG-1.0-era and universally
 * honoured, giving every decoder at least a chromaticity-based
 * approximation of the real primaries. iCCP (an embedded Display P3 ICC
 * profile) was considered and dropped: hand-rolling a byte-correct ICC
 * binary from memory risks a profile that's subtly wrong in a way nothing
 * here can verify, whereas cICP + cHRM/gAMA are small, spec-checkable
 * integers. sRGB docs get the standard sRGB chunk (+ matching cHRM/gAMA).
 *
 * Which chunk set gets picked is the caller's call (see host/localHost.ts
 * export()): it must match the colour space the pixels were ACTUALLY
 * rendered in, not the document's stated intent, so tag and bytes never
 * disagree (mirrors gpu/present.ts's "exported pixels = seen pixels").
 */

import type { FramePixels } from './types';

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32Bytes(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const crc = crc32(body);

  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32Bytes(data.length), 0);
  out.set(body, 4);
  out.set(u32Bytes(crc), 4 + body.length);
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const bufferView = new Uint8Array(bytes); // fresh, non-shared backing for the stream API
  void writer.write(bufferView);
  void writer.close();

  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Filter type 0 (None) on every scanline: one 0x00 byte then the raw RGBA row. */
function filterScanlines(data: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = width * 4;
  const out = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const srcOff = y * rowBytes;
    const dstOff = y * (rowBytes + 1);
    out[dstOff] = 0;
    out.set(data.subarray(srcOff, srcOff + rowBytes), dstOff + 1);
  }
  return out;
}

const CICP_DISPLAY_P3 = new Uint8Array([12, 13, 0, 1]);

// [whiteX, whiteY, redX, redY, greenX, greenY, blueX, blueY], PNG cHRM units
// (uint32, scaled by 100000). Both share the D65 white point.
const CHRM_SRGB = [0.3127, 0.329, 0.64, 0.33, 0.3, 0.6, 0.15, 0.06];
const CHRM_P3 = [0.3127, 0.329, 0.68, 0.32, 0.265, 0.69, 0.15, 0.06]; // SMPTE EG 432-1

function chrmChunk(values: number[]): Uint8Array {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, Math.round(v * 100000)));
  return chunk('cHRM', out);
}

function gamaChunk(): Uint8Array {
  // Legacy decoders only understand a single gamma value (no piecewise sRGB
  // curve in PNG's gAMA model): 1/2.2 is the standard sRGB approximation.
  return chunk('gAMA', u32Bytes(45455));
}

export async function encodePng(
  frame: FramePixels,
  colorSpace: 'srgb' | 'display-p3',
): Promise<ArrayBuffer> {
  const { width, height, data } = frame;

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const colourChunks =
    colorSpace === 'display-p3'
      ? [chunk('cICP', CICP_DISPLAY_P3), chrmChunk(CHRM_P3), gamaChunk()]
      : [chunk('sRGB', new Uint8Array([0])), chrmChunk(CHRM_SRGB), gamaChunk()];

  const compressed = await deflate(filterScanlines(data, width, height));

  const parts = [
    SIGNATURE,
    chunk('IHDR', ihdr),
    ...colourChunks,
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out.buffer;
}

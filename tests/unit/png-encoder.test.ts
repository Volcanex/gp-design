import { describe, it, expect } from 'vitest';
import { encodePng } from '../../src/engine/export/png-encoder';
import type { FramePixels } from '../../src/engine/export/types';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(bytes));
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

/** Parses top-level PNG chunks: [{ type, data }]. Does not validate CRCs (that's the decoder's job). */
function parseChunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8; // past signature
  const chunks: { type: string; data: Uint8Array }[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!,
    );
    const data = png.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 8 + length + 4; // length + type + data + crc
  }
  return chunks;
}

function tinyFrame(): FramePixels {
  // 2x1 RGBA8: opaque red, then translucent green.
  return {
    width: 2,
    height: 1,
    data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]),
  };
}

describe('png-encoder', () => {
  it('writes a valid signature and IHDR matching the frame dimensions', async () => {
    const buf = await encodePng(tinyFrame(), 'srgb');
    const bytes = new Uint8Array(buf);
    expect(Array.from(bytes.subarray(0, 8))).toEqual(SIGNATURE);

    const chunks = parseChunks(bytes);
    const ihdr = chunks.find((c) => c.type === 'IHDR');
    expect(ihdr).toBeDefined();
    const view = new DataView(ihdr!.data.buffer, ihdr!.data.byteOffset, ihdr!.data.byteLength);
    expect(view.getUint32(0)).toBe(2); // width
    expect(view.getUint32(4)).toBe(1); // height
    expect(ihdr!.data[8]).toBe(8); // bit depth
    expect(ihdr!.data[9]).toBe(6); // colour type: RGBA
  });

  it('tags sRGB docs with an sRGB chunk (no cICP)', async () => {
    const chunks = parseChunks(new Uint8Array(await encodePng(tinyFrame(), 'srgb')));
    expect(chunks.some((c) => c.type === 'sRGB')).toBe(true);
    expect(chunks.some((c) => c.type === 'cICP')).toBe(false);
    expect(chunks.some((c) => c.type === 'cHRM')).toBe(true);
    expect(chunks.some((c) => c.type === 'gAMA')).toBe(true);
  });

  it('tags display-p3 docs with a cICP chunk (P3-D65 primaries, sRGB transfer)', async () => {
    const chunks = parseChunks(new Uint8Array(await encodePng(tinyFrame(), 'display-p3')));
    const cicp = chunks.find((c) => c.type === 'cICP');
    expect(cicp).toBeDefined();
    expect(Array.from(cicp!.data)).toEqual([12, 13, 0, 1]);
    expect(chunks.some((c) => c.type === 'sRGB')).toBe(false);
    expect(chunks.some((c) => c.type === 'cHRM')).toBe(true);
  });

  it('IDAT inflates to filter-none-prefixed scanlines matching the source pixels', async () => {
    const frame = tinyFrame();
    const chunks = parseChunks(new Uint8Array(await encodePng(frame, 'srgb')));
    const idat = chunks.find((c) => c.type === 'IDAT');
    expect(idat).toBeDefined();

    const inflated = await inflate(idat!.data);
    const rowBytes = frame.width * 4;
    // filter byte per row + raw RGBA row
    expect(inflated.length).toBe((rowBytes + 1) * frame.height);
    expect(inflated[0]).toBe(0); // filter type: None
    expect(Array.from(inflated.subarray(1, 1 + rowBytes))).toEqual(Array.from(frame.data));
  });

  it('ends with an IEND chunk', async () => {
    const chunks = parseChunks(new Uint8Array(await encodePng(tinyFrame(), 'srgb')));
    expect(chunks.at(-1)?.type).toBe('IEND');
  });
});

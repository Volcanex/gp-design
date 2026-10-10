import { describe, it, expect } from 'vitest';
import { buildTar } from '../../src/engine/export/tar';

/** Minimal manual USTAR reader: just enough to verify buildTar's output,
 * deliberately independent of buildTar's own field-writing helpers. */
function parseTar(buf: ArrayBuffer): { name: string; size: number; data: Uint8Array }[] {
  const bytes = new Uint8Array(buf);
  const entries: { name: string; size: number; data: Uint8Array }[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive zero block

    const readString = (start: number, length: number) => {
      let end = start;
      while (end < start + length && header[end] !== 0) end++;
      return new TextDecoder().decode(header.subarray(start, end));
    };
    const readOctal = (start: number, length: number) => {
      const str = readString(start, length).trim();
      return str.length ? parseInt(str, 8) : 0;
    };

    const name = readString(0, 100);
    const size = readOctal(124, 12);
    const magic = readString(257, 6);
    expect(magic).toBe('ustar');

    const dataStart = offset + 512;
    const data = bytes.subarray(dataStart, dataStart + size);
    entries.push({ name, size, data: new Uint8Array(data) });

    const consumed = 512 + Math.ceil(size / 512) * 512;
    offset += consumed;
  }
  return entries;
}

function checksumOf(header: Uint8Array): number {
  const copy = Uint8Array.from(header);
  copy.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of copy) sum += b;
  return sum;
}

describe('tar writer', () => {
  it('round-trips a single small file', () => {
    const content = new TextEncoder().encode('hello tar');
    const buf = buildTar([{ name: 'frame-0000.png', data: content }]);
    const entries = parseTar(buf);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('frame-0000.png');
    expect(entries[0]!.size).toBe(content.length);
    expect(Array.from(entries[0]!.data)).toEqual(Array.from(content));
  });

  it('round-trips multiple files of varying (non-block-aligned) sizes', () => {
    const files = [
      { name: 'frame-0000.png', data: new Uint8Array(10).fill(1) },
      { name: 'frame-0001.png', data: new Uint8Array(512).fill(2) },
      { name: 'frame-0002.png', data: new Uint8Array(513).fill(3) },
      { name: 'frame-0003.png', data: new Uint8Array(0) },
    ];
    const entries = parseTar(buildTar(files));
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    entries.forEach((e, i) => {
      expect(e.size).toBe(files[i]!.data.length);
      expect(Array.from(e.data)).toEqual(Array.from(files[i]!.data));
    });
  });

  it('writes a header whose checksum field matches an independently-computed sum', () => {
    const buf = buildTar([{ name: 'a.png', data: new Uint8Array([9, 9, 9]) }]);
    const header = new Uint8Array(buf).subarray(0, 512);
    const chksumField = new TextDecoder().decode(header.subarray(148, 154)).replace(/\0/g, '').trim();
    const written = parseInt(chksumField, 8);
    expect(written).toBe(checksumOf(header));
  });

  it('ends with two zeroed 512-byte blocks', () => {
    const buf = buildTar([{ name: 'a.png', data: new Uint8Array([1]) }]);
    const bytes = new Uint8Array(buf);
    const tail = bytes.subarray(bytes.length - 1024);
    expect(tail.every((b) => b === 0)).toBe(true);
    expect(bytes.length % 512).toBe(0);
  });
});

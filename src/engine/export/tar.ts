/**
 * Hand-rolled USTAR writer, no dependency, only what png-sequence.ts needs:
 * one archive of flat regular files, no directories/symlinks/long names.
 * Header layout is the POSIX ustar format (512-byte header, name/size/mtime
 * as NUL-terminated octal-ASCII, checksum computed with the checksum field
 * itself treated as eight spaces). Content is padded to a 512-byte boundary
 * per entry; the archive ends with two zeroed 512-byte blocks.
 */

const BLOCK = 512;

function writeString(header: Uint8Array, offset: number, value: string, length: number): void {
  for (let i = 0; i < Math.min(value.length, length); i++) header[offset + i] = value.charCodeAt(i);
}

/** Octal ASCII, NUL-terminated, left-padded with '0' to fill `length` bytes. */
function writeOctal(header: Uint8Array, offset: number, value: number, length: number): void {
  const digits = Math.floor(value).toString(8).padStart(length - 1, '0');
  writeString(header, offset, digits, length - 1);
  header[offset + length - 1] = 0;
}

function makeHeader(name: string, size: number, mtimeSeconds: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, name, 100);
  writeOctal(header, 100, 0o644, 8); // mode
  writeOctal(header, 108, 0, 8); // uid
  writeOctal(header, 116, 0, 8); // gid
  writeOctal(header, 124, size, 12);
  writeOctal(header, 136, mtimeSeconds, 12);
  header.fill(0x20, 148, 156); // chksum field: eight spaces while summing
  header[156] = '0'.charCodeAt(0); // typeflag: regular file
  writeString(header, 257, 'ustar', 6); // magic (implicit trailing NUL)
  writeString(header, 263, '00', 2); // version

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i]!;
  const chksum = sum.toString(8).padStart(6, '0');
  writeString(header, 148, chksum, 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

export function buildTar(files: readonly TarEntry[]): ArrayBuffer {
  const mtime = Math.floor(Date.now() / 1000);
  const parts: Uint8Array[] = [];
  for (const file of files) {
    parts.push(makeHeader(file.name, file.data.length, mtime));
    parts.push(file.data);
    const pad = (BLOCK - (file.data.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2)); // end-of-archive marker

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out.buffer;
}

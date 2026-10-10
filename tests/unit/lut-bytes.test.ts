import { describe, it, expect } from 'vitest';
import { packLutBytes, identityLutBytes, invertedLutBytes } from '../../src/engine/passes/builtin/lut-bytes';

function texel(bytes: Uint8Array, n: number, r: number, g: number, bSlice: number): [number, number, number, number] {
  const width = n * n;
  const x = bSlice * n + r;
  const idx = (g * width + x) * 4;
  return [bytes[idx]!, bytes[idx + 1]!, bytes[idx + 2]!, bytes[idx + 3]!];
}

describe('packLutBytes', () => {
  it('sizes the buffer as (n*n) x n x 4 bytes', () => {
    const n = 4;
    const bytes = packLutBytes(n, (r, g, b) => [r, g, b]);
    expect(bytes.length).toBe(n * n * n * 4);
  });

  it('alpha is always 255', () => {
    const bytes = identityLutBytes(3);
    for (let i = 3; i < bytes.length; i += 4) expect(bytes[i]).toBe(255);
  });

  it('clamps out-of-range map output into 0..255', () => {
    const bytes = packLutBytes(2, () => [2, -1, 0.5]);
    expect(texel(bytes, 2, 0, 0, 0)).toEqual([255, 0, 128, 255]);
  });
});

describe('identityLutBytes', () => {
  it('grid corner (0,0,0) is black, (n-1,n-1,n-1) is white', () => {
    const n = 4;
    const bytes = identityLutBytes(n);
    expect(texel(bytes, n, 0, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(texel(bytes, n, n - 1, n - 1, n - 1)).toEqual([255, 255, 255, 255]);
  });

  it('maps r,g,b straight through at a mid grid point', () => {
    const n = 5;
    const bytes = identityLutBytes(n);
    const [r, g, b, a] = texel(bytes, n, 2, 1, 3);
    expect(r).toBe(Math.round((2 / (n - 1)) * 255));
    expect(g).toBe(Math.round((1 / (n - 1)) * 255));
    expect(b).toBe(Math.round((3 / (n - 1)) * 255));
    expect(a).toBe(255);
  });
});

describe('invertedLutBytes', () => {
  it('grid corner (0,0,0) is white, (n-1,n-1,n-1) is black', () => {
    const n = 4;
    const bytes = invertedLutBytes(n);
    expect(texel(bytes, n, 0, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(texel(bytes, n, n - 1, n - 1, n - 1)).toEqual([0, 0, 0, 255]);
  });
});

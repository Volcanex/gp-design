import { describe, it, expect } from 'vitest';
import { decodeRgba16f, encodeRgba16f } from '../../src/ui/canvas/raster-codec';

describe('raster-codec', () => {
  it('round-trips typical OKLab+alpha values through encode/decode within f16 precision', () => {
    const values = new Float32Array([0, 1, -1, 0.5, -0.5, 0.6, 0.1, -0.05, 1, 0.25, 0.75, 0.999]);
    const encoded = encodeRgba16f(values);
    const decoded = decodeRgba16f(encoded);
    expect(decoded.length).toBe(values.length);
    for (let i = 0; i < values.length; i += 1) {
      expect(decoded[i]).toBeCloseTo(values[i]!, 2);
    }
  });

  it('round-trips exact zero and negative zero (magnitude, sign not asserted)', () => {
    const values = new Float32Array([0, -0]);
    const decoded = decodeRgba16f(encodeRgba16f(values));
    expect(Math.abs(decoded[0]!)).toBe(0);
    expect(Math.abs(decoded[1]!)).toBe(0);
  });

  it('encoded buffer byte length matches rgba16float layout (2 bytes/channel)', () => {
    const values = new Float32Array(16); // 4 pixels * 4 channels
    const encoded = encodeRgba16f(values);
    expect(encoded.byteLength).toBe(values.length * 2);
  });
});

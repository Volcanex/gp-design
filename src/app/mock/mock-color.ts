/**
 * OKLab → sRGB for the mock's 2D-canvas rendering only. The real engine
 * does this in WGSL (wgsl/snippets/oklab.wgsl) mirrored by color/oklab.ts;
 * this copy is throwaway with the mock and deliberately unshared.
 */

export function oklabToSrgbCss(lab: readonly number[]): string {
  const [L = 0, a = 0, b = 0] = lab;
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const enc = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  };
  return `rgb(${enc(r)}, ${enc(g)}, ${enc(bb)})`;
}

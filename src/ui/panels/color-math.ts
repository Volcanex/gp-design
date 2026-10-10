/**
 * OKLab/OKLCH <-> sRGB, both directions, for the color panel's picker and
 * hex field. Mirrors the constants in src/app/mock/mock-color.ts (which only
 * goes OKLab->sRGB for the mock's 2D canvas); this will need to mirror
 * src/engine/color/oklab.ts once the real engine lands (Phase 2).
 */

export type Oklab = readonly [number, number, number];
export type Oklch = readonly [number, number, number];
export type Srgb = readonly [number, number, number];

export function oklabToSrgb([L, a, b]: Oklab): Srgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const enc = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, v));
  };
  return [enc(r), enc(g), enc(bb)];
}

export function srgbToOklab([r, g, b]: Srgb): Oklab {
  const dec = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lr = dec(r), lg = dec(g), lb = dec(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

export function oklabToOklch([L, a, b]: Oklab): Oklch {
  const C = Math.sqrt(a * a + b * b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}

export function oklchToOklab([L, C, H]: Oklch): Oklab {
  const rad = (H * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}

export function oklchToSrgb(lch: Oklch): Srgb {
  return oklabToSrgb(oklchToOklab(lch));
}

export function srgbToOklch(rgb: Srgb): Oklch {
  return oklabToOklch(srgbToOklab(rgb));
}

export function srgbToHex([r, g, b]: Srgb): string {
  const byte = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

export function hexToSrgb(hex: string): Srgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

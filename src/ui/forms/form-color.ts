/**
 * OKLab <-> sRGB (both directions) + OKLCH helpers for the color swatch/popover.
 * Mirrors src/engine/color/oklab.ts (and app/mock/mock-color.ts, which only
 * needs the one-way OKLab->CSS path for the mock renderer); this copy exists
 * because the UI needs the inverse (sRGB->OKLab, for hex input) too.
 */

export type Oklab = readonly [number, number, number];
export type Srgb = readonly [number, number, number];

export function oklabToSrgb(lab: Oklab): Srgb {
  const [L, a, b] = lab;
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(bb)];
}

export function srgbToOklab(rgb: Srgb): Oklab {
  const [r8, g8, b8] = rgb;
  const r = srgbToLinear(r8), g = srgbToLinear(g8), b = srgbToLinear(b8);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, v));
}

function srgbToLinear(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function srgbToCss([r, g, b]: Srgb): string {
  const enc = (c: number) => Math.round(c * 255);
  return `rgb(${enc(r)}, ${enc(g)}, ${enc(b)})`;
}

export function oklabToCss(lab: Oklab): string {
  return srgbToCss(oklabToSrgb(lab));
}

export function srgbToHex([r, g, b]: Srgb): string {
  const enc = (c: number) => Math.round(c * 255).toString(16).padStart(2, '0');
  return `#${enc(r)}${enc(g)}${enc(b)}`;
}

export function hexToSrgb(hex: string): Srgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** OKLCH: L stays; a/b become C (chroma) + H (hue, degrees). */
export function oklabToOklch(lab: Oklab): readonly [number, number, number] {
  const [L, a, b] = lab;
  const c = Math.sqrt(a * a + b * b);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return [L, c, h < 0 ? h + 360 : h];
}

export function oklchToOklab(lch: readonly [number, number, number]): Oklab {
  const [L, c, h] = lch;
  const rad = (h * Math.PI) / 180;
  return [L, c * Math.cos(rad), c * Math.sin(rad)];
}

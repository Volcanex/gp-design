/**
 * CPU reference color math: mirrors wgsl/snippets/oklab.wgsl (and the OKLab
 * → sRGB direction that already lives in src/app/mock/mock-color.ts; the
 * constants here are the same Ottosson ones, kept in sync deliberately).
 * Buffers hold OKLab + straight alpha per the engine's non-negotiables;
 * these functions are what present/export and asset ingestion call to
 * cross into/out of encoded sRGB and Display P3.
 */

export type Vec3 = readonly [number, number, number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Linear → encoded sRGB, per channel. */
export function srgbEncode(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
}

/** Encoded sRGB → linear, per channel. */
export function srgbDecode(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Björn Ottosson's linear sRGB → OKLab. */
export function linearSrgbToOklab([r, g, b]: Vec3): Vec3 {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

/** Inverse of linearSrgbToOklab. */
export function oklabToLinearSrgb([L, a, b]: Vec3): Vec3 {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/** OKLab → OKLCh: hue in degrees, [0, 360). */
export function oklabToOklch([L, a, b]: Vec3): Vec3 {
  const c = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, c, h];
}

/** OKLCh → OKLab. */
export function oklchToOklab([L, c, h]: Vec3): Vec3 {
  const rad = (h * Math.PI) / 180;
  return [L, c * Math.cos(rad), c * Math.sin(rad)];
}

/** OKLab → clamped 8-bit sRGB [r, g, b]. */
export function oklabToSrgb8(lab: Vec3): readonly [number, number, number] {
  const [r, g, b] = oklabToLinearSrgb(lab);
  const enc = (c: number) => Math.round(clamp01(srgbEncode(c)) * 255);
  return [enc(r), enc(g), enc(b)];
}

/** 8-bit sRGB [r, g, b] (0-255) → OKLab. */
export function srgb8ToOklab([r, g, b]: readonly [number, number, number]): Vec3 {
  return linearSrgbToOklab([
    srgbDecode(r / 255),
    srgbDecode(g / 255),
    srgbDecode(b / 255),
  ]);
}

/**
 * Linear sRGB ↔ linear Display P3, D65. Derived via the shared XYZ D65
 * intermediate (sRGB and P3 share a white point, differ only in primaries);
 * hardcoded here rather than round-tripped through XYZ at runtime.
 */
const LIN_SRGB_TO_LIN_P3: readonly Vec3[] = [
  [0.8224621, 0.1775380, 0.0],
  [0.0331941, 0.9668058, 0.0],
  [0.0170827, 0.0723974, 0.9105199],
];

const LIN_P3_TO_LIN_SRGB: readonly Vec3[] = [
  [1.2249401, -0.2249404, 0.0],
  [-0.0420569, 1.0420571, 0.0],
  [-0.0196376, -0.0786361, 1.0982735],
];

function applyMatrix(m: readonly Vec3[], [x, y, z]: Vec3): Vec3 {
  return [
    m[0]![0] * x + m[0]![1] * y + m[0]![2] * z,
    m[1]![0] * x + m[1]![1] * y + m[1]![2] * z,
    m[2]![0] * x + m[2]![1] * y + m[2]![2] * z,
  ];
}

export function linearSrgbToLinearP3(rgb: Vec3): Vec3 {
  return applyMatrix(LIN_SRGB_TO_LIN_P3, rgb);
}

export function linearP3ToLinearSrgb(p3: Vec3): Vec3 {
  return applyMatrix(LIN_P3_TO_LIN_SRGB, p3);
}

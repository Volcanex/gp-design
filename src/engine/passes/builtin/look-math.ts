/**
 * Pure TS mirrors of the L-channel remap math used by core.levels and
 * core.curves. Each WGSL pass reimplements the same formula inline (shaders
 * can't import TS), kept in sync by review, not by codegen. tests/unit/
 * look-math.test.ts exercises these directly; the WGSL bodies comment
 * "mirrors look-math.ts" at the point of use so drift is visible.
 */

export function levelsRemap(
  l: number,
  inBlack: number,
  inWhite: number,
  gamma: number,
  outBlack: number,
  outWhite: number,
): number {
  const range = inWhite - inBlack;
  const t0 = range !== 0 ? (l - inBlack) / range : 0;
  const t = Math.min(1, Math.max(0, t0));
  const g = Math.pow(t, 1 / gamma);
  return outBlack + g * (outWhite - outBlack);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Three-zone parametric curve: shadows/midtones/highlights each contribute
 * an additive offset to L, weighted by a smooth partition-of-unity basis
 * centred at L=0, L=0.5, L=1 respectively (wShadow + wMid + wHighlight ===
 * 1 for every L, by construction: wMid is defined as the remainder).
 */
export function curvesRemap(
  l: number,
  shadows: number,
  midtones: number,
  highlights: number,
): number {
  const t = Math.min(1, Math.max(0, l));
  const wShadow = 1 - smoothstep(0, 0.5, t);
  const wHighlight = smoothstep(0.5, 1, t);
  const wMid = 1 - wShadow - wHighlight;
  const offset = (shadows * wShadow + midtones * wMid + highlights * wHighlight) * 0.5;
  return Math.min(1, Math.max(0, t + offset));
}

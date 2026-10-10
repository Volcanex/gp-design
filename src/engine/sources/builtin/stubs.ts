import type { PassDescriptor } from '../../passes/pass';
import { sourceFromPass } from '../from-pass';

/**
 * Stub: real impl Phase 2/3. Each renders flat magenta so it's obviously
 * a placeholder in the compositor rather than looking like a bug. Magenta
 * is OKLab-encoded sRGB (1,0,1): computed on CPU via linear_srgb_to_oklab
 * (sRGB primaries map to themselves at 0/1, so decode is a no-op here),
 * cross-checked against oklch.com's reference for #ff00ff (L=0.7017,
 * C=0.322, H=328.4deg).
 */
const MAGENTA_OKLAB: readonly [number, number, number, number] = [0.7017, 0.2745, -0.1691, 1];

function stubPass(id: string, label: string): PassDescriptor {
  return {
    id,
    label,
    kind: 'render',
    wgsl: `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return vec4f(${MAGENTA_OKLAB[0]}, ${MAGENTA_OKLAB[1]}, ${MAGENTA_OKLAB[2]}, ${MAGENTA_OKLAB[3]});
}
`,
    inputs: [],
    params: {},
    metadata: { category: 'core', description: `Stub for ${label}: real impl Phase 2/3.` },
  };
}

// core.scene's real implementation lives in ./scene.ts (Phase 3, M5). No
// stub registered here anymore.
export const nestedDoc = sourceFromPass(stubPass('core.nested-doc', 'Nested Document'));

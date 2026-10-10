/**
 * FROZEN CONTRACT (F0). The atomic step: (inputs, params, time) → output.
 *
 * Binding convention (derived, never hand-written):
 *   group(0) binding(0): engine uniforms { time, frame, resolution, _pad }
 *   group(0) binding(1): generated Params UBO (packed from `params` schema;
 *                        params-ubo.ts emits the WGSL `struct Params` text:
 *                        shader authors just write `params.foo`)
 *   group(1): declared `inputs` as (texture_2d<f32>, sampler) pairs in order;
 *             asset-kind params append after declared inputs
 *   group(2) binding(0): compute only; output texture_storage_2d<rgba16float, write>
 *
 * Buffers hold OKLab (L, a, b, straight alpha) unless metadata.colorSpace
 * says 'rgb', in which case the chain executor wraps the pass in converts.
 */

import type { ParamsSchema, ResolvedParams } from '../params/schema';

export interface PassInputDecl {
  name: string;
  filter?: 'linear' | 'nearest';
  optional?: boolean;
}

export interface PassMetadata {
  category: string;
  /** Menu placement, e.g. 'Adjustments/Exposure'. Menus build from the registry. */
  menuPath?: string;
  description?: string;
  /** 'rgb' → executor auto-wraps with OKLab↔RGB convert passes. Default 'oklab'. */
  colorSpace?: 'oklab' | 'rgb';
}

export interface PassDescriptor {
  /** Registry key, e.g. 'core.exposure'. */
  id: string;
  label: string;
  kind: 'render' | 'compute';
  /** Shader body; buildShader() prepends includes + generated Params struct. */
  wgsl: string;
  /** Snippet ids from wgsl/snippets, e.g. ['oklab', 'bluenoise']. */
  includes?: string[];
  inputs: readonly PassInputDecl[];
  params: ParamsSchema;
  /** Informational: conceptually in-place. Executor ALWAYS ping-pongs regardless. */
  readWrite?: boolean;
  metadata: PassMetadata;
  /**
   * Macro effects expand to a sequence of already-registered sub-passes
   * instead of running their own `wgsl`: run-chain.ts's macro branch calls
   * this once per chain step and runs each returned sub-pass in turn.
   * `inputs` names which prior outputs feed a sub-pass (default `['prev']`):
   * 'prev' is the previous sub-step's output (or the macro's input, for the
   * first sub-step), 'orig' is always the macro's own input. `wgsl` may be
   * `''` when `expand` is present: the descriptor is never compiled itself.
   */
  expand?: (params: ResolvedParams) => {
    pass: string;
    params: ResolvedParams;
    inputs?: readonly ('prev' | 'orig')[];
  }[];
}

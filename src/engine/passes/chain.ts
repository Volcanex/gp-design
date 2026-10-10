/**
 * FROZEN CONTRACT (F0). Chain is pure data: an ordered list of effect
 * instances. A layer's effect stack, a group's post, and the document's
 * postChain are all this one type. runChain (implemented in Phase 1,
 * engine track D) owns ping-pong; a pass's input is never its attachment.
 */

import type { ParamValues } from '../params/schema';

export interface EffectInstance {
  /** Instance id: selection/animation target. */
  id: string;
  /** PassDescriptor registry key. */
  pass: string;
  params: ParamValues;
  enabled: boolean;
}

export type Chain = EffectInstance[];

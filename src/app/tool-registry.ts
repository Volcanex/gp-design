/**
 * Shared tool metadata used by both the Tools panel and tool.cycle
 * (shell-commands.ts): which tools have no working implementation yet, so
 * neither the button nor the keyboard cycle can land on one. Kept out of
 * app/types.ts (FROZEN CONTRACT) since it's a UI-facing list, not a type.
 */

import type { ToolId } from './types';

export const DISABLED_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>([
  'select-lasso', 'select-wand', 'clone', 'recolor',
]);

export function isToolDisabled(id: ToolId): boolean {
  return DISABLED_TOOLS.has(id);
}

/**
 * Discoverability SSOT: one table of per-tool hint text (statusbar) plus the
 * "still the untouched starter doc" heuristic (canvas overlay + the move-
 * tool's empty-canvas fallback). `TOOL_HINTS` is a `Record<ToolId, ...>` so
 * adding a ToolId without a hint fails `tsc`, not a runtime lookup.
 *
 * Key labels that appear inside a hint sentence are derived from
 * bindings.ts (via keymap.ts's formatKeys) rather than hardcoded, so a
 * rebound shortcut can't leave a stale hint behind. Mirrors panels/tools.ts's
 * toolKeyHint approach for the tool-cycle keys themselves.
 */

import { formatKeys } from '../../app/keymap/keymap';
import { history } from '../../app/commands/app-history';
import type { ToolId } from '../../app/types';

/** Raw KeyBinding.keys values are physical-key codes (e.g. 'BracketLeft');
 * this is a display-only prettifier for the handful this file quotes in
 * prose. It does not change WHICH key is reported, only how it reads. */
function prettyKey(raw: string): string {
  return raw
    .replace(/BracketLeft/g, '[')
    .replace(/BracketRight/g, ']')
    .replace(/Equal/g, '+')
    .replace(/Minus/g, '-');
}

function keyLabel(commandId: string, args?: unknown): string {
  return prettyKey(formatKeys(commandId, args));
}

const SIZE_DOWN = keyLabel('tool.brushSize', -1);
const SIZE_UP = keyLabel('tool.brushSize', 1);
const SWAP_KEY = keyLabel('color.swap');
const DESELECT_KEYS = keyLabel('edit.deselect');

const PAINT_HINT = `Drag to paint, ${SIZE_DOWN} and ${SIZE_UP} change size, ${SWAP_KEY} swaps colours`;
const MARQUEE_HINT = `Drag to marquee-select objects, Shift adds, ${DESELECT_KEYS} deselects`;
const NOT_IMPLEMENTED = 'Not implemented yet';

export interface ToolHint {
  /** Shown when the tool has no active selection (or selection is n/a). */
  default: string;
  /** Shown instead of `default` when selectionState.objects is non-empty. */
  selected?: string;
}

/** Record<ToolId, ...>: exhaustive by construction; a new ToolId with no
 * entry here is a tsc error, not a silent blank hint. */
const TOOL_HINTS: Record<ToolId, ToolHint> = {
  'move': {
    default: 'Click an object to select, drag to move, drag handles to resize (Shift locks aspect)',
    selected: 'Drag to move, Delete removes, arrows nudge',
  },
  'select-rect': { default: MARQUEE_HINT },
  'select-ellipse': { default: MARQUEE_HINT },
  'select-lasso': { default: NOT_IMPLEMENTED },
  'select-wand': { default: NOT_IMPLEMENTED },
  'zoom': { default: 'Click to zoom in, Alt+click out' },
  'pan': { default: 'Drag to pan, or Shift+drag with any tool' },
  'brush': { default: PAINT_HINT },
  'pencil': { default: PAINT_HINT },
  'eraser': { default: PAINT_HINT },
  'bucket': { default: 'Click to fill a contiguous colour region on the active raster layer' },
  'gradient': { default: 'Drag to set the gradient direction' },
  'picker': { default: 'Click to pick a colour' },
  'recolor': { default: NOT_IMPLEMENTED },
  'clone': { default: NOT_IMPLEMENTED },
  'text': { default: 'Click the canvas to place text' },
  'line': { default: 'Drag to draw a straight line' },
  'shapes': { default: 'Drag to draw a shape, pick the kind from the Insert menu' },
};

/** Still the pristine starter doc (File > New's default two-layer doc,
 * never touched): no undo history yet. Kept as one heuristic so the canvas
 * overlay and the move-tool's empty-canvas hint agree on what "empty" means. */
export function isStarterDoc(): boolean {
  return history.entries().length === 0;
}

export interface HintContext {
  tool: ToolId;
  disabled: boolean;
  hasSelection: boolean;
  /** viewState.maskEditing is set. Mask-edit mode outranks every per-tool
   * hint (the paint tools behave differently while it's active). */
  maskEditing?: boolean;
}

/** The statusbar hint for the current tool/selection/doc state. Disabled
 * tools always read "Not implemented yet" regardless of selection. */
export function hintFor(ctx: HintContext): string {
  if (ctx.maskEditing) {
    return 'Editing mask: paint white to reveal, black to hide. Click the chip to exit';
  }
  if (ctx.disabled) return NOT_IMPLEMENTED;
  if (ctx.tool === 'move' && !ctx.hasSelection && isStarterDoc()) {
    return 'Nothing to select yet: drop or paste an image, or pick a tool to start';
  }
  const entry = TOOL_HINTS[ctx.tool];
  return ctx.hasSelection && entry.selected ? entry.selected : entry.default;
}

export const CANVAS_HINT_TEXT = 'Drop or paste an image. B paint, O shapes, T text, F9 effects';

/**
 * The paint.net keymap table: SSOT for every shortcut. `keys` is the
 * canonical combo string produced by keymap.ts's normaliser (modifiers
 * ordered Ctrl, Alt, Shift). `when: 'canvas'` restricts a binding to the
 * canvas context (suppressed while typing in a form field or a dialog is
 * open). Everything else is a global menu-level command.
 */

import type { ToolId } from '../types';

export interface KeyBinding {
  keys: string;
  command: string;
  args?: unknown;
  when?: 'canvas';
}

function group(...tools: ToolId[]): ToolId[] {
  return tools;
}

function nudge(keys: string, dx: number, dy: number): KeyBinding {
  return { keys, command: 'edit.nudge', args: { dx, dy }, when: 'canvas' };
}

export const KEY_BINDINGS: KeyBinding[] = [
  // Panels
  { keys: 'F5', command: 'panel.toggle', args: 'tools' },
  { keys: 'F6', command: 'panel.toggle', args: 'history' },
  { keys: 'F7', command: 'panel.toggle', args: 'layers' },
  { keys: 'F8', command: 'panel.toggle', args: 'colors' },
  { keys: 'F9', command: 'panel.toggle', args: 'effects' },
  { keys: 'F10', command: 'panel.toggle', args: 'timeline' },
  // One layout now (docked shell): resets every pane and the column width.
  { keys: 'Ctrl+Shift+F5', command: 'panel.reset' },

  // Edit / history
  { keys: 'Ctrl+Z', command: 'edit.undo' },
  { keys: 'Ctrl+Y', command: 'edit.redo' },
  // Copy/Cut/Paste are canvas-scoped (unlike most Edit-menu bindings below)
  // so they don't hijack native copy/paste while typing in the text tool's
  // floating textarea or any other form field: keymap.ts's resolveBinding
  // suppresses `when: 'canvas'` bindings for text-editing targets.
  { keys: 'Ctrl+C', command: 'edit.copy', when: 'canvas' },
  { keys: 'Ctrl+X', command: 'edit.cut', when: 'canvas' },
  { keys: 'Ctrl+V', command: 'edit.paste', when: 'canvas' },
  { keys: 'Ctrl+Shift+C', command: 'edit.copyMerged' },
  { keys: 'Ctrl+Shift+V', command: 'edit.pasteAsLayer' },
  // Select All is canvas-scoped like Copy/Cut/Paste above. Otherwise it'd
  // hijack native "select all text" in a form field or open dialog.
  { keys: 'Ctrl+A', command: 'edit.selectAll', when: 'canvas' },
  { keys: 'Ctrl+D', command: 'edit.deselect' },
  { keys: 'Ctrl+F', command: 'edit.repeatEffect' },

  // Nudge selected objects: 1px, Shift+arrow = 10px. Canvas-scoped so
  // arrow keys still move a text cursor in any form field/dialog.
  nudge('ArrowUp', 0, -1),
  nudge('ArrowDown', 0, 1),
  nudge('ArrowLeft', -1, 0),
  nudge('ArrowRight', 1, 0),
  nudge('Shift+ArrowUp', 0, -10),
  nudge('Shift+ArrowDown', 0, 10),
  nudge('Shift+ArrowLeft', -10, 0),
  nudge('Shift+ArrowRight', 10, 0),

  // Layers
  { keys: 'Ctrl+Shift+N', command: 'layer.new' },
  { keys: 'Ctrl+Shift+D', command: 'layer.duplicate' },
  { keys: 'Ctrl+Shift+Delete', command: 'layer.delete' },
  { keys: 'Ctrl+M', command: 'layer.mergeDown' },
  { keys: 'Ctrl+Shift+F', command: 'layer.flatten' },
  { keys: 'Ctrl+Comma', command: 'layer.toggleVisibility' },
  { keys: 'F4', command: 'layer.properties' },
  { keys: 'Alt+PageUp', command: 'layer.selectAbove' },
  { keys: 'Alt+PageDown', command: 'layer.selectBelow' },
  { keys: 'Ctrl+G', command: 'layer.group' },
  { keys: 'Ctrl+Shift+G', command: 'layer.ungroup' },

  // Adjustments / effects: ids may not exist in the registry yet; the
  // command handler (content builders) is responsible for a graceful no-op.
  { keys: 'Ctrl+L', command: 'effect.open', args: 'core.levels' },
  { keys: 'Ctrl+Shift+M', command: 'effect.open', args: 'core.curves' },
  { keys: 'Ctrl+Shift+U', command: 'effect.open', args: 'core.hsl' },
  { keys: 'Ctrl+Shift+T', command: 'effect.open', args: 'core.brightness-contrast' },
  { keys: 'Ctrl+Shift+P', command: 'effect.open', args: 'core.posterize' },
  { keys: 'Ctrl+Shift+I', command: 'effect.open', args: 'core.invert' },

  // Tools: single-key groups, canvas-scoped. Repeat presses cycle.
  { keys: 'S', command: 'tool.cycle', args: group('select-rect', 'select-lasso', 'select-ellipse', 'select-wand'), when: 'canvas' },
  { keys: 'M', command: 'tool.cycle', args: group('move'), when: 'canvas' },
  { keys: 'Z', command: 'tool.cycle', args: group('zoom'), when: 'canvas' },
  { keys: 'H', command: 'tool.cycle', args: group('pan'), when: 'canvas' },
  { keys: 'B', command: 'tool.cycle', args: group('brush'), when: 'canvas' },
  { keys: 'P', command: 'tool.cycle', args: group('pencil'), when: 'canvas' },
  { keys: 'E', command: 'tool.cycle', args: group('eraser'), when: 'canvas' },
  { keys: 'F', command: 'tool.cycle', args: group('bucket'), when: 'canvas' },
  { keys: 'G', command: 'tool.cycle', args: group('gradient'), when: 'canvas' },
  { keys: 'K', command: 'tool.cycle', args: group('picker'), when: 'canvas' },
  { keys: 'R', command: 'tool.cycle', args: group('recolor'), when: 'canvas' },
  { keys: 'L', command: 'tool.cycle', args: group('clone'), when: 'canvas' },
  { keys: 'T', command: 'tool.cycle', args: group('text'), when: 'canvas' },
  { keys: 'O', command: 'tool.cycle', args: group('line', 'shapes'), when: 'canvas' },

  // Transport: global, not canvas-scoped, so play/pause works regardless of
  // focus. Plain Space is claimed by pan (see viewport.ts); Ctrl+Space avoids
  // that collision.
  { keys: 'Ctrl+Space', command: 'clock.toggle' },

  // Colour, brush size, view: canvas-scoped
  { keys: 'X', command: 'color.swap', when: 'canvas' },
  { keys: 'C', command: 'color.switchActive', when: 'canvas' },
  { keys: 'BracketLeft', command: 'tool.brushSize', args: -1, when: 'canvas' },
  { keys: 'BracketRight', command: 'tool.brushSize', args: 1, when: 'canvas' },
  { keys: 'Ctrl+BracketLeft', command: 'tool.brushSize', args: -5, when: 'canvas' },
  { keys: 'Ctrl+BracketRight', command: 'tool.brushSize', args: 5, when: 'canvas' },
  { keys: 'Ctrl+0', command: 'view.actualSize', when: 'canvas' },
  { keys: 'Ctrl+B', command: 'view.zoomToWindow', when: 'canvas' },
  { keys: 'Ctrl+Shift+B', command: 'view.zoomToSelection', when: 'canvas' },
  { keys: 'Ctrl+Equal', command: 'view.zoomIn', when: 'canvas' },
  { keys: 'Ctrl+Minus', command: 'view.zoomOut', when: 'canvas' },
];

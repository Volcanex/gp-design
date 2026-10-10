/**
 * Text editing: a floating <textarea> positioned over the edited object in
 * canvas-region coordinates (DOM, like the selection overlay, see
 * select-tool.ts's header). Two entry points wire into it:
 *  - the Text tool (createTextToolHandler): click inserts a new (empty)
 *    text object at that point via registry.ts's insertTextAt, then opens
 *    the editor on it immediately. This is the ONLY way a user can type
 *    text at all (Insert > Text creates a literal, uneditable "Text").
 *  - the Move tool's double-click (select-tool.ts calls openEditor when it
 *    detects one), for editing an existing text object.
 * Enter (no shift) or blur commits content.text via patchCommand (one undo
 * step, using document.ts's setParam special-case for object content.text,
 * see its comment for why that's not a generic ParamValues bag). Escape
 * cancels without writing. `isTextEditingTarget` (keymap.ts) already treats
 * any focused <textarea> as text-editing, so canvas-scoped single-key
 * shortcuts stay suppressed while this is open. Nothing extra needed here.
 */

import type { AppCtx, ToolId } from '../../app/types';
import { layerId, objectId } from '@engine';
import { viewState } from '../../app/stores';
import { history } from '../../app/commands/app-history';
import { patchCommand } from '../../app/commands/command';
import { insertTextAt } from '../../app/commands/registry';
import { findSceneObject, objectDocCorners, docCornersToCanvasPx } from './object-bounds';
import type { ToolHandler, ToolPoint } from './viewport';

const MIN_WIDTH_PX = 120;
const MIN_HEIGHT_PX = 32;

export interface TextEditor {
  openForObject(layer: string, id: string): void;
  openForNewObjectAt(pt: ToolPoint): void;
}

/**
 * The editor lives in a wrapper div given the EXACT same width/height/
 * transform as the canvas element every layout tick: same technique
 * mountSelectionOverlay (select-tool.ts) uses, so a corner in canvas-local
 * px (docCornersToCanvasPx, zoom-only) is also correct wrapper-local px
 * without any separate getBoundingClientRect offset bookkeeping.
 */
export function mountTextEditor(app: AppCtx, canvasRegion: HTMLElement, canvas: HTMLCanvasElement): TextEditor {
  const wrapper = document.createElement('div');
  wrapper.className = 'gd-selection-overlay'; // reuse: absolute, top:0/left:0, pointer-events:none
  canvasRegion.appendChild(wrapper);

  const textarea = document.createElement('textarea');
  textarea.className = 'gd-text-editor';
  textarea.style.display = 'none';
  textarea.style.position = 'absolute';
  textarea.style.pointerEvents = 'auto';
  textarea.dataset.testid = 'text-editor';
  wrapper.appendChild(textarea);

  function syncWrapperTransform(): void {
    wrapper.style.width = canvas.style.width;
    wrapper.style.height = canvas.style.height;
    wrapper.style.transform = canvas.style.transform;
  }
  viewState.subscribe(syncWrapperTransform);
  syncWrapperTransform();

  let editing: { layer: string; id: string } | null = null;

  function close(): void {
    editing = null;
    textarea.style.display = 'none';
    textarea.blur();
  }

  function commit(): void {
    if (!editing) return;
    const { layer, id } = editing;
    const value = textarea.value;
    close();
    history.push(app, patchCommand('Edit Text', [{
      op: 'setParam',
      target: { kind: 'object', layer: layerId(layer), id: objectId(id) },
      key: 'content.text',
      value,
    }]));
  }

  function cancel(): void {
    close();
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
    e.stopPropagation();
  });
  textarea.addEventListener('blur', () => commit());

  function position(layer: string, id: string): boolean {
    const doc = app.engine.getDocument();
    const corners = objectDocCorners(doc, layerId(layer), objectId(id));
    if (!corners) return false;
    syncWrapperTransform();
    const { zoom } = viewState.get();
    const [tl, , br] = docCornersToCanvasPx(corners, zoom) as [[number, number], [number, number], [number, number]];
    textarea.style.left = `${tl[0]}px`;
    textarea.style.top = `${tl[1]}px`;
    textarea.style.width = `${Math.max(MIN_WIDTH_PX, br[0] - tl[0])}px`;
    textarea.style.height = `${Math.max(MIN_HEIGHT_PX, br[1] - tl[1])}px`;
    return true;
  }

  return {
    openForObject(layer, id) {
      const doc = app.engine.getDocument();
      const node = findSceneObject(doc, layerId(layer), objectId(id));
      if (!node || node.content.type !== 'text') return;
      if (!position(layer, id)) return;
      editing = { layer, id };
      textarea.value = node.content.text.text;
      textarea.style.display = '';
      // Deferred one tick: this opens from inside the canvas's pointerdown
      // handler (viewport.ts), and the browser's own default focus handling
      // for that same mousedown, which runs AFTER our listener returns,
      // steals focus right back to the (non-focusable) canvas/body,
      // immediately blurring the textarea and firing commit() before the
      // user can type a single character. A setTimeout(0) focus call runs
      // after that default action has already happened, so it sticks.
      setTimeout(() => {
        textarea.focus();
        textarea.select();
      }, 0);
    },
    openForNewObjectAt(pt) {
      // insertTextAt never refuses (registry.ts's resolveSceneLayer always
      // resolves-or-creates a scene layer): always something to open.
      const created = insertTextAt(app, pt);
      this.openForObject(created.layer, created.id);
    },
  };
}

export function createTextToolHandler(editor: TextEditor): ToolHandler {
  return {
    down(pt: ToolPoint, tool: ToolId) {
      if (tool !== 'text') return;
      editor.openForNewObjectAt(pt);
    },
    move() {},
    up() {},
  };
}

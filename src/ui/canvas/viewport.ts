/**
 * Canvas pointer/wheel wiring. Pan inputs (Space+drag, middle-drag, the Pan
 * tool, Shift+left-drag, plain wheel) all funnel through one panDrag/pan-by
 * path. Ctrl+wheel and the Zoom tool (click = in, Alt+click = out) both zoom
 * centred on the cursor via the same zoomAtClient helper. Pointer events that
 * aren't a pan or a zoom-tool click route to the active ToolHandler in
 * document coordinates (client px -> doc px via the current zoom/pan). Shift
 * is claimed for pan here. Revisit if shift-constrain gestures are ever
 * added to paint tools.
 */

import type { AppCtx, ToolId } from '../../app/types';
import { createStore } from '../../app/store';
import { toolState, viewState } from '../../app/stores';
import { clampZoom } from '../shell/shell-commands';
import { clampPan } from '../shell/view-math';

export interface ToolPoint {
  x: number;
  y: number;
  pressure: number;
  /** Shift held at the moment this point was captured: select-tool.ts's
   * shift-click toggle / shift-marquee-additive read this instead of a
   * second event listener. Optional (defaults to false when absent) so
   * every OTHER handler/test constructing a ToolPoint literal by hand
   * doesn't need updating for a field only select-tool.ts reads. */
  shiftKey?: boolean;
}

export interface ToolHandler {
  down(pt: ToolPoint, tool: ToolId): void;
  move(pt: ToolPoint, tool: ToolId): void;
  up(pt: ToolPoint, tool: ToolId): void;
}

const noopHandler: ToolHandler = { down() {}, move() {}, up() {} };
let handler: ToolHandler = noopHandler;

export function setToolHandler(h: ToolHandler): void {
  handler = h;
}

/** Last known pointer position in document coordinates, for the statusbar. */
export const pointerPosition = createStore<ToolPoint | null>(null);

const CURSORS: Record<ToolId, string> = {
  'select-rect': 'crosshair',
  'select-lasso': 'crosshair',
  'select-ellipse': 'crosshair',
  'select-wand': 'crosshair',
  move: 'move',
  zoom: 'zoom-in',
  pan: 'grab',
  brush: 'crosshair',
  pencil: 'crosshair',
  eraser: 'crosshair',
  bucket: 'crosshair',
  gradient: 'crosshair',
  picker: 'crosshair',
  recolor: 'crosshair',
  clone: 'crosshair',
  text: 'text',
  line: 'crosshair',
  shapes: 'crosshair',
};

export function installViewport(app: AppCtx, canvas: HTMLCanvasElement): void {
  let spaceDown = false;
  let altDown = false;
  let panDrag: { startClientX: number; startClientY: number; startPanX: number; startPanY: number } | null = null;

  function docSize() {
    return app.engine.getDocument().canvas;
  }

  function regionRect(): DOMRect {
    return (canvas.parentElement ?? canvas).getBoundingClientRect();
  }

  function setPan(x: number, y: number): void {
    const { zoom } = viewState.get();
    const pan = clampPan({ x, y }, regionRect(), docSize(), zoom);
    viewState.update((s) => ({ ...s, panX: pan.x, panY: pan.y }));
  }

  function toDocPoint(e: PointerEvent): ToolPoint {
    const rect = regionRect();
    const { zoom, panX, panY } = viewState.get();
    return {
      x: (e.clientX - rect.left - panX) / zoom,
      y: (e.clientY - rect.top - panY) / zoom,
      pressure: e.pressure || 0.5,
      shiftKey: e.shiftKey,
    };
  }

  /** Zoom by `factor`, anchored so the doc point under (clientX, clientY) stays fixed. */
  function zoomAtClient(clientX: number, clientY: number, factor: number): void {
    const rect = regionRect();
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;
    const { zoom, panX, panY } = viewState.get();
    const docX = (cursorX - panX) / zoom;
    const docY = (cursorY - panY) / zoom;
    const newZoom = clampZoom(zoom * factor);
    const pan = clampPan(
      { x: cursorX - docX * newZoom, y: cursorY - docY * newZoom },
      regionRect(),
      docSize(),
      newZoom,
    );
    viewState.update((s) => ({ ...s, zoom: newZoom, panX: pan.x, panY: pan.y }));
  }

  /** Shift is claimed for pan globally (see header comment) EXCEPT on the
   * move/select-rect/select-ellipse tools, where Shift+click/drag is
   * claimed instead for additive selection (toggle-add a clicked object,
   * union a marquee into the existing selection): select-tool.ts needs the
   * real pointer event to reach its handler for that. */
  function isPanTrigger(e: PointerEvent): boolean {
    const tool = toolState.get().active;
    const shiftClaimedBySelection = tool === 'move' || tool === 'select-rect' || tool === 'select-ellipse';
    return spaceDown || e.button === 1 || tool === 'pan' || (e.shiftKey && e.button === 0 && !shiftClaimedBySelection);
  }

  function startPanDrag(clientX: number, clientY: number): void {
    const { panX, panY } = viewState.get();
    panDrag = { startClientX: clientX, startClientY: clientY, startPanX: panX, startPanY: panY };
    updateCursor(toolState.get().active);
  }

  function updateCursor(tool: ToolId): void {
    if (panDrag) {
      canvas.style.cursor = 'grabbing';
    } else if (spaceDown || tool === 'pan') {
      canvas.style.cursor = 'grab';
    } else if (tool === 'zoom' && altDown) {
      canvas.style.cursor = 'zoom-out';
    } else {
      canvas.style.cursor = CURSORS[tool];
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      spaceDown = true;
      if (e.target === document.body || e.target === canvas) e.preventDefault();
      updateCursor(toolState.get().active);
    }
    if (e.key === 'Alt') {
      altDown = true;
      updateCursor(toolState.get().active);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      updateCursor(toolState.get().active);
    }
    if (e.key === 'Alt') {
      altDown = false;
      updateCursor(toolState.get().active);
    }
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const { panX, panY } = viewState.get();
      if (e.ctrlKey) {
        zoomAtClient(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY));
        return;
      }
      if (e.shiftKey) {
        setPan(panX - e.deltaY, panY);
      } else {
        setPan(panX, panY - e.deltaY);
      }
    },
    { passive: false },
  );

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (isPanTrigger(e)) {
      if (e.button === 1) e.preventDefault();
      startPanDrag(e.clientX, e.clientY);
      return;
    }
    if (toolState.get().active === 'zoom' && e.button === 0) {
      zoomAtClient(e.clientX, e.clientY, e.altKey ? 1 / 1.25 : 1.25);
      return;
    }
    const pt = toDocPoint(e);
    pointerPosition.set(pt);
    handler.down(pt, toolState.get().active);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (panDrag) {
      const drag = panDrag;
      setPan(drag.startPanX + (e.clientX - drag.startClientX), drag.startPanY + (e.clientY - drag.startClientY));
      pointerPosition.set(toDocPoint(e));
      return;
    }
    const pt = toDocPoint(e);
    pointerPosition.set(pt);
    handler.move(pt, toolState.get().active);
  });

  const endDrag = (e: PointerEvent) => {
    if (panDrag) {
      panDrag = null;
      updateCursor(toolState.get().active);
      return;
    }
    handler.up(toDocPoint(e), toolState.get().active);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  toolState.subscribe((s) => updateCursor(s.active));
  updateCursor(toolState.get().active);
}

/**
 * Everything the app shell itself can execute: panels, view/zoom, tool
 * selection, colour swap. Returns false for ids it doesn't own so the
 * command registry can fall through to content commands (layers/effects/edit).
 */

import type { AppCtx, ToolId } from '../../app/types';
import { clockState, defaultLayout, defaultPanelPlacement, layoutState, toolState, viewState } from '../../app/stores';
import { isToolDisabled } from '../../app/tool-registry';
import { getCanvasRegionSize } from './shell';
import { centeredPan, clampPan, fitZoom } from './view-math';

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 32;

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

function clampBrush(size: number): number {
  return Math.min(500, Math.max(1, size));
}

function togglePanel(id: string): void {
  layoutState.update((s) => {
    const current = s.panels[id] ?? defaultPanelPlacement(id);
    return { ...s, panels: { ...s.panels, [id]: { ...current, visible: !current.visible } } };
  });
}

/** Docked shell: there is one layout, so "reset" restores every pane's
 * visibility/collapse and the column width together. The `id` argument is
 * accepted for the old per-panel bindings but ignored. */
function resetLayout(): void {
  layoutState.set(defaultLayout());
}

function cycleTool(args: unknown): void {
  if (!Array.isArray(args) || args.length === 0) return;
  const tools = (args as ToolId[]).filter((id) => !isToolDisabled(id));
  if (tools.length === 0) return;
  const current = toolState.get().active;
  const idx = tools.indexOf(current);
  const next = tools[(idx + 1) % tools.length]!;
  toolState.update((s) => ({ ...s, active: next }));
}

function nudgeBrushSize(args: unknown): void {
  const delta = typeof args === 'number' ? args : 0;
  toolState.update((s) => ({ ...s, brushSize: clampBrush(s.brushSize + delta) }));
}

/** Zoom about the region centre: keep the doc point under it fixed. */
function zoomAtRegionCentre(app: AppCtx, newZoomOf: (zoom: number) => number): void {
  const region = getCanvasRegionSize();
  if (!region.width || !region.height) return;
  const doc = app.engine.getDocument().canvas;
  const { zoom, panX, panY } = viewState.get();
  const newZoom = newZoomOf(zoom);
  const centreX = region.width / 2;
  const centreY = region.height / 2;
  const docX = (centreX - panX) / zoom;
  const docY = (centreY - panY) / zoom;
  const pan = clampPan({ x: centreX - docX * newZoom, y: centreY - docY * newZoom }, region, doc, newZoom);
  viewState.update((s) => ({ ...s, zoom: newZoom, panX: pan.x, panY: pan.y }));
}

function toggleClock(app: AppCtx): void {
  app.engine.setClock({ cmd: clockState.get().playing ? 'pause' : 'play' });
}

function zoomToWindow(app: AppCtx): void {
  const region = getCanvasRegionSize();
  if (!region.width || !region.height) return;
  const doc = app.engine.getDocument().canvas;
  const zoom = fitZoom(region, doc);
  const pan = centeredPan(region, doc, zoom);
  viewState.update((s) => ({ ...s, zoom, panX: pan.x, panY: pan.y }));
}

export function shellExecute(app: AppCtx, id: string, args?: unknown): boolean {
  switch (id) {
    case 'panel.toggle':
      togglePanel(args as string);
      return true;
    case 'panel.reset':
      resetLayout();
      return true;
    case 'view.theme':
      window.g?.theme(typeof args === 'string' ? args : 'dark');
      return true;
    case 'tool.cycle':
      cycleTool(args);
      return true;
    case 'tool.brushSize':
      nudgeBrushSize(args);
      return true;
    case 'color.swap':
      toolState.update((s) => ({ ...s, primary: s.secondary, secondary: s.primary }));
      return true;
    case 'color.switchActive':
      toolState.update((s) => ({ ...s, editing: s.editing === 'primary' ? 'secondary' : 'primary' }));
      return true;
    case 'clock.toggle':
      toggleClock(app);
      return true;
    case 'view.zoomIn':
      zoomAtRegionCentre(app, (zoom) => clampZoom(zoom * 1.25));
      return true;
    case 'view.zoomOut':
      zoomAtRegionCentre(app, (zoom) => clampZoom(zoom / 1.25));
      return true;
    case 'view.actualSize':
      zoomAtRegionCentre(app, () => 1);
      return true;
    case 'view.zoomToWindow':
    case 'view.zoomToSelection': // no selection-fit yet; fit-to-window stands in.
      zoomToWindow(app);
      return true;
    default:
      return false;
  }
}

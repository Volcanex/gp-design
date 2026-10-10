/**
 * Line: drag = one straight stroke on the paintable raster layer. No live
 * preview (per architect brief: restroking every move would multiply
 * beginStroke/endStroke calls for no visible benefit under SwiftShader); the
 * whole beginStroke -> interpolated points -> endStroke sequence runs once,
 * on pointerup, from the recorded drag start to the release point.
 *
 * Shapes: drag = insert a scene object sized/positioned to match the drag
 * rectangle (registry.ts's insertDraggedShape, same insertObject plumbing as
 * the Insert menu's fixed-size commands). Which shape KIND it inserts is
 * toolState.lastShape, whichever shape the Insert menu created most
 * recently (registry.ts's SHAPES block sets it), not a separate cycle
 * gesture; see src/ui/CLAUDE.md's Shapes-tool section for why.
 */

import type { AppCtx, ToolId } from '../../app/types';
import { layerId } from '@engine';
import { toolState } from '../../app/stores';
import { insertDraggedShape } from '../../app/commands/registry';
import { resolvePaintLayer, commitStrokeEdits } from './paint-layer';
import type { ToolHandler, ToolPoint } from './viewport';

/** One interpolated point roughly every 2 doc px along the segment, dense
 * enough that the round brush stamp leaves no gaps at typical brush sizes. */
const STEP_PX = 2;

function interpolateSegment(from: ToolPoint, to: ToolPoint): ToolPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.round(dist / STEP_PX));
  const points: ToolPoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push({ x: from.x + dx * t, y: from.y + dy * t, pressure: to.pressure });
  }
  return points;
}

export function createLineShapesToolHandler(app: AppCtx): ToolHandler {
  let start: ToolPoint | null = null;

  return {
    down(pt, tool) {
      if (tool !== 'line' && tool !== 'shapes') return;
      start = pt;
    },
    move() {
      // No live preview (see header comment).
    },
    up(pt, tool) {
      if (!start) return;
      const from = start;
      start = null;
      if (tool === 'line') {
        const target = resolvePaintLayer(app);
        const { brushSize, primary } = toolState.get();
        app.engine.beginStroke({ layer: layerId(target), brush: 'round', size: brushSize, color: primary, mode: 'paint' });
        for (const p of interpolateSegment(from, pt)) app.engine.strokePoint(p);
        void commitStrokeEdits(app, 'Line');
        return;
      }
      if (tool === 'shapes') {
        const x = Math.min(from.x, pt.x);
        const y = Math.min(from.y, pt.y);
        const width = Math.abs(pt.x - from.x);
        const height = Math.abs(pt.y - from.y);
        if (width < 1 || height < 1) return; // click without drag: nothing to insert
        insertDraggedShape(app, toolState.get().lastShape ?? 'rect', { x, y, width, height });
      }
    },
  };
}

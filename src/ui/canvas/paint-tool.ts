/**
 * ToolHandler for brush/pencil/eraser/picker, installed via setToolHandler
 * from main.ts.
 *
 * Stroke commit: endStroke() resolves the wire contract's "Commits stroke to
 * the raster asset; returns the edit batch (one undo step)" as returning an
 * UNAPPLIED batch: applyEdits is documented (host/EngineHost.ts, CLAUDE.md)
 * as THE ONLY document mutation channel, so a paint stroke must go through it
 * exactly once. This mirrors registry.ts's layer.mergeDown/flatten, which
 * take an async engine call's returned DocEdit[] and hand it straight to
 * `history.push(app, patchCommand(label, edits))` without a separate
 * pre-apply step. Applying the batch a second time ourselves (e.g. via a
 * manual engine.applyEdits before the history push) would double-apply
 * commitRaster: document.ts's applyCommitRaster snapshots "old" region bytes
 * as whatever is currently in the asset immediately before writing `src`, so
 * a second apply of the same edit would capture the just-painted pixels as
 * the "old" state, making undo a no-op instead of reverting to pre-stroke
 * content. One apply, via patchCommand.run(), is both correct and consistent
 * with the rest of the command table.
 */

import type { AppCtx, ToolId } from '../../app/types';
import type { ReadbackResult } from '@engine';
import { layerId } from '@engine';
import { toolState } from '../../app/stores';
import { resolveStrokeTarget, commitStrokeEdits } from './paint-layer';
import { beginMaskStroke, maskStrokePoint, commitMaskStroke } from './mask-paint';
import type { ToolHandler, ToolPoint } from './viewport';

type PaintTool = 'brush' | 'pencil' | 'eraser';

function isPaintTool(tool: ToolId): tool is PaintTool {
  return tool === 'brush' || tool === 'pencil' || tool === 'eraser';
}

function strokeLabel(tool: PaintTool): string {
  return tool === 'brush' ? 'Brush' : tool === 'pencil' ? 'Pencil' : 'Eraser';
}

/**
 * Sample one RGBA pixel out of a readback result. `region` in the request is
 * forward-declared in the frozen contract but the current engine ignores it
 * and always returns the full frame, so we clamp/sample by hand rather than
 * assuming the buffer is already cropped to 1x1. If a future engine DOES
 * crop to the requested region, width/height collapse to 1 and this still
 * resolves to index 0, so the same code path covers both.
 */
function sampleRgba(result: ReadbackResult, x: number, y: number): [number, number, number, number] | null {
  if (result.width <= 0 || result.height <= 0) return null;
  const px = Math.min(result.width - 1, Math.max(0, Math.round(x)));
  const py = Math.min(result.height - 1, Math.max(0, Math.round(y)));
  const i = (py * result.width + px) * 4;
  if (result.via === 'float') {
    const arr = new Float32Array(result.data);
    if (i + 3 >= arr.length) return null;
    return [arr[i]!, arr[i + 1]!, arr[i + 2]!, arr[i + 3]!];
  }
  const arr = new Uint8Array(result.data);
  if (i + 3 >= arr.length) return null;
  return [arr[i]! / 255, arr[i + 1]! / 255, arr[i + 2]! / 255, arr[i + 3]! / 255];
}

export function createPaintToolHandler(app: AppCtx): ToolHandler {
  let activeTool: PaintTool | null = null;
  // MASKS block: true when the in-progress stroke is routed to a mask
  // asset (resolveStrokeTarget's 'mask' branch) rather than a layer's own
  // GPU raster source: down() decides this once per stroke, move()/up()
  // just need to remember which CPU/GPU path to keep feeding.
  let maskMode = false;

  async function pick(pt: ToolPoint): Promise<void> {
    const result = await app.engine.readback({
      region: { x: Math.round(pt.x), y: Math.round(pt.y), width: 1, height: 1 },
      via: 'float',
    });
    const rgba = sampleRgba(result, pt.x, pt.y);
    if (!rgba) return;
    // 'float' readback is the raw accumulator, which is OKLab (L, a, b,
    // straight alpha) per the buffer non-negotiable. No sRGB conversion here,
    // that would double-convert an already-OKLab value.
    const [L, a, b, alpha] = rgba;
    toolState.update((s) => ({ ...s, primary: [L, a, b, alpha] }));
  }

  return {
    down(pt, tool) {
      if (tool === 'picker') {
        void pick(pt);
        return;
      }
      if (!isPaintTool(tool)) return;
      const target = resolveStrokeTarget(app);
      const { brushSize, primary } = toolState.get();
      activeTool = tool;
      const size = tool === 'pencil' ? 1 : brushSize;
      if (target.kind === 'mask') {
        maskMode = true;
        beginMaskStroke(app, target.asset);
        maskStrokePoint(app, pt, size, primary, tool === 'eraser');
        return;
      }
      maskMode = false;
      app.engine.beginStroke({
        layer: layerId(target.layer),
        brush: 'round',
        size,
        color: primary,
        mode: tool === 'eraser' ? 'erase' : 'paint',
      });
      app.engine.strokePoint(pt);
    },
    move(pt) {
      if (!activeTool) return;
      if (maskMode) {
        const { brushSize, primary } = toolState.get();
        maskStrokePoint(app, pt, activeTool === 'pencil' ? 1 : brushSize, primary, activeTool === 'eraser');
        return;
      }
      app.engine.strokePoint(pt);
    },
    up(pt) {
      if (!activeTool) return;
      const tool = activeTool;
      activeTool = null;
      if (maskMode) {
        const { brushSize, primary } = toolState.get();
        maskStrokePoint(app, pt, tool === 'pencil' ? 1 : brushSize, primary, tool === 'eraser');
        commitMaskStroke(app, `${strokeLabel(tool)} Mask`);
        maskMode = false;
        return;
      }
      app.engine.strokePoint(pt);
      void commitStrokeEdits(app, strokeLabel(tool));
    },
  };
}

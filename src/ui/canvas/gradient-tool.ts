/**
 * Gradient tool: drag on the canvas -> a new core.gradient layer on top,
 * fromPt/toPt set to the drag vector normalized to [0,1] doc-uv (same space
 * core.gradient's WGSL samples `in.uv` in, see
 * engine/sources/builtin/gradient.ts). colorA/colorB default to the current
 * primary/secondary (already OKLab, no conversion). gradType stays 'linear'
 * from a drag; radial and re-tuning colors go through the auto-generated
 * params form (per src/ui/CLAUDE.md: no per-effect UI files), not this tool.
 */

import type { AppCtx } from '../../app/types';
import { layerId, identityTransform } from '@engine';
import { toolState, viewState } from '../../app/stores';
import { history } from '../../app/commands/app-history';
import { patchCommand } from '../../app/commands/command';
import type { ToolHandler, ToolPoint } from './viewport';

function normalized(pt: ToolPoint, width: number, height: number): [number, number] {
  return [width > 0 ? pt.x / width : 0, height > 0 ? pt.y / height : 0];
}

export function createGradientToolHandler(app: AppCtx): ToolHandler {
  let start: ToolPoint | null = null;

  return {
    down(pt, tool) {
      if (tool !== 'gradient') return;
      start = pt;
    },
    move() {
      // No live preview: commit happens once on release (see header).
    },
    up(pt, tool) {
      if (tool !== 'gradient' || !start) return;
      const from = start;
      start = null;
      if (Math.hypot(pt.x - from.x, pt.y - from.y) < 1) return; // click without drag: nothing to create

      const doc = app.engine.getDocument();
      const { width, height } = doc.canvas;
      const { primary, secondary } = toolState.get();
      const id = `gradient-${crypto.randomUUID().slice(0, 8)}`;

      history.push(app, patchCommand('New Gradient Layer', [{
        op: 'addLayer',
        parent: null,
        index: doc.layers.length,
        layer: {
          id: layerId(id),
          kind: 'layer',
          name: 'Gradient',
          enabled: true,
          source: {
            type: 'core.gradient',
            params: {
              fromPt: normalized(from, width, height),
              toPt: normalized(pt, width, height),
              colorA: primary,
              colorB: secondary,
              gradType: 'linear',
            },
          },
          chain: [],
          blendMode: 'normal',
          opacity: 1,
          transform: identityTransform(),
          liveness: 'baked',
        },
      }]));
      viewState.update((s) => ({ ...s, activeLayer: id }));
    },
  };
}

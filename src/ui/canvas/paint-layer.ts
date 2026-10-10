/**
 * Shared by every tool that paints onto the raster asset (brush/pencil/
 * eraser in paint-tool.ts, the Line tool in line-shapes-tool.ts): resolving
 * which layer a stroke lands on, and committing endStroke()'s unapplied
 * batch through patchCommand exactly once (see paint-tool.ts's header
 * comment for why a second applyEdits would corrupt commitRaster's undo).
 */

import type { AppCtx } from '../../app/types';
import { layerId, findLayer } from '@engine';
import { viewState } from '../../app/stores';
import { history } from '../../app/commands/app-history';
import { patchCommand } from '../../app/commands/command';

/**
 * Painting must never silently refuse (paint.net semantics): resolve the
 * stroke target to the active layer if it's a raster layer, else the topmost
 * raster layer, else create a fresh 'Paint' raster layer on top (one
 * undoable step) and make it active.
 */
export function resolvePaintLayer(app: AppCtx): string {
  const doc = app.engine.getDocument();
  const active = viewState.get().activeLayer;
  const isRaster = (id: string | null) =>
    id !== null &&
    doc.layers.some((l) => l.id === id && l.kind === 'layer' && l.source.type === 'core.raster');

  if (isRaster(active)) return active as string;

  const topmostRaster = [...doc.layers]
    .reverse()
    .find((l) => l.kind === 'layer' && l.source.type === 'core.raster');
  if (topmostRaster) {
    viewState.update((s) => ({ ...s, activeLayer: topmostRaster.id }));
    return topmostRaster.id;
  }

  const id = `paint-${crypto.randomUUID().slice(0, 8)}`;
  history.push(app, patchCommand('New Paint Layer', [{
    op: 'addLayer',
    parent: null,
    index: doc.layers.length,
    layer: {
      id: layerId(id),
      kind: 'layer',
      name: 'Paint',
      enabled: true,
      source: { type: 'core.raster', params: {} },
      chain: [],
      blendMode: 'normal',
      opacity: 1,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
      liveness: 'baked',
    },
  }]));
  viewState.update((s) => ({ ...s, activeLayer: id }));
  return id;
}

/**
 * MASKS block. What a brush/pencil/eraser stroke should land on: a real
 * layer's raster source (unchanged resolvePaintLayer behaviour) or, while
 * MASK EDIT MODE is active (viewState.maskEditing), that layer's mask
 * raster asset instead. This is the single routing decision every paint
 * tool consults. See mask-paint.ts for why a mask can't go through the
 * frozen StrokeConfig/beginStroke GPU path (masks aren't real layers) and
 * has its own CPU-side stroke commit instead.
 */
export type StrokeTarget = { kind: 'layer'; layer: string } | { kind: 'mask'; layer: string; asset: string };

export function resolveStrokeTarget(app: AppCtx): StrokeTarget {
  const editing = viewState.get().maskEditing;
  if (editing) {
    const doc = app.engine.getDocument();
    const found = findLayer(doc, layerId(editing));
    if (found && found.node.kind === 'layer' && found.node.mask) {
      return { kind: 'mask', layer: editing, asset: found.node.mask.asset };
    }
    // The layer (or its mask) vanished out from under an active edit session
    // (e.g. Remove Mask fired from the menu while still 'in' edit mode):
    // fall back to normal layer painting and exit mask mode defensively.
    viewState.update((s) => ({ ...s, maskEditing: null }));
  }
  return { kind: 'layer', layer: resolvePaintLayer(app) };
}

/** Commits endStroke()'s edit batch as one history entry under `label`;
 * no-ops if the stroke produced no edits (paint-tool.ts's existing
 * behaviour, mirrored here so Line does the same). */
export async function commitStrokeEdits(app: AppCtx, label: string): Promise<void> {
  const edits = await app.engine.endStroke();
  if (edits.length === 0) return;
  history.push(app, patchCommand(label, edits));
}

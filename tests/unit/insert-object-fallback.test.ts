// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { executeCommand, insertDraggedShape, insertTextAt } from '../../src/app/commands/registry';
import { applyEdits } from '../../src/engine/doc/document';
import { history } from '../../src/app/commands/app-history';
import { selectionState, viewState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, DocumentJSON, EngineHost } from '@engine';
import { layerId } from '@engine';

/** Real applyEdits (document.ts), not a stub: these tests exercise the
 * resolve-or-create chain's addLayer/addObject edits, so they need a
 * document that actually mutates (mirrors text-tool.test.ts's approach). */
function fakeEngine(doc: DocumentJSON): EngineHost {
  return {
    getDocument: () => doc,
    applyEdits: (edits: DocEdit[]) => applyEdits(doc, edits),
  } as unknown as EngineHost;
}

function emptyDoc(): DocumentJSON {
  return {
    version: 1,
    canvas: { width: 1280, height: 720, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [],
    postChain: [],
    assets: {},
  } as unknown as DocumentJSON;
}

function sceneOf(doc: DocumentJSON, layerId: string): { id: string }[] {
  const layer = doc.layers.find((l) => l.id === layerId) as unknown as { source: { params: { scene?: { id: string }[] } } };
  return layer.source.params.scene ?? [];
}

describe('object insertion never refuses (mirrors paint-layer.ts resolvePaintLayer)', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
  });

  it('active layer already a scene layer: inserts there directly, no extra layer created', () => {
    const doc = emptyDoc();
    doc.layers.push({
      id: layerId('scene-1'), kind: 'layer', name: 'Scene', enabled: true,
      source: { type: 'core.scene', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, liveness: 'live',
    });
    viewState.update((s) => ({ ...s, activeLayer: 'scene-1' }));
    const app: AppCtx = { engine: fakeEngine(doc) };

    executeCommand(app, 'object.insertRect');

    expect(doc.layers).toHaveLength(1);
    expect(sceneOf(doc, 'scene-1')).toHaveLength(1);
    expect(viewState.get().activeLayer).toBe('scene-1');
  });

  it('active layer is raster (e.g. just painted), but a scene layer exists elsewhere: falls back to the topmost scene layer and activates it', () => {
    const doc = emptyDoc();
    doc.layers.push(
      {
        id: layerId('scene-1'), kind: 'layer', name: 'Scene', enabled: true,
        source: { type: 'core.scene', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, liveness: 'live',
      },
      {
        id: layerId('paint-1'), kind: 'layer', name: 'Paint', enabled: true,
        source: { type: 'core.raster', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, liveness: 'baked',
      },
    );
    viewState.update((s) => ({ ...s, activeLayer: 'paint-1' })); // just painted
    const app: AppCtx = { engine: fakeEngine(doc) };

    const created = insertTextAt(app, { x: 100, y: 100 });

    expect(doc.layers).toHaveLength(2); // no new layer created
    expect(created.layer).toBe('scene-1');
    expect(sceneOf(doc, 'scene-1')).toHaveLength(1);
    expect(viewState.get().activeLayer).toBe('scene-1');
  });

  it('no scene layer anywhere: auto-creates one (its own undo step) and inserts into it', () => {
    const doc = emptyDoc();
    doc.layers.push({
      id: layerId('paint-1'), kind: 'layer', name: 'Paint', enabled: true,
      source: { type: 'core.raster', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, liveness: 'baked',
    });
    viewState.update((s) => ({ ...s, activeLayer: 'paint-1' }));
    const app: AppCtx = { engine: fakeEngine(doc) };

    insertDraggedShape(app, 'rect', { x: 10, y: 10, width: 50, height: 50 });

    expect(doc.layers).toHaveLength(2);
    const newLayer = doc.layers.find((l) => l.id !== 'paint-1')!;
    expect(newLayer.kind === 'layer' && newLayer.source.type).toBe('core.scene');
    expect(sceneOf(doc, newLayer.id)).toHaveLength(1);
    expect(viewState.get().activeLayer).toBe(newLayer.id);
    expect(history.entries().map((e) => e.label)).toEqual(['New Scene Layer', 'Insert Object']);
  });
});

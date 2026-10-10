// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { executeCommand } from '../../src/app/commands/registry';
import { applyEdits } from '../../src/engine/doc/document';
import { history } from '../../src/app/commands/app-history';
import { selectionState, toolState, viewState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, DocumentJSON, EngineHost, ObjectNode } from '@engine';
import { layerId } from '@engine';

function fakeEngine(doc: DocumentJSON): EngineHost {
  return {
    getDocument: () => doc,
    applyEdits: (edits: DocEdit[]) => applyEdits(doc, edits),
  } as unknown as EngineHost;
}

function docWithSceneLayer(): DocumentJSON {
  const doc = {
    version: 1,
    canvas: { width: 1280, height: 720, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [
      {
        id: layerId('scene-1'), kind: 'layer', name: 'Scene', enabled: true,
        source: { type: 'core.scene', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, liveness: 'live',
      },
    ],
    postChain: [],
    assets: {},
  } as unknown as DocumentJSON;
  return doc;
}

function sceneObjects(doc: DocumentJSON): ObjectNode[] {
  const layer = doc.layers[0] as unknown as { source: { params: { scene?: ObjectNode[] } } };
  return layer.source.params.scene ?? [];
}

describe('SHAPES block insert commands (object.insertPolygon/insertStar/insertRoundedRect)', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
    toolState.update((s) => ({ ...s, lastShape: 'rect' }));
    viewState.update((s) => ({ ...s, activeLayer: 'scene-1' }));
  });

  it('insertPolygon: hexagon default, sets toolState.lastShape', () => {
    const doc = docWithSceneLayer();
    const app: AppCtx = { engine: fakeEngine(doc) };

    executeCommand(app, 'object.insertPolygon');

    const [obj] = sceneObjects(doc);
    expect(obj!.content).toMatchObject({ type: 'shape', shape: { shape: 'polygon', sides: 6 } });
    expect(toolState.get().lastShape).toBe('polygon');
  });

  it('insertStar: 5-point star default, sets toolState.lastShape', () => {
    const doc = docWithSceneLayer();
    const app: AppCtx = { engine: fakeEngine(doc) };

    executeCommand(app, 'object.insertStar');

    const [obj] = sceneObjects(doc);
    expect(obj!.content).toMatchObject({ type: 'shape', shape: { shape: 'star', starPoints: 5, innerRatio: 0.5 } });
    expect(toolState.get().lastShape).toBe('star');
  });

  it('insertRoundedRect: radius-12 default, sets toolState.lastShape', () => {
    const doc = docWithSceneLayer();
    const app: AppCtx = { engine: fakeEngine(doc) };

    executeCommand(app, 'object.insertRoundedRect');

    const [obj] = sceneObjects(doc);
    expect(obj!.content).toMatchObject({ type: 'shape', shape: { shape: 'rounded-rect', radius: 12 } });
    expect(toolState.get().lastShape).toBe('rounded-rect');
  });
});

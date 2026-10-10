// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { createSelectToolHandler, mountSelectionOverlay } from '../../src/ui/canvas/select-tool';
import { selectionState, viewState } from '../../src/app/stores';
import { history } from '../../src/app/commands/app-history';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, EngineHost, HitResult } from '@engine';
import { layerId, objectId } from '@engine';

function sceneDoc() {
  return {
    version: 1,
    canvas: { width: 1280, height: 720, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [
      {
        id: 'scene-1',
        kind: 'layer',
        name: 'Scene',
        enabled: true,
        source: {
          type: 'core.scene',
          params: {
            scene: [
              // Bbox: (40,40)-(60,60), inside a 0..100 marquee.
              { id: 'obj-in', name: 'In', enabled: true, transform: { x: 50, y: 50, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, content: { type: 'shape', shape: { shape: 'rect', width: 20, height: 20 } }, style: {}, liveness: 'live' },
              // Bbox: (490,490)-(510,510), outside.
              { id: 'obj-out', name: 'Out', enabled: true, transform: { x: 500, y: 500, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, content: { type: 'shape', shape: { shape: 'rect', width: 20, height: 20 } }, style: {}, liveness: 'live' },
            ],
          },
        },
        chain: [],
        blendMode: 'normal',
        opacity: 1,
        transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
        liveness: 'baked',
      },
    ],
    postChain: [],
    assets: {},
  };
}

function fakeEngine(doc: ReturnType<typeof sceneDoc>, hits: HitResult[] = []) {
  let i = 0;
  const engine = {
    getDocument: () => doc,
    hitTest: async (): Promise<HitResult> => hits[i++] ?? { layer: null, object: null },
    applyEdits(edits: DocEdit[]): DocEdit[] { return edits; },
  } as unknown as EngineHost;
  return engine;
}

describe('select-tool marquee (select-rect/select-ellipse)', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
    viewState.update((s) => ({ ...s, activeLayer: 'scene-1' }));
  });

  it('drag shows a live marquee region, then resolves to overlapping objects on release', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const handler = createSelectToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'select-rect');
    handler.move({ x: 100, y: 100, pressure: 1 }, 'select-rect');
    expect(selectionState.get().marquee).toEqual({ x: 0, y: 0, width: 100, height: 100 });

    handler.up({ x: 100, y: 100, pressure: 1 }, 'select-rect');
    // The rect is kept (not nulled): edit.fillSelection needs it to
    // outlive the drag; only deselect paths clear it.
    expect(selectionState.get().marquee).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(selectionState.get().objects).toEqual(['obj-in']);
  });

  it('finds objects on a scene layer that is NOT active, and makes it active (the activeLayer-scoping bug painting first used to trigger)', () => {
    const doc = sceneDoc();
    // A second, currently-active layer that isn't a scene at all. Mirrors
    // painting a stroke, which reassigns activeLayer to the raster layer
    // (paint-layer.ts's resolvePaintLayer) and used to make marquees over
    // 'scene-1' resolve to nothing.
    doc.layers.push({
      id: 'paint-1', kind: 'layer', name: 'Paint', enabled: true,
      source: { type: 'core.raster', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, liveness: 'baked',
    } as unknown as (typeof doc.layers)[number]);
    viewState.update((s) => ({ ...s, activeLayer: 'paint-1' }));
    const app: AppCtx = { engine: fakeEngine(doc) };
    const handler = createSelectToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'select-rect');
    handler.up({ x: 100, y: 100, pressure: 1 }, 'select-rect');

    expect(selectionState.get().objects).toEqual(['obj-in']);
    expect(viewState.get().activeLayer).toBe('scene-1');
  });

  it('a release with ~zero drag distance deselects instead of selecting', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const handler = createSelectToolHandler(app);
    selectionState.set({ objects: ['obj-in'], marquee: null });

    handler.down({ x: 10, y: 10, pressure: 1 }, 'select-rect');
    handler.up({ x: 10, y: 10, pressure: 1 }, 'select-rect');

    expect(selectionState.get()).toEqual({ objects: [], marquee: null });
  });

  it('select-ellipse uses the same bbox marquee resolution as select-rect', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const handler = createSelectToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'select-ellipse');
    handler.up({ x: 100, y: 100, pressure: 1 }, 'select-ellipse');
    expect(selectionState.get().objects).toEqual(['obj-in']);
  });
});

describe('select-tool move-tool click activates the hit object\'s layer', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
  });

  it('activates the hit layer even when a different layer was active (engine.hitTest already searches every layer)', async () => {
    const doc = sceneDoc();
    doc.layers.push({
      id: 'paint-1', kind: 'layer', name: 'Paint', enabled: true,
      source: { type: 'core.raster', params: {} }, chain: [], blendMode: 'normal', opacity: 1,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, liveness: 'baked',
    } as unknown as (typeof doc.layers)[number]);
    viewState.update((s) => ({ ...s, activeLayer: 'paint-1' }));
    const hits: HitResult[] = [{ layer: layerId('scene-1'), object: objectId('obj-in') }];
    const app: AppCtx = { engine: fakeEngine(doc, hits) };
    const handler = createSelectToolHandler(app);

    handler.down({ x: 50, y: 50, pressure: 1 }, 'move');
    await Promise.resolve();
    await Promise.resolve();

    expect(selectionState.get().objects).toEqual(['obj-in']);
    expect(viewState.get().activeLayer).toBe('scene-1');
  });
});

describe('select-tool Escape deselects, Delete/Backspace deletes', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
  });

  it('Escape clears selectionState (pure deselect, never deletes)', () => {
    const app: AppCtx = { engine: fakeEngine(sceneDoc()) };
    createSelectToolHandler(app);
    selectionState.set({ objects: ['obj-in'], marquee: null });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(selectionState.get()).toEqual({ objects: [], marquee: null });
    expect(history.entries()).toHaveLength(0);
  });

  it('bare Delete/Backspace with objects selected removes them (via edit.deleteSelected) and clears selection', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    createSelectToolHandler(app);

    selectionState.set({ objects: ['obj-in'], marquee: null });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(selectionState.get()).toEqual({ objects: [], marquee: null });
    expect(history.entries()).toEqual([{ label: 'Delete Objects', current: true }]);

    selectionState.set({ objects: ['obj-in'], marquee: null });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
    expect(selectionState.get()).toEqual({ objects: [], marquee: null });
  });

  it('bare Delete with only a marquee (no objects) clears the marquee, not a deselect-flavoured no-op', () => {
    const app: AppCtx = { engine: fakeEngine(sceneDoc()) };
    createSelectToolHandler(app);
    selectionState.set({ objects: [], marquee: { x: 0, y: 0, width: 10, height: 10 } });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));

    expect(selectionState.get()).toEqual({ objects: [], marquee: null });
    expect(history.entries()).toHaveLength(0); // nothing to undo: no objects were touched
  });

  it('does not treat Ctrl+Shift+Delete (layer.delete) as the object-delete key', () => {
    const app: AppCtx = { engine: fakeEngine(sceneDoc()) };
    createSelectToolHandler(app);
    selectionState.set({ objects: ['obj-in'], marquee: null });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', ctrlKey: true, shiftKey: true }));

    expect(selectionState.get().objects).toEqual(['obj-in']);
    expect(history.entries()).toHaveLength(0);
  });

  it('does not fire while a text input has focus', () => {
    const app: AppCtx = { engine: fakeEngine(sceneDoc()) };
    createSelectToolHandler(app);
    const input = document.createElement('input');
    document.body.appendChild(input);
    selectionState.set({ objects: ['obj-in'], marquee: null });

    // Dispatched ON the input (bubbles to the window listener) so
    // e.target is the input, matching isTextEditingTarget's real check.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));

    expect(selectionState.get().objects).toEqual(['obj-in']);
    input.remove();
  });
});

describe('select-tool move-tool double-click', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
  });

  it('two completed clicks (down+up, no drag) on the same object within the window fire onObjectDoubleClick', async () => {
    const doc = sceneDoc();
    const hits: HitResult[] = [
      { layer: layerId('scene-1'), object: objectId('obj-in') },
      { layer: layerId('scene-1'), object: objectId('obj-in') },
    ];
    const app: AppCtx = { engine: fakeEngine(doc, hits) };
    let dbl: [string, string] | null = null;
    const handler = createSelectToolHandler(app, { onObjectDoubleClick: (layer, id) => { dbl = [layer, id]; } });

    handler.down({ x: 50, y: 50, pressure: 1 }, 'move');
    await Promise.resolve();
    await Promise.resolve();
    handler.up({ x: 50, y: 50, pressure: 1 }, 'move');
    expect(dbl).toBeNull();

    handler.down({ x: 50, y: 50, pressure: 1 }, 'move');
    await Promise.resolve();
    await Promise.resolve();
    handler.up({ x: 50, y: 50, pressure: 1 }, 'move');
    expect(dbl).toEqual(['scene-1', 'obj-in']);
  });

  it('a click immediately followed by a real drag does NOT fire onObjectDoubleClick, and the drag still moves the object', async () => {
    const doc = sceneDoc();
    const hits: HitResult[] = [
      { layer: layerId('scene-1'), object: objectId('obj-in') },
      { layer: layerId('scene-1'), object: objectId('obj-in') },
    ];
    const app: AppCtx = { engine: fakeEngine(doc, hits) };
    let dbl: [string, string] | null = null;
    const handler = createSelectToolHandler(app, { onObjectDoubleClick: (layer, id) => { dbl = [layer, id]; } });

    // First: a plain click (down+up, no movement) selects and records it.
    handler.down({ x: 50, y: 50, pressure: 1 }, 'move');
    await Promise.resolve();
    await Promise.resolve();
    handler.up({ x: 50, y: 50, pressure: 1 }, 'move');

    // Second: down again quickly, then an actual drag. Must move the
    // object, not be swallowed as a double-click (the regression this
    // guards against).
    handler.down({ x: 50, y: 50, pressure: 1 }, 'move');
    await Promise.resolve();
    await Promise.resolve();
    handler.move({ x: 90, y: 50, pressure: 1 }, 'move');
    handler.up({ x: 90, y: 50, pressure: 1 }, 'move');

    expect(dbl).toBeNull();
    expect(history.entries().some((e) => e.label === 'Move Object')).toBe(true);
  });
});

describe('select-tool move-tool shift-click toggle', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
  });

  it('shift+click on an unselected object ADDS it to the selection and activates its layer', async () => {
    const doc = sceneDoc();
    const hits: HitResult[] = [{ layer: layerId('scene-1'), object: objectId('obj-out') }];
    const app: AppCtx = { engine: fakeEngine(doc, hits) };
    const handler = createSelectToolHandler(app);
    selectionState.set({ objects: ['obj-in'], marquee: null });

    handler.down({ x: 500, y: 500, pressure: 1, shiftKey: true }, 'move');
    await Promise.resolve();
    await Promise.resolve();

    expect(selectionState.get().objects).toEqual(['obj-in', 'obj-out']);
    expect(viewState.get().activeLayer).toBe('scene-1');
  });

  it('shift+click on an already-selected object REMOVES it (toggle-off) without starting a drag', async () => {
    const doc = sceneDoc();
    const hits: HitResult[] = [{ layer: layerId('scene-1'), object: objectId('obj-in') }];
    const app: AppCtx = { engine: fakeEngine(doc, hits) };
    const handler = createSelectToolHandler(app);
    selectionState.set({ objects: ['obj-in', 'obj-out'], marquee: null });

    handler.down({ x: 50, y: 50, pressure: 1, shiftKey: true }, 'move');
    await Promise.resolve();
    await Promise.resolve();
    handler.move({ x: 90, y: 50, pressure: 1, shiftKey: true }, 'move');
    handler.up({ x: 90, y: 50, pressure: 1, shiftKey: true }, 'move');

    expect(selectionState.get().objects).toEqual(['obj-out']);
    // No drag was armed for the removed object, so no Move Object entry.
    expect(history.entries()).toHaveLength(0);
  });

  it('shift+click on empty space is a no-op: it does not clear the existing selection', async () => {
    const doc = sceneDoc();
    const hits: HitResult[] = [{ layer: null, object: null }];
    const app: AppCtx = { engine: fakeEngine(doc, hits) };
    const handler = createSelectToolHandler(app);
    selectionState.set({ objects: ['obj-in'], marquee: null });

    handler.down({ x: 900, y: 900, pressure: 1, shiftKey: true }, 'move');
    await Promise.resolve();
    await Promise.resolve();

    expect(selectionState.get().objects).toEqual(['obj-in']);
  });
});

describe('select-tool shift+marquee additivity', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
    viewState.update((s) => ({ ...s, activeLayer: 'scene-1' }));
  });

  it('shift+marquee ADDS newly-overlapped objects to the existing selection instead of replacing it', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const handler = createSelectToolHandler(app);
    selectionState.set({ objects: ['obj-in'], marquee: null });

    // Marquee around obj-out (490,490)-(510,510), well clear of obj-in.
    handler.down({ x: 480, y: 480, pressure: 1, shiftKey: true }, 'select-rect');
    handler.move({ x: 520, y: 520, pressure: 1, shiftKey: true }, 'select-rect');
    handler.up({ x: 520, y: 520, pressure: 1, shiftKey: true }, 'select-rect');

    expect(selectionState.get().objects.slice().sort()).toEqual(['obj-in', 'obj-out']);
  });

  it('a plain (non-shift) marquee still REPLACES the selection, including clearing it over empty space', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const handler = createSelectToolHandler(app);
    selectionState.set({ objects: ['obj-in'], marquee: null });

    // Empty region, no shift.
    handler.down({ x: 700, y: 700, pressure: 1 }, 'select-rect');
    handler.move({ x: 750, y: 750, pressure: 1 }, 'select-rect');
    handler.up({ x: 750, y: 750, pressure: 1 }, 'select-rect');

    expect(selectionState.get().objects).toEqual([]);
  });

  it('shift+click (tiny drag) with the marquee tool is additive-only: it does not clear the selection', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const handler = createSelectToolHandler(app);
    selectionState.set({ objects: ['obj-in'], marquee: null });

    handler.down({ x: 700, y: 700, pressure: 1, shiftKey: true }, 'select-rect');
    handler.up({ x: 700, y: 700, pressure: 1, shiftKey: true }, 'select-rect');

    expect(selectionState.get().objects).toEqual(['obj-in']);
  });
});

describe('select-tool marquee/click descend into enabled groups', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
  });

  function docWithGroupedScene() {
    const doc = sceneDoc();
    // Move the scene layer inside a group: objectsOverlapping/currentSelection
    // used to only look at the top-level doc.layers array and would silently
    // miss this (see src/ui/CLAUDE.md).
    const sceneLayer = doc.layers[0]!;
    doc.layers = [{ id: 'group-1', kind: 'group', name: 'Group', enabled: true, children: [sceneLayer] } as unknown as (typeof doc.layers)[number]];
    return doc;
  }

  it('marquee-select finds an object on a scene layer nested inside an enabled group', () => {
    const doc = docWithGroupedScene();
    const app: AppCtx = { engine: fakeEngine(doc) };
    const handler = createSelectToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'select-rect');
    handler.up({ x: 100, y: 100, pressure: 1 }, 'select-rect');

    expect(selectionState.get().objects).toEqual(['obj-in']);
    expect(viewState.get().activeLayer).toBe('scene-1');
  });
});

describe('mountSelectionOverlay: multi-selection', () => {
  function mountOverlay(doc: ReturnType<typeof sceneDoc>) {
    const region = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.style.width = '1280px';
    canvas.style.height = '720px';
    region.appendChild(canvas);
    document.body.appendChild(region);
    const engine = {
      getDocument: () => doc,
      on: () => () => {},
    } as unknown as EngineHost;
    const app: AppCtx = { engine };
    mountSelectionOverlay(app, region, canvas);
    return region;
  }

  beforeEach(() => {
    selectionState.set({ objects: [], marquee: null });
  });

  it('draws a box for every selected object, but interactive handles only on the primary (last) one', () => {
    const doc = sceneDoc();
    const region = mountOverlay(doc);
    selectionState.set({ objects: ['obj-in', 'obj-out'], marquee: null });

    const boxes = region.querySelectorAll('.gd-selection-box');
    expect(boxes).toHaveLength(2);
    const secondary = region.querySelectorAll('.gd-selection-box--secondary');
    expect(secondary).toHaveLength(1); // obj-in only: obj-out is primary
    // Handles exist (one per corner/edge) and only ever belong to the primary box.
    expect(region.querySelectorAll('.gd-selection-handle').length).toBeGreaterThan(0);

    region.remove();
  });

  it('a single selection still gets its own handles (unchanged behaviour)', () => {
    const doc = sceneDoc();
    const region = mountOverlay(doc);
    selectionState.set({ objects: ['obj-in'], marquee: null });

    expect(region.querySelectorAll('.gd-selection-box')).toHaveLength(1);
    expect(region.querySelectorAll('.gd-selection-box--secondary')).toHaveLength(0);
    expect(region.querySelectorAll('.gd-selection-handle').length).toBeGreaterThan(0);

    region.remove();
  });
});

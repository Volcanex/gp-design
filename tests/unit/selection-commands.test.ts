// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { executeCommand } from '../../src/app/commands/registry';
import { history } from '../../src/app/commands/app-history';
import { selectionState, viewState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import { applyEdits } from '../../src/engine/doc/document';
import type { DocEdit, DocumentJSON, EngineHost } from '@engine';

function sceneDoc(): DocumentJSON {
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
              { id: 'obj-a', name: 'A', enabled: true, transform: { x: 50, y: 50, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, content: { type: 'shape', shape: { shape: 'rect', width: 20, height: 20 } }, style: {}, liveness: 'live' },
              { id: 'obj-b', name: 'B', enabled: true, transform: { x: 500, y: 500, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 }, content: { type: 'shape', shape: { shape: 'rect', width: 20, height: 20 } }, style: {}, liveness: 'live' },
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
  } as unknown as DocumentJSON;
}

/** A real (not stubbed) applyEdits, so deleteSelected/nudge's effect on the
 * document (and its undo) can be asserted for real, not just "an edit was
 * constructed". */
function fakeEngine(doc: DocumentJSON) {
  const engine = {
    getDocument: () => doc,
    applyEdits: (edits: DocEdit[]) => applyEdits(doc, edits),
  } as unknown as EngineHost;
  return engine;
}

function sceneParams(doc: DocumentJSON) {
  const layer = doc.layers.find((l) => l.kind === 'layer' && l.source.type === 'core.scene') as unknown as
    { source: { params: { scene?: { id: string; transform: { x: number; y: number } }[] } } };
  // removeObject collapses the params.scene key entirely once the array
  // empties out (document.ts's lazy-creation mirror, so undo is a true
  // no-op). Treat "absent" the same as "empty" here.
  return layer.source.params.scene ?? [];
}

describe('edit.deleteSelected', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
  });

  it('with objects selected, removes them in one undo step (undo restores both)', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    selectionState.set({ objects: ['obj-a', 'obj-b'], marquee: null });

    executeCommand(app, 'edit.deleteSelected');

    expect(sceneParams(doc)).toHaveLength(0);
    expect(selectionState.get()).toEqual({ objects: [], marquee: null });
    expect(history.entries()).toEqual([{ label: 'Delete Objects', current: true }]);

    history.undo(app);
    expect(sceneParams(doc).map((o) => o.id).sort()).toEqual(['obj-a', 'obj-b']);
  });

  it('with only a marquee (no objects), clears the marquee and pushes no history', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    selectionState.set({ objects: [], marquee: { x: 0, y: 0, width: 10, height: 10 } });

    executeCommand(app, 'edit.deleteSelected');

    expect(selectionState.get()).toEqual({ objects: [], marquee: null });
    expect(sceneParams(doc)).toHaveLength(2); // nothing deleted
    expect(history.entries()).toHaveLength(0);
  });

  it('with nothing selected, no-ops', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    selectionState.set({ objects: [], marquee: null });

    executeCommand(app, 'edit.deleteSelected');

    expect(selectionState.get()).toEqual({ objects: [], marquee: null });
    expect(history.entries()).toHaveLength(0);
  });
});

describe('edit.selectAll', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
  });

  it('selects every scene object across every enabled scene layer', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };

    executeCommand(app, 'edit.selectAll');

    expect(selectionState.get().objects.slice().sort()).toEqual(['obj-a', 'obj-b']);
    expect(selectionState.get().marquee).toBeNull();
  });

  it('skips objects on a disabled scene layer', () => {
    const doc = sceneDoc();
    (doc.layers[0] as { enabled: boolean }).enabled = false;
    const app: AppCtx = { engine: fakeEngine(doc) };

    executeCommand(app, 'edit.selectAll');

    expect(selectionState.get().objects).toEqual([]);
  });
});

describe('edit.nudge', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
    viewState.update((s) => ({ ...s, activeLayer: 'scene-1' }));
  });

  it('moves every selected object by (dx, dy), one undo step covering all of them', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    selectionState.set({ objects: ['obj-a', 'obj-b'], marquee: null });

    executeCommand(app, 'edit.nudge', { dx: 1, dy: -10 });

    const byId = Object.fromEntries(sceneParams(doc).map((o) => [o.id, o.transform]));
    expect(byId['obj-a']).toMatchObject({ x: 51, y: 40 });
    expect(byId['obj-b']).toMatchObject({ x: 501, y: 490 });
    expect(history.entries()).toEqual([{ label: 'Nudge', current: true }]);

    history.undo(app);
    const restored = Object.fromEntries(sceneParams(doc).map((o) => [o.id, o.transform]));
    expect(restored['obj-a']).toMatchObject({ x: 50, y: 50 });
    expect(restored['obj-b']).toMatchObject({ x: 500, y: 500 });
  });

  it('each keypress is its own undo step (not merged into a burst)', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    selectionState.set({ objects: ['obj-a'], marquee: null });

    executeCommand(app, 'edit.nudge', { dx: 1, dy: 0 });
    executeCommand(app, 'edit.nudge', { dx: 1, dy: 0 });

    expect(history.entries()).toEqual([
      { label: 'Nudge', current: false },
      { label: 'Nudge', current: true },
    ]);
    expect(sceneParams(doc).find((o) => o.id === 'obj-a')!.transform).toMatchObject({ x: 52 });
  });

  it('does nothing with no selection', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };

    executeCommand(app, 'edit.nudge', { dx: 5, dy: 5 });

    expect(history.entries()).toHaveLength(0);
  });
});

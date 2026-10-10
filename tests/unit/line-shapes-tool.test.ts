// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { createLineShapesToolHandler } from '../../src/ui/canvas/line-shapes-tool';
import { history } from '../../src/app/commands/app-history';
import { toolState, viewState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, EngineHost, StrokeConfig, StrokePoint } from '@engine';

function fakeEngine(opts: { layers?: { id: string; sourceType: string }[]; endStrokeResult?: DocEdit[] } = {}) {
  const layers = (opts.layers ?? [{ id: 'paint-1', sourceType: 'core.raster' }]).map((l) => ({
    id: l.id, kind: 'layer', name: l.id, enabled: true,
    source: { type: l.sourceType, params: l.sourceType === 'core.scene' ? {} : {} },
    chain: [], blendMode: 'normal', opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'baked',
  }));
  const doc = { version: 1, canvas: { width: 1280, height: 720 }, clock: { fps: 30 }, layers, postChain: [], assets: {} };
  const calls: { begin: StrokeConfig[]; points: StrokePoint[] } = { begin: [], points: [] };
  const applied: DocEdit[][] = [];
  const endStrokeResult = opts.endStrokeResult ?? [{ op: 'setOpacity', id: 'x', value: 1 } as DocEdit];
  const engine = {
    getDocument: () => doc,
    beginStroke(c: StrokeConfig) { calls.begin.push(c); },
    strokePoint(p: StrokePoint) { calls.points.push(p); },
    async endStroke(): Promise<DocEdit[]> { return endStrokeResult; },
    applyEdits(edits: DocEdit[]): DocEdit[] { applied.push(edits); return edits; },
  } as unknown as EngineHost;
  return { engine, calls, applied, doc };
}

describe('line tool', () => {
  beforeEach(() => {
    history.clear();
    toolState.set({ active: 'line', brushSize: 10, primary: [0.5, 0, 0, 1], secondary: [1, 1, 1, 1], editing: 'primary', lastShape: 'rect' });
    viewState.update((s) => ({ ...s, activeLayer: 'paint-1' }));
  });

  it('down->up commits one straight stroke: beginStroke, interpolated points including both ends, endStroke, one undo step', async () => {
    const { engine, calls } = fakeEngine();
    const app: AppCtx = { engine };
    const handler = createLineShapesToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'line');
    handler.up({ x: 10, y: 0, pressure: 1 }, 'line');
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.begin).toHaveLength(1);
    expect(calls.begin[0]).toMatchObject({ layer: 'paint-1', brush: 'round', size: 10, mode: 'paint' });
    expect(calls.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(calls.points[calls.points.length - 1]).toMatchObject({ x: 10, y: 0 });
    expect(history.entries()).toEqual([{ label: 'Line', current: true }]);
  });

  it('does nothing on move (no live preview) and nothing without a prior down', () => {
    const { engine, calls } = fakeEngine();
    const app: AppCtx = { engine };
    const handler = createLineShapesToolHandler(app);

    handler.move({ x: 5, y: 5, pressure: 1 }, 'line');
    handler.up({ x: 5, y: 5, pressure: 1 }, 'line');

    expect(calls.begin).toHaveLength(0);
  });
});

describe('shapes tool', () => {
  beforeEach(() => {
    history.clear();
    viewState.update((s) => ({ ...s, activeLayer: 'scene-1' }));
    toolState.update((s) => ({ ...s, lastShape: 'rect' }));
  });

  it('drag inserts a scene rect object sized/positioned to the drag rectangle, selects it, one undo step', () => {
    const { engine, applied } = fakeEngine({ layers: [{ id: 'scene-1', sourceType: 'core.scene' }] });
    const app: AppCtx = { engine };
    const handler = createLineShapesToolHandler(app);

    handler.down({ x: 100, y: 100, pressure: 1 }, 'shapes');
    handler.up({ x: 300, y: 250, pressure: 1 }, 'shapes');

    expect(applied).toHaveLength(1);
    const edit = applied[0]![0] as Extract<DocEdit, { op: 'addObject' }>;
    expect(edit.op).toBe('addObject');
    expect(edit.object.content).toMatchObject({ type: 'shape', shape: { shape: 'rect', width: 200, height: 150 } });
    expect(edit.object.transform).toMatchObject({ x: 200, y: 175 }); // centre of the drag rect
    expect(history.entries()).toEqual([{ label: 'Insert Object', current: true }]);
  });

  it('a release with ~zero drag distance inserts nothing', () => {
    const { engine, applied } = fakeEngine({ layers: [{ id: 'scene-1', sourceType: 'core.scene' }] });
    const app: AppCtx = { engine };
    const handler = createLineShapesToolHandler(app);

    handler.down({ x: 100, y: 100, pressure: 1 }, 'shapes');
    handler.up({ x: 100, y: 100, pressure: 1 }, 'shapes');

    expect(applied).toHaveLength(0);
  });

  it('inserts whichever shape kind toolState.lastShape holds (set by the Insert menu, not a cycle gesture)', () => {
    toolState.update((s) => ({ ...s, lastShape: 'star' }));
    const { engine, applied } = fakeEngine({ layers: [{ id: 'scene-1', sourceType: 'core.scene' }] });
    const app: AppCtx = { engine };
    const handler = createLineShapesToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'shapes');
    handler.up({ x: 100, y: 100, pressure: 1 }, 'shapes');

    const edit = applied[0]![0] as Extract<DocEdit, { op: 'addObject' }>;
    expect(edit.object.content).toMatchObject({ type: 'shape', shape: { shape: 'star', starPoints: 5, innerRatio: 0.5 } });
  });
});

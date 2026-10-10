import { describe, it, expect, beforeEach } from 'vitest';
import { createPaintToolHandler } from '../../src/ui/canvas/paint-tool';
import { toolState, viewState } from '../../src/app/stores';
import { history } from '../../src/app/commands/app-history';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, EngineHost, ReadbackResult, StrokeConfig, StrokePoint } from '@engine';
import { layerId } from '@engine';

function fakeEngine(opts: { layers?: { id: string; sourceType: string }[] } = {}) {
  const calls: { begin: StrokeConfig[]; points: StrokePoint[]; ended: number } = { begin: [], points: [], ended: 0 };
  let endStrokeResult: DocEdit[] = [];
  let readbackResult: ReadbackResult = { width: 1, height: 1, data: new ArrayBuffer(16), via: 'float' };
  const layers = (opts.layers ?? [{ id: 'layer-1', sourceType: 'core.raster' }]).map((l) => ({
    id: l.id,
    kind: 'layer',
    name: l.id,
    enabled: true,
    source: { type: l.sourceType, params: {} },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'baked',
  }));
  const doc = { version: 1, canvas: {}, clock: { fps: 30 }, layers, postChain: [], assets: {} };
  const applied: DocEdit[][] = [];
  const engine = {
    getDocument: () => doc,
    beginStroke(config: StrokeConfig) { calls.begin.push(config); },
    strokePoint(p: StrokePoint) { calls.points.push(p); },
    async endStroke(): Promise<DocEdit[]> { calls.ended += 1; return endStrokeResult; },
    applyEdits(edits: DocEdit[]): DocEdit[] {
      // Mirrors document.ts's contract closely enough for history bookkeeping:
      // any edit is its own trivial inverse for these tests.
      applied.push(edits);
      return edits;
    },
    async readback(): Promise<ReadbackResult> { return readbackResult; },
  } as unknown as EngineHost;
  return {
    engine,
    calls,
    applied,
    setEndStrokeResult: (edits: DocEdit[]) => { endStrokeResult = edits; },
    setReadbackResult: (r: ReadbackResult) => { readbackResult = r; },
  };
}

describe('paint-tool handler', () => {
  beforeEach(() => {
    history.clear();
    toolState.set({ active: 'brush', brushSize: 24, primary: [0.6, 0.1, -0.05, 1], secondary: [1, 0, 0, 1], editing: 'primary' });
    viewState.set({ zoom: 1, panX: 0, panY: 0, activeLayer: 'layer-1', collapsedGroups: [], maskEditing: null });
  });

  it('down -> move -> up sequences beginStroke, strokePoint per event, endStroke, and pushes one history entry', async () => {
    const { engine, calls, setEndStrokeResult } = fakeEngine();
    const edit: DocEdit = { op: 'setOpacity', id: layerId('layer-1'), value: 1 };
    setEndStrokeResult([edit]);
    const app: AppCtx = { engine };
    const handler = createPaintToolHandler(app);

    handler.down({ x: 1, y: 2, pressure: 1 }, 'brush');
    handler.move({ x: 3, y: 4, pressure: 1 }, 'brush');
    handler.move({ x: 5, y: 6, pressure: 1 }, 'brush');
    handler.up({ x: 7, y: 8, pressure: 1 }, 'brush');

    // endStroke() is awaited internally. Flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.begin).toHaveLength(1);
    expect(calls.begin[0]).toMatchObject({ layer: 'layer-1', brush: 'round', size: 24, mode: 'paint' });
    // down + 2 move + up = 4 points.
    expect(calls.points).toHaveLength(4);
    expect(calls.ended).toBe(1);
    expect(history.entries()).toEqual([{ label: 'Brush', current: true }]);
  });

  it('pencil forces brush size to 1 and eraser sets mode to erase', () => {
    const { engine, calls } = fakeEngine();
    const app: AppCtx = { engine };
    const handler = createPaintToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'pencil');
    handler.up({ x: 0, y: 0, pressure: 1 }, 'pencil');
    handler.down({ x: 0, y: 0, pressure: 1 }, 'eraser');
    handler.up({ x: 0, y: 0, pressure: 1 }, 'eraser');

    expect(calls.begin[0]).toMatchObject({ size: 1, mode: 'paint' });
    expect(calls.begin[1]).toMatchObject({ mode: 'erase' });
  });

  it('with no active layer, routes the stroke to the topmost raster layer', () => {
    viewState.update((s) => ({ ...s, activeLayer: null }));
    const { engine, calls } = fakeEngine({
      layers: [
        { id: 'bg', sourceType: 'core.solid' },
        { id: 'paint-a', sourceType: 'core.raster' },
        { id: 'paint-b', sourceType: 'core.raster' },
      ],
    });
    const app: AppCtx = { engine };
    const handler = createPaintToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'brush');
    expect(calls.begin).toHaveLength(1);
    expect(calls.begin[0]).toMatchObject({ layer: 'paint-b' });
    expect(viewState.get().activeLayer).toBe('paint-b');
  });

  it('with no raster layer anywhere, auto-creates one (one history step) and strokes it', () => {
    viewState.update((s) => ({ ...s, activeLayer: null }));
    const { engine, calls, applied } = fakeEngine({
      layers: [{ id: 'bg', sourceType: 'core.solid' }],
    });
    const app: AppCtx = { engine };
    const handler = createPaintToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'brush');
    expect(applied).toHaveLength(1);
    expect(applied[0]![0]).toMatchObject({ op: 'addLayer' });
    expect(history.entries()).toEqual([{ label: 'New Paint Layer', current: true }]);
    expect(calls.begin).toHaveLength(1);
    expect(calls.begin[0]!.layer).toBe(viewState.get().activeLayer);
  });

  it('does not push a history entry when endStroke returns no edits', async () => {
    const { engine } = fakeEngine();
    const app: AppCtx = { engine };
    const handler = createPaintToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'brush');
    handler.up({ x: 0, y: 0, pressure: 1 }, 'brush');
    await Promise.resolve();
    await Promise.resolve();

    expect(history.entries()).toHaveLength(0);
  });

  it('picker reads back the pixel under the cursor as-is into primary (float readback is already OKLab)', async () => {
    const { engine, setReadbackResult } = fakeEngine();
    const width = 4, height = 4;
    const data = new Float32Array(width * height * 4);
    const px = 2, py = 1;
    const i = (py * width + px) * 4;
    // Buffers hold OKLab (L, a, b, straight alpha): the readback contract,
    // not sRGB. The picker must use these components directly.
    data[i] = 0.62; data[i + 1] = 0.08; data[i + 2] = -0.04; data[i + 3] = 0.75;
    setReadbackResult({ width, height, data: data.buffer, via: 'float' });

    const app: AppCtx = { engine };
    const handler = createPaintToolHandler(app);
    handler.down({ x: px, y: py, pressure: 1 }, 'picker');
    await Promise.resolve();
    await Promise.resolve();

    const primary = toolState.get().primary;
    expect(primary[0]).toBeCloseTo(0.62);
    expect(primary[1]).toBeCloseTo(0.08);
    expect(primary[2]).toBeCloseTo(-0.04);
    expect(primary[3]).toBeCloseTo(0.75);
  });

  it('picker does not begin a paint stroke', () => {
    const { engine, calls } = fakeEngine();
    const app: AppCtx = { engine };
    const handler = createPaintToolHandler(app);
    handler.down({ x: 0, y: 0, pressure: 1 }, 'picker');
    expect(calls.begin).toHaveLength(0);
  });
});

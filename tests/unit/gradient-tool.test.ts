import { describe, it, expect, beforeEach } from 'vitest';
import { createGradientToolHandler } from '../../src/ui/canvas/gradient-tool';
import { history } from '../../src/app/commands/app-history';
import { toolState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, EngineHost } from '@engine';

function fakeEngine() {
  const doc = {
    version: 1,
    canvas: { width: 1280, height: 720, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [] as unknown[],
    postChain: [],
    assets: {},
  };
  const applied: DocEdit[][] = [];
  const engine = {
    getDocument: () => doc,
    applyEdits(edits: DocEdit[]): DocEdit[] { applied.push(edits); return edits; },
  } as unknown as EngineHost;
  return { engine, doc, applied };
}

describe('gradient tool', () => {
  beforeEach(() => {
    history.clear();
    toolState.set({ active: 'gradient', brushSize: 24, primary: [0.6, 0.1, -0.05, 1], secondary: [1, 0, 0, 1], editing: 'primary' });
  });

  it('drag maps fromPt/toPt to normalized [0,1] doc-uv and creates one core.gradient layer', () => {
    const { engine, applied } = fakeEngine();
    const app: AppCtx = { engine };
    const handler = createGradientToolHandler(app);

    handler.down({ x: 256, y: 360, pressure: 1 }, 'gradient'); // 0.2, 0.5
    handler.up({ x: 1024, y: 360, pressure: 1 }, 'gradient'); // 0.8, 0.5

    expect(applied).toHaveLength(1);
    const edit = applied[0]![0] as Extract<DocEdit, { op: 'addLayer' }>;
    expect(edit.op).toBe('addLayer');
    if (edit.layer.kind !== 'layer') throw new Error('expected a Layer, not a group');
    const { source } = edit.layer;
    expect(source.type).toBe('core.gradient');
    expect(source.params.fromPt).toEqual([0.2, 0.5]);
    expect(source.params.toPt).toEqual([0.8, 0.5]);
    expect(source.params.colorA).toEqual([0.6, 0.1, -0.05, 1]);
    expect(source.params.colorB).toEqual([1, 0, 0, 1]);
    expect(source.params.gradType).toBe('linear');
    expect(history.entries()).toEqual([{ label: 'New Gradient Layer', current: true }]);
  });

  it('a release with ~zero drag distance creates nothing', () => {
    const { engine, applied } = fakeEngine();
    const app: AppCtx = { engine };
    const handler = createGradientToolHandler(app);

    handler.down({ x: 100, y: 100, pressure: 1 }, 'gradient');
    handler.up({ x: 100, y: 100, pressure: 1 }, 'gradient');

    expect(applied).toHaveLength(0);
    expect(history.entries()).toHaveLength(0);
  });

  it('ignores down/up for any other tool', () => {
    const { engine, applied } = fakeEngine();
    const app: AppCtx = { engine };
    const handler = createGradientToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'move');
    handler.up({ x: 500, y: 500, pressure: 1 }, 'move');

    expect(applied).toHaveLength(0);
  });
});

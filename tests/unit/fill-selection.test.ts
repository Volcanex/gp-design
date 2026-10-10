import { describe, it, expect, beforeEach } from 'vitest';
import { executeCommand } from '../../src/app/commands/registry';
import { history } from '../../src/app/commands/app-history';
import { selectionState, toolState, viewState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, EngineHost, StrokeConfig, StrokePoint } from '@engine';

function fakeEngine(opts: { layers?: { id: string; sourceType: string }[]; endStrokeResult?: DocEdit[] } = {}) {
  const layers = (opts.layers ?? [{ id: 'paint-1', sourceType: 'core.raster' }]).map((l) => ({
    id: l.id, kind: 'layer', name: l.id, enabled: true,
    source: { type: l.sourceType, params: {} }, chain: [], blendMode: 'normal', opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'baked',
  }));
  const doc = { version: 1, canvas: { width: 1280, height: 720 }, clock: { fps: 30 }, layers, postChain: [], assets: {} };
  const calls: { begin: StrokeConfig[]; points: StrokePoint[] } = { begin: [], points: [] };
  const endStrokeResult = opts.endStrokeResult ?? [{ op: 'setOpacity', id: 'x', value: 1 } as DocEdit];
  const engine = {
    getDocument: () => doc,
    beginStroke(c: StrokeConfig) { calls.begin.push(c); },
    strokePoint(p: StrokePoint) { calls.points.push(p); },
    async endStroke(): Promise<DocEdit[]> { return endStrokeResult; },
    applyEdits(edits: DocEdit[]): DocEdit[] { return edits; },
  } as unknown as EngineHost;
  return { engine, calls };
}

describe('edit.fillSelection', () => {
  beforeEach(() => {
    history.clear();
    toolState.set({ active: 'select-rect', brushSize: 20, primary: [0.7, 0, 0, 1], secondary: [1, 1, 1, 1], editing: 'primary' });
    viewState.update((s) => ({ ...s, activeLayer: 'paint-1' }));
  });

  it('with a marquee, stamps a round-brush grid across the rect on the raster layer and pushes one undo step', async () => {
    const { engine, calls } = fakeEngine();
    const app: AppCtx = { engine };
    selectionState.set({ objects: [], marquee: { x: 0, y: 0, width: 40, height: 40 } });

    executeCommand(app, 'edit.fillSelection');
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.begin).toHaveLength(1);
    expect(calls.begin[0]).toMatchObject({ layer: 'paint-1', brush: 'round', color: [0.7, 0, 0, 1], mode: 'paint' });
    expect(calls.points.length).toBeGreaterThan(1);
    // Every stamped point stays within the selection rect.
    for (const p of calls.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(40);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(40);
    }
    expect(history.entries()).toEqual([{ label: 'Fill Selection', current: true }]);
  });

  it('does nothing without a marquee selection', async () => {
    const { engine, calls } = fakeEngine();
    const app: AppCtx = { engine };
    selectionState.set({ objects: [], marquee: null });

    executeCommand(app, 'edit.fillSelection');
    await Promise.resolve();

    expect(calls.begin).toHaveLength(0);
    expect(history.entries()).toHaveLength(0);
  });
});

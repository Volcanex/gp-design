import { describe, it, expect, beforeEach } from 'vitest';
import { createBucketToolHandler } from '../../src/ui/canvas/bucket-tool';
import { toolState, viewState, selectionState } from '../../src/app/stores';
import { history } from '../../src/app/commands/app-history';
import type { AppCtx } from '../../src/app/types';
import type { AssetJSON, DocEdit, EngineHost } from '@engine';
import { encodeRgba16f } from '../../src/ui/canvas/raster-codec';

function fakeEngine(opts: {
  layers?: { id: string; sourceType: string; assetRef?: string }[];
  assets?: Record<string, AssetJSON>;
  width?: number;
  height?: number;
} = {}) {
  const layers = (opts.layers ?? [{ id: 'paint-1', sourceType: 'core.raster' }]).map((l) => ({
    id: l.id,
    kind: 'layer',
    name: l.id,
    enabled: true,
    source: { type: l.sourceType, params: l.assetRef ? { asset: { asset: l.assetRef } } : {} },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'baked',
  }));
  const doc = {
    version: 1,
    canvas: { width: opts.width ?? 4, height: opts.height ?? 4, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers,
    postChain: [],
    assets: opts.assets ?? {},
  };
  const applied: DocEdit[][] = [];
  const engine = {
    getDocument: () => doc,
    applyEdits(edits: DocEdit[]): DocEdit[] {
      applied.push(edits);
      return edits;
    },
  } as unknown as EngineHost;
  return { engine, doc, applied };
}

describe('bucket tool handler', () => {
  beforeEach(() => {
    history.clear();
    toolState.set({
      active: 'bucket', brushSize: 24, primary: [0.9, 0, 0, 1], secondary: [1, 0, 0, 1],
      editing: 'primary', bucketTolerance: 0.05,
    });
    viewState.set({ zoom: 1, panX: 0, panY: 0, activeLayer: 'paint-1', collapsedGroups: [] });
    selectionState.set({ objects: [], marquee: null });
  });

  it('ignores clicks for tools other than bucket', () => {
    const { engine, applied } = fakeEngine();
    const app: AppCtx = { engine };
    const handler = createBucketToolHandler(app);
    handler.down({ x: 0, y: 0, pressure: 1 }, 'brush');
    expect(applied).toHaveLength(0);
  });

  it('on a layer with no raster asset yet, adds an asset + setParam + commitRaster as one history entry', () => {
    const { engine, applied } = fakeEngine();
    const app: AppCtx = { engine };
    const handler = createBucketToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'bucket');

    expect(applied).toHaveLength(1);
    const edits = applied[0]!;
    expect(edits.map((e) => e.op)).toEqual(['addAsset', 'setParam', 'commitRaster']);
    const commit = edits[2] as Extract<DocEdit, { op: 'commitRaster' }>;
    // Transparent 4x4 canvas -> whole-canvas fill.
    expect(commit.region).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(history.entries()).toEqual([{ label: 'Bucket Fill', current: true }]);
  });

  it('on a layer with an existing raster asset, commits a single commitRaster edit scoped to the flood region', () => {
    const width = 4, height = 4;
    // Solid existing colour everywhere except column x=2..3, which differs enough to stop the fill.
    const pixels = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const different = x >= 2;
        pixels[i] = different ? 0.1 : 0.5;
        pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 1;
      }
    }
    const asset: AssetJSON = { type: 'raster', data: encodeRgba16f(pixels), width, height };
    const { engine, applied } = fakeEngine({
      layers: [{ id: 'paint-1', sourceType: 'core.raster', assetRef: 'raster-1' }],
      assets: { 'raster-1': asset },
      width, height,
    });
    const app: AppCtx = { engine };
    const handler = createBucketToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'bucket');

    expect(applied).toHaveLength(1);
    const edits = applied[0]!;
    expect(edits).toHaveLength(1);
    expect(edits[0]!.op).toBe('commitRaster');
    const commit = edits[0] as Extract<DocEdit, { op: 'commitRaster' }>;
    expect(commit.asset).toBe('raster-1');
    expect(commit.region.width).toBe(2); // stops before the differing column
  });

  it('does nothing (no history entry) when the seed is outside the current marquee selection', () => {
    selectionState.set({ objects: [], marquee: { x: 2, y: 2, width: 1, height: 1 } });
    const { engine, applied } = fakeEngine();
    const app: AppCtx = { engine };
    const handler = createBucketToolHandler(app);

    handler.down({ x: 0, y: 0, pressure: 1 }, 'bucket');

    expect(applied).toHaveLength(0);
    expect(history.entries()).toHaveLength(0);
  });
});

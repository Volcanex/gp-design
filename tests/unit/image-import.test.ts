import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppCtx } from '../../src/app/types';
import type { AssetJSON, DocEdit, DocumentJSON, EngineHost, LayerNode, ObjectNode } from '@engine';
import { selectionState, toolState, viewState } from '../../src/app/stores';

/**
 * Mirrors video-import.test.ts's fakeApp shape: a minimal EngineHost stub
 * that just records the edit batch importImageAsLayer builds, rather than
 * a real applyEdits. This is a unit test of the edit-batch/fit-math
 * contract, not of document.ts's addObject/addAsset mutation (covered
 * elsewhere). Real GPU rendering of the resulting object is exercised by
 * tests/e2e/image-object.spec.ts.
 */
function fakeApp(canvasWidth = 1280, canvasHeight = 720): { app: AppCtx; edits: DocEdit[] } {
  const doc: DocumentJSON = {
    version: 1,
    canvas: { width: canvasWidth, height: canvasHeight, workingFormat: 'rgba16float', outputColorSpace: 'srgb' },
    clock: { fps: 30 },
    layers: [],
    postChain: [],
    assets: {},
  };
  const edits: DocEdit[] = [];
  const engine = {
    getDocument: () => doc,
    applyEdits: (batch: DocEdit[]) => {
      edits.push(...batch);
      return [];
    },
  } as unknown as EngineHost;
  return { app: { engine }, edits };
}

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  viewState.set({ zoom: 1, panX: 0, panY: 0, activeLayer: null, collapsedGroups: [] });
  selectionState.set({ objects: [], marquee: null });
  toolState.update((s) => ({ ...s, active: 'brush' }));
});

function stubBitmap(width: number, height: number): void {
  (createImageBitmap as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    width, height, close: () => {},
  });
}

describe('importImageAsLayer', () => {
  it('smaller than canvas: builds addAsset + a core.scene layer + one image object at native size, centred', async () => {
    const { importImageAsLayer } = await import('../../src/app/commands/image-import');
    stubBitmap(200, 100);
    const { app, edits } = fakeApp(1280, 720);

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await importImageAsLayer(app, blob, 'photo');

    expect(edits).toHaveLength(3);
    const [addAsset, addLayer, addObject] = edits;

    expect(addAsset!.op).toBe('addAsset');
    if (addAsset!.op !== 'addAsset') throw new Error('unreachable');
    expect(addAsset!.asset).toMatchObject({ type: 'image', width: 200, height: 100 });

    expect(addLayer!.op).toBe('addLayer');
    if (addLayer!.op !== 'addLayer') throw new Error('unreachable');
    const layer = addLayer!.layer as LayerNode;
    expect(layer.kind).toBe('layer');
    if (layer.kind !== 'layer') throw new Error('unreachable');
    expect(layer.source).toEqual({ type: 'core.scene', params: {} });
    expect(layer.liveness).toBe('live');

    expect(addObject!.op).toBe('addObject');
    if (addObject!.op !== 'addObject') throw new Error('unreachable');
    expect(addObject!.layer).toBe(layer.id);
    const object = addObject!.object as ObjectNode;
    expect(object.content).toEqual({ type: 'image', asset: addAsset!.id });
    // Smaller than the canvas -> unscaled (native size via the content box).
    expect(object.transform.scaleX).toBe(1);
    expect(object.transform.scaleY).toBe(1);
    expect(object.transform.x).toBe(640);
    expect(object.transform.y).toBe(360);
    expect(object.transform.anchorX).toBe(0.5);
    expect(object.transform.anchorY).toBe(0.5);
  });

  it('larger than canvas: scales down uniformly (contain-fit), preserving aspect', async () => {
    const { importImageAsLayer } = await import('../../src/app/commands/image-import');
    // 2000x1000 image (2:1) into a 1000x1000 canvas -> width is the limiting
    // axis, scale = 0.5, so fitted 1000x500, NOT stretched to 1000x1000.
    stubBitmap(2000, 1000);
    const { app, edits } = fakeApp(1000, 1000);

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await importImageAsLayer(app, blob, 'big-photo');

    const addObject = edits.find((e) => e.op === 'addObject');
    if (!addObject || addObject.op !== 'addObject') throw new Error('no addObject edit');
    const object = addObject.object as ObjectNode;
    expect(object.transform.scaleX).toBeCloseTo(0.5);
    expect(object.transform.scaleY).toBeCloseTo(0.5);
    // Uniform scale -> aspect preserved (never a different X vs Y scale).
    expect(object.transform.scaleX).toBe(object.transform.scaleY);
  });

  it('never upscales a tall-aspect image beyond native size on the short axis', async () => {
    const { importImageAsLayer } = await import('../../src/app/commands/image-import');
    // Tall image (100x2000) into an 800x600 canvas: height overflows (2000 >
    // 600) but width doesn't (100 < 800). Scale is capped by the height
    // ratio, not clamped separately per axis (that would skew aspect).
    stubBitmap(100, 2000);
    const { app, edits } = fakeApp(800, 600);

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await importImageAsLayer(app, blob, 'tall-photo');

    const addObject = edits.find((e) => e.op === 'addObject');
    if (!addObject || addObject.op !== 'addObject') throw new Error('no addObject edit');
    const object = addObject.object as ObjectNode;
    const expectedScale = 600 / 2000;
    expect(object.transform.scaleX).toBeCloseTo(expectedScale);
    expect(object.transform.scaleY).toBeCloseTo(expectedScale);
  });

  it('selects the new object and switches to the move tool so the next drag moves it', async () => {
    const { importImageAsLayer } = await import('../../src/app/commands/image-import');
    stubBitmap(50, 50);
    const { app, edits } = fakeApp();
    toolState.update((s) => ({ ...s, active: 'brush' }));

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await importImageAsLayer(app, blob, 'photo');

    const addObject = edits.find((e) => e.op === 'addObject');
    if (!addObject || addObject.op !== 'addObject') throw new Error('no addObject edit');
    const object = addObject.object as ObjectNode;

    expect(selectionState.get().objects).toEqual([object.id]);
    expect(toolState.get().active).toBe('move');
    const addLayer = edits.find((e) => e.op === 'addLayer');
    if (!addLayer || addLayer.op !== 'addLayer') throw new Error('no addLayer edit');
    expect(viewState.get().activeLayer).toBe(addLayer.layer.id);
  });

  it('is one undo step: applyEdits is called exactly once with all three edits', async () => {
    const { importImageAsLayer } = await import('../../src/app/commands/image-import');
    stubBitmap(50, 50);
    const doc: DocumentJSON = {
      version: 1,
      canvas: { width: 1280, height: 720, workingFormat: 'rgba16float', outputColorSpace: 'srgb' },
      clock: { fps: 30 },
      layers: [],
      postChain: [],
      assets: {},
    };
    const applyEdits = vi.fn((_batch: DocEdit[]) => [] as DocEdit[]);
    const engine = { getDocument: () => doc, applyEdits } as unknown as EngineHost;
    const app: AppCtx = { engine };

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await importImageAsLayer(app, blob, 'photo');

    expect(applyEdits).toHaveBeenCalledTimes(1);
    expect(applyEdits.mock.calls[0]![0]).toHaveLength(3);
  });
});

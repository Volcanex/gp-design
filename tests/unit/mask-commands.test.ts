import { describe, it, expect, beforeEach } from 'vitest';
import { executeCommand } from '../../src/app/commands/registry';
import { viewState } from '../../src/app/stores';
import { history } from '../../src/app/commands/app-history';
import { whiteMaskBytes } from '../../src/ui/canvas/mask-paint';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, DocumentJSON } from '@engine';

const rasterLayer = (id: string, mask?: { asset: string; enabled: boolean; invert: boolean }) => ({
  id,
  kind: 'layer',
  name: id,
  enabled: true,
  source: { type: 'core.raster', params: {} },
  chain: [],
  blendMode: 'normal',
  opacity: 1,
  transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
  liveness: 'baked',
  ...(mask ? { mask } : {}),
});

function fakeApp(doc: DocumentJSON): { app: AppCtx; applied: DocEdit[][] } {
  const applied: DocEdit[][] = [];
  const app = {
    engine: {
      getDocument: () => doc,
      applyEdits(edits: DocEdit[]): DocEdit[] {
        applied.push(edits);
        // Apply setMask/addAsset in-place well enough for these tests to
        // observe the resulting document state, mirroring document.ts's
        // real semantics closely (not a full reimplementation).
        for (const edit of edits) {
          if (edit.op === 'addAsset') doc.assets[edit.id] = edit.asset;
          if (edit.op === 'setMask') {
            const layer = doc.layers.find((l: any) => l.id === edit.id) as any;
            if (layer) { if (edit.mask === null) delete layer.mask; else layer.mask = edit.mask; }
          }
        }
        return edits;
      },
    },
  } as unknown as AppCtx;
  return { app, applied };
}

describe('MASKS block: layer.* mask commands', () => {
  beforeEach(() => {
    history.clear();
    viewState.set({ zoom: 1, panX: 0, panY: 0, activeLayer: 'paint-1', collapsedGroups: [], maskEditing: null });
  });

  it('layer.addMask batches one addAsset (white fill, canvas-sized) + one setMask into a single history entry', () => {
    const doc: DocumentJSON = {
      version: 1,
      canvas: { width: 4, height: 4, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
      clock: { fps: 30 },
      layers: [rasterLayer('paint-1')],
      postChain: [],
      assets: {},
    } as unknown as DocumentJSON;
    const { app, applied } = fakeApp(doc);

    executeCommand(app, 'layer.addMask');

    expect(history.entries()).toEqual([{ label: 'Add Mask', current: true }]);
    expect(applied).toHaveLength(1);
    const [addAsset, setMask] = applied[0]!;
    expect(addAsset).toMatchObject({ op: 'addAsset', asset: { type: 'raster', width: 4, height: 4 } });
    expect(new Uint8Array((addAsset as any).asset.data)).toEqual(new Uint8Array(whiteMaskBytes(4, 4)));
    expect(setMask).toMatchObject({ op: 'setMask', id: 'paint-1', mask: { enabled: true, invert: false, asset: (addAsset as any).id } });

    const layer = doc.layers[0] as any;
    expect(layer.mask).toEqual({ asset: (addAsset as any).id, enabled: true, invert: false });
  });

  it('layer.addMask no-ops if the active layer already has a mask', () => {
    const doc: DocumentJSON = {
      version: 1,
      canvas: { width: 4, height: 4, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
      clock: { fps: 30 },
      layers: [rasterLayer('paint-1', { asset: 'mask-1', enabled: true, invert: false })],
      postChain: [],
      assets: { 'mask-1': { type: 'raster', data: new ArrayBuffer(4 * 4 * 8), width: 4, height: 4 } },
    } as unknown as DocumentJSON;
    const { app, applied } = fakeApp(doc);

    executeCommand(app, 'layer.addMask');
    expect(applied).toHaveLength(0);
    expect(history.entries()).toHaveLength(0);
  });

  it('layer.removeMask / enableMask / disableMask / toggleMaskInvert act via setMask', () => {
    const doc: DocumentJSON = {
      version: 1,
      canvas: { width: 4, height: 4, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
      clock: { fps: 30 },
      layers: [rasterLayer('paint-1', { asset: 'mask-1', enabled: true, invert: false })],
      postChain: [],
      assets: {},
    } as unknown as DocumentJSON;
    const { app } = fakeApp(doc);

    executeCommand(app, 'layer.disableMask');
    expect((doc.layers[0] as any).mask).toEqual({ asset: 'mask-1', enabled: false, invert: false });

    executeCommand(app, 'layer.enableMask');
    expect((doc.layers[0] as any).mask).toEqual({ asset: 'mask-1', enabled: true, invert: false });

    executeCommand(app, 'layer.toggleMaskInvert');
    expect((doc.layers[0] as any).mask).toEqual({ asset: 'mask-1', enabled: true, invert: true });

    executeCommand(app, 'layer.removeMask');
    expect((doc.layers[0] as any).mask).toBeUndefined();

    expect(history.entries().map((e) => e.label)).toEqual(['Disable Mask', 'Enable Mask', 'Invert Mask', 'Remove Mask']);
  });
});

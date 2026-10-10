import { describe, it, expect, beforeEach } from 'vitest';
import { resolveStrokeTarget } from '../../src/ui/canvas/paint-layer';
import { viewState } from '../../src/app/stores';
import type { AppCtx } from '../../src/app/types';
import type { DocumentJSON } from '@engine';

function fakeApp(doc: DocumentJSON): AppCtx {
  return { engine: { getDocument: () => doc } } as unknown as AppCtx;
}

function docWith(layers: any[]): DocumentJSON {
  return { version: 1, canvas: { width: 32, height: 32 }, clock: { fps: 30 }, layers, postChain: [], assets: {} } as unknown as DocumentJSON;
}

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

describe('resolveStrokeTarget: MASKS block', () => {
  beforeEach(() => {
    viewState.set({ zoom: 1, panX: 0, panY: 0, activeLayer: 'paint-1', collapsedGroups: [], maskEditing: null });
  });

  it('routes to the layer (unchanged resolvePaintLayer behaviour) when not in mask edit mode', () => {
    const doc = docWith([rasterLayer('paint-1')]);
    const target = resolveStrokeTarget(fakeApp(doc));
    expect(target).toEqual({ kind: 'layer', layer: 'paint-1' });
  });

  it('routes to the mask asset while MASK EDIT MODE targets a layer with a mask', () => {
    const doc = docWith([rasterLayer('paint-1', { asset: 'mask-1', enabled: true, invert: false })]);
    viewState.update((s) => ({ ...s, maskEditing: 'paint-1' }));
    const target = resolveStrokeTarget(fakeApp(doc));
    expect(target).toEqual({ kind: 'mask', layer: 'paint-1', asset: 'mask-1' });
  });

  it('falls back to layer routing and exits mask mode if the edited layer lost its mask', () => {
    const doc = docWith([rasterLayer('paint-1')]); // no mask
    viewState.update((s) => ({ ...s, maskEditing: 'paint-1' }));
    const target = resolveStrokeTarget(fakeApp(doc));
    expect(target).toEqual({ kind: 'layer', layer: 'paint-1' });
    expect(viewState.get().maskEditing).toBeNull();
  });

  it('falls back to layer routing and exits mask mode if the edited layer no longer exists', () => {
    const doc = docWith([rasterLayer('paint-1')]);
    viewState.update((s) => ({ ...s, maskEditing: 'gone' }));
    const target = resolveStrokeTarget(fakeApp(doc));
    expect(target).toEqual({ kind: 'layer', layer: 'paint-1' });
    expect(viewState.get().maskEditing).toBeNull();
  });
});

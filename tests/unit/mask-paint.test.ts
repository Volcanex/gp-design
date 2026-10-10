import { describe, it, expect, beforeEach } from 'vitest';
import { whiteMaskBytes, beginMaskStroke, maskStrokePoint, commitMaskStroke } from '../../src/ui/canvas/mask-paint';
import { history } from '../../src/app/commands/app-history';
import type { AppCtx } from '../../src/app/types';
import type { DocumentJSON } from '@engine';

function fakeApp(doc: DocumentJSON): { app: AppCtx } {
  const app = {
    engine: {
      getDocument: () => doc,
      requestFrame: () => {},
      invalidateAsset: () => {},
    },
  } as unknown as AppCtx;
  return { app };
}

function docWithMask(width = 32, height = 32): DocumentJSON {
  return {
    version: 1,
    canvas: { width, height, workingFormat: 'rgba16float', outputColorSpace: 'display-p3' },
    clock: { fps: 30 },
    layers: [],
    postChain: [],
    assets: { 'mask-1': { type: 'raster', data: whiteMaskBytes(width, height), width, height } },
  } as unknown as DocumentJSON;
}

describe('whiteMaskBytes', () => {
  it('fills every pixel with L=1, a=0, b=0, alpha=1 (opaque white: an all-keep mask)', () => {
    const bytes = whiteMaskBytes(2, 2);
    expect(bytes.byteLength).toBe(2 * 2 * 8);
    const view = new Uint16Array(bytes);
    for (let i = 0; i < 4; i++) {
      expect(view[i * 4]).toBe(0x3c00); // L=1 (f16)
      expect(view[i * 4 + 1]).toBe(0); // a=0
      expect(view[i * 4 + 2]).toBe(0); // b=0
      expect(view[i * 4 + 3]).toBe(0x3c00); // alpha=1 (f16)
    }
  });
});

describe('mask stroke CPU rasterizer', () => {
  beforeEach(() => {
    history.clear();
  });

  it('paints the brush colour\'s L into the mask, live, before commit', () => {
    const doc = docWithMask();
    const { app } = fakeApp(doc);
    beginMaskStroke(app, 'mask-1');
    maskStrokePoint(app, { x: 4, y: 4 }, 8, [0.0, 0, 0, 1], false);

    const asset = doc.assets['mask-1'] as any;
    const view = new Uint16Array(asset.data);
    const centerIndex = (4 * 32 + 4) * 4;
    // Painted black (L=0) at the stroke centre, no longer the L=1 default.
    expect(view[centerIndex]).not.toBe(0x3c00);
    // A pixel far outside the brush's falloff radius (r+1 = 5px from the
    // stroke centre at (4,4)) is untouched.
    const farIndex = (28 * 32 + 28) * 4;
    expect(view[farIndex]).toBe(0x3c00);
  });

  it('commits exactly one history entry per stroke; undo restores byte-identical bytes', () => {
    const doc = docWithMask();
    const { app } = fakeApp(doc);
    const before = (doc.assets['mask-1'] as any).data.slice(0);

    beginMaskStroke(app, 'mask-1');
    maskStrokePoint(app, { x: 4, y: 4 }, 8, [0.0, 0, 0, 1], false);
    commitMaskStroke(app, 'Brush Mask');

    expect(history.entries()).toEqual([{ label: 'Brush Mask', current: true }]);
    const afterCommit = new Uint8Array((doc.assets['mask-1'] as any).data.slice(0));
    expect(afterCommit).not.toEqual(new Uint8Array(before));

    history.undo(app);
    expect(new Uint8Array((doc.assets['mask-1'] as any).data)).toEqual(new Uint8Array(before));

    history.redo(app);
    expect(new Uint8Array((doc.assets['mask-1'] as any).data)).toEqual(afterCommit);
  });

  it('a stroke that stamps no coverage change pushes no history entry', () => {
    const doc = docWithMask();
    const { app } = fakeApp(doc);
    beginMaskStroke(app, 'mask-1');
    // Painting white onto an already-all-white mask changes nothing.
    maskStrokePoint(app, { x: 4, y: 4 }, 8, [1, 0, 0, 1], false);
    commitMaskStroke(app, 'Brush Mask');
    expect(history.entries()).toHaveLength(0);
  });

  it('erase mode scales the mask alpha down instead of touching L', () => {
    const doc = docWithMask();
    const { app } = fakeApp(doc);
    beginMaskStroke(app, 'mask-1');
    maskStrokePoint(app, { x: 4, y: 4 }, 8, [1, 0, 0, 1], true);
    const asset = doc.assets['mask-1'] as any;
    const view = new Uint16Array(asset.data);
    const centerIndex = (4 * 32 + 4) * 4;
    expect(view[centerIndex]).toBe(0x3c00); // L untouched
    expect(view[centerIndex + 3]).toBeLessThan(0x3c00); // alpha reduced
  });

  it('begin on a missing/non-raster asset is a safe no-op (no crash, nothing committed)', () => {
    const doc = docWithMask();
    const { app } = fakeApp(doc);
    beginMaskStroke(app, 'does-not-exist');
    maskStrokePoint(app, { x: 4, y: 4 }, 8, [0, 0, 0, 1], false);
    commitMaskStroke(app, 'Brush Mask');
    expect(history.entries()).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import { burn, type BurnRenderer, type BurnFrame } from '../../src/engine/burn/burn';
import { applyEdits, findLayer } from '../../src/engine/doc/document';
import { createLayer } from '../../src/engine/doc/layer';
import { emptyDocument } from '../../src/engine/doc/json';
import { layerId } from '../../src/engine/core/types';
import type { DocumentJSON, Layer } from '../../src/engine/doc/json';

/**
 * Pure edit-batch construction: fakes the GPU frame-pull entirely (no
 * device, no engine) so this exercises only burn.ts's DocEdit assembly and
 * document.ts's applyEdits, the same contract localHost.ts's real
 * renderSubtree()-backed renderer plugs into.
 */
function baseDoc(): DocumentJSON {
  const doc = emptyDocument(4, 4);
  doc.layers.push(createLayer({
    id: layerId('plasma1'),
    name: 'Plasma',
    source: { type: 'core.plasma', params: { scale: 8, speed: 6 } },
    chain: [{ id: 'fx1', pass: 'core.exposure', params: { exposure: 1 }, enabled: true }],
  }));
  return doc;
}

function makeFrame(fill: number): BurnFrame {
  const data = new ArrayBuffer(4 * 4 * 8);
  new Float32Array(data).fill(fill);
  return { data, width: 4, height: 4 };
}

describe('burn: still mode', () => {
  it('bakes the target layer into a raster source with an empty chain', async () => {
    const doc = baseDoc();
    const renderer: BurnRenderer = async () => makeFrame(1);

    const result = await burn(doc, { target: layerId('plasma1'), mode: 'still' }, 0, renderer);

    expect(result.edits).toEqual([
      { op: 'addAsset', id: expect.any(String), asset: { type: 'raster', data: expect.any(ArrayBuffer), width: 4, height: 4 } },
      { op: 'removeLayer', id: layerId('plasma1') },
      { op: 'addLayer', parent: null, index: 0, layer: expect.objectContaining({ id: layerId('plasma1') }) },
    ]);

    const inverses = applyEdits(doc, result.edits);
    const baked = findLayer(doc, layerId('plasma1'))!.node as Layer;
    expect(baked.source.type).toBe('core.raster');
    expect(baked.chain).toEqual([]);
    expect(baked.liveness).toBe('baked');
    expect(baked.baked).toBeUndefined();
    const assetRef = baked.source.params['asset'] as { asset: string };
    expect(doc.assets[assetRef.asset]).toMatchObject({ type: 'raster', width: 4, height: 4 });

    // Undo restores the original live plasma layer + removes the baked asset.
    applyEdits(doc, inverses);
    expect(doc).toEqual(baseDoc());
  });

  it('is a no-op when the target does not resolve to a layer', async () => {
    const doc = baseDoc();
    const renderer: BurnRenderer = async () => makeFrame(1);
    const result = await burn(doc, { target: layerId('missing'), mode: 'still' }, 0, renderer);
    expect(result.edits).toEqual([]);
  });

  it('is a no-op when the renderer cannot produce a frame', async () => {
    const doc = baseDoc();
    const renderer: BurnRenderer = async () => null;
    const result = await burn(doc, { target: layerId('plasma1'), mode: 'still' }, 0, renderer);
    expect(result.edits).toEqual([]);
  });
});

describe('burn: clip mode', () => {
  it('bakes a range of frames into a clip asset and clears the chain', async () => {
    const doc = baseDoc();
    const seen: number[] = [];
    const renderer: BurnRenderer = async (_target, t) => {
      seen.push(t);
      return makeFrame(t);
    };

    const result = await burn(
      doc,
      { target: layerId('plasma1'), mode: 'clip', range: { from: 0, to: 0.5, fps: 4 } },
      0,
      renderer,
    );

    // 0, 0.25, 0.5 @ 4fps over [0, 0.5] inclusive.
    expect(seen).toEqual([0, 0.25, 0.5]);

    applyEdits(doc, result.edits);
    const baked = findLayer(doc, layerId('plasma1'))!.node as Layer;
    expect(baked.liveness).toBe('baked');
    expect(baked.chain).toEqual([]);
    expect(baked.baked).toEqual({ clip: expect.any(String), frames: 3, fps: 4 });
    const asset = doc.assets[baked.baked!.clip];
    expect(asset).toMatchObject({ type: 'clip', width: 4, height: 4, fps: 4 });
    if (asset?.type === 'clip') expect(asset.frames.length).toBe(3);
  });

  it('is a no-op when range is missing', async () => {
    const doc = baseDoc();
    const renderer: BurnRenderer = async () => makeFrame(1);
    const result = await burn(doc, { target: layerId('plasma1'), mode: 'clip' }, 0, renderer);
    expect(result.edits).toEqual([]);
  });
});

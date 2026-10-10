import { describe, it, expect } from 'vitest';
import { evictedLayerIds, evictedAssetIds } from '../../src/engine/doc/document';
import { emptyDocument } from '../../src/engine/doc/json';
import type { DocumentJSON, Layer, LayerGroup } from '../../src/engine/doc/json';
import { assetId, layerId } from '../../src/engine/core/types';

/**
 * Pure "given a doc and a set of cached ids, which get evicted" walk: no
 * GPU, no engine, exactly what core/engine.ts's reconcile() (and
 * core/asset-textures.ts's evict()) delegate to for the actual liveness
 * decision. See src/engine/CLAUDE.md's "GPU resource lifetime" section.
 */

function solidLayer(id: string, overrides: Partial<Layer> = {}): Layer {
  return {
    id: layerId(id),
    kind: 'layer',
    name: id,
    enabled: true,
    source: { type: 'core.solid', params: { color: [0.5, 0, 0, 1] } },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
    liveness: 'live',
    ...overrides,
  };
}

function group(id: string, children: DocumentJSON['layers']): LayerGroup {
  return {
    id: layerId(id),
    kind: 'group',
    name: id,
    enabled: true,
    children,
    chain: [],
    blendMode: 'normal',
    opacity: 1,
  };
}

describe('evictedLayerIds', () => {
  it('keeps ids for layers still present anywhere in the tree, including inside groups', () => {
    const doc = emptyDocument();
    doc.layers = [solidLayer('a'), group('g1', [solidLayer('c')])];

    const evicted = evictedLayerIds(doc, ['a', 'c', 'g1', 'gone'].map(layerId));
    expect(evicted).toEqual(['gone']);
  });

  it('evicts everything once the doc is emptied', () => {
    const doc = emptyDocument();
    doc.layers = [];
    expect(evictedLayerIds(doc, ['a', 'b'].map(layerId))).toEqual(['a', 'b']);
  });

  it('is a no-op set difference: an empty cached-id set evicts nothing', () => {
    const doc = emptyDocument();
    doc.layers = [solidLayer('a')];
    expect(evictedLayerIds(doc, [])).toEqual([]);
  });
});

describe('evictedAssetIds', () => {
  function docWithReferences(): DocumentJSON {
    const doc = emptyDocument();
    doc.layers = [
      solidLayer('fg', {
        mask: { asset: 'mask1', enabled: true, invert: false },
        chain: [{ id: 'fx1', pass: 'core.lut', params: { asset: { asset: assetId('lut1') }, amount: 1 }, enabled: true }],
        source: { type: 'core.image', params: { asset: { asset: assetId('img1') } } },
      }),
    ];
    doc.assets = {
      mask1: { type: 'raster', data: new ArrayBuffer(0), width: 1, height: 1 },
      lut1: { type: 'lut', data: new ArrayBuffer(0), size: 1 },
      img1: { type: 'image', mime: 'image/png', data: new ArrayBuffer(0), width: 1, height: 1 },
      orphan1: { type: 'lut', data: new ArrayBuffer(0), size: 1 },
    };
    return doc;
  }

  it('keeps ids referenced by a mask, a chain param, or a source param; evicts the rest', () => {
    const doc = docWithReferences();
    const evicted = evictedAssetIds(doc, ['mask1', 'lut1', 'img1', 'orphan1']);
    expect(evicted).toEqual(['orphan1']);
  });

  it('a document-level postChain reference counts as live too', () => {
    const doc = emptyDocument();
    doc.postChain = [{ id: 'post1', pass: 'core.lut', params: { asset: { asset: assetId('lut1') }, amount: 1 }, enabled: true }];
    doc.assets = { lut1: { type: 'lut', data: new ArrayBuffer(0), size: 1 } };
    expect(evictedAssetIds(doc, ['lut1'])).toEqual([]);
  });

  it('removing the referencing layer makes every one of its asset refs evictable', () => {
    const doc = docWithReferences();
    doc.layers = [];
    const evicted = evictedAssetIds(doc, ['mask1', 'lut1', 'img1', 'orphan1']);
    expect(evicted.sort()).toEqual(['img1', 'lut1', 'mask1', 'orphan1']);
  });
});

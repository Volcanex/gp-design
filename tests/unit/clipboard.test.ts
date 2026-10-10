// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { executeCommand } from '../../src/app/commands/registry';
import { history } from '../../src/app/commands/app-history';
import { selectionState, viewState } from '../../src/app/stores';
import { applyEdits } from '../../src/engine/doc/document';
import { createLayer } from '../../src/engine/doc/layer';
import { createObject } from '../../src/engine/doc/object';
import { emptyDocument } from '../../src/engine/doc/json';
import { layerId, objectId, assetId } from '../../src/engine/core/types';
import type { AppCtx } from '../../src/app/types';
import type { DocEdit, DocumentJSON } from '@engine';

/** A fake engine backed by the REAL applyEdits (document.ts): no GPU
 * involved, so addLayer/addObject/addAsset behave exactly like the live
 * engine instead of a hand-rolled subset (see MockEngineHost's gaps). */
function fakeEngine(doc: DocumentJSON) {
  return {
    getDocument: () => doc,
    applyEdits: (edits: DocEdit[]) => applyEdits(doc, edits),
  } as unknown as AppCtx['engine'];
}

function sceneDoc(): DocumentJSON {
  const doc = emptyDocument(200, 200);
  doc.layers.push(createLayer({
    id: layerId('scene-1'),
    name: 'Scene',
    source: {
      type: 'core.scene',
      params: {
        scene: [
          createObject({
            id: objectId('obj-1'),
            name: 'Rect',
            content: { type: 'shape', shape: { shape: 'rect', width: 40, height: 40 } },
            transform: { x: 100, y: 100, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5 },
          }),
        ],
      } as never,
    },
  }));
  return doc;
}

describe('edit.copy / edit.cut / edit.paste: object precedence', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
  });

  it('Copy with a scene selection copies the object, not the layer', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    selectionState.set({ objects: ['obj-1'], marquee: null });

    executeCommand(app, 'edit.copy');
    executeCommand(app, 'edit.paste');

    const scene = (doc.layers[0] as unknown as { source: { params: { scene: { id: string; transform: { x: number; y: number } }[] } } }).source.params.scene;
    expect(scene).toHaveLength(2);
    expect(scene[1]!.id).not.toBe('obj-1');
    // +10px offset from the original at (100,100).
    expect(scene[1]!.transform.x).toBe(110);
    expect(scene[1]!.transform.y).toBe(110);
  });

  it('repeated paste keeps generating fresh ids (no id collision on the second paste)', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    selectionState.set({ objects: ['obj-1'], marquee: null });
    executeCommand(app, 'edit.copy');

    executeCommand(app, 'edit.paste');
    executeCommand(app, 'edit.paste');

    const scene = (doc.layers[0] as unknown as { source: { params: { scene: { id: string }[] } } }).source.params.scene;
    const ids = new Set(scene.map((o) => o.id));
    expect(ids.size).toBe(3);
  });

  it('Cut removes the object and pushes exactly one undo step', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    selectionState.set({ objects: ['obj-1'], marquee: null });

    executeCommand(app, 'edit.cut');

    // document.ts's removeObject collapses an emptied scene array back to
    // "absent" (mirrors addLayer's lazy creation), not `[]`.
    const scene = (doc.layers[0] as unknown as { source: { params: { scene?: unknown[] } } }).source.params.scene;
    expect(scene ?? []).toHaveLength(0);
    expect(history.entries()).toEqual([{ label: 'Cut', current: true }]);
    expect(selectionState.get().objects).toEqual([]);

    history.undo(app);
    const restored = (doc.layers[0] as unknown as { source: { params: { scene: { id: string }[] } } }).source.params.scene;
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).toBe('obj-1');
  });

  it('Cut then Paste round-trips the object back in (via the internal clipboard, independent of undo)', () => {
    const doc = sceneDoc();
    const app: AppCtx = { engine: fakeEngine(doc) };
    selectionState.set({ objects: ['obj-1'], marquee: null });

    executeCommand(app, 'edit.cut');
    executeCommand(app, 'edit.paste');

    const scene = (doc.layers[0] as unknown as { source: { params: { scene: unknown[] } } }).source.params.scene;
    expect(scene).toHaveLength(1);
  });
});

describe('edit.copy / edit.paste: layer (no selection)', () => {
  beforeEach(() => {
    history.clear();
    selectionState.set({ objects: [], marquee: null });
  });

  const SOURCE_ASSET_ID = assetId('asset-1');

  function docWithImageLayer(): DocumentJSON {
    const doc = emptyDocument(100, 100);
    doc.assets[SOURCE_ASSET_ID] = { type: 'image', mime: 'image/png', data: new ArrayBuffer(4), width: 1, height: 1 };
    doc.layers.push(createLayer({
      id: layerId('img-1'),
      name: 'Image',
      source: { type: 'core.image', params: { asset: { asset: SOURCE_ASSET_ID } } },
    }, 'baked'));
    return doc;
  }

  it('copies the whole active layer when there is no object selection', () => {
    const doc = docWithImageLayer();
    const app: AppCtx = { engine: fakeEngine(doc) };
    viewState.update((s) => ({ ...s, activeLayer: 'img-1' }));

    executeCommand(app, 'edit.copy');
    executeCommand(app, 'edit.paste');

    expect(doc.layers).toHaveLength(2);
    expect(doc.layers[1]!.name).toBe('Image copy');
    expect(doc.layers[1]!.id).not.toBe('img-1');
  });

  it('re-adds a snapshotted asset that is missing from the paste-target doc', () => {
    const doc = docWithImageLayer();
    const app: AppCtx = { engine: fakeEngine(doc) };
    viewState.update((s) => ({ ...s, activeLayer: 'img-1' }));
    executeCommand(app, 'edit.copy');

    // Simulate pasting into a doc that no longer has the source asset
    // (e.g. it was removed, or this is effectively a fresh document).
    delete doc.assets[SOURCE_ASSET_ID];

    executeCommand(app, 'edit.paste');

    const pasted = doc.layers[1] as unknown as { source: { params: { asset: { asset: string } } } };
    const pastedAssetId = pasted.source.params.asset.asset;
    expect(doc.assets[pastedAssetId]).toBeDefined();
    expect(doc.assets[pastedAssetId]!.type).toBe('image');
  });

  it('does NOT duplicate an asset already present in the paste-target doc', () => {
    const doc = docWithImageLayer();
    const app: AppCtx = { engine: fakeEngine(doc) };
    viewState.update((s) => ({ ...s, activeLayer: 'img-1' }));
    executeCommand(app, 'edit.copy');

    executeCommand(app, 'edit.paste');

    expect(Object.keys(doc.assets)).toHaveLength(1);
  });

  it('Cut removes the layer as one undo step and clears activeLayer', () => {
    const doc = docWithImageLayer();
    const app: AppCtx = { engine: fakeEngine(doc) };
    viewState.update((s) => ({ ...s, activeLayer: 'img-1' }));

    executeCommand(app, 'edit.cut');

    expect(doc.layers).toHaveLength(0);
    expect(viewState.get().activeLayer).toBeNull();
    expect(history.entries()).toEqual([{ label: 'Cut', current: true }]);
  });
});

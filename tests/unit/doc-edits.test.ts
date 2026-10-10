import { describe, it, expect } from 'vitest';
import { applyEdit, applyEdits, findLayer, findObject, sceneObjects } from '../../src/engine/doc/document';
import { createLayer, createGroup } from '../../src/engine/doc/layer';
import { createObject } from '../../src/engine/doc/object';
import { emptyDocument } from '../../src/engine/doc/json';
import { layerId, objectId, identityTransform } from '../../src/engine/core/types';
import type { DocumentJSON } from '../../src/engine/doc/json';
import type { DocEdit } from '../../src/engine/host/protocol';

function baseDoc(): DocumentJSON {
  const doc = emptyDocument(64, 64);
  doc.layers.push(createLayer({
    id: layerId('l1'),
    name: 'layer one',
    source: { type: 'core.solid', params: { color: [0.5, 0, 0, 1] } },
    chain: [{ id: 'fx1', pass: 'core.exposure', params: { exposure: 0 }, enabled: true }],
  }));
  doc.layers.push(createGroup({
    id: layerId('g1'),
    name: 'group one',
    children: [
      createLayer({ id: layerId('l2'), name: 'nested', source: { type: 'core.solid', params: {} } }),
    ],
  }));
  return doc;
}

/** Apply, assert, apply the inverse, and check we're back to the original. */
function roundTrip(doc: DocumentJSON, edit: DocEdit, assertAfter: (d: DocumentJSON) => void) {
  const before = structuredClone(doc);
  const inverse = applyEdit(doc, edit);
  expect(inverse).not.toBeNull();
  assertAfter(doc);
  const result = applyEdit(doc, inverse!);
  expect(result).not.toBeNull();
  expect(doc).toEqual(before);
}

describe('applyEdit: setParam', () => {
  it('layer source params', () => {
    const doc = baseDoc();
    roundTrip(doc, { op: 'setParam', target: { kind: 'layer', id: layerId('l1') }, key: 'color', value: [1, 1, 1, 1] }, (d) => {
      expect(findLayer(d, layerId('l1'))!.node).toMatchObject({ source: { params: { color: [1, 1, 1, 1] } } });
    });
  });

  it('introducing a new key round-trips to deletion', () => {
    const doc = baseDoc();
    const layer = findLayer(doc, layerId('l1'))!.node as any;
    expect('brandNew' in layer.source.params).toBe(false);
    const inverse = applyEdit(doc, { op: 'setParam', target: { kind: 'layer', id: layerId('l1') }, key: 'brandNew', value: 5 });
    expect(layer.source.params.brandNew).toBe(5);
    applyEdit(doc, inverse!);
    expect('brandNew' in layer.source.params).toBe(false);
  });

  it('effect-instance params via chain lookup', () => {
    const doc = baseDoc();
    roundTrip(doc, { op: 'setParam', target: { kind: 'effect', owner: layerId('l1'), instance: 'fx1' }, key: 'exposure', value: 2 }, (d) => {
      const node = findLayer(d, layerId('l1'))!.node as any;
      expect(node.chain[0].params.exposure).toBe(2);
    });
  });

  it('missing target is a no-op', () => {
    const doc = baseDoc();
    const inverse = applyEdit(doc, { op: 'setParam', target: { kind: 'layer', id: layerId('nope') }, key: 'x', value: 1 });
    expect(inverse).toBeNull();
  });

  it('document target has no backing store (no-op)', () => {
    const doc = baseDoc();
    const inverse = applyEdit(doc, { op: 'setParam', target: { kind: 'document' }, key: 'x', value: 1 });
    expect(inverse).toBeNull();
  });
});

function docWithSceneObjects(): DocumentJSON {
  const doc = emptyDocument(64, 64);
  const textObj = createObject({
    id: objectId('t1'), name: 'Text',
    content: { type: 'text', text: { text: 'hello', font: 'default', size: 24 } },
    style: { fill: [0.5, 0.1, -0.1, 1] },
  });
  const shapeObj = createObject({
    id: objectId('s1'), name: 'Rect',
    content: { type: 'shape', shape: { shape: 'rect', width: 10, height: 10 } },
  });
  const layer = createLayer({ id: layerId('scene'), name: 'Scene', source: { type: 'core.scene', params: {} } });
  layer.source.params['scene'] = [textObj, shapeObj] as never;
  doc.layers.push(layer);
  return doc;
}

describe('applyEdit: setParam, object targets (content.* special cases)', () => {
  it("content.text round-trips a text object's string", () => {
    const doc = docWithSceneObjects();
    roundTrip(doc, { op: 'setParam', target: { kind: 'object', layer: layerId('scene'), id: objectId('t1') }, key: 'content.text', value: 'world' }, (d) => {
      const found = findObject(d, layerId('scene'), objectId('t1'))!;
      expect(found.node.content).toMatchObject({ type: 'text', text: { text: 'world' } });
    });
  });

  it('content.text is a no-op on a non-text object', () => {
    const doc = docWithSceneObjects();
    const inverse = applyEdit(doc, { op: 'setParam', target: { kind: 'object', layer: layerId('scene'), id: objectId('s1') }, key: 'content.text', value: 'nope' });
    expect(inverse).toBeNull();
  });

  it("content.size round-trips a text object's font size", () => {
    const doc = docWithSceneObjects();
    roundTrip(doc, { op: 'setParam', target: { kind: 'object', layer: layerId('scene'), id: objectId('t1') }, key: 'content.size', value: 48 }, (d) => {
      const found = findObject(d, layerId('scene'), objectId('t1'))!;
      expect(found.node.content).toMatchObject({ type: 'text', text: { size: 48 } });
    });
  });

  it('content.size is a no-op on a non-text object', () => {
    const doc = docWithSceneObjects();
    const inverse = applyEdit(doc, { op: 'setParam', target: { kind: 'object', layer: layerId('scene'), id: objectId('s1') }, key: 'content.size', value: 10 });
    expect(inverse).toBeNull();
  });

  it('content.fill round-trips a text object’s existing fill', () => {
    const doc = docWithSceneObjects();
    roundTrip(doc, { op: 'setParam', target: { kind: 'object', layer: layerId('scene'), id: objectId('t1') }, key: 'content.fill', value: [0, 0, 0, 1] }, (d) => {
      const found = findObject(d, layerId('scene'), objectId('t1'))!;
      expect(found.node.style.fill).toEqual([0, 0, 0, 1]);
    });
  });

  it('content.fill round-trips a shape object with no prior fill (undo clears the key back to absent)', () => {
    const doc = docWithSceneObjects();
    const target = { kind: 'object' as const, layer: layerId('scene'), id: objectId('s1') };
    expect(findObject(doc, layerId('scene'), objectId('s1'))!.node.style.fill).toBeUndefined();
    roundTrip(doc, { op: 'setParam', target, key: 'content.fill', value: [1, 0.2, -0.2, 0.5] }, (d) => {
      const found = findObject(d, layerId('scene'), objectId('s1'))!;
      expect(found.node.style.fill).toEqual([1, 0.2, -0.2, 0.5]);
    });
    expect(findObject(doc, layerId('scene'), objectId('s1'))!.node.style.fill).toBeUndefined();
  });

  it('content.fill on an unknown object is a no-op', () => {
    const doc = docWithSceneObjects();
    const inverse = applyEdit(doc, { op: 'setParam', target: { kind: 'object', layer: layerId('scene'), id: objectId('missing') }, key: 'content.fill', value: [0, 0, 0, 1] });
    expect(inverse).toBeNull();
  });
});

describe('applyEdit: layer tree ops', () => {
  it('addLayer / removeLayer at root', () => {
    const doc = baseDoc();
    const newLayer = createLayer({ id: layerId('l3'), name: 'added', source: { type: 'core.solid', params: {} } });
    roundTrip(doc, { op: 'addLayer', parent: null, index: 1, layer: newLayer }, (d) => {
      expect(d.layers[1]!.id).toBe('l3');
    });
  });

  it('addLayer / removeLayer inside a group', () => {
    const doc = baseDoc();
    const newLayer = createLayer({ id: layerId('l4'), name: 'nested-added', source: { type: 'core.solid', params: {} } });
    roundTrip(doc, { op: 'addLayer', parent: layerId('g1'), index: 0, layer: newLayer }, (d) => {
      const group = findLayer(d, layerId('g1'))!.node as any;
      expect(group.children[0].id).toBe('l4');
    });
  });

  it("removeLayer's inverse restores into the original parent, not root", () => {
    const doc = baseDoc();
    const before = structuredClone(doc);
    const inverse = applyEdit(doc, { op: 'removeLayer', id: layerId('l2') });
    expect(inverse).toEqual({ op: 'addLayer', parent: layerId('g1'), index: 0, layer: expect.anything() });
    const group = findLayer(doc, layerId('g1'))!.node as any;
    expect(group.children).toHaveLength(0);
    applyEdit(doc, inverse!);
    expect(doc).toEqual(before);
  });

  it('reorderLayer within the same parent', () => {
    const doc = baseDoc();
    roundTrip(doc, { op: 'reorderLayer', id: layerId('l1'), parent: null, index: 1 }, (d) => {
      expect(d.layers.map((l) => l.id)).toEqual(['g1', 'l1']);
    });
  });

  it('reorderLayer across parents (root -> group)', () => {
    const doc = baseDoc();
    roundTrip(doc, { op: 'reorderLayer', id: layerId('l1'), parent: layerId('g1'), index: 0 }, (d) => {
      expect(d.layers.map((l) => l.id)).toEqual(['g1']);
      const group = findLayer(d, layerId('g1'))!.node as any;
      expect(group.children.map((c: any) => c.id)).toEqual(['l1', 'l2']);
    });
  });

  it('setBlend', () => {
    const doc = baseDoc();
    roundTrip(doc, { op: 'setBlend', id: layerId('l1'), mode: 'multiply' }, (d) => {
      expect((findLayer(d, layerId('l1'))!.node as any).blendMode).toBe('multiply');
    });
  });

  it('setOpacity', () => {
    const doc = baseDoc();
    roundTrip(doc, { op: 'setOpacity', id: layerId('l1'), value: 0.3 }, (d) => {
      expect((findLayer(d, layerId('l1'))!.node as any).opacity).toBe(0.3);
    });
  });

  it('setChain on a layer', () => {
    const doc = baseDoc();
    const newChain = [{ id: 'fx2', pass: 'core.blur', params: {}, enabled: true }];
    roundTrip(doc, { op: 'setChain', target: { kind: 'layer', id: layerId('l1') }, chain: newChain }, (d) => {
      expect((findLayer(d, layerId('l1'))!.node as any).chain).toEqual(newChain);
    });
  });

  it('setChain on the document postChain', () => {
    const doc = baseDoc();
    const newChain = [{ id: 'fx3', pass: 'core.grade', params: {}, enabled: true }];
    roundTrip(doc, { op: 'setChain', target: { kind: 'document' }, chain: newChain }, (d) => {
      expect(d.postChain).toEqual(newChain);
    });
  });

  it('setTransform on a layer', () => {
    const doc = baseDoc();
    const t = { ...identityTransform(), x: 10 };
    roundTrip(doc, { op: 'setTransform', id: layerId('l1'), transform: t }, (d) => {
      expect((findLayer(d, layerId('l1'))!.node as any).transform).toEqual(t);
    });
  });

  it('setEnabled on a group', () => {
    const doc = baseDoc();
    roundTrip(doc, { op: 'setEnabled', id: layerId('g1'), enabled: false }, (d) => {
      expect((findLayer(d, layerId('g1'))!.node as any).enabled).toBe(false);
    });
  });

  it('renameNode on a layer', () => {
    const doc = baseDoc();
    roundTrip(doc, { op: 'renameNode', id: layerId('l1'), name: 'renamed' }, (d) => {
      expect((findLayer(d, layerId('l1'))!.node as any).name).toBe('renamed');
    });
  });
});

describe('applyEdit: scene objects', () => {
  function docWithScene(): DocumentJSON {
    const doc = baseDoc();
    const layer = findLayer(doc, layerId('l1'))!.node as any;
    layer.source.params.scene = [
      createObject({ id: objectId('o1'), name: 'rect', content: { type: 'shape', shape: { shape: 'rect', width: 10, height: 10 } } }),
    ];
    return doc;
  }

  it('addObject / removeObject at scene root', () => {
    const doc = docWithScene();
    const newObj = createObject({ id: objectId('o2'), name: 'ellipse', content: { type: 'shape', shape: { shape: 'ellipse', width: 5, height: 5 } } });
    roundTrip(doc, { op: 'addObject', layer: layerId('l1'), parent: null, index: 0, object: newObj }, (d) => {
      const layer = findLayer(d, layerId('l1'))!.node as any;
      expect(sceneObjects(layer)!.map((o) => o.id)).toEqual(['o2', 'o1']);
    });
  });

  it('addObject / removeObject nested under a parent object', () => {
    const doc = docWithScene();
    const child = createObject({ id: objectId('c1'), name: 'child', content: { type: 'shape', shape: { shape: 'rect', width: 1, height: 1 } } });
    roundTrip(doc, { op: 'addObject', layer: layerId('l1'), parent: objectId('o1'), index: 0, object: child }, (d) => {
      const found = findObject(d, layerId('l1'), objectId('o1'))!;
      expect(found.node.children).toHaveLength(1);
      expect(found.node.children![0]!.id).toBe('c1');
    });
  });

  it("removeObject's inverse restores under the original parent object", () => {
    const doc = docWithScene();
    const layer = findLayer(doc, layerId('l1'))!.node as any;
    const objects = sceneObjects(layer)!;
    objects[0]!.children = [
      createObject({ id: objectId('c2'), name: 'child2', content: { type: 'shape', shape: { shape: 'rect', width: 1, height: 1 } } }),
    ];
    const before = structuredClone(doc);
    const inverse = applyEdit(doc, { op: 'removeObject', layer: layerId('l1'), id: objectId('c2') });
    expect(inverse).toEqual(expect.objectContaining({ op: 'addObject', parent: objectId('o1') }));
    applyEdit(doc, inverse!);
    expect(doc).toEqual(before);
  });

  it('setTransform on an object (id ambiguity resolved without a layer hint)', () => {
    const doc = docWithScene();
    const t = { ...identityTransform(), rotation: 1.2 };
    roundTrip(doc, { op: 'setTransform', id: objectId('o1'), transform: t }, (d) => {
      expect(findObject(d, layerId('l1'), objectId('o1'))!.node.transform).toEqual(t);
    });
  });

  it('setEnabled on an object', () => {
    const doc = docWithScene();
    roundTrip(doc, { op: 'setEnabled', id: objectId('o1'), enabled: false }, (d) => {
      expect(findObject(d, layerId('l1'), objectId('o1'))!.node.enabled).toBe(false);
    });
  });
});

describe('applyEdit: commitRaster', () => {
  it('swaps a sub-region of raster bytes and inverts', () => {
    const doc = baseDoc();
    const width = 4;
    const height = 4;
    const bytesPerPixel = 8;
    const full = new Uint8Array(width * height * bytesPerPixel).fill(1);
    doc.assets['raster1'] = { type: 'raster', data: full.buffer, width, height };

    const region = { x: 1, y: 1, width: 2, height: 2 };
    const patch = new Uint8Array(region.width * region.height * bytesPerPixel).fill(9);

    const before = structuredClone(doc);
    const inverse = applyEdit(doc, {
      op: 'commitRaster', layer: layerId('l1'), asset: 'raster1', data: patch.buffer, region,
    });
    expect(inverse).not.toBeNull();

    const patched = new Uint8Array((doc.assets['raster1'] as any).data);
    // Row 1, col 1 (inside region) should be patched to 9.
    const insideOffset = (1 * width + 1) * bytesPerPixel;
    expect(patched[insideOffset]).toBe(9);
    // Row 0, col 0 (outside region) should be untouched.
    expect(patched[0]).toBe(1);

    applyEdit(doc, inverse!);
    expect(doc).toEqual(before);
  });

  it('missing raster asset is a no-op', () => {
    const doc = baseDoc();
    const inverse = applyEdit(doc, {
      op: 'commitRaster', layer: layerId('l1'), asset: 'nope', data: new ArrayBuffer(8),
      region: { x: 0, y: 0, width: 1, height: 1 },
    });
    expect(inverse).toBeNull();
  });
});

describe('applyEdits: batches', () => {
  it('returns inverses in reverse order; applying them undoes the whole batch', () => {
    const doc = baseDoc();
    const before = structuredClone(doc);
    const edits: DocEdit[] = [
      { op: 'setOpacity', id: layerId('l1'), value: 0.2 },
      { op: 'setBlend', id: layerId('l1'), mode: 'screen' },
      { op: 'renameNode', id: layerId('l1'), name: 'batched' },
    ];
    const inverses = applyEdits(doc, edits);
    expect(inverses.map((i) => i.op)).toEqual(['renameNode', 'setBlend', 'setOpacity']);

    const node = findLayer(doc, layerId('l1'))!.node as any;
    expect(node.opacity).toBe(0.2);
    expect(node.blendMode).toBe('screen');
    expect(node.name).toBe('batched');

    applyEdits(doc, inverses);
    expect(doc).toEqual(before);
  });

  it('a no-op edit in the middle of a batch contributes no inverse', () => {
    const doc = baseDoc();
    const edits: DocEdit[] = [
      { op: 'setOpacity', id: layerId('l1'), value: 0.5 },
      { op: 'setBlend', id: layerId('missing' as any), mode: 'screen' },
      { op: 'setBlend', id: layerId('l1'), mode: 'darken' },
    ];
    const inverses = applyEdits(doc, edits);
    expect(inverses).toHaveLength(2);
  });
});

// MASKS block.
describe('applyEdit: setMask', () => {
  it('sets a mask on a layer with no prior mask; inverse removes it', () => {
    const doc = baseDoc();
    roundTrip(
      doc,
      { op: 'setMask', id: layerId('l1'), mask: { asset: 'mask-1', enabled: true, invert: false } },
      (d) => {
        expect((findLayer(d, layerId('l1'))!.node as any).mask).toEqual({ asset: 'mask-1', enabled: true, invert: false });
      },
    );
    expect('mask' in (findLayer(doc, layerId('l1'))!.node as any)).toBe(false);
  });

  it('replaces an existing mask; inverse restores the old one', () => {
    const doc = baseDoc();
    (findLayer(doc, layerId('l1'))!.node as any).mask = { asset: 'mask-old', enabled: true, invert: false };
    roundTrip(
      doc,
      { op: 'setMask', id: layerId('l1'), mask: { asset: 'mask-new', enabled: false, invert: true } },
      (d) => {
        expect((findLayer(d, layerId('l1'))!.node as any).mask).toEqual({ asset: 'mask-new', enabled: false, invert: true });
      },
    );
    expect((findLayer(doc, layerId('l1'))!.node as any).mask).toEqual({ asset: 'mask-old', enabled: true, invert: false });
  });

  it('mask: null removes an existing mask; inverse restores it', () => {
    const doc = baseDoc();
    (findLayer(doc, layerId('l1'))!.node as any).mask = { asset: 'mask-1', enabled: true, invert: false };
    roundTrip(doc, { op: 'setMask', id: layerId('l1'), mask: null }, (d) => {
      expect('mask' in (findLayer(d, layerId('l1'))!.node as any)).toBe(false);
    });
    expect((findLayer(doc, layerId('l1'))!.node as any).mask).toEqual({ asset: 'mask-1', enabled: true, invert: false });
  });

  it('no-ops on a missing layer id', () => {
    const doc = baseDoc();
    const inverse = applyEdit(doc, { op: 'setMask', id: layerId('nope'), mask: { asset: 'x', enabled: true, invert: false } });
    expect(inverse).toBeNull();
  });

  it('no-ops on a group (masks are Layer-only, not LayerGroup)', () => {
    const doc = baseDoc();
    const inverse = applyEdit(doc, { op: 'setMask', id: layerId('g1'), mask: { asset: 'x', enabled: true, invert: false } });
    expect(inverse).toBeNull();
  });
});

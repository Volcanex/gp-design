import { describe, it, expect } from 'vitest';
import {
  displayChain, toggledChain, removedChain, reorderedChain, chainForTarget, findSelectedObject, findSelectedTextObject,
} from '../../src/ui/panels/effects-logic';
import { applyEdits } from '../../src/engine/doc/document';
import { createLayer, createGroup } from '../../src/engine/doc/layer';
import { createObject } from '../../src/engine/doc/object';
import { emptyDocument } from '../../src/engine/doc/json';
import { layerId, objectId } from '../../src/engine/core/types';
import type { DocumentJSON } from '../../src/engine/doc/json';
import type { Chain, EffectInstance } from '../../src/engine/passes/chain';
import type { NodePath } from '../../src/engine/host/protocol';

function fx(id: string, enabled = true): EffectInstance {
  return { id, pass: 'core.exposure', params: { exposure: 0 }, enabled };
}

function chain4(): Chain {
  return [fx('a'), fx('b'), fx('c'), fx('d')];
}

describe('displayChain', () => {
  it('reverses so index 0 is the last-applied (top of the stack)', () => {
    expect(displayChain(chain4()).map((f) => f.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('returns an empty list for an empty chain', () => {
    expect(displayChain([])).toEqual([]);
  });

  it('does not mutate the input', () => {
    const chain = chain4();
    const before = JSON.stringify(chain);
    displayChain(chain);
    expect(JSON.stringify(chain)).toBe(before);
  });
});

describe('toggledChain', () => {
  it('flips only the matching instance', () => {
    const next = toggledChain(chain4(), 'b');
    expect(next.map((f) => [f.id, f.enabled])).toEqual([['a', true], ['b', false], ['c', true], ['d', true]]);
  });

  it('is a no-op for an unknown id', () => {
    const chain = chain4();
    expect(toggledChain(chain, 'missing')).toEqual(chain);
  });
});

describe('removedChain', () => {
  it('filters out only the matching instance, preserving order', () => {
    expect(removedChain(chain4(), 'c').map((f) => f.id)).toEqual(['a', 'b', 'd']);
  });

  it('is a no-op for an unknown id', () => {
    const chain = chain4();
    expect(removedChain(chain, 'missing')).toEqual(chain);
  });
});

describe('reorderedChain: exhaustive display-row matrix (a 4-effect chain)', () => {
  // Reference behaviour: pluck the dragged DISPLAY row out, drop it back in
  // at the target display row, the same "obviously correct" idiom
  // layers-logic.test.ts checks reorderTarget against.
  function expectedDisplayOrder(displayIds: string[], from: number, to: number): string[] {
    const ids = [...displayIds];
    const [dragged] = ids.splice(from, 1);
    ids.splice(to, 0, dragged!);
    return ids;
  }

  const DISPLAY_IDS = ['d', 'c', 'b', 'a']; // chain4() reversed (top-first)
  const rowCount = DISPLAY_IDS.length;

  for (let from = 0; from < rowCount; from++) {
    for (let to = 0; to < rowCount; to++) {
      it(`drag display row ${from} -> drop row ${to}${from === to ? ' (no-op)' : ''}`, () => {
        const chain = chain4();
        const next = reorderedChain(chain, from, to);
        expect(displayChain(next).map((f) => f.id)).toEqual(expectedDisplayOrder(DISPLAY_IDS, from, to));
      });
    }
  }

  it('adjacent nudge (the most common gesture) is not a silent no-op', () => {
    const chain = chain4();
    const next = reorderedChain(chain, 1, 2); // display row 1 ('c') -> row 2
    expect(displayChain(next).map((f) => f.id)).not.toEqual(DISPLAY_IDS);
    expect(displayChain(next).map((f) => f.id)).toEqual(expectedDisplayOrder(DISPLAY_IDS, 1, 2));
  });

  it('top display row -> bottom display row lands last in append (chain) order', () => {
    const chain = chain4();
    const next = reorderedChain(chain, 0, rowCount - 1); // 'd' (top) to the bottom
    expect(next[0]!.id).toBe('d');
  });

  it('bottom display row -> top display row lands first in append (chain) order', () => {
    const chain = chain4();
    const next = reorderedChain(chain, rowCount - 1, 0); // 'a' (bottom) to the top
    expect(next[next.length - 1]!.id).toBe('a');
  });

  it('clamps out-of-range rows instead of throwing', () => {
    const chain = chain4();
    expect(() => reorderedChain(chain, -5, 50)).not.toThrow();
    expect(reorderedChain([], 0, 0)).toEqual([]);
  });

  it('round-trips through the real setChain op (undo restores order)', () => {
    const doc = emptyDocument();
    doc.layers.push(createLayer({ id: layerId('l1'), name: 'L1', source: { type: 'core.solid', params: {} }, chain: chain4() }));
    const target: NodePath = { kind: 'layer', id: layerId('l1') };
    const before = displayChain(chainForTarget(doc, target)!).map((f) => f.id);

    const reordered = reorderedChain(chainForTarget(doc, target)!, 1, 3);
    const inverse = applyEdits(doc, [{ op: 'setChain', target, chain: reordered }]);
    expect(displayChain(chainForTarget(doc, target)!).map((f) => f.id)).toEqual(expectedDisplayOrder(before, 1, 3));

    applyEdits(doc, inverse);
    expect(displayChain(chainForTarget(doc, target)!).map((f) => f.id)).toEqual(before);
  });
});

function docWithLayerAndGroup(): DocumentJSON {
  const doc = emptyDocument();
  doc.layers.push(createLayer({
    id: layerId('l1'),
    name: 'L1',
    source: { type: 'core.solid', params: {} },
    chain: [fx('fx1')],
  }));
  doc.layers.push(createGroup({
    id: layerId('g1'),
    name: 'G1',
    children: [
      createLayer({ id: layerId('l2'), name: 'nested', source: { type: 'core.solid', params: {} }, chain: [fx('fx2')] }),
    ],
  }));
  return doc;
}

describe('chainForTarget', () => {
  it('reads a top-level layer chain', () => {
    const doc = docWithLayerAndGroup();
    expect(chainForTarget(doc, { kind: 'layer', id: layerId('l1') })?.map((f) => f.id)).toEqual(['fx1']);
  });

  it('reads a layer chain nested inside a group', () => {
    const doc = docWithLayerAndGroup();
    expect(chainForTarget(doc, { kind: 'layer', id: layerId('l2') })?.map((f) => f.id)).toEqual(['fx2']);
  });

  it('reads doc.postChain for a document target', () => {
    const doc = docWithLayerAndGroup();
    doc.postChain = [fx('post1')];
    expect(chainForTarget(doc, { kind: 'document' })?.map((f) => f.id)).toEqual(['post1']);
  });

  it('returns null for an unknown layer id', () => {
    const doc = docWithLayerAndGroup();
    expect(chainForTarget(doc, { kind: 'layer', id: layerId('missing') })).toBeNull();
  });

  it('returns null for an effect target (not addressable as a whole chain)', () => {
    const doc = docWithLayerAndGroup();
    expect(chainForTarget(doc, { kind: 'effect', owner: layerId('l1'), instance: 'fx1' })).toBeNull();
  });

  it('reads an object chain, defaulting to empty when the object has none', () => {
    const doc = emptyDocument();
    const layer = createLayer({ id: layerId('l1'), name: 'Scene', source: { type: 'core.scene', params: {} } });
    const obj = createObject({
      id: objectId('o1'), name: 'Rect', content: { type: 'shape', shape: { shape: 'rect', width: 10, height: 10 } },
    });
    layer.source.params['scene'] = [obj] as never;
    doc.layers.push(layer);
    expect(chainForTarget(doc, { kind: 'object', layer: layerId('l1'), id: objectId('o1') })).toEqual([]);
  });
});

describe('findSelectedObject', () => {
  function docWithMixedObjects() {
    const doc = emptyDocument();
    const layer = createLayer({ id: layerId('l1'), name: 'Scene', source: { type: 'core.scene', params: {} } });
    const textObj = createObject({
      id: objectId('t1'), name: 'Text',
      content: { type: 'text', text: { text: 'hi', font: 'default', size: 32 } },
    });
    const shapeObj = createObject({
      id: objectId('s1'), name: 'Rect', content: { type: 'shape', shape: { shape: 'rect', width: 10, height: 10 } },
    });
    layer.source.params['scene'] = [textObj, shapeObj] as never;
    doc.layers.push(layer);
    return doc;
  }

  it('finds the single selected object, of any content type, along with its layer id', () => {
    const doc = docWithMixedObjects();
    expect(findSelectedObject(doc, ['s1'])).toMatchObject({ node: { id: 's1' }, layer: 'l1' });
    expect(findSelectedObject(doc, ['t1'])).toMatchObject({ node: { id: 't1' }, layer: 'l1' });
  });

  it('returns null for no selection or a multi-object selection', () => {
    const doc = docWithMixedObjects();
    expect(findSelectedObject(doc, [])).toBeNull();
    expect(findSelectedObject(doc, ['t1', 's1'])).toBeNull();
  });

  it('returns null for an unknown id', () => {
    const doc = docWithMixedObjects();
    expect(findSelectedObject(doc, ['missing'])).toBeNull();
  });

  it('finds an object nested inside a group, resolving the nested layer id', () => {
    const doc = emptyDocument();
    const layer = createLayer({ id: layerId('l2'), name: 'Scene', source: { type: 'core.scene', params: {} } });
    const shapeObj = createObject({
      id: objectId('s2'), name: 'Rect', content: { type: 'shape', shape: { shape: 'rect', width: 10, height: 10 } },
    });
    layer.source.params['scene'] = [shapeObj] as never;
    doc.layers.push(createGroup({ id: layerId('g1'), name: 'G1', children: [layer] }));
    expect(findSelectedObject(doc, ['s2'])).toMatchObject({ node: { id: 's2' }, layer: 'l2' });
  });
});

describe('findSelectedTextObject', () => {
  function docWithTextObject() {
    const doc = emptyDocument();
    const layer = createLayer({ id: layerId('l1'), name: 'Scene', source: { type: 'core.scene', params: {} } });
    const textObj = createObject({
      id: objectId('t1'), name: 'Text',
      content: { type: 'text', text: { text: 'hi', font: 'default', size: 32 } },
      style: { fill: [0.5, 0, 0, 1] },
    });
    const shapeObj = createObject({
      id: objectId('s1'), name: 'Rect', content: { type: 'shape', shape: { shape: 'rect', width: 10, height: 10 } },
    });
    layer.source.params['scene'] = [textObj, shapeObj] as never;
    doc.layers.push(layer);
    return doc;
  }

  it('finds a selected text object', () => {
    const doc = docWithTextObject();
    const found = findSelectedTextObject(doc, ['t1']);
    expect(found?.id).toBe('t1');
  });

  it('returns null when the single selection is not a text object', () => {
    const doc = docWithTextObject();
    expect(findSelectedTextObject(doc, ['s1'])).toBeNull();
  });

  it('returns null for no selection', () => {
    const doc = docWithTextObject();
    expect(findSelectedTextObject(doc, [])).toBeNull();
  });

  it('returns null for a multi-object selection', () => {
    const doc = docWithTextObject();
    expect(findSelectedTextObject(doc, ['t1', 's1'])).toBeNull();
  });

  it('finds a text object nested inside a group', () => {
    const doc = emptyDocument();
    const layer = createLayer({ id: layerId('l2'), name: 'Scene', source: { type: 'core.scene', params: {} } });
    const textObj = createObject({
      id: objectId('t2'), name: 'Text',
      content: { type: 'text', text: { text: 'hi', font: 'default', size: 32 } },
    });
    layer.source.params['scene'] = [textObj] as never;
    doc.layers.push(createGroup({ id: layerId('g1'), name: 'G1', children: [layer] }));
    expect(findSelectedTextObject(doc, ['t2'])?.id).toBe('t2');
  });
});

import { describe, it, expect } from 'vitest';
import { displayOrder, activeWalk, dropTarget } from '../../src/ui/panels/layers-logic';
import { emptyDocument } from '../../src/engine/doc/json';
import { applyEdits } from '../../src/engine/doc/document';
import { layerId, identityTransform } from '../../src/engine/core/types';
import type { DocumentJSON, Layer, LayerGroup, LayerNode } from '../../src/engine/doc/json';

function makeLayer(id: string, name: string): Layer {
  return {
    id: layerId(id),
    kind: 'layer',
    name,
    enabled: true,
    source: { type: 'core.solid', params: { color: [0, 0, 0, 1] } },
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    transform: identityTransform(),
    liveness: 'baked',
  };
}

function makeGroup(id: string, name: string, children: LayerNode[]): LayerGroup {
  return {
    id: layerId(id),
    kind: 'group',
    name,
    enabled: true,
    chain: [],
    blendMode: 'normal',
    opacity: 1,
    children,
  };
}

function docWithLayers(names: string[]): DocumentJSON {
  const doc = emptyDocument();
  doc.layers = names.map((n, i) => makeLayer(`l${i}`, n));
  return doc;
}

describe('displayOrder', () => {
  it('reverses doc.layers so index 0 is the top of the stack', () => {
    const doc = docWithLayers(['bottom', 'middle', 'top']);
    const rows = displayOrder(doc);
    expect(rows.map((r) => r.node.name)).toEqual(['top', 'middle', 'bottom']);
    expect(rows.every((r) => r.depth === 0 && r.parentId === null)).toBe(true);
  });

  it('recurses into groups, still top-first per level', () => {
    const doc = emptyDocument();
    doc.layers = [
      makeLayer('l0', 'bg'),
      makeGroup('g0', 'group', [makeLayer('c0', 'child-a'), makeLayer('c1', 'child-b')]),
    ];
    const rows = displayOrder(doc);
    expect(rows.map((r) => r.node.name)).toEqual(['group', 'child-b', 'child-a', 'bg']);
    expect(rows.find((r) => r.node.name === 'child-a')!.depth).toBe(1);
    expect(rows.find((r) => r.node.name === 'child-a')!.parentId).toBe(layerId('g0'));
  });

  it('returns an empty list for an empty document', () => {
    expect(displayOrder(emptyDocument())).toEqual([]);
  });

  it('omits a collapsed group\'s children (but keeps the group row itself)', () => {
    const doc = emptyDocument();
    doc.layers = [
      makeLayer('l0', 'bg'),
      makeGroup('g0', 'group', [makeLayer('c0', 'child-a'), makeLayer('c1', 'child-b')]),
    ];
    const rows = displayOrder(doc, new Set([layerId('g0')]));
    expect(rows.map((r) => r.node.name)).toEqual(['group', 'bg']);
  });

  it('default (no collapsed set) behaves exactly as before: every existing caller unaffected', () => {
    const doc = emptyDocument();
    doc.layers = [makeGroup('g0', 'group', [makeLayer('c0', 'child')])];
    expect(displayOrder(doc).map((r) => r.node.name)).toEqual(['group', 'child']);
  });
});

describe('activeWalk', () => {
  it('selects the top row when nothing is active', () => {
    const doc = docWithLayers(['bottom', 'middle', 'top']);
    expect(activeWalk(doc, null, -1)).toBe(layerId('l2'));
  });

  it('walks toward the top with dir -1 and toward the bottom with dir 1', () => {
    const doc = docWithLayers(['bottom', 'middle', 'top']);
    // Display order top-first: l2 (top), l1 (middle), l0 (bottom).
    expect(activeWalk(doc, layerId('l1'), -1)).toBe(layerId('l2'));
    expect(activeWalk(doc, layerId('l1'), 1)).toBe(layerId('l0'));
  });

  it('clamps at the ends instead of wrapping', () => {
    const doc = docWithLayers(['bottom', 'top']);
    expect(activeWalk(doc, layerId('l1'), -1)).toBe(layerId('l1'));
    expect(activeWalk(doc, layerId('l0'), 1)).toBe(layerId('l0'));
  });

  it('falls back to the top row for an unknown current id', () => {
    const doc = docWithLayers(['bottom', 'top']);
    expect(activeWalk(doc, layerId('missing'), 1)).toBe(layerId('l1'));
  });

  it('returns null for an empty document', () => {
    expect(activeWalk(emptyDocument(), null, -1)).toBeNull();
  });
});

describe('dropTarget (depth-aware drag-reorder, exhaustive via the real applyEdits)', () => {
  const NAMES = ['l0', 'l1', 'l2', 'l3']; // doc order (bottom-first)

  function docTopFirstIds(doc: DocumentJSON): string[] {
    return displayOrder(doc).map((r) => r.node.id as unknown as string);
  }

  /** Standard array-move idiom over the flat top-first id list: the
   * reference behaviour every same-level (from, to) pair is checked
   * against. */
  function expectedTopFirstOrder(topFirstIds: string[], from: number, to: number): string[] {
    const ids = [...topFirstIds];
    const [dragged] = ids.splice(from, 1);
    ids.splice(to, 0, dragged!);
    return ids;
  }

  describe('flat 4-layer fixture (no groups): every (from, to) pair', () => {
    const rowCount = NAMES.length;
    for (let from = 0; from < rowCount; from++) {
      for (let to = 0; to < rowCount; to++) {
        it(`drag row ${from} -> drop row ${to}${from === to ? ' (no-op)' : ''}`, () => {
          const doc = docWithLayers(NAMES);
          const before = docTopFirstIds(doc);
          const draggedId = layerId(before[from]!);

          const rows = displayOrder(doc);
          const target = dropTarget(rows, to, draggedId)!;
          expect(target).not.toBeNull();
          const inverse = applyEdits(doc, [{ op: 'reorderLayer', id: draggedId, parent: target.parent, index: target.index }]);

          expect(docTopFirstIds(doc)).toEqual(expectedTopFirstOrder(before, from, to));

          // Undo (the inverse reorderLayer) must restore the original order.
          applyEdits(doc, inverse);
          expect(docTopFirstIds(doc)).toEqual(before);
        });
      }
    }

    it('adjacent nudge downward (the most common gesture) is NOT a silent no-op', () => {
      const doc = docWithLayers(NAMES);
      const before = docTopFirstIds(doc); // ['l3','l2','l1','l0']
      const draggedId = layerId(before[1]!); // 'l2', currently row 1
      const target = dropTarget(displayOrder(doc), 2, draggedId)!;
      applyEdits(doc, [{ op: 'reorderLayer', id: draggedId, parent: target.parent, index: target.index }]);
      expect(docTopFirstIds(doc)).not.toEqual(before);
      expect(docTopFirstIds(doc)).toEqual(expectedTopFirstOrder(before, 1, 2));
    });

    it('top -> bottom lands at doc index 0', () => {
      const doc = docWithLayers(NAMES);
      const rows = displayOrder(doc);
      const topId = rows[0]!.node.id;
      const target = dropTarget(rows, rows.length - 1, topId)!;
      applyEdits(doc, [{ op: 'reorderLayer', id: topId, parent: target.parent, index: target.index }]);
      expect(doc.layers[0]!.id).toBe(topId);
    });

    it('bottom -> top lands at the highest doc index', () => {
      const doc = docWithLayers(NAMES);
      const rows = displayOrder(doc);
      const bottomId = rows[rows.length - 1]!.node.id;
      const target = dropTarget(rows, 0, bottomId)!;
      applyEdits(doc, [{ op: 'reorderLayer', id: bottomId, parent: target.parent, index: target.index }]);
      expect(doc.layers[doc.layers.length - 1]!.id).toBe(bottomId);
    });
  });

  describe('4-layer + 1-group fixture', () => {
    /** doc order (bottom-first): l0, l1, [group g0: c0, c1], l2. 6 rows
     * top-first: l2, group, c1, c0, l1, l0 (group is depth 0, c0/c1 depth 1). */
    function fixture(): DocumentJSON {
      const doc = emptyDocument();
      doc.layers = [
        makeLayer('l0', 'l0'),
        makeLayer('l1', 'l1'),
        makeGroup('g0', 'group', [makeLayer('c0', 'c0'), makeLayer('c1', 'c1')]),
        makeLayer('l2', 'l2'),
      ];
      return doc;
    }

    it('top-first row layout sanity check', () => {
      const rows = displayOrder(fixture());
      expect(rows.map((r) => r.node.id as unknown as string)).toEqual(['l2', 'g0', 'c1', 'c0', 'l1', 'l0']);
      expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 1, 0, 0]);
    });

    it('dropping a top-level layer INTO the group row lands as its new top child', () => {
      const doc = fixture();
      const rows = displayOrder(doc);
      const groupRow = rows.findIndex((r) => r.node.id === layerId('g0'));
      const target = dropTarget(rows, groupRow, layerId('l1'))!;
      expect(target).toEqual({ parent: layerId('g0'), index: 2 }); // append after c0,c1
      applyEdits(doc, [{ op: 'reorderLayer', id: layerId('l1'), parent: target.parent, index: target.index }]);
      const found = doc.layers.find((n) => n.id === layerId('g0'));
      expect(found?.kind).toBe('group');
      expect((found as LayerGroup).children.map((c) => c.id as unknown as string)).toEqual(['c0', 'c1', 'l1']);
      expect(displayOrder(doc).map((r) => r.node.id as unknown as string)).toEqual(['l2', 'g0', 'l1', 'c1', 'c0', 'l0']);
    });

    it('dropping a child OUT of the group onto a top-level row lands as a top-level sibling', () => {
      const doc = fixture();
      const rows = displayOrder(doc);
      const l1Row = rows.findIndex((r) => r.node.id === layerId('l1'));
      const target = dropTarget(rows, l1Row, layerId('c0'))!;
      expect(target).toEqual({ parent: null, index: 2 }); // takes l1's display slot, l1 slides down
      applyEdits(doc, [{ op: 'reorderLayer', id: layerId('c0'), parent: target.parent, index: target.index }]);
      expect(doc.layers.map((n) => n.id as unknown as string)).toEqual(['l0', 'l1', 'c0', 'g0', 'l2']);
      const group = doc.layers.find((n) => n.id === layerId('g0')) as LayerGroup;
      expect(group.children.map((c) => c.id as unknown as string)).toEqual(['c1']);
    });

    it('nudging a child adjacent within the same group (c0 above c1)', () => {
      const doc = fixture();
      const rows = displayOrder(doc);
      // Top-first: ['l2','g0','c1','c0','l1','l0']. c1 is row 2 (top of the
      // two children), c0 is row 3 (bottom). Dragging c0 up onto c1's row
      // takes that display slot; c1 slides down. c0 becomes the topmost
      // child (doc order, bottom-first: [c1, c0]).
      const target = dropTarget(rows, 2, layerId('c0'))!;
      applyEdits(doc, [{ op: 'reorderLayer', id: layerId('c0'), parent: target.parent, index: target.index }]);
      const group = doc.layers.find((n) => n.id === layerId('g0')) as LayerGroup;
      expect(group.children.map((c) => c.id as unknown as string)).toEqual(['c1', 'c0']);
    });

    it('nudging a child downward within the same group (c1 below c0)', () => {
      const doc = fixture();
      const rows = displayOrder(doc);
      // c1 is row 2 (top of the two children); drop it onto c0's row (3).
      const target = dropTarget(rows, 3, layerId('c1'))!;
      applyEdits(doc, [{ op: 'reorderLayer', id: layerId('c1'), parent: target.parent, index: target.index }]);
      const group = doc.layers.find((n) => n.id === layerId('g0')) as LayerGroup;
      expect(group.children.map((c) => c.id as unknown as string)).toEqual(['c1', 'c0']);
    });

    it('dropping a group onto its own header row returns null (group rows always mean drop-INTO, and a group cannot nest inside itself)', () => {
      const rows = displayOrder(fixture());
      const groupRow = rows.findIndex((r) => r.node.id === layerId('g0'));
      expect(dropTarget(rows, groupRow, layerId('g0'))).toBeNull();
    });

    it('dropping a group INTO one of its own children returns null (own-descendant guard)', () => {
      const rows = displayOrder(fixture());
      const c0Row = rows.findIndex((r) => r.node.id === layerId('c0'));
      expect(dropTarget(rows, c0Row, layerId('g0'))).toBeNull();
    });

    it('a group CAN be dropped among its own top-level siblings (only nesting into itself/its own subtree is barred)', () => {
      const doc = fixture();
      const rows = displayOrder(doc);
      const l1Row = rows.findIndex((r) => r.node.id === layerId('l1'));
      const target = dropTarget(rows, l1Row, layerId('g0'));
      expect(target).not.toBeNull();
      applyEdits(doc, [{ op: 'reorderLayer', id: layerId('g0'), parent: target!.parent, index: target!.index }]);
      expect(doc.layers.map((n) => n.id as unknown as string)).toEqual(['l0', 'g0', 'l1', 'l2']);
    });

    it('collapsed rows are simply excluded: dropTarget only ever sees what displayOrder hands it', () => {
      const doc = fixture();
      const rows = displayOrder(doc, new Set([layerId('g0')]));
      expect(rows.map((r) => r.node.id as unknown as string)).toEqual(['l2', 'g0', 'l1', 'l0']);
      // Hovering the (collapsed) group row still drops INTO it.
      const groupRow = rows.findIndex((r) => r.node.id === layerId('g0'));
      const target = dropTarget(rows, groupRow, layerId('l1'))!;
      expect(target).toEqual({ parent: layerId('g0'), index: 2 });
    });

    it('own-descendant guard: cannot drop a group into a grandchild either', () => {
      const doc = emptyDocument();
      doc.layers = [makeGroup('g0', 'outer', [makeGroup('g1', 'inner', [makeLayer('c0', 'c0')])])];
      const rows = displayOrder(doc);
      const c0Row = rows.findIndex((r) => r.node.id === layerId('c0'));
      expect(dropTarget(rows, c0Row, layerId('g0'))).toBeNull();
    });
  });

  it('returns null when the dragged id is not present in the given rows', () => {
    const rows = displayOrder(docWithLayers(NAMES));
    expect(dropTarget(rows, 0, layerId('missing'))).toBeNull();
  });

  it('clamps an out-of-range dropRow to the nearest real row instead of throwing', () => {
    const rows = displayOrder(docWithLayers(NAMES));
    expect(dropTarget(rows, -5, layerId('l0'))).toEqual(dropTarget(rows, 0, layerId('l0')));
    expect(dropTarget(rows, 999, layerId('l0'))).toEqual(dropTarget(rows, rows.length - 1, layerId('l0')));
  });

  it('returns null for an empty row list', () => {
    expect(dropTarget([], 0, layerId('missing'))).toBeNull();
  });
});
